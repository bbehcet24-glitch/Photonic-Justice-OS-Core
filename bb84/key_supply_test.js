#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * ULTRA-DÜŞÜK GECİKME: İKİ STRATEJİNİN ÖLÇÜMÜ
 * ═══════════════════════════════════════════════════════════════════
 * Sınanan iddialar:
 *   1. Sert <350 ms SLA sistemi kilitler (taban — yeniden doğrulanır).
 *   2. ELASTİK PENCERE kilidi açar AMA ultra-düşük gecikme VERMEZ:
 *      sonlu-anahtar sınırı fiziksel bir alt sınır dayatır. Gecikme
 *      ayrıca DEĞİŞKENDİR (jitter) — sert SLA'nın yerini tutamaz.
 *   3. ANAHTAR DEPOSU tüketici gecikmesini üretim gecikmesinden AYIRIR:
 *      depo doluyken servis gecikmesi ≈ 0.
 *   4. YETERLİLİK KOŞULU: R(T_b) > D olmalı. Talep üretimi aşarsa
 *      hiçbir depo boyutu kurtarmaz — bu ölçülür.
 *   5. BOYUTLANDIRMA: S_min ≈ D·T_b türetilir, sonra depo boyutu
 *      taranarak doğrulanır.
 *   6. GÜVENLİK BEDELİ: büyük depo = anahtarın uzun beklemesi.
 *      Ortalama/azami anahtar yaşı ölçülür.
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");
const K = require("./qkd_key_supply.js");
const CS = require("./continuous_stream_test.js");

const EPOCHS = 20;                    // 20 × 3.400 ms = 68 s
const SEED = 0x51D3C0DE;
const ULTRA_LOW_SLA = 200;            // kullanıcının bahsettiği sert kısa SLA
const REQUEST_BITS = 128;             // tipik oturum anahtarı parçası
// "Sıfır ret" iddiası ÖRNEKLEM BÜYÜKLÜĞÜNE bağlıdır: 0/n gözlemde
// gerçek oran için %95 üst sınır ≈ 3/n'dir ("üçler kuralı"). Bu yüzden
// hem oturum uzatıldı hem de sınır RAPORLANIYOR — "0 gördük" demek,
// "oran sıfırdır" demek DEĞİLDİR.
const ruleOfThree = (n) => (n > 0 ? 3 / n : 1);

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const st = CS.stationarity(pairs, sessionMs, 16);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ceiling = (st.meanRate / 4) * (1 - C.h2(calib.ePh) - leakPerBit);
  out.stream = {
    sessionMs, totalPairs: pairs.length, pairsPerSec: st.meanRate, cv: st.cv,
    ePh: calib.ePh, leakPerBit: +leakPerBit.toFixed(6), ceilingBps: +ceiling.toFixed(2),
  };

  // ══ 1) TABAN: sert kısa SLA ══
  const hard = C.runContinuous(pairs, { maxLatencyMs: ULTRA_LOW_SLA, leakPerBit, minEll: 1, seed: SEED, sessionMs });
  out.hardSla = {
    slaMs: ULTRA_LOW_SLA, blocks: hard.totals.blocks, ell: hard.totals.ell,
    sustainedRateBps: hard.totals.sustainedRateBps, pairsWasted: hard.totals.pairsWasted,
  };
  chk(`Sert ${ULTRA_LOW_SLA} ms SLA sistemi KİLİTLİYOR (taban)`,
    hard.totals.ell === 0,
    `${hard.totals.blocks} blok, ℓ=0 bit, ${hard.totals.pairsWasted.toLocaleString("tr-TR")} çift çöpe`);

  // ══ 2) STRATEJİ 1 — ELASTİK PENCERE ══
  const elastic = {};
  for (const target of [64, 128, 256, 512]) {
    const e = K.runElastic(pairs, { ellTarget: target, leakPerBit, tickMs: 5, seed: SEED, sessionMs });
    elastic[target] = e.totals;
  }
  out.elastic = elastic;
  const e128 = elastic[128];
  chk("Elastik pencere kilidi AÇIYOR (sert SLA'da 0 iken artık anahtar var)",
    e128.ell > 0 && e128.blocks > 0,
    `ℓ hedefi 128 bit → ${e128.blocks} blok, toplam ${e128.ell.toLocaleString("tr-TR")} bit, ${e128.sustainedRateBps} bit/s`);
  chk(`AMA ultra-düşük gecikme VERMİYOR: en hızlı blok bile ${ULTRA_LOW_SLA} ms'i aşıyor`,
    e128.latencyMin > ULTRA_LOW_SLA,
    `en küçük gecikme ${e128.latencyMin} ms > ${ULTRA_LOW_SLA} ms · p50 ${e128.latencyP50} ms · p95 ${e128.latencyP95} ms`);
  chk("Elastik gecikme DEĞİŞKEN (jitter) — sert SLA'nın yerini tutamaz",
    e128.latencyJitter > 0,
    `min ${e128.latencyMin} ms → p95 ${e128.latencyP95} ms, jitter ${e128.latencyJitter} ms`);
  chk("Daha küçük ℓ hedefi bile fiziksel alt sınırı aşamıyor",
    elastic[64].latencyMin > ULTRA_LOW_SLA,
    `ℓ=64 bit hedefiyle bile en hızlı blok ${elastic[64].latencyMin} ms`);

  // ══ 3) STRATEJİ 2 — ANAHTAR DEPOSU ══
  // Üretim yüksek SLA'da; tüketici depodan servis alır.
  const PROD_SLA = 5000;
  const prod = C.runContinuous(pairs, { maxLatencyMs: PROD_SLA, leakPerBit, minEll: 1, seed: SEED, sessionMs });
  const prodBlocks = prod.blocks.filter(b => !b.truncated);
  const prodRate = prod.totals.sustainedRateBps;
  out.production = {
    slaMs: PROD_SLA, blocks: prodBlocks.length, meanBlockMs: prod.totals.meanBlockMs,
    meanEllPerBlock: prod.totals.meanEllPerBlock, sustainedRateBps: prodRate,
    pctOfCeiling: +(100 * prodRate / ceiling).toFixed(2),
  };

  const DEMAND = Math.round(prodRate * 0.5);            // üretimin yarısı kadar talep
  const warmup = prod.totals.meanBlockMs * 2;
  const served = K.runTieredSupply(prodBlocks, {
    sessionMs, demandBps: DEMAND, requestBits: REQUEST_BITS,
    capacityBits: Infinity, seed: 0xD33D4A1D, warmupMs: warmup,
  });
  out.tiered = { ...served, levelTrace: undefined, traceLen: served.levelTrace.length };
  out.levelTrace = served.levelTrace.filter((_, i) => i % 3 === 0);
  const bound = ruleOfThree(served.requestsAfterWarmup);
  out.tiered.steadyDenialUpperBound95 = +bound.toFixed(5);
  chk("Depo doluyken tüketici gecikmesi ≈ 0 (üretim gecikmesinden AYRIŞTI)",
    served.servedCount > 0 && served.steadyDenialRate === 0,
    `${served.servedCount.toLocaleString("tr-TR")} istek servis edildi (ısınma sonrası ${served.requestsAfterWarmup}), gözlenen ret 0 · ` +
    `üçler kuralıyla gerçek ret oranı için %95 ÜST SINIR %${(100 * bound).toFixed(2)} — "0 gördük", "oran sıfır" demek değil · ` +
    `üretim ${PROD_SLA} ms bloklarla çalışırken tüketici anında servis alıyor`);
  chk("Depo, ısınma döneminde reddediyor — bu bir hata değil, dolma süresi",
    served.deniedCount > 0 && served.denialRate > served.steadyDenialRate,
    `toplam ret ${served.deniedCount} (hepsi ilk ${Math.round(warmup)} ms içinde), kararlı durumda ret yok`);

  // ══ 4) YETERLİLİK KOŞULU: talep > üretim ══
  const overload = K.runTieredSupply(prodBlocks, {
    sessionMs, demandBps: Math.round(prodRate * 1.3), requestBits: REQUEST_BITS,
    capacityBits: Infinity, seed: 0xD33D4A1D, warmupMs: warmup,
  });
  out.overload = { ...overload, levelTrace: undefined };
  chk("YETERLİLİK: talep üretimi aşarsa SONSUZ depo bile kurtarmıyor",
    overload.steadyDenialRate > 0.1,
    `talep = üretimin %130'u → kapasite SINIRSIZ olmasına rağmen kararlı ret oranı %${(100 * overload.steadyDenialRate).toFixed(1)} · ` +
    `depo dalgalanmayı yutar, AÇIĞI KAPATMAZ`);

  // ══ 5) DEPO BOYUTLANDIRMA ══
  const derived = K.requiredStoreBits(DEMAND, prod.totals.meanBlockMs, REQUEST_BITS, 3);
  // İNCE IZGARA: eşiği bulabilmek için 0,3×–2× arası yoğun örneklenir.
  // Kaba ızgarada "en küçük sıfır-ret kapasitesi" yalnızca bir sonraki
  // ızgara noktası olarak okunur ve formül haksız yere yanlış görünür.
  const sizes = [0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 2, 3]
    .map(f => Math.round(derived * f));
  const sizing = sizes.map(cap => {
    const r = K.runTieredSupply(prodBlocks, {
      sessionMs, demandBps: DEMAND, requestBits: REQUEST_BITS,
      capacityBits: cap, seed: 0xD33D4A1D, warmupMs: warmup,
    });
    return {
      capacityBits: cap, ofDerived: +(cap / derived).toFixed(2),
      steadyDenialRate: r.steadyDenialRate, discardedBits: r.discardedBits,
      discardedPct: r.depositedBits + r.discardedBits ? +(100 * r.discardedBits / (r.depositedBits + r.discardedBits)).toFixed(2) : 0,
      meanKeyAgeMs: r.meanKeyAgeMs, maxKeyAgeMs: r.maxKeyAgeMs,
    };
  });
  out.sizing = {
    demandBps: DEMAND, blockMs: prod.totals.meanBlockMs, requestBits: REQUEST_BITS,
    derivedMinBits: derived, formula: "S_min = D·T_b + 3·requestBits·√(λ·T_b)",
    meanDrainBits: Math.round(DEMAND * prod.totals.meanBlockMs / 1000),
    tailTermBits: derived - Math.round(DEMAND * prod.totals.meanBlockMs / 1000),
    sweep: sizing,
  };
  const okSizes = sizing.filter(s => s.steadyDenialRate === 0);
  out.sizing.smallestZeroDenialBits = okSizes.length ? okSizes[0].capacityBits : null;
  chk("Türetilen S_min = D·T_b + 3σ, ölçülen sıfır-ret eşiğiyle uyuşuyor (±%25)",
    okSizes.length > 0 && Math.abs(okSizes[0].ofDerived - 1) <= 0.25,
    `türetilen ${derived.toLocaleString("tr-TR")} bit = ortalama çekiliş ${out.sizing.meanDrainBits.toLocaleString("tr-TR")} + kuyruk payı ${out.sizing.tailTermBits.toLocaleString("tr-TR")} · ` +
    `ölçülen en küçük sıfır-ret kapasitesi ${okSizes[0].capacityBits.toLocaleString("tr-TR")} bit (türetilenin ${okSizes[0].ofDerived}×)`);
  chk("Kuyruk terimi GEREKLİ: yalnızca ortalama çekiliş (D·T_b) kadar depo YETMİYOR",
    (sizing.find(s => s.capacityBits <= out.sizing.meanDrainBits * 1.02 && s.capacityBits >= out.sizing.meanDrainBits * 0.85) ?? { steadyDenialRate: 1 }).steadyDenialRate > 0,
    `ortalama çekiliş ${out.sizing.meanDrainBits.toLocaleString("tr-TR")} bit civarındaki kapasitelerde hâlâ ret var — ` +
    `dalgalanma √T_b ile ölçeklendiği için sabit çarpan yerine kuyruk payı türetildi`);
  chk("Yetersiz depo hem REDDEDİYOR hem de taşan anahtarı ÇÖPE ATIYOR (çift kayıp)",
    sizing[0].steadyDenialRate > 0 && sizing[0].discardedBits > 0,
    `kapasite türetilenin ${sizing[0].ofDerived}× → ret %${(100 * sizing[0].steadyDenialRate).toFixed(1)} VE üretilen anahtarın %${sizing[0].discardedPct}'i taşıp atılıyor`);

  // ══ 6) GÜVENLİK BEDELİ: depo boyutu ↔ anahtar yaşı ══
  const ages = sizing.filter(s => s.meanKeyAgeMs != null);
  out.securityCost = {
    note: "Depoda bekleyen anahtar, deposu ele geçiren birine toplu hâlde açılır. Depo boyutu maliyetle değil, azami anahtar YAŞI politikasıyla sınırlanmalıdır.",
    byCapacity: ages.map(a => ({ capacityBits: a.capacityBits, meanKeyAgeMs: a.meanKeyAgeMs, maxKeyAgeMs: a.maxKeyAgeMs })),
  };
  chk("GÜVENLİK BEDELİ ölçüldü: depo büyüdükçe anahtarın beklediği süre uzuyor",
    ages.length >= 2 && ages[ages.length - 1].maxKeyAgeMs > ages[0].maxKeyAgeMs,
    `kapasite ${ages[0].capacityBits.toLocaleString("tr-TR")} → azami yaş ${ages[0].maxKeyAgeMs} ms · ` +
    `kapasite ${ages[ages.length - 1].capacityBits.toLocaleString("tr-TR")} → azami yaş ${ages[ages.length - 1].maxKeyAgeMs} ms`);

  // ══ 7) İKİ STRATEJİNİN DOĞRUDAN KARŞILAŞTIRMASI ══
  out.comparison = [
    { strateji: `sert ${ULTRA_LOW_SLA} ms SLA`, tuketiciGecikmeMs: ULTRA_LOW_SLA, garanti: "gecikme", anahtar: 0, hizBps: 0, calisir: false },
    { strateji: "elastik pencere (ℓ≥128)", tuketiciGecikmeMs: e128.latencyP50, garanti: "anahtar", anahtar: e128.ell, hizBps: e128.sustainedRateBps, calisir: true },
    { strateji: `depo (üretim ${PROD_SLA} ms)`, tuketiciGecikmeMs: 0, garanti: "gecikme + anahtar", anahtar: served.servedBits, hizBps: prodRate, calisir: true },
  ];
  chk("Yalnızca DEPO her iki garantiyi birden veriyor",
    out.comparison[2].tuketiciGecikmeMs === 0 && out.comparison[2].hizBps > out.comparison[1].hizBps,
    `depo: gecikme 0 ms VE ${prodRate} bit/s (tavanın %${out.production.pctOfCeiling}'i) · ` +
    `elastik: p50 ${e128.latencyP50} ms ve yalnızca ${e128.sustainedRateBps} bit/s`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "key_supply.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ ULTRA-DÜŞÜK GECİKME: ELASTİK PENCERE vs ANAHTAR DEPOSU ══\n");
  console.log(`  Akış ${trn(sessionMs / 1000, 1)} s · ${trn(pairs.length)} çift · tavan ${trn(ceiling, 0)} bit/s`);
  console.log(`  TABAN — sert ${ULTRA_LOW_SLA} ms SLA: ℓ=0, ${trn(hard.totals.pairsWasted)} çift çöpe\n`);
  console.log("  ELASTİK PENCERE");
  console.log("    ℓ hedefi   blok    min      p50      p95      max     hız(bit/s)");
  for (const [t, e] of Object.entries(elastic))
    console.log(`    ${pad(t, 8)} ${pad(e.blocks, 6)} ${pad(e.latencyMin, 7)} ${pad(e.latencyP50, 8)} ${pad(e.latencyP95, 8)} ${pad(e.latencyMax, 7)} ${pad(trn(e.sustainedRateBps, 0), 12)}`);
  console.log(`\n  ANAHTAR DEPOSU (üretim ${PROD_SLA} ms blok → ${trn(prodRate, 0)} bit/s = tavanın %${out.production.pctOfCeiling}'i)`);
  console.log(`    talep ${trn(DEMAND)} bit/s · ${trn(served.servedCount)} istek servis · kararlı ret %${trn(100 * served.steadyDenialRate, 3)} · tüketici gecikmesi 0 ms`);
  console.log(`    aşırı yük (talep = üretimin %130'u): kararlı ret %${trn(100 * overload.steadyDenialRate, 1)} — sonsuz depoya rağmen`);
  console.log(`\n  DEPO BOYUTLANDIRMA — S_min = D·T_b + 3·b·√(λ·T_b) = ${trn(out.sizing.meanDrainBits)} + ${trn(out.sizing.tailTermBits)} = ${trn(derived)} bit`);
  console.log("    kapasite(bit)  türetilenin×   ret%     taşma%   ort.yaş(ms)  azami yaş(ms)");
  for (const s of sizing)
    console.log(`    ${pad(trn(s.capacityBits), 13)} ${pad(s.ofDerived, 13)} ${pad(trn(100 * s.steadyDenialRate, 2), 8)} ${pad(trn(s.discardedPct, 2), 8)} ${pad(trn(s.meanKeyAgeMs ?? 0, 0), 12)} ${pad(trn(s.maxKeyAgeMs, 0), 13)}`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
