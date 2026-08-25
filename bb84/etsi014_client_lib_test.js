#!/usr/bin/env node
"use strict";
/**
 * etsi014_client_lib_test.js — genelleştirilmiş istemcinin LOOPBACK doğrulaması
 * ═══════════════════════════════════════════════════════════════════
 * etsi014_client_lib.runFlow'u YEREL KME'mize karşı (mTLS) koşturur —
 * QuKayDee'ye yöneltmeden önce istemci mantığının DOĞRU olduğunu kanıtlar.
 * Geçerse: aynı istemci, config (URL + sertifika) değişimiyle gerçek
 * QuKayDee ucuna aynen bağlanır (bkz. etsi014_qukaydee_client.js).
 *
 * Yerel KME tek örnektir → master ve slave aynı baseUrl'e bağlanır
 * (QuKayDee'de bunlar ayrı kme-1/kme-2 olur; runFlow ikisini de destekler).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const LIB = require("./etsi014_client_lib.js");

const PKI = "/tmp/pki/reqs", CA = "/tmp/pki/ca-cert.pem";
const PORT = 9444, KEYSTORE = "/tmp/liblb_keystore.json";
const MASTER = "SAE-MASTER", SLAVE = "SAE-ANK", KEY_BYTES = 32;

function buildKeystore(n) {
  const strip = s => s.replace(/^SAE-/i, "");
  const routeKey = [strip(MASTER), strip(SLAVE)].sort().join("-");
  const entries = [];
  for (let i = 0; i < n; i++) entries.push({ key_ID: crypto.randomUUID(),
    key: crypto.randomBytes(KEY_BYTES).toString("base64"), sizeBits: KEY_BYTES * 8, blockIndex: i + 1 });
  fs.writeFileSync(KEYSTORE, JSON.stringify({ routes: { [routeKey]: entries } }));
  return routeKey;
}

async function waitUp(cfg, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await LIB.httpsCall({ baseUrl: cfg.master.baseUrl, method: "GET",
      apiPath: `/api/v1/keys/${encodeURIComponent(SLAVE)}/status`, cert: cfg.master.cert, key: cfg.master.key, ca: cfg.serverCa });
      if (r.status) return true; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const routeKey = buildKeystore(8);
  const srv = spawn("node", [path.join(__dirname, "etsi014_kme_server.js"),
    `--keystore=${KEYSTORE}`, `--port=${PORT}`,
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`],
    { stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});

  // Loopback config: master ve slave aynı yerel KME'ye (QuKayDee'de ayrı olurdu).
  const cfg = LIB.loadCerts({
    serverCaPath: CA, number: 3, size: 256, decPathSaeId: MASTER,
    master: { baseUrl: `https://localhost:${PORT}`, saeId: MASTER, certPath: path.join(PKI, "SAE-MASTER-cert.pem"), keyPath: path.join(PKI, "SAE-MASTER-key.pem") },
    slave: { baseUrl: `https://localhost:${PORT}`, saeId: SLAVE, certPath: path.join(PKI, "SAE-ANK-cert.pem"), keyPath: path.join(PKI, "SAE-ANK-key.pem") },
  });

  try {
    const up = await waitUp(cfg);
    chk("Yerel KME mTLS ucu ayağa kalktı (loopback)", up, up ? `https://localhost:${PORT} · route '${routeKey}'` : "sunucu dinlemedi");
    if (!up) throw new Error("server-down");

    const res = await LIB.runFlow(cfg);
    for (const c of res.checks) out.checks.push(c);   // lib'in 3 §6 kontrolü
    chk("Genelleştirilmiş istemci uçtan uca GEÇTİ (QuKayDee'ye config-hazır)",
      res.allPassed && res.keyMatch.allMatch,
      `master===slave ${res.keyMatch.delivered}/${res.keyMatch.requested} · lib runFlow tüm §6 kontrolleri ${res.allPassed ? "geçti ✓" : "başarısız ✗"} — ` +
      `QuKayDee'ye geçiş yalnız config (URL+sertifika) değişimi`);
  } finally {
    srv.kill("SIGTERM");
  }

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "etsi014_client_lib.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ GENELLEŞTİRİLMİŞ ETSI-014 İSTEMCİ — LOOPBACK DOĞRULAMA ══\n");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ — istemci QuKayDee'ye config-hazır" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
