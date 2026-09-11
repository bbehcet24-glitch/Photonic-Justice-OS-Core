#!/usr/bin/env node
"use strict";
/**
 * shielded_detector_physics_test.js — Kuantum fiziksel katman güncellemesi
 * tatbikatı: Faraday kalkanlamasının getirdiği düşük-gürültü ortamını
 * dedektör simülasyonuna yansıtır, QBER alt sınırını yeniden hesaplar,
 * temizlenmiş kanalda Secret Key Rate artışını doğrular.
 * ═══════════════════════════════════════════════════════════════════
 * Gösterilen:
 *   (A) TERMAL/EM AYRIŞTIRMASI + ÇAPRAZ-KONTROL: yer-tabanlı (bu projenin
 *       kendi referansı, 5e-4) ile uydu-kalibreli (çekirdeğin
 *       DetectorNoiseModel'i, 1 GHz'e izdüşürülmüş) karanlık-sayım
 *       referansları AYNI DEDEKTÖRÜ TEMSİL ETMEZ (~2000× fark) — bu
 *       AÇIKÇA raporlanır, biri diğerinin yerine ZORLA KONULMAZ.
 *   (B) QBER ALT SINIRI YENİDEN HESAPLAMA: kirli (ESKİ kafes EM'i) →
 *       temiz (YENİ kafes) geçişte ölçülen QBER, RF'siz TERMAL-SADECE
 *       tabana (alt sınıra) geri döner — AYNI qrng tohumuyla BİREBİR eşit.
 *   (C) SECRET KEY RATE ARTIŞI: aynı senaryo, çekirdeğin sonlu-anahtar
 *       kanıtına (QKDSecurityProof.secureKeyLength, SALT OKUNUR) beslenip
 *       GERÇEK saat süresine (ham darbe sayısı = n/siftYield) göre bit/sn
 *       hesaplanır — temiz kanalda ÖLÇÜLEBİLİR bir artış.
 *   (D) JİTTER HİZALAMA: koinsidans penceresi taraması — temiz kanalda
 *       AYNI verim hedefinde daha düşük QBER (bkz. network_shielding_bridge
 *       ile birlikte kullanım — burada yalnız alt motor test edilir).
 *   + ÇEKİRDEK DOKUNULMADI: SHA-256 değişmedi (bu dosya QKDSecurityProof +
 *     DetectorNoiseModel'i SALT OKUNUR çağırır — production_gate.js ile
 *     AYNI, zaten kabul edilmiş desen; "sıfır import" İDDİASI YOKTUR).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const RF = require("./rf_noise_bridge.js");
const Dphy = require("./shielded_detector_physics.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const OLD_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 5 };
const NEW_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 3, honeycombDepthMm: 9 };
const WORST_HARMONIC_HZ = 19e9;
const SCENARIO = { sourceLevelDbuVm: 80, observerDistanceM: 0.3, noiseFloorDbuVm: 20 };

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) TERMAL/EM AYRIŞTIRMASI + ÇAPRAZ-KONTROL ══
  const groundThermal = Dphy.THERMAL_DARK_PROB_GROUND;
  const satRef = Dphy.satelliteReferenceDarkProbAtPeriod(1000, true);
  out.thermalCrossCheck = { groundThermal, satelliteReferenceAt1GHz: satRef, ratio: +(groundThermal / satRef).toFixed(1) };
  chk("(A) TERMAL/EM AYRIŞTIRMASI: yer-tabanlı ve uydu-kalibreli referanslar AÇIKÇA farklı (~2000×) — biri diğerinin yerine zorla KONULMUYOR",
    satRef > 0 && satRef < groundThermal / 100,
    `yer-tabanlı termal referans (timetag_acquisition_bridge.js, bu projenin kendi kalibrasyonu): ${groundThermal.toExponential(2)} · ` +
    `çekirdeğin uydu-kalibreli DetectorNoiseModel'i 1 GHz'e izdüşürülünce: ${satRef.toExponential(2)} (${(groundThermal / satRef).toFixed(0)}× daha düşük — FARKLI senaryo/dedektör kalibrasyonu, doğrudan birbirinin yerine KULLANILMIYOR)`);

  // Ortak RF girdileri (bkz. rf_noise_bridge_test.js ile aynı senaryo/kafesler)
  const rfOld = RF.evaluateRfNoiseContribution({ ...SCENARIO, cage: { ...OLD_CAGE, freqHz: WORST_HARMONIC_HZ } });
  const rfNew = RF.evaluateRfNoiseContribution({ ...SCENARIO, cage: { ...NEW_CAGE, freqHz: WORST_HARMONIC_HZ } });
  const result = Dphy.evaluateCleanChannel({ emDarkProbDirty: rfOld.rfDarkProb, emDarkProbClean: rfNew.rfDarkProb });
  out.channel = result;

  // ══ (B) QBER ALT SINIRI YENİDEN HESAPLAMA ══
  chk("(B) QBER ALT SINIRI: kirliden temize geçişte ölçülen QBER, RF'siz TERMAL-SADECE tabana BİREBİR geri dönüyor",
    result.cleanMatchesBaseline && result.dirty.qberPct > result.baseline.qberPct * 1.5,
    `taban (yalnız termal) QBER %${result.baseline.qberPct} · ESKİ kafes (kirli EM) QBER %${result.dirty.qberPct} (${(result.dirty.qberPct / result.baseline.qberPct).toFixed(1)}× yüksek) · ` +
    `YENİ kafes (temiz) QBER %${result.clean.qberPct} — tabana BİREBİR eşit (aynı qrng tohumu, yalnız darkProb farklı): QBER alt sınırı GERİ KAZANILDI`);

  // ══ (C) SECRET KEY RATE ARTIŞI ══
  chk("(C) SECRET KEY RATE: temizlenmiş kanalda ÖLÇÜLEBİLİR bir artış (gerçek saat süresine göre, ham darbe = n/siftYield)",
    result.clean.skrBps > result.dirty.skrBps && result.skrIncreasePct > 10 && result.clean.skrBps === result.baseline.skrBps,
    `ESKİ kafes: ${(result.dirty.skrBps / 1e6).toFixed(2)} Mbit/s · YENİ kafes: ${(result.clean.skrBps / 1e6).toFixed(2)} Mbit/s (tabanla AYNI) → %${result.skrIncreasePct} artış. ` +
    `(n=1e6 elenmiş bit için sonlu-anahtar kanıtı ℓ=${result.dirty.ell.toLocaleString("tr-TR")}→${result.clean.ell.toLocaleString("tr-TR")} bit, her iki durumda da ℓ>0/güvenli)`);

  // ══ (D) JİTTER HİZALAMA — alt motor ══
  const darkDirty = Dphy.combinedDarkProb(rfOld.rfDarkProb), darkClean = Dphy.combinedDarkProb(rfNew.rfDarkProb);
  const sweepDirty = Dphy.findOptimalCoincidenceWindow({ darkProb: darkDirty });
  const sweepClean = Dphy.findOptimalCoincidenceWindow({ darkProb: darkClean });
  out.jitterSweep = { dirty: sweepDirty, clean: sweepClean };
  chk("(D) JİTTER HİZALAMA: AYNI koinsidans penceresinde temiz kanal HER ZAMAN daha düşük QBER veriyor (pencere taraması boyunca monoton)",
    sweepClean.sweep.every((s, i) => s.qberPct < sweepDirty.sweep[i].qberPct) && sweepClean.optimal.qberPct < sweepDirty.optimal.qberPct,
    `${sweepDirty.sweep.length} pencere genişliği (${sweepDirty.sweep.map(s => s.multiple + "σ").join(", ")}) tarandı — HER birinde temiz kanal daha düşük QBER veriyor. ` +
    `Önerilen pencerede (${sweepClean.optimal.windowPs} ps): kirli QBER %${sweepDirty.optimal.qberPct} → temiz QBER %${sweepClean.optimal.qberPct}`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: photonnet_core.js SHA-256 değişmedi (bu dosya QKDSecurityProof/DetectorNoiseModel'i SALT OKUNUR çağırır)",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — production_gate.js ile AYNI, zaten kabul edilmiş salt-okunur core çağrı deseni`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "shielded_detector_physics.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ Kuantum fiziksel katman — kalkanlanmış dedektör simülasyonu ══\n");
  console.log(`  (A) termal çapraz-kontrol: yer=${out.thermalCrossCheck.groundThermal.toExponential(1)} vs uydu@1GHz=${out.thermalCrossCheck.satelliteReferenceAt1GHz.toExponential(1)} (${out.thermalCrossCheck.ratio}×)`);
  console.log(`  (B) QBER: taban %${out.channel.baseline.qberPct} · kirli %${out.channel.dirty.qberPct} · temiz %${out.channel.clean.qberPct}`);
  console.log(`  (C) SKR: kirli ${(out.channel.dirty.skrBps / 1e6).toFixed(2)} Mbit/s · temiz ${(out.channel.clean.skrBps / 1e6).toFixed(2)} Mbit/s (+%${out.channel.skrIncreasePct})`);
  console.log(`  (D) jitter: kirli optimal ${out.jitterSweep.dirty.optimal.windowPs}ps/QBER%${out.jitterSweep.dirty.optimal.qberPct} · temiz ${out.jitterSweep.clean.optimal.windowPs}ps/QBER%${out.jitterSweep.clean.optimal.qberPct}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "shielded_detector_physics.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
