#!/usr/bin/env node
"use strict";
/**
 * predictive_maintenance.js — Faraday kafesi için KESTİRİMCİ BAKIM: çevresel
 * sensör verisi + SE ölçümünden kalan ömrü (RUL) tahmin eder ve kalkan kritik
 * eşiğe DAYANMADAN önce otonom sistem yöneticisine erken uyarı üretir.
 * ═══════════════════════════════════════════════════════════════════
 * KRİTİK EŞİK: adaptive_shielding_mitigation.js'in dışa-sızıntı eşiği
 * (SE_gerekli + ölçüm belirsizliği; test ağında 39 dB). Ölçülen SE bunun altına
 * inince düğüm HOLD'a girer ve yeni anahtar karantinaya gider — yani bakım
 * sinyali HOLD'dan ÖNCE gelmelidir.
 *
 * MODEL (fizik bilgili durum-uzayı, doğrusal Kalman filtresi):
 *   durum x = [L, s]   L = güncel SE seviyesi (dB), s = birimin bilinmeyen ölçeği
 *   L_{k+1} = L_k − s · ΔD_k + η_k      ΔD_k = çevre örneğinin BEKLENEN kaybı (ölçek 1)
 *   s_{k+1} = s_k + ζ_k                  (yavaş sürüklenme — conta partisi/ montaj farkı)
 *   z_k     = L_k + v_k                  (saatlik toplu SE ölçümü)
 * F = [[1, −ΔD], [0, 1]] doğrusal olduğundan filtre TAM Kalman'dır (EKF değil).
 * 'time-only' kipinde ΔD = Δt (saat): mevcut "zamana bağlı" modelin karşılığı —
 * aynı filtre, aynı önsel bilgiyle kıyas için.
 *
 * RUL: posteriordan (L, s) örneklenir; gelecek maruziyet SAHA KLİMATOLOJİSİNDEN
 * (SiteClimate.climatology) birikimli olarak öngörülür; her örnek için
 * L − s·[D(t+h) − D(t)] ≤ eşik olan ilk h bulunur → p10 / p50 / p90.
 * Uyarı kararları MUHAFAZAKÂR p10'a göre verilir.
 *
 * UYARI DÜZEYLERİ (histerezisli):
 *   ADVISORY  p10 RUL ≤ 60 gün   → bakım planla
 *   WARNING   p10 RUL ≤ 14 gün   → iş emri aç
 *   CRITICAL  p10 RUL ≤ 2 gün VEYA tahmini SE ≤ eşik + 0,5 dB → acil müdahale
 *   (son savunma, modelden bağımsız: tahmini SE ≤ eşik + 0,5 dB → CRITICAL her zaman;
 *    model henüz öğrenmemişken tahmini SE ≤ eşik + 2 dB → en az WARNING)
 *   ÖĞRENME KAPISI: ilk 14 gün ve ölçek belirsizliği %30'un üstündeyken RUL-tabanlı
 *   uyarı ÜRETİLMEZ (geniş önsel, açılışta sahte "yakında arıza" alarmı verirdi);
 *   marj-tabanlı son savunma bu sırada da açıktır.
 *   STEP_CHANGE ardışık ≥3 saat aynı yönde kapı dışı (4σ) yenilik → ani değişim
 *               (gevşek panel, açık kapı) — TREND MODELİ BUNU ÖNGÖREMEZ, yalnız algılar;
 *               filtre yeni seviyeye yeniden oturtulur.
 *   Düşürme yalnız p10, düzey eşiğinin 1,5 katını 24 saat boyunca aşarsa (salınım yok).
 *
 * DÜRÜSTLÜK: üsler (Peck n, Ea; Coffin–Manson q; Basquin b) SABİT varsayılır,
 * yalnız ölçek öğrenilir. Hava anomalileri klimatolojiden sapar; tahmin bunu
 * bilemez. Ölçüm cihazının sabit sapması (±1 dB) seviyeye karışır — bu yüzden
 * eşik zaten SE_gerekli + belirsizliktir ve tahmin edilen şey ÖLÇÜLEN SE'nin
 * operasyonel eşiği geçme zamanıdır.
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const E = require("./environmental_aging_model.js");
const { mulberry32 } = require("./hardware_aging_model.js");

const ALERT_LEVELS = Object.freeze(["NONE", "ADVISORY", "WARNING", "CRITICAL"]);
const DEFAULT_POLICY = Object.freeze({ advisoryDays: 60, warningDays: 14, criticalDays: 2,
  warningMarginDb: 2, criticalMarginDb: 0.5,          // modelden BAĞIMSIZ son savunma: tahmini SE ile eşik arası
  minLearningHours: 14 * 24, maxScaleRelSd: 0.3,     // öğrenme kapısı: RUL-tabanlı uyarılar ancak bundan sonra
  downgradeFactor: 1.5, downgradeHoldHours: 24 });

/** Klimatolojiden birikimli beklenen maruziyet (saatlik, mutlak saat dizini) — tahmin için. */
class ClimatologyExposure {
  constructor(climate, { params = E.DEFAULT_ENV_AGING_PARAMS, untilHours }) {
    this.cum = new Float64Array(untilHours + 1);
    const counter = new E.ThermalCycleCounter(params.tc.minRangeC);
    for (let h = 0; h < untilHours; h++) {
      const env = climate.climatology(h);
      this.cum[h + 1] = this.cum[h] + E.expectedLossDb(env, 1, counter.push(env.tempC), params).total;
    }
  }
  /** h saat sonra birikecek beklenen maruziyet: D(t+h) − D(t) */
  ahead(tHours, h) { const i = Math.min(this.cum.length - 1, Math.floor(tHours)); const j = Math.min(this.cum.length - 1, i + h); return this.cum[j] - this.cum[i]; }
  /** X maruziyetinin birikeceği ilk h (yoksa Infinity) — ikili arama */
  hoursUntil(tHours, X) {
    const i = Math.min(this.cum.length - 1, Math.floor(tHours)), base = this.cum[i];
    if (this.cum[this.cum.length - 1] - base < X) return Infinity;
    let lo = i, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] - base >= X) hi = mid; else lo = mid + 1; }
    return lo - i;
  }
}

class DegradationKalman {
  constructor({ initialSeDb, initialSdDb = 2, sPrior = { mean: 1, sd: 0.8 }, measSigmaDb = 0.2, processRel = 0.3, sDriftSdPerSqrtHour = 0.002, gateSigma = 4, stepConsecutive = 3 }) {
    this.x = [initialSeDb, sPrior.mean];
    this.P = [[initialSdDb ** 2, 0], [0, sPrior.sd ** 2]];
    Object.assign(this, { measSigmaDb, processRel, sDriftSdPerSqrtHour, gateSigma, stepConsecutive });
    this.rejectRun = 0; this.rejectSign = 0; this.n = 0; this.rejected = 0;
  }
  predict(dD, dtHours) {
    const [L, s] = this.x, P = this.P;
    this.x = [L - s * dD, s];
    // F P Fᵀ + Q,  F = [[1,−dD],[0,1]]
    const p00 = P[0][0] - 2 * dD * P[0][1] + dD * dD * P[1][1];
    const p01 = P[0][1] - dD * P[1][1];
    const qL = (this.processRel * Math.max(s, 0) * dD) ** 2;
    const qS = this.sDriftSdPerSqrtHour ** 2 * dtHours;
    this.P = [[p00 + qL, p01], [p01, P[1][1] + qS]];
  }
  /** @returns {{accepted, step, innovation, S}} */
  update(z) {
    if (!Number.isFinite(z)) return { accepted: false, step: false, missing: true };
    const S = this.P[0][0] + this.measSigmaDb ** 2;
    const nu = z - this.x[0];
    if (Math.abs(nu) > this.gateSigma * Math.sqrt(S)) {
      this.rejected++;
      const sg = Math.sign(nu);
      this.rejectRun = sg === this.rejectSign ? this.rejectRun + 1 : 1; this.rejectSign = sg;
      if (this.rejectRun >= this.stepConsecutive) {
        // ANİ DEĞİŞİM: seviyeyi yeni ölçüme oturt, ölçek bilgisini koru
        this.x = [z, this.x[1]]; this.P = [[this.measSigmaDb ** 2 * 4, 0], [0, this.P[1][1]]];
        this.rejectRun = 0;
        return { accepted: false, step: true, direction: sg, innovation: nu, S };
      }
      return { accepted: false, step: false, innovation: nu, S };
    }
    this.rejectRun = 0; this.rejectSign = 0;
    const K0 = this.P[0][0] / S, K1 = this.P[1][0] / S;
    this.x = [this.x[0] + K0 * nu, this.x[1] + K1 * nu];
    const P = this.P;
    this.P = [[(1 - K0) * P[0][0], (1 - K0) * P[0][1]], [P[1][0] - K1 * P[0][0], P[1][1] - K1 * P[0][1]]];
    this.n++;
    return { accepted: true, step: false, innovation: nu, S };
  }
  /** Bakım sonrası yeniden başlangıç (yeni conta → yeni seviye; ölçek önseline geri dönüş isteğe bağlı). */
  reset(seDb, keepScale = true, sPrior = { mean: 1, sd: 0.8 }) {
    this.x = [seDb, keepScale ? this.x[1] : sPrior.mean];
    this.P = [[0.5, 0], [0, keepScale ? Math.max(this.P[1][1], 0.05) : sPrior.sd ** 2]];
    this.rejectRun = 0;
  }
}

/**
 * Düğüm başına kestirimci monitör.
 * @param cfg.mode 'environmental' | 'time-only'
 * @param cfg.climate SiteClimate (environmental kipte tahmin için)
 * @param cfg.thresholdDb operasyonel eşik (ölçülen SE)
 * @param cfg.sPrior environmental: ölçek önseli; time-only: dB/saat önseli (aynı bilgi düzeyi için çağıran hesaplar)
 */
class PrognosticsMonitor {
  constructor(cfg) {
    if (!["environmental", "time-only"].includes(cfg.mode)) throw new TypeError("PrognosticsMonitor: mode 'environmental' | 'time-only'.");
    if (!Number.isFinite(cfg.thresholdDb)) throw new TypeError("PrognosticsMonitor: thresholdDb ZORUNLU.");
    Object.assign(this, { nodeId: cfg.nodeId != null ? cfg.nodeId : "?", mode: cfg.mode, thresholdDb: cfg.thresholdDb, params: cfg.params || E.DEFAULT_ENV_AGING_PARAMS,
      policy: { ...DEFAULT_POLICY, ...(cfg.policy || {}) }, samples: cfg.samples || 300, horizonHours: cfg.horizonHours || 2 * E.HOURS_PER_YEAR,
      evalEveryHours: cfg.evalEveryHours || 24 });
    this.rng = mulberry32((cfg.seed || 1) >>> 0);
    this.sPrior = cfg.sPrior || { mean: 1, sd: 0.8 };
    // Ölçek sürüklenmesi ÖNSEL ORTALAMAYA GÖRE göreli verilir → iki kip (ölçek / dB·saat⁻¹) adil kıyaslanır.
    this.kf = new DegradationKalman({ initialSeDb: cfg.initialSeDb, sPrior: this.sPrior, measSigmaDb: cfg.measSigmaDb || 0.2,
      sDriftSdPerSqrtHour: (cfg.sDriftRelPerSqrtHour != null ? cfg.sDriftRelPerSqrtHour : 0.002) * this.sPrior.mean });
    if (this.mode === "environmental") {
      if (!cfg.climatologyExposure) throw new TypeError("PrognosticsMonitor: environmental kip için climatologyExposure ZORUNLU.");
      this.clim = cfg.climatologyExposure;
      this.counter = new E.ThermalCycleCounter(this.params.tc.minRangeC);
    }
    this.level = "NONE"; this.belowSinceH = null; this.lastEvalH = -Infinity; this.lastT = null;
    this.events = []; this.lastRul = null;
  }

  _rul(tHours) {
    const [L, s] = this.kf.x, P = this.kf.P;
    // 2B Gauss örneklemi (Cholesky)
    const a = Math.sqrt(Math.max(P[0][0], 1e-12)), b = P[1][0] / a, c = Math.sqrt(Math.max(P[1][1] - b * b, 1e-12));
    const out = [];
    for (let i = 0; i < this.samples; i++) {
      const z1 = this._g(), z2 = this._g();
      const Ls = L + a * z1, ss = s + b * z1 + c * z2;
      const X = Ls - this.thresholdDb;
      let h;
      if (X <= 0) h = 0;
      else if (!(ss > 0)) h = Infinity;
      else h = this.mode === "environmental" ? this.clim.hoursUntil(tHours, X / ss) : X / ss;
      out.push(h);
    }
    out.sort((x, y) => x - y);
    const q = (p) => out[Math.min(out.length - 1, Math.floor(p * out.length))];
    return { p10: q(0.1) / 24, p50: q(0.5) / 24, p90: q(0.9) / 24 };
  }
  _g() { return Math.sqrt(-2 * Math.log(this.rng() || 1e-12)) * Math.cos(2 * Math.PI * this.rng()); }

  /** Ölçek posteriorunun göreli belirsizliği ve veri miktarı yeterli mi? */
  learned() {
    const s = this.kf.x[1], sd = Math.sqrt(Math.max(this.kf.P[1][1], 0));
    return this.kf.n >= this.policy.minLearningHours && s > 0 && sd / s <= this.policy.maxScaleRelSd;
  }
  _levelFor(rul, Lhat) {
    const p = this.policy, m = Lhat - this.thresholdDb;
    // Marj kuralı: CRITICAL marjı HER ZAMAN açık (mutlak son savunma). WARNING marjı yalnız model
    // henüz öğrenmemişken — öğrendikten sonra yavaş bozulan birimde 2 dB aylar demektir ve filo testi
    // bunun gerçek ömür 56 günden fazlayken 26 gereksiz WARNING ürettiğini ölçtü.
    const learned = this.learned();
    const byMargin = m <= p.criticalMarginDb ? "CRITICAL" : (!learned && m <= p.warningMarginDb) ? "WARNING" : "NONE";
    let byRul = "NONE";
    if (learned) byRul = rul.p10 <= p.criticalDays ? "CRITICAL" : rul.p10 <= p.warningDays ? "WARNING" : rul.p10 <= p.advisoryDays ? "ADVISORY" : "NONE";
    this._basis = ALERT_LEVELS.indexOf(byMargin) >= ALERT_LEVELS.indexOf(byRul) && byMargin !== "NONE" ? "marj" : "RUL";
    return ALERT_LEVELS.indexOf(byMargin) >= ALERT_LEVELS.indexOf(byRul) ? byMargin : byRul;
  }
  _limitDays(level) { const p = this.policy; return level === "CRITICAL" ? p.criticalDays : level === "WARNING" ? p.warningDays : p.advisoryDays; }

  _emit(tHours, kind, extra) {
    const ev = { nodeId: this.nodeId, mode: this.mode, atHours: tHours, kind, level: this.level, seEstimateDb: +this.kf.x[0].toFixed(2), scale: +this.kf.x[1].toFixed(3), rulDays: this.lastRul, learned: this.learned(), ...extra };
    this.events.push(ev);
    return ev;
  }

  /**
   * Saatlik giriş. sample: { seDb (toplu ölçüm, NaN olabilir), env: {tempC, rh, vibGrms, doorEvents} }
   * @returns {Array} bu saatte üretilen olaylar (otonom yöneticiye)
   */
  ingest(tHours, sample) {
    const dt = this.lastT == null ? 1 : tHours - this.lastT;
    this.lastT = tHours;
    const dD = this.mode === "environmental" ? E.expectedLossDb(sample.env, dt, this.counter.push(sample.env.tempC), this.params).total : dt;
    this.kf.predict(dD, dt);
    const u = this.kf.update(sample.seDb);
    const out = [];
    if (u.step) out.push(this._emit(tHours, "STEP_CHANGE", { direction: u.direction < 0 ? "düşüş" : "yükseliş", innovationDb: +u.innovation.toFixed(2),
      action: u.direction < 0 ? "Ani SE düşüşü (gevşek panel/conta, açık kapı?) — trend modeli bunu öngöremez; 24 saat içinde yerinde muayene" : "Ani SE yükselişi — bakım yapıldı mı? Filtre yeni seviyeye oturtuldu" }));
    if (tHours - this.lastEvalH >= this.evalEveryHours || u.step) {
      this.lastEvalH = tHours;
      this.lastRul = this._rul(tHours);
      const r = this.lastRul;
      const target = this._levelFor(r, this.kf.x[0]);
      const rank = (l) => ALERT_LEVELS.indexOf(l);
      if (rank(target) > rank(this.level)) {
        this.level = target; this.belowSinceH = null;
        out.push(this._emit(tHours, "ALERT", { basis: this._basis, action: actionFor(target, r) }));
      } else if (rank(target) < rank(this.level)) {
        // düşürme histerezisi: p10, mevcut düzey sınırının 1,5 katını 24 saat aşmalı
        const ok = r.p10 > this.policy.downgradeFactor * this._limitDays(this.level) && this.kf.x[0] - this.thresholdDb > 1.5 * this.policy.warningMarginDb;
        if (ok) { if (this.belowSinceH == null) this.belowSinceH = tHours; if (tHours - this.belowSinceH >= this.policy.downgradeHoldHours) { this.level = target; this.belowSinceH = null; out.push(this._emit(tHours, "DOWNGRADE", {})); } }
        else this.belowSinceH = null;
      }
    }
    return out;
  }

  /** Bakım tamamlandı bildirimi (otonom yönetici çağırır). */
  notifyMaintenance(tHours, newSeDb) {
    this.kf.reset(newSeDb, true, this.sPrior);
    this.level = "NONE"; this.belowSinceH = null; this.lastEvalH = -Infinity;
    if (this.counter) this.counter = new E.ThermalCycleCounter(this.params.tc.minRangeC);
    return this._emit(tHours, "MAINTENANCE_DONE", { newSeDb });
  }
}

function actionFor(level, r) {
  const d = (x) => (Number.isFinite(x) ? `${x.toFixed(0)} gün` : "∞");
  if (level === "ADVISORY") return `Bakım PLANLA — kritik eşiğe muhafazakâr kalan ömür ${d(r.p10)} (medyan ${d(r.p50)})`;
  if (level === "WARNING") return `İş emri AÇ — conta/derz bakımı ${d(r.p10)} içinde yapılmalı`;
  return `ACİL müdahale — kalkan kritik eşiğe çok yakın (p10 ${d(r.p10)}); trafiği bu düğümden önceden kaydırmayı değerlendir`;
}

/**
 * Otonom bakım planlayıcı — uyarıları iş emrine çevirir.
 * ADVISORY → min(p10 − güvenlik, planlama ufku) içinde planlı bakım
 * WARNING  → ≤ warningDispatchDays; CRITICAL/STEP_CHANGE(düşüş) → ≤ urgentDispatchHours
 */
class MaintenanceScheduler {
  constructor({ advisoryLeadDays = 21, safetyDays = 7, warningDispatchDays = 3, urgentDispatchHours = 24 } = {}) {
    Object.assign(this, { advisoryLeadDays, safetyDays, warningDispatchDays, urgentDispatchHours });
    this.orders = new Map(); // nodeId → {dueH, reason}
    this.log = [];
  }
  consider(ev) {
    let dueH = null, reason = null;
    if (ev.kind === "ALERT" && ev.level === "ADVISORY") {
      const p10h = Number.isFinite(ev.rulDays.p10) ? ev.rulDays.p10 * 24 : Infinity;
      dueH = ev.atHours + Math.max(24, Math.min(this.advisoryLeadDays * 24, p10h - this.safetyDays * 24)); reason = "planlı (ADVISORY)";
    } else if (ev.kind === "ALERT" && ev.level === "WARNING") { dueH = ev.atHours + this.warningDispatchDays * 24; reason = "iş emri (WARNING)"; }
    else if ((ev.kind === "ALERT" && ev.level === "CRITICAL") || (ev.kind === "STEP_CHANGE" && ev.direction === "düşüş")) { dueH = ev.atHours + this.urgentDispatchHours; reason = ev.kind === "STEP_CHANGE" ? "muayene (ani değişim)" : "acil (CRITICAL)"; }
    if (dueH == null) return null;
    const cur = this.orders.get(ev.nodeId);
    if (!cur || dueH < cur.dueH) { const o = { nodeId: ev.nodeId, dueH, reason, fromEvent: ev.kind + ":" + ev.level }; this.orders.set(ev.nodeId, o); this.log.push({ ...o, atHours: ev.atHours }); return o; }
    return null;
  }
  due(nodeId, tHours) { const o = this.orders.get(nodeId); return o && tHours >= o.dueH ? o : null; }
  complete(nodeId) { this.orders.delete(nodeId); }
}

module.exports = { ALERT_LEVELS, DEFAULT_POLICY, ClimatologyExposure, DegradationKalman, PrognosticsMonitor, MaintenanceScheduler };
