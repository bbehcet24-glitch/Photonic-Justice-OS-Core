#!/usr/bin/env node
"use strict";
/**
 * detector_recalibration.js — FAZ 3: GERÇEK-GÜRÜLTÜ REKALİBRASYONU (B4)
 * ═══════════════════════════════════════════════════════════════════
 * Faz 1/2 emülatörünün idealize gürültü modeli (karanlık sayım + jitter +
 * hizasızlık) GERÇEK tek-foton dedektörlerinin iki kusurunu atlıyordu:
 *   • AFTERPULSING — bir tıklamadan sonra tuzaklanan yükler boşalıp sonraki
 *     kapıda SAHTE bir tıklama üretir; sinyalle korelasyonsuz → QBER'e
 *     doğrudan katkı. İdeal model bunu görmez → QBER'i OLDUĞUNDAN DÜŞÜK tahmin.
 *   • VERİM UYUMSUZLUĞU — 4 dedektör (H/V/D/A) eşit verimli değil. QBER'e
 *     DOĞRUDAN katkısı ~0'dır AMA elenmiş anahtarı YANLI yapar (bit dağılımı
 *     0.5'ten sapar) ve standart sonlu-anahtar sınırının GÖRMEDİĞİ bir yan
 *     kanal açar (dedektör-verim-uyumsuzluğu / time-shift saldırısı).
 *
 * REKALİBRASYON: gerçekçi (daha yüksek) QBER çekirdeğin sonlu-anahtar
 * kanıtına (QKDSecurityProof.secureKeyLength) beslenir → güvenli-anahtar
 * oranı (ℓ/n) DÜŞER, güvenlik marjı yeniden oturur. İdealize kalibrasyon
 * İYİMSERDİ. Çekirdek DEĞİŞTİRİLMEZ (yalnız kanıt fonksiyonu çağrılır).
 */
const B = require("./timetag_acquisition_bridge.js");
const { QKDSecurityProof } = require("./photonnet_core.js");

/** Her kusurun QBER katkısını TEK TEK açarak ölç (ayrıştırma). */
function qberByImperfection(base) {
  const off = { eDetect: 0, darkProb: 0, afterpulseProb: 0, detEff: [1, 1, 1, 1] };
  const run = (over) => B.acquire({ ...base, ...off, ...over });
  const mis = run({ eDetect: base.eDetect });
  const dark = run({ darkProb: base.darkProb });
  const ap = run({ afterpulseProb: base.afterpulseProb });
  const mm = run({ detEff: base.detEff });
  const ideal = run({ eDetect: base.eDetect, darkProb: base.darkProb });         // idealize model (kusursuz dedektör)
  const real = run({ eDetect: base.eDetect, darkProb: base.darkProb,
    afterpulseProb: base.afterpulseProb, detEff: base.detEff });                  // gerçek dedektör
  return {
    misalignment: +(mis.qber * 100).toFixed(3), dark: +(dark.qber * 100).toFixed(3),
    afterpulse: +(ap.qber * 100).toFixed(3), mismatch: +(mm.qber * 100).toFixed(3),
    idealQber: +(ideal.qber * 100).toFixed(3), realQber: +(real.qber * 100).toFixed(3),
    idealRun: ideal, realRun: real, mismatchRun: mm,
  };
}

/** Elenmiş anahtarda bit-1 oranı (verim uyumsuzluğu → sapar). */
function keyBias(bits) { return bits.length ? bits.reduce((s, b) => s + b, 0) / bits.length : 0.5; }

/**
 * Dedektör başına algılama-oranı asimetrisi — verim uyumsuzluğunun ÖLÇÜLEBİLİR
 * gözlemlenebiliri (yan-kanal izleme metriği). Standart QBER sınırı bunu görmez.
 */
function detectionAsymmetry(acqRun) {
  // acqRun.bits yerine ham dedektör sayımına ihtiyaç var → tek-tıklama yuvalarından say.
  return acqRun;   // (drill ham sayımı ayrıca ölçer)
}

/**
 * Sonlu-anahtar rekalibrasyonu: ideal vs gerçek QBER'i çekirdek kanıta besle.
 * @returns her n için {compR, ell, secure} — ideal ve gerçek.
 */
function recalibrateFiniteKey(idealQberPct, realQberPct, nList = [1e4, 1e5, 1e6]) {
  return nList.map(n => {
    const id = QKDSecurityProof.secureKeyLength(n, idealQberPct / 100);
    const rl = QKDSecurityProof.secureKeyLength(n, realQberPct / 100);
    return { n,
      idealCompR: +(id.compressionRatio * 100).toFixed(2), idealEll: id.ell, idealSecure: id.secure,
      realCompR: +(rl.compressionRatio * 100).toFixed(2), realEll: rl.ell, realSecure: rl.secure,
      lossPts: +((id.compressionRatio - rl.compressionRatio) * 100).toFixed(2) };
  });
}

/** ℓ→0 olan QBER (güvenlik uçurumu) — verilen n için rekalibre marj. */
function qberCliff(n) {
  let lo = 0, hi = 0.5;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (QKDSecurityProof.secureKeyLength(n, mid).ell > 0) lo = mid; else hi = mid;
  }
  return +(lo * 100).toFixed(2);
}

module.exports = { qberByImperfection, keyBias, detectionAsymmetry, recalibrateFiniteKey, qberCliff };
