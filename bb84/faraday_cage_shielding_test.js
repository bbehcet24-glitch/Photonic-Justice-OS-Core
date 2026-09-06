#!/usr/bin/env node
"use strict";
/**
 * faraday_cage_shielding_test.js — EK KATMAN tatbikatı: Faraday kafesi
 * EM kalkanlama etkinliği modeli
 * ═══════════════════════════════════════════════════════════════════
 * Gösterilen:
 *   (A) DÜZ DUVAR BASKIN: kalın bakır, açıklık yok, düşük frekans →
 *       çok yüksek SE (soğurma frekansla/kalınlıkla hızla büyür).
 *   (B) AÇIKLIK BASKIN: aynı kalın duvar + büyük açıklık + yüksek frekans
 *       → kalkanlamayı AÇIKLIK belirler, duvar kalınlığı önemsiz kalır
 *       (EMC'nin temel kuralı: en zayıf halka açıklıktır, alan değil boyut).
 *   (C) FREKANS TARAMASI: birden çok tehdit frekansında EN KÖTÜ durum
 *       seçiliyor (tek bir "iyi" frekansa güvenilmiyor).
 *   (D) BAĞIMSIZ YOLLARIN GÜÇ-ALANI BİRLEŞİMİ: zayıf yol baskın çıkıyor.
 *   (E) ÇOKLU-YANSIMA DÜZELTMESİNİN DEJENERE UÇ DURUMU: A≈0 iken -Infinity
 *       yerine sonlu bir değer dönüyor (sayısal kırılganlık yok).
 *   (F) BİLİNMEYEN MALZEME: açıkça reddediliyor (sessiz varsayılan yok).
 *   (G) EMİSYON TESPİT EDİLEBİLİRLİĞİ: iyi kalkanlanmış kafes → gürültü
 *       tabanının altına düşer (bastırılmış); açıklığı büyük/sızdıran
 *       kafes → yakın mesafede hâlâ tespit edilebilir kalır.
 *   (H) GERÇEKÇİ SAAT HARMONİKLERİ: projenin KENDİ zamanlama modelinde
 *       (timetag_acquisition_bridge.js) lazer darbe TEKRAR frekansı
 *       periodPs=1000 ps → TEMEL frekans tam olarak 1 GHz. Ama bu periyodik
 *       bir DAR DARBE treni (darbe genişliği periyottan çok daha kısa) —
 *       Fourier analizi gereği böyle bir sinyalin spektrumu temel frekansın
 *       TEK KATLARINDA (3, 5, 7, 9 GHz…) güçlü enerji taşır. Bu donanım
 *       seçimine bağlı bir varsayım DEĞİL, periyodik darbe trenlerinin
 *       matematiksel bir sonucudur. Dolayısıyla kalkanlama değerlendirmesini
 *       yalnızca 1 GHz'e kadar taramak GERÇEK tehdidi hafife alır: aynı
 *       kafes tasarımı (2mm çelik + 5mm açıklık) 1 GHz'de zaten hedefin
 *       altındayken (29,5 dB < 60 dB), 19. harmonikte (19 GHz) DAHA DA
 *       kötüleşir — açıklık kaynaklı sızıntı frekansla birlikte MONOTON
 *       kötüleşir (rezonansa kadar, bkz. apertureLeakageDb).
 *   (I) DÜZELTİLMİŞ TASARIM: (H)'de bulunan açığı KAPATIYOR — sadece
 *       açıklığı küçültmek (honeycomb olmadan) 19 GHz'de 60 dB için ~8
 *       mikrometreye inmeyi gerektirir (PRATİK DEĞİL). Bunun yerine
 *       gerçekçi bir açıklık (3mm) + honeycomb dalga-kılavuzu-altı
 *       tünel derinliği (9mm, 3:1 oran — gerçek EMC honeycomb vent
 *       panellerinde yaygın kullanılan oran) eklenince AYNI 1-19 GHz
 *       harmonik taramasında hedef (60 dB) RAHATÇA tutturulur.
 *   + ÇEKİRDEK DOKUNULMADI: bu modül photonnet_core.js'i import ETMEZ
 *     (kaynakta doğrulanır) ve dosyanın SHA-256'sı test öncesi/sonrası
 *     değişmez (house convention: production_gate_test.js ile aynı ilke).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const F = require("./faraday_cage_shielding.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) DÜZ DUVAR BASKIN ══
  const wall = F.evaluateFaradayCage({ materialName: "copper", thicknessMm: 1.0, apertureMaxDimMm: 0, freqHz: 1e5, targetSeDb: 60 });
  out.wallDominant = { combinedSeDb: wall.worst.combinedSeDb, bottleneck: wall.worst.bottleneck, ok: wall.ok };
  chk("(A) DÜZ DUVAR BASKIN: 1mm bakır, açıklık yok, 100 kHz → çok yüksek SE (>150 dB), hedefi (60 dB) rahat aşar",
    wall.ok && wall.worst.bottleneck === "wall" && wall.worst.combinedSeDb > 150,
    `1mm bakır/100kHz, açıklık yok: birleşik SE ${wall.worst.combinedSeDb.toFixed(1)} dB (darboğaz: duvar) — ` +
    `soğurma kalınlık×√frekans ile hızla büyür, hedef ${wall.targetSeDb} dB'yi büyük marjla aşıyor`);

  // ══ (B) AÇIKLIK BASKIN ══
  const aperture = F.evaluateFaradayCage({ materialName: "copper", thicknessMm: 1.0, apertureMaxDimMm: 50, freqHz: 1e9, targetSeDb: 60 });
  out.apertureDominant = { combinedSeDb: aperture.worst.combinedSeDb, bottleneck: aperture.worst.bottleneck,
    wallSeDb: aperture.worst.wallSeDb, apertureSeDb: aperture.worst.apertureSeDb, ok: aperture.ok };
  chk("(B) AÇIKLIK BASKIN: AYNI 1mm bakır duvar + 50mm açıklık + 1 GHz → kalkanlamayı açıklık belirler, kapı hedefi TUTTURAMAZ",
    !aperture.ok && aperture.worst.bottleneck === "aperture" && aperture.worst.wallSeDb > 1000 && aperture.worst.combinedSeDb < 15,
    `duvar tek başına SE ${aperture.worst.wallSeDb.toFixed(0)} dB (mükemmel) ama 50mm açıklık ile birleşik SE yalnız ` +
    `${aperture.worst.combinedSeDb.toFixed(1)} dB < hedef ${aperture.targetSeDb} dB — EMC kuralı doğrulandı: darboğaz açıklık, duvar kalınlığı değil`);

  // ══ (C) FREKANS TARAMASI: en kötü durum seçilir ══
  const sweep = F.evaluateFaradayCage({ materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 5, freqRangeHz: [1e7, 1e8, 1e9], targetSeDb: 60 });
  const worstIsHighestFreq = sweep.worst.freqHz === 1e9;
  out.sweep = { worstFreqHz: sweep.worst.freqHz, combinedSeDb: sweep.worst.combinedSeDb, perFreqCount: sweep.perFreq.length, ok: sweep.ok };
  chk("(C) FREKANS TARAMASI: 3 tehdit frekansı arasından EN KÖTÜ (en yüksek frekans → en küçük açıklık-dalga-boyu oranı) seçiliyor",
    sweep.perFreq.length === 3 && worstIsHighestFreq && sweep.worst.combinedSeDb === Math.min(...sweep.perFreq.map(p => p.combinedSeDb)),
    `2mm çelik + 5mm açıklık, {10, 100, 1000} MHz taraması: en kötü nokta ${(sweep.worst.freqHz / 1e6).toFixed(0)} MHz'de ` +
    `SE ${sweep.worst.combinedSeDb.toFixed(1)} dB — kapı tek bir "iyi" frekansa güvenmiyor, hepsini denetliyor`);

  // ══ (D) BAĞIMSIZ YOLLARIN GÜÇ-ALANI BİRLEŞİMİ ══
  const combined = F.combineShieldingPathsDb([100, 20, Infinity]);
  out.pathCombination = { inputsDb: [100, 20, Infinity], combinedSeDb: +combined.toFixed(2) };
  chk("(D) BAĞIMSIZ YOL BİRLEŞİMİ: [100 dB, 20 dB, sızıntı-yok] güç alanında birleşince ZAYIF yol (20 dB) baskın çıkar",
    Math.abs(combined - 20) < 0.1,
    `combineShieldingPathsDb([100, 20, ∞]) = ${combined.toFixed(2)} dB ≈ 20 dB — en zayıf yol, güçlü yolları maskeler ` +
    `(100 dB'lik duvar, 20 dB'lik bir açıklığı telafi edemez)`);

  // ══ (E) ÇOKLU-YANSIMA DÜZELTMESİ — DEJENERE UÇ DURUM ══
  const bZero = F.multipleReflectionCorrectionDb(0);
  const bMid = F.multipleReflectionCorrectionDb(7);
  const bHigh = F.multipleReflectionCorrectionDb(20);
  out.multiReflectionEdge = { bAt0: bZero, bAt7: +bMid.toFixed(2), bAt20: bHigh };
  chk("(E) ÇOKLU-YANSIMA UÇ DURUMU: A≈0 iken SONLU değer döner (−Infinity yok), A≥15 dB'de düzeltme sıfırlanır",
    Number.isFinite(bZero) && bZero < 0 && bMid < 0 && bHigh === 0,
    `B(A=0)=${bZero} dB (sonlu, dejenere durum korunuyor) · B(A=7 dB)=${bMid.toFixed(2)} dB · B(A=20 dB)=${bHigh} dB (A≥15 dB'de anlamsız → 0)`);

  // ══ (F) BİLİNMEYEN MALZEME ══
  let threw = false, errMsg = "";
  try { F.material("unobtainium"); } catch (e) { threw = true; errMsg = e.message; }
  out.unknownMaterial = { threw, errMsg };
  chk("(F) BİLİNMEYEN MALZEME: sessiz varsayılan YOK, açıkça reddediliyor",
    threw && /Bilinmeyen/.test(errMsg),
    `material("unobtainium") → hata: "${errMsg}"`);

  // ══ (G) EMİSYON TESPİT EDİLEBİLİRLİĞİ ══
  const shielded = F.emissionDetectabilityCheck({
    sourceLevelDbuVm: 80,
    cage: { materialName: "copper", thicknessMm: 1.0, apertureMaxDimMm: 0, freqHz: 1e8, targetSeDb: 60 },
    observerDistanceM: 3, noiseFloorDbuVm: 20,
  });
  const leaky = F.emissionDetectabilityCheck({
    sourceLevelDbuVm: 80,
    cage: { materialName: "copper", thicknessMm: 1.0, apertureMaxDimMm: 100, freqHz: 1e9, targetSeDb: 60 },
    observerDistanceM: 1, noiseFloorDbuVm: 20,
  });
  out.detectability = {
    shielded: { detectable: shielded.detectable, receivedDbuVm: shielded.receivedDbuVm, noiseFloorDbuVm: shielded.noiseFloorDbuVm },
    leaky: { detectable: leaky.detectable, receivedDbuVm: leaky.receivedDbuVm, noiseFloorDbuVm: leaky.noiseFloorDbuVm },
  };
  chk("(G) EMİSYON TESPİT EDİLEBİLİRLİĞİ: iyi kalkanlanmış kafes → gürültü tabanı altına düşer; büyük açıklıklı kafes → yakında hâlâ tespit edilebilir",
    !shielded.detectable && leaky.detectable,
    `iyi kalkanlanmış (açıklık yok, 100 MHz, 3 m): alınan ${shielded.receivedDbuVm} dBµV/m < gürültü tabanı ${shielded.noiseFloorDbuVm} dBµV/m → bastırılmış ✓ · ` +
    `sızdıran (100mm açıklık, 1 GHz, 1 m): alınan ${leaky.receivedDbuVm} dBµV/m > gürültü tabanı ${leaky.noiseFloorDbuVm} dBµV/m → hâlâ tespit edilebilir ✓`);

  // ══ (H) GERÇEKÇİ SAAT HARMONİKLERİ ══
  // Proje kendi zamanlama modelinde periodPs=1000 ps kullanıyor
  // (bkz. timetag_acquisition_bridge.js) → temel tekrar frekansı 1 GHz.
  const fFundamentalHz = 1e9;
  const harmonics = [1, 2, 3, 5, 7, 9, 11, 13, 15, 19].map(n => n * fFundamentalHz);
  const cageCfg = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 5 };
  const upTo1GHz = F.evaluateFaradayCage({ ...cageCfg, freqRangeHz: [1e7, 1e8, 1e9], targetSeDb: 60 });
  const withHarmonics = F.evaluateFaradayCage({ ...cageCfg, freqRangeHz: harmonics, targetSeDb: 60 });
  const worstHarmonicIsAbove1GHz = withHarmonics.worst.freqHz > 1e9;
  const worseThanFundamental = withHarmonics.worst.combinedSeDb < upTo1GHz.worst.combinedSeDb;
  out.clockHarmonics = {
    fundamentalHz: fFundamentalHz, harmonicsTestedHz: harmonics,
    combinedSeAt1GHzDb: +upTo1GHz.worst.combinedSeDb.toFixed(2),
    worstCombinedSeDb: +withHarmonics.worst.combinedSeDb.toFixed(2),
    worstFreqHz: withHarmonics.worst.freqHz,
    perHarmonic: withHarmonics.perFreq.map(p => ({ freqHz: p.freqHz, combinedSeDb: +p.combinedSeDb.toFixed(2) })),
  };
  chk("(H) GERÇEKÇİ SAAT HARMONİKLERİ: 1 GHz temel + tek katları (3-19 GHz) — sadece 1 GHz'e kadar tarama YETERSİZ, gerçek en kötü durum daha yüksek harmonikte VE daha kötü",
    worstHarmonicIsAbove1GHz && worseThanFundamental && harmonics.every(h => h >= 1e9),
    `temel 1 GHz'de birleşik SE ${upTo1GHz.worst.combinedSeDb.toFixed(1)} dB (zaten hedefin altında) → ${(withHarmonics.worst.freqHz / 1e9).toFixed(0)} GHz harmonikte ${withHarmonics.worst.combinedSeDb.toFixed(1)} dB'ye DÜŞÜYOR. ` +
    `Bu donanım seçimine bağlı bir varsayım değil — periyodik dar darbe treninin Fourier spektrumu temel frekansın tek katlarında güçlü enerji taşır (matematiksel gerçek). ` +
    `SONUÇ: mevcut kafes tasarımı (2mm çelik + 5mm açıklık) ne 1 GHz'de ne de harmoniklerde hedefi (60 dB) tutturuyor — açıklık küçültülmeli veya derinlikli honeycomb filtre kullanılmalı (bkz. modül dürüstlük notu)`);

  // ══ (I) DÜZELTİLMİŞ TASARIM ══
  // Seçenek 1: honeycomb OLMADAN, sadece küçültme — 19 GHz'de 60 dB için
  // gereken açıklık boyutu (pratik olup olmadığını göstermek için).
  const lambdaAt19GhzMm = 299792458000 / 19e9;
  const requiredApertureMmNoHoneycomb = lambdaAt19GhzMm / (2 * 1000); // 20log10(λ/2L)=60 → λ/2L=1000
  // Seçenek 2 (SEÇİLEN DÜZELTME): pratik açıklık + honeycomb derinliği.
  const fixedCfg = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 3, honeycombDepthMm: 9, freqRangeHz: harmonics, targetSeDb: 60 };
  const fixed = F.evaluateFaradayCage(fixedCfg);
  out.fixedDesign = {
    requiredApertureUmNoHoneycomb: +(requiredApertureMmNoHoneycomb * 1000).toFixed(2),
    apertureMaxDimMm: fixedCfg.apertureMaxDimMm, honeycombDepthMm: fixedCfg.honeycombDepthMm,
    ratio: fixedCfg.honeycombDepthMm / fixedCfg.apertureMaxDimMm,
    ok: fixed.ok, worstCombinedSeDb: +fixed.worst.combinedSeDb.toFixed(1), worstFreqHz: fixed.worst.freqHz, marginDb: fixed.marginDb,
    perHarmonic: fixed.perFreq.map(p => ({ freqHz: p.freqHz, combinedSeDb: +p.combinedSeDb.toFixed(1) })),
  };
  chk("(I) DÜZELTİLMİŞ TASARIM: sadece küçültme PRATİK DEĞİL (mikrometre mertebesi); açıklık+honeycomb tüm harmoniklerde (1-19 GHz) hedefi tutturuyor",
    requiredApertureMmNoHoneycomb < 0.1 && fixed.ok && fixed.perFreq.every(p => p.combinedSeDb >= 60),
    `honeycomb'suz çözüm: 19 GHz'de 60 dB için açıklık ≤ ${(requiredApertureMmNoHoneycomb * 1000).toFixed(1)} µm olmalı — PRATİK DEĞİL. ` +
    `Düzeltme: ${fixedCfg.apertureMaxDimMm} mm açıklık + ${fixedCfg.honeycombDepthMm} mm honeycomb derinliği (oran ${(fixedCfg.honeycombDepthMm / fixedCfg.apertureMaxDimMm).toFixed(0)}:1) ` +
    `→ 1-19 GHz taramasının TAMAMINDA hedef tutturuluyor, en kötü durum ${fixed.worst.combinedSeDb.toFixed(1)} dB @ ${(fixed.worst.freqHz / 1e9).toFixed(0)} GHz (marj +${fixed.marginDb} dB)`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const src = fs.readFileSync(path.join(__dirname, "faraday_cage_shielding.js"), "utf8");
  const noCoreImport = !/require\(["']\.\/photonnet_core\.js["']\)/.test(src);
  const hashAfter = coreHash();
  out.coreIntegrity = { noCoreImport, unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: faraday_cage_shielding.js photonnet_core.js'i import ETMEZ VE dosyanın SHA-256'sı değişmedi",
    noCoreImport && hashBefore === hashAfter,
    `kaynakta core import taraması: ${noCoreImport ? "yok ✓" : "BULUNDU ✗"} · SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası ✓ ` +
    `— bu katman çekirdekten TAMAMEN bağımsız, kendi başına test edilebilir bir fizik hesaplayıcısı`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "faraday_cage_shielding.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ EK KATMAN — Faraday kafesi EM kalkanlama etkinliği ══\n");
  console.log(`  (A) düz duvar baskın: ${out.wallDominant.combinedSeDb.toFixed(1)} dB (${out.wallDominant.bottleneck})`);
  console.log(`  (B) açıklık baskın: ${out.apertureDominant.combinedSeDb.toFixed(1)} dB (${out.apertureDominant.bottleneck}) — duvar tek başına ${out.apertureDominant.wallSeDb.toFixed(0)} dB idi`);
  console.log(`  (C) frekans taraması: en kötü ${(out.sweep.worstFreqHz / 1e6).toFixed(0)} MHz'de ${out.sweep.combinedSeDb.toFixed(1)} dB (${out.sweep.perFreqCount} frekans tarandı)`);
  console.log(`  (D) yol birleşimi [100,20,∞] dB → ${out.pathCombination.combinedSeDb} dB`);
  console.log(`  (E) çoklu-yansıma uç durum: B(0)=${out.multiReflectionEdge.bAt0} dB · B(7)=${out.multiReflectionEdge.bAt7} dB · B(20)=${out.multiReflectionEdge.bAt20} dB`);
  console.log(`  (F) bilinmeyen malzeme reddi: ${out.unknownMaterial.threw ? "✓" : "✗"}`);
  console.log(`  (G) tespit edilebilirlik: kalkanlı=${out.detectability.shielded.detectable} (${out.detectability.shielded.receivedDbuVm} dBµV/m) · sızdıran=${out.detectability.leaky.detectable} (${out.detectability.leaky.receivedDbuVm} dBµV/m)`);
  console.log(`  (H) saat harmonikleri: 1 GHz'de ${out.clockHarmonics.combinedSeAt1GHzDb} dB → ${(out.clockHarmonics.worstFreqHz / 1e9).toFixed(0)} GHz'de ${out.clockHarmonics.worstCombinedSeDb} dB (daha kötü)`);
  console.log(`  (I) düzeltilmiş tasarım: ${out.fixedDesign.apertureMaxDimMm}mm açıklık + ${out.fixedDesign.honeycombDepthMm}mm honeycomb → en kötü ${out.fixedDesign.worstCombinedSeDb} dB, ok=${out.fixedDesign.ok}`);
  console.log(`\n  ÇEKİRDEK: import yok=${out.coreIntegrity.noCoreImport ? "✓" : "✗"} · SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "faraday_cage_shielding.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
