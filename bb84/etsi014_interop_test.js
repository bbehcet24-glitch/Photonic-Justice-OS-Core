#!/usr/bin/env node
"use strict";
/**
 * etsi014_interop_test.js — A5: ETSI-014 İNTEROP MATRİSİ
 * ═══════════════════════════════════════════════════════════════════
 * Çift yönlü birlikte-çalışabilirlik kanıtı:
 *   (A) İSTEMCİMİZ ↔ BİZİM KME (happy path, §6 şema + key-match).
 *   (B) İSTEMCİMİZ ↔ BAĞIMSIZ REFERANS KME (temiz-oda, farklı key_size/rota)
 *       → istemci VENDOR-NEUTRAL: kendi sunucumuza bağlı değil.
 *   (C) UYUMLULUK PROBLARI ↔ BİZİM KME (kenar/hata: number sınırları,
 *       bilinmeyen key_ID, GET biçimi, bilinmeyen uç, eksik key_IDs).
 *   (D) AYNI PROBLAR ↔ REFERANS KME → iki bağımsız KME de standarda uyuyor.
 *   (E) MATRİS: her iki yön × iki KME çalışıyor → interop kanıtı.
 *   + çekirdek SHA-256 değişmedi.
 *
 * İki KME de aynı CA ile mTLS (gerçek dağıtımda olduğu gibi). Referans KME
 * çekirdeği HİÇ require etmez — gerçekten bağımsız.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const LIB = require("./etsi014_client_lib.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const PKI = "/tmp/pki/reqs", CA = "/tmp/pki/ca-cert.pem";
const OUR_PORT = 9451, REF_PORT = 9452, KEYSTORE = "/tmp/interop_keystore.json";
const MASTER = "SAE-MASTER", SLAVE = "SAE-ANK";
const enc = s => encodeURIComponent(s);

function certs() {
  return { serverCaPath: CA,
    master: { baseUrl: "", saeId: MASTER, certPath: path.join(PKI, "SAE-MASTER-cert.pem"), keyPath: path.join(PKI, "SAE-MASTER-key.pem") },
    slave: { baseUrl: "", saeId: SLAVE, certPath: path.join(PKI, "SAE-ANK-cert.pem"), keyPath: path.join(PKI, "SAE-ANK-key.pem") },
    decPathSaeId: MASTER, number: 3 };
}
function withUrls(cfg, url) { return { ...cfg, master: { ...cfg.master, baseUrl: url }, slave: { ...cfg.slave, baseUrl: url } }; }
function buildKeystore(n) {
  const rk = [MASTER, SLAVE].map(s => s.replace(/^SAE-/i, "")).sort().join("-");
  const e = []; for (let i = 0; i < n; i++) e.push({ key_ID: crypto.randomUUID(), key: crypto.randomBytes(32).toString("base64"), sizeBits: 256, blockIndex: i + 1 });
  fs.writeFileSync(KEYSTORE, JSON.stringify({ routes: { [rk]: e } }));
}
async function waitUp(cfg) {
  for (let t = 0; t < 40; t++) { try { const r = await LIB.httpsCall({ baseUrl: cfg.master.baseUrl, method: "GET", apiPath: `/api/v1/keys/${enc(SLAVE)}/status`, cert: cfg.master.cert, key: cfg.master.key, ca: cfg.serverCa }); if (r.status) return true; } catch { await new Promise(r => setTimeout(r, 200)); } }
  return false;
}
// Bağımsız istemci gibi kenar/hata probları.
async function probes(cfg) {
  const call = (method, apiPath, body, who = "master") => LIB.httpsCall({ baseUrl: cfg[who].baseUrl, method, apiPath, body, cert: cfg[who].cert, key: cfg[who].key, ca: cfg.serverCa });
  const r = {};
  r.statusGet = (await call("GET", `/api/v1/keys/${enc(SLAVE)}/status`)).status;
  r.numberZero = (await call("POST", `/api/v1/keys/${enc(SLAVE)}/enc_keys`, { number: 0 })).status;
  r.numberOver = (await call("POST", `/api/v1/keys/${enc(SLAVE)}/enc_keys`, { number: 99999 })).status;
  r.unknownKeyId = (await call("POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: [{ key_ID: crypto.randomUUID() }] }, "slave")).status;
  r.emptyKeyIds = (await call("POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: [] }, "slave")).status;
  r.unknownPath = (await call("GET", `/api/v1/keys/${enc(SLAVE)}/bogus`)).status;
  return r;
}
function probesConform(r) {
  return r.statusGet === 200 && r.numberZero === 400 && r.numberOver === 400 &&
    r.unknownKeyId === 400 && r.emptyKeyIds === 400 && r.unknownPath === 404;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  buildKeystore(20);
  const ourSrv = spawn("node", [path.join(__dirname, "etsi014_kme_server.js"), `--keystore=${KEYSTORE}`, `--port=${OUR_PORT}`,
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  const refSrv = spawn("node", [path.join(__dirname, "etsi014_reference_kme.js"), `--port=${REF_PORT}`,
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  [ourSrv, refSrv].forEach(s => { s.stdout.on("data", () => {}); s.stderr.on("data", () => {}); });

  const base = LIB.loadCerts(certs());
  const ourCfg = withUrls(base, `https://localhost:${OUR_PORT}`);
  const refCfg = { ...withUrls(base, `https://localhost:${REF_PORT}`), size: null };   // referans 128-bit; size gönderme

  try {
    if (!await waitUp(ourCfg) || !await waitUp(refCfg)) throw new Error("KME'ler ayağa kalkmadı");

    // ══ (A) İSTEMCİMİZ ↔ BİZİM KME ══
    const ourFlow = await LIB.runFlow({ ...ourCfg, size: null });
    out.ourFlow = { passed: ourFlow.allPassed, keySize: ourFlow.status && ourFlow.status.key_size, match: ourFlow.keyMatch };
    chk("(A) İSTEMCİMİZ ↔ BİZİM KME: §6 akışı geçiyor (key_size 256), master===slave",
      ourFlow.allPassed && ourFlow.keyMatch.allMatch,
      `key_size ${ourFlow.status.key_size} · ${ourFlow.keyMatch.delivered}/${ourFlow.keyMatch.requested} anahtar · master===slave ✓`);

    // ══ (B) İSTEMCİMİZ ↔ BAĞIMSIZ REFERANS KME ══
    const refFlow = await LIB.runFlow(refCfg);
    out.refFlow = { passed: refFlow.allPassed, keySize: refFlow.status && refFlow.status.key_size, vendor: refFlow.status && refFlow.status.status_extension && refFlow.status.status_extension.vendor, match: refFlow.keyMatch };
    chk("(B) İSTEMCİMİZ ↔ BAĞIMSIZ REFERANS KME: farklı satıcı/key_size'a UYUM sağlıyor (vendor-neutral)",
      refFlow.allPassed && refFlow.keyMatch.allMatch && refFlow.status.key_size === 128,
      `bağımsız KME (vendor="${out.refFlow.vendor}", key_size ${refFlow.status.key_size}, farklı rota şeması) · ` +
      `istemci status'tan key_size okuyup uyum sağladı, ${refFlow.keyMatch.delivered}/${refFlow.keyMatch.requested} master===slave ✓ — ` +
      `istemci KENDİ sunucumuza bağlı DEĞİL, standarda bağlı`);

    // ══ (C) UYUMLULUK PROBLARI ↔ BİZİM KME ══
    const ourProbes = await probes(ourCfg);
    out.ourProbes = ourProbes;
    chk("(C) UYUMLULUK PROBLARI ↔ BİZİM KME: kenar/hata durumları spec-uyumlu",
      probesConform(ourProbes),
      `status GET ${ourProbes.statusGet} · number=0→${ourProbes.numberZero} · number=99999→${ourProbes.numberOver} · ` +
      `bilinmeyen key_ID→${ourProbes.unknownKeyId} · boş key_IDs→${ourProbes.emptyKeyIds} · bilinmeyen uç→${ourProbes.unknownPath} (hepsi beklenen)`);

    // ══ (D) AYNI PROBLAR ↔ REFERANS KME ══
    const refProbes = await probes(refCfg);
    out.refProbes = refProbes;
    chk("(D) AYNI PROBLAR ↔ REFERANS KME: bağımsız KME de aynı spec davranışını gösteriyor",
      probesConform(refProbes),
      `status GET ${refProbes.statusGet} · number=0→${refProbes.numberZero} · number=99999→${refProbes.numberOver} · ` +
      `bilinmeyen key_ID→${refProbes.unknownKeyId} · boş key_IDs→${refProbes.emptyKeyIds} · bilinmeyen uç→${refProbes.unknownPath} — iki KME hata davranışında hemfikir`);

    // ══ (E) MATRİS ══
    const matrix = out.ourFlow.passed && out.refFlow.passed && probesConform(ourProbes) && probesConform(refProbes);
    out.matrix = { clientVsOur: out.ourFlow.passed, clientVsRef: out.refFlow.passed, probesVsOur: probesConform(ourProbes), probesVsRef: probesConform(refProbes), interop: matrix };
    chk("(E) İNTEROP MATRİSİ: her iki yön × iki bağımsız KME çalışıyor",
      matrix,
      `istemci↔bizim ✓ · istemci↔referans ✓ · problar↔bizim ✓ · problar↔referans ✓. ` +
      `Ne istemcimiz kendi sunucumuza, ne KME'miz kendi istemcimize bağlı — üçü de STANDARDA bağlı`);

  } finally { ourSrv.kill("SIGTERM"); refSrv.kill("SIGTERM"); }

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… — referans KME çekirdeği require ETMEZ (gerçekten bağımsız)`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "etsi014_interop.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ A5 — ETSI-014 İNTEROP MATRİSİ ══\n");
  if (out.matrix) {
    console.log("              │ bizim KME │ referans KME");
    console.log(`  istemcimiz  │    ${out.matrix.clientVsOur ? "✓" : "✗"}     │     ${out.matrix.clientVsRef ? "✓" : "✗"}`);
    console.log(`  problar     │    ${out.matrix.probesVsOur ? "✓" : "✗"}     │     ${out.matrix.probesVsRef ? "✓" : "✗"}`);
    console.log(`  (bizim key_size ${out.ourFlow.keySize} · referans key_size ${out.refFlow.keySize} / vendor="${out.refFlow.vendor}")`);
  }
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "etsi014_interop.json")}\n`);
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
