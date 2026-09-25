#!/usr/bin/env node
"use strict";
/**
 * async_finite_sigma_estimator.js — correctionLog'dan (τ_k) beslenen,
 * VERİ TOPLAMAYI (senkron/hızlı) HESAPLAMADAN (asenkron/ayrı görev)
 * AYIRAN, sonlu-örneklem (Chebyshev — dağılımdan-bağımsız, HER n için
 * kanıtlanmış) VEYA asimptotik (CLT/Gauss-yaklaşık) güven aralıklarıyla
 * σ² pencere-tahmini üreten katman.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM/TÜRETİM: bkz. bb84/docs/ASYNC_FINITE_SIGMA_ESTIMATOR_DESIGN.md.
 * kalman_sigma_estimator.js'İN YERİNE DEĞİL, YANINA — TAMAMLAYICI bir
 * ikinci tahminci (bkz. DESIGN.md §6). Bu dosya kalman_sigma_estimator.js'i
 * import ETMEZ, ondan BAĞIMSIZDIR (ikisi AYNI buffer'a AYRI AYRI
 * zincirlenebilir).
 *
 * ÇEKİRDEĞE, quantum_phase_buffer.js'E VE correction_log_recorder.js'E
 * TEK SATIR DOKUNULMAZ. Bu dosya HİÇBİRİNİ require ETMEZ (çağıran
 * geçirir) — si3n4_pic_link_budget.js/kalman_sigma_estimator.js İLE
 * AYNI desen.
 *
 * KULLANIM (canlı/asenkron):
 *   const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: buffer.deltaMaxRad, windowSize: 20, epsilon: 0.05 });
 *   est.attachToBuffer(buffer);              // recorder/kalman'ın zincirini KAYBETMEDEN eklenir
 *   est.onEstimate = (snap) => console.log(snap.sigmaEstimate, snap.sigmaLowerBound, snap.sigmaUpperBound);
 *   // ... normal çalışma (push() SENKRON/hızlı; hesaplama AYRI bir setImmediate görevinde) ...
 *   await est.nextEstimate();                // BİR SONRAKİ pencere tamamlanana kadar bekler
 *
 * KULLANIM (geçmiş correctionLog'dan TOPLU):
 *   const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad, windowSize: 20 });
 *   replayCorrectionLog(est, recorder.correctionLog);
 *   await est.drain();                        // kuyruk boşalana/TÜM pencereler işlenene kadar bekler
 *   est.flush();                              // son (TAM DOLMAMIŞ) pencereyi de ZORLA raporla
 * ═══════════════════════════════════════════════════════════════════
 */

// ── kalman_sigma_estimator.js'te ÖLÇÜLEN sabitler — BURADA DA yeniden
// kullanılıyor (bkz. DESIGN.md §0/§7 — kapalı-form DEĞİL, Monte Carlo). ──
const DEFAULTS = Object.freeze({
  kBias: 1.80,
  measurementVarianceRatio: 0.78,
  windowSize: 20,
  defaultEpsilon: 0.05,
  method: "chebyshev", // 'chebyshev' | 'clt' — bkz. DESIGN.md §3.3 (fail-closed varsayılan)
});

/**
 * Standart normal yoğunluk — temel matematikten, EZBERLENMİŞ sabit YOK.
 */
function stdNormalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standart normal CDF — Simpson kuralıyla NÜMERİK İNTEGRAL (bkz.
 * DESIGN.md §3.2 — rasyonel-yaklaşım polinomu EZBERDEN YAZILMADI,
 * yalnızca temel calculus kullanıldı). [-8,x] aralığı (±8σ dışı ihmal
 * edilebilir — çift taraflı kuyruk olasılığı <1e-15).
 */
function stdNormalCDF(x) {
  if (x <= -8) return 0;
  if (x >= 8) return 1;
  const a = -8, b = x;
  const n = 2000; // çift sayı — Simpson kuralı gereği
  const h = (b - a) / n;
  let sum = stdNormalPdf(a) + stdNormalPdf(b);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * stdNormalPdf(a + i * h);
  }
  return (h / 3) * sum;
}

/**
 * Standart normal ters-CDF — ikili-arama (bisection) ile stdNormalCDF'i
 * TERS ÇEVİRİR. p: (0,1) aralığında, Φ(z)=p olacak z döner.
 */
function normInvCDF(p) {
  if (!(p > 0) || !(p < 1)) throw new RangeError("normInvCDF: p (0,1) aralığında olmalı.");
  let lo = -8, hi = 8;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (stdNormalCDF(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** İki-taraflı kritik değer: P(|Z|>zCrit)=epsilon ⟹ zCrit=Φ⁻¹(1−ε/2). */
function zCritTwoSided(epsilon) {
  if (!(epsilon > 0) || epsilon >= 1) throw new RangeError("zCritTwoSided: epsilon (0,1) aralığında olmalı.");
  return normInvCDF(1 - epsilon / 2);
}

/**
 * Chebyshev yarı-genişliği — DAĞILIMDAN BAĞIMSIZ, HER n için kanıtlanmış
 * (bkz. DESIGN.md §3.1). P(|Z̄−σ²|≥h)≤ε GARANTİLİDİR (σ² için plug-in
 * sigma2Hat kullanılır).
 */
function chebyshevHalfWidth(sigma2Hat, n, v, epsilon) {
  if (!(sigma2Hat > 0)) throw new RangeError("chebyshevHalfWidth: sigma2Hat>0 olmalı.");
  if (!(n > 0)) throw new RangeError("chebyshevHalfWidth: n>0 olmalı.");
  if (!(v > 0)) throw new RangeError("chebyshevHalfWidth: v>0 olmalı.");
  if (!(epsilon > 0) || epsilon >= 1) throw new RangeError("chebyshevHalfWidth: epsilon (0,1) aralığında olmalı.");
  return sigma2Hat * Math.sqrt(v / (n * epsilon));
}

/**
 * CLT/Gauss-yaklaşık yarı-genişliği — ASİMPTOTİK (bkz. DESIGN.md §3.2/
 * §3.3 — küçük n VE küçük epsilon'da GÜVENİLMEZ, ÖLÇÜLDÜ).
 */
function cltHalfWidth(sigma2Hat, n, v, epsilon) {
  if (!(sigma2Hat > 0)) throw new RangeError("cltHalfWidth: sigma2Hat>0 olmalı.");
  if (!(n > 0)) throw new RangeError("cltHalfWidth: n>0 olmalı.");
  if (!(v > 0)) throw new RangeError("cltHalfWidth: v>0 olmalı.");
  return zCritTwoSided(epsilon) * sigma2Hat * Math.sqrt(v / n);
}

/**
 * CLT yönteminin AMPİRİK OLARAK DOĞRULANDIĞI rejimde mi (bkz. DESIGN.md
 * §3.3 — N≥1/ε ampirik eşiği, YALNIZCA test edilen aralıkta geçerli).
 */
function isCltWindowValidated(n, epsilon) {
  return n >= 1 / epsilon;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Veri toplamayı (push, senkron/hızlı) hesaplamadan (tick, asenkron/
 * setImmediate) AYIRAN pencereli σ² tahminci — bkz. DESIGN.md §4.
 */
class AsyncFiniteSigmaEstimator {
  /**
   * @param opts.deltaMaxRad — buffer'ın KENDİ eşiği (τ→σ² dönüşümü için gerekli)
   * @param opts.windowSize — pencere boyutu N (bkz. DEFAULTS)
   * @param opts.epsilon — hedef ihlal olasılığı (bkz. DEFAULTS)
   * @param opts.method — 'chebyshev' (varsayılan, HER zaman geçerli) | 'clt' (asimptotik)
   * @param opts.allowUnverifiedClt — method:'clt' VE N<1/epsilon iken bile ZORLA izin ver (bkz. DESIGN.md §3.3)
   * @param opts.kBias,measurementVarianceRatio — bkz. DEFAULTS (kalman_sigma_estimator.js'ten miras)
   * @param opts.onEstimate — her pencere tamamlandığında çağrılan kanca(snapshot)
   */
  constructor(opts = {}) {
    if (!(opts.deltaMaxRad > 0)) throw new RangeError("AsyncFiniteSigmaEstimator: opts.deltaMaxRad gerekli ve >0 olmalı.");
    this.deltaMaxRad = opts.deltaMaxRad;
    this.kBias = opts.kBias ?? DEFAULTS.kBias;
    this.v = opts.measurementVarianceRatio ?? DEFAULTS.measurementVarianceRatio;
    this.windowSize = opts.windowSize ?? DEFAULTS.windowSize;
    if (!(this.windowSize >= 1)) throw new RangeError("AsyncFiniteSigmaEstimator: opts.windowSize >=1 olmalı.");
    this.epsilon = opts.epsilon ?? DEFAULTS.defaultEpsilon;
    if (!(this.epsilon > 0) || this.epsilon >= 1) throw new RangeError("AsyncFiniteSigmaEstimator: opts.epsilon (0,1) aralığında olmalı.");
    this.method = opts.method ?? DEFAULTS.method;
    if (this.method !== "chebyshev" && this.method !== "clt") throw new RangeError("AsyncFiniteSigmaEstimator: opts.method 'chebyshev' veya 'clt' olmalı.");
    this.allowUnverifiedClt = opts.allowUnverifiedClt ?? false;
    this.onEstimate = opts.onEstimate || null;

    this._queue = [];
    this._currentWindow = [];
    this._latestSnapshot = null;
    this._stopped = false;
    this._scheduled = false;
    this._waiters = [];
    this.history = [];
    this.maxHistoryEntries = opts.maxHistoryEntries ?? 10000;

    this._priorOnCorrection = null;
    this._attachedLastCorrectionTS = null;
  }

  /**
   * TEK bir τ_k örneğini kuyruğa ekler — SENKRON, HIZLI, hesaplama
   * YAPMAZ (bkz. DESIGN.md §4). Gerçek hesaplama SONRAKİ asenkron
   * tick'e bırakılır.
   */
  push({ tau, tS }) {
    if (this._stopped) return;
    if (tau == null || !(tau > 0)) return;
    this._queue.push({ tau, tS });
    if (!this._scheduled) this._scheduleTick();
  }

  _scheduleTick() {
    if (this._stopped) return;
    this._scheduled = true;
    setImmediate(() => {
      this._scheduled = false;
      this._tick();
    });
  }

  /**
   * ASENKRON: kuyruktaki HER örneği z'ye çevirir, pencereye ekler.
   * ÖNEMLİ (bkz. DESIGN.md §4 — GERÇEK bulgu, testte YAKALANDI):
   * `_completeWindow()`'un fırlattığı bir hata (ör. fail-closed CLT
   * doğrulama hatası), bu fonksiyon BİR setImmediate GERİ ÇAĞIRMASI
   * İÇİNDE çalıştığından, çağıranın SENKRON try/catch'iyle
   * YAKALANAMAZ — process'i ÇÖKERTİR. Bu yüzden burada YAKALANIP
   * nextEstimate()/onError ARACILIĞIYLA (Promise reddi) TESLİM EDİLİR.
   */
  _tick() {
    if (this._stopped) return;
    while (this._queue.length) {
      const { tau, tS } = this._queue.shift();
      const z = (this.deltaMaxRad * this.deltaMaxRad) / (tau * this.kBias);
      this._currentWindow.push({ z, tS });
      if (this._currentWindow.length >= this.windowSize) {
        try {
          this._completeWindow();
        } catch (err) {
          this._deliverError(err);
          break; // bu tick'i durdur — kalan kuyruk öğeleri SONRAKİ push()'a bırakılır
        }
      }
    }
    // Kuyruk boşaldı — YENİDEN planlama YOK (CPU'yu boşa YAKMAZ, bkz. DESIGN.md §4).
    // push() bir dahaki örnekte kendi tick'ini yeniden planlayacak.
  }

  _deliverError(err) {
    if (this.onError) this.onError(err);
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.reject(err);
  }

  _completeWindow() {
    const entries = this._currentWindow;
    this._currentWindow = [];
    const n = entries.length;
    const zs = entries.map((e) => e.z);
    const sigma2Estimate = mean(zs);

    let halfWidth, methodUsed;
    if (this.method === "chebyshev") {
      halfWidth = chebyshevHalfWidth(sigma2Estimate, n, this.v, this.epsilon);
      methodUsed = "chebyshev";
    } else {
      const validated = isCltWindowValidated(n, this.epsilon);
      if (!validated && !this.allowUnverifiedClt) {
        throw new RangeError(
          `AsyncFiniteSigmaEstimator: CLT yöntemi n=${n}, epsilon=${this.epsilon} için AMPİRİK OLARAK DOĞRULANMADI ` +
          `(bkz. ASYNC_FINITE_SIGMA_ESTIMATOR_DESIGN.md §3.3, ampirik eşik N>=1/epsilon=${(1 / this.epsilon).toFixed(1)}) — ` +
          `opts.allowUnverifiedClt:true ile ZORLA geçebilirsiniz VEYA method:'chebyshev' kullanın.`
        );
      }
      halfWidth = cltHalfWidth(sigma2Estimate, n, this.v, this.epsilon);
      methodUsed = validated ? "clt" : "clt-unverified";
    }

    const sigma2Lower = Math.max(0, sigma2Estimate - halfWidth);
    const sigma2Upper = sigma2Estimate + halfWidth;
    const snapshot = {
      tS: entries[entries.length - 1].tS,
      windowSize: n,
      method: methodUsed,
      epsilon: this.epsilon,
      sigma2Estimate,
      sigmaEstimate: Math.sqrt(sigma2Estimate),
      sigma2LowerBound: sigma2Lower,
      sigma2UpperBound: sigma2Upper,
      sigmaLowerBound: Math.sqrt(sigma2Lower),
      sigmaUpperBound: Math.sqrt(sigma2Upper),
    };
    this._latestSnapshot = snapshot;
    this.history.push(snapshot);
    if (this.history.length > this.maxHistoryEntries) this.history.splice(0, this.history.length - this.maxHistoryEntries);

    if (this.onEstimate) this.onEstimate(snapshot);
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.resolve(snapshot);
  }

  /** Şu ana kadar üretilen SON pencere sonucu (yoksa null). */
  latestSnapshot() {
    return this._latestSnapshot;
  }

  /**
   * BİR SONRAKİ pencere tamamlandığında çözülen (VEYA doğrulama hatası
   * olursa REDDEDİLEN — bkz. _deliverError) Promise — asenkron
   * mimariyi test etmek/beklemek için (bkz. DESIGN.md §4).
   */
  nextEstimate() {
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /**
   * Kuyrukta bekleyen TÜM örnekler işlenip pencereye/pencerelere
   * aktarılana kadar bekler (TOPLU/replay kullanımı için — bkz.
   * DESIGN.md §4).
   */
  drain() {
    return new Promise((resolve) => {
      const check = () => {
        if (this._stopped || (this._queue.length === 0 && !this._scheduled)) resolve();
        else setImmediate(check);
      };
      setImmediate(check);
    });
  }

  /**
   * Tam dolmamış (n<windowSize) mevcut pencereyi ZORLA tamamlar —
   * formüller GERÇEK n'i kullandığından matematiksel olarak GEÇERLİ
   * kalır (bkz. DESIGN.md §4), sadece daha GENİŞ bir aralık üretir.
   * @returns {object|null} yeni snapshot, ya da null (pencere boşsa)
   */
  flush() {
    if (this._currentWindow.length === 0) return null;
    this._completeWindow();
    return this._latestSnapshot;
  }

  /** Asenkron döngüyü durdurur — dangling setImmediate KALMAZ. */
  stop() {
    this._stopped = true;
  }

  /**
   * `buffer.onCorrection`'ı (ZATEN var olan enjeksiyon noktası) BİR
   * KEZ DAHA zincirler — önceki zincirlenmiş kancaları (CorrectionLogRecorder,
   * KalmanSigmaEstimator, ...) KAYBETMEDEN.
   */
  attachToBuffer(buffer) {
    if (!buffer || typeof buffer.tickPulse !== "function") {
      throw new TypeError("attachToBuffer: 'buffer' bir QuantumPhaseBuffer örneği olmalı.");
    }
    this._priorOnCorrection = buffer.onCorrection || null;
    buffer.onCorrection = (info) => {
      if (this._priorOnCorrection) this._priorOnCorrection(info);
      const tau = this._attachedLastCorrectionTS == null ? null : info.tS - this._attachedLastCorrectionTS;
      this._attachedLastCorrectionTS = info.tS;
      this.push({ tau, tS: info.tS });
    };
    return this;
  }
}

/**
 * Bir `CorrectionLogRecorder.correctionLog` dizisini (GEÇMİŞ veri)
 * SIRAYLA `push()`'a besler — TOPLU/ısındırma kullanımı için (bkz.
 * kalman_sigma_estimator.js'in AYNI adlı fonksiyonu — BURADA push()
 * ASENKRON olduğundan, çağıran `await estimator.drain()` ile
 * TÜMÜNÜN işlenmesini beklemelidir).
 */
function replayCorrectionLog(estimator, correctionLog) {
  for (const entry of correctionLog) {
    estimator.push({ tau: entry.sinceLastCorrectionS, tS: entry.tS });
  }
}

module.exports = {
  DEFAULTS,
  stdNormalPdf,
  stdNormalCDF,
  normInvCDF,
  zCritTwoSided,
  chebyshevHalfWidth,
  cltHalfWidth,
  isCltWindowValidated,
  AsyncFiniteSigmaEstimator,
  replayCorrectionLog,
};
