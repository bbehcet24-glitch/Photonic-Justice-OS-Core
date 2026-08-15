#!/usr/bin/env node
"use strict";
/**
 * entanglement_swap_scheduler_test.js
 * ═══════════════════════════════════════════════════════════════════
 * entanglement_swap_scheduler.js'in ÜÇ İYİLEŞTİRMESİNİ, her birini
 * AYRI AYRI izole ederek ölçer. "İyileştirdim" iddiası ancak eski hâl
 * de aynı koşuda çalıştırılıp yan yana konursa doğrulanabilir — bu
 * dosyanın tek işi budur.
 *
 * BÖLÜM 0: içsel tutarlılık denetimi (cebir gerçekten doğru mu?)
 * BÖLÜM 1: bellek zamanlayıcı — naif vs akıllı (foton reddi)
 * BÖLÜM 2: arıtma protokolü — BBPSSW vs DEJMPS (verim)
 * BÖLÜM 3: gerçek fiber fiziği — mesafe ve T2 taramaları
 * BÖLÜM 4: v1 tabanına karşı toplu sonuç
 *
 * Çıktı: konsol + /tmp/entanglement_swap_scheduler_report.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const S = require("./entanglement_swap_scheduler.js");

const BASE = {
  attemptsPerLink: 1000,
  memorySlots: 20,
  t1Ms: 50,
  t2Ms: 10,
  targetFinalFidelity: 0.85,
  seed: 0xE17A0BEE,
};
const run = (over) => S.simulate({ ...BASE, elementaryKm: S.REFERENCE_KM, policy: "smart", protocol: "dejmps", multiplexing: 1, ...over });
const drops = (r) => r.memory.AR.rejectedFull + r.memory.RB.rejectedFull;
const defers = (r) => r.memory.AR.deferredBackpressure + r.memory.RB.deferredBackpressure;
const pad = (v, n) => String(v).padStart(n);

const report = { generatedAt: new Date().toISOString(), sections: {} };
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
  return ok;
};

// ══════════════════════════════════════════════════════════
console.log("═".repeat(72));
console.log("BÖLÜM 0 — İÇSEL TUTARLILIK DENETİMİ (cebir doğru mu?)");
console.log("═".repeat(72));
const selfChecks = S.selfCheck();
for (const c of selfChecks) {
  check(c.name, c.ok, c.ok ? null : `got=${c.got} want=${c.want}`);
}
report.sections.selfCheck = selfChecks.map(c => ({ name: c.name, ok: c.ok }));

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(72));
console.log("BÖLÜM 1 — AKILLI BELLEK KUYRUKLAMA (hedef: foton reddini azalt)");
console.log("═".repeat(72));
console.log("Bellek baskısı, gerçek tekrarlayıcılardaki gibi KAYNAK ÇOKLAMASI (M paralel");
console.log("mod) ile yaratılır. M=1'de üretim hızı düşüktür ve bellek hiç dolmaz —");
console.log("zamanlayıcının ölçülebilir hâle geldiği rejim M≥32'dir.\n");
console.log("  M     politika  düşürülen  ertelenen  nihai çift   verim");
const sec1 = [];
for (const M of [1, 8, 32, 128]) {
  for (const policy of ["naive", "smart"]) {
    const r = run({ multiplexing: M, policy });
    sec1.push({ M, policy, drops: drops(r), defers: defers(r), finalPairs: r.totals.finalPairs, yieldPct: r.totals.yieldPct });
    console.log(`  ${pad(M, 4)}  ${policy.padEnd(8)}  ${pad(drops(r), 9)}  ${pad(defers(r), 9)}  ${pad(r.totals.finalPairs, 10)}  ${pad(r.totals.yieldPct + "%", 7)}`);
  }
}
report.sections.scheduler = sec1;
const pressured = sec1.filter(x => x.M >= 32);
const naiveDrops = pressured.filter(x => x.policy === "naive").reduce((a, b) => a + b.drops, 0);
const smartDrops = pressured.filter(x => x.policy === "smart").reduce((a, b) => a + b.drops, 0);
console.log();
check("Bellek baskısı altında naif politika GERÇEKTEN foton düşürüyor", naiveDrops > 0, `${naiveDrops} foton reddedildi`);
check("Akıllı politika foton reddini SIFIRA indiriyor", smartDrops === 0, `naif ${naiveDrops} → akıllı ${smartDrops}`);
const nY = pressured.filter(x => x.policy === "naive").reduce((a, b) => a + b.finalPairs, 0);
const sY = pressured.filter(x => x.policy === "smart").reduce((a, b) => a + b.finalPairs, 0);
check("Akıllı politika nihai verimi de düşürmüyor (artırıyor)", sY >= nY, `${nY} → ${sY} çift`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(72));
console.log("BÖLÜM 2 — DEJMPS'e GEÇİŞ (hedef: verimi %0.25'in üstüne çıkar)");
console.log("═".repeat(72));
console.log("Gürültü SAF σ_z olduğu için BBPSSW'nin Werner varsayımı bilgi ATAR;");
console.log("DEJMPS gürültünün yapısını KULLANIR.\n");
console.log("  protokol  nihai çift   verim     Fmin       eşikaltı takas");
const sec2 = [];
for (const protocol of ["bbpssw", "dejmps"]) {
  const r = run({ protocol, policy: "smart" });
  sec2.push({ protocol, finalPairs: r.totals.finalPairs, yieldPct: r.totals.yieldPct, fMin: r.fidelity.min, belowTarget: r.totals.swapsBelowTarget });
  console.log(`  ${protocol.padEnd(8)}  ${pad(r.totals.finalPairs, 10)}  ${pad(r.totals.yieldPct + "%", 7)}  ${pad(r.fidelity.min ?? "-", 9)}  ${pad(r.totals.swapsBelowTarget, 14)}`);
}
report.sections.protocol = sec2;
const bb = sec2.find(x => x.protocol === "bbpssw"), dj = sec2.find(x => x.protocol === "dejmps");
console.log();
console.log("  Tek adım karşılaştırma (F=0.88, saf faz gürültüsü):");
const pure = S.bellState(0.88, 0, 0, 0.12);
const djStep = S.bellDejmpsStep(pure, "Z"), bbStep = S.bbpsswPurify(pure, pure);
console.log(`    BBPSSW: F 0.88 → ${bbStep.state.I.toFixed(4)}  (başarı olasılığı ${bbStep.pSuccess.toFixed(4)})`);
console.log(`    DEJMPS: F 0.88 → ${djStep.state.I.toFixed(4)}  (başarı olasılığı ${djStep.pSuccess.toFixed(4)})`);
console.log();
check("DEJMPS verimi %0.25 hedefinin ÜSTÜNDE", dj.yieldPct > 0.25, `%${dj.yieldPct}`);
check("DEJMPS, BBPSSW'yi belirgin şekilde geçiyor", dj.yieldPct > bb.yieldPct * 2, `%${bb.yieldPct} → %${dj.yieldPct}`);
check("DEJMPS ile teslim edilen TÜM çiftler hedef sadakatin üstünde", dj.fMin !== null && dj.fMin >= BASE.targetFinalFidelity, `Fmin=${dj.fMin}`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(72));
console.log("BÖLÜM 3 — GERÇEK FİBER FİZİĞİ (soyut tur/kapasite kaldırıldı)");
console.log("═".repeat(72));
console.log(`  Sönümleme: ${S.FIBER_ATTENUATION_DB_PER_KM} dB/km · Kırılma indisi: ${S.FIBER_REFRACTIVE_INDEX} · Fiber ışık hızı: ${S.FIBER_V_KM_PER_MS.toFixed(2)} km/ms`);
console.log(`  Spesifikasyondaki %35 kayıp ⇔ ${S.REFERENCE_KM.toFixed(3)} km fiber (ters denklemle TÜRETİLDİ)`);
console.log();
console.log("  A) Mesafe taraması (T2=10ms):");
console.log("     km    kayıp    faz hatası   gecikme     nihai çift   verim");
const sweepKm = [];
for (const km of [S.REFERENCE_KM, 15, 20, 30, 40, 60]) {
  const r = run({ elementaryKm: km });
  sweepKm.push({ km: +km.toFixed(3), lossRate: r.physics.lossRate, phaseErrorRate: r.physics.phaseErrorRate, oneWayDelayMs: r.physics.oneWayDelayMs, finalPairs: r.totals.finalPairs, yieldPct: r.totals.yieldPct });
  console.log(`     ${pad(km.toFixed(1), 5)}  ${pad((r.physics.lossRate * 100).toFixed(1) + "%", 7)}  ${pad((r.physics.phaseErrorRate * 100).toFixed(1) + "%", 10)}  ${pad(r.physics.oneWayDelayMs.toFixed(4) + "ms", 10)}  ${pad(r.totals.finalPairs, 10)}  ${pad(r.totals.yieldPct + "%", 7)}`);
}
console.log();
console.log("  B) 40 km'de T2 taraması — sıfır verim GERÇEKTEN dekoherans kaynaklı mı?");
console.log("     T2        nihai çift   verim");
const sweepT2 = [];
for (const t2 of [10, 50, 200, 1000]) {
  const r = run({ elementaryKm: 40, t2Ms: t2, t1Ms: t2 * 5 });
  sweepT2.push({ t2Ms: t2, finalPairs: r.totals.finalPairs, yieldPct: r.totals.yieldPct });
  console.log(`     ${pad(t2 + "ms", 8)}  ${pad(r.totals.finalPairs, 10)}  ${pad(r.totals.yieldPct + "%", 7)}`);
}
report.sections.physics = { sweepKm, sweepT2, constants: { attenuationDbPerKm: S.FIBER_ATTENUATION_DB_PER_KM, refractiveIndex: S.FIBER_REFRACTIVE_INDEX, velocityKmPerMs: +S.FIBER_V_KM_PER_MS.toFixed(3), referenceKm: +S.REFERENCE_KM.toFixed(4) } };
console.log();
check("Gecikme mesafeyle ORANTILI (ışık hızı denklemi gerçekten bağlı)",
  Math.abs(sweepKm[sweepKm.length - 1].oneWayDelayMs / sweepKm[0].oneWayDelayMs - 60 / S.REFERENCE_KM) < 0.01,
  `${sweepKm[0].oneWayDelayMs}ms @${S.REFERENCE_KM.toFixed(1)}km → ${sweepKm[sweepKm.length - 1].oneWayDelayMs}ms @60km`);
check("Verim mesafeyle MONOTON azalıyor (fizik doğru yönde)",
  sweepKm.every((x, i) => i === 0 || x.yieldPct <= sweepKm[i - 1].yieldPct + 0.01),
  sweepKm.map(x => x.yieldPct + "%").join(" → "));
check("40 km'deki sıfır verim, T2 uzatılınca DÜZELİYOR (dekoherans kaynaklı, hata değil)",
  sweepT2[sweepT2.length - 1].finalPairs > sweepT2[0].finalPairs,
  `T2=10ms: ${sweepT2[0].finalPairs} çift → T2=1000ms: ${sweepT2[sweepT2.length - 1].finalPairs} çift`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(72));
console.log("BÖLÜM 4 — v1 TABANINA KARŞI TOPLU SONUÇ");
console.log("═".repeat(72));
const V1_YIELD_PCT = 0.25;   // entanglement_swap_concurrency_test.js, commit 65b460a: 5/2000
const V1_FINAL_PAIRS = 5;
const best = run({ policy: "smart", protocol: "dejmps" });
const naiveBb = run({ policy: "naive", protocol: "bbpssw" });
console.log(`  v1 (BBPSSW + naif FIFO + soyut kapasite tavanı):  ${V1_FINAL_PAIRS} çift, verim %${V1_YIELD_PCT}`);
console.log(`  v2 (akıllı zamanlayıcı + DEJMPS + gerçek fizik):  ${best.totals.finalPairs} çift, verim %${best.totals.yieldPct}`);
console.log(`  → iyileşme çarpanı: ×${(best.totals.yieldPct / V1_YIELD_PCT).toFixed(1)}`);
console.log();
console.log("  Katkı ayrıştırması (referans mesafe, M=1):");
console.log(`    naif + BBPSSW : ${pad(naiveBb.totals.finalPairs, 4)} çift (%${naiveBb.totals.yieldPct})`);
console.log(`    akıllı + BBPSSW: ${pad(bb.finalPairs, 4)} çift (%${bb.yieldPct})   ← zamanlayıcının katkısı`);
console.log(`    akıllı + DEJMPS: ${pad(dj.finalPairs, 4)} çift (%${dj.yieldPct})   ← protokolün katkısı`);
report.sections.summary = {
  v1: { finalPairs: V1_FINAL_PAIRS, yieldPct: V1_YIELD_PCT },
  v2: { finalPairs: best.totals.finalPairs, yieldPct: best.totals.yieldPct, fMin: best.fidelity.min },
  improvementFactor: +(best.totals.yieldPct / V1_YIELD_PCT).toFixed(2),
  decomposition: {
    naiveBbpssw: naiveBb.totals.yieldPct,
    smartBbpssw: bb.yieldPct,
    smartDejmps: dj.yieldPct,
  },
};
console.log();
check("Defter dengeli (bellek GC doğru — sızıntı yok)", best.ledger.balanced, `tahsis=${best.ledger.admitted} serbest=${best.ledger.released}`);
check("Sonsuz döngü koruması tetiklenmedi (deadlock yok)", !best.guardHit);
check("Verim v1 tabanının ÜSTÜNDE", best.totals.yieldPct > V1_YIELD_PCT, `%${V1_YIELD_PCT} → %${best.totals.yieldPct}`);

console.log("\n" + "═".repeat(72));
console.log(failures === 0 ? "GENEL SONUÇ: ✅ TÜM DENETİMLER GEÇTİ" : `GENEL SONUÇ: ❌ ${failures} DENETİM BAŞARISIZ`);
console.log("═".repeat(72));
report.failures = failures;
fs.writeFileSync("/tmp/entanglement_swap_scheduler_report.json", JSON.stringify(report, null, 2));
console.log("\nRapor: /tmp/entanglement_swap_scheduler_report.json");
process.exit(failures === 0 ? 0 : 1);
