#!/usr/bin/env node
"use strict";
/**
 * shield_sensor_hal.js — KALKAN SENSÖR HAL'İ ve VERİ BESLEME MOCK'LARI
 * ═══════════════════════════════════════════════════════════════════
 * Karar katmanı, çok-düğümlü ağ, mesh izolasyonu ve kestirimci bakım dB/kalkan
 * verisini bugüne kadar her testin içinde elle üretilmiş dizilerden alıyordu. Bu
 * modül o veriyi GERÇEK bir sensör yolunun biçiminde üretir ve tüketicilere tek bir
 * kapıdan (doğrulayıcı) verir. Gerçek sensör geldiğinde yalnız bir sürücü sınıfı eklenir.
 *
 *   ShieldSensorHAL (sözleşme) ── readFrames(nowMs) → Promise<Frame[]>
 *     ├─ MockShieldSensorDriver   fiziksel model + sensör gürültüsü/nicemleme/doyma + ARIZA enjeksiyonu
 *     ├─ ReplayShieldSensorDriver JSONL/CSV kaydından oynatma (FrameRecorder ile kayıt)
 *     └─ HttpShieldSensorDriver   SimulatedSensorDeviceServer'a (gerçek HTTP) bağlanır
 *   SensorFrameValidator  → KAPALI-BAŞARISIZ: geçersiz/bayat/takılı/tekrar/gelecek-zamanlı veri NaN olur
 *   ShieldSensorFeed      → sürücü + doğrulayıcı → { meas, env, quality } (ağ/mesh/bakım biçiminde)
 *
 * Çerçeve (v1, düğüm başına bir örnek):
 *   { v:1, nodeId, seq, tMs, se:[{id:'A', db, sat}], ambient:{dbuvm, sat},
 *     env:{tempC, rh, vibGrms}, probeDb?: number|null, y0:{linkKey: Y0} }
 *   y0 yalnız düğümün ALICI olduğu linkler için (Y0'ı alıcının dedektörü ölçer).
 *
 * DÜRÜSTLÜK / KAPSAM:
 *   • Fiziksel model, tüketicinin kullandığı içeri-giriş modelinin (ingressEffectiveY0) AYNISIDIR →
 *     "model doğruysa sistem çalışır" döngüseldir. ingressMismatchDb ile gerçek dünyanın modelden
 *     sapması enjekte edilebilir; ama gerçek saha verisinin yerini tutmaz.
 *   • Y0, 1 s'lik vakum-decoy penceresinden (vars. 1e8 vakum darbesi) Poisson sayımıyla tahmin edilir;
 *     pencereler örnekler arasında BAĞIMSIZ üretilir (gerçek kayan pencere geçişleri yumuşatır).
 *   • Tek sensörlü kayma (drift) doğrulayıcıyla ALGILANAMAZ — referans ya da ikinci sensör gerekir.
 *   • Sensör parametreleri (σ, nicemleme, aralık) varsayım; belirli bir cihazın veri sayfası değil.
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const http = require("http");
const A = require("./adaptive_shielding_mitigation.js");
const NETM = require("./multinode_shielding_network.js");

const SENSOR_DEFAULTS = Object.freeze({
  sampleMs: 50,
  seNoiseDb: 0.3, seQuantDb: 0.1, seMinDb: 0, seMaxDb: 100,          // SE ölçer: dinamik aralık 0–100 dB
  ambientNoiseDb: 0.5, ambientQuantDb: 0.1, ambientMinDbuVm: -10, ambientMaxDbuVm: 140,
  tempNoiseC: 0.1, rhNoisePct: 0.5, probeNoiseDb: 0.5,
  y0WindowPulses: 1e8, baseY0: 1e-5,                                  // 1 s × 1 GHz × %10 vakum
  // doğrulayıcı
  maxAgeMs: 150, futureToleranceMs: 50, stuckSamples: 40, dualDisagreeDb: 3, dualDisagreeMs: 1000,
  y0Max: 1, tempRangeC: [-50, 100],
});

// ═══ Sayaç-tabanlı (durumsuz) RNG: aynı (tohum, düğüm, kanal, örnek) → aynı değer ═══
function hash32(...xs) {
  let h = 0x811c9dc5 ^ xs.length;
  for (const x of xs) { h = Math.imul(h ^ (x | 0), 0x01000193); h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; }
  return h >>> 0;
}
const u01 = (...xs) => (hash32(...xs) + 0.5) / 4294967296;
const gauss = (...xs) => Math.sqrt(-2 * Math.log(u01(...xs, 1))) * Math.cos(2 * Math.PI * u01(...xs, 2));
function poissonC(lambda, ...xs) {
  if (!(lambda > 0)) return 0;
  if (lambda >= 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(...xs, 7)));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= u01(...xs, 100 + k); } while (p > L && k < 1000);
  return k - 1;
}
const quant = (v, q) => (q > 0 ? Math.round(v / q) * q : v);
const strHash = (s) => hash32(...[...String(s)].map((c) => c.charCodeAt(0)));

// ═══ 1) Fiziksel model (gerçek değerler, gürültüsüz; t'nin saf fonksiyonu) ═══
/**
 * events:
 *   { kind:'door', node, startMs, durMs, seDb=15, rampMs=200 }       kafes kapısı (SE çöküşü)
 *   { kind:'gasketAging', node, startMs=0, durMs, lossDb }             doğrusal conta kaybı
 *   { kind:'rfEmitter', node, startMs, durMs, ambientDbuVm }           ortam alanı sensörünün GÖRDÜĞÜ verici
 *   { kind:'rogueRf', node, startMs, durMs, y0Factor, probeDb=0 }      dedektöre giriş; ortam sensörü GÖRMEZ,
 *                                                                      bağımsız prob probeDb kadar görür
 *   { kind:'injection', link:key, startMs, durMs, y0Factor }           vericiden fibere ışık (yalnız o link)
 * thermal: { meanC=25, ampC=8, rhMean=50, rhAmp=15, periodMs=86400000, vibGrms=0.05 }
 */
class PhysicalShieldModel {
  constructor({ topology, ingress, events = [], thermal = {}, ingressMismatchDb = 0, o = {} }) {
    this.topology = topology; this.ingress = ingress; this.events = events;
    this.thermal = { meanC: 25, ampC: 8, rhMean: 50, rhAmp: 15, periodMs: 86400000, vibGrms: 0.05, ...thermal };
    this.ingressMismatchDb = ingressMismatchDb; this.o = { ...SENSOR_DEFAULTS, ...o };
    this.nodeIdx = new Map(topology.nodes.map((n, i) => [n.id, i]));
  }
  _active(e, t) { const s = e.startMs || 0, d = e.durMs == null ? Infinity : e.durMs; return t >= s && t <= s + d; }
  truth(t) {
    const nodes = {}, links = {};
    const th = this.thermal;
    for (const n of this.topology.nodes) {
      const i = this.nodeIdx.get(n.id);
      let se = n.nominalSeDb, amb = n.ambientFieldDbuVm, door = false, rogueFactor = 1, rogueProbe = 0;
      for (const e of this.events) {
        if (e.node !== n.id) continue;
        if (e.kind === "gasketAging") {
          const s = e.startMs || 0; if (t > s) se -= e.lossDb * Math.min(1, (t - s) / e.durMs);
        }
      }
      for (const e of this.events) {
        if (e.node !== n.id || !this._active(e, t)) continue;
        if (e.kind === "door") {
          const tgt = e.seDb != null ? e.seDb : 15, ramp = e.rampMs != null ? e.rampMs : 200;
          const s = e.startMs, end = e.startMs + e.durMs;
          const f = Math.min(1, (t - s) / ramp, (end - t) / ramp);
          se = Math.min(se, se + (tgt - se) * Math.max(0, f)); door = true;
        } else if (e.kind === "rfEmitter") amb = Math.max(amb, e.ambientDbuVm);
        else if (e.kind === "rogueRf") { rogueFactor *= e.y0Factor || 1; rogueProbe = Math.max(rogueProbe, e.probeDb || 0); }
      }
      const ph = (2 * Math.PI * t) / th.periodMs + i * 0.7;
      nodes[n.id] = { seDb: se, ambientDbuVm: amb, tempC: th.meanC + th.ampC * Math.sin(ph), rh: th.rhMean - th.rhAmp * Math.sin(ph), vibGrms: th.vibGrms, doorOpen: door, rogueFactor, rogueProbeDb: rogueProbe };
    }
    for (const l of this.topology.links) {
      const key = NETM.linkKey(l.a, l.b), rx = nodes[l.b];
      let y0 = A.ingressEffectiveY0({ seDb: rx.seDb, ambientFieldDbuVm: rx.ambientDbuVm, susceptibilityDbuVm: this.ingress.susceptibilityDbuVm - this.ingressMismatchDb, refDarkYield: this.ingress.refDarkYield, baseY0: this.o.baseY0 }).Y0eff;
      y0 *= rx.rogueFactor;
      for (const e of this.events) if (e.kind === "injection" && e.link === key && this._active(e, t)) y0 *= e.y0Factor;
      links[key] = { y0, rx: l.b, tx: l.a };
    }
    return { nodes, links };
  }
}

// ═══ 2) Sözleşme ═══
class ShieldSensorHAL {
  /** @returns Promise<Frame[]> — o ana kadar alınan çerçeveler (eksik/boş olabilir). */
  async readFrames(_nowMs) { throw new Error("ShieldSensorHAL.readFrames: alt sınıf uygulamalı"); }
  async close() {}
}

// ═══ 3) Mock sürücü: model + sensör + arıza ═══
/**
 * sensors: { nodeId: { dualSe:bool, probe:bool, seBiasDb:{A,B} } }
 * faults:
 *   { kind:'dropout', node, startMs, durMs }                      çerçeve hiç gelmez
 *   { kind:'stuck', node, field:'se'|'ambient'|'y0', sensor='A', startMs, durMs }   değer donar
 *   { kind:'fieldMissing', node, field, startMs, durMs }          alan null
 *   { kind:'stale', node, startMs, durMs, delayMs }               zaman damgası geride (tampon)
 *   { kind:'clockSkew', node, startMs, durMs, skewMs }            zaman damgası ileride
 *   { kind:'drift', node, sensor='A', startMs, rateDbPerS }       SE sensörü kayar
 *   { kind:'spike', node, atMs, deltaDb }                         EFT artefaktı (tek örnek)
 *   { kind:'dupSeq', node, startMs, durMs }                       aynı seq tekrar (yeniden oynatılan çerçeve)
 *   { kind:'outOfRange', node, field, value, startMs, durMs }     fiziksel olarak imkânsız değer
 */
class MockShieldSensorDriver extends ShieldSensorHAL {
  constructor({ model, seed = 1, sensors = {}, faults = [], o = {} }) {
    super();
    this.model = model; this.seed = seed; this.sensors = sensors; this.faults = faults;
    this.o = { ...SENSOR_DEFAULTS, ...model.o, ...o };
    this.topology = model.topology;
    this.stuckVal = new Map(); this.seq = new Map(this.topology.nodes.map((n) => [n.id, 0]));
    this.rxLinks = new Map(this.topology.nodes.map((n) => [n.id, this.topology.links.filter((l) => l.b === n.id).map((l) => NETM.linkKey(l.a, l.b))]));
  }
  _f(kind, node, t) { return this.faults.filter((f) => f.kind === kind && f.node === node && t >= (f.startMs || 0) && (f.durMs == null || t <= (f.startMs || 0) + f.durMs)); }
  _stuck(node, field, sensor, t, v) {
    const f = this.faults.find((x) => x.kind === "stuck" && x.node === node && x.field === field && (x.sensor == null ? (field !== "se" || sensor === "A") : x.sensor === sensor) && t >= x.startMs && (x.durMs == null || t <= x.startMs + x.durMs));
    const k = `${node}:${field}:${sensor}`;
    if (!f) { this.stuckVal.delete(k); return v; }
    if (!this.stuckVal.has(k)) this.stuckVal.set(k, v);
    return this.stuckVal.get(k);
  }
  /** Saf çerçeve üretimi (senkron). */
  framesAt(t) {
    const o = this.o, k = Math.round(t / o.sampleMs), tr = this.model.truth(t), out = [];
    for (const n of this.topology.nodes) {
      const id = n.id, ni = this.model.nodeIdx.get(id), cfg = this.sensors[id] || {}, T = tr.nodes[id];
      if (this._f("dropout", id, t).length) continue;
      const se = [];
      for (const [si, sid] of (cfg.dualSe ? ["A", "B"] : ["A"]).entries()) {
        let v = T.seDb + o.seNoiseDb * gauss(this.seed, ni, 10 + si, k) + ((cfg.seBiasDb || {})[sid] || 0);
        for (const f of this.faults) if (f.kind === "drift" && f.node === id && (f.sensor || "A") === sid && t > f.startMs) v += f.rateDbPerS * (t - f.startMs) / 1000;
        for (const f of this.faults) if (f.kind === "spike" && f.node === id && Math.round(f.atMs / o.sampleMs) === k && (f.sensor || "A") === sid) v += f.deltaDb;
        v = Math.min(o.seMaxDb, Math.max(o.seMinDb, quant(v, o.seQuantDb)));
        v = this._stuck(id, "se", sid, t, v);
        se.push({ id: sid, db: +v.toFixed(3), sat: v >= o.seMaxDb });
      }
      let amb = quant(T.ambientDbuVm + o.ambientNoiseDb * gauss(this.seed, ni, 20, k), o.ambientQuantDb);
      amb = Math.min(o.ambientMaxDbuVm, Math.max(o.ambientMinDbuVm, amb));
      amb = this._stuck(id, "ambient", "A", t, amb);
      const env = { tempC: +(T.tempC + o.tempNoiseC * gauss(this.seed, ni, 30, k)).toFixed(2), rh: +Math.min(100, Math.max(0, T.rh + o.rhNoisePct * gauss(this.seed, ni, 31, k))).toFixed(1), vibGrms: T.vibGrms };
      const y0 = {};
      for (const [li, key] of this.rxLinks.get(id).entries()) {
        const lam = tr.links[key].y0 * o.y0WindowPulses;
        let v = Math.max(1, poissonC(lam, this.seed, ni, 40 + li, k)) / o.y0WindowPulses;
        v = this._stuck(id, "y0", key, t, v);
        y0[key] = v;
      }
      const frame = { v: 1, nodeId: id, seq: 0, tMs: t, se, ambient: { dbuvm: +amb.toFixed(2), sat: amb >= o.ambientMaxDbuVm }, env, y0 };
      if (cfg.probe) frame.probeDb = +Math.max(0, T.rogueProbeDb + o.probeNoiseDb * gauss(this.seed, ni, 50, k)).toFixed(2);
      for (const f of this._f("fieldMissing", id, t)) { if (f.field === "se") frame.se = []; else if (f.field === "ambient") frame.ambient = null; else if (f.field === "y0") frame.y0 = {}; else if (f.field === "env") frame.env = null; }
      for (const f of this._f("outOfRange", id, t)) { if (f.field === "se") frame.se = frame.se.map((s) => ({ ...s, db: f.value })); else if (f.field === "ambient") frame.ambient = { dbuvm: f.value, sat: false }; else if (f.field === "y0") for (const kk of Object.keys(frame.y0)) frame.y0[kk] = f.value; }
      for (const f of this._f("stale", id, t)) frame.tMs = t - f.delayMs;
      for (const f of this._f("clockSkew", id, t)) frame.tMs = t + f.skewMs;
      if (!this._f("dupSeq", id, t).length) this.seq.set(id, this.seq.get(id) + 1);
      frame.seq = this.seq.get(id);
      out.push(frame);
    }
    return out;
  }
  async readFrames(nowMs) { return this.framesAt(nowMs); }
}

// ═══ 4) Doğrulayıcı (kapalı-başarısız) ═══
class SensorFrameValidator {
  constructor({ topology, o = {} }) {
    this.topology = topology; this.o = { ...SENSOR_DEFAULTS, ...o };
    this.ids = new Set(topology.nodes.map((n) => n.id));
    this.links = topology.links.map((l) => ({ key: NETM.linkKey(l.a, l.b), a: l.a, b: l.b }));
    this.lastSeq = new Map(); this.runs = new Map(); this.disagreeSince = new Map();
    this.counters = {};
  }
  _count(r) { this.counters[r] = (this.counters[r] || 0) + 1; }
  _stuck(key, v) {
    const r = this.runs.get(key);
    if (r && r.v === v) r.n++; else this.runs.set(key, { v, n: 1 });
    return this.runs.get(key).n >= this.o.stuckSamples;
  }
  /** @returns { meas:{se, y0, y0Invalid, ambient, probe}, env, quality, rejects } */
  ingest(frames, receivedMs) {
    const o = this.o;
    const se = {}, ambient = {}, probe = {}, env = {}, quality = {}, y0 = {}, y0Invalid = {}, rejects = [];
    for (const id of this.ids) { se[id] = NaN; ambient[id] = NaN; probe[id] = null; env[id] = null; quality[id] = { frame: false, reasons: [] }; }
    for (const l of this.links) { y0[l.key] = NaN; y0Invalid[l.key] = true; }
    const ok = (Array.isArray(frames) ? frames : []).filter((f) => {
      const bad = (r) => { rejects.push({ nodeId: f && f.nodeId, reason: r }); this._count(r); return false; };
      if (!f || typeof f !== "object" || f.v !== 1) return bad("şema/sürüm");
      if (!this.ids.has(f.nodeId)) return bad("bilinmeyen düğüm");
      if (!Number.isInteger(f.seq) || !Number.isFinite(f.tMs)) return bad("şema: seq/tMs");
      return true;
    }).sort((x, y) => x.seq - y.seq);
    for (const f of ok) {
      const id = f.nodeId, q = quality[id];
      const rej = (r) => { rejects.push({ nodeId: id, reason: r }); q.reasons.push(r); this._count(r); };
      if (this.lastSeq.has(id) && f.seq <= this.lastSeq.get(id)) { rej("seq tekrarı/geri"); continue; }
      if (f.tMs > receivedMs + o.futureToleranceMs) { rej("zaman damgası gelecekte"); continue; }
      if (receivedMs - f.tMs > o.maxAgeMs) { rej("bayat"); continue; }
      this.lastSeq.set(id, f.seq); q.frame = true;
      // ── SE: her sensör ayrı; doyma = alt sınır (muhafazakâr), takılı/aralık dışı = geçersiz
      const vals = [];
      for (const s of Array.isArray(f.se) ? f.se : []) {
        const tag = `${id}:se:${s.id}`;
        if (!Number.isFinite(s.db) || s.db < o.seMinDb || s.db > o.seMaxDb) { q.reasons.push(`SE-${s.id} aralık dışı`); this._count("SE aralık dışı"); continue; }
        if (this._stuck(tag, s.db)) { q.reasons.push(`SE-${s.id} takılı`); this._count("SE takılı"); continue; }
        if (s.sat) q.reasons.push(`SE-${s.id} doymuş (alt sınır)`);
        vals.push({ id: s.id, db: s.db });
      }
      if (!vals.length) { q.reasons.push("SE yok"); }
      else {
        se[id] = Math.min(...vals.map((v) => v.db));
        const nDecl = (Array.isArray(f.se) ? f.se : []).length;
        if (nDecl > 1 && vals.length === 1) q.reasons.push("SE tek sensör");
        if (vals.length === 2) {
          if (Math.abs(vals[0].db - vals[1].db) > o.dualDisagreeDb) {
            if (!this.disagreeSince.has(id)) this.disagreeSince.set(id, f.tMs);
            if (f.tMs - this.disagreeSince.get(id) >= o.dualDisagreeMs) { q.reasons.push("SE sensörleri uyuşmuyor (küçüğü kullanılıyor)"); this._count("SE uyuşmazlık"); }
          } else this.disagreeSince.delete(id);
        }
      }
      // ── ortam alanı: doyma GEÇERSİZ (alanı olduğundan düşük gösterir → beklenen Y0 düşük → güvensiz yön)
      const a = f.ambient;
      if (!a || !Number.isFinite(a.dbuvm) || a.dbuvm < o.ambientMinDbuVm || a.dbuvm > o.ambientMaxDbuVm) q.reasons.push("ortam alanı yok/aralık dışı");
      else if (a.sat) q.reasons.push("ortam alanı doymuş (geçersiz)");
      else if (this._stuck(`${id}:ambient`, a.dbuvm)) q.reasons.push("ortam alanı takılı");
      else ambient[id] = a.dbuvm;
      // ── çevre
      if (f.env && Number.isFinite(f.env.tempC) && f.env.tempC >= o.tempRangeC[0] && f.env.tempC <= o.tempRangeC[1] && Number.isFinite(f.env.rh) && f.env.rh >= 0 && f.env.rh <= 100)
        env[id] = { tempC: f.env.tempC, rh: f.env.rh, vibGrms: Number.isFinite(f.env.vibGrms) && f.env.vibGrms >= 0 ? f.env.vibGrms : 0 };
      else q.reasons.push("çevre verisi geçersiz");
      // ── prob
      if (f.probeDb != null) { if (Number.isFinite(f.probeDb) && f.probeDb >= 0) probe[id] = f.probeDb; else q.reasons.push("prob geçersiz"); }
      // ── Y0: yalnız bu düğümün ALICI olduğu linkler kabul edilir
      for (const l of this.links.filter((x) => x.b === id)) {
        const v = f.y0 ? f.y0[l.key] : undefined;
        if (!Number.isFinite(v) || v < 0 || v > o.y0Max) { if (v !== undefined) q.reasons.push(`Y0 ${l.key} aralık dışı`); else q.reasons.push(`Y0 ${l.key} yok`); continue; }
        if (this._stuck(`${id}:y0:${l.key}`, v)) { q.reasons.push(`Y0 ${l.key} takılı`); continue; }
        y0[l.key] = v; y0Invalid[l.key] = false;
      }
      if (f.y0) for (const kk of Object.keys(f.y0)) if (!this.links.some((x) => x.key === kk && x.b === id)) q.reasons.push(`Y0 ${kk} bu düğümün alıcısı değil (yok sayıldı)`);
    }
    for (const id of this.ids) if (!quality[id].frame && !quality[id].reasons.length) quality[id].reasons.push("çerçeve yok");
    return { meas: { se, y0, y0Invalid, ambient, probe }, env, quality, rejects };
  }
}

// ═══ 5) Besleme adaptörü ═══
class ShieldSensorFeed {
  constructor({ driver, validator }) { this.driver = driver; this.validator = validator; this.reads = 0; }
  async read(nowMs) {
    let frames = [], err = null;
    try { frames = await this.driver.readFrames(nowMs); } catch (e) { err = e; frames = []; } // sürücü hatası → veri yok (kapalı-başarısız)
    const r = this.validator.ingest(frames, nowMs);
    this.reads++;
    return { ...r, driverError: err ? String(err.message || err) : null, frameCount: frames.length };
  }
  /** Kestirimci bakım örneği (predictive_maintenance.js ingest biçimi). */
  static prognosticsSample(r, nodeId) { return { seDb: r.meas.se[nodeId], env: r.env[nodeId] ? { ...r.env[nodeId], doorEvents: 0 } : null }; }
}

// ═══ 6) Kayıt / oynatma ═══
class FrameRecorder {
  constructor() { this.lines = []; }
  record(receivedMs, frames) { for (const f of frames) this.lines.push(JSON.stringify({ receivedMs, frame: f })); }
  toJsonl() { return this.lines.join("\n") + (this.lines.length ? "\n" : ""); }
  /** Düz CSV: y0 'anahtar=değer;…', se 'A:db:sat|B:db:sat'. */
  toCsv() {
    const rows = ["receivedMs,nodeId,seq,tMs,se,ambient,ambientSat,tempC,rh,vibGrms,probeDb,y0"];
    for (const ln of this.lines) {
      const { receivedMs, frame: f } = JSON.parse(ln);
      rows.push([receivedMs, f.nodeId, f.seq, f.tMs, (f.se || []).map((s) => `${s.id}:${s.db}:${s.sat ? 1 : 0}`).join("|"),
        f.ambient ? f.ambient.dbuvm : "", f.ambient && f.ambient.sat ? 1 : 0, f.env ? f.env.tempC : "", f.env ? f.env.rh : "", f.env ? f.env.vibGrms : "",
        f.probeDb == null ? "" : f.probeDb, Object.entries(f.y0 || {}).map(([k, v]) => `${k}=${v}`).join(";")].join(","));
    }
    return rows.join("\n") + "\n";
  }
}
function parseRecording(text, format = "jsonl") {
  const entries = [], errors = [];
  const lines = String(text).split(/\r?\n/);
  if (format === "jsonl") {
    lines.forEach((ln, i) => {
      if (!ln.trim()) return;
      try { const o = JSON.parse(ln); if (!Number.isFinite(o.receivedMs) || !o.frame) throw new Error("receivedMs/frame yok"); entries.push(o); }
      catch (e) { errors.push({ line: i + 1, reason: e.message }); }
    });
  } else if (format === "csv") {
    const hdr = lines[0].split(",");
    const need = ["receivedMs", "nodeId", "seq", "tMs", "se", "ambient", "ambientSat", "tempC", "rh", "vibGrms", "probeDb", "y0"];
    if (need.some((c, i) => hdr[i] !== c)) return { entries, errors: [{ line: 1, reason: "başlık uyumsuz" }] };
    lines.slice(1).forEach((ln, j) => {
      const i = j + 2; if (!ln.trim()) return;
      const c = ln.split(",");
      if (c.length !== need.length) { errors.push({ line: i, reason: `sütun sayısı ${c.length} ≠ ${need.length}` }); return; }
      const num = (s) => (s === "" ? null : Number(s));
      const se = c[4] ? c[4].split("|").map((p) => { const [id, db, sat] = p.split(":"); return { id, db: Number(db), sat: sat === "1" }; }) : [];
      const y0 = {}; if (c[11]) for (const kv of c[11].split(";")) { const [k, v] = kv.split("="); y0[k] = Number(v); }
      const f = { v: 1, nodeId: c[1], seq: Number(c[2]), tMs: Number(c[3]), se, ambient: c[5] === "" ? null : { dbuvm: Number(c[5]), sat: c[6] === "1" },
        env: c[7] === "" ? null : { tempC: Number(c[7]), rh: Number(c[8]), vibGrms: Number(c[9]) }, y0 };
      if (c[10] !== "") f.probeDb = num(c[10]);
      if (!Number.isFinite(Number(c[0])) || !Number.isInteger(f.seq)) { errors.push({ line: i, reason: "receivedMs/seq sayı değil" }); return; }
      entries.push({ receivedMs: Number(c[0]), frame: f });
    });
  } else throw new Error(`parseRecording: biçim ${format}?`);
  entries.sort((a, b) => a.receivedMs - b.receivedMs);
  return { entries, errors };
}
class ReplayShieldSensorDriver extends ShieldSensorHAL {
  constructor({ text, format = "jsonl", timeOffsetMs = 0 }) {
    super(); const p = parseRecording(text, format);
    this.entries = p.entries; this.errors = p.errors; this.i = 0; this.timeOffsetMs = timeOffsetMs;
  }
  /** (önceki çağrı, nowMs] aralığında alınmış çerçeveler. */
  async readFrames(nowMs) {
    const out = [];
    while (this.i < this.entries.length && this.entries[this.i].receivedMs + this.timeOffsetMs <= nowMs) out.push(this.entries[this.i++].frame);
    return out;
  }
  get done() { return this.i >= this.entries.length; }
  /** Gerçek zamanlı (hızlandırılmış) oynatma: onFrames(receivedMs, frames). */
  play({ speed = 1, onFrames }) {
    const groups = new Map(); for (const e of this.entries) { if (!groups.has(e.receivedMs)) groups.set(e.receivedMs, []); groups.get(e.receivedMs).push(e.frame); }
    const ts = [...groups.keys()]; if (!ts.length) return Promise.resolve(0);
    const t0 = ts[0], start = Date.now();
    return new Promise((resolve) => {
      let k = 0;
      const tick = () => {
        while (k < ts.length && (ts[k] - t0) / speed <= Date.now() - start) { onFrames(ts[k], groups.get(ts[k])); k++; }
        if (k >= ts.length) resolve(ts.length); else setTimeout(tick, Math.max(0, Math.min(20, (ts[k] - t0) / speed - (Date.now() - start))));
      };
      tick();
    });
  }
}

// ═══ 7) Simüle sensör cihazı (gerçek HTTP) + sürücü ═══
/**
 * GET /v1/frames?t=<ms>  → 200 {"frames":[…]}
 * Arıza modu (süreç içinden): server.mode = { kind:'ok'|'latency'|'http503'|'malformed'|'truncated'|'hang', delayMs }
 */
class SimulatedSensorDeviceServer {
  constructor({ driver }) { this.driver = driver; this.mode = { kind: "ok" }; this.requests = 0; this.server = null; this.sockets = new Set(); }
  async start(port = 0) {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    await new Promise((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = this.server.address().port; return `http://127.0.0.1:${this.port}`;
  }
  async _handle(req, res) {
    this.requests++;
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname !== "/v1/frames") { res.writeHead(404).end(); return; }
    const t = Number(u.searchParams.get("t"));
    const m = this.mode;
    if (m.kind === "hang") return; // yanıt yok
    if (m.kind === "http503") { res.writeHead(503, { "content-type": "application/json" }).end('{"error":"sensör meşgul"}'); return; }
    const frames = this.driver.framesAt(t);
    let body = JSON.stringify({ frames });
    if (m.kind === "malformed") body = body.replace(/"seq":/g, '"seq"').slice(0, -1);
    if (m.kind === "truncated") body = body.slice(0, Math.floor(body.length / 2));
    const send = () => { if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(body); };
    if (m.kind === "latency") setTimeout(send, m.delayMs || 0); else send();
  }
  async stop() { if (!this.server) return; for (const s of this.sockets) s.destroy(); await new Promise((r) => this.server.close(r)); this.server = null; }
}
class HttpShieldSensorDriver extends ShieldSensorHAL {
  constructor({ baseUrl, timeoutMs = 100 }) { super(); this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; this.lastError = null; this.errors = 0; }
  async readFrames(nowMs) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/v1/frames?t=${nowMs}`, { signal: ac.signal });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(await r.text());
      if (!j || !Array.isArray(j.frames)) throw new Error("yanıt biçimi: frames dizisi yok");
      this.lastError = null; return j.frames;
    } catch (e) {
      this.errors++; this.lastError = e.name === "AbortError" ? `zaman aşımı (${this.timeoutMs} ms)` : String(e.message || e);
      return []; // veri yok → doğrulayıcı NaN üretir → tüketici kapalı-başarısız
    } finally { clearTimeout(tm); }
  }
}

module.exports = {
  SENSOR_DEFAULTS, PhysicalShieldModel, ShieldSensorHAL, MockShieldSensorDriver, SensorFrameValidator, ShieldSensorFeed,
  FrameRecorder, parseRecording, ReplayShieldSensorDriver, SimulatedSensorDeviceServer, HttpShieldSensorDriver,
  _rng: { hash32, u01, gauss, poissonC, strHash },
};
