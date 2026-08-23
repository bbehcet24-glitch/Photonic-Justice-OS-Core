#!/usr/bin/env node
"use strict";
/**
 * predictive_jitter_alignment.js — TAHMİNSEL JITTER HİZALAMA (L5.5)
 * ═══════════════════════════════════════════════════════════════════
 * async_sync_drill.js şunu gösterdi: durum-tabanlı (içerik-adresli)
 * doğrulama skew'e BAĞIŞIK, ama bir zaman-penceresi kullanan alıcı (ör.
 * eski/interop bir SAE, PTP tabanlı bir donanım) sürekli asimetrik
 * sürüklenme altında CANLI-KİLİDE giriyor: pencere açılır → geçerli paket
 * düşer → resync fırtınası → akış donar.
 *
 * Bu modül o pencerenin AÇILMASINI önceden engeller. Tepkisel resync
 * yerine, her hattın saat kaymasını (offset + drift + yavaş termal
 * bileşen) ÇEVRİMİÇİ ÖĞRENİP bir sonraki pencereyi ÖN-BESLEMELİ
 * (feed-forward) düzeltir. Kalan artık yalnızca ÖNGÖRÜLEMEZ jitter'dır.
 *
 * "YAPAY ZEKA" NE DEMEK BURADA — DÜRÜST ÇERÇEVE:
 *   Kara kutu bir sinir ağı DEĞİL. Çevrimiçi uyarlamalı bir kestirici:
 *   sabit-hızlı (constant-velocity) Kalman filtresi ile saat disiplini —
 *   PTP (IEEE 1588) ve GPS alıcılarının onlarca yıldır kullandığı
 *   yerleşik teknik. Durum x = [offset, drift]; her ölçümle özyinelemeli
 *   güncellenir; bir adım ileri TAHMİN edilir ve o tahmin ön-beslemeli
 *   düzeltme olarak uygulanır. Öğrenen, YORUMLANABİLİR bir model —
 *   "öngörülebilir kısmı öğren, önceden sil".
 *
 * DÜRÜST SINIR: kestirici yalnız ÖNGÖRÜLEBİLİR yapıyı (offset, drift,
 * yavaş trend) silebilir. Saf beyaz jitter'ın öngörülebilir kısmı YOKTUR;
 * orada artık = tam jitter (kestirici yapı UYDURMAZ). Bu da ölçülüp
 * raporlanır — modül kendi sınırını da kanıtlar.
 *
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi — bu bağımsız bir L5.5
 * katmanıdır, yalnızca mulberry32 (tohumlu RNG) çağrılır.
 */
const { mulberry32 } = require("./photonnet_core.js");

/**
 * Sabit-hızlı Kalman saat kestiricisi.
 * Durum: x = [b (offset), d (adım başına drift)].
 * Geçiş:  b' = b + d,  d' = d   →  F = [[1,1],[0,1]]
 * Ölçüm:  z = b + gürültü         →  H = [1, 0]
 *
 * @param {object} opts
 *   q    — süreç gürültüsü (drift'in ne kadar hızlı değişebildiği). Büyük
 *          q → daha uyarlanabilir ama daha gürültülü; küçük q → daha düzgün
 *          ama ani değişime yavaş. Uyarlanabilirlik/düzgünlük dengesi.
 *   r    — ölçüm gürültüsü (jitter varyansı tahmini).
 */
class JitterPredictor {
  constructor({ q = 1e-4, r = 1.0 } = {}) {
    this.b = 0; this.d = 0;                 // durum
    this.P = [[1, 0], [0, 1]];              // kovaryans
    this.q = q; this.r = r;
    this.nUpdates = 0;
  }
  /** Bir adım ileri TAHMİN: bir sonraki pencerenin beklenen kayması. */
  predict() { return this.b + this.d; }
  /**
   * Ölçülen kaymayı işle (özyinelemeli güncelleme).
   * @param {number} z — bu penceredeki GÖZLENEN skew
   */
  update(z) {
    // ── ÖNGÖRÜ (time update): x = F·x, P = F·P·Fᵀ + Q ──
    const b = this.b + this.d, d = this.d;
    const P = this.P;
    // F·P·Fᵀ
    const p00 = P[0][0] + P[0][1] + P[1][0] + P[1][1];
    const p01 = P[0][1] + P[1][1];
    const p10 = P[1][0] + P[1][1];
    const p11 = P[1][1];
    // + Q (drift durumuna süreç gürültüsü)
    const Pp = [[p00 + this.q, p01], [p10, p11 + this.q]];
    // ── DÜZELTME (measurement update) ──
    const y = z - b;                        // yenilik (innovation)
    const S = Pp[0][0] + this.r;            // yenilik kovaryansı
    const k0 = Pp[0][0] / S, k1 = Pp[1][0] / S;   // Kalman kazancı
    this.b = b + k0 * y;
    this.d = d + k1 * y;
    // P = (I − K·H)·P
    this.P = [
      [(1 - k0) * Pp[0][0], (1 - k0) * Pp[0][1]],
      [Pp[1][0] - k1 * Pp[0][0], Pp[1][1] - k1 * Pp[0][1]],
    ];
    this.nUpdates++;
    return { innovation: y, predicted: b };
  }
}

/**
 * Bir hat için gerçek skew üreteci: offset + drift + yavaş termal
 * (sinüzoidal) + beyaz jitter. async_sync ile aynı fizik, artı termal.
 */
function makeSkewSource({ offset = 0, driftPerStep = 0, thermalAmp = 0, thermalPeriod = 400, jitter = 0.5, seed = 1 }) {
  const rng = mulberry32(seed >>> 0);
  return (k) => offset + driftPerStep * k
    + thermalAmp * Math.sin(2 * Math.PI * k / thermalPeriod)
    + (rng() * 2 - 1) * jitter;
}

/**
 * Hizalama koşumu: N pencere boyunca ölçüp, ÖN-BESLEMELİ düzeltme
 * uygulanır; artık skew (|gerçek − tahmin|) pencere ile karşılaştırılır.
 *
 * @param opts.predict — true: Kalman ön-besleme; false: düzeltme yok (naif)
 * @returns {{residuals, drops, dropPct, resyncs, meanResidual, jitterFloor}}
 */
function runAligned({ N, windowMs, skewSource, predict = true, q = 1e-4, r = 1.0,
  resyncThreshold = 8, resyncStallSteps = 12, jitterFloor = 0.5 }) {
  const kf = new JitterPredictor({ q, r });
  const residuals = [];
  let drops = 0, dropRun = 0, resyncs = 0, stall = 0, corrected = 0;
  for (let k = 0; k < N; k++) {
    const trueSkew = skewSource(k);
    // ÖN-BESLEME: bir sonraki kaymayı tahmin et, telafi et.
    const est = predict ? kf.predict() : 0;
    const residual = trueSkew - est;            // düzeltmeden sonra kalan
    residuals.push(residual);
    // Alıcı zaman-penceresi kararı ARTIK residual üzerinden:
    if (stall > 0) { stall--; drops++; }
    else if (Math.abs(residual) > windowMs) {
      drops++; dropRun++;
      if (dropRun >= resyncThreshold) { resyncs++; dropRun = 0; stall = resyncStallSteps; }
    } else { dropRun = 0; corrected++; }
    // Kestiriciyi GÖZLENEN skew ile güncelle (bir sonraki tahmin için).
    kf.update(trueSkew);
  }
  const absRes = residuals.map(Math.abs);
  const mean = absRes.reduce((s, x) => s + x, 0) / absRes.length;
  return { residuals, meanResidual: +mean.toFixed(4), drops, dropPct: +(100 * drops / N).toFixed(2),
    resyncs, corrected, jitterFloor,
    finalOffset: +kf.b.toFixed(4), finalDrift: +kf.d.toFixed(5) };
}

module.exports = { JitterPredictor, makeSkewSource, runAligned };
