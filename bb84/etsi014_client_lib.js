#!/usr/bin/env node
"use strict";
/**
 * etsi014_client_lib.js — vendor-neutral ETSI GS QKD 014 istemci kütüphanesi
 * ═══════════════════════════════════════════════════════════════════
 * Faz 0'ın istemcisini GENELLEŞTİRİR: kendi KME'sini başlatmak yerine,
 * config'le verilen HERHANGİ bir ETSI-014 ucuna (yerel KME'miz VEYA gerçek
 * QuKayDee bulutu) bağlanır. Kritik fark — gerçek dağıtımda master ve slave
 * SAE'ler AYRI KME'lere bağlanır (QuKayDee: kme-1 ↔ sae-1, kme-2 ↔ sae-2);
 * bu yüzden master ve slave uçları ayrı config'lenir.
 *
 * Standart: ETSI GS QKD 014 V1.1.1, §6. mTLS: her SAE kendi sertifikasını
 * sunar, sunucu CA'sına güvenir. Çekirdeğe/çözüme özgü hiçbir varsayım yok —
 * yalnız standardın şeması.
 */
const https = require("https");
const fs = require("fs");

// ── mTLS HTTPS çağrısı (mutlak URL + istemci sertifikası) ───────────
function httpsCall({ baseUrl, method, apiPath, body, cert, key, ca }) {
  const u = new URL(baseUrl);
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    host: u.hostname, port: u.port || 443, method, path: apiPath, servername: u.hostname,
    cert, key, ca, rejectUnauthorized: true,
    headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let buf = ""; res.on("data", c => buf += c);
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json, raw: buf }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── ETSI 014 V1.1.1 §6 şema doğrulayıcıları ─────────────────────────
const isUUID = s => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isB64 = s => typeof s === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, "base64").toString("base64") === s;
const b64bytes = s => Buffer.from(s, "base64").length;

function validateStatus(st) {
  const req = ["source_KME_ID", "target_KME_ID", "master_SAE_ID", "slave_SAE_ID",
    "key_size", "stored_key_count", "max_key_count", "max_key_per_request", "max_key_size", "min_key_size", "max_SAE_ID_count"];
  const missing = req.filter(f => !(f in st));
  const numFields = ["key_size", "stored_key_count", "max_key_count", "max_key_per_request", "max_key_size", "min_key_size", "max_SAE_ID_count"];
  const badType = numFields.filter(f => f in st && !Number.isInteger(st[f]));
  return { ok: missing.length === 0 && badType.length === 0, missing, badType };
}
function validateKeyContainer(kc, expectBytes) {
  if (!kc || !Array.isArray(kc.keys) || !kc.keys.length) return { ok: false, why: "keys[] yok/boş" };
  for (const k of kc.keys) {
    if (!isUUID(k.key_ID)) return { ok: false, why: `key_ID UUID değil: ${k.key_ID}` };
    if (!isB64(k.key)) return { ok: false, why: `key base64 değil` };
    if (expectBytes && b64bytes(k.key) !== expectBytes) return { ok: false, why: `key ${b64bytes(k.key)} bayt (beklenen ${expectBytes})` };
  }
  return { ok: true };
}
const enc = s => encodeURIComponent(s);

/**
 * Uçtan uca ETSI-014 iki-taraflı anahtar teslim akışını koştur.
 * @param cfg.master  {baseUrl, saeId, cert, key}  — enc_keys/status buraya
 * @param cfg.slave   {baseUrl, saeId, cert, key}  — dec_keys buraya
 * @param cfg.serverCa Buffer — güvenilen sunucu CA'sı (her iki KME)
 * @param cfg.number   istenecek anahtar sayısı
 * @param cfg.size     anahtar boyu (bit) — verilmezse istekten çıkarılır (KME varsayılanı)
 * @param cfg.decPathSaeId  dec_keys yolundaki SAE (ETSI: master SAE ID; varsayılan bu)
 * @returns {checks[], allPassed, status, keyMatch}
 */
async function runFlow(cfg) {
  const checks = [];
  const chk = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
  const ca = cfg.serverCa;
  const N = cfg.number || 3;
  const decSae = cfg.decPathSaeId || cfg.master.saeId;   // ETSI: dec yolunda master SAE ID
  const out = {};

  // ── (1) GET STATUS (master → kendi KME'si, slave SAE yolda) ──
  const st = await httpsCall({ baseUrl: cfg.master.baseUrl, method: "GET",
    apiPath: `/api/v1/keys/${enc(cfg.slave.saeId)}/status`, cert: cfg.master.cert, key: cfg.master.key, ca });
  const sv = st.status === 200 ? validateStatus(st.json) : { ok: false, missing: ["HTTP " + st.status] };
  out.status = st.json;
  const keyBytes = st.json && Number.isInteger(st.json.key_size) ? st.json.key_size / 8 : null;
  chk("(1) GET status — §6.1 Status şeması geçerli",
    st.status === 200 && sv.ok,
    st.status === 200 ? `HTTP 200 · stored_key_count=${st.json.stored_key_count} · key_size=${st.json.key_size} · KME=${st.json.source_KME_ID}`
      : `HTTP ${st.status}; eksik/hatalı: ${(sv.missing || []).concat(sv.badType || []).join(", ")}`);

  // ── (2) POST enc_keys (master → kendi KME'si) ──
  const encBody = cfg.size ? { number: N, size: cfg.size } : { number: N };
  const ek = await httpsCall({ baseUrl: cfg.master.baseUrl, method: "POST",
    apiPath: `/api/v1/keys/${enc(cfg.slave.saeId)}/enc_keys`, body: encBody, cert: cfg.master.cert, key: cfg.master.key, ca });
  const ev = ek.status === 200 ? validateKeyContainer(ek.json, keyBytes) : { ok: false, why: "HTTP " + ek.status + (ek.json && ek.json.message ? ` (${ek.json.message})` : "") };
  const masterKeys = ek.status === 200 ? ek.json.keys : [];
  chk("(2) POST enc_keys — master N anahtar+key_ID alır, §6.2 Key container geçerli",
    ek.status === 200 && ev.ok && masterKeys.length === N,
    ek.status === 200 ? `HTTP 200 · ${masterKeys.length} anahtar · key_ID UUID, key base64${keyBytes ? "/" + keyBytes + " bayt" : ""}`
      : `HTTP ${ek.status}: ${ev.why}`);

  // ── (3) POST dec_keys (slave → kendi KME'si, master SAE yolda) ──
  const keyIDs = masterKeys.map(k => ({ key_ID: k.key_ID }));
  const dk = keyIDs.length ? await httpsCall({ baseUrl: cfg.slave.baseUrl, method: "POST",
    apiPath: `/api/v1/keys/${enc(decSae)}/dec_keys`, body: { key_IDs: keyIDs }, cert: cfg.slave.cert, key: cfg.slave.key, ca })
    : { status: 0, json: null };
  const dv = dk.status === 200 ? validateKeyContainer(dk.json, keyBytes) : { ok: false, why: "HTTP " + dk.status + (dk.json && dk.json.message ? ` (${dk.json.message})` : "") };
  const slaveKeys = dk.status === 200 ? dk.json.keys : [];
  const byId = Object.fromEntries(slaveKeys.map(k => [k.key_ID, k.key]));
  const allMatch = masterKeys.length > 0 && masterKeys.every(m => byId[m.key_ID] === m.key);
  out.keyMatch = { requested: N, delivered: slaveKeys.length, allMatch };
  chk("(3) POST dec_keys — slave AYNI anahtarları key_ID ile çeker, master ile BİREBİR",
    dk.status === 200 && dv.ok && slaveKeys.length === N && allMatch,
    dk.status === 200 ? `HTTP 200 · ${slaveKeys.length}/${N} · master.key === slave.key TÜM key_ID'lerde ${allMatch ? "✓" : "✗"}`
      : `HTTP ${dk.status}: ${dv.why}`);

  out.checks = checks;
  out.allPassed = checks.every(c => c.ok);
  return out;
}

/** Config'ten sertifika dosyalarını okuyup Buffer'a çeker. */
function loadCerts(cfg) {
  const rd = p => fs.readFileSync(p);
  return {
    ...cfg,
    serverCa: rd(cfg.serverCaPath),
    master: { ...cfg.master, cert: rd(cfg.master.certPath), key: rd(cfg.master.keyPath) },
    slave: { ...cfg.slave, cert: rd(cfg.slave.certPath), key: rd(cfg.slave.keyPath) },
  };
}

module.exports = { httpsCall, runFlow, loadCerts, validateStatus, validateKeyContainer, isUUID, isB64, b64bytes };
