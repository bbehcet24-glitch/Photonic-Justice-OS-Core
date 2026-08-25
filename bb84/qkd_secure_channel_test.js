#!/usr/bin/env node
"use strict";
/**
 * qkd_secure_channel_test.js — A2 QKD anahtarıyla gerçek TLS tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * Klasik yığının ETSI-014 ile TESLİM ETTİĞİ anahtarın GERÇEK bir TLS
 * oturumunu kurduğunu uçtan uca gösterir:
 *   (A) ETSI-014 TESLİM: master enc_keys, slave dec_keys → İKİSİ AYNI anahtarı
 *       key_ID ile alır (Faz 0 garantisi).
 *   (B) TLS OTURUMU: bu QKD anahtarı PSK olarak → gerçek TLS el sıkışması,
 *       AEAD cipher, şifreli yük yankılanıyor.
 *   (C) YANLIŞ ANAHTAR REDDİ: QKD anahtarı olmayan istemci el sıkışmayı
 *       geçemez → güvenliğin kökü gerçekten QKD anahtarı.
 *   (D) HİBRİT İLERİ-GİZLİLİK: ECDHE-PSK → efemer ECDHE ⊕ QKD PSK; güvenlik
 *       ikisinden biri güvenliyse ayakta.
 *   (E) ANAHTAR TEL ÜSTÜNDE DEĞİL: pasif dinleyici tüm el sıkışma baytlarını
 *       kaydeder; ham QKD anahtarı baytları GEÇMİYOR (yalnız kimlik + türetim).
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const LIB = require("./etsi014_client_lib.js");
const SC = require("./qkd_secure_channel.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const PKI = "/tmp/pki/reqs", CA = "/tmp/pki/ca-cert.pem";
const PORT = 9445, KEYSTORE = "/tmp/qkdtls_keystore.json";
const MASTER = "SAE-MASTER", SLAVE = "SAE-ANK", KEY_BYTES = 32;
const enc = s => encodeURIComponent(s);

function buildKeystore(n) {
  const strip = s => s.replace(/^SAE-/i, "");
  const routeKey = [strip(MASTER), strip(SLAVE)].sort().join("-");
  const entries = [];
  for (let i = 0; i < n; i++) entries.push({ key_ID: crypto.randomUUID(),
    key: crypto.randomBytes(KEY_BYTES).toString("base64"), sizeBits: KEY_BYTES * 8, blockIndex: i + 1 });
  fs.writeFileSync(KEYSTORE, JSON.stringify({ routes: { [routeKey]: entries } }));
  return routeKey;
}
function certs() {
  return { ca: fs.readFileSync(CA),
    master: { cert: fs.readFileSync(path.join(PKI, "SAE-MASTER-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-MASTER-key.pem")) },
    slave: { cert: fs.readFileSync(path.join(PKI, "SAE-ANK-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-ANK-key.pem")) } };
}
const base = `https://localhost:${PORT}`;

async function waitUp(cr) {
  for (let t = 0; t < 40; t++) {
    try { const r = await LIB.httpsCall({ baseUrl: base, method: "GET", apiPath: `/api/v1/keys/${enc(SLAVE)}/status`, cert: cr.master.cert, key: cr.master.key, ca: cr.ca }); if (r.status) return true; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();
  const cr = certs();

  buildKeystore(4);
  const srv = spawn("node", [path.join(__dirname, "etsi014_kme_server.js"),
    `--keystore=${KEYSTORE}`, `--port=${PORT}`, `--cert=${path.join(PKI, "localhost-cert.pem")}`,
    `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});

  try {
    if (!await waitUp(cr)) throw new Error("KME ayağa kalkmadı");

    // ══ (A) ETSI-014 TESLİM — master ve slave AYNI anahtarı alır ══
    const ek = await LIB.httpsCall({ baseUrl: base, method: "POST", apiPath: `/api/v1/keys/${enc(SLAVE)}/enc_keys`,
      body: { number: 1, size: 256 }, cert: cr.master.cert, key: cr.master.key, ca: cr.ca });
    const masterKey = ek.json.keys[0];
    const dk = await LIB.httpsCall({ baseUrl: base, method: "POST", apiPath: `/api/v1/keys/${enc(MASTER)}/dec_keys`,
      body: { key_IDs: [{ key_ID: masterKey.key_ID }] }, cert: cr.slave.cert, key: cr.slave.key, ca: cr.ca });
    const slaveKey = dk.json.keys[0];
    const same = masterKey.key === slaveKey.key;
    const psk = Buffer.from(masterKey.key, "base64");
    out.delivery = { key_ID: masterKey.key_ID.slice(0, 8), same, pskBytes: psk.length };
    chk("(A) ETSI-014 TESLİM: master ve slave AYNI QKD anahtarını key_ID ile alır",
      same && psk.length === 32,
      `key_ID ${masterKey.key_ID.slice(0, 8)}… · master.key === slave.key ${same ? "✓" : "✗"} · ${psk.length} bayt (256-bit) PSK olarak hazır`);

    // ══ (B) TLS OTURUMU — QKD anahtarı PSK ══
    const sess = await SC.establishTls({ serverPsk: psk, clientPsk: Buffer.from(slaveKey.key, "base64"), payload: "PhotonNet · QKD-korumalı yük" });
    out.tls = { ok: sess.ok, cipher: sess.cipher, protocol: sess.protocol, echoed: sess.echoed };
    chk("(B) TLS OTURUMU: QKD anahtarı PSK olarak gerçek TLS el sıkışmasını kuruyor, şifreli yük yankılanıyor",
      sess.ok && sess.echoed && /GCM|CHACHA/.test(sess.cipher || ""),
      `${sess.protocol} · cipher ${sess.cipher} (AEAD) · şifreli yük gidip yankı olarak döndü ✓ — ` +
      `oturumun kökü QKD-teslim anahtarı`);

    // ══ (C) YANLIŞ ANAHTAR REDDİ ══
    const wrong = await SC.establishTls({ serverPsk: psk, clientPsk: crypto.randomBytes(32), payload: "x", timeoutMs: 4000 });
    out.wrongKey = { ok: wrong.ok, error: wrong.error };
    chk("(C) YANLIŞ ANAHTAR REDDİ: QKD anahtarı olmayan istemci el sıkışmayı GEÇEMEZ",
      !wrong.ok,
      `yanlış PSK ile istemci → el sıkışma BAŞARISIZ ("${(wrong.error || "").slice(0, 44)}…"). ` +
      `Güvenliğin kökü gerçekten QKD anahtarı — anahtar olmadan oturum kurulamıyor`);

    // ══ (D) HİBRİT İLERİ-GİZLİLİK ══
    const hybrid = /ECDHE-PSK/.test(sess.cipher || "");
    out.hybrid = { cipher: sess.cipher, ecdhePsk: hybrid };
    chk("(D) HİBRİT: ECDHE-PSK → efemer ECDHE ⊕ QKD PSK (ikisinden biri güvenliyse ayakta)",
      hybrid,
      `cipher ${sess.cipher}: efemer ECDHE ileri-gizlilik + QKD PSK birlikte. ` +
      `Klasik DH kırılsa QKD korur; QKD ele geçse ECDHE korur — QKD-KEM hibrit modeli`);

    // ══ (E) ANAHTAR TEL ÜSTÜNDE DEĞİL ══
    const tapped = await SC.establishTls({ serverPsk: psk, clientPsk: psk, payload: "gizli", tap: true });
    const wireHasKey = tapped.recorded ? tapped.recorded.includes(psk) : true;
    out.wire = { recordedBytes: tapped.recorded ? tapped.recorded.length : 0, keyOnWire: wireHasKey };
    chk("(E) ANAHTAR TEL ÜSTÜNDE DEĞİL: pasif dinleyici ham QKD anahtarını GÖRMÜYOR",
      tapped.ok && !wireHasKey,
      `pasif dinleyici ${tapped.recorded ? tapped.recorded.length : 0} bayt el sıkışma kaydetti; ham 32-baytlık QKD anahtarı ` +
      `bu baytlarda YOK (${wireHasKey ? "VAR ✗" : "yok ✓"}). PSK-TLS yalnız kimlik dizgesi + türetim gönderir, anahtarı değil`);

  } finally {
    srv.kill("SIGTERM");
  }

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — TLS/PSK katmanda, çekirdek sabit`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "qkd_secure_channel.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ A2 — QKD ANAHTARIYLA GERÇEK TLS OTURUMU ══\n");
  if (out.delivery) console.log(`  (A) ETSI-014 teslim: key_ID ${out.delivery.key_ID}… · master===slave ${out.delivery.same ? "✓" : "✗"} · ${out.delivery.pskBytes} bayt PSK`);
  if (out.tls) console.log(`  (B) TLS: ${out.tls.protocol} · ${out.tls.cipher} · yankı ${out.tls.echoed ? "✓" : "✗"}`);
  if (out.wrongKey) console.log(`  (C) yanlış anahtar: el sıkışma ${out.wrongKey.ok ? "GEÇTİ ✗" : "reddedildi ✓"}`);
  if (out.hybrid) console.log(`  (D) hibrit: ECDHE-PSK ${out.hybrid.ecdhePsk ? "✓" : "✗"}`);
  if (out.wire) console.log(`  (E) tel üstünde anahtar: ${out.wire.keyOnWire ? "VAR ✗" : "yok ✓"} (${out.wire.recordedBytes} bayt kaydedildi)`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "qkd_secure_channel.json")}\n`);
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
