#!/usr/bin/env node
"use strict";
/**
 * quantum_phase_buffer.js — Si₃N₄ PIC'in termo-optik faz kaydırıcısındaki
 * BİRİKEN faz hatasını (δ) izleyen ve eşik aşılınca darbeleri fail-closed
 * olarak TUTAN/damgalayan "Kuantum Buffer" mantığı.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM: bkz. bb84/docs/QUANTUM_PHASE_BUFFER_DESIGN.md — bu dosya o
 * tasarımın hesaplanabilir/test edilebilir kısmıdır (bb84/si3n4_pic_link_budget.js'in
 * SI3N4_PIC_DESIGN.md ile ilişkisiyle AYNI desen).
 *
 * NEDEN "TAMPON" (buffer): termo-optik ısıtıcının fiziksel yanıt süresi
 * (10-100μs, SI3N4_PIC_DESIGN.md §5) MHz-sınıfı darbe hızından ÇOK YAVAŞ
 * — düzeltme fırsatları arasında YÜZLERCE darbe geçer. Çözüm "daha hızlı
 * düzelt" değil: ölçülen faz hatası toleransı AŞTIĞINDA, düzeltme
 * TAMAMLANANA kadar gelen darbeleri KODLAMADAN TUT (fail-closed) — hatalı
 * fazla SESSİZCE kodlamaya devam ETME. Bu, projenin genel fail-closed
 * disipliniyle (qrng_hardware_bridge.js, mtls_handshake_qrng_sync.js)
 * TUTARLIDIR.
 *
 * NEDEN EpochResetController'DAN AYRI BİR MODÜL: EpochResetController
 * SABİT zaman aralığında (30 gün) tetiklenen DİJİTAL bir sayaç
 * disiplinidir. Bu modül ise SÜREKLİ bir fiziksel büyüklüğün (radyan
 * cinsinden faz) EŞİK-AŞIMINA göre (olay-tetiklemeli, aralığı SABİT
 * DEĞİL) tetiklenir — bkz. tasarım belgesi §2. API BİLİNÇLİ OLARAK
 * benzer (record-benzeri ilerletme + rollover-benzeri kanca) ama
 * anlamı FARKLI, bu yüzden AYRI sınıf.
 *
 * ÇEKİRDEĞE ENTEGRASYON: bkz. tasarım belgesi §6 — bu modülün ürettiği
 * "hangi darbeler TUTULDU / hangi darbeler hangi δ ile kodlandı" kararı,
 * Alice'in bit dizisi bb84/photonnet_core.js'e VERİLMEDEN ÖNCE
 * `applyPhaseBufferToBits()` ile uygulanır. Çekirdeğe TEK SATIR
 * dokunulmadı, import bile EDİLMİYOR (bu dosya çekirdekten bağımsız
 * çalışır — entegrasyon çağıran tarafından yapılır, bkz.
 * bb84/chaos_quantum_phase_buffer_test.js).
 */

// ── Varsayılan parametreler (bkz. tasarım belgesi §3/§4 — gerekçelendirilmiş, ölçülmemiş) ──
const DEFAULTS = Object.freeze({
  // DAC gürültüsü + termal kararsızlığın BİRLEŞİK etkisi — büyüklük
  // mertebesi tahmini (bkz. tasarım belgesi §4): birkaç saniyede ~0.1rad
  // birikecek şekilde seçildi (10-100μs düzeltme aralığında YÖNETİLEBİLİR
  // kalması için) — ÖLÇÜLMÜŞ bir değer DEĞİL.
  sigmaRadPerSqrtS: 0.03,
  // Isıtıcının fiziksel yanıt süresi — SI3N4_PIC_DESIGN.md §5 ile
  // TUTARLI (10-100μs aralığının ORTA değeri).
  correctionIntervalS: 50e-6,
  // §3'te geriye-çözülen tolerans: sin²(δ/2)=targetErrorContribution
  targetErrorContribution: 0.01,
});

/** δ_max'ı hedef bit-hata katkısından GERİYE ÇÖZER — keyfi sabit YAZILMAZ. */
function deltaMaxFromTargetError(targetErrorContribution = DEFAULTS.targetErrorContribution) {
  if (!(targetErrorContribution > 0) || targetErrorContribution >= 1) {
    throw new RangeError("deltaMaxFromTargetError: targetErrorContribution (0,1) aralığında olmalı.");
  }
  return 2 * Math.asin(Math.sqrt(targetErrorContribution));
}

/**
 * Faz hatası (δ, radyan) → interferometrik bit-hata olasılığı.
 * P_hata(δ) = sin²(δ/2) — bkz. tasarım belgesi §3.
 */
function phaseErrorToBitFlipProb(deltaRad) {
  return Math.pow(Math.sin(deltaRad / 2), 2);
}

/**
 * Biriken faz hatasını ayrık-zamanlı rastgele-yürüyüş (Wiener süreci
 * yaklaşımı) olarak ilerleten model — bkz. tasarım belgesi §4.
 * `rng` enjekte edilebilir (test edilebilirlik/determinizm için) —
 * verilmezse Math.random kullanılır.
 */
class PhaseDriftModel {
  constructor(opts = {}) {
    this.sigmaRadPerSqrtS = opts.sigmaRadPerSqrtS ?? DEFAULTS.sigmaRadPerSqrtS;
    this.rng = opts.rng || Math.random;
    this.delta = 0; // radyan — biriken faz hatası
  }
  /** Box-Muller ile standart normal örnek — bağımlılık EKLEMEDEN. */
  _gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** dt saniye ilerler — δ(t+dt) = δ(t) + N(0, σ²·dt). */
  step(dtS) {
    if (!(dtS > 0)) throw new RangeError("PhaseDriftModel.step: dtS pozitif olmalı.");
    this.delta += this._gaussian() * this.sigmaRadPerSqrtS * Math.sqrt(dtS);
    return this.delta;
  }
  /** Gerçek bir düzeltme darbesini temsil eder — δ sıfırlanır. */
  correct() {
    this.delta = 0;
  }
}

/**
 * Kuantum Buffer — bkz. tasarım belgesi §5. Yüksek frekansta (her darbe)
 * `tickPulse()`, düşük frekansta (ısıtıcının fiziksel yanıt süresine göre)
 * `maybeCorrect()` çağrılır.
 */
class QuantumPhaseBuffer {
  /**
   * @param opts.driftModel        — bir PhaseDriftModel örneği (enjekte edilir, test edilebilirlik için)
   * @param opts.deltaMaxRad       — tolerans eşiği (verilmezse targetErrorContribution'dan türetilir)
   * @param opts.targetErrorContribution — deltaMaxRad verilmezse bundan türetilir (bkz. deltaMaxFromTargetError)
   * @param opts.correctionIntervalS — iki düzeltme fırsatı arası minimum süre (fiziksel yanıt süresi)
   * @param opts.onCorrection      — her düzeltmede çağrılan kanca(correctionInfo)
   */
  constructor(opts = {}) {
    this.driftModel = opts.driftModel || new PhaseDriftModel();
    this.deltaMaxRad = opts.deltaMaxRad ?? deltaMaxFromTargetError(opts.targetErrorContribution);
    this.correctionIntervalS = opts.correctionIntervalS ?? DEFAULTS.correctionIntervalS;
    this.onCorrection = opts.onCorrection || (() => {});
    this.timeSinceLastCorrectionS = 0;
    this.holding = false; // TUTMA durumunda mı (düzeltme arifesinde eşik aşıldı)
    this.correctionLog = [];
    this.pulseLog = []; // her darbe için { tS, held, deltaAtEncode }
    this._elapsedS = 0;
  }

  /**
   * Bir darbe periyodunu ilerletir: drift modelini bir adım ilerletir,
   * darbenin TUTULUP TUTULMADIĞINA (mevcut `holding` durumuna göre) karar
   * verir ve kaydeder. `dtS` darbe periyodudur (ör. MHz darbe hızı için ~1e-6).
   * @returns {{held:boolean, deltaAtEncode:number}}
   */
  tickPulse(dtS) {
    this.driftModel.step(dtS);
    this._elapsedS += dtS;
    this.timeSinceLastCorrectionS += dtS;
    const rec = { tS: this._elapsedS, held: this.holding, deltaAtEncode: this.driftModel.delta };
    this.pulseLog.push(rec);
    return { held: rec.held, deltaAtEncode: rec.deltaAtEncode };
  }

  /**
   * Düzeltme fırsatı penceresi — YALNIZCA `correctionIntervalS` geçtiyse
   * gerçek bir "ölçüm+düzeltme" denemesi yapar (ısıtıcının fiziksel yanıt
   * süresi sınırı, bkz. tasarım belgesi §2). Eşik aşılmışsa `holding=true`
   * yapar, düzeltir, sonra `holding=false`'a döner (düzeltme ANLIK kabul
   * edilir — gerçek sistemde bunun kendisi de bir gecikme taşır, bu basit
   * modelde ihmal edilmiştir, bkz. tasarım belgesi §7).
   * @returns {boolean} bu çağrıda bir düzeltme YAPILDI mı
   */
  maybeCorrect() {
    if (this.timeSinceLastCorrectionS < this.correctionIntervalS) return false;
    this.timeSinceLastCorrectionS = 0;
    const measuredDelta = this.driftModel.delta; // pilot-ton "ölçümü" — bu basit modelde GÜRÜLTÜSÜZ okunur
    if (Math.abs(measuredDelta) > this.deltaMaxRad) {
      this.holding = true;
      this.driftModel.correct();
      this.correctionLog.push({
        tS: this._elapsedS,
        measuredDeltaRad: measuredDelta,
        deltaMaxRad: this.deltaMaxRad,
      });
      this.onCorrection({ tS: this._elapsedS, measuredDeltaRad: measuredDelta });
      this.holding = false;
      return true;
    }
    return false;
  }

  snapshot() {
    return {
      elapsedS: this._elapsedS,
      pulseCount: this.pulseLog.length,
      heldCount: this.pulseLog.filter((p) => p.held).length,
      correctionCount: this.correctionLog.length,
      deltaMaxRad: this.deltaMaxRad,
      currentDeltaRad: this.driftModel.delta,
    };
  }
}

/**
 * Bir BB84 çalışması boyunca Kuantum Buffer'ı GERÇEKTEN İŞLETİP darbe
 * başına { held, deltaAtEncode } kaydını üretir. `pulseCount` darbe,
 * `pulsePeriodS` periyotla simüle edilir; `correctionIntervalS`'ye göre
 * uygun aralıklarla `maybeCorrect()` otomatik çağrılır.
 */
function runPhaseBuffer(buffer, pulseCount, pulsePeriodS) {
  const log = [];
  for (let i = 0; i < pulseCount; i++) {
    const r = buffer.tickPulse(pulsePeriodS);
    buffer.maybeCorrect();
    log.push(r);
  }
  return log;
}

/**
 * Kuantum Buffer'ın ürettiği kararı, ÇEKİRDEĞE VERİLMEDEN ÖNCE Alice'in
 * bit dizisine uygular — bkz. tasarım belgesi §6. TUTULAN darbeler diziden
 * ÇIKARILIR (gerçek sistemde hiç gönderilmemiş olurlardı); TUTULMAMIŞ ama
 * δ≠0 ile kodlanan darbeler P_hata(δ) olasılıkla ÇEVRİLİR (bit-flip).
 * `rng` enjekte edilebilir (determinizm için).
 *
 * @returns {{ bits:number[], heldCount:number, flippedCount:number }}
 */
function applyPhaseBufferToBits(bits, pulseLog, rng = Math.random) {
  if (bits.length !== pulseLog.length) {
    throw new RangeError(`applyPhaseBufferToBits: bits.length (${bits.length}) !== pulseLog.length (${pulseLog.length}) — her bit tam olarak bir darbeye karşılık gelmeli.`);
  }
  const outBits = [];
  let heldCount = 0, flippedCount = 0;
  for (let i = 0; i < bits.length; i++) {
    const p = pulseLog[i];
    if (p.held) { heldCount++; continue; } // gerçek sistemde hiç gönderilmedi
    const pFlip = phaseErrorToBitFlipProb(p.deltaAtEncode);
    let bit = bits[i];
    if (rng() < pFlip) { bit ^= 1; flippedCount++; }
    outBits.push(bit);
  }
  return { bits: outBits, heldCount, flippedCount };
}

module.exports = {
  DEFAULTS,
  deltaMaxFromTargetError,
  phaseErrorToBitFlipProb,
  PhaseDriftModel,
  QuantumPhaseBuffer,
  runPhaseBuffer,
  applyPhaseBufferToBits,
};
