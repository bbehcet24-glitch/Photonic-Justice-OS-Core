#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * HİBRİT GÖREV DÖNGÜSÜ — BAZ EŞLEŞME VERİMİ ÖLÇÜMÜ
 * ═══════════════════════════════════════════════════════════════════
 * Hedef "baz eşleşme verimini 4,5 kat artırmak" olarak konuldu. Bu sayı
 * TEK BAŞINA anlamlı değildir: hangi tabana ve hangi ölçüte göre?
 * Olası eşleştirmeler ölçülüp ayrı ayrı raporlanır:
 *
 *   taban                       anahtar turu oranı
 *   E91 (3×3 ızgara)            1/9  ≈ 0,111
 *   BBM92 yansız, anahtar bazı   1/4  = 0,250
 *   BBM92 yansız, TÜM eleme      1/2  = 0,500
 *
 * "×4,5" tam olarak 0,500 / 0,111 oranıdır — yani BB84'ün TOPLAM
 * elemesini E91'in ANAHTAR turlarıyla kıyaslar. Bu apples-to-oranges
 * bir eşleştirmedir; aynı ölçüt (anahtar turu) kullanıldığında yansız
 * BBM92/E91 oranı 2,25'tir. Modül bu yüzden sabit bir hedef sayıyı
 * kovalamaz, ULAŞILABİLİR kazancı ölçer ve nereden geldiğini gösterir.
 *
 * Sınananlar:
 *   1. Yanlı baz seçimi anahtar turu oranını p² kadar yükseltiyor.
 *   2. p'nin İÇ OPTİMUMU var (PE örneklemi çökünce μ patlıyor) ve
 *      optimum blok boyutuyla birlikte 1'e yaklaşıyor.
 *   3. ℓ kazancı, baz eşleşme kazancından KÜÇÜK (μ bedeli).
 *   4. Bell görev döngüsü sertifikayı sürdürüyor.
 *   5. Güvenlik değişmezleri korunuyor (e_bit = 0, e_ph X'ten).
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");
const CS = require("./continuous_stream_test.js");
const DC = require("./bb84_e91_duty_cycle.js");

const EPOCHS = 8;                    // 8 × 3.400 ms = 27,2 s
const SEED = 0x51D3C0DE;
const F_BELL = 0.01;                 // turların %1'i Bell sertifikasına

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ePh = calib.ePh;
  out.stream = { sessionMs, totalPairs: pairs.length, ePh, leakPerBit: +leakPerBit.toFixed(6) };

  // ══ 1) TABANLAR — ölçülür, varsayılmaz ══
  const e91 = DC.e91BasisFractions(pairs);
  const unbiased = DC.dutyCycleMeasure(pairs, { pKey: 0.5, fBell: 0, seed: 0x0DDC1CE5 });
  out.baselines = {
    e91: e91,
    bbm92Unbiased: {
      keyRoundFraction: unbiased.keyRoundFraction,
      peRoundFraction: unbiased.peRoundFraction,
      basisMatchFraction: unbiased.basisMatchFraction,
    },
    claimedTarget: 4.5,
    whereTheClaimComesFrom: {
      ratio_bbm92AllSifted_over_e91Key: +(unbiased.basisMatchFraction / e91.keyRoundFraction).toFixed(2),
      ratio_bbm92Key_over_e91Key: +(unbiased.keyRoundFraction / e91.keyRoundFraction).toFixed(2),
      note: "×4,5 ≈ BB84'ün TÜM elemesi ÷ E91'in ANAHTAR turları. Aynı ölçütle (anahtar turu) oran 2,25'tir.",
    },
  };
  chk("Ölçülen tabanlar teorik oranlarla uyuşuyor (E91 1/9 ve 1/9, BBM92 1/4 ve 1/2)",
    Math.abs(e91.keyRoundFraction - 1 / 9) < 0.005 && Math.abs(unbiased.keyRoundFraction - 0.25) < 0.005 &&
    Math.abs(unbiased.basisMatchFraction - 0.5) < 0.006,
    `E91 anahtar ${e91.keyRoundFraction} (≈0,111) · BBM92 anahtar ${unbiased.keyRoundFraction} (≈0,250), eleme ${unbiased.basisMatchFraction} (≈0,500)`);
  chk('"×4,5" iddiası, ölçümle TAM OLARAK BB84-eleme ÷ E91-anahtar oranına denk geliyor',
    Math.abs(out.baselines.whereTheClaimComesFrom.ratio_bbm92AllSifted_over_e91Key - 4.5) < 0.15,
    `ölçülen oran ${out.baselines.whereTheClaimComesFrom.ratio_bbm92AllSifted_over_e91Key} — ama aynı ölçütle karşılaştırınca (anahtar/anahtar) ${out.baselines.whereTheClaimComesFrom.ratio_bbm92Key_over_e91Key}`);

  // ══ 2) YANLILIK TARAMASI (blok = tüm akış) ══
  const N = pairs.length;
  const sweep = [];
  for (const p of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98]) {
    const r = DC.runDutyCycle(pairs, { pKey: p, fBell: F_BELL, seed: 0x0DDC1CE5 });
    sweep.push({
      pKey: p, keyRounds: r.keyRounds, peRounds: r.peRounds, bellRounds: r.bellRounds,
      keyRoundFraction: r.keyRoundFraction, mu: r.mu, ePh: r.ePh, eBit: r.eBit, ell: r.ell,
      basisGainVsUnbiased: +(r.keyRoundFraction / unbiased.keyRoundFraction).toFixed(3),
      basisGainVsE91: +(r.keyRoundFraction / e91.keyRoundFraction).toFixed(3),
    });
  }
  out.biasSweep = sweep;
  const bestMeasured = sweep.reduce((a, b) => (b.ell > a.ell ? b : a));
  out.bestMeasured = bestMeasured;

  const derived = DC.optimalBias(N, ePh, leakPerBit, { fBell: F_BELL });
  out.derivedOptimum = { rounds: N, ...derived };
  chk("Yanlı baz seçimi anahtar turu oranını p² kadar yükseltiyor (ölçüm ≈ teori)",
    sweep.every(s => Math.abs(s.keyRoundFraction - s.pKey * s.pKey * (1 - F_BELL)) < 0.006),
    sweep.map(s => `p=${s.pKey}→${s.keyRoundFraction}`).join(" · "));
  chk("p'nin İÇ OPTİMUMU var: p→1'de ℓ tekrar düşüyor (PE örneklemi çöküyor)",
    sweep[sweep.length - 1].ell < bestMeasured.ell,
    `en iyi ölçülen p=${bestMeasured.pKey} → ℓ=${bestMeasured.ell.toLocaleString("tr-TR")} · p=${sweep[sweep.length - 1].pKey} → ℓ=${sweep[sweep.length - 1].ell.toLocaleString("tr-TR")} (μ ${sweep[sweep.length - 1].mu})`);
  chk("Türetilen p*, ölçülen en iyi p ile uyuşuyor (±0,08)",
    Math.abs(derived.p - bestMeasured.pKey) <= 0.08,
    `türetilen p* = ${derived.p} (öngörülen ℓ ${derived.ellPredicted.toLocaleString("tr-TR")}) · ölçülen en iyi p = ${bestMeasured.pKey} (ℓ ${bestMeasured.ell.toLocaleString("tr-TR")})`);

  // ══ 3) KAZANÇ — HANGİ ÖLÇÜT, HANGİ TABAN ══
  const base = sweep[0];                                    // p=0,5, Bell açık
  out.gains = {
    basisMatchGainVsUnbiased: bestMeasured.basisGainVsUnbiased,
    basisMatchGainVsE91: bestMeasured.basisGainVsE91,
    ellGainVsUnbiased: +(bestMeasured.ell / base.ell).toFixed(3),
    note: "Baz eşleşme kazancı ile ℓ kazancı AYNI DEĞİLDİR: anahtar turu artarken PE örneklemi küçülür ve μ büyür.",
  };
  chk("ℓ kazancı, baz eşleşme kazancından KÜÇÜK (μ bedeli gerçek)",
    out.gains.ellGainVsUnbiased < out.gains.basisMatchGainVsUnbiased,
    `baz eşleşme ×${out.gains.basisMatchGainVsUnbiased} ama ℓ ×${out.gains.ellGainVsUnbiased} — aradaki fark μ'nün bedeli`);
  chk("Hedeflenen ×4,5, E91 tabanına göre AŞILIYOR; yansız BBM92 tabanına göre aşılmıyor",
    bestMeasured.basisGainVsE91 > 4.5 && bestMeasured.basisGainVsUnbiased < 4.5,
    `E91'e göre ×${bestMeasured.basisGainVsE91} (>4,5 ✓) · yansız BBM92'ye göre ×${bestMeasured.basisGainVsUnbiased} (<4,5) — ` +
    `4 kat teorik tavandır (¼→1) ve sonlu blokta ulaşılamaz`);

  // ══ 4) KAZANÇ BLOK BOYUTUYLA BÜYÜYOR ══
  // p* → 1 olduğu için kazanç da N ile artar. Türetilerek gösterilir,
  // ölçülebilen aralıkta ölçümle DOĞRULANIR.
  const scale = [];
  for (const frac of [0.02, 0.05, 0.1, 0.25, 0.5, 1]) {
    const sub = pairs.slice(0, Math.round(N * frac));
    const d = DC.optimalBias(sub.length, ePh, leakPerBit, { fBell: F_BELL });
    const meas = DC.runDutyCycle(sub, { pKey: d.p, fBell: F_BELL, seed: 0x0DDC1CE5 });
    const basePer = DC.runDutyCycle(sub, { pKey: 0.5, fBell: F_BELL, seed: 0x0DDC1CE5 });
    scale.push({
      rounds: sub.length, derivedP: d.p,
      keyRoundFraction: meas.keyRoundFraction,
      basisGainVsUnbiased: +(meas.keyRoundFraction / basePer.keyRoundFraction).toFixed(3),
      ell: meas.ell, ellBase: basePer.ell,
      ellGain: basePer.ell > 0 ? +(meas.ell / basePer.ell).toFixed(3) : null,
    });
  }
  out.scaleWithBlockSize = scale;
  chk("Optimum yanlılık ve kazanç, blok boyutu büyüdükçe ARTIYOR",
    scale[scale.length - 1].derivedP > scale[0].derivedP &&
    scale[scale.length - 1].basisGainVsUnbiased > scale[0].basisGainVsUnbiased,
    scale.map(s => `${s.rounds.toLocaleString("tr-TR")} tur → p*=${s.derivedP}, ×${s.basisGainVsUnbiased}`).join(" · "));

  // Teorik tavan: p→1 iken anahtar turu (1−f_bell) → kazanç 4×(1−f)
  const theoretical = (1 - F_BELL) / unbiased.keyRoundFraction;
  out.theoreticalCeiling = +theoretical.toFixed(3);
  chk("Ölçülen kazanç teorik tavanı (×4) AŞMIYOR",
    scale.every(s => s.basisGainVsUnbiased <= theoretical * 1.02),
    `teorik tavan ×${out.theoreticalCeiling} (p→1, ¼→1−f_bell) · en yüksek ölçüm ×${Math.max(...scale.map(s => s.basisGainVsUnbiased))}`);

  // ══ 5) BELL SERTİFİKASI VE GÜVENLİK DEĞİŞMEZLERİ ══
  const bell = DC.runDutyCycle(pairs, { pKey: bestMeasured.pKey, fBell: F_BELL, seed: 0x0DDC1CE5 });
  out.certification = {
    fBell: F_BELL, bellRounds: bell.bellRounds, ...bell.bell,
    keyCostPct: +(100 * F_BELL).toFixed(2),
  };
  chk("Bell görev döngüsü sertifikayı sürdürüyor (3σ üstü ihlal)",
    bell.bell && bell.bell.violated && bell.bell.sigmaAboveClassical >= 3,
    `turların %${(100 * F_BELL).toFixed(0)}'i Bell moduna ayrıldı → ${bell.bellRounds.toLocaleString("tr-TR")} tur, ` +
    `S=${bell.bell.S} ± ${bell.bell.standardError} (${bell.bell.sigmaAboveClassical}σ)`);
  chk("Güvenlik değişmezleri korunuyor: e_bit = 0 ve e_ph X bazından",
    bell.eBit === 0 && Math.abs(bell.ePh - ePh) / ePh < 0.15,
    `e_bit=${bell.eBit} (saf fazda 0 olmalı) · e_ph=${bell.ePh}, bağımsız ölçüm ${ePh} (fark %${(100 * Math.abs(bell.ePh - ePh) / ePh).toFixed(1)})`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "duty_cycle.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ BB84/E91 HİBRİT GÖREV DÖNGÜSÜ ══\n");
  console.log(`  Akış ${trn(sessionMs / 1000, 1)} s · ${trn(pairs.length)} çift · e_ph ${ePh}\n`);
  console.log("  TABANLAR (ölçüldü)");
  console.log(`    E91 3×3      : anahtar ${e91.keyRoundFraction} · PE ${e91.peRoundFraction} · CHSH ${e91.chshFraction} · ziyan ${e91.wastedFraction}`);
  console.log(`    BBM92 yansız : anahtar ${unbiased.keyRoundFraction} · PE ${unbiased.peRoundFraction} · eleme ${unbiased.basisMatchFraction}`);
  console.log(`    "×4,5" = eleme ÷ E91-anahtar = ${out.baselines.whereTheClaimComesFrom.ratio_bbm92AllSifted_over_e91Key}` +
    `  (aynı ölçütle anahtar/anahtar = ${out.baselines.whereTheClaimComesFrom.ratio_bbm92Key_over_e91Key})\n`);
  console.log("  YANLILIK TARAMASI (Bell görev döngüsü %1)");
  console.log("     p     anahtar turu   oran     μ        ℓ(bit)     ×yansız  ×E91");
  for (const s of sweep)
    console.log(`   ${pad(trn(s.pKey, 2), 5)} ${pad(trn(s.keyRounds), 14)} ${pad(trn(s.keyRoundFraction, 4), 8)} ${pad(trn(s.mu, 5), 8)} ${pad(trn(s.ell), 10)} ${pad("×" + trn(s.basisGainVsUnbiased, 2), 9)} ${pad("×" + trn(s.basisGainVsE91, 2), 6)}`);
  console.log(`\n  Türetilen p* = ${derived.p} (öngörü ℓ ${trn(derived.ellPredicted)}) · ölçülen en iyi p = ${bestMeasured.pKey} (ℓ ${trn(bestMeasured.ell)})`);
  console.log(`  KAZANÇ: baz eşleşme ×${out.gains.basisMatchGainVsUnbiased} (yansıza göre), ×${out.gains.basisMatchGainVsE91} (E91'e göre) · ℓ ×${out.gains.ellGainVsUnbiased}`);
  console.log(`  Teorik tavan ×${out.theoreticalCeiling} (p→1)\n`);
  console.log("  KAZANÇ BLOK BOYUTUYLA BÜYÜYOR");
  console.log("    tur           p*      anahtar turu   ×yansız   ℓ");
  for (const s of scale)
    console.log(`    ${pad(trn(s.rounds), 12)} ${pad(trn(s.derivedP, 3), 7)} ${pad(trn(s.keyRoundFraction, 4), 12)} ${pad("×" + trn(s.basisGainVsUnbiased, 2), 9)} ${pad(trn(s.ell), 8)}`);
  console.log(`\n  Bell sertifikası: %${(100 * F_BELL).toFixed(0)} görev döngüsü → S=${bell.bell.S} (${bell.bell.sigmaAboveClassical}σ)`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
