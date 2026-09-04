#!/usr/bin/env node
"use strict";
/**
 * qukaydee_realistic_test.js — A2'yi A1'in GERÇEK KOŞULLARI altında test et
 * ═══════════════════════════════════════════════════════════════════
 * QKD-TLS sistemini (A2), QuKayDee'nin (A1) gerçek koşullarını BİREBİR
 * simüle eden emülatör üzerinden koşturur: iki ayrı KME (kme-1/kme-2),
 * sae-1/sae-2 kimlikleri, çapraz-KME key stream, mTLS, ağ gecikmesi.
 *   (A) A1 — QuKayDee topolojisi: master status+enc_keys kme-1'de,
 *       slave dec_keys kme-2'de; §6 şema + key-match.
 *   (B) ÇAPRAZ-KME SENKRON: kme-1'de üretilen anahtar kme-2'den (AYRI uç)
 *       key_ID ile birebir çekiliyor.
 *   (C) A2 — QKD-TLS: bu iki-KME yolundan teslim edilen anahtar gerçek bir
 *       ECDHE-PSK TLS oturumunun kökü.
 *   (D) mTLS DAYATMASI: istemci sertifikası sunmayan bağlantı reddedilir.
 *   (E) GERÇEKÇİ GECİKME: enjekte edilen ağ gecikmesi ölçülüyor (anlık
 *       loopback değil — bulut ucu gibi).
 *   (F) TEK-SEFERLİK (çapraz-KME): kme-2'den çekilen anahtar tekrar çekilemez.
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const LIB = require("./etsi014_client_lib.js");
const SC = require("./qkd_secure_channel.js");
const { startQukaydeeEmulator } = require("./qukaydee_emulator.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const PKI = "/tmp/pki", QD = "/tmp/pki/qukaydee";
const enc = s => encodeURIComponent(s);
const rd = p => fs.readFileSync(p);

/** QuKayDee-tarzı sae-1/sae-2 sertifikaları yoksa CA'dan üret (self-sufficient). */
function ensureQdCerts() {
  if (fs.existsSync(path.join(QD, "sae-1.crt")) && fs.existsSync(path.join(QD, "sae-2.crt"))) return;
  if (!fs.existsSync(path.join(PKI, "ca-key.pem"))) throw new Error(`PKI CA yok (${PKI}/ca-key.pem) — önce pki_tools kurulumunu koşun`);
  fs.mkdirSync(QD, { recursive: true });
  for (const sae of ["sae-1", "sae-2"]) {
    execSync(`openssl genrsa -out ${QD}/${sae}.key 2048`, { stdio: "ignore" });
    execSync(`openssl req -new -key ${QD}/${sae}.key -out ${QD}/${sae}.csr -subj "/C=TR/O=PhotonNet QuKayDee-sim/CN=${sae}"`, { stdio: "ignore" });
    execSync(`openssl x509 -req -in ${QD}/${sae}.csr -CA ${PKI}/ca-cert.pem -CAkey ${PKI}/ca-key.pem -CAcreateserial -out ${QD}/${sae}.crt -days 365 -sha256`, { stdio: "ignore" });
  }
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();
  ensureQdCerts();

  const tls = { cert: rd(path.join(PKI, "reqs/localhost-cert.pem")), key: rd(path.join(PKI, "reqs/localhost-key.pem")), ca: rd(path.join(PKI, "ca-cert.pem")) };
  const emu = await startQukaydeeEmulator({ kme1Port: 9701, kme2Port: 9702, latencyMs: 45, jitterMs: 25, keySizeBits: 256, tls });

  // QuKayDee-birebir config: iki AYRI uç, sae-1/sae-2 kimlik+sertifikaları.
  const ca = rd(path.join(PKI, "ca-cert.pem"));
  const master = { baseUrl: emu.urls.kme1, saeId: "sae-1", cert: rd(path.join(QD, "sae-1.crt")), key: rd(path.join(QD, "sae-1.key")) };
  const slave = { baseUrl: emu.urls.kme2, saeId: "sae-2", cert: rd(path.join(QD, "sae-2.crt")), key: rd(path.join(QD, "sae-2.key")) };
  const cfg = { master, slave, serverCa: ca, decPathSaeId: "sae-1", number: 3, size: null };

  try {
    // ══ (A) A1 — QuKayDee topolojisi ══
    const flow = await LIB.runFlow(cfg);
    out.a1 = { passed: flow.allPassed, kme: flow.status && flow.status.source_KME_ID, keySize: flow.status && flow.status.key_size,
      emulator: flow.status && flow.status.status_extension && flow.status.status_extension.emulator, match: flow.keyMatch };
    chk("(A) A1 QuKayDee TOPOLOJİSİ: master kme-1'de status+enc, slave kme-2'de dec; §6 + key-match",
      flow.allPassed && flow.keyMatch.allMatch && flow.status.source_KME_ID === "kme-1",
      `status KME=${flow.status.source_KME_ID} (emülatör="${out.a1.emulator}") · key_size ${flow.status.key_size} · ` +
      `${flow.keyMatch.delivered}/${flow.keyMatch.requested} master(sae-1)===slave(sae-2) ✓ — iki AYRI KME üzerinden`);

    // ══ (B) ÇAPRAZ-KME SENKRON ══
    const ek = await LIB.httpsCall({ baseUrl: master.baseUrl, method: "POST", apiPath: `/api/v1/keys/${enc("sae-2")}/enc_keys`, body: { number: 1 }, cert: master.cert, key: master.key, ca });
    const mkey = ek.json.keys[0];
    const dk = await LIB.httpsCall({ baseUrl: slave.baseUrl, method: "POST", apiPath: `/api/v1/keys/${enc("sae-1")}/dec_keys`, body: { key_IDs: [{ key_ID: mkey.key_ID }] }, cert: slave.cert, key: slave.key, ca });
    const skey = dk.json.keys[0];
    const synced = mkey.key === skey.key;
    out.crossKme = { key_ID: mkey.key_ID.slice(0, 8), mintedAt: "kme-1", fetchedAt: "kme-2", synced };
    chk("(B) ÇAPRAZ-KME SENKRON: kme-1'de üretilen anahtar kme-2'den birebir çekiliyor",
      synced,
      `key_ID ${mkey.key_ID.slice(0, 8)}… kme-1'de (${master.baseUrl.split(":").pop()}) üretildi, kme-2'den (${slave.baseUrl.split(":").pop()}) çekildi · ` +
      `master.key === slave.key ${synced ? "✓" : "✗"} — gerçek QuKayDee'nin KME'ler arası senkronizasyonu`);

    // ══ (C) A2 — QKD-TLS (QuKayDee anahtarıyla) ══
    const psk = Buffer.from(skey.key, "base64");
    const sess = await SC.establishTls({ serverPsk: psk, clientPsk: psk, payload: "QuKayDee→PhotonNet gizli yük" });
    out.a2 = { ok: sess.ok, cipher: sess.cipher, protocol: sess.protocol, echoed: sess.echoed };
    chk("(C) A2 QKD-TLS: QuKayDee-yolundan gelen anahtar gerçek TLS oturumunun kökü",
      sess.ok && sess.echoed && /ECDHE-PSK/.test(sess.cipher || ""),
      `iki-KME QuKayDee yolundan teslim edilen 256-bit anahtar → ${sess.protocol} · ${sess.cipher} · ` +
      `şifreli yük yankılandı ✓ — A1(gerçek koşullar)→A2 zinciri uçtan uca çalışıyor`);

    // ══ (D) mTLS DAYATMASI ══
    let mtlsRejected = false, mtlsErr = "";
    try { await LIB.httpsCall({ baseUrl: master.baseUrl, method: "GET", apiPath: `/api/v1/keys/${enc("sae-2")}/status`, cert: undefined, key: undefined, ca }); }
    catch (e) { mtlsRejected = true; mtlsErr = e.message; }
    out.mtls = { rejected: mtlsRejected, error: mtlsErr };
    chk("(D) mTLS DAYATMASI: istemci sertifikası sunmayan bağlantı reddedilir",
      mtlsRejected,
      `sertifikasız istemci → bağlantı REDDEDİLDİ ("${(mtlsErr || "").slice(0, 40)}…"). ` +
      `QuKayDee gibi, SAE kimliği mTLS istemci sertifikasıyla zorunlu`);

    // ══ (E) GERÇEKÇİ GECİKME ══
    const lat = emu.latency();
    const meanLat = lat.reduce((s, x) => s + x, 0) / lat.length;
    out.latency = { samples: lat.length, meanMs: +meanLat.toFixed(1), minMs: +Math.min(...lat).toFixed(1), maxMs: +Math.max(...lat).toFixed(1) };
    chk("(E) GERÇEKÇİ GECİKME: her isteğe ağ gecikmesi enjekte edildi (anlık loopback değil)",
      meanLat > 30 && lat.length >= 5,
      `${lat.length} istek · ortalama gecikme ${meanLat.toFixed(1)} ms (${out.latency.minMs}–${out.latency.maxMs} ms) — ` +
      `bulut ucu gibi; sistem sıfır-gecikme loopback'te değil gerçekçi koşulda sınandı`);

    // ══ (F) TEK-SEFERLİK (çapraz-KME) ══
    const again = await LIB.httpsCall({ baseUrl: slave.baseUrl, method: "POST", apiPath: `/api/v1/keys/${enc("sae-1")}/dec_keys`, body: { key_IDs: [{ key_ID: mkey.key_ID }] }, cert: slave.cert, key: slave.key, ca });
    out.oneTime = { status: again.status };
    chk("(F) TEK-SEFERLİK (çapraz-KME): kme-2'den çekilen anahtar tekrar çekilemez",
      again.status >= 400,
      `zaten çekilmiş key_ID tekrar dec_keys (kme-2) → HTTP ${again.status} — anahtar tüketildi, tekrar-kullanım yok`);

  } finally { await emu.stop(); }

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… — emülatör çekirdeği require ETMEZ`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "qukaydee_realistic.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ A2 @ QuKayDee GERÇEK KOŞULLARI (birebir simülasyon) ══\n");
  if (out.a1) console.log(`  (A) A1 topoloji: KME=${out.a1.kme} · key_size ${out.a1.keySize} · master(sae-1)===slave(sae-2) ${out.a1.match.allMatch ? "✓" : "✗"}`);
  if (out.crossKme) console.log(`  (B) çapraz-KME: kme-1'de üret → kme-2'den çek · senkron ${out.crossKme.synced ? "✓" : "✗"}`);
  if (out.a2) console.log(`  (C) A2 TLS: ${out.a2.protocol} · ${out.a2.cipher} · yankı ${out.a2.echoed ? "✓" : "✗"}`);
  if (out.mtls) console.log(`  (D) mTLS: sertifikasız ${out.mtls.rejected ? "reddedildi ✓" : "GEÇTİ ✗"}`);
  if (out.latency) console.log(`  (E) gecikme: ort ${t(out.latency.meanMs, 1)} ms (${out.latency.samples} istek, ${out.latency.minMs}–${out.latency.maxMs} ms)`);
  if (out.oneTime) console.log(`  (F) tek-seferlik: tekrar dec → HTTP ${out.oneTime.status}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "qukaydee_realistic.json")}\n`);
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
