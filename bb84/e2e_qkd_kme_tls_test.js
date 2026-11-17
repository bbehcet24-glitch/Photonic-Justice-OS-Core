#!/usr/bin/env node
"use strict";
/**
 * e2e_qkd_kme_tls_test.js — uçtan uca: foton → QKD → KME (ETSI-014, mTLS) → TLS (ECDHE-PSK) → mesaj
 * ═══════════════════════════════════════════════════════════════════
 * Hakem bulguları P1-3 ve P1-4. Önceki testlerde KME'nin anahtarları rastgele üretiliyordu (qkd_secure_channel_test,
 * mock_ibm_client); burada anahtar ÇEKİRDEĞİN QKD hattından gelir ve hiçbir aşama taklit (mock) değildir:
 *   1) QuantumKeyDistribution.deriveSiftedKey (25 km fiber, SNSPD, gece) → KeyPoolBuffer: PE + Cascade + sonlu-anahtar ℓ
 *      + Toeplitz → KeyDeliveryStore'a kayıt
 *   2) KeyDeliveryStore.exportForKME() → bb84/etsi014_kme_server.js AYRI bir süreç olarak, test PKI'siyle mTLS
 *   3) master SAE enc_keys, slave SAE dec_keys (etsi014_client_lib, gerçek HTTPS + istemci sertifikası)
 *   4) qkd_secure_channel.js: anahtar PSK olarak gerçek TLS 1.2 ECDHE-PSK oturumu, mesaj gidip yankılanıyor
 *
 *   E1 Çekirdek QKD hattı bir blok üretti: n, k, QBER_test, Cascade yakınsadı, ℓ > 0, KeyDeliveryStore'a kaydedildi
 *   E2 KME'nin master ve slave SAE'ye verdiği anahtar AYNI ve QKD bloğunun anahtarıyla bit bit AYNI
 *   E3 Tek kullanım: aynı key_ID ikinci kez dec_keys ile çekilemez (replay reddi); depo sayacı anahtarın silindiğini gösteriyor
 *   E4 TLS: QKD anahtarı PSK, şifre takımı ECDHE-PSK (ECDHE paylaşılan sırrı VE PSK birlikte; RFC 5489 premaster),
 *      mesaj şifreli gidip yankılanıyor; yanlış PSK ile el sıkışma kurulamıyor
 *   E5 Mesaj UTF-8 baytları bozulmadan yankılandı; pasif dinleyicinin kaydettiği TLS baytlarında açık metin yok
 * Ön koşul: /tmp/pki test PKI'si (npm test üretir). Port 9461.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "uçtan uca test SNSPD ile");
const core = require("./photonnet_core.js");
const LIB = require("./etsi014_client_lib.js");
const SC = require("./qkd_secure_channel.js");

const PKI = "/tmp/pki/reqs", CA = "/tmp/pki/ca-cert.pem", PORT = 9461;
const KEYSTORE = path.join(require("os").tmpdir(), `e2e_qkd_keystore_${process.pid}.json`);
const MASTER = "SAE-MASTER", SLAVE = "SAE-ANK", ROUTE = "ANK-MASTER";
const MESSAGE = "Merhaba Dünya — foton → QKD → KME → TLS";
const enc = (s) => encodeURIComponent(s);
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const certs = () => ({ ca: fs.readFileSync(CA),
  master: { cert: fs.readFileSync(path.join(PKI, "SAE-MASTER-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-MASTER-key.pem")) },
  slave: { cert: fs.readFileSync(path.join(PKI, "SAE-ANK-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-ANK-key.pem")) } });
const base = `https://localhost:${PORT}`;
const call = (cr, who, method, apiPath, body) => LIB.httpsCall({ baseUrl: base, method, apiPath, body, cert: cr[who].cert, key: cr[who].key, ca: cr.ca });

async function waitUp(cr) {
  for (let t = 0; t < 50; t++) {
    try { const r = await call(cr, "master", "GET", `/api/v1/keys/${enc(SLAVE)}/status`); if (r.status === 200) return true; }
    catch (_) { /* henüz yok */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  // ── 1) QKD → havuz → KeyDeliveryStore ──
  const kpb = new core.KeyPoolBuffer();
  const qkd = new core.QuantumKeyDistribution(crypto.randomBytes(4).readUInt32BE(0));
  const chan = core.mulberry32(crypto.randomBytes(4).readUInt32BE(0));
  const ctx = { isNight: true, freeSpace: false, detectorProfile: "snspd" };
  let fin = null, pulses = 0;
  for (let i = 0; i < 400 && !fin; i++) {
    const r = qkd.deriveSiftedKey(rb(16384), 25, false, chan, ctx);
    pulses += 16384;
    const res = kpb.feed("MASTER", "ANK", r.siftedKeyBits, r.bobKeyBits, 4242, 16384);
    if (res && res.finalized) fin = res.finalized;
  }
  const stored = (core.keyDeliveryStore.byRoute[ROUTE] || []).slice(-1)[0];
  chk("E1 Çekirdek QKD hattı bir blok üretti ve KME deposuna kaydetti (PE + Cascade + sonlu-anahtar + Toeplitz)",
    fin && fin.proof.secure && fin.reconciliation && fin.reconciliation.converged && stored && stored.sizeBits === fin.finalKeyBitsLen,
    fin ? `${pulses.toLocaleString("tr-TR")} darbe, n ${fin.n}, k ${fin.k}, QBER_test %${(fin.qEstimated * 100).toFixed(2)}, Cascade sızıntısı ${fin.reconciliation.leakedBits} bit, ℓ ${fin.proof.ell} bit → key_ID ${stored ? stored.key_ID.slice(0, 8) : "—"}…` : "blok oluşmadı");
  if (!fin || !stored) return finish();
  fs.writeFileSync(KEYSTORE, core.keyDeliveryStore.exportForKME(), { mode: 0o600 });

  // ── 2) KME süreci (mTLS) ──
  const cr = certs();
  const srv = spawn(process.execPath, [path.join(__dirname, "etsi014_kme_server.js"), `--keystore=${KEYSTORE}`, `--port=${PORT}`,
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});
  try {
    if (!await waitUp(cr)) { chk("KME ayağa kalktı", false, "status uç noktası yanıt vermedi"); return finish(); }
    // ── 3) ETSI-014 teslim ──
    const ek = await call(cr, "master", "POST", `/api/v1/keys/${enc(SLAVE)}/enc_keys`, { number: 1 });
    const mk = ek.json && ek.json.keys && ek.json.keys[0];
    const dk = mk ? await call(cr, "slave", "POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: [{ key_ID: mk.key_ID }] }) : null;
    const sk = dk && dk.json && dk.json.keys && dk.json.keys[0];
    chk("E2 KME teslimi: master ve slave aynı anahtarı aldı ve anahtar QKD bloğunun anahtarıyla bit bit aynı",
      mk && sk && mk.key === sk.key && mk.key === stored.key && mk.key_ID === stored.key_ID,
      mk ? `key_ID ${mk.key_ID.slice(0, 8)}…, ${Buffer.from(mk.key, "base64").length} bayt (${stored.sizeBits} bit); master = slave ${mk && sk && mk.key === sk.key}, = QKD bloğu ${mk.key === stored.key}` : `enc_keys durum ${ek.status}`);
    const again = mk ? await call(cr, "slave", "POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: [{ key_ID: mk.key_ID }] }) : null;
    const st = await call(cr, "master", "GET", `/api/v1/keys/${enc(SLAVE)}/status`);
    chk("E3 Tek kullanım: aynı key_ID ikinci kez çekilemiyor (replay reddi), anahtar depodan silindi",
      again && again.status === 400 && st.json && st.json.stored_key_count === 0,
      `ikinci dec_keys → HTTP ${again ? again.status : "—"} (${again && again.json ? String(again.json.message || "").slice(0, 70) : ""}); depoda kalan ${st.json ? st.json.stored_key_count : "—"}`);
    // ── 4) TLS ECDHE-PSK + mesaj ──
    const psk = Buffer.from(mk.key, "base64");
    const sess = await SC.establishTls({ serverPsk: psk, clientPsk: Buffer.from(sk.key, "base64"), payload: MESSAGE, tap: true });
    const wrong = await SC.establishTls({ serverPsk: psk, clientPsk: crypto.randomBytes(psk.length), payload: "x", timeoutMs: 4000 });
    chk("E4 TLS: QKD anahtarı PSK, ECDHE-PSK şifre takımı (ECDHE sırrı VE PSK birlikte), mesaj yankılandı; yanlış PSK reddedildi",
      sess.ok && sess.echoed && /^ECDHE-PSK/.test(sess.cipher || "") && !wrong.ok,
      `${sess.protocol} · ${sess.cipher} · yankı ${sess.echoed}; yanlış PSK: ${wrong.ok ? "KABUL EDİLDİ" : "el sıkışma kurulamadı"}`);
    const wire = sess.recorded || Buffer.alloc(0), plain = Buffer.from(MESSAGE, "utf8");
    chk("E5 Mesaj UTF-8 baytları bozulmadan yankılandı ve hatta (kaydedilen TLS baytlarında) açık metin geçmiyor",
      sess.echoed === true && wire.length > 0 && wire.indexOf(plain) < 0 && wire.indexOf(Buffer.from("Merhaba")) < 0,
      `"${MESSAGE}" (${plain.length} bayt UTF-8); hatta kaydedilen ${wire.length} bayt, açık metin ${wire.indexOf(plain) < 0 ? "yok" : "VAR"}`);
  } finally {
    srv.kill("SIGTERM");
    try { fs.unlinkSync(KEYSTORE); } catch (_) { /* yok */ }
  }
  return finish();
}

function finish() {
  out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
  fs.writeFileSync(path.join(__dirname, "reports", "e2e_qkd_kme_tls.json"), JSON.stringify(out, null, 2));
  for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.total > 0 && out.passed === out.total ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
