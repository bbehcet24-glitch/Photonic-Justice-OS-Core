#!/usr/bin/env node
"use strict";
/**
 * kalman_sigma_estimator.js — Kuantum Buffer'ın `correctionLog`'undan
 * (bkz. correction_log_recorder.js) beslenen, canlı donanım sürüklenmesini
 * (σ) anlık olarak yeniden tahmin eden skaler Kalman Filtresi.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM/TÜRETİM: bkz. bb84/docs/KALMAN_SIGMA_ESTIMATOR_DESIGN.md — bu
 * dosya o belgenin §3 (Jensen yanlılığı + düzeltme) + §4 (Kalman
 * denklemleri) + §5 (correctionLog entegrasyonu) bölümlerinin
 * ÇALIŞTIRILABİLİR hâlidir.
 *
 * ÇEKİRDEĞE, quantum_phase_buffer.js'E VE correction_log_recorder.js'E
 * TEK SATIR DOKUNULMAZ. Bu dosya İKİSİNİ DE require ETMEZ (çağıran
 * geçirir/zaten elinde bulundurur) — si3n4_pic_link_budget.js ile AYNI
 * desen. `attachToBuffer`, `QuantumPhaseBuffer`'ın ZATEN VAR OLAN
 * `onCorrection` enjeksiyon noktasını (CorrectionLogRecorder'ın da
 * kullandığı AYNI kanca) BİR KEZ DAHA zincirler.
 *
 * KULLANIM (canlı/anlık):
 *   const { QuantumPhaseBuffer } = require("./quantum_phase_buffer.js");
 *   const { CorrectionLogRecorder } = require("./correction_log_recorder.js");
 *   const { KalmanSigmaEstimator } = require("./kalman_sigma_estimator.js");
 *   const buffer = new QuantumPhaseBuffer({ ... });
 *   const recorder = new CorrectionLogRecorder({ ... });
 *   recorder.attachToBuffer(buffer);           // ÖNCE recorder zincirlenir
 *   const kalman = new KalmanSigmaEstimator({ deltaMaxRad: buffer.deltaMaxRad, initialSigmaRadPerSqrtS: 0.03 });
 *   kalman.attachToBuffer(buffer);             // SONRA kalman ZİNCİRE EKLENİR (recorder'ı ETKİLEMEZ)
 *   // ... normal çalışma ...
 *   console.log(kalman.sigmaEstimate(), kalman.sigmaUncertainty());
 *
 * KULLANIM (geçmiş correctionLog'dan ISINDIRMA):
 *   const kalman = new KalmanSigmaEstimator({ deltaMaxRad, initialSigmaRadPerSqrtS: 0.03 });
 *   replayCorrectionLog(kalman, recorder.correctionLog);
 * ═══════════════════════════════════════════════════════════════════
 */

// ── Monte Carlo ile ÖLÇÜLEN evrensel sabitler — bkz. DESIGN.md §3.2/§4.2 ──
const DEFAULTS = Object.freeze({
  kBias: 1.80, // E[δmax²/τ] / gerçek-σ² yanlılık çarpanı (Jensen eşitsizliği, düzeltme)
  measurementVarianceRatio: 0.78, // Var[δmax²/(τ·kBias)] / gerçek-σ⁴
  processNoiseRelRate: 0.05, // gerekçelendirilmiş ama ÖLÇÜLMEMİŞ — bkz. DESIGN.md §4.1/§8
  initialVarianceMultiplier: 4, // başlangıç belirsizliği — (initialSigma²)²×bu çarpan
});

/**
 * Kuantum Buffer'ın correctionLog'undan (τ_k = düzeltme-arası süre)
 * beslenen skaler Kalman Filtresi — durum: x=σ² (rad²/s).
 */
class KalmanSigmaEstimator {
  /**
   * @param opts.deltaMaxRad — buffer'ın KENDİ eşiği (τ→σ² dönüşümü için gerekli)
   * @param opts.initialSigmaRadPerSqrtS — başlangıç σ tahmini (ör. YAPILANDIRILMIŞ/nominal değer)
   * @param opts.processNoiseRelRate,kBias,measurementVarianceRatio,initialVarianceMultiplier — bkz. DEFAULTS
   */
  constructor(opts = {}) {
    if (!(opts.deltaMaxRad > 0)) throw new RangeError("KalmanSigmaEstimator: opts.deltaMaxRad gerekli ve >0 olmalı.");
    if (!(opts.initialSigmaRadPerSqrtS > 0)) throw new RangeError("KalmanSigmaEstimator: opts.initialSigmaRadPerSqrtS gerekli ve >0 olmalı.");
    this.deltaMaxRad = opts.deltaMaxRad;
    this.kBias = opts.kBias ?? DEFAULTS.kBias;
    this.measurementVarianceRatio = opts.measurementVarianceRatio ?? DEFAULTS.measurementVarianceRatio;
    this.processNoiseRelRate = opts.processNoiseRelRate ?? DEFAULTS.processNoiseRelRate;

    this.x = opts.initialSigmaRadPerSqrtS * opts.initialSigmaRadPerSqrtS; // durum: σ²
    this.P = this.x * this.x * (opts.initialVarianceMultiplier ?? DEFAULTS.initialVarianceMultiplier);
    this.lastTS = null;
    this.updateCount = 0;
    this.history = []; // bkz. snapshot() — bounded, correctionLog'un KENDİSİ kadar (nadir olay) büyür
    this.maxHistoryEntries = opts.maxHistoryEntries ?? 10000;

    this._priorOnCorrection = null;
    this._attachedLastCorrectionTS = null;
  }

  /**
   * TEK bir τ_k (düzeltme-arası süre, saniye) ölçümüyle güncelleme —
   * bkz. DESIGN.md §3.3 (yanlılık düzeltmesi) + §4.3 (Kalman denklemleri).
   * @param {{tau:number|null, tS:number}} p — tau=null ise (ör. İLK düzeltme, önceki referans yok) ATLANIR.
   * @returns {object|null} güncelleme kaydı, ya da null (atlandıysa)
   */
  update({ tau, tS }) {
    if (tau == null || !(tau > 0)) return null;
    const dtReal = this.lastTS == null ? 0 : Math.max(0, tS - this.lastTS);

    // ── Öngörü (predict) — bkz. DESIGN.md §4.1 ──
    const Qprocess = Math.pow(this.processNoiseRelRate * this.x, 2) * dtReal;
    const xPred = this.x;
    const PPred = this.P + Qprocess;

    // ── Ölçüm (measurement) — bkz. DESIGN.md §3.3/§4.2 ──
    const z = (this.deltaMaxRad * this.deltaMaxRad) / (tau * this.kBias); // Jensen-DÜZELTİLMİŞ σ² ölçümü
    const R = this.measurementVarianceRatio * xPred * xPred;

    // ── Güncelleme (update) — bkz. DESIGN.md §4.3 ──
    const K = PPred / (PPred + R);
    const innovation = z - xPred;
    const xNew = Math.max(1e-12, xPred + K * innovation); // pozitiflik güvencesi (varyans negatif OLAMAZ)
    const PNew = (1 - K) * PPred;

    this.x = xNew; this.P = PNew; this.lastTS = tS; this.updateCount++;
    const rec = { tS, tau, z, xPred, xNew, PPred, PNew, kalmanGain: K, sigmaEstimate: Math.sqrt(xNew) };
    this.history.push(rec);
    if (this.history.length > this.maxHistoryEntries) this.history.splice(0, this.history.length - this.maxHistoryEntries);
    return rec;
  }

  /** Şu anki σ tahmini (rad/√s). */
  sigmaEstimate() { return Math.sqrt(this.x); }

  /**
   * σ tahmininin belirsizliği (std) — delta-yöntemiyle: Var[√x] ≈ P/(4x)
   * (√x'in x'e göre türevi 1/(2√x) olduğundan, Var[f(x)]≈f'(x)²·Var[x]).
   */
  sigmaUncertainty() {
    if (this.x <= 0) return NaN;
    return Math.sqrt(this.P) / (2 * Math.sqrt(this.x));
  }

  snapshot() {
    return {
      sigmaEstimate: this.sigmaEstimate(),
      sigmaUncertainty: this.sigmaUncertainty(),
      varianceEstimate: this.x,
      varianceCovariance: this.P,
      updateCount: this.updateCount,
    };
  }

  /**
   * `buffer.onCorrection`'ı (ZATEN var olan enjeksiyon noktası — bkz.
   * DESIGN.md §5) BİR KEZ DAHA zincirler — `CorrectionLogRecorder.
   * attachToBuffer`'ın ÖNCEDEN zincirlediği kancayı KAYBETMEDEN. τ_k'yı
   * KENDİ BAŞINA (ardışık `info.tS` farkından) hesaplar.
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
      this.update({ tau, tS: info.tS });
    };
    return this;
  }
}

/**
 * Bir `CorrectionLogRecorder.correctionLog` dizisini (GEÇMİŞ veri) SIRAYLA
 * besler — ISINDIRMA (warm-start) için. `entry.sinceLastCorrectionS`
 * ALANI ZATEN τ_k'dır (bkz. correction_log_recorder.js, DEĞİŞTİRİLMEDEN)
 * — bu fonksiyon o dosyaya HİÇ dokunmaz, sadece ÇIKTISINI okur.
 */
function replayCorrectionLog(estimator, correctionLog) {
  const updates = [];
  for (const entry of correctionLog) {
    const rec = estimator.update({ tau: entry.sinceLastCorrectionS, tS: entry.tS });
    if (rec) updates.push(rec);
  }
  return updates;
}

module.exports = {
  DEFAULTS,
  KalmanSigmaEstimator,
  replayCorrectionLog,
};
