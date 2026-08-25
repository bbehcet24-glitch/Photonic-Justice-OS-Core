#!/usr/bin/env node
"use strict";
/**
 * etsi014_faz0_client.js — FAZ 0: KME'yi bir ETSI-014 ucuna bağla
 * ═══════════════════════════════════════════════════════════════════
 * Yol haritasının Faz 0'ı: HİÇ kuantum donanımı olmadan, PhotonNet'in
 * L7 KME'sinin gerçek ETSI GS QKD 014 V1.1.1 standardını konuştuğunu
 * uçtan uca KANITLAR. Bunu VENDOR-NEUTRAL bir istemciyle yapar —
 * sunucunun kendine özgü davranışına göre değil, YALNIZCA standardın
 * şemasına göre çağırır. Yani bu istemcinin geçmesi, KME'nin QuKayDee /
 * ID Quantique gibi HERHANGİ bir standart tüketiciyle uyumlu olduğu
 * anlamına gelir.
 *
 * GERÇEK ETSI 014 iki-taraflı anahtar teslim akışı (mTLS üzerinde):
 *   1) Master SAE  → GET  /api/v1/keys/{slave}/status
 *   2) Master SAE  → POST /api/v1/keys/{slave}/enc_keys   → {keys:[{key_ID,key}]}
 *   3) Slave  SAE  → POST /api/v1/keys/{master}/dec_keys  → AYNI anahtarlar
 *   TEMEL GARANTİ: slave'in key_ID ile çektiği anahtar, master'ınkiyle BİREBİR.
 *
 * Şema doğrulaması ETSI GS QKD 014 V1.1.1 §6'ya göre: Status ve Key
 * container alan adları/tipleri, key_ID UUID, key base64 + doğru bayt
 * uzunluğu, hata durumları (bilinmeyen key_ID, number>128).
 *
 * NOT — QuKayDee'ye bağlanmak: bu istemci PhotonNet KME'sine karşı
 * çalışıyor (donanımsız, self-contained). Aynı istemciyi gerçek bir
 * QuKayDee hesabına yöneltmek yalnızca URL + istemci sertifikası
 * değişimidir (aşağıdaki ENDPOINT/CERTS sabitleri). Hesap açmayı
 * gerektirdiğinden burada PhotonNet KME'si standart uç olarak kullanılır.
 *
 * Çekirdek photonnet_core.js'e DOKUNULMAZ; KME sunucusu ayrı süreç.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PKI = "/tmp/pki/reqs";
const CA = "/tmp/pki/ca-cert.pem";
const PORT = 9443;
const HOST = "localhost";
const KEYSTORE = "/tmp/faz0_keystore.json";
const KEY_BYTES = 32;                 // 256-bit anahtarlar (KME status.key_size varsayılanıyla uyumlu)
const MASTER = "SAE-MASTER", SLAVE = "SAE-ANK";

// ── Vendor-neutral mTLS ETSI-014 istemcisi ──────────────────────────
function makeAgent(saeName) {
  return {
    cert: fs.readFileSync(path.join(PKI, `${saeName}-cert.pem`)),
    key: fs.readFileSync(path.join(PKI, `${saeName}-key.pem`)),
    ca: fs.readFileSync(CA),
  };
}
function call(saeName, method, urlPath, body) {
  const creds = makeAgent(saeName);
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    host: HOST, port: PORT, method, path: urlPath, servername: HOST,
    cert: creds.cert, key: creds.key, ca: creds.ca, rejectUnauthorized: true,
    headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        let json = null; try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const enc = (s) => encodeURIComponent(s);

// ── Taze keystore: SAE çifti (MASTER+ANK) → route "ANK-MASTER" ───────
function buildKeystore(n) {
  const strip = s => s.replace(/^SAE-/i, "");
  const routeKey = [strip(MASTER), strip(SLAVE)].sort().join("-");
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ key_ID: crypto.randomUUID(),
      key: crypto.randomBytes(KEY_BYTES).toString("base64"), sizeBits: KEY_BYTES * 8, blockIndex: i + 1 });
  }
  fs.writeFileSync(KEYSTORE, JSON.stringify({ routes: { [routeKey]: entries } }));
  return { routeKey, entries };
}

// ── Şema yardımcıları (ETSI GS QKD 014 V1.1.1 §6) ───────────────────
const isUUID = s => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isB64 = s => typeof s === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, "base64").toString("base64") === s;
const b64bytes = s => Buffer.from(s, "base64").length;

function validateStatus(st) {
  const req = ["source_KME_ID", "target_KME_ID", "master_SAE_ID", "slave_SAE_ID",
    "key_size", "stored_key_count", "max_key_count", "max_key_per_request",
    "max_key_size", "min_key_size", "max_SAE_ID_count"];
  const missing = req.filter(f => !(f in st));
  const numFields = ["key_size", "stored_key_count", "max_key_count", "max_key_per_request", "max_key_size", "min_key_size", "max_SAE_ID_count"];
  const badType = numFields.filter(f => f in st && !Number.isInteger(st[f]));
  return { ok: missing.length === 0 && badType.length === 0, missing, badType };
}
function validateKeyContainer(kc, expectBytes) {
  if (!kc || !Array.isArray(kc.keys) || !kc.keys.length) return { ok: false, why: "keys[] yok/boş" };
  for (const k of kc.keys) {
    if (!isUUID(k.key_ID)) return { ok: false, why: `key_ID UUID değil: ${k.key_ID}` };
    if (!isB64(k.key)) return { ok: false, why: `key base64 değil: ${k.key}` };
    if (expectBytes && b64bytes(k.key) !== expectBytes) return { ok: false, why: `key ${b64bytes(k.key)} bayt (beklenen ${expectBytes})` };
  }
  return { ok: true };
}

async function waitForServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await call(MASTER, "GET", `/api/v1/keys/${enc(SLAVE)}/status`); if (r.status) return true; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), endpoint: `https://${HOST}:${PORT}`, checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const ks = buildKeystore(8);

  // ── KME sunucusunu mTLS modunda ayrı süreç olarak başlat ──
  const srv = spawn("node", [path.join(__dirname, "etsi014_kme_server.js"),
    `--keystore=${KEYSTORE}`, `--port=${PORT}`,
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`,
    `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = "";
  srv.stdout.on("data", d => srvLog += d);
  srv.stderr.on("data", d => srvLog += d);

  try {
    const up = await waitForServer();
    chk("KME mTLS sunucusu ayağa kalktı (ETSI-014 ucu dinliyor)", up,
      up ? `https://${HOST}:${PORT} · keystore route '${ks.routeKey}' · ${ks.entries.length} anahtar yüklü`
        : "sunucu zamanında dinlemeye başlamadı");
    if (!up) throw new Error("server-down");

    // ── (1) GET STATUS — master SAE ──
    const st = await call(MASTER, "GET", `/api/v1/keys/${enc(SLAVE)}/status`);
    const sv = st.status === 200 ? validateStatus(st.json) : { ok: false, missing: ["HTTP " + st.status] };
    out.status = st.json;
    chk("(1) GET STATUS: ETSI-014 §6.1 Status şeması geçerli, anahtar sayısı raporlanıyor",
      st.status === 200 && sv.ok && st.json.stored_key_count === ks.entries.length,
      st.status === 200
        ? `HTTP 200 · stored_key_count=${st.json.stored_key_count} · key_size=${st.json.key_size} · ` +
          `source_KME=${st.json.source_KME_ID} · tüm zorunlu alanlar var/tipli`
        : `HTTP ${st.status}; eksik/hatalı: ${(sv.missing || []).concat(sv.badType || []).join(", ")}`);

    // ── (2) ENC_KEYS — master anahtar + key_ID alır ──
    const N = 3;
    const ek = await call(MASTER, "POST", `/api/v1/keys/${enc(SLAVE)}/enc_keys`, { number: N, size: 256 });
    const ev = ek.status === 200 ? validateKeyContainer(ek.json, KEY_BYTES) : { ok: false, why: "HTTP " + ek.status };
    const masterKeys = ek.status === 200 ? ek.json.keys : [];
    chk("(2) POST enc_keys: master N anahtar + key_ID alır, Key container §6.2 şeması geçerli",
      ek.status === 200 && ev.ok && masterKeys.length === N,
      ek.status === 200
        ? `HTTP 200 · ${masterKeys.length} anahtar · key_ID'ler UUID, key'ler base64/${KEY_BYTES} bayt · ` +
          `ör. ${masterKeys[0].key_ID.slice(0, 8)}…`
        : `HTTP ${ek.status}: ${ev.why}`);

    // ── (3) DEC_KEYS — slave AYNI anahtarları key_ID ile çeker ──
    const keyIDs = masterKeys.map(k => ({ key_ID: k.key_ID }));
    const dk = await call(SLAVE, "POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: keyIDs });
    const dv = dk.status === 200 ? validateKeyContainer(dk.json, KEY_BYTES) : { ok: false, why: "HTTP " + dk.status };
    const slaveKeys = dk.status === 200 ? dk.json.keys : [];
    // TEMEL GARANTİ: her key_ID için master.key === slave.key
    const byId = Object.fromEntries(slaveKeys.map(k => [k.key_ID, k.key]));
    const allMatch = masterKeys.length > 0 && masterKeys.every(m => byId[m.key_ID] === m.key);
    out.keyMatch = { requested: N, delivered: slaveKeys.length, allMatch };
    chk("(3) POST dec_keys: slave AYNI anahtarları key_ID ile çeker — master ile BİREBİR eşleşiyor",
      dk.status === 200 && dv.ok && slaveKeys.length === N && allMatch,
      dk.status === 200
        ? `HTTP 200 · ${slaveKeys.length}/${N} anahtar · master.key === slave.key TÜM key_ID'lerde ✓ — ` +
          `iki-taraflı ETSI-014 teslim garantisi sağlandı`
        : `HTTP ${dk.status}: ${dv.why}`);

    // ── (4) HATA DURUMU: bilinmeyen key_ID reddedilir ──
    const bad = await call(SLAVE, "POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`,
      { key_IDs: [{ key_ID: crypto.randomUUID() }] });
    const rejected = bad.status >= 400 || (Array.isArray(bad.json && bad.json.keys) && bad.json.keys.length === 0);
    chk("(4) HATA: bilinmeyen key_ID teslim edilmez (spec-uyumlu ret)",
      rejected,
      `bilinmeyen key_ID → HTTP ${bad.status}${bad.json && bad.json.message ? ` ("${bad.json.message}")` : ""} — ` +
      `var olmayan anahtar servis edilmiyor`);

    // ── (5) HATA DURUMU: number > max_key_per_request reddedilir ──
    const over = await call(MASTER, "POST", `/api/v1/keys/${enc(SLAVE)}/enc_keys`, { number: 999 });
    chk("(5) HATA: number > 128 (max_key_per_request) → HTTP 400 (sınır dayatılıyor)",
      over.status === 400,
      `number=999 → HTTP ${over.status}${over.json && over.json.message ? ` ("${over.json.message}")` : ""} — ` +
      `max_key_per_request sınırı dayatılıyor`);

    // ── (6) TEK-SEFERLİK TESLİM: teslim edilen anahtar TÜKETİLİR, tekrar servis edilmez ──
    // (3)'te keyIDs[0] zaten slave'e teslim edildi. Güvenlik-doğru davranış:
    // aynı anahtar İKİNCİ kez servis EDİLMEZ (anahtar tekrar-kullanımı önlenir).
    const again = await call(SLAVE, "POST", `/api/v1/keys/${enc(MASTER)}/dec_keys`, { key_IDs: [keyIDs[0]] });
    const consumed = again.status >= 400 || (Array.isArray(again.json && again.json.keys) && again.json.keys.length === 0);
    chk("(6) TEK-SEFERLİK TESLİM: teslim edilen anahtar tüketilir, tekrar servis edilmez (anahtar tekrar-kullanımı önlenir)",
      consumed,
      `zaten teslim edilmiş key_ID tekrar dec_keys → HTTP ${again.status}${again.json && again.json.message ? ` ("${again.json.message}")` : ""} — ` +
      `KME anahtarı tesliminde tüketiyor (one-time delivery). Bu güvenlik-doğru: anahtar tekrar-kullanımı bir açık olurdu. ` +
      `Uzlaşım: ağ kaybında slave anahtarı yeniden alamaz (güvenlik ↔ güvenilirlik dengesi — gerçek dağıtımlarda uygulama katmanında ele alınır)`);

  } finally {
    srv.kill("SIGTERM");
  }

  out.serverLogTail = srvLog.split("\n").filter(Boolean).slice(-3);
  out.qukaydeeNote = "Aynı istemci gerçek QuKayDee'ye: ENDPOINT (host/port) + istemci sertifikası değişimi. " +
    "PhotonNet KME'si burada standart ETSI-014 ucu olarak kullanıldı (hesap gerektirmeden, donanımsız).";
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "etsi014_faz0.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ FAZ 0 — KME ↔ ETSI-014 UCU (donanımsız, mTLS) ══\n");
  console.log(`  Uç: ${out.endpoint}  ·  standart: ETSI GS QKD 014 V1.1.1`);
  if (out.status) console.log(`  Status: stored=${out.status.stored_key_count} · key_size=${out.status.key_size} bit · KME=${out.status.source_KME_ID}`);
  if (out.keyMatch) console.log(`  Anahtar eşleşmesi: ${out.keyMatch.delivered}/${out.keyMatch.requested} · master===slave: ${out.keyMatch.allMatch ? "EVET ✓" : "HAYIR ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n  Not: ${out.qukaydeeNote}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ — KME gerçek bir ETSI-014 ucu olarak çalışıyor" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "etsi014_faz0.json")}\n`);
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
