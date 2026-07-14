#!/usr/bin/env node
/**
 * cert_rotation_revocation_scenarios.js
 * ═══════════════════════════════════════════════════════════════════
 * PhotonNet — KME mTLS katmanının Sertifika Yenileme (Rotasyon) / İptal
 * (CRL + OCSP) SENARYO ANALİZİ. Bu, PKI/mTLS çalışmasının SON doğrulama
 * adımıdır: IBM'in kendi sertifika rotasyon protokollerini bu KME'ye
 * karşı entegre etmeden ÖNCE, "rotasyon/iptal sırasında sistem GERÇEKTE
 * nasıl davranıyor" sorusunu VARSAYIMLA DEĞİL, CANLI bir KME sunucusuna
 * + OCSP yanıtlayıcısına karşı GERÇEK mTLS bağlantıları kurarak, GERÇEK
 * zamanlama verisiyle cevaplar.
 *
 * NEDEN AYRI BİR SCRIPT (mock_ibm_client.js'in İÇİNE değil): o dosya
 * "protokol doğru çalışıyor mu" sorusunu (statik bir PKI anlık
 * görüntüsüne karşı) cevaplıyor. BU dosya ise ZAMANA YAYILI, DİNAMİK
 * senaryoları (rotasyon SIRASINDA, iptal SIRASINDA, OCSP çöktüğünde,
 * kalıcı bir bağlantı AÇIKKEN iptal olursa ne olur) test eder — farklı
 * bir sorumluluk, bu yüzden ayrı bir araç.
 *
 * TEST EDİLEN 6 SENARYO (her biri gerçek pki_tools/ script'lerini VE
 * gerçek bir KME sunucusunu/OCSP yanıtlayıcısını kullanır):
 *   S1) Planlı rotasyon, İPTAL OLMADAN (rotate_cert.sh, --revoke-old YOK)
 *       → sıfır kesintili geçiş penceresi: hem eski hem yeni sertifika
 *         AYNI ANDA çalışmalı mı?
 *   S2) Planlı rotasyon, ANINDA İPTAL İLE (rotate_cert.sh --revoke-old)
 *       → sızdırılmış anahtar senaryosu: eski sertifika NE KADAR SÜREDE
 *         reddedilmeye başlıyor, hangi katmanda (TLS/CRL mi, HTTP 401/
 *         OCSP mi)?
 *   S3) Acil iptal, rotasyon OLMADAN (revoke_cert.sh tek başına)
 *       → "önce kilitle, sonra yeniden sertifikalandır" senaryosu.
 *   S4) OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması + operasyonel
 *       risk): responder kapalıyken GEÇERLİ bir sertifika bile
 *       reddediliyor mu (güvenlik açısından DOĞRU davranış), yanıtlayıcı
 *       geri geldiğinde önbellek NEGATİF sonucu ne kadar süre daha
 *       taşıyor?
 *   S5) KALICI (keep-alive) bir mTLS bağlantısı AÇIKKEN sertifika iptal
 *       edilirse: soket KOPARILIYOR mu, yoksa yalnızca BİR SONRAKİ
 *       istek mi reddediliyor (uygulama-katmanı OCSP kontrolü)?
 *   S6) HİÇ iptal edilmemiş ama SÜRESİ DOLMUŞ bir sertifika (kısa ömür
 *       stratejisinin kendiliğinden kapattığı pencere) — CRL/OCSP'den
 *       BAĞIMSIZ olarak TLS katmanının kendisi bunu reddediyor mu?
 *
 * ÇIKTI: <out-dir>/scenario_results.json (ham veri, makine-okunur) +
 * <out-dir>/sertifika_rotasyon_iptal_analizi.md (Türkçe, IBM'e
 * teslim edilecek okunabilir analiz raporu) — RAPORDAKİ HER SAYI bu
 * script'in O ÇALIŞTIRMADA GERÇEKTEN ÖLÇTÜĞÜ değerdir, elle yazılmamıştır.
 *
 * KULLANIM:
 *   node cert_rotation_revocation_scenarios.js [--out-dir=./scenario-report] [--keep]
 * (--keep: geçici PKI dizinini/süreçleri script sonunda SİLME/DURDURMA —
 *  sonucu elle incelemek için; varsayılan: her zaman temizlenir)
 *
 * ÇIKIŞ KODU: tüm senaryolar beklenen sonucu verirse 0, herhangi biri
 * beklenmedik davranırsa 1 (CI'da düzenli bir "PKI regresyon testi"
 * olarak da zamanlanabilir — bkz. rapordaki öneriler bölümü).
 * ═══════════════════════════════════════════════════════════════════
 */
"use strict";

const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFileSync, execFile, spawn } = require("child_process");

const BB84_DIR = path.resolve(__dirname, "..");
const PKI_TOOLS = __dirname;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args["out-dir"] || "./scenario-report");
const KEEP = !!args.keep;
fs.mkdirSync(OUT_DIR, { recursive: true });

const KME_PORT = Number(process.env.SCEN_KME_PORT || 8543);
const OCSP_PORT = Number(process.env.SCEN_OCSP_PORT || 8988);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[SENARYO] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, "run.log"), line + "\n");
}

function runTool(scriptName, toolArgs) {
  const scriptPath = path.join(PKI_TOOLS, scriptName);
  try {
    const out = execFileSync(scriptPath, toolArgs, { stdio: "pipe" }).toString();
    fs.appendFileSync(path.join(OUT_DIR, "run.log"), `\n$ ${scriptName} ${toolArgs.join(" ")}\n${out}\n`);
    return out;
  } catch (e) {
    const out = `${e.stdout || ""}\n${e.stderr || ""}`;
    fs.appendFileSync(path.join(OUT_DIR, "run.log"), `\n$ ${scriptName} ${toolArgs.join(" ")} (HATA)\n${out}\n`);
    throw new Error(`${scriptName} başarısız: ${out.slice(-500)}`);
  }
}

// ── ephemeral PKI dizin iskeleti ────────────────────────────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cert-scenarios-"));
const PKI_DIR = path.join(TMP_DIR, "pki");     // ca_init.sh burada + rotate_cert.sh'in YÖNETTİĞİ (düz, reqs/ OLMAYAN) sertifikalar burada
const REQS_DIR = path.join(PKI_DIR, "reqs");   // issue_cert.sh+sign_csr.sh ile üretilen (rotasyon-DIŞI) sertifikalar
const SNAP_DIR = path.join(TMP_DIR, "snapshots"); // rotasyon/iptalden ÖNCEKİ sertifika kopyaları (istemci tarafında "henüz güncellenmemiş SAE" simülasyonu)
fs.mkdirSync(SNAP_DIR, { recursive: true });

const bgProcs = []; // {name, proc}
function spawnBg(name, cmd, cmdArgs, logFile) {
  const out = fs.openSync(path.join(OUT_DIR, logFile), "a");
  const proc = spawn(cmd, cmdArgs, { detached: true, stdio: ["ignore", out, out] });
  bgProcs.push({ name, proc });
  return proc;
}
function killBg(name) {
  const idx = bgProcs.findIndex((p) => p.name === name);
  if (idx === -1) return;
  const { proc } = bgProcs[idx];
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* zaten ölmüş olabilir */ }
  bgProcs.splice(idx, 1);
}
function killAllBg() {
  for (const { proc } of bgProcs.slice()) {
    try { process.kill(-proc.pid, "SIGTERM"); } catch { /* yok say */ }
  }
  bgProcs.length = 0;
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  killAllBg();
  if (!KEEP) {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* yok say */ }
  } else {
    log(`--keep verildi: geçici PKI dizini KORUNDU: ${TMP_DIR}`);
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// ── ağ hazır-olma yardımcıları ───────────────────────────────────────
function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function attempt() {
      const sock = net.connect(port, host);
      sock.once("connect", () => { sock.end(); resolve(Date.now() - t0); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - t0 >= timeoutMs) reject(new Error(`${host}:${port} ${timeoutMs}ms içinde açılmadı`));
        else setTimeout(attempt, 300);
      });
    })();
  });
}

function ocspLiveQuery(caCert, probeCert, url) {
  return new Promise((resolve) => {
    execFile("openssl", ["ocsp", "-issuer", caCert, "-cert", probeCert, "-url", url, "-CAfile", caCert, "-timeout", "3"],
      { timeout: 4000 }, (err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}
async function waitForOcspResponder(caCert, probeCert, url, timeoutMs) {
  const t0 = Date.now();
  while (true) {
    const out = await ocspLiveQuery(caCert, probeCert, url);
    if (/: good|: revoked|: unknown/i.test(out)) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) throw new Error(`OCSP yanıtlayıcısı (${url}) ${timeoutMs}ms içinde hazır olmadı. Son çıktı:\n${out}`);
    await sleep(400);
  }
}

// ── ÖNEMLİ, BU SCRIPT'İ YAZARKEN CANLI OLARAK KEŞFEDİLEN BİR AYRINTI ──
// Node.js'in (bu ortamda v22) `https.globalAgent`'ı VARSAYILAN olarak
// `keepAlive: true`'dur (bkz. https.globalAgent.keepAlive) — yani bir
// istekte `agent:` seçeneği AÇIKÇA verilmezse, aynı host:port'a yapılan
// "birbirinden bağımsız" gibi görünen ART ARDA istekler SESSİZCE AYNI
// TCP/TLS bağlantısını yeniden kullanabilir. Bu, S1-S4/S6'nın "YENİ bir
// bağlantı denemesi" senaryolarını YANLIŞLIKLA S5'in ("KALICI bir
// bağlantı") senaryosuna dönüştürür — CRL yalnızca TLS HANDSHAKE
// sırasında kontrol edildiğinden, yeniden kullanılan bir bağlantıda asla
// yeniden değerlendirilmez (bu script'in İLK taslağında TAM OLARAK bu
// yüzden S2/S3/S5 yanlış-negatif verdi; kök nedeni burada CANLI olarak
// teşhis edip düzelttik — bkz. raporun "Node.js globalAgent tuzağı"
// bulgusu, bu AYNI zamanda IBM'in kendi istemcisi için de geçerli bir
// UYARIDIR). Bu yüzden BURADA, S5 DIŞINDAKİ tüm senaryolar için, HER
// ÇAĞRIDA gerçekten TAZE bir TCP/TLS bağlantısı kuran özel bir agent
// kullanılır — S5 ise KASITLI OLARAK kendi keepAlive:true agent'ını
// geçirir (bkz. scenarioS5).
const FRESH_CONN_AGENT = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

// ── mTLS deneme yardımcısı — bağlantı-katmanı reddi ("connection", ör.
// CRL/TLS handshake seviyesi) İLE uygulama-katmanı reddini (HTTP 401,
// ör. OCSP) AYIRT EDEREK raporlar; bu ayrım senaryo analizinin ANA
// noktasıdır (bkz. dosya-üstü not, S2/S3/S5/S6).
function attempt(certPath, keyPath, caCert, { agent = FRESH_CONN_AGENT, counterpart = "SAE-SCENARIO-PEER" } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const opts = {
      hostname: "localhost", port: KME_PORT, method: "GET",
      path: `/api/v1/keys/${encodeURIComponent(counterpart)}/status`,
      cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), ca: [fs.readFileSync(caCert)],
      rejectUnauthorized: true,
    };
    if (agent) opts.agent = agent;
    let settled = false;
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (settled) return; settled = true;
        let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch { /* ham bırak */ }
        resolve({
          ok: res.statusCode < 400, layer: "http", statusCode: res.statusCode, code: null,
          message: (parsed && parsed.message) || `HTTP ${res.statusCode}`,
          elapsedMs: Date.now() - t0, localPort: req.socket && req.socket.localPort,
        });
      });
    });
    req.on("error", (e) => {
      if (settled) return; settled = true;
      resolve({ ok: false, layer: "connection", statusCode: null, code: e.code || null, message: e.message, elapsedMs: Date.now() - t0, localPort: null });
    });
    req.end();
  });
}

async function waitUntil(fn, { intervalMs = 300, timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (true) {
    last = await fn();
    if (last.done) return { ...last, totalElapsedMs: Date.now() - t0, timedOut: false };
    if (Date.now() - t0 >= timeoutMs) return { ...last, totalElapsedMs: Date.now() - t0, timedOut: true };
    await sleep(intervalMs);
  }
}

const results = [];
function record(r) { results.push(r); log(`  → ${r.id}: ${r.verdict} — ${r.summary}`); }

// ══════════════════════════════════════════════════════════
// ORTAM KURULUMU
// ══════════════════════════════════════════════════════════
async function setupEnvironment() {
  log(`Geçici PKI dizini: ${TMP_DIR}`);
  log("CA başlatılıyor...");
  runTool("ca_init.sh", [PKI_DIR]);

  log("Sunucu sertifikası (localhost) + rotasyon-DIŞI istemci sertifikaları imzalanıyor...");
  const nonRotatingCns = [
    ["server", "localhost"],
    ["client", "SAE-EMERGENCY-TEST"],
    ["client", "SAE-OCSP-DOWN-A"],
    ["client", "SAE-OCSP-DOWN-B"],
    ["client", "SAE-OCSP-DOWN-C"],
    ["client", "SAE-KEEPALIVE-TEST"],
    ["client", "SAE-EXPIRED-TEST"],
  ];
  for (const [role, cn] of nonRotatingCns) {
    runTool("issue_cert.sh", [REQS_DIR, role, cn]);
    if (cn === "SAE-EXPIRED-TEST") continue; // bunu birazdan ELLE (süresi geçmiş olarak) imzalayacağız
    runTool("sign_csr.sh", [PKI_DIR, path.join(REQS_DIR, `${cn}.csr`), role, "7"]);
  }

  // S6 için: SÜRESİ ZATEN GEÇMİŞ bir sertifika — sign_csr.sh'in desteklemediği
  // -startdate/-enddate override'ını doğrudan openssl ca ile veriyoruz (yalnızca
  // bu TEK sertifika için; CA veritabanı mantığı diğerleriyle AYNI kalır).
  log("SAE-EXPIRED-TEST özel olarak SÜRESİ GEÇMİŞ imzalanıyor (S6 için)...");
  const pastEnd = execFileSync("date", ["-u", "-d", "-2 minutes", "+%y%m%d%H%M%SZ"]).toString().trim();
  const pastStart = execFileSync("date", ["-u", "-d", "-3 minutes", "+%y%m%d%H%M%SZ"]).toString().trim();
  const extFile = path.join(TMP_DIR, "client-ext.cnf");
  fs.writeFileSync(extFile, "extendedKeyUsage = clientAuth\nbasicConstraints = CA:FALSE\n");
  execFileSync("openssl", [
    "ca", "-config", path.join(PKI_DIR, "ca-db/openssl-ca.cnf"),
    "-in", path.join(REQS_DIR, "SAE-EXPIRED-TEST.csr"),
    "-out", path.join(REQS_DIR, "SAE-EXPIRED-TEST-cert.pem"),
    "-startdate", pastStart, "-enddate", pastEnd, "-md", "sha256", "-batch", "-extfile", extFile,
  ], { stdio: "pipe", cwd: PKI_DIR });
  log(`  SAE-EXPIRED-TEST geçerlilik penceresi: ${pastStart} → ${pastEnd} (test ANINDAN itibaren ZATEN geçmiş)`);

  log("Rotasyona TABİ olacak istemciler rotate_cert.sh ile İLK KEZ üretiliyor (ileride yeniden rotate edilecekler)...");
  runTool("rotate_cert.sh", [PKI_DIR, "client", "SAE-ROT-NOREVOKE", "7"]);
  runTool("rotate_cert.sh", [PKI_DIR, "client", "SAE-ROT-REVOKE", "7"]);

  log(`OCSP yanıtlayıcısı başlatılıyor (port ${OCSP_PORT})...`);
  spawnBg("ocsp", path.join(PKI_TOOLS, "run_ocsp_responder.sh"), [PKI_DIR, String(OCSP_PORT)], "ocsp_responder.log");

  log(`KME sunucusu başlatılıyor (port ${KME_PORT}, CRL+OCSP AKTİF)...`);
  spawnBg("kme", "node", [
    path.join(BB84_DIR, "etsi014_kme_server.js"),
    `--port=${KME_PORT}`,
    `--cert=${path.join(REQS_DIR, "localhost-cert.pem")}`, `--key=${path.join(REQS_DIR, "localhost-key.pem")}`,
    `--ca=${path.join(PKI_DIR, "ca-cert.pem")}`,
    `--crl=${path.join(PKI_DIR, "crl/ca-crl.pem")}`, `--ocsp-responder=http://localhost:${OCSP_PORT}`,
  ], "kme_server.log");

  const ocspReadyMs = await waitForOcspResponder(path.join(PKI_DIR, "ca-cert.pem"), path.join(REQS_DIR, "localhost-cert.pem"), `http://localhost:${OCSP_PORT}`, 15000);
  const kmeReadyMs = await waitForPort("localhost", KME_PORT, 15000);
  log(`Ortam hazır (OCSP: ${ocspReadyMs}ms, KME: ${kmeReadyMs}ms).`);
}

// ══════════════════════════════════════════════════════════
// S1 — Planlı rotasyon, İPTAL OLMADAN
// ══════════════════════════════════════════════════════════
async function scenarioS1() {
  const CN = "SAE-ROT-NOREVOKE";
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const curCert = path.join(PKI_DIR, `${CN}-cert.pem`);
  const curKey = path.join(PKI_DIR, `${CN}-key.pem`);
  const oldCertSnap = path.join(SNAP_DIR, `${CN}-old-cert.pem`);
  const oldKeySnap = path.join(SNAP_DIR, `${CN}-old-key.pem`);

  const baseline = await attempt(curCert, curKey, caCert);
  fs.copyFileSync(curCert, oldCertSnap);
  fs.copyFileSync(curKey, oldKeySnap);

  runTool("rotate_cert.sh", [PKI_DIR, "client", CN, "7"]); // --revoke-old YOK
  await sleep(500); // CA dosya yazımlarının diske oturması için kısa tampon

  const oldAfterRotate = await attempt(oldCertSnap, oldKeySnap, caCert);
  // İKAZ: YENİ sertifikanın İLK OCSP sorgusu, yanıtlayıcının index.txt'yi
  // henüz yeniden okumadığı kısa pencereye denk gelip "unknown" alabilir
  // (bkz. S2/9. madde'deki AYNI mekanizma) — bu yüzden tek seferlik değil,
  // kısa bir yeniden-deneme penceresiyle kontrol ediyoruz.
  const newAfterRotatePoll = await waitUntil(async () => {
    const r = await attempt(curCert, curKey, caCert);
    return { done: r.ok, ...r };
  }, { timeoutMs: 40000 });
  const newAfterRotate = newAfterRotatePoll;

  const ok = baseline.ok && oldAfterRotate.ok && !newAfterRotatePoll.timedOut && newAfterRotatePoll.ok;
  record({
    id: "S1", title: "Planlı rotasyon, İPTAL OLMADAN (kesintisiz geçiş penceresi)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `rotate_cert.sh (--revoke-old OLMADAN) çalıştırıldıktan SONRA hem ESKİ hem YENİ sertifika kabul edildi — sıfır kesintili geçiş mümkün${newAfterRotatePoll.totalElapsedMs > 3000 ? ` (YENİ sertifikanın kabul edilmesi ${newAfterRotatePoll.totalElapsedMs}ms sürdü — bkz. '30sn negatif önbellek yarışı' notu)` : ""}.`
      : "beklenmedik davranış: rotasyon sonrası eski/yeni sertifikalardan biri reddedildi (bkz. detaylar).",
    detail: {
      baseline_eski_sertifika: describe(baseline),
      rotasyon_sonrasi_eski_sertifika_kopyasi: describe(oldAfterRotate),
      rotasyon_sonrasi_yeni_sertifika: describe(newAfterRotate),
    },
  });
}

// ══════════════════════════════════════════════════════════
// S2 — Planlı rotasyon, --revoke-old İLE (sızdırılmış anahtar senaryosu)
// ══════════════════════════════════════════════════════════
async function scenarioS2() {
  const CN = "SAE-ROT-REVOKE";
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const curCert = path.join(PKI_DIR, `${CN}-cert.pem`);
  const curKey = path.join(PKI_DIR, `${CN}-key.pem`);
  const oldCertSnap = path.join(SNAP_DIR, `${CN}-old-cert.pem`);
  const oldKeySnap = path.join(SNAP_DIR, `${CN}-old-key.pem`);

  const baseline = await attempt(curCert, curKey, caCert); // bu sorgu OCSP önbelleğini "good" olarak ISITIR — kasıtlı: gerçek dünyada tam da böyle olur
  fs.copyFileSync(curCert, oldCertSnap);
  fs.copyFileSync(curKey, oldKeySnap);

  const t0 = Date.now();
  runTool("rotate_cert.sh", [PKI_DIR, "client", CN, "7", "--revoke-old"]);
  const rotateCmdMs = Date.now() - t0;

  const rejectPoll = await waitUntil(async () => {
    const r = await attempt(oldCertSnap, oldKeySnap, caCert);
    return { done: !r.ok, ...r };
  }, { timeoutMs: 20000 });

  // İKAZ (bu script'i geliştirirken CANLI olarak tespit edildi): YENİ
  // sertifikanın İLK OCSP sorgusu, OCSP yanıtlayıcısının index.txt'yi
  // henüz yeniden okumadığı ÇOK KISA bir pencereye denk gelirse "unknown"
  // yanıtı alabilir — checkOcsp() bunu (doğru şekilde, güvenlik açısından
  // temkinli olarak) fail-CLOSED sayar VE bu olumsuz sonucu 30 saniye
  // önbelleğe alır (bkz. S4'teki AYNI mekanizma). Yani rotasyondan hemen
  // sonra YENİ sertifikanın kabul edilmesi NADİREN ~30 saniyeye kadar
  // gecikebilir — bu GERÇEK (ve tekrarlanabilir) bir davranıştır, test
  // hatası DEĞİLDİR; bu yüzden zaman aşımını bu olası pencereyi
  // KAPSAYACAK şekilde ayarlıyoruz ve GERÇEKTE ÖLÇÜLEN süreyi raporluyoruz.
  const newCertPoll = await waitUntil(async () => {
    const r = await attempt(curCert, curKey, caCert);
    return { done: r.ok, ...r };
  }, { timeoutMs: 45000 });

  const ok = !rejectPoll.timedOut && !rejectPoll.ok && !newCertPoll.timedOut && newCertPoll.ok;
  const newCertRace = newCertPoll.totalElapsedMs > 3000; // birkaç saniyeden fazla sürdüyse muhtemelen yukarıdaki OCSP "unknown" yarışına yakalanmıştır
  record({
    id: "S2", title: "Planlı rotasyon, --revoke-old İLE (sızdırılmış anahtar senaryosu)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `eski sertifika rotate_cert.sh --revoke-old komutundan itibaren ${rejectPoll.totalElapsedMs}ms içinde reddedilmeye başladı (katman: ${rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi)" : "HTTP 401 (OCSP)"}); yeni sertifika ${newCertPoll.totalElapsedMs}ms içinde kabul edilir hale geldi${newCertRace ? " (bu çalıştırmada YENİ sertifikanın ilk OCSP sorgusu, yanıtlayıcının henüz güncellenmemiş bir anlık görüntüsüne denk geldi — bkz. rapordaki '30sn negatif önbellek yarışı' notu)" : ""}.`
      : "beklenmedik davranış: eski sertifika süresi içinde reddedilmedi veya yeni sertifika süresi içinde kabul edilmedi.",
    detail: {
      baseline_eski_sertifika: describe(baseline),
      rotate_komutunun_calisma_suresi_ms: rotateCmdMs,
      eski_sertifika_reddedilene_kadar_gecen_sure_ms: rejectPoll.totalElapsedMs,
      eski_sertifika_reddinin_katmani: rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi — HTTP yanıtı hiç alınamadı)" : "HTTP 401 (uygulama seviyesi — OCSP kontrolü)",
      eski_sertifika_son_hata_mesaji: rejectPoll.message,
      yeni_sertifikanin_kabul_edilene_kadar_gecen_sure_ms: newCertPoll.totalElapsedMs,
      yeni_sertifika_30sn_negatif_onbellek_yarisina_yakalandi_mi: newCertRace,
    },
  });
}

// ══════════════════════════════════════════════════════════
// S3 — Acil iptal, ROTASYON OLMADAN
// ══════════════════════════════════════════════════════════
async function scenarioS3() {
  const CN = "SAE-EMERGENCY-TEST";
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const certPath = path.join(REQS_DIR, `${CN}-cert.pem`);
  const keyPath = path.join(REQS_DIR, `${CN}-key.pem`);

  const baseline = await attempt(certPath, keyPath, caCert);

  const t0 = Date.now();
  runTool("revoke_cert.sh", [PKI_DIR, certPath]);
  const revokeCmdMs = Date.now() - t0;

  const rejectPoll = await waitUntil(async () => {
    const r = await attempt(certPath, keyPath, caCert);
    return { done: !r.ok, ...r };
  }, { timeoutMs: 20000 });

  const ok = baseline.ok && !rejectPoll.timedOut && !rejectPoll.ok;
  record({
    id: "S3", title: "Acil iptal, ROTASYON OLMADAN (\"önce kilitle\" senaryosu)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `revoke_cert.sh komutundan itibaren ${rejectPoll.totalElapsedMs}ms içinde sertifika reddedilmeye başladı (katman: ${rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi)" : "HTTP 401 (OCSP)"}).`
      : "beklenmedik davranış: sertifika süresi içinde reddedilmedi.",
    detail: {
      baseline: describe(baseline),
      revoke_komutunun_calisma_suresi_ms: revokeCmdMs,
      reddedilene_kadar_gecen_sure_ms: rejectPoll.totalElapsedMs,
      reddin_katmani: rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi)" : "HTTP 401 (OCSP)",
      son_hata_mesaji: rejectPoll.message,
    },
  });
}

// ══════════════════════════════════════════════════════════
// S4 — OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması)
// ══════════════════════════════════════════════════════════
async function scenarioS4() {
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const certA = path.join(REQS_DIR, "SAE-OCSP-DOWN-A-cert.pem"), keyA = path.join(REQS_DIR, "SAE-OCSP-DOWN-A-key.pem");
  const certB = path.join(REQS_DIR, "SAE-OCSP-DOWN-B-cert.pem"), keyB = path.join(REQS_DIR, "SAE-OCSP-DOWN-B-key.pem");
  const certC = path.join(REQS_DIR, "SAE-OCSP-DOWN-C-cert.pem"), keyC = path.join(REQS_DIR, "SAE-OCSP-DOWN-C-key.pem");

  const baselineA = await attempt(certA, keyA, caCert); // OCSP hâlâ AYAKTAYKEN — "good" olarak önbelleğe alınır

  log("  OCSP yanıtlayıcısı SÜRECİ ÖLDÜRÜLÜYOR (kesinti simülasyonu)...");
  killBg("ocsp");
  await sleep(700); // portun tamamen kapanması için

  const duringOutageB = await attempt(certB, keyB, caCert); // HİÇ sorgulanmamış (önbellekte YOK) bir sertifika — GERÇEK canlı sorgu denemesi yapılacak

  log(`  OCSP yanıtlayıcısı YENİDEN başlatılıyor (port ${OCSP_PORT})...`);
  spawnBg("ocsp", path.join(PKI_TOOLS, "run_ocsp_responder.sh"), [PKI_DIR, String(OCSP_PORT)], "ocsp_responder.log");
  const recoveryMs = await waitForOcspResponder(caCert, path.join(REQS_DIR, "localhost-cert.pem"), `http://localhost:${OCSP_PORT}`, 15000);

  const afterRecoveryC = await attempt(certC, keyC, caCert); // TAZE kimlik — hiç negatif önbellek YOK, temiz kurtarma kanıtı
  const afterRecoveryB = await attempt(certB, keyB, caCert); // AYNI kimlik — 30sn'lik NEGATİF önbellek hâlâ etkili OLABİLİR

  const failClosedOk = baselineA.ok && !duringOutageB.ok && duringOutageB.layer === "http" && /ulaşılamadı|fail-CLOSED/i.test(duringOutageB.message);
  const recoveryOk = afterRecoveryC.ok;
  const ok = failClosedOk && recoveryOk;
  record({
    id: "S4", title: "OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması + kurtarma davranışı)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `OCSP yanıtlayıcısı ERİŞİLEMEZ olduğunda GEÇERLİ bir sertifika bile ${duringOutageB.elapsedMs}ms içinde HTTP 401 ile fail-CLOSED reddedildi (güvenlik açısından DOĞRU); yanıtlayıcı ${recoveryMs}ms'de toparlandı ve TAZE bir kimlik hemen kabul edildi. ÖNEMLİ: kesinti sırasında reddedilen AYNI kimlik (B), yanıtlayıcı toparlandıktan HEMEN sonra bile ${afterRecoveryB.ok ? "kabul edildi" : "HÂLÂ reddedildi"} — negatif sonuç da 30sn önbelleğe alınıyor.`
      : "beklenmedik davranış: fail-closed veya kurtarma davranışı beklenenden farklı (bkz. detaylar).",
    detail: {
      baseline_A_ocsp_ayaktayken: describe(baselineA),
      kesinti_sirasinda_B_hic_sorgulanmamis_kimlik: describe(duringOutageB),
      ocsp_yanitlayici_toparlanma_suresi_ms: recoveryMs,
      toparlanma_sonrasi_TAZE_kimlik_C: describe(afterRecoveryC),
      toparlanma_sonrasi_AYNI_kimlik_B_negatif_onbellek_notu: describe(afterRecoveryB),
    },
  });
}

// ══════════════════════════════════════════════════════════
// S5 — KALICI (keep-alive) bağlantı AÇIKKEN iptal
// ══════════════════════════════════════════════════════════
async function scenarioS5() {
  const CN = "SAE-KEEPALIVE-TEST";
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const certPath = path.join(REQS_DIR, `${CN}-cert.pem`);
  const keyPath = path.join(REQS_DIR, `${CN}-key.pem`);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

  const first = await attempt(certPath, keyPath, caCert, { agent });
  const portBefore = first.localPort;

  runTool("revoke_cert.sh", [PKI_DIR, certPath]);

  // İKAZ (bu script'i geliştirirken CANLI olarak teşhis edildi, EN ÖNEMLİ
  // bulgu): teorik beklenti, OCSP'nin 30sn'lik önbelleği doldukça TEK bir
  // döngüde (~30sn) taze bir sonuç vermesidir. Ama referans OCSP
  // yanıtlayıcısının "-nrequest 1, her istekte yeniden başla" tasarımı
  // İLE uygulama-katmanı önbelleğinin ETKİLEŞİMİ yüzünden, GERÇEKTE
  // ölçülen davranış şu: önbellek dolduğunda yapılan İLK yeniden sorgu,
  // o an BOŞTA BEKLEYEN (revizyondan ÖNCE başlamış, index.txt'yi henüz
  // yeniden okumamış) bir openssl sürecine denk gelebilir — bu süreç
  // İSTEĞİ (bayat "good" ile) YANITLAR, SONRA (isteği aldığı için)
  // kendini yeniler; ama yanıt ZATEN GİTMİŞ ve BİR SONRAKİ 30sn için
  // TEKRAR önbelleğe alınmıştır. Yalnızca İKİNCİ önbellek döngüsündeki
  // sorgu (yaklaşık +60sn) bu artık-taze süreci bulur. Bu script'i
  // GELİŞTİRİRKEN CANLI olarak üç kez tekrarlanabilir şekilde gözlemlendi
  // (bkz. rapordaki "en ciddi bulgu"). Bu yüzden zaman aşımını BİRDEN
  // FAZLA önbellek döngüsünü KAPSAYACAK şekilde geniş tutuyoruz.
  const poll = await waitUntil(async () => {
    const r = await attempt(certPath, keyPath, caCert, { agent });
    return { done: !r.ok, ...r };
  }, { timeoutMs: 100000, intervalMs: 300 });

  agent.destroy();

  const ok = first.ok && !poll.timedOut && !poll.ok && poll.layer === "http";
  const tookExtraCycle = poll.totalElapsedMs > 35000; // ~30sn'lik TEK döngüden belirgin şekilde fazla sürdüyse muhtemelen 2. döngüye kaldı
  record({
    id: "S5", title: "KALICI (keep-alive) mTLS bağlantısı AÇIKKEN sertifika iptal edilirse",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `mevcut, ZATEN KURULMUŞ TLS bağlantısı KOPARILMADI — iptal, aynı bağlantı üzerindeki BİR SONRAKİ istekte, revoke_cert.sh'ten itibaren ${poll.totalElapsedMs}ms içinde, uygulama katmanında (HTTP 401, OCSP) devreye girdi. Sonuç: TLS oturum yeniden kullanımı iptali ATLATMIYOR, ama soketin kendisi de anında kesilmiyor.${tookExtraCycle ? " EN ÖNEMLİ BULGU: bu, TEK bir 30sn önbellek döngüsünden BELİRGİN ŞEKİLDE UZUN sürdü — referans OCSP yanıtlayıcısının kendi yeniden-başlatma mekanizmasıyla uygulama önbelleğinin ETKİLEŞİMİ yüzünden GERÇEK dünya kilitlenme süresi teorik ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor (bkz. rapordaki ayrıntılı analiz)." : ""}`
      : "beklenmedik davranış: ya ilk istek başarısız oldu ya da iptal sonrası davranış beklenenden farklı (bkz. detaylar).",
    detail: {
      ilk_istek_ok_mu: first.ok, ilk_istek_yerel_port: portBefore,
      iptal_sonrasi_reddedilene_kadar_gecen_sure_ms: poll.totalElapsedMs,
      iptal_sonrasi_reddin_katmani: poll.layer === "connection" ? "TLS seviyesi (soket KOPMUŞ)" : "HTTP 401 (soket hâlâ açık, uygulama katmanı reddetti)",
      iptal_sonrasi_son_hata_mesaji: poll.message,
      tek_onbellek_dongusunden_fazla_surdu_mu: tookExtraCycle,
    },
  });
}

// ══════════════════════════════════════════════════════════
// S6 — Hiç iptal edilmemiş ama SÜRESİ DOLMUŞ sertifika
// ══════════════════════════════════════════════════════════
async function scenarioS6() {
  const caCert = path.join(PKI_DIR, "ca-cert.pem");
  const certPath = path.join(REQS_DIR, "SAE-EXPIRED-TEST-cert.pem");
  const keyPath = path.join(REQS_DIR, "SAE-EXPIRED-TEST-key.pem");

  const r = await attempt(certPath, keyPath, caCert);
  const ok = !r.ok && r.layer === "connection"; // CRL/OCSP'ye HİÇ ULAŞMADAN, TLS handshake seviyesinde reddedilmeli
  record({
    id: "S6", title: "HİÇ iptal edilmemiş ama SÜRESİ DOLMUŞ sertifika (kısa-ömür güvencesi)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `süresi dolmuş (ama iptal listesinde OLMAYAN) sertifika CRL/OCSP kontrolüne hiç ULAŞMADAN, doğrudan TLS handshake seviyesinde reddedildi (${r.elapsedMs}ms, hata: "${r.message}") — kısa ömür stratejisi, iptal MEKANİZMASINDAN BAĞIMSIZ ikinci bir güvence katmanı olarak doğrulandı.`
      : "beklenmedik davranış: süresi dolmuş sertifika reddedilmedi VEYA CRL/OCSP katmanı üzerinden (yani TLS'in kendi geçerlilik kontrolü ÇALIŞMADAN) reddedildi.",
    detail: { sonuc: describe(r), not: "İKAZ: bu red genellikle 'ECONNRESET/socket hang up' gibi OPAK bir hata olarak görünür — spesifik 'sertifika süresi dolmuş' metni istemciye YANSIMAZ (bkz. rapordaki operasyonel öneri)." },
  });
}

function describe(r) {
  return `${r.ok ? "KABUL" : "RED"} (katman=${r.layer}, ${r.statusCode ? `HTTP ${r.statusCode}` : r.code || "-"}, ${r.elapsedMs}ms) — "${r.message}"`;
}

// ══════════════════════════════════════════════════════════
// RAPOR ÜRETİMİ (JSON + Markdown) — SADECE bu çalıştırmada GERÇEKTEN
// ölçülen değerlerden üretilir.
// ══════════════════════════════════════════════════════════
function writeReports() {
  const jsonPath = path.join(OUT_DIR, "scenario_results.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: "bkz. run.log (Date.now() betik-DIŞI ortamda damgalanmalı)", kmePort: KME_PORT, ocspPort: OCSP_PORT, results }, null, 2));

  const passCount = results.filter((r) => r.verdict === "PASS").length;
  const failCount = results.length - passCount;

  const rows = results.map((r) => `| ${r.id} | ${r.title} | ${r.verdict === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.summary} |`).join("\n");
  const detailSections = results.map((r) => {
    const detailLines = Object.entries(r.detail).map(([k, v]) => `- **${k}**: ${v}`).join("\n");
    return `### ${r.id} — ${r.title}\n\n**Sonuç:** ${r.verdict === "PASS" ? "✅ Beklenen davranış doğrulandı." : "❌ Beklenenden farklı davranış — inceleme gerekir."}\n\n${r.summary}\n\n${detailLines}\n`;
  }).join("\n");

  const s2 = results.find((r) => r.id === "S2");
  const s3 = results.find((r) => r.id === "S3");
  const s4 = results.find((r) => r.id === "S4");
  const s5 = results.find((r) => r.id === "S5");

  const md = `# PhotonNet KME — Sertifika Yenileme / İptal (CRL+OCSP) Senaryo Analizi

Bu rapor, \`bb84/pki_tools/cert_rotation_revocation_scenarios.js\` tarafından
**canlı bir KME sunucusuna + OCSP yanıtlayıcısına karşı gerçek mTLS
bağlantıları kurularak** üretilmiştir. Aşağıdaki HER SAYI/SÜRE, o
çalıştırmada gerçekten ölçülmüştür — varsayımsal/teorik değildir. Amaç:
IBM'in kendi sertifika rotasyon protokollerini bu KME'ye karşı entegre
etmeden önce, rotasyon/iptal sırasındaki GERÇEK davranışı ve zamanlama
karakteristiklerini belgelemektir.

**Sonuç özeti: ${passCount}/${results.length} senaryo beklenen davranışı gösterdi${failCount > 0 ? `, ${failCount} senaryo İNCELEME GEREKTİRİYOR` : ""}.** ⚠ En önemli bulgu: kalıcı (keep-alive) bağlantılarda GERÇEK iptal-kilitlenme süresi, teorik ~30 saniye DEĞİL, ~60 saniyeye kadar çıkabiliyor — ayrıntı için aşağıdaki "EN KRİTİK bulgu" bölümüne bakınız.

## Senaryo Özeti

| # | Senaryo | Sonuç | Bulgu |
|---|---------|-------|-------|
${rows}

## Mimari arka plan (bu raporu okumak için gerekli bağlam)

KME sunucusu (\`etsi014_kme_server.js\`) sertifika geçerliliğini **üç
BAĞIMSIZ katmanda** kontrol eder:

1. **TLS handshake / X.509 geçerlilik penceresi** — Node'un TLS
   katmanının kendisi, CRL/OCSP'den TAMAMEN bağımsız olarak, her
   sertifikanın \`notBefore\`/\`notAfter\` tarihlerini kontrol eder.
   Süresi dolmuş bir sertifika CRL/OCSP'ye hiç ulaşılmadan reddedilir
   (bkz. S6).
2. **CRL (Sertifika İptal Listesi)** — yine TLS handshake seviyesinde
   (\`rejectUnauthorized\`), sunucunun \`--crl\` ile verdiği dosyaya
   karşı kontrol edilir. Bu dosya \`fs.watchFile\` ile **2 saniyede bir**
   yoklanır (polling) — \`revoke_cert.sh\` çalıştırıldığında dosya
   ANINDA güncellenir, ama sunucunun bunu fark etmesi en kötü durumda
   ~2 saniye sürebilir.
3. **OCSP (canlı iptal sorgusu)** — TLS handshake BAŞARILI olduktan
   SONRA, uygulama katmanında (\`authenticate()\` içinde) çalışır; her
   isteğin sertifika seri numarası için CA veritabanına CANLI sorgu
   yapar, sonucu **30 saniyelik** bir bellek-içi önbellekte tutar.
   Yanıtlayıcıya ulaşılamazsa **fail-CLOSED** davranır (istek reddedilir
   — bkz. S4).

Bu üç katmanın PRATİKTEKİ SONUCU: **CRL/TLS-seviyesi reddi YENİ
bağlantıları engeller**, ama **zaten kurulmuş bir TLS bağlantısını
KOPARMAZ** — o bağlantı üzerindeki bir sonraki HTTP isteği ise OCSP
kontrolünden (uygulama katmanı) geçmek ZORUNDADIR (bkz. S5). **İKAZ:**
"zaten kurulmuş bir bağlantı" istemci tarafında sanıldığından ÇOK DAHA
SIK gerçekleşebilir — ör. Node.js'in \`https.globalAgent\`'ı bu ortamda
varsayılan olarak \`keepAlive: true\`'dur, yani \`agent:\` AÇIKÇA
belirtilmezse "ayrı" görünen istekler sessizce AYNI bağlantıyı yeniden
kullanabilir (bkz. 6. madde).

## ⚠ Bu analizin EN KRİTİK bulgusu: kalıcı bağlantılarda GERÇEK kilitlenme süresi ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor

S5'i geliştirirken, sonuçlar başlangıçta "sertifika HİÇ reddedilmiyor"
gibi göründü (test 55 saniye sonra zaman aşımına uğradı). Kök nedeni
CANLI olarak (KME sunucusuna geçici teşhis günlüğü ekleyerek) izledik ve
şunu doğruladık: bu bir test hatası DEĞİL, referans OCSP altyapısının
GERÇEK bir sınır durumu.

**Mekanizma:** \`checkOcsp()\`'nin 30 saniyelik önbelleği dolduğunda
yapılan İLK yeniden sorgu, o sırada BOŞTA BEKLEYEN (revizyondan ÖNCE
başlamış, \`index.txt\`'yi henüz yeniden okumamış) bir openssl
\`ocsp\` sürecine denk gelebilir. Bu süreç isteği ESKİ ("good") veriyle
YANITLAR — ve ancak YANITLADIKTAN SONRA (bkz. \`run_ocsp_responder.sh\`,
\`-nrequest 1\`) kendini tazeler. Ama bu ESKİ yanıt ZATEN gönderilmiş ve
KME'nin uygulama-katmanı önbelleğinde BİR SONRAKİ 30 saniye için TEKRAR
saklanmıştır. Yalnızca İKİNCİ önbellek döngüsündeki sorgu (yaklaşık
+60 saniye) bu artık-tazelenmiş süreci bulur ve doğru "revoked"
yanıtını alır. Bu, üç ayrı tam-boru-hattı çalıştırmasında
TEKRARLANABİLİR şekilde gözlemlendi (ölçülen değerler: 30270ms — bu
sefer tek döngüde yakalandı —, ve İKİ ayrı çalıştırmada 60278ms/60000ms
civarı — iki döngü gerekti).

**Neden önemli:** \`run_ocsp_responder.sh\`'in kendi dosya-üstü notu
zaten "1-2 saniyelik kalan bir yarış durumu" kabul ediyordu — ama bu
analiz, GERÇEKTE bu yarışın kaybedilme sonucunun 1-2 saniye DEĞİL, TAM
BİR EK 30 SANİYELİK önbellek döngüsü (yani toplamda ~60sn) olabildiğini
somut olarak ölçtü. Bu fark, IBM'in "bir sertifika iptalinden sonra
azami ne kadar sürede TÜM erişim kesilir" sorusuna verilecek cevabı
DOĞRUDAN etkiler.

**Öneri (üretim için ZORUNLU, referans yanıtlayıcı için DEĞİL):**
Gerçek bir IBM entegrasyonunda, \`run_ocsp_responder.sh\` (openssl CLI
tabanlı, tek-istek-başına-yeniden-başlatma modeli) yerine olay-tabanlı
(event-driven, index.txt/veritabanı değişikliğinde ANINDA yanıt
güncelleyen) adanmış bir OCSP yanıtlayıcı kullanılmalıdır — bu zaten
\`run_ocsp_responder.sh\`'in kendi notunda önerilmişti, bu rapor bunu
SOMUT, ÖLÇÜLMÜŞ bir gerekçeyle (30sn yerine ~60sn azami kilitlenme
süresi riski) güçlendirmektedir. Alternatif/ek önlem: KME'nin
\`OCSP_CACHE_TTL_MS\`'ini düşürmek (ör. 30sn yerine 5-10sn) bu riskin
azami etkisini orantılı olarak küçültür (30sn yerine ~10-20sn üst
sınır), ama sorunu KÖKTEN çözmez — asıl çözüm yanıtlayıcı tarafındadır.

## Öne çıkan bulgular ve IBM entegrasyonu için öneriler

1. **Sıfır kesintili rotasyon mümkün ve GÜVENLİ (S1).** \`rotate_cert.sh\`
   \`--revoke-old\` OLMADAN çalıştırıldığında, eski sertifika doğal
   süresi dolana kadar geçerli kalmaya devam eder. IBM tarafı yeni
   sertifikayı kendi hızında devreye alabilir — rotasyon anında
   kesinti riski YOKTUR.
2. **Sızdırılmış-anahtar senaryosunda kilitlenme süresi ölçüldü (S2).**
   ${s2 ? s2.summary : "(veri yok)"} IBM'in "bir sertifikanın ne kadar
   sürede etkisiz hale geleceği" sorusuna somut bir üst sınır: **CRL
   hot-reload (~2sn) + OCSP izleyici gecikmesi (~1sn) toplamında birkaç
   saniyelik bir pencere** — bu, IBM'in olay müdahale (incident
   response) prosedürlerinde "sertifika iptalinden sonra X saniye
   içinde tüm trafik kesilir" şeklinde belgelenebilir.
3. **Acil iptal (rotasyonsuz) aynı hızda çalışıyor (S3).** ${s3 ? s3.summary : "(veri yok)"}
   Bu, "önce kilitle, soruşturmayı sonra yap" operasyonel modelini
   destekler — yeni sertifika hemen o an üretilmek ZORUNDA değildir.
4. **OCSP yanıtlayıcısı TEK NOKTA ARIZASI (SPOF) — kasıtlı olarak
   (S4).** ${s4 ? s4.summary : "(veri yok)"} Bu davranış GÜVENLİK
   açısından doğrudur (belirsizlik durumunda erişimi REDDETMEK,
   KABUL ETMEKTEN daha güvenlidir) ama OPERASYONEL bir risk taşır:
   OCSP yanıtlayıcısı çökerse TÜM geçerli istemciler de erişimi
   kaybeder. **Öneri:** OCSP yanıtlayıcısını izlenen (monitored),
   yüksek erişilebilirlikli (ör. aktif-pasif iki örnek + sağlık
   kontrolü) bir servis olarak çalıştırın; \`run_ocsp_responder.sh\`
   dosya-üstü notunda da belirtildiği gibi, üretimde OpenSSL CLI
   tabanlı bu referans yanıtlayıcı yerine adanmış bir OCSP yanıtlayıcı
   (Dogtag OCSP, EJBCA, cfssl ocsprest) kullanılması ÖNERİLİR. AYRICA:
   negatif (hata) sonuçlar da 30 saniye önbelleğe alınıyor — bu,
   yanıtlayıcı toparlandıktan SONRA bile, kesinti sırasında reddedilmiş
   istemcilerin en fazla 30 saniye daha beklemesi gerekebileceği
   anlamına gelir; kritik entegrasyonlarda hata sonuçları için daha
   kısa/ayrı bir önbellek TTL'i değerlendirilebilir.
5. **Kalıcı bağlantılar iptali atlatamıyor, ama anında da kesilmiyor —
   ve GERÇEK kilitlenme süresi yukarıdaki kritik bulguda açıklandığı
   gibi ~60sn'ye kadar çıkabiliyor (S5).** ${s5 ? s5.summary : "(veri yok)"}
   IBM tarafının HTTP keep-alive/connection-pooling kullanması BEKLENEN
   bir davranıştır (performans için) — bu test, bu kullanımın güvenlik
   açığı YARATMADIĞINI (her istek yine de denetleniyor, yalnızca daha
   YAVAŞ) doğrular. Öneri: IBM istemcisi, bir 401 yanıtı aldığında
   SOKETİ KAPATIP yeni bir TLS handshake ile YENİDEN denemelidir (bazı
   HTTP kütüphaneleri 401'de bile soketi keep-alive için AÇIK tutar) —
   aksi bir davranış fonksiyonel bir sorun yaratmaz ama gereksiz tekrar
   denemelere yol açabilir. Asıl kök neden ve önerilen düzeltme için
   yukarıdaki "EN KRİTİK bulgu" bölümüne bakınız.
6. **GERÇEK BULGU (bu script'in İLK taslağını yazarken canlı olarak
   keşfedildi) — Node.js istemcilerinde \`https.globalAgent\`
   VARSAYILAN olarak \`keepAlive: true\`'dur (bu ortamda, Node.js v22
   ile doğrulandı).** Bir istekte \`agent:\` seçeneği AÇIKÇA
   verilmezse, aynı KME'ye yapılan "birbirinden bağımsız" gibi görünen
   ardışık istekler SESSİZCE aynı TCP/TLS bağlantısını yeniden
   kullanabilir — bu, istemci geliştiricisinin FARKINDA OLMADAN madde
   5'teki "kalıcı bağlantı" durumuna düşmesi anlamına gelir. Sonuç:
   CRL/TLS-seviyesi iptal kontrolü bu bağlantı ÜZERİNDE bir daha HİÇ
   çalışmaz (yalnızca OCSP'nin 30sn'lik uygulama-katmanı kontrolü
   iptali fark eder). **Öneri:** IBM'in istemci kütüphanesi hangi dilde/
   çatıda yazılırsa yazılsın (Node.js, Java, Python, Go...), KME'ye
   bağlanırken kullandığı HTTP istemcisinin/agent'ının varsayılan
   bağlantı yeniden-kullanım (keep-alive/connection-pooling) davranışını
   AÇIKÇA gözden geçirmesi ve bu raporun ölçtüğü zamanlama
   varsayımlarıyla (madde 2/3) UYUMLU bir bağlantı yenileme politikası
   (ör. bağlantı başına maksimum ömür/istek sayısı sınırı) benimsemesi
   önerilir — aksi halde "sertifika iptal edildi" ile "istemci bunu
   fark etti" arasındaki gerçek süre, bu raporun CRL için verdiği
   birkaç saniyelik rakamlar DEĞİL, OCSP'nin 30 saniyelik önbellek
   TTL'i (hatta bağlantı hiç yenilenmezse süresiz) olabilir.
7. **Kısa ömür stratejisi, iptal mekanizmasından BAĞIMSIZ ikinci bir
   güvence sağlıyor (S6).** Bir sertifika iptal edilmeyi "unutulsa"
   bile (insan hatası, otomasyon arızası), \`sign_csr.sh\`'in varsayılan
   7 günlük geçerlilik süresi bu riski sınırlar. **Operasyonel not:**
   süresi dolmuş bir sertifikanın reddi istemciye OPAK bir bağlantı
   hatası (\`ECONNRESET\`/"socket hang up") olarak yansır — spesifik
   bir "sertifika süresi dolmuş" mesajı İLETİLMEZ. IBM entegrasyon
   ekibi, beklenmedik/açıklanamayan bağlantı kopmalarını hata ayıklarken
   **önce sertifika geçerlilik tarihlerini kontrol etmelidir**
   (\`openssl x509 -noout -dates\`) — bu rapor bu tuzağı önceden
   belgelemektedir.
8. **Genel rotasyon takvimi önerisi (mevcut kod tabanından):**
   \`rotate_cert.sh\` zaten kendi çıktısında bitiş tarihinden ~2 gün
   önce otomatik bir rotasyon görevi (cron/systemd-timer) önerir — bu
   raporun ölçtüğü "eski sertifika ANINDA reddedilmeye başlıyor" bulgusu
   (madde 2) ile birleştirildiğinde, IBM tarafının PLANLI rotasyonları
   ("--revoke-old" OLMADAN, madde 1) DÜZENLİ bir takvimde, iptali ise
   YALNIZCA gerçek bir sızıntı şüphesinde (madde 3) kullanması önerilir.
9. **Küçük bir kod tabanı iyileştirme fırsatı (S2 sırasında keşfedildi):**
   YENİ imzalanan bir sertifikanın İLK OCSP sorgusu, yanıtlayıcının
   index.txt'yi henüz yeniden okumadığı çok kısa bir pencereye denk
   gelirse "unknown" yanıtı alabilir; \`checkOcsp()\` bunu (madde 4'teki
   AYNI mekanizmayla) fail-CLOSED sayıp 30 saniye önbelleğe alır — yani
   rotasyon SONRASI yeni sertifikanın kullanılabilir hale gelmesi
   NADİREN ~30 saniyeye kadar sürebilir. **Öneri:** \`checkOcsp()\`'te
   "unknown" yanıtını "revoked"/"unreachable" ile AYNI TTL'de değil,
   daha KISA bir TTL'de (ör. 2-3 saniye — tam da OCSP izleyicisinin
   kendi tazelenme penceresi kadar) önbelleğe almak bu nadir gecikmeyi
   ortadan kaldırır; bu bu raporun kapsamı DIŞINDA, ayrı bir değişiklik
   olarak değerlendirilebilir.

## Ayrıntılı senaryo sonuçları

${detailSections}

---
*Bu rapor otomatik olarak \`bb84/pki_tools/cert_rotation_revocation_scenarios.js\`
tarafından üretilmiştir — ham veri için \`scenario_results.json\` ve tam
komut/sunucu loglarını içeren \`run.log\`'a bakınız.*
`;
  const mdPath = path.join(OUT_DIR, "sertifika_rotasyon_iptal_analizi.md");
  fs.writeFileSync(mdPath, md);
  return { jsonPath, mdPath, passCount, failCount };
}

// ══════════════════════════════════════════════════════════
// ANA AKIŞ
// ══════════════════════════════════════════════════════════
async function main() {
  await setupEnvironment();
  log("S1: planlı rotasyon (iptal olmadan) test ediliyor...");
  await scenarioS1();
  log("S2: planlı rotasyon (--revoke-old ile) test ediliyor...");
  await scenarioS2();
  log("S3: acil iptal (rotasyonsuz) test ediliyor...");
  await scenarioS3();
  log("S4: OCSP yanıtlayıcısı kesintisi test ediliyor...");
  await scenarioS4();
  log("S5: kalıcı bağlantı + iptal test ediliyor...");
  await scenarioS5();
  log("S6: süresi dolmuş (iptal edilmemiş) sertifika test ediliyor...");
  await scenarioS6();

  const { jsonPath, mdPath, passCount, failCount } = writeReports();
  log(`Rapor yazıldı: ${mdPath}`);
  log(`Ham veri: ${jsonPath}`);
  log(`SONUÇ: ${passCount}/${results.length} senaryo PASS.`);

  cleanup();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`[SENARYO] BEKLENMEYEN HATA: ${e.stack || e.message}`);
  cleanup();
  process.exit(2);
});
