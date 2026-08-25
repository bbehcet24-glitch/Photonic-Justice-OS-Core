#!/usr/bin/env node
"use strict";
/**
 * etsi014_reference_kme.js — BAĞIMSIZ (temiz-oda) ETSI-014 REFERANS KME
 * ═══════════════════════════════════════════════════════════════════
 * A5 interop için: PhotonNet'in KME'sinden TAMAMEN AYRI, minimal, ETSI GS
 * QKD 014 V1.1.1 uyumlu bir "başka satıcı" KME'si. Amaç — istemcimizin
 * VENDOR-NEUTRAL olduğunu (kendi sunucumuzun iç davranışına bağlı olmadığını)
 * kanıtlamak. Kasıtlı olarak FARKLI iç seçimler yapar:
 *   • key_size 128 (bizimki 256) — istemci status'tan okuyup uyum sağlamalı.
 *   • rota anahtarı [a,b].sort().join("|") (farklı ayraç, "SAE-" soymaz).
 *   • anahtarlar enc_keys'te ANLIK üretilir (harici keystore yok).
 * Wire biçimi (JSON alanları, yollar, hata kodları) STANDARDA uyar.
 *
 * mTLS: aynı CA'ya güvenir (gerçek dağıtımda iki KME de aynı CA ile
 * provisyonlanır); SAE kimliği istemci sertifikası CN'inden okunur.
 * Çekirdek photonnet_core.js'e HİÇ dokunmaz, onu HİÇ require etmez.
 */
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

const KEY_SIZE_BITS = 128;                     // BİLEREK bizimkinden (256) farklı
const MAX_PER_REQ = 64;

function parseArgs(argv) { const o = {}; for (const a of argv) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) o[m[1]] = m[2] ?? true; } return o; }
const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || "9600", 10);

// ── depo: rota → sırada bekleyen + verilmiş anahtarlar ──────────────
const pools = new Map();                       // routeKey → { queue:[{key_ID,key}], issued:Map }
const routeKey = (a, b) => [a, b].sort().join("|");
function pool(rk) { if (!pools.has(rk)) pools.set(rk, { queue: [], issued: new Map() }); return pools.get(rk); }
function mint(rk, n) {
  const p = pool(rk); const out = [];
  for (let i = 0; i < n; i++) { const e = { key_ID: crypto.randomUUID(), key: crypto.randomBytes(KEY_SIZE_BITS / 8).toString("base64") }; p.issued.set(e.key_ID, e); out.push(e); }
  return out;
}

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
const readBody = (req) => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s)); });
function saeFromCert(req) { const c = req.socket.getPeerCertificate && req.socket.getPeerCertificate(); return c && c.subject ? c.subject.CN : null; }

const RE = { status: /^\/api\/v1\/keys\/([^/]+)\/status$/, enc: /^\/api\/v1\/keys\/([^/]+)\/enc_keys$/, dec: /^\/api\/v1\/keys\/([^/]+)\/dec_keys$/ };

const handler = async (req, res) => {
  try {
    const caller = saeFromCert(req);
    if (!caller) return send(res, 401, { message: "istemci sertifikası yok" });
    const p = req.url.split("?")[0]; let m;
    if ((m = p.match(RE.status)) && req.method === "GET") {
      const slave = decodeURIComponent(m[1]); const rk = routeKey(caller, slave);
      return send(res, 200, {
        source_KME_ID: "RefKME-1", target_KME_ID: "RefKME-1", master_SAE_ID: caller, slave_SAE_ID: slave,
        key_size: KEY_SIZE_BITS, stored_key_count: pool(rk).queue.length + pool(rk).issued.size,
        max_key_count: 100000, max_key_per_request: MAX_PER_REQ, max_key_size: 1024, min_key_size: 64, max_SAE_ID_count: 0,
        status_extension: { vendor: "reference-clean-room" },
      });
    }
    if ((m = p.match(RE.enc)) && (req.method === "POST" || req.method === "GET")) {
      const slave = decodeURIComponent(m[1]); const rk = routeKey(caller, slave);
      let number = 1, size = KEY_SIZE_BITS;
      if (req.method === "POST") { const raw = await readBody(req); if (raw) { let b; try { b = JSON.parse(raw); } catch { return send(res, 400, { message: "gövde JSON değil" }); } number = b.number ?? 1; if (b.size != null) size = b.size; } }
      else { const u = new URL(req.url, "http://x"); if (u.searchParams.has("number")) number = parseInt(u.searchParams.get("number"), 10); if (u.searchParams.has("size")) size = parseInt(u.searchParams.get("size"), 10); }
      if (!Number.isInteger(number) || number < 1 || number > MAX_PER_REQ) return send(res, 400, { message: `number 1..${MAX_PER_REQ} olmalı` });
      if (size !== KEY_SIZE_BITS) return send(res, 400, { message: `bu KME yalnız ${KEY_SIZE_BITS}-bit anahtar üretir` });
      return send(res, 200, { keys: mint(rk, number).map(e => ({ key_ID: e.key_ID, key: e.key })) });
    }
    if ((m = p.match(RE.dec)) && (req.method === "POST" || req.method === "GET")) {
      const master = decodeURIComponent(m[1]); const rk = routeKey(caller, master);
      let ids = [];
      if (req.method === "POST") { const raw = await readBody(req); let b = {}; if (raw) { try { b = JSON.parse(raw); } catch { return send(res, 400, { message: "gövde JSON değil" }); } } if (!Array.isArray(b.key_IDs) || !b.key_IDs.length) return send(res, 400, { message: "key_IDs dizisi gerekli" }); ids = b.key_IDs.map(k => typeof k === "string" ? k : k.key_ID); }
      else { const u = new URL(req.url, "http://x"); const s = u.searchParams.get("key_ID"); if (!s) return send(res, 400, { message: "key_ID gerekli" }); ids = [s]; }
      const p2 = pool(rk); const out = [];
      for (const id of ids) { const e = p2.issued.get(id); if (!e) return send(res, 400, { message: `key_ID bulunamadı: ${id}` }); out.push({ key_ID: e.key_ID, key: e.key }); p2.issued.delete(id); }
      return send(res, 200, { keys: out });
    }
    return send(res, 404, { message: "bilinmeyen uç", path: p });
  } catch (e) { send(res, 500, { message: "iç hata" }); }
};

const server = https.createServer({
  cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key), ca: [fs.readFileSync(args.ca)],
  requestCert: true, rejectUnauthorized: true,
}, handler);
server.on("tlsClientError", () => {});
server.listen(PORT, () => console.log(`[RefKME] bağımsız referans KME dinliyor :${PORT} (key_size ${KEY_SIZE_BITS}-bit)`));
