#!/usr/bin/env node
"use strict";
/**
 * cabinet_lock_hal.js — Faraday kafesi kabin kilidi için DONANIM SOYUTLAMA
 * KATMANI (HAL): maintenance_traffic_coordinator.doorMayOpen() kararını gerçek
 * bir akıllı kilide / kilit API'sine bağlayan sözleşme + simüle donanım.
 * ═══════════════════════════════════════════════════════════════════
 * hal/hardware_interface.py ile AYNI ilke: arayüz KÜÇÜK ve vendor'dan bağımsız.
 * Gerçek bir kilit eklemek için yalnız CabinetLockHAL'den türetilmiş bir sınıf
 * yazılır; koordinatör, ağ ve testler değişmez.
 *
 * GÜVENLİK TASARIMI:
 *   • AÇMA YETKİSİ = Ed25519 imzalı, KISA ÖMÜRLÜ, TEK KULLANIMLIK belge
 *     (düğüm, iş emri, teknisyen, nbf/exp, nonce, "boşaltıldı" beyanı).
 *     Kilit yalnız AÇIK anahtarı tutar → ele geçirilen kilit yetki ÜRETEMEZ.
 *   • Kilit kendi tarafında YENİDEN doğrular: imza, düğüm, zaman penceresi (saat
 *     kayması toleransıyla), kilit tarafı azami ömür, nonce tekrarı, boşaltma
 *     beyanının tazeliği. Herhangi biri başarısız → KİLİTLİ KALIR.
 *   • FAIL-SECURE: iletişim kopması, zaman aşımı, eyleyici arızası, geçersiz
 *     belge → kilit kapalı kalır. Açıldıktan sonra kapı unlockWindowMs içinde
 *     açılmazsa kendiliğinden yeniden kilitlenir.
 *   • KAPI SENSÖRÜ (reed kontağı) kilitten BAĞIMSIZDIR: kilitliyken kapı açılırsa
 *     (zorlama) TAMPER, mekanik acil anahtarla açılırsa OVERRIDE olayı üretir.
 *     Koordinatör bu olaylarda düğümü HEMEN ağdan çıkarır (olay-tetikli yeniden
 *     planlama) — SE izleyicisinin bir sonraki örneğini beklemez.
 *
 * DÜRÜSTLÜK / KAPSAM:
 *   • Bu bir SİMÜLE donanımdır; belirli bir üreticinin API'si taklit EDİLMEZ.
 *     HTTP uç noktaları bu projenin kendi tasarımıdır (POST /v1/locks/:id/unlock …).
 *   • Simüle API sunucusu 127.0.0.1 üzerinde düz HTTP konuşur; yetki imzalı belgeyle
 *     sağlanır. Gerçek dağıtımda taşıma katmanı mTLS olmalıdır (pki_tools ile aynı CA).
 *   • İnsan güvenliği: kabinlerde mekanik acil anahtar / yangın çıkışı ihtiyacı
 *     gerçektir; kilit bunu ENGELLEMEZ, yalnız OVERRIDE olayı olarak raporlar.
 *   • Sensör gecikmesi (vars. 5 ms) ve kilit davranışı varsayımdır.
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const crypto = require("crypto");
const http = require("http");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

// ═══ 1) Sözleşme ═══
class CabinetLockError extends Error {}
/**
 * Her kilit sürücüsünün uyacağı SÖZLEŞME. Tüm metodlar Promise döndürür
 * (ağ üzerinden konuşan sürücüler için doğal; bellek-içi sürücü de aynı biçimi korur).
 *   requestUnlock(nodeId, grantToken) → { ok, state, reason?, unlockedUntilMs? }
 *   lock(nodeId)                      → { ok, state }
 *   status(nodeId)                    → { state, door, sensorHealthy, actuatorHealthy }
 *   pollEvents(nodeId, sinceSeq)      → [ { seq, type, atMs, ... } ]
 */
class CabinetLockHAL {
  async requestUnlock() { throw new CabinetLockError("CabinetLockHAL.requestUnlock uygulanmadı"); }
  async lock() { throw new CabinetLockError("CabinetLockHAL.lock uygulanmadı"); }
  async status() { throw new CabinetLockError("CabinetLockHAL.status uygulanmadı"); }
  async pollEvents() { throw new CabinetLockError("CabinetLockHAL.pollEvents uygulanmadı"); }
}

// ═══ 2) Yetki makamı (koordinatör tarafı — özel anahtar burada) ═══
class UnlockGrantAuthority {
  constructor({ privateKey, publicKey } = {}) {
    if (!privateKey) ({ privateKey, publicKey } = crypto.generateKeyPairSync("ed25519"));
    this.privateKey = privateKey; this.publicKey = publicKey;
  }
  publicKeyPem() { return this.publicKey.export({ type: "spki", format: "pem" }); }
  /** @returns {string} "payload.signature" (base64url) */
  issue({ nodeId, workOrderId, technicianId, nbfMs, expMs, attestation }) {
    const payload = { v: 1, typ: "cabinet-unlock", nodeId, workOrderId, technicianId, nbf: nbfMs, exp: expMs, nonce: crypto.randomUUID(), attestation };
    const body = Buffer.from(JSON.stringify(payload));
    return `${b64u(body)}.${b64u(crypto.sign(null, body, this.privateKey))}`;
  }
}

// ═══ 3) Simüle akıllı kilit (cihaz tarafı — yalnız açık anahtar) ═══
const LOCK_DEFAULTS = Object.freeze({ unlockWindowMs: 30000, maxGrantTtlMs: 10 * 60e3, clockSkewToleranceMs: 2000, maxAttestationAgeMs: 5000, sensorLatencyMs: 5 });

class SimulatedSmartLock {
  constructor({ nodeId, authorityPublicKey, clock = () => Date.now(), opts = {} }) {
    if (!nodeId || !authorityPublicKey) throw new TypeError("SimulatedSmartLock: nodeId ve authorityPublicKey ZORUNLU.");
    const pk = typeof authorityPublicKey === "string" ? crypto.createPublicKey(authorityPublicKey) : authorityPublicKey;
    Object.assign(this, { nodeId, pk, clock, opts: { ...LOCK_DEFAULTS, ...opts } });
    this.state = "LOCKED";          // LOCKED | UNLOCKED
    this.door = "CLOSED";           // CLOSED | OPEN
    this.unlockedUntilMs = null;
    this.seenNonces = new Map();     // nonce → exp (tekrar koruması)
    this.faults = { actuatorStuck: false, sensorDead: false, clockSkewMs: 0 };
    this.events = []; this.seq = 0;
    this.authorizedEntry = false;    // mevcut açıklık geçerli yetkiyle mi?
  }
  _now() { return this.clock() + this.faults.clockSkewMs; }
  _emit(type, extra = {}, atMs = this._now()) { const ev = { seq: ++this.seq, nodeId: this.nodeId, type, atMs, ...extra }; this.events.push(ev); return ev; }
  _sensor(type, physMs, extra) { if (this.faults.sensorDead) return null; return this._emit(type, extra, physMs + this.opts.sensorLatencyMs); }

  /** Zamanı ilerlet: süresi dolan açma penceresi → yeniden kilit. */
  tick() {
    const now = this._now();
    if (this.state === "UNLOCKED" && this.door === "CLOSED" && now >= this.unlockedUntilMs) {
      this.state = "LOCKED"; this.unlockedUntilMs = null; this._emit("RELOCKED", { reason: "açma penceresi doldu, kapı açılmadı" });
    }
    for (const [n, exp] of this.seenNonces) if (exp + this.opts.clockSkewToleranceMs < now) this.seenNonces.delete(n);
  }

  /** Belgeyi doğrula; geçerliyse sürgüyü çek. Her ret KİLİTLİ bırakır. */
  unlock(token) {
    this.tick();
    const now = this._now(), o = this.opts;
    const deny = (reason, code = 403) => { this._emit("UNLOCK_DENIED", { reason }); return { ok: false, code, state: this.state, reason }; };
    if (typeof token !== "string" || token.split(".").length !== 2) return deny("belge biçimi geçersiz");
    const [pb, sb] = token.split(".");
    let body, payload;
    try { body = fromB64u(pb); payload = JSON.parse(body.toString("utf8")); } catch (e) { return deny("belge çözülemedi"); }
    let sigOk = false;
    try { sigOk = crypto.verify(null, body, this.pk, fromB64u(sb)); } catch (e) { sigOk = false; }
    if (!sigOk) return deny("imza geçersiz");
    if (payload.v !== 1 || payload.typ !== "cabinet-unlock") return deny("belge türü/sürümü geçersiz");
    if (payload.nodeId !== this.nodeId) return deny(`belge başka düğüm için (${payload.nodeId})`);
    if (!Number.isFinite(payload.nbf) || !Number.isFinite(payload.exp) || payload.exp - payload.nbf > o.maxGrantTtlMs) return deny("belge ömrü kilit sınırını aşıyor");
    if (now + o.clockSkewToleranceMs < payload.nbf) return deny("belge henüz geçerli değil (nbf)");
    if (now - o.clockSkewToleranceMs > payload.exp) return deny("belgenin süresi dolmuş (exp)");
    if (!payload.nonce || this.seenNonces.has(payload.nonce)) return deny("belge daha önce kullanılmış (tekrar)");
    const a = payload.attestation || {};
    if (a.drained !== true || !Number.isFinite(a.planCheckedAtMs) || now - a.planCheckedAtMs > o.maxAttestationAgeMs + o.clockSkewToleranceMs) return deny("boşaltma beyanı yok ya da bayat");
    if (this.door === "OPEN") return deny("kapı zaten açık", 409);
    this.seenNonces.set(payload.nonce, payload.exp); // nonce eyleyici sonucundan bağımsız harcanır
    if (this.faults.actuatorStuck) { this._emit("UNLOCK_FAILED", { reason: "eyleyici sıkıştı — sürgü çekilemedi (KİLİTLİ kaldı)", workOrderId: payload.workOrderId }); return { ok: false, code: 503, state: this.state, reason: "eyleyici arızası" }; }
    this.state = "UNLOCKED"; this.unlockedUntilMs = now + o.unlockWindowMs;
    this._emit("UNLOCKED", { workOrderId: payload.workOrderId, technicianId: payload.technicianId, untilMs: this.unlockedUntilMs });
    return { ok: true, code: 200, state: this.state, unlockedUntilMs: this.unlockedUntilMs };
  }

  lock() { if (this.door === "CLOSED") { this.state = "LOCKED"; this.unlockedUntilMs = null; this._emit("RELOCKED", { reason: "komutla" }); } return { ok: this.state === "LOCKED", state: this.state }; }

  // ── Fiziksel dünya (testlerin "teknisyen/saldırgan" eylemleri) ──
  /** Kapıyı aç. forced=true: kilitliyken zorla. @returns {boolean} kapı açıldı mı */
  physicalOpen({ forced = false, atMs = this._now() } = {}) {
    this.tick();
    if (this.door === "OPEN") return true;
    if (this.state === "UNLOCKED") { this.door = "OPEN"; this.authorizedEntry = true; this._sensor("DOOR_OPENED", atMs, { authorized: true }); return true; }
    if (!forced) return false; // sürgü kapalı — kapı açılmaz
    this.door = "OPEN"; this.authorizedEntry = false;
    this._sensor("TAMPER", atMs, { authorized: false, detail: "kilitliyken kapı açıldı (zorlama)" });
    return true;
  }
  /** Mekanik acil anahtar — engellenmez, raporlanır. */
  mechanicalOverride({ atMs = this._now() } = {}) {
    this.state = "UNLOCKED"; this.door = "OPEN"; this.authorizedEntry = false;
    this._sensor("OVERRIDE", atMs, { authorized: false, detail: "mekanik acil anahtar kullanıldı" });
    return true;
  }
  physicalClose({ atMs = this._now() } = {}) {
    if (this.door === "CLOSED") return;
    this.door = "CLOSED";
    this._sensor("DOOR_CLOSED", atMs, { authorizedEntry: this.authorizedEntry });
    this.state = "LOCKED"; this.unlockedUntilMs = null; this._emit("RELOCKED", { reason: "kapı kapandı, sürgü oturdu" }, atMs + this.opts.sensorLatencyMs);
  }
  status() { this.tick(); return { nodeId: this.nodeId, state: this.state, door: this.faults.sensorDead ? "UNKNOWN" : this.door, sensorHealthy: !this.faults.sensorDead, actuatorHealthy: !this.faults.actuatorStuck, unlockedUntilMs: this.unlockedUntilMs }; }
  eventsSince(seq = 0, uptoMs = Infinity) { return this.events.filter((e) => e.seq > seq && e.atMs <= uptoMs); }
}

// ═══ 4) Sürücüler ═══
/** Bellek-içi sürücü (simülasyon zamanıyla) — ağ simülasyonu testleri için. */
class InProcessLockAdapter extends CabinetLockHAL {
  constructor(locks) { super(); this.locks = new Map(locks.map((l) => [l.nodeId, l])); }
  _l(id) { const l = this.locks.get(id); if (!l) throw new CabinetLockError(`kilit yok: ${id}`); return l; }
  async requestUnlock(id, token) { return this._l(id).unlock(token); }
  async lock(id) { return this._l(id).lock(); }
  async status(id) { return this._l(id).status(); }
  async pollEvents(id, sinceSeq = 0, uptoMs = Infinity) { return this._l(id).eventsSince(sinceSeq, uptoMs); }
}

/**
 * Simüle kilit DENETLEYİCİSİ — gerçek HTTP API (127.0.0.1). Arıza enjeksiyonu:
 * commsDown=true → istekler YANITSIZ bırakılır (askıda), istemci zaman aşımına düşer.
 */
class SimulatedLockApiServer {
  constructor(locks) { this.locks = new Map(locks.map((l) => [l.nodeId, l])); this.commsDown = false; this.server = null; this.hung = new Set(); }
  async start(port = 0) {
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = this.server.address().port; this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }
  async stop() { for (const s of this.hung) s.destroy(); await new Promise((r) => this.server.close(r)); }
  _send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); }
  _handle(req, res) {
    if (this.commsDown) { this.hung.add(req.socket); return; } // yanıt yok — fail-secure testleri için
    const m = /^\/v1\/locks\/([^/]+)\/(unlock|lock|status|events)(?:\?since=(\d+))?$/.exec(req.url);
    const lock = m && this.locks.get(decodeURIComponent(m[1]));
    if (!lock) return this._send(res, 404, { message: "kilit/uç nokta yok" });
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
    req.on("end", () => {
      try {
        if (m[2] === "unlock" && req.method === "POST") { const r = lock.unlock((JSON.parse(raw || "{}")).grant); return this._send(res, r.code, r); }
        if (m[2] === "lock" && req.method === "POST") return this._send(res, 200, lock.lock());
        if (m[2] === "status" && req.method === "GET") return this._send(res, 200, lock.status());
        if (m[2] === "events" && req.method === "GET") return this._send(res, 200, { events: lock.eventsSince(+(m[3] || 0)) });
        return this._send(res, 405, { message: "yöntem desteklenmiyor" });
      } catch (e) { return this._send(res, 400, { message: "istek çözülemedi" }); }
    });
  }
}

/** HTTP sürücüsü — gerçek bir kilit denetleyicisinin REST API'sine bu biçimde bağlanılır. */
class HttpLockAdapter extends CabinetLockHAL {
  constructor({ baseUrl, timeoutMs = 2000 }) { super(); this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; }
  _call(method, p, body) {
    const u = new URL(p, this.baseUrl), data = body ? JSON.stringify(body) : null;
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
        headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* boş */ } fin({ httpStatus: res.statusCode, json: j }); });
      });
      req.setTimeout(this.timeoutMs, () => { req.destroy(); fin({ httpStatus: 0, error: `zaman aşımı (${this.timeoutMs} ms)` }); });
      req.on("error", (e) => fin({ httpStatus: 0, error: e.code || e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  async requestUnlock(id, token) {
    const r = await this._call("POST", `/v1/locks/${encodeURIComponent(id)}/unlock`, { grant: token });
    if (r.httpStatus === 0) return { ok: false, state: "LOCKED_ASSUMED", reason: `${r.error} — kilit KİLİTLİ varsayılır (fail-secure)` };
    return { ok: r.httpStatus === 200 && !!(r.json && r.json.ok), httpStatus: r.httpStatus, ...(r.json || {}) };
  }
  async lock(id) { const r = await this._call("POST", `/v1/locks/${encodeURIComponent(id)}/lock`); return r.json || { ok: false, error: r.error }; }
  async status(id) { const r = await this._call("GET", `/v1/locks/${encodeURIComponent(id)}/status`); return r.httpStatus === 200 ? r.json : { state: "UNKNOWN", door: "UNKNOWN", error: r.error }; }
  async pollEvents(id, sinceSeq = 0) { const r = await this._call("GET", `/v1/locks/${encodeURIComponent(id)}/events?since=${sinceSeq}`); return r.httpStatus === 200 ? r.json.events : []; }
}

module.exports = { CabinetLockHAL, CabinetLockError, UnlockGrantAuthority, SimulatedSmartLock, InProcessLockAdapter, SimulatedLockApiServer, HttpLockAdapter, LOCK_DEFAULTS };
