#!/usr/bin/env node
"use strict";
/**
 * correction_log_recorder.js — Kuantum Buffer'ın (`quantum_phase_buffer.js`)
 * analog simülasyon çıktılarını (biriken faz hatası ölçümleri, düzeltme
 * olayları) SINIRLI BELLEKLE, DENETLENEBİLİR bir şemayla loglayan ve
 * AYRIK-ÖRNEKLEMENİN kaçırabileceği eşik-aşımlarını (aliasing) tespit eden
 * kayıtçı.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM: bkz. bb84/docs/CORRECTION_LOG_RECORDER_DESIGN.md — bu dosya o
 * tasarımın hesaplanabilir/test edilebilir kısmıdır.
 *
 * ÇEKİRDEĞE VE quantum_phase_buffer.js'E TEK SATIR DOKUNULMAZ. Bu dosya
 * ikisini de require ETMEZ (çağıran taraf require edip geçirir) —
 * si3n4_pic_link_budget.js / decoy_state_protocol.js ile AYNI desen.
 * `attachToBuffer(buffer)`, `QuantumPhaseBuffer`'ın ZATEN VAR OLAN
 * `onCorrection` enjeksiyon noktasını kullanır (yeni bir hook İCAT
 * EDİLMEZ) — önceki bir onCorrection varsa ZİNCİRLEME çağrılır.
 *
 * KULLANIM:
 *   const { QuantumPhaseBuffer } = require("./quantum_phase_buffer.js");
 *   const { CorrectionLogRecorder, runPhaseBufferWithRecording } = require("./correction_log_recorder.js");
 *   const buffer = new QuantumPhaseBuffer({ ... });
 *   const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
 *   recorder.attachToBuffer(buffer);
 *   runPhaseBufferWithRecording(buffer, recorder, 100000, 1e-6);
 *   const health = recorder.analyzeCalibrationHealth({ sigmaRadPerSqrtS: 0.03 });
 * ═══════════════════════════════════════════════════════════════════
 */

const DEFAULTS = Object.freeze({
  maxExcursionLogEntries: 10000, // §6 dürüstlük notu: sınırsız büyümeyi önleyen basit FIFO budama
  // §3.2'de ÖLÇÜLEN aliasing yanlılığı ~%1-5 mertebesindeydi — bu eşik
  // KASITLI OLARAK ondan BÜYÜKTÜR (bir büyüklük mertebesi üstü) ki normal
  // örnekleme yanlılığı YANLIŞ-POZİTİF bir "kalibrasyon-dışı" uyarısı
  // ÜRETMESİN — bkz. tasarım belgesi §3.2.
  calibrationHealthRatioThreshold: 3.0,
});

/**
 * σ ve δ_max verilen bir Kuantum Buffer için, beklenen (sürekli-izlemeli
 * yaklaşım) düzeltme-arası ortalama süre — bkz. tasarım belgesi §3.1.
 * E[τ] = δ_max²/σ² (sürüklenmesiz Wiener sürecinin ±δ_max bariyerine
 * ilk-geçiş-zamanı MFPT'si, 0'dan başlayarak).
 */
function expectedCorrectionIntervalS(sigmaRadPerSqrtS, deltaMaxRad) {
  if (!(sigmaRadPerSqrtS > 0) || !(deltaMaxRad > 0)) {
    throw new RangeError("expectedCorrectionIntervalS: sigmaRadPerSqrtS ve deltaMaxRad sıfırdan büyük olmalı.");
  }
  return (deltaMaxRad * deltaMaxRad) / (sigmaRadPerSqrtS * sigmaRadPerSqrtS);
}

/**
 * Kuantum Buffer'a DIŞARIDAN takılan kayıtçı — bkz. tasarım belgesi §2/§4.
 */
class CorrectionLogRecorder {
  /**
   * @param opts.correctionIntervalS — buffer'ın KENDİ correctionIntervalS'i (aliasing/eşleştirme toleransı için)
   * @param opts.deltaMaxRad — buffer'ın KENDİ eşiği (excursion tespiti için)
   * @param opts.maxExcursionLogEntries — bkz. DEFAULTS
   */
  constructor(opts = {}) {
    if (!(opts.correctionIntervalS > 0)) throw new RangeError("CorrectionLogRecorder: opts.correctionIntervalS gerekli ve >0 olmalı.");
    if (!(opts.deltaMaxRad > 0)) throw new RangeError("CorrectionLogRecorder: opts.deltaMaxRad gerekli ve >0 olmalı.");
    this.correctionIntervalS = opts.correctionIntervalS;
    this.deltaMaxRad = opts.deltaMaxRad;
    this.maxExcursionLogEntries = opts.maxExcursionLogEntries ?? DEFAULTS.maxExcursionLogEntries;

    this.correctionLog = []; // versiyonlanmış, zenginleştirilmiş kayıtlar — bkz. tasarım §2
    this.excursionLog = []; // {startTS, endTS, peakAbsDeltaRad, caught} — bkz. tasarım §4
    this._seq = 0;
    this._lastCorrectionTS = null;
    this._openExcursion = null; // {startTS, peakAbsDeltaRad} | null — O(1) bellek, pulseLog TUTULMAZ
    this._pendingCorrectionsSinceOpen = []; // açık aşım penceresinde loglanan correctionLog.tS'leri (küçük, geçici)
    this._priorOnCorrection = null;
    this._attachedBuffer = null;
  }

  /** buffer.onCorrection'ı (ZATEN VAR OLAN enjeksiyon noktası) kendine yönlendirir — zincirleme korunur. */
  attachToBuffer(buffer) {
    if (!buffer || typeof buffer.tickPulse !== "function" || typeof buffer.maybeCorrect !== "function") {
      throw new TypeError("attachToBuffer: 'buffer' bir QuantumPhaseBuffer örneği olmalı (tickPulse+maybeCorrect).");
    }
    this._priorOnCorrection = buffer.onCorrection || null;
    this._attachedBuffer = buffer;
    buffer.onCorrection = (info) => {
      if (this._priorOnCorrection) this._priorOnCorrection(info);
      this._handleCorrection(info);
    };
    return this;
  }

  _handleCorrection(info) {
    const sinceLastCorrectionS = this._lastCorrectionTS == null ? null : info.tS - this._lastCorrectionTS;
    const exceedRatio = Math.abs(info.measuredDeltaRad) / this.deltaMaxRad;
    this.correctionLog.push({
      schemaVersion: 1,
      seq: this._seq++,
      tS: info.tS,
      measuredDeltaRad: info.measuredDeltaRad, // HAM — buffer'dan DEĞİŞTİRİLMEDEN
      deltaMaxRad: this.deltaMaxRad,             // HAM
      exceedRatio,                               // türetilmiş, YENİDEN HESAPLANABİLİR (measuredDeltaRad/deltaMaxRad)
      sinceLastCorrectionS,
    });
    this._lastCorrectionTS = info.tS;
    // Açık bir aşım varsa, bu düzeltme onu "yakaladı" — kapanışta kullanılacak.
    if (this._openExcursion) this._pendingCorrectionsSinceOpen.push(info.tS);
  }

  /**
   * Her `tickPulse()` sonrası çağrılır (bkz. runPhaseBufferWithRecording).
   * `pulseLog`'un TAMAMINI SAKLAMAZ — yalnızca O(1) "açık aşım" durumunu
   * tutar (bkz. tasarım §2/§4). rec: {tS, held, deltaAtEncode} (QuantumPhaseBuffer.tickPulse'un döndürdüğü ile AYNI şekil, +tS).
   */
  recordPulse(rec) {
    const absDelta = Math.abs(rec.deltaAtEncode);
    const exceeds = absDelta > this.deltaMaxRad;
    if (exceeds) {
      if (!this._openExcursion) {
        this._openExcursion = { startTS: rec.tS, peakAbsDeltaRad: absDelta };
        this._pendingCorrectionsSinceOpen = [];
      } else if (absDelta > this._openExcursion.peakAbsDeltaRad) {
        this._openExcursion.peakAbsDeltaRad = absDelta;
      }
    } else if (this._openExcursion) {
      // Aşım kapandı (δ eşiğin altına döndü) — bu pencerede bir düzeltme LOGLANDI mı?
      const caught = this._pendingCorrectionsSinceOpen.length > 0;
      this._pushExcursion({
        startTS: this._openExcursion.startTS,
        endTS: rec.tS,
        peakAbsDeltaRad: this._openExcursion.peakAbsDeltaRad,
        caught,
      });
      this._openExcursion = null;
      this._pendingCorrectionsSinceOpen = [];
    }
  }

  _pushExcursion(e) {
    this.excursionLog.push(e);
    if (this.excursionLog.length > this.maxExcursionLogEntries) {
      this.excursionLog.splice(0, this.excursionLog.length - this.maxExcursionLogEntries); // basit FIFO budama — bkz. tasarım §6
    }
  }

  /**
   * Kayıtlı correctionLog'un GÖZLENEN ortalama düzeltme-arası süresini,
   * TEORİK (§3.1) E[τ]=δ_max²/σ² ile karşılaştırır. Bkz. tasarım §3.2:
   * gözlenenin teorikten biraz BÜYÜK olması (AYRIK örnekleme yanlılığı)
   * NORMALDİR — yalnızca calibrationHealthRatioThreshold'u aşan bir sapma
   * işaretlenir.
   */
  analyzeCalibrationHealth({ sigmaRadPerSqrtS }) {
    const theoreticalS = expectedCorrectionIntervalS(sigmaRadPerSqrtS, this.deltaMaxRad);
    const intervals = this.correctionLog.map((c) => c.sinceLastCorrectionS).filter((x) => x != null);
    if (intervals.length === 0) {
      return { theoreticalS, observedMeanS: null, ratio: null, sampleCount: 0, flagged: false, reason: "yeterli düzeltme olayı yok (en az 2 düzeltme gerekli)" };
    }
    const observedMeanS = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const ratio = observedMeanS / theoreticalS;
    const flagged = ratio > DEFAULTS.calibrationHealthRatioThreshold || ratio < 1 / DEFAULTS.calibrationHealthRatioThreshold;
    return {
      theoreticalS, observedMeanS, ratio, sampleCount: intervals.length, flagged,
      reason: flagged
        ? `gözlenen/teorik=${ratio.toFixed(2)} — beklenen aliasing-yanlılığı aralığının (§3.2, ~1.0-1.1) ÇOK dışında, kalibrasyon-dışı OLABİLİR`
        : null,
    };
  }

  /** correctionLog'u NDJSON (satır-ayrımlı JSON) dizesine çevirir — bkz. tasarım §2. */
  toNdjsonLines() {
    return this.correctionLog.map((r) => JSON.stringify(r)).join("\n") + (this.correctionLog.length ? "\n" : "");
  }

  /** Gerçekten diske yazar (Node fs) — isteğe bağlı, çağrılmazsa hiçbir I/O olmaz. */
  flushToFile(filePath, { append = true } = {}) {
    const fs = require("fs");
    const data = this.toNdjsonLines();
    if (append) fs.appendFileSync(filePath, data);
    else fs.writeFileSync(filePath, data);
    return { bytesWritten: Buffer.byteLength(data), lineCount: this.correctionLog.length };
  }

  snapshot() {
    return {
      correctionCount: this.correctionLog.length,
      excursionCount: this.excursionLog.length,
      missedExcursionCount: this.excursionLog.filter((e) => !e.caught).length,
      openExcursion: this._openExcursion ? { ...this._openExcursion } : null,
    };
  }
}

/**
 * quantum_phase_buffer.js'in KENDİ `runPhaseBuffer`'ının YANINA eklenen
 * sarmalayıcı — AYNI döngü mantığını (tickPulse+maybeCorrect) tekrarlar,
 * TEK fark: her tick sonrası recorder.recordPulse(rec) de çağrılır.
 * `runPhaseBuffer`'ın KENDİSİ değiştirilmedi, bu AYRI bir fonksiyondur.
 */
function runPhaseBufferWithRecording(buffer, recorder, pulseCount, pulsePeriodS) {
  const log = [];
  for (let i = 0; i < pulseCount; i++) {
    const r = buffer.tickPulse(pulsePeriodS);
    // ÖNEMLİ SIRALAMA (kendi testinde yakalanan gerçek bir hata — bkz. commit
    // mesajı): recordPulse, maybeCorrect'TEN ÖNCE çağrılmalı. maybeCorrect()
    // TAM OLARAK bu darbenin (r.deltaAtEncode) δ'sini eşiğe karşı kontrol
    // eder — eğer recordPulse SONRA çağrılırsa, bu darbenin excursion'ı HENÜZ
    // açılmadan düzeltme zaten tetiklenmiş olur ve _handleCorrection onu asla
    // "yakalanmış" olarak işaretleyemez (her olay YANLIŞLIKLA "kaçırıldı"
    // görünür). recordPulse ÖNCE çağrılınca, excursion açılır/güncellenir,
    // SONRA maybeCorrect() AYNI δ değerini kontrol eder — düzeltme olursa
    // _handleCorrection açık excursion'ı GERÇEKTEN görür.
    recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
    buffer.maybeCorrect();
    log.push(r);
  }
  return log;
}

module.exports = {
  DEFAULTS,
  expectedCorrectionIntervalS,
  CorrectionLogRecorder,
  runPhaseBufferWithRecording,
};
