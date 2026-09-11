#!/usr/bin/env node
"use strict";
/**
 * shielded_detector_physics.js — Faraday kalkanlamasının getirdiği DÜŞÜK
 * GÜRÜLTÜ ortamını dedektör (SNSPD-sınıfı) simülasyonuna yansıtır: karanlık
 * sayımı TERMAL + EM bileşenlerine ayırır, QBER alt sınırını yeniden
 * hesaplar, temizlenmiş kanalda GÜVENLİ ANAHTAR ORANINI (Secret Key Rate)
 * doğrular. Çekirdeğe dokunmaz (yalnız salt-okunur QKDSecurityProof çağrısı
 * — production_gate.js/detector_recalibration.js ile AYNI, kabul edilmiş desen).
 * ═══════════════════════════════════════════════════════════════════
 * KARANLIK SAYIM AYRIŞTIRMASI (bu dosyanın özü):
 *   toplam darkProb = TERMAL (dedektörün kendi intrinsik gürültüsü,
 *                       kalkanlamadan ETKİLENMEZ) + EM (kafesten sızan RF
 *                       emisyonun sahte tetiklemesi, bkz. rf_noise_bridge.js)
 *   Kafes DÜZELTİLİNCE (bkz. faraday_cage_shielding_test.js I): EM bileşeni
 *   ~0'a çöker, toplam ≈ yalnız TERMAL kalır → "temizlenmiş taban."
 *
 * TERMAL REFERANS DEĞERİ — DÜRÜSTLÜK NOTU (KRİTİK):
 *   Çekirdeğin DetectorNoiseModel'i (EK 44) UYDU/Micius senaryosu için
 *   kalibredir (80 MHz kapı, gece/gündüz gökyüzü arka planı). Bu proje
 *   dosyasının beslediği timetag_acquisition_bridge.js İSE ayrı bir
 *   senaryo — YER TABANLI FİBER BB84 (1 GHz kapı, darkProb=5e-4 varsayılan)
 *   — için AYRICA kalibre edilmiş kendi referans değerine sahiptir. Bu
 *   İKİSİ AYNI DEDEKTÖRÜ TEMSİL ETMEZ ve doğrudan birbirinin yerine
 *   KONULAMAZ (aşağıda çapraz-kontrol için ikisi de raporlanır — bkz.
 *   shielded_detector_physics_test.js (A) — ama TERMAL bileşen olarak
 *   BU MODÜLDE timetag_acquisition_bridge.js'nin KENDİ, zaten test edilmiş
 *   referansı (5e-4) kullanılır; çekirdeğin uydu-kalibreli sayısı buraya
 *   ZORLA UYARLANMAZ).
 */
const B = require("./timetag_acquisition_bridge.js");
const RF = require("./rf_noise_bridge.js");
const { QKDSecurityProof, DetectorNoiseModel } = require("./photonnet_core.js");

const THERMAL_DARK_PROB_GROUND = 5e-4; // bkz. timetag_acquisition_bridge.js'nin kendi varsayılanı (yer-tabanlı fiber referansı)

/**
 * Çapraz-kontrol/BİLGİ AMAÇLI: çekirdeğin UYDU-kalibreli DetectorNoiseModel'i
 * (80 MHz kapı) BİZİM 1 GHz kapımıza (periodPs) izdüşürülürse ne verir?
 * SADECE karşılaştırma için — operatif hesaplamada KULLANILMAZ (bkz. modül
 * dürüstlük notu).
 */
function satelliteReferenceDarkProbAtPeriod(periodPs, isNight = true) {
  const coreGateWidthS = 1 / 80e6; // core'un kendi SOURCE_GATE_WIDTH_S'i (80MHz Micius)
  const pAtCoreGate = DetectorNoiseModel.phantomClickProbability(isNight);
  const rateHz = -Math.log(1 - pAtCoreGate) / coreGateWidthS;
  const ourGateS = periodPs * 1e-12;
  return 1 - Math.exp(-rateHz * ourGateS);
}

/** Termal + EM bileşenlerini toplar (bağımsız olasılıklar, [0,1]'e sınırlı). */
function combinedDarkProb(emDarkProb, thermalDarkProb = THERMAL_DARK_PROB_GROUND) {
  return Math.min(Math.max(thermalDarkProb + emDarkProb, 0), 1);
}

/**
 * Güvenli anahtar oranı (bit/sn). ÖNEMLİ: QKDSecurityProof.secureKeyLength'in
 * n parametresi ELENMİŞ (sifted) anahtar uzunluğudur — HAM darbe sayısı
 * DEĞİL (standart sonlu-anahtar/GLLP-Serfling kanıt sözleşmesi, bkz.
 * detector_recalibration.js'in aynı kullanımı). n sifted bit üretmek için
 * gereken HAM darbe sayısı = n / siftYield — gerçek geçen süre buna göre
 * hesaplanır, yoksa oran siftYield'i göz ardı ederek OLDUĞUNDAN BÜYÜK çıkar.
 */
function secretKeyRateBps(ell, nSifted, siftYieldFraction, periodPs) {
  if (siftYieldFraction <= 0) return 0;
  const rawPulsesNeeded = nSifted / siftYieldFraction;
  const seconds = rawPulsesNeeded * periodPs * 1e-12;
  return seconds > 0 ? ell / seconds : 0;
}

/**
 * ANA GİRİŞ NOKTASI: temel (yalnız termal) / kirli (termal+ESKİ kafes EM) /
 * temiz (termal+YENİ kafes EM) üç senaryoyu AYNI qrng tohumuyla koşar,
 * ölçülen QBER'i karşılaştırır, çekirdeğin sonlu-anahtar kanıtına besleyip
 * (SALT OKUNUR) her biri için Secret Key Rate hesaplar.
 */
function evaluateCleanChannel({ pulses = 500000, periodPs = 1000, efficiency = 0.12, jitterPs = 80,
  eDetect = 0.01, emDarkProbDirty, emDarkProbClean, qrngSeed = 42, physSeed = 3, nForFiniteKey = 1e6 }) {
  const thermal = THERMAL_DARK_PROB_GROUND;
  const darkBaseline = thermal;
  const darkDirty = combinedDarkProb(emDarkProbDirty, thermal);
  const darkClean = combinedDarkProb(emDarkProbClean, thermal);

  const mk = (darkProb) => ({ pulses, periodPs, efficiency, jitterPs, eDetect, darkProb, physSeed, qrng: B.seededQrng(qrngSeed) });
  const runBaseline = B.acquire(mk(darkBaseline));
  const runDirty = B.acquire(mk(darkDirty));
  const runClean = B.acquire(mk(darkClean));

  const withFiniteKey = (run) => {
    const sec = QKDSecurityProof.secureKeyLength(nForFiniteKey, run.qber);
    const skrBps = secretKeyRateBps(sec.ell, nForFiniteKey, run.siftYield, periodPs);
    return { qberPct: +(run.qber * 100).toFixed(4), siftYieldPct: +(run.siftYield * 100).toFixed(2), ell: sec.ell, secure: sec.secure, skrBps };
  };

  const baseline = withFiniteKey(runBaseline), dirty = withFiniteKey(runDirty), clean = withFiniteKey(runClean);
  return {
    darkProb: { thermal: darkBaseline, dirty: darkDirty, clean: darkClean },
    baseline, dirty, clean,
    skrIncreasePct: baseline.skrBps > 0 ? +(((clean.skrBps - dirty.skrBps) / dirty.skrBps) * 100).toFixed(1) : null,
    cleanMatchesBaseline: clean.qberPct === baseline.qberPct,
  };
}

/**
 * Bir dizi aday koinsidans penceresi (jitterPs'nin katları) üzerinde tarama
 * yapar; verilen hedef-verim eşiğini (maksimum verimin oranı) karşılayan
 * EN DAR pencereyi seçer. "Jitter hizalama" optimizasyonunun temeli.
 */
function findOptimalCoincidenceWindow({ pulses = 300000, periodPs = 1000, efficiency = 0.12, jitterPs = 80,
  eDetect = 0.01, darkProb, qrngSeed = 42, physSeed = 3, windowMultiples = [2, 3, 4, 5, 6, 8], yieldFraction = 0.95 }) {
  const sweep = windowMultiples.map((m) => {
    const windowPs = m * jitterPs;
    const r = B.acquire({ pulses, periodPs, efficiency, jitterPs, eDetect, darkProb, physSeed, qrng: B.seededQrng(qrngSeed), windowPs });
    return { multiple: m, windowPs, qberPct: +(r.qber * 100).toFixed(3), siftYieldPct: +(r.siftYield * 100).toFixed(3) };
  });
  const maxYield = Math.max(...sweep.map(s => s.siftYieldPct));
  const threshold = maxYield * yieldFraction;
  const candidates = sweep.filter(s => s.siftYieldPct >= threshold);
  const optimal = candidates.reduce((a, b) => (b.windowPs < a.windowPs ? b : a), candidates[0] || sweep[sweep.length - 1]);
  return { sweep, maxYieldPct: maxYield, thresholdPct: +threshold.toFixed(3), optimal };
}

module.exports = {
  THERMAL_DARK_PROB_GROUND, satelliteReferenceDarkProbAtPeriod, combinedDarkProb,
  secretKeyRateBps, evaluateCleanChannel, findOptimalCoincidenceWindow,
};
