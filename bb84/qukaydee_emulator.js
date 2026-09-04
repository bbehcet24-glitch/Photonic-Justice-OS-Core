#!/usr/bin/env node
"use strict";
/**
 * qukaydee_emulator.js — QuKayDee GERÇEK KOŞULLARINI BİREBİR TAKLİT EDEN emülatör
 * ═══════════════════════════════════════════════════════════════════
 * A1 (QuKayDee) koşullarını sadık biçimde yerelde canlandırır ki A2
 * (QKD-TLS) sistemini GERÇEK QuKayDee topolojisi altında test edebilelim
 * (sandbox'tan gerçek QuKayDee'ye erişim yok). Birebir simüle edilen:
 *   • İKİ AYRI KME: kme-1 (sae-1/master), kme-2 (sae-2/slave) — ayrı portlar.
 *   • ÇAPRAZ-KME KEY STREAM: kme-1'de üretilen anahtar, kme-2'den key_ID ile
 *     çekilir (gerçek QuKayDee'nin KME'ler arası senkronizasyonu).
 *   • SAE kimliği mTLS istemci sertifikası CN'inden (sae-1/sae-2).
 *   • GERÇEKÇİ AĞ GECİKMESİ: her isteğe taban + jitter (bulut ucu gibi).
 *   • ETSI GS QKD 014 wire biçimi + hata kodları.
 *
 * Çekirdek photonnet_core.js'e DOKUNMAZ, onu require ETMEZ (bağımsız araç).
 */
const https = require("https");
const crypto = require("crypto");

const routeOf = (a, b) => [a, b].sort().join("~");

/**
 * QuKayDee-sadık emülatörü başlat.
 * @returns {Promise<{urls:{kme1,kme2}, latency:()=>number[], stop:()=>Promise}>}
 */
function startQukaydeeEmulator({ kme1Port = 9701, kme2Port = 9702, latencyMs = 40, jitterMs = 20,
  keySizeBits = 256, maxPerReq = 128, tls } = {}) {
  const streams = new Map();               // routeKey → Map(key_ID → key)  (KME'ler arası PAYLAŞILAN)
  const stream = (rk) => { if (!streams.has(rk)) streams.set(rk, new Map()); return streams.get(rk); };
  const latencies = [];
  const rnd = () => Math.random();
  const delay = () => new Promise(r => { const d = latencyMs + rnd() * jitterMs; latencies.push(+d.toFixed(1)); setTimeout(r, d); });

  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
  const readBody = (req) => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s)); });
  const saeOf = (req) => { const c = req.socket.getPeerCertificate && req.socket.getPeerCertificate(); return c && c.subject ? c.subject.CN : null; };
  const RE = { status: /^\/api\/v1\/keys\/([^/]+)\/status$/, enc: /^\/api\/v1\/keys\/([^/]+)\/enc_keys$/, dec: /^\/api\/v1\/keys\/([^/]+)\/dec_keys$/ };

  function makeHandler(kmeName) {
    return async (req, res) => {
      await delay();                         // gerçekçi ağ gecikmesi
      try {
        const caller = saeOf(req);
        if (!caller) return send(res, 401, { message: "istemci sertifikası yok" });
        const p = req.url.split("?")[0]; let m;
        if ((m = p.match(RE.status)) && req.method === "GET") {
          const other = decodeURIComponent(m[1]); const st = stream(routeOf(caller, other));
          return send(res, 200, { source_KME_ID: kmeName, target_KME_ID: kmeName === "kme-1" ? "kme-2" : "kme-1",
            master_SAE_ID: caller, slave_SAE_ID: other, key_size: keySizeBits, stored_key_count: st.size,
            max_key_count: 100000, max_key_per_request: maxPerReq, max_key_size: 1024, min_key_size: 64, max_SAE_ID_count: 0,
            status_extension: { emulator: "qukaydee-faithful", kme: kmeName } });
        }
        if ((m = p.match(RE.enc)) && (req.method === "POST" || req.method === "GET")) {
          const slave = decodeURIComponent(m[1]); const st = stream(routeOf(caller, slave));
          let number = 1, size = keySizeBits;
          if (req.method === "POST") { const raw = await readBody(req); if (raw) { let b; try { b = JSON.parse(raw); } catch { return send(res, 400, { message: "gövde JSON değil" }); } number = b.number ?? 1; if (b.size != null) size = b.size; } }
          else { const u = new URL(req.url, "http://x"); if (u.searchParams.has("number")) number = parseInt(u.searchParams.get("number"), 10); if (u.searchParams.has("size")) size = parseInt(u.searchParams.get("size"), 10); }
          if (!Number.isInteger(number) || number < 1 || number > maxPerReq) return send(res, 400, { message: `number 1..${maxPerReq}` });
          if (size !== keySizeBits) return send(res, 400, { message: `bu KME ${keySizeBits}-bit üretir` });
          const out = [];
          for (let i = 0; i < number; i++) { const e = { key_ID: crypto.randomUUID(), key: crypto.randomBytes(keySizeBits / 8).toString("base64") }; st.set(e.key_ID, e.key); out.push(e); }
          return send(res, 200, { keys: out });
        }
        if ((m = p.match(RE.dec)) && (req.method === "POST" || req.method === "GET")) {
          const master = decodeURIComponent(m[1]); const st = stream(routeOf(caller, master));   // AYNI paylaşılan stream
          let ids = [];
          if (req.method === "POST") { const raw = await readBody(req); let b = {}; if (raw) { try { b = JSON.parse(raw); } catch { return send(res, 400, { message: "gövde JSON değil" }); } } if (!Array.isArray(b.key_IDs) || !b.key_IDs.length) return send(res, 400, { message: "key_IDs gerekli" }); ids = b.key_IDs.map(k => typeof k === "string" ? k : k.key_ID); }
          else { const u = new URL(req.url, "http://x"); const s = u.searchParams.get("key_ID"); if (!s) return send(res, 400, { message: "key_ID gerekli" }); ids = [s]; }
          const out = [];
          for (const id of ids) { const k = st.get(id); if (k === undefined) return send(res, 400, { message: `key_ID bulunamadı: ${id}` }); out.push({ key_ID: id, key: k }); st.delete(id); }
          return send(res, 200, { keys: out });
        }
        return send(res, 404, { message: "bilinmeyen uç", path: p });
      } catch { send(res, 500, { message: "iç hata" }); }
    };
  }

  const opts = { cert: tls.cert, key: tls.key, ca: [tls.ca], requestCert: true, rejectUnauthorized: true };
  const s1 = https.createServer(opts, makeHandler("kme-1")); s1.on("tlsClientError", () => {});
  const s2 = https.createServer(opts, makeHandler("kme-2")); s2.on("tlsClientError", () => {});

  return new Promise((resolve) => {
    let up = 0;
    const done = () => { if (++up === 2) resolve({
      urls: { kme1: `https://localhost:${kme1Port}`, kme2: `https://localhost:${kme2Port}` },
      latency: () => latencies.slice(),
      stop: () => Promise.all([new Promise(r => s1.close(r)), new Promise(r => s2.close(r))]),
    }); };
    s1.listen(kme1Port, "127.0.0.1", done);
    s2.listen(kme2Port, "127.0.0.1", done);
  });
}

module.exports = { startQukaydeeEmulator };
