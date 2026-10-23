#!/usr/bin/env node
"use strict";
/**
 * ocsp_cache_staleness_test.js — OCSP bayatlık kaynaklarının (R1–R3, K1) kesin yeniden üretimi ve düzeltmenin kanıtı
 * ═══════════════════════════════════════════════════════════════════
 * Bağlam: docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md. Kapı 3a'daki "~30 s yeni sertifika gecikmesi" (S1/S2) ve
 * "~60 s keep-alive iptali" (S5) iki katmandan geliyordu:
 *   Yanıtlayıcı (pki_tools/run_ocsp_responder.sh) index izleyicisi:
 *     R1 1 s tarama → yeni imzalanan sertifikaya ~1 s "unknown"
 *     R2 saniye çözünürlüklü mtime → aynı saniyedeki ikinci değişiklik kaçıyordu
 *     R3 ilk tarama yalnız taban kaydediyordu → (yeniden) başlangıçtan sonraki ilk saniyedeki değişiklik HİÇ görülmüyordu
 *        (iptal edilmiş sertifikaya "good")
 *   KME (etsi014_kme_server.js checkOcsp):
 *     K1 belirsiz sonuç (unknown/ulaşılamadı) good ile aynı 30 s önbelleğe alınıyordu
 *
 *   O1 (R3) Yanıtlayıcı başladıktan hemen sonra: sorgu (good) → iptal → 1 s boşta → sorgu "revoked" (6/6)
 *   O2 (R2) Aynı saniyede iki index değişikliği → 2,5 s sonra ikinci değişikliğin sertifikası "good" (8/8)
 *   O3 (R1) Yeni sertifika imzadan 300 ms sonra "good" (10/10)
 *   O4 (K1) Bayat yanıtlayıcı yeni sertifikaya "unknown" der → KME 401 (fail-closed); yanıtlayıcı tazelenince
 *           sertifika ~2 s içinde kabul. Karşılaştırma: --ocsp-indeterminate-ttl-ms=30000 (eski davranış) ile 6 s sonra hâlâ RED
 *   O5 Güvenlik gevşemedi: iptal edilen sertifika 401 "İPTAL" ve tekrar denemede de RED; yanıtlayıcı çökükken RED, 2,5 s sonra da RED
 *   O6 Geçersiz --ocsp-indeterminate-ttl-ms → KME açılmıyor (çıkış kodu 2)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync, execFile, spawn, spawnSync } = require("child_process");

const TOOLS = path.join(__dirname, "pki_tools");
const BASE = Number(process.env.OCSP_TEST_BASE_PORT || 19400);
const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilMsInSecond = async (ms) => { await sleep((((ms - (Date.now() % 1000)) + 1000) % 1000)); };
const procs = [];

function setupPki() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsp-stale-"));
  const pki = path.join(root, "pki"), reqs = path.join(root, "reqs");
  const sh = (s, a) => execFileSync("bash", [path.join(TOOLS, s), ...a], { stdio: "pipe" });
  sh("ca_init.sh", [pki]);
  const mk = (role, cn) => { sh("issue_cert.sh", [reqs, role, cn]); };
  const sign = (role, cn) => sh("sign_csr.sh", [pki, path.join(reqs, `${cn}.csr`), role, "1"]);
  const revoke = (cn) => sh("revoke_cert.sh", [pki, path.join(reqs, `${cn}-cert.pem`)]);
  mk("server", "localhost"); sign("server", "localhost");
  return { root, pki, reqs, mk, sign, revoke, ca: path.join(pki, "ca-cert.pem"), cert: (cn) => path.join(reqs, `${cn}-cert.pem`), key: (cn) => path.join(reqs, `${cn}-key.pem`) };
}
const query = (P, port, cn) => new Promise((res) => execFile("openssl", ["ocsp", "-issuer", P.ca, "-cert", P.cert(cn), "-url", `http://localhost:${port}`, "-CAfile", P.ca, "-timeout", "3"], { timeout: 4000 },
  (e, so, se) => { const o = `${so}\n${se}`; res(/: good/.test(o) ? "good" : /: revoked/.test(o) ? "revoked" : /: unknown/.test(o) ? "unknown" : "error"); }));
function startResponder(P, port) {
  const p = spawn("bash", [path.join(TOOLS, "run_ocsp_responder.sh"), P.pki, String(port)], { stdio: "ignore", detached: true });
  procs.push(p); return p;
}
function stop(p) { try { process.kill(-p.pid, "SIGTERM"); } catch (_) { /* kapalı */ } }
async function waitGood(P, port, cn = "localhost") { for (let i = 0; i < 60; i++) { if (await query(P, port, cn) === "good") return true; await sleep(150); } return false; }

// ── O1: R3 ──
async function o1() {
  const P = setupPki(); const res = [];
  for (let i = 0; i < 6; i++) { P.mk("client", `SAE-R3-${i}`); P.sign("client", `SAE-R3-${i}`); }
  for (let i = 0; i < 6; i++) {
    const port = BASE + 1;
    const r = startResponder(P, port); await waitGood(P, port);
    const before = await query(P, port, `SAE-R3-${i}`);
    P.revoke(`SAE-R3-${i}`);           // yanıtlayıcının ilk saniyesi içinde
    await sleep(1000);
    res.push({ before, after: await query(P, port, `SAE-R3-${i}`) });
    stop(r); await sleep(400);
  }
  fs.rmSync(P.root, { recursive: true, force: true });
  return res;
}
// ── O2: R2 ──
async function o2() {
  const P = setupPki(); const port = BASE + 2; const r = startResponder(P, port); await waitGood(P, port);
  const res = [];
  for (let i = 0; i < 8; i++) {
    P.mk("client", `SAE-A${i}`); P.mk("client", `SAE-B${i}`);
    await query(P, port, "localhost"); await sleep(1300);
    await untilMsInSecond(20); P.sign("client", `SAE-A${i}`);
    const sA = Math.floor(fs.statSync(path.join(P.pki, "ca-db/index.txt")).mtimeMs / 1000);
    await untilMsInSecond(650); P.sign("client", `SAE-B${i}`);
    const sB = Math.floor(fs.statSync(path.join(P.pki, "ca-db/index.txt")).mtimeMs / 1000);
    await sleep(2500);
    res.push({ sameSecond: sA === sB, st: await query(P, port, `SAE-B${i}`) });
  }
  stop(r); fs.rmSync(P.root, { recursive: true, force: true });
  return res;
}
// ── O3: R1 ──
async function o3() {
  const P = setupPki(); const port = BASE + 3; const r = startResponder(P, port); await waitGood(P, port);
  const res = [];
  for (let i = 0; i < 10; i++) {
    P.mk("client", `SAE-N${i}`); await query(P, port, "localhost"); await sleep(400);
    P.sign("client", `SAE-N${i}`); await sleep(300);
    res.push(await query(P, port, `SAE-N${i}`));
  }
  stop(r); fs.rmSync(P.root, { recursive: true, force: true });
  return res;
}

// ── KME yardımcıları ──
function startKme(P, kmePort, ocspPort, extra = []) {
  const p = spawn(process.execPath, [path.join(__dirname, "etsi014_kme_server.js"), `--port=${kmePort}`,
    `--cert=${P.cert("localhost")}`, `--key=${P.key("localhost")}`, `--ca=${P.ca}`, `--ocsp-responder=http://localhost:${ocspPort}`, ...extra],
    { stdio: "ignore", detached: true });
  procs.push(p); return p;
}
const fresh = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
const kmeCall = (P, kmePort, cn) => new Promise((res) => {
  const t = Date.now();
  const req = https.request({ hostname: "localhost", port: kmePort, path: "/api/v1/keys/SAE-PEER/status", cert: fs.readFileSync(P.cert(cn)), key: fs.readFileSync(P.key(cn)), ca: fs.readFileSync(P.ca), agent: fresh }, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { let m = ""; try { m = JSON.parse(d).message || ""; } catch (_) { /* ham */ } res({ status: r.statusCode, msg: m, ms: Date.now() - t }); });
  });
  req.on("error", (e) => res({ status: null, msg: e.code || e.message, ms: Date.now() - t })); req.end();
});
async function waitKme(P, kmePort) { for (let i = 0; i < 60; i++) { const r = await kmeCall(P, kmePort, "localhost"); if (r.status != null) return true; await sleep(150); } return false; }
/** Bayat (izleyicisiz, index anlık görüntüsüyle) yanıtlayıcı: tek süreç, index'i bir kez okur. */
function staticResponder(P, port, indexFile) {
  const p = spawn("openssl", ["ocsp", "-port", String(port), "-index", indexFile, "-CA", P.ca, "-rkey", path.join(P.pki, "ca-key.pem"), "-rsigner", P.ca], { stdio: "ignore", detached: true });
  procs.push(p); return p;
}

// ── O4: K1 ──
async function o4(indeterminateTtl) {
  const P = setupPki();
  const ocspPort = BASE + (indeterminateTtl === 30000 ? 11 : 10), kmePort = ocspPort + 20;
  P.mk("client", "SAE-OLD"); P.sign("client", "SAE-OLD");
  const snap = path.join(P.root, "index-snapshot.txt");
  fs.copyFileSync(path.join(P.pki, "ca-db/index.txt"), snap); // yeni sertifikadan ÖNCEKİ hâl
  P.mk("client", "SAE-NEW"); P.sign("client", "SAE-NEW");
  let resp = staticResponder(P, ocspPort, snap);
  await sleep(500);
  const kme = startKme(P, kmePort, ocspPort, indeterminateTtl != null ? [`--ocsp-indeterminate-ttl-ms=${indeterminateTtl}`] : []);
  await waitKme(P, kmePort);
  const first = await kmeCall(P, kmePort, "SAE-NEW");                 // bayat yanıtlayıcı → unknown → 401
  stop(resp); await sleep(300);
  resp = staticResponder(P, ocspPort, path.join(P.pki, "ca-db/index.txt")); // yanıtlayıcı tazelendi
  await sleep(300);
  const tFix = Date.now(); let accepted = null, last = null;
  while (Date.now() - tFix < 6000) { last = await kmeCall(P, kmePort, "SAE-NEW"); if (last.status === 200) { accepted = Date.now() - tFix; break; } await sleep(200); }
  stop(kme); stop(resp); await sleep(200);
  fs.rmSync(P.root, { recursive: true, force: true });
  return { first, acceptedAfterFixMs: accepted, last };
}

// ── O5: güvenlik ──
async function o5() {
  const P = setupPki(); const ocspPort = BASE + 12, kmePort = ocspPort + 20;
  P.mk("client", "SAE-REV"); P.sign("client", "SAE-REV"); P.mk("client", "SAE-DOWN"); P.sign("client", "SAE-DOWN");
  let resp = startResponder(P, ocspPort); await waitGood(P, ocspPort);
  const kme = startKme(P, kmePort, ocspPort); await waitKme(P, kmePort);
  P.revoke("SAE-REV"); await sleep(1000);
  const rev1 = await kmeCall(P, kmePort, "SAE-REV"); await sleep(2500);
  const rev2 = await kmeCall(P, kmePort, "SAE-REV");
  stop(resp); await sleep(700);
  const down1 = await kmeCall(P, kmePort, "SAE-DOWN"); await sleep(2500);
  const down2 = await kmeCall(P, kmePort, "SAE-DOWN");
  stop(kme); await sleep(200);
  fs.rmSync(P.root, { recursive: true, force: true });
  return { rev1, rev2, down1, down2 };
}

async function main() {
  try {
    const r1 = await o1();
    chk("O1 (R3) Yanıtlayıcı (yeniden) başladıktan hemen sonraki iptal görülüyor: sorgu good → iptal → 1 s boşta → sorgu REVOKED (eski izleyicide bu durumda iptal edilmiş sertifikaya 'good' veriliyordu — S5'in ~60 s'si)",
      r1.length === 6 && r1.every((x) => x.before === "good" && x.after === "revoked"), r1.map((x) => `${x.before}→${x.after}`).join(", "));
    const r2 = await o2(); const same = r2.filter((x) => x.sameSecond);
    chk("O2 (R2) Aynı saniye içindeki iki index değişikliğinden İKİNCİSİ görülüyor: 2,5 s sonra ikinci sertifika GOOD (eski izleyicide 20 denemede 11 kez 'unknown')",
      same.length >= 5 && same.every((x) => x.st === "good"), `aynı saniyeye düşen ${same.length}/${r2.length} deneme: ${same.map((x) => x.st).join(", ")}`);
    const r3 = await o3();
    chk("O3 (R1) Yeni imzalanan sertifika imzadan 300 ms sonra GOOD (eski izleyicide 500 ms'de 4/10 'unknown')",
      r3.every((x) => x === "good"), `${r3.filter((x) => x === "good").length}/${r3.length} good`);
    const k = await o4(null), kOld = await o4(30000);
    out.o4 = { yeni: k, eskiDavranis: kOld };
    chk("O4 (K1) Bayat yanıtlayıcı yeni sertifikaya 'unknown' dediğinde KME fail-CLOSED reddediyor (401); yanıtlayıcı tazelenince sertifika ~2 s içinde KABUL ediliyor. Eski davranışla (--ocsp-indeterminate-ttl-ms=30000) 6 s sonra hâlâ RED",
      k.first.status === 401 && /TANIMIYOR|unknown/i.test(k.first.msg) && k.acceptedAfterFixMs != null && k.acceptedAfterFixMs <= 3000 && kOld.first.status === 401 && kOld.acceptedAfterFixMs == null,
      `ilk istek ${k.first.status}: ${k.first.msg.slice(0, 70)} · tazelendikten ${k.acceptedAfterFixMs} ms sonra kabul · 30 s TTL ile: ${kOld.acceptedAfterFixMs == null ? `6 s sonra hâlâ ${kOld.last && kOld.last.status}` : `${kOld.acceptedAfterFixMs} ms`}`);
    const s = await o5();
    chk("O5 Güvenlik gevşemedi: iptal edilen sertifika 401 'İPTAL' ve 2,5 s sonra da RED (revoked 30 s önbellekte); yanıtlayıcı çökükken GEÇERLİ sertifika RED (fail-closed) ve 2,5 s sonraki yeniden sorguda da RED",
      s.rev1.status === 401 && /İPTAL/.test(s.rev1.msg) && s.rev2.status === 401 && s.down1.status === 401 && /ulaşılamadı/.test(s.down1.msg) && s.down2.status === 401,
      `iptal: ${s.rev1.status}/${s.rev2.status} · çökük: ${s.down1.status} (${s.down1.msg.slice(0, 40)}…)/${s.down2.status}`);
    const bad = spawnSync(process.execPath, [path.join(__dirname, "etsi014_kme_server.js"), "--port=0", "--ocsp-responder=http://localhost:1", "--ocsp-indeterminate-ttl-ms=abc"], { encoding: "utf8", timeout: 5000 });
    chk("O6 Geçersiz --ocsp-indeterminate-ttl-ms (metin) → KME açılmıyor, çıkış kodu 2 (sessiz varsayılan yok)", bad.status === 2, `çıkış ${bad.status}: ${(bad.stderr || "").trim().slice(0, 90)}`);
  } finally {
    for (const p of procs) stop(p);
  }
  out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "ocsp_cache_staleness.json"), JSON.stringify(out, null, 2));
  for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error(e); for (const p of procs) stop(p); process.exit(2); });
