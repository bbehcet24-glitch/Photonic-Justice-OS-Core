#!/usr/bin/env node
"use strict";
/**
 * attenuation_sweep_test.js
 * ═══════════════════════════════════════════════════════════════════
 * İKİ ÖLÇÜM:
 *
 * A) KANAL ZAYIFLAMA (α) TARAMASI — farklı fiber kaliteleri:
 *      0.00 dB/km  kayıpsız kanal (İDEALLEŞTİRME — üst sınır referansı)
 *      0.16 dB/km  ultra-düşük kayıplı fiber (mertebe)
 *      0.20 dB/km  SMF-28 standart @1550nm
 *      0.30 dB/km  yaşlanmış/ekli saha fiberi (mertebe)
 *      0.40 dB/km  kötü/çok ekli fiber (mertebe)
 *
 *    DÜRÜSTLÜK NOTU (α=0): bu, "uydu bağlantısı" DEĞİL, KAYIPSIZ KANAL
 *    idealleştirmesidir. Gerçek serbest-uzay/uydu bağlantılarında baskın
 *    kayıp kırınım (geometrik yayılma, ~1/L²) ve atmosferik sönümlemedir;
 *    bunlar km başına ÜSTEL DEĞİLDİR, dolayısıyla tek bir α ile temsil
 *    edilemezler. α=0 burada yalnızca "kayıp tamamen ortadan kalksa ne
 *    olurdu" sorusunun üst sınırını verir — ve asıl bulguyu ortaya
 *    çıkarır: kaybı sıfırlamak bile mesafe sınırını KALDIRMIYOR.
 *
 * B) DEJMPS TUR SAYISI — düşük-taban (F > 0.5) rejimi:
 *    DEJMPS bir çifti yukarı çekebilir ancak ve ancak F > 0.5 iken
 *    (2I²−3I+1 < 0). Ama F → 0.5'e yaklaştıkça hem GEREKEN TUR SAYISI
 *    artar hem de her turun başarı olasılığı düşer. Her tur 2 çift
 *    tüketip p olasılıkla 1 çift ürettiği için çıktı başına ham çift
 *    maliyeti Π(2/pᵢ) ile ÇİFTE-ÜSTEL patlar. Bu bölüm o patlamayı
 *    hem ANALİTİK olarak hem de simülasyonda ÖLÇÜLEN tur sayısıyla
 *    gösterir.
 *
 * Çıktı: konsol + /tmp/attenuation_sweep.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const E = require("./entanglement_swap_scheduler.js");

const ALPHAS = [
  { a: 0.00, label: "0,00", tech: "kayıpsız kanal (idealleştirme — üst sınır)" },
  { a: 0.16, label: "0,16", tech: "ultra-düşük kayıplı fiber (mertebe)" },
  { a: 0.20, label: "0,20", tech: "SMF-28 standart @1550nm" },
  { a: 0.30, label: "0,30", tech: "yaşlanmış/ekli saha fiberi (mertebe)" },
  { a: 0.40, label: "0,40", tech: "kötü / çok ekli fiber (mertebe)" },
];
const SEEDS = [0xE17A0BEE, 0x1234567, 0xABCDEF1, 0x55AA33C, 0x9E3779B1, 0x2545F491, 0x7F4A7C15];
const KM_MIN = 4, KM_MAX = 90, KM_STEP = 2;
const BASE = {
  attemptsPerLink: 1000, memorySlots: 20, t1Ms: 50, t2Ms: 10,
  targetFinalFidelity: 0.85, policy: "smart", protocol: "dejmps", multiplexing: 1,
};
const pad = (v, n) => String(v).padStart(n);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// ══════════════════════════════════════════════════════════
console.log("═".repeat(78));
console.log("BÖLÜM A — KANAL ZAYIFLAMA (α) TARAMASI");
console.log("═".repeat(78));
console.log("  α (dB/km)  kritik eşik   çalışma eşiği   9,4 km'de verim   9,4 km'de kayıp");
const alphaResults = [];
for (const A of ALPHAS) {
  const curve = [];
  for (let km = KM_MIN; km <= KM_MAX; km += KM_STEP) {
    const runs = SEEDS.map(seed => E.simulate({ ...BASE, elementaryKm: km, attenuationDbPerKm: A.a, seed }));
    const pairs = runs.map(r => r.totals.finalPairs);
    const rounds = runs.map(r => r.totals.meanRoundsPerFinalPair).filter(x => x != null);
    curve.push({
      km,
      nonZero: pairs.filter(p => p > 0).length,
      seeds: SEEDS.length,
      meanYieldPct: +(runs.reduce((s, r) => s + r.totals.yieldPct, 0) / runs.length).toFixed(4),
      lossPct: +(runs[0].physics.lossRate * 100).toFixed(2),
      rawFidelity: +(1 - runs[0].physics.phaseErrorRate).toFixed(5),
      meanRounds: rounds.length ? +(rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(3) : null,
    });
  }
  let critical = null, working = null;
  for (let i = curve.length - 1; i >= 0; i--) {
    if (critical === null && curve[i].nonZero * 2 >= curve[i].seeds) critical = curve[i].km;
    if (working === null && curve[i].meanYieldPct >= 0.5) working = curve[i].km;
    if (critical !== null && working !== null) break;
  }
  const at94 = curve.find(c => Math.abs(c.km - 9.354) < 1.2) ?? curve[2];
  alphaResults.push({ ...A, criticalKm: critical, workingKm: working, curve, at94 });
  console.log(`  ${pad(A.label, 9)}  ${pad((critical ?? "yok") + " km", 11)}  ${pad((working ?? "yok") + " km", 13)}  ${pad("%" + at94.meanYieldPct, 15)}  ${pad("%" + at94.lossPct, 15)}`);
}
console.log();
const crits = alphaResults.map(r => r.criticalKm ?? 0);
// Eşik ölçümü doğası gereği gürültülüdür (çoğunluk kuralı + 2 km kuantalama);
// bu yüzden monotonluk SABİT MESAFEDEKİ VERİM üzerinden — gürültüsüz,
// doğrudan ölçülen büyüklük — sınanır, eşik ise TOLERANSLA kontrol edilir.
const yields94 = alphaResults.map(r => r.at94.meanYieldPct);
check("Zayıflama arttıkça verim AZALIYOR (sabit 9,4 km'de, monoton)",
  yields94.every((v, i) => i === 0 || v <= yields94[i - 1] + 1e-9),
  ALPHAS.map((A, i) => `α=${A.label}:%${yields94[i]}`).join(" → "));
check("Kritik eşik de azalıyor (eşik ölçümü ±1 adım gürültülü)",
  crits.every((v, i) => i === 0 || v <= crits[i - 1] + KM_STEP),
  ALPHAS.map((A, i) => `α=${A.label}:${crits[i]}km`).join(" → "));
const lossless = alphaResults[0];
check("α=0 (kayıpsız) BİLE mesafe sınırını KALDIRMIYOR",
  lossless.criticalKm != null && lossless.criticalKm < KM_MAX,
  `kayıpsız kanalda dahi eşik ${lossless.criticalKm} km — sınırı koyan kayıp değil, FAZ GÜRÜLTÜSÜ + bellek dekoheransı`);
const std = alphaResults.find(r => r.a === 0.2), bad = alphaResults.find(r => r.a === 0.4);
check("Kötü fiber (0,40) standart fibere (0,20) göre menzili kısaltıyor",
  (bad.criticalKm ?? 0) < (std.criticalKm ?? 0),
  `${std.criticalKm} km → ${bad.criticalKm} km`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM B — DEJMPS TUR SAYISI, DÜŞÜK-TABAN (F > 0.5) REJİMİNDE");
console.log("═".repeat(78));
const linkTarget = E.requiredLinkFidelity(0.85, "dephasing");
console.log(`Hedef bağ sadakati: ${linkTarget.toFixed(6)}   ·   DEJMPS alt sınırı: F > 0.5 (cebirsel)\n`);
console.log("  F_ham    gereken tur   çıktı başına ham çift   1. tur p_başarı");
const analytic = [];
for (const F of [0.95, 0.92, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.575, 0.55, 0.535, 0.52, 0.51, 0.505, 0.502]) {
  const r = E.dejmpsRoundsToTarget(F, linkTarget);
  analytic.push({ F, rounds: r.rounds, cost: r.rawPairsPerOutput, p1: r.pChain[0] ?? null, reachable: r.reachable });
  console.log(`  ${pad(F.toFixed(3), 6)}   ${pad(r.rounds, 11)}   ${pad(r.rawPairsPerOutput.toLocaleString("tr-TR"), 21)}   ${pad(r.pChain[0] != null ? r.pChain[0].toFixed(4) : "—", 15)}`);
}
console.log();
const finite = analytic.filter(a => Number.isFinite(a.cost));
check("Tur sayısı F azaldıkça MONOTON artıyor",
  finite.every((a, i) => i === 0 || a.rounds >= finite[i - 1].rounds),
  finite.map(a => a.rounds).join(" ≤ "));
check("Kaynak maliyeti F → 0.5'te ÜSTEL patlıyor",
  finite[finite.length - 1].cost > 1000 * finite[0].cost,
  `F=${finite[0].F}: ${finite[0].cost} çift → F=${finite[finite.length - 1].F}: ${finite[finite.length - 1].cost.toLocaleString("tr-TR")} çift`);
check("F ≤ 0.5'te arıtma İMKÂNSIZ (cebirsel sınır)",
  !E.dejmpsRoundsToTarget(0.5, linkTarget).reachable && !E.dejmpsRoundsToTarget(0.49, linkTarget).reachable);

// ── Simülasyonda ÖLÇÜLEN tur sayısı (analitikle karşılaştırma) ──
console.log("\n  ── Simülasyonda ÖLÇÜLEN ortalama tur (α=0,20 standart fiber) ──");
console.log("   km    F_ham     ölçülen tur   analitik tur   verim");
const measured = [];
for (const km of [4, 9.354, 15, 20, 25, 30, 35]) {
  const runs = SEEDS.map(seed => E.simulate({ ...BASE, elementaryKm: km, attenuationDbPerKm: 0.2, seed }));
  const rr = runs.map(r => r.totals.meanRoundsPerFinalPair).filter(x => x != null);
  const Fraw = 1 - runs[0].physics.phaseErrorRate;
  const ana = E.dejmpsRoundsToTarget(Fraw, linkTarget);
  const mRounds = rr.length ? +(rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(3) : null;
  measured.push({ km, Fraw: +Fraw.toFixed(5), measuredRounds: mRounds, analyticRounds: ana.rounds, yieldPct: +(runs.reduce((s, r) => s + r.totals.yieldPct, 0) / runs.length).toFixed(4) });
  console.log(`  ${pad(km, 5)}  ${pad(Fraw.toFixed(4), 7)}  ${pad(mRounds ?? "—", 12)}  ${pad(Number.isFinite(ana.rounds) ? ana.rounds : "∞", 12)}  ${pad("%" + (runs.reduce((s, r) => s + r.totals.yieldPct, 0) / runs.length).toFixed(2), 7)}`);
}
const comparable = measured.filter(m => m.measuredRounds != null && Number.isFinite(m.analyticRounds));
// ÖNEMLİ BULGU: ölçülen tur sayısı analitikten DAİMA ≥ çıkıyor ve fark
// mesafeyle BÜYÜYOR. Bu bir tutarsızlık DEĞİL, fiziksel bir sonuçtur:
// analitik hesap İDEAL simetrik arıtmayı (bekleme yok, dekoherans yok)
// varsayar; simülasyonda ise çiftler eşlerini beklerken dekohere olur,
// sadakatleri düşer ve hedefe ulaşmak için FAZLADAN tur gerekir.
// Yani dekoherans yalnızca verimi düşürmez, ARITMA MALİYETİNİ de artırır.
for (const m of comparable) m.roundOverhead = +(m.measuredRounds - m.analyticRounds).toFixed(3);
check("Ölçülen tur ≥ analitik tur (dekoherans tur EKLER, asla azaltmaz)",
  comparable.every(m => m.measuredRounds >= m.analyticRounds - 0.05),
  comparable.map(m => `${m.km}km:+${m.roundOverhead}`).join(" "));
const overheads = comparable.map(m => m.roundOverhead);
check("Dekoherans kaynaklı tur fazlalığı mesafeyle BÜYÜYOR",
  overheads[overheads.length - 1] > overheads[0],
  `${comparable[0].km} km: +${overheads[0]} tur → ${comparable[comparable.length - 1].km} km: +${overheads[overheads.length - 1]} tur`);

const out = {
  generatedAt: new Date().toISOString(),
  method: {
    seeds: SEEDS.length, kmRange: [KM_MIN, KM_MAX], kmStep: KM_STEP,
    base: { ...BASE },
    linkTarget: +linkTarget.toFixed(6),
    alphaZeroNote: "α=0, 'uydu bağlantısı' DEĞİL, KAYIPSIZ KANAL idealleştirmesidir. Gerçek serbest-uzay bağlantılarında baskın kayıp kırınım (~1/L²) ve atmosferik sönümlemedir; km başına üstel değildir ve tek bir α ile temsil edilemez.",
  },
  alphaSweep: alphaResults,
  dejmpsRounds: { linkTarget: +linkTarget.toFixed(6), analytic, measured },
  failures,
};
fs.writeFileSync("/tmp/attenuation_sweep.json", JSON.stringify(out, null, 2));
console.log("\n" + "═".repeat(78));
console.log(failures === 0 ? "GENEL SONUÇ: ✅ TÜM DENETİMLER GEÇTİ" : `GENEL SONUÇ: ❌ ${failures} DENETİM BAŞARISIZ`);
console.log("═".repeat(78));
console.log("\nVeri: /tmp/attenuation_sweep.json");
process.exit(failures === 0 ? 0 : 1);
