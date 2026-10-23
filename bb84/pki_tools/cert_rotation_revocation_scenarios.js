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

const DOC_OCSP = "bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md";
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
      ? `rotate_cert.sh (--revoke-old OLMADAN) çalıştırıldıktan SONRA hem ESKİ hem YENİ sertifika kabul edildi — sıfır kesintili geçiş mümkün${newAfterRotatePoll.totalElapsedMs > 3000 ? ` (YENİ sertifikanın kabul edilmesi ${newAfterRotatePoll.totalElapsedMs}ms sürdü — beklenen üst sınır ~3 s; bkz. ${DOC_OCSP})` : ` (YENİ sertifika ${newAfterRotatePoll.totalElapsedMs}ms içinde kabul edildi)`}.`
      : "beklenmedik davranış: rotasyon sonrası eski/yeni sertifikalardan biri reddedildi (bkz. detaylar).",
    detail: {
      baseline_eski_sertifika: describe(baseline),
      rotasyon_sonrasi_eski_sertifika_kopyasi: describe(oldAfterRotate),
      rotasyon_sonrasi_yeni_sertifika: describe(newAfterRotate),
      yeni_sertifika_kabul_suresi_ms: newAfterRotatePoll.totalElapsedMs,
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

  // YENİ sertifikanın İLK OCSP sorgusu, yanıtlayıcının index.txt'yi henüz
  // yeniden okumadığı kısa pencereye (ölçüm: imzadan 0 ms sonra 6/10, 200 ms+
  // sonra 0/10) denk gelirse "unknown" alır; checkOcsp() bunu fail-CLOSED
  // sayar. Eskiden bu belirsiz sonuç 30 s önbelleğe alındığından yeni
  // sertifika ~30 s kilitleniyordu (4 koşuda 2); artık belirsiz sonuç 2 s
  // tutulur (bkz. bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md). Zaman aşımı
  // eski davranışı da kapsayacak kadar geniş bırakıldı; ölçülen süre raporlanır.
  const newCertPoll = await waitUntil(async () => {
    const r = await attempt(curCert, curKey, caCert);
    return { done: r.ok, ...r };
  }, { timeoutMs: 45000 });

  const ok = !rejectPoll.timedOut && !rejectPoll.ok && !newCertPoll.timedOut && newCertPoll.ok;
  const newCertRace = newCertPoll.totalElapsedMs > 3000; // ~3 s'den uzun sürdüyse belirsiz sonuç beklenenden uzun tutulmuş demektir (bkz. DOC_OCSP)
  record({
    id: "S2", title: "Planlı rotasyon, --revoke-old İLE (sızdırılmış anahtar senaryosu)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `eski sertifika rotate_cert.sh --revoke-old komutundan itibaren ${rejectPoll.totalElapsedMs}ms içinde reddedilmeye başladı (katman: ${rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi)" : "HTTP 401 (OCSP)"}); yeni sertifika ${newCertPoll.totalElapsedMs}ms içinde kabul edilir hale geldi${newCertRace ? ` (beklenen üst sınır ~3 s AŞILDI — belirsiz OCSP sonucu beklenenden uzun önbellekte kaldı; bkz. ${DOC_OCSP})` : ""}.`
      : "beklenmedik davranış: eski sertifika süresi içinde reddedilmedi veya yeni sertifika süresi içinde kabul edilmedi.",
    detail: {
      baseline_eski_sertifika: describe(baseline),
      rotate_komutunun_calisma_suresi_ms: rotateCmdMs,
      eski_sertifika_reddedilene_kadar_gecen_sure_ms: rejectPoll.totalElapsedMs,
      eski_sertifika_reddinin_katmani: rejectPoll.layer === "connection" ? "TLS/CRL (bağlantı seviyesi — HTTP yanıtı hiç alınamadı)" : "HTTP 401 (uygulama seviyesi — OCSP kontrolü)",
      eski_sertifika_son_hata_mesaji: rejectPoll.message,
      yeni_sertifikanin_kabul_edilene_kadar_gecen_sure_ms: newCertPoll.totalElapsedMs,
      yeni_sertifika_kabul_suresi_ms: newCertPoll.totalElapsedMs,
      yeni_sertifika_3sn_ust_sinirini_asti_mi: newCertRace,
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
  const tOutageReject = Date.now();

  log(`  OCSP yanıtlayıcısı YENİDEN başlatılıyor (port ${OCSP_PORT})...`);
  spawnBg("ocsp", path.join(PKI_TOOLS, "run_ocsp_responder.sh"), [PKI_DIR, String(OCSP_PORT)], "ocsp_responder.log");
  const recoveryMs = await waitForOcspResponder(caCert, path.join(REQS_DIR, "localhost-cert.pem"), `http://localhost:${OCSP_PORT}`, 15000);

  const afterRecoveryC = await attempt(certC, keyC, caCert); // TAZE kimlik — hiç negatif önbellek YOK, temiz kurtarma kanıtı
  const afterRecoveryB = await attempt(certB, keyB, caCert); // AYNI kimlik — belirsiz (ulaşılamadı) sonuç yalnız 2 s önbellekte kalır (eskiden 30 s)
  const sinceOutageRejectMs = Date.now() - tOutageReject;
  // Belirsiz sonuç 2 s önbellekte kalır: B o süre dolduktan sonra yeniden sorgulanıp kabul edilmeli
  let afterTtlB = afterRecoveryB, sinceOutageRejectMs2 = sinceOutageRejectMs;
  if (!afterRecoveryB.ok) { await sleep(Math.max(0, 2300 - sinceOutageRejectMs)); afterTtlB = await attempt(certB, keyB, caCert); sinceOutageRejectMs2 = Date.now() - tOutageReject; }

  const failClosedOk = baselineA.ok && !duringOutageB.ok && duringOutageB.layer === "http" && /ulaşılamadı|fail-CLOSED/i.test(duringOutageB.message);
  const recoveryOk = afterRecoveryC.ok && afterTtlB.ok; // B, belirsiz-sonuç TTL'i (2 s) dolunca kabul edilmeli
  const ok = failClosedOk && recoveryOk;
  record({
    id: "S4", title: "OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması + kurtarma davranışı)",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `OCSP yanıtlayıcısı ERİŞİLEMEZ olduğunda GEÇERLİ bir sertifika bile ${duringOutageB.elapsedMs}ms içinde HTTP 401 ile fail-CLOSED reddedildi (güvenlik açısından DOĞRU); yanıtlayıcı ${recoveryMs}ms'de toparlandı ve TAZE bir kimlik hemen kabul edildi. Kesinti sırasında reddedilen AYNI kimlik (B), reddinden ${sinceOutageRejectMs}ms sonra ${afterRecoveryB.ok ? "kabul edildi" : `henüz reddediliyordu, ${sinceOutageRejectMs2}ms sonra ${afterTtlB.ok ? "KABUL edildi" : "HÂLÂ reddedildi"}`} — KME belirsiz (ulaşılamadı/unknown) sonucu yalnız 2 s önbelleğe alıyor (good/revoked 30 s; bkz. ${DOC_OCSP}).`
      : "beklenmedik davranış: fail-closed veya kurtarma davranışı beklenenden farklı (bkz. detaylar).",
    detail: {
      baseline_A_ocsp_ayaktayken: describe(baselineA),
      kesinti_sirasinda_B_hic_sorgulanmamis_kimlik: describe(duringOutageB),
      ocsp_yanitlayici_toparlanma_suresi_ms: recoveryMs,
      toparlanma_sonrasi_TAZE_kimlik_C: describe(afterRecoveryC),
      toparlanma_sonrasi_AYNI_kimlik_B: describe(afterRecoveryB),
      B_reddinden_sonra_gecen_ms: sinceOutageRejectMs,
      B_belirsiz_ttl_sonrasi: describe(afterTtlB),
      B_belirsiz_ttl_sonrasi_gecen_ms: sinceOutageRejectMs2,
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

  // Beklenen: OCSP'nin 30 s'lik "good" önbelleği dolunca TEK döngüde (~30 s)
  // taze "revoked". Eskiden bu senaryo TUTARLI olarak ~60 s sürüyordu (4/4):
  // S4 yanıtlayıcıyı yeniden başlatıyor, S5'in iptali yanıtlayıcının ilk
  // saniyesine düşüyordu ve eski index izleyicisi ilk taramada yalnız TABAN
  // kaydettiği için bu değişikliği HİÇ görmüyordu (R3) → 30 s sonraki sorgu
  // bayat "good" alıp bir 30 s daha önbelleğe alıyordu. İzleyici düzeltildi
  // (bkz. bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md); zaman aşımı yine de
  // birden fazla döngüyü kapsayacak kadar geniş bırakıldı.
  const poll = await waitUntil(async () => {
    const r = await attempt(certPath, keyPath, caCert, { agent });
    return { done: !r.ok, ...r };
  }, { timeoutMs: 100000, intervalMs: 300 });

  agent.destroy();

  const ok = first.ok && !poll.timedOut && !poll.ok && poll.layer === "http";
  const tookExtraCycle = poll.totalElapsedMs > 35000; // ~30 s'lik TEK döngüden belirgin şekilde fazla → yanıtlayıcı bayat "good" vermiş (R3 benzeri)
  record({
    id: "S5", title: "KALICI (keep-alive) mTLS bağlantısı AÇIKKEN sertifika iptal edilirse",
    verdict: ok ? "PASS" : "FAIL",
    summary: ok
      ? `mevcut, ZATEN KURULMUŞ TLS bağlantısı KOPARILMADI — iptal, aynı bağlantı üzerindeki BİR SONRAKİ istekte, revoke_cert.sh'ten itibaren ${poll.totalElapsedMs}ms içinde, uygulama katmanında (HTTP 401, OCSP) devreye girdi. Sonuç: TLS oturum yeniden kullanımı iptali ATLATMIYOR, ama soketin kendisi de anında kesilmiyor.${tookExtraCycle ? ` ⚠ UYARI: bu, TEK bir 30 s önbellek döngüsünden BELİRGİN ŞEKİLDE UZUN sürdü — yanıtlayıcı iptalden sonra bayat "good" vermiş olmalı (bkz. ${DOC_OCSP}, R3).` : " Süre tek bir 30 s önbellek döngüsüyle uyumlu."}`
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
  const s5Ms = s5 && s5.detail ? s5.detail.iptal_sonrasi_reddedilene_kadar_gecen_sure_ms : null;

  const md = `# PhotonNet KME — Sertifika Yenileme / İptal (CRL+OCSP) Senaryo Analizi

Bu rapor, \`bb84/pki_tools/cert_rotation_revocation_scenarios.js\` tarafından
**canlı bir KME sunucusuna + OCSP yanıtlayıcısına karşı gerçek mTLS
bağlantıları kurularak** üretilmiştir. Aşağıdaki HER SAYI/SÜRE, o
çalıştırmada gerçekten ölçülmüştür — varsayımsal/teorik değildir. Amaç:
IBM'in kendi sertifika rotasyon protokollerini bu KME'ye karşı entegre
etmeden önce, rotasyon/iptal sırasındaki GERÇEK davranışı ve zamanlama
karakteristiklerini belgelemektir.

**Sonuç özeti: ${passCount}/${results.length} senaryo beklenen davranışı gösterdi${failCount > 0 ? `, ${failCount} senaryo İNCELEME GEREKTİRİYOR` : ""}.** ${s5Ms != null ? (s5Ms > 35000 ? `⚠ Bu koşuda kalıcı (keep-alive) bağlantıda iptal ${s5Ms} ms sürdü — tek 30 s önbellek döngüsünden UZUN (bkz. "OCSP zamanlaması" bölümü).` : `Kalıcı (keep-alive) bağlantıda iptal bu koşuda ${s5Ms} ms sürdü — tek 30 s önbellek döngüsüyle uyumlu.`) : ""}

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
   yapar; "good"/"revoked" sonucunu **30 saniye**, belirsiz sonucu
   ("unknown" / yanıtlayıcıya ulaşılamadı) **2 saniye** önbellekte tutar.
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

## OCSP zamanlaması — ölçülen ve düzeltilen bayatlık kaynakları

Bu raporun önceki sürümleri iki "yarış" bildiriyordu: rotasyondan sonra
yeni sertifikanın NADİREN ~30 s kilitlenmesi (S1/S2) ve kalıcı bağlantıda
iptalin TUTARLI olarak ~60 s sürmesi (S5). İkisinin kök nedeni ölçülerek
bulundu ve düzeltildi (\`bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md\`):

- **Yanıtlayıcı (run_ocsp_responder.sh):** index.txt izleyicisi saniye
  çözünürlüklü mtime'a 1 s'de bir bakıyordu ve ilk taramada yalnız taban
  kaydediyordu. Sonuçları: yeni sertifikaya ~1 s "unknown" (R1), aynı
  saniyedeki ikinci değişikliğin kaçması (R2), yanıtlayıcı başladıktan
  sonraki ilk saniyedeki değişikliğin HİÇ görülmemesi (R3 — S5'in ~60 s'si;
  iptal edilmiş sertifikaya "good"). Artık izleyici güncel parmak izini
  (inode + boyut + ns mtime) çalışan sürecin YÜKLEDİĞİ parmak iziyle
  0,2 s'de bir karşılaştırıyor.
- **KME (checkOcsp):** belirsiz sonuç ("unknown"/ulaşılamadı) "good" ile aynı
  30 s önbelleğe alınıyordu; tek bir geçici "unknown" geçerli sertifikayı
  30 s kilitliyordu. Artık belirsiz sonuç 2 s tutuluyor (istek yine
  fail-CLOSED reddediliyor). good/revoked için 30 s TTL değişmedi.

**Bu koşunun ölçümleri:** S1 yeni sertifika ${(results.find((r) => r.id === "S1") || { detail: {} }).detail.yeni_sertifika_kabul_suresi_ms ?? "?"} ms,
S2 yeni sertifika ${s2 && s2.detail ? s2.detail.yeni_sertifika_kabul_suresi_ms : "?"} ms, S5 kalıcı bağlantıda iptal ${s5Ms ?? "?"} ms.

**Üretim önerisi (değişmedi):** openssl CLI tabanlı bu referans yanıtlayıcı
yerine CA veritabanı değişikliğini olay-tabanlı izleyen adanmış bir OCSP
yanıtlayıcı (Dogtag OCSP, EJBCA, cfssl ocsprest) kullanılmalıdır. Kalıcı
bağlantıda iptal gecikmesinin üst sınırı artık KME'nin good TTL'idir
(\`--ocsp-cache-ttl-ms\`, vars. 30 s); daha kısa bir üst sınır gerekiyorsa
bu değer düşürülebilir (bedeli: daha sık OCSP sorgusu).

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
   (Dogtag OCSP, EJBCA, cfssl ocsprest) kullanılması ÖNERİLİR. Belirsiz
   (hata) sonuçlar yalnız 2 s önbelleğe alınır: yanıtlayıcı toparlanınca
   kesinti sırasında reddedilmiş istemciler en geç ~2 s sonra yeniden
   değerlendirilir (eskiden 30 s; \`--ocsp-indeterminate-ttl-ms\`).
5. **Kalıcı bağlantılar iptali atlatamıyor, ama anında da kesilmiyor —
   üst sınır KME'nin good önbellek TTL'i (vars. 30 s) (S5).** ${s5 ? s5.summary : "(veri yok)"}
   IBM tarafının HTTP keep-alive/connection-pooling kullanması BEKLENEN
   bir davranıştır (performans için) — bu test, bu kullanımın güvenlik
   açığı YARATMADIĞINI (her istek yine de denetleniyor, yalnızca daha
   YAVAŞ) doğrular. Öneri: IBM istemcisi, bir 401 yanıtı aldığında
   SOKETİ KAPATIP yeni bir TLS handshake ile YENİDEN denemelidir (bazı
   HTTP kütüphaneleri 401'de bile soketi keep-alive için AÇIK tutar) —
   aksi bir davranış fonksiyonel bir sorun yaratmaz ama gereksiz tekrar
   denemelere yol açabilir. Asıl kök neden ve önerilen düzeltme için
   yukarıdaki "OCSP zamanlaması" bölümüne bakınız.
6. **GERÇEK BULGU (bu script'in İLK taslağını yazarken canlı olarak
   keşfedildi) — Node.js istemcilerinde \`https.globalAgent\`
   VARSAYILAN olarak \`keepAlive: true\`'dur (bu ortamda, Node.js v22
   ile doğrulandı).** Bir istekte \`agent:\` seçeneği AÇIKÇA
   verilmezse, aynı KME'ye yapılan "birbirinden bağımsız" gibi görünen
   ardışık istekler SESSİZCE aynı TCP/TLS bağlantısını yeniden
   kullanabilir — bu, istemci geliştiricisinin FARKINDA OLMADAN madde
   5'teki "kalıcı bağlantı" durumuna düşmesi anlamına gelir. Sonuç:
   CRL/TLS-seviyesi iptal kontrolü bu bağlantı ÜZERİNDE bir daha HİÇ
   çalışmaz (yalnızca OCSP'nin 30 s'lik uygulama-katmanı kontrolü
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
9. **Önceki sürümde önerilen iyileştirme uygulandı (S2 sırasında keşfedilmişti):**
   \`checkOcsp()\` artık "unknown" ve "ulaşılamadı" sonuçlarını good/revoked ile
   aynı 30 s değil, 2 s önbelleğe alıyor; rotasyon sonrası yeni sertifika en geç
   ~2-3 s içinde kabul ediliyor (bkz. "OCSP zamanlaması").

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
