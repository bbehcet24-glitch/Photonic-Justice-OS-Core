#!/usr/bin/env node
"use strict";
/**
 * rf_noise_bridge_test.js — Faraday kafesi bulgularını GERÇEK QKD kanal
 * simülasyonuna (timetag_acquisition_bridge.js'nin uçtan-uca sift/QBER
 * motoru) besleyen tatbikat.
 * ═══════════════════════════════════════════════════════════════════
 * SORU: kafesten sızan EM emisyon, dedektör elektroniğinde sahte tıklamalar
 * (RF kaynaklı "dark count") yaratarak ÖLÇÜLEN QBER'i ne kadar etkiler —
 * ve bu, ESKİ (5mm çıplak açıklık) ile YENİ (3mm+9mm honeycomb) kafes
 * tasarımları arasında somut olarak nasıl farklılaşır?
 *
 * Gösterilen:
 *   (A) KALİBRASYON DUYARLILIĞI: marj→olasılık dönüşümü tutarlı (0 dB→ref,
 *       +10 dB→×10, çok negatif marj→~0, olasılık [0,1]'e sınırlı).
 *   (B) ESKİ TASARIM, 0.3 m: RF sızıntısı ÖLÇÜLEBİLİR şekilde QBER'i
 *       yükseltiyor (~2.3× ) ama abort eşiğinin (%11) altında kalıyor —
 *       "sessiz" bir performans/güvenlik marjı kaybı.
 *   (C) YENİ TASARIM, 0.3 m: RF katkısı ihmal edilebilir ölçüde küçük —
 *       ölçülen QBER, AYNI qrng tohumuyla, RF'siz temel duruma TAM eşit.
 *   (D) ESKİ TASARIM, 0.1 m (yakın-alan/kablo-geçişi senaryosu): QBER
 *       BB84 abort eşiğini (%11) AŞIYOR — kanal İPTAL olur (DoS-benzeri
 *       kullanılabilirlik riski, sadece "gizlilik" değil). YENİ tasarım
 *       aynı mesafede etkilenmiyor.
 *   (E) SONLU-ANAHTAR ETKİSİ: aynı RF sızıntısı, çekirdeğin sonlu-anahtar
 *       kanıtına (QKDSecurityProof.secureKeyLength, SALT OKUNUR — bkz.
 *       detector_recalibration.js ile aynı, zaten kabul edilmiş desen)
 *       beslenince ESKİ tasarımda güvenli-anahtar uzunluğu (ℓ) belirgin
 *       düşüyor (0.3 m senaryosunda ℓ>0 kalsa da); YENİ tasarımda kayıp SIFIR.
 *   + ÇEKİRDEĞE DOKUNULMADI: rf_noise_bridge.js photonnet_core.js'i
 *     DOĞRUDAN import ETMEZ (kaynak taraması) ve dosyanın SHA-256'sı
 *     test öncesi/sonrası değişmedi.
 *
 * DÜRÜSTLÜK NOTU: buradaki marj→darkProb kalibrasyonu (rf_noise_bridge.js
 * başlığında açıklanan) DOĞRULANMAMIŞ bir mühendislik varsayımıdır —
 * gerçek sayılar gerçek donanım ölçümüyle değişebilir. Burada gösterilen,
 * MODELİN İÇSEL TUTARLILIĞI ve YÖN'üdür (RF sızıntısı arttıkça QBER
 * artar, kafes düzeltmesi bunu sıfırlar) — mutlak sayılar değil.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const RF = require("./rf_noise_bridge.js");
const B = require("./timetag_acquisition_bridge.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const OLD_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 5 };
const NEW_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 3, honeycombDepthMm: 9 };
const WORST_HARMONIC_HZ = 19e9; // bkz. faraday_cage_shielding_test.js (H): en kötü durum 19. harmonikte
const SOURCE_LEVEL_DBUVM = 80;  // illüstratif kaynak seviyesi (bkz. modül dürüstlük notu — kalibre edilmemiş)
const NOISE_FLOOR_DBUVM = 20;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) KALİBRASYON DUYARLILIĞI ══
  const p0 = RF.rfInducedDarkProb(0), p10 = RF.rfInducedDarkProb(10), pNeg = RF.rfInducedDarkProb(-100), pClip = RF.rfInducedDarkProb(1000);
  out.calibration = { p0, p10, pNeg, pClip };
  chk("(A) KALİBRASYON DUYARLILIĞI: marj=0→referans, +10dB→×10, çok negatif→~0, olasılık [0,1]'e sınırlı",
    p0 === 5e-4 && Math.abs(p10 / p0 - 10) < 1e-9 && pNeg < 1e-12 && pClip === 1,
    `marj=0dB → ${p0} (referans darkProb) · marj=+10dB → ${p10} (×${(p10 / p0).toFixed(1)}) · marj=-100dB → ${pNeg.toExponential(2)} (ihmal edilebilir) · marj=+1000dB → ${pClip} (1'e sınırlı, olasılık taşmıyor)`);

  // Ortak temel kanal parametreleri — timing_coincidence_test.js'teki BASE ile aynı aile.
  const mkBase = (seed) => ({ pulses: 500000, periodPs: 1000, efficiency: 0.12, jitterPs: 80, eDetect: 0.01, darkProb: 5e-4, physSeed: 3, qrng: B.seededQrng(seed) });
  const QRNG_SEED = 42; // baseline/eski/yeni AYNI tohum → fark SADECE darkProb'dan gelir (adil karşılaştırma)
  const baseline = B.acquire(mkBase(QRNG_SEED));

  // ══ (B) ESKİ TASARIM, 0.3 m ══
  const rfOld03 = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: SOURCE_LEVEL_DBUVM, cage: { ...OLD_CAGE, freqHz: WORST_HARMONIC_HZ }, observerDistanceM: 0.3, noiseFloorDbuVm: NOISE_FLOOR_DBUVM });
  const withOld03 = RF.simulateChannelWithRfNoise(mkBase(QRNG_SEED), rfOld03.rfDarkProb);
  out.oldAt03m = { marginDb: rfOld03.marginDb, detectable: rfOld03.detectable, rfDarkProb: rfOld03.rfDarkProb,
    baselineQberPct: +(baseline.qber * 100).toFixed(3), withRfQberPct: +(withOld03.qber * 100).toFixed(3) };
  chk("(B) ESKİ TASARIM (5mm çıplak), 0.3 m: RF sızıntısı QBER'i ÖLÇÜLEBİLİR şekilde yükseltiyor ama abort eşiğinin (%11) altında kalıyor",
    withOld03.qber > baseline.qber * 1.5 && withOld03.qber < 0.11,
    `marj +${rfOld03.marginDb} dB (tespit edilebilir) → rfDarkProb ${rfOld03.rfDarkProb.toExponential(2)} → QBER %${(baseline.qber * 100).toFixed(2)} → %${(withOld03.qber * 100).toFixed(2)} (${(withOld03.qber / baseline.qber).toFixed(1)}× artış), abort eşiğinin (%11) ALTINDA — "sessiz" bir marj kaybı`);

  // ══ (C) YENİ TASARIM, 0.3 m ══
  const rfNew03 = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: SOURCE_LEVEL_DBUVM, cage: { ...NEW_CAGE, freqHz: WORST_HARMONIC_HZ }, observerDistanceM: 0.3, noiseFloorDbuVm: NOISE_FLOOR_DBUVM });
  const withNew03 = RF.simulateChannelWithRfNoise(mkBase(QRNG_SEED), rfNew03.rfDarkProb);
  out.newAt03m = { marginDb: rfNew03.marginDb, detectable: rfNew03.detectable, rfDarkProb: rfNew03.rfDarkProb,
    baselineQberPct: +(baseline.qber * 100).toFixed(4), withRfQberPct: +(withNew03.qber * 100).toFixed(4) };
  chk("(C) YENİ TASARIM (3mm+9mm honeycomb), 0.3 m: RF katkısı ihmal edilebilir — ölçülen QBER, RF'siz temel duruma TAM eşit",
    withNew03.qber === baseline.qber,
    `marj ${rfNew03.marginDb} dB (derinden gürültü tabanının altında) → rfDarkProb ${rfNew03.rfDarkProb.toExponential(2)} (temel darkProb'un ${(rfNew03.rfDarkProb / 5e-4).toExponential(2)}'i) → ölçülen QBER AYNI tohumla BİREBİR eşit: %${(baseline.qber * 100).toFixed(4)} = %${(withNew03.qber * 100).toFixed(4)}`);

  // ══ (D) ESKİ TASARIM, 0.1 m — kanal İPTAL oluyor mu? ══
  const rfOld01 = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: SOURCE_LEVEL_DBUVM, cage: { ...OLD_CAGE, freqHz: WORST_HARMONIC_HZ }, observerDistanceM: 0.1, noiseFloorDbuVm: NOISE_FLOOR_DBUVM });
  const withOld01 = RF.simulateChannelWithRfNoise(mkBase(QRNG_SEED), rfOld01.rfDarkProb);
  const rfNew01 = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: SOURCE_LEVEL_DBUVM, cage: { ...NEW_CAGE, freqHz: WORST_HARMONIC_HZ }, observerDistanceM: 0.1, noiseFloorDbuVm: NOISE_FLOOR_DBUVM });
  const withNew01 = RF.simulateChannelWithRfNoise(mkBase(QRNG_SEED), rfNew01.rfDarkProb);
  out.at01m = { old: { marginDb: rfOld01.marginDb, qberPct: +(withOld01.qber * 100).toFixed(3), aborts: withOld01.qber >= 0.11 },
    new_: { marginDb: rfNew01.marginDb, qberPct: +(withNew01.qber * 100).toFixed(4), aborts: withNew01.qber >= 0.11 } };
  chk("(D) YAKIN-ALAN SENARYOSU (0.1 m, örn. kablo geçişi yanı): ESKİ tasarımda QBER abort eşiğini AŞIYOR (kanal İPTAL — DoS-benzeri risk); YENİ tasarım etkilenmiyor",
    withOld01.qber >= 0.11 && withNew01.qber < 0.11,
    `ESKİ: marj +${rfOld01.marginDb} dB → QBER %${(withOld01.qber * 100).toFixed(2)} ≥ abort eşiği %11 → ANAHTAR İPTAL (kanal kullanılamaz hale gelir, salt gizlilik değil KULLANILABİLİRLİK riski). ` +
    `YENİ: marj ${rfNew01.marginDb} dB → QBER %${(withNew01.qber * 100).toFixed(4)} ≪ %11 → etkilenmiyor`);

  // ══ (E) SONLU-ANAHTAR ETKİSİ (0.3 m senaryosu, n=1e6) ══
  const N = 1e6;
  const fkOld = RF.recalibrateFiniteKey(baseline.qber * 100, withOld03.qber * 100, [N])[0];
  const fkNew = RF.recalibrateFiniteKey(baseline.qber * 100, withNew03.qber * 100, [N])[0];
  out.finiteKey = { n: N, oldIdealEll: fkOld.idealEll, oldRealEll: fkOld.realEll, oldLossPts: fkOld.lossPts, oldStillSecure: fkOld.realSecure,
    newIdealEll: fkNew.idealEll, newRealEll: fkNew.realEll, newLossPts: fkNew.lossPts, newStillSecure: fkNew.realSecure };
  chk("(E) SONLU-ANAHTAR ETKİSİ (n=1e6, 0.3 m): ESKİ tasarımın RF sızıntısı güvenli-anahtar uzunluğunu BELİRGİN düşürüyor (ℓ>0 kalsa da); YENİ tasarımda kayıp SIFIR",
    fkOld.realEll < fkOld.idealEll * 0.85 && fkOld.realSecure && fkNew.lossPts === 0 && fkNew.realSecure,
    `ESKİ: ℓ ${fkOld.idealEll.toLocaleString("tr-TR")} → ${fkOld.realEll.toLocaleString("tr-TR")} bit (%${((1 - fkOld.realEll / fkOld.idealEll) * 100).toFixed(1)} kayıp), hâlâ güvenli (ℓ>0) ama gereksiz yere pahalı. ` +
    `YENİ: ℓ değişmedi (${fkNew.idealEll.toLocaleString("tr-TR")} bit, kayıp %0) — kafes düzeltmesi bu maliyeti TAMAMEN ortadan kaldırıyor`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const src = fs.readFileSync(path.join(__dirname, "rf_noise_bridge.js"), "utf8");
  const noDirectCoreImport = !/require\(["']\.\/photonnet_core\.js["']\)/.test(src);
  const hashAfter = coreHash();
  out.coreIntegrity = { noDirectCoreImport, unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: rf_noise_bridge.js photonnet_core.js'i DOĞRUDAN import ETMEZ VE dosyanın SHA-256'sı değişmedi",
    noDirectCoreImport && hashBefore === hashAfter,
    `kaynakta doğrudan core import taraması: ${noDirectCoreImport ? "yok ✓" : "BULUNDU ✗"} · SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası ✓ ` +
    `— yalnız zaten test edilmiş katman dosyaları (faraday_cage_shielding, timetag_acquisition_bridge, detector_recalibration) beslendi`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "rf_noise_bridge.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ RF gürültü köprüsü — Faraday kafesi → QKD kanal QBER'i ══\n");
  console.log(`  (A) kalibrasyon: p(0dB)=${out.calibration.p0} · p(+10dB)=${out.calibration.p10} · p(-100dB)=${out.calibration.pNeg.toExponential(1)} · p(+1000dB)=${out.calibration.pClip}`);
  console.log(`  (B) ESKİ @0.3m: QBER %${out.oldAt03m.baselineQberPct} → %${out.oldAt03m.withRfQberPct}`);
  console.log(`  (C) YENİ @0.3m: QBER %${out.newAt03m.baselineQberPct} → %${out.newAt03m.withRfQberPct} (aynı)`);
  console.log(`  (D) @0.1m: ESKİ QBER %${out.at01m.old.qberPct} (abort=${out.at01m.old.aborts}) · YENİ QBER %${out.at01m.new_.qberPct} (abort=${out.at01m.new_.aborts})`);
  console.log(`  (E) sonlu-anahtar (n=1e6): ESKİ ℓ kaybı %${((1 - out.finiteKey.oldRealEll / out.finiteKey.oldIdealEll) * 100).toFixed(1)} · YENİ ℓ kaybı %0`);
  console.log(`\n  ÇEKİRDEK: doğrudan import yok=${out.coreIntegrity.noDirectCoreImport ? "✓" : "✗"} · SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "rf_noise_bridge.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
