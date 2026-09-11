#!/usr/bin/env node
"use strict";
/**
 * hardware_aging_model.js — "SAHAYA İNİŞ / YAŞLANMA FAKTÖRÜ" anahtarı:
 * gerçek dünyada bir Faraday kafesinin kalkanlama etkinliği SABİT KALMAZ —
 * conta sıkışması gevşer, honeycomb lehim/bağlantı noktaları oksitlenir,
 * duvar derzleri korozyona uğrar, termal döngüler mikro-boşluklar açar.
 * Bu modül bunu KOD SEVİYESİNDE, kapatılabilir bir anahtarla simüle eder.
 * ═══════════════════════════════════════════════════════════════════
 * MODEL (güç/sızıntı ALANINDA, dB'de DEĞİL — DÜRÜSTLÜK NOTU aşağıda):
 *   Her "saha döngüsü" (ör. bir bakım aralığı/termal döngü), kalkanın
 *   SIZINTI KESRİNİ (leak = 10^(-SE_dB/10), yani kafesin GEÇİRDİĞİ güç
 *   oranı) rastgele %1–%5 ARTIRIR:
 *     leak_{i+1} = leak_i · (1 + U(0.01, 0.05))
 *   Bu ARTAN, BİRİKEN (compounding) bir bozulmadır — gerçek aşınma gibi
 *   kendiliğinden İYİLEŞMEZ. dB'de bu, SE'nin (log ölçekte) giderek
 *   KÜÇÜLEN adımlarla düşmesi anlamına gelir (yüksek SE'de %'lik sızıntı
 *   artışı az dB kaybettirir; SE düştükçe AYNI %'lik artış DAHA FAZLA dB
 *   kaybettirir — gerçekçi: iyi bir kalkan yavaş bozulur, kötüleşmiş bir
 *   kalkan HIZLA çöker).
 *
 * DÜRÜSTLÜK NOTU: "%1-5 arasında rastgele düşürsün" talebini SIZINTI
 * KESRİNE (güç alanında, doğrusal) uyguluyoruz — SE dB DEĞERİNİN kendisine
 * DEĞİL. Nedeni: faraday_cage_shielding.js'nin TÜM matematiği (bkz.
 * combineShieldingPathsDb) zaten güç-alanında toplanan sızıntı kesirleri
 * üzerine kuruludur; "%X kalkanlama kaybı" fiziksel olarak "%X daha fazla
 * güç sızıyor" demektir, "SE dB değerinden X çıkar" demek DEĞİLDİR (o,
 * farklı ve daha az fiziksel bir yaklaşım olurdu — bkz. modülün ikinci
 * notu). Gerçek malzeme bozulması (korozyon, gevşeme) da doğası gereği
 * GEÇİRGENLİĞİ (güç oranını) etkiler, dB ölçeğini değil.
 *
 * Bu modül photonnet_core.js'i import ETMEZ; yalnızca faraday_cage_shielding.js
 * ile aynı "sonuç şekli"ni (ok/marginDb/combinedSeDb/detail) üretip başka
 * katmanlara (rf_noise_bridge, shielded_detector_physics, network_shielding_bridge,
 * production_gate) DOĞRUDAN takılabilir bir "yaşlanmış kafes değerlendirmesi" verir.
 */
const F = require("./faraday_cage_shielding.js");

/** mulberry32 — deterministik, tohumlu PRNG (çekirdekten BAĞIMSIZ yerel kopya;
 *  yalnız bu modülün kendi tekrarlanabilir tatbikatları için — anahtar üretimiyle
 *  HİÇBİR İLGİSİ YOK, core'un mulberry32'siyle KARIŞTIRILMAMALI). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tek bir saha-döngüsü bozulma adımı: sızıntı kesrini %[minPct,maxPct] artırır.
 *  DÜRÜSTLÜK NOTU (FİZİKSEL TABAN): leakFraction bir GÜÇ ORANIDIR — kafesin
 *  DIŞARI SIZDIRDIĞI gücün, ÜZERİNE gelen güce oranı. Fiziksel olarak bu
 *  1'i (yani SE=0 dB, "kalkan yok" — tam saydamlık) AŞAMAZ; bir bariyer,
 *  üzerine gelenden DAHA FAZLASINI "sızdıramaz" (negatif SE, kazanç anlamına
 *  gelir ki bu bir pasif kalkan için fiziksel değildir). Bu yüzden 1'de
 *  SIFIRLANIR (clamp) — bozulma bu noktadan sonra durur, "daha da kötüsü"
 *  yoktur (zaten tam saydam). Aşağıdaki applyFieldAging() bu tavanı her
 *  döngüde uygular. */
function degradeLeakFraction(leakFraction, minPct = 1, maxPct = 5, rng = Math.random) {
  const pct = minPct + rng() * (maxPct - minPct);
  return Math.min(leakFraction * (1 + pct / 100), 1);
}

const leakFromSeDb = (seDb) => Math.pow(10, -seDb / 10);
const seDbFromLeak = (leak) => (leak > 0 ? -10 * Math.log10(leak) : Infinity);

/**
 * ANA GİRİŞ NOKTASI — "Sahaya İniş / Yaşlanma Faktörü" anahtarı.
 * enabled=false: nominal değerlendirmeyi OLDUĞU GİBİ döndürür (bypass —
 * anahtar kapalıyken davranış SIFIR fark, mevcut kullanım ETKİLENMEZ).
 * enabled=true: nominal SE'yi `cycles` saha-döngüsü kadar BİRİKEREK
 * bozar ve YENİ (aynı şekilde) bir kafes-değerlendirmesi nesnesi döndürür.
 *
 * @param {Object} nominalCageEval — faraday_cage_shielding.evaluateFaradayCage() çıktısı
 * @param {Object} opts { enabled, cycles, minPct, maxPct, seed }
 */
function applyFieldAging(nominalCageEval, { enabled = false, cycles = 0, minPct = 1, maxPct = 5, seed = 1 } = {}) {
  if (!enabled || cycles <= 0) {
    return { ...nominalCageEval, aging: { enabled: false, cycles: 0, degradedPct: 0 } };
  }
  const rng = mulberry32(seed >>> 0);
  let leak = leakFromSeDb(nominalCageEval.worst.combinedSeDb);
  const history = [];
  for (let c = 1; c <= cycles; c++) {
    leak = degradeLeakFraction(leak, minPct, maxPct, rng);
    history.push({ cycle: c, combinedSeDb: +seDbFromLeak(leak).toFixed(2) });
  }
  const agedSeDb = seDbFromLeak(leak);
  const ok = agedSeDb >= nominalCageEval.targetSeDb;
  const marginDb = +(agedSeDb - nominalCageEval.targetSeDb).toFixed(1);
  const degradedPct = +(((leak - leakFromSeDb(nominalCageEval.worst.combinedSeDb)) / leakFromSeDb(nominalCageEval.worst.combinedSeDb)) * 100).toFixed(1);
  const firstFailCycle = history.find(h => h.combinedSeDb < nominalCageEval.targetSeDb);
  return {
    ...nominalCageEval,
    ok, marginDb,
    worst: { ...nominalCageEval.worst, combinedSeDb: agedSeDb },
    detail: ok
      ? `${cycles} saha-döngüsü sonrası (birikimli sızıntı artışı %${degradedPct}): birleşik SE ${agedSeDb.toFixed(1)} dB ≥ hedef ${nominalCageEval.targetSeDb} dB (marj +${marginDb} dB) — hâlâ dayanıklı`
      : `${cycles} saha-döngüsü sonrası (birikimli sızıntı artışı %${degradedPct}): birleşik SE ${agedSeDb.toFixed(1)} dB < hedef ${nominalCageEval.targetSeDb} dB (açık ${Math.abs(marginDb)} dB) — YAŞLANMA nedeniyle hedefi KAYBETTİ`,
    aging: {
      enabled: true, cycles, minPct, maxPct, seed, degradedPct,
      nominalSeDb: nominalCageEval.worst.combinedSeDb, agedSeDb: +agedSeDb.toFixed(2),
      firstFailCycle: firstFailCycle ? firstFailCycle.cycle : null,
      history,
    },
  };
}

module.exports = { degradeLeakFraction, leakFromSeDb, seDbFromLeak, applyFieldAging, mulberry32 };
