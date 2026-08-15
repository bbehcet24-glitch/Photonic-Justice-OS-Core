#!/usr/bin/env node
"use strict";
/**
 * multihop_qkd_flow_test.js
 * ═══════════════════════════════════════════════════════════════════
 * İKİ İSTEK, TEK TEST:
 *   A) A — R1 — R2 — B (üçüncü düğüm): dinamik kuantum yönlendirme
 *   B) Üretilen yüksek sadakatli çiftleri TÜKETEREK QKD güvenli veri akışı
 *
 * Çıktı: konsol + /tmp/multihop_qkd_flow_report.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const E = require("./entanglement_swap_scheduler.js");
const M = require("./entanglement_multihop_router.js");
const Q = require("./qkd_over_entanglement.js");

const KM = E.REFERENCE_KM;
const SEEDS = [0xE17A0BEE, 0x1234567, 0xABCDEF1, 0x55AA33C];
const pad = (v, n) => String(v).padStart(n);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const report = { generatedAt: new Date().toISOString(), sections: {} };

// ══════════════════════════════════════════════════════════
console.log("═".repeat(76));
console.log("BÖLÜM A — ÜÇÜNCÜ DÜĞÜM: A — R1 — R2 — B  (dinamik kuantum yönlendirme)");
console.log("═".repeat(76));
console.log(`Gereken ELEMANTER bağ sadakati (nihai F ≥ 0.85 için):`);
console.log(`   2 bağ (A-R-B)      : ${M.requiredSegmentFidelity(0.85, 2).toFixed(6)}`);
console.log(`   3 bağ (A-R1-R2-B)  : ${M.requiredSegmentFidelity(0.85, 3).toFixed(6)}   ← üçüncü düğümün bedeli\n`);

const POLICIES = ["sequential", "dynamic", "balanced"];
const chainRuns = {};
console.log("  politika     nihai çift   verim     Fmin       ort. bekleme   uçtan uca gecikme");
for (const pol of POLICIES) {
  const rs = SEEDS.map(seed => M.simulateChain({
    segmentKm: [KM, KM, KM], swapPolicy: pol, seed,
    attemptsPerSegment: 20000, t2Ms: 10, t1Ms: 50,
  }));
  const avg = (f) => rs.reduce((a, r) => a + (f(r) ?? 0), 0) / rs.length;
  const fmins = rs.map(r => r.fidelity.min).filter(x => x != null);
  chainRuns[pol] = {
    finalPairs: Math.round(avg(r => r.totals.finalPairs)),
    yieldPct: +avg(r => r.totals.yieldPct).toFixed(4),
    fMin: fmins.length ? +Math.min(...fmins).toFixed(6) : null,
    meanSpanWaitMs: +avg(r => r.totals.meanSpanWaitMs).toFixed(5),
    meanLatencyMs: +avg(r => r.totals.meanEndToEndLatencyMs).toFixed(5),
    ledgerBalanced: rs.every(r => r.ledger.balanced),
    fusionsByPair: rs[0].totals.fusionsByPair,
  };
  const c = chainRuns[pol];
  console.log(`  ${pol.padEnd(12)} ${pad(c.finalPairs, 10)}  ${pad(c.yieldPct + "%", 8)}  ${pad(c.fMin, 9)}  ${pad(c.meanSpanWaitMs + "ms", 13)}  ${pad(c.meanLatencyMs + "ms", 17)}`);
}
report.sections.routing = chainRuns;

const ys = POLICIES.map(p => chainRuns[p].yieldPct);
const spread = (Math.max(...ys) - Math.min(...ys)) / Math.max(...ys);
console.log();
check("Zincir uçtan uca çift üretiyor (3 bağ, 2 takas)", chainRuns.dynamic.finalPairs > 0, `${chainRuns.dynamic.finalPairs} çift`);
check("Tüm teslim edilen çiftler hedef sadakatin üstünde", POLICIES.every(p => chainRuns[p].fMin >= 0.85), `Fmin=${chainRuns.dynamic.fMin}`);
check("Bellek defteri dengeli (sızıntı yok)", POLICIES.every(p => chainRuns[p].ledgerBalanced));
console.log();
console.log("  ── DÜRÜST BULGU: yönlendirme politikası ölçülebilir fark yaratMIYOR ──");
console.log(`  Politikalar arası verim yayılımı: %${(spread * 100).toFixed(1)}.`);
console.log("  SEBEBİ MATEMATİKSEL: saf faz gürültüsünde takas, Pauli hata gruplarının");
console.log("  konvolüsyonudur; konvolüsyon BİRLEŞMELİ ve DEĞİŞMELİ olduğu için takas");
console.log("  SIRASI nihai sadakati DEĞİŞTİREMEZ. Sıra yalnızca bekleme süresini,");
console.log("  o da yalnızca bekleme/T2 oranı büyükse etkiler:");
console.log(`     ort. bekleme = ${chainRuns.dynamic.meanSpanWaitMs} ms,  T2 = 10 ms  →  oran ≈ ${(chainRuns.dynamic.meanSpanWaitMs / 10).toFixed(4)}`);
console.log("  Bu oran ~0.01 mertebesinde kaldığı sürece hangi politika seçilirse");
console.log("  seçilsin sonuç aynıdır. Politikanın önem kazanacağı rejim (oran > 0.2)");
console.log("  ise zincirin başka nedenlerle zaten sıfır verim verdiği rejimdir.");
report.sections.routingFinding = {
  yieldSpreadPct: +(spread * 100).toFixed(2),
  waitToT2Ratio: +(chainRuns.dynamic.meanSpanWaitMs / 10).toFixed(5),
  explanation: "Pauli konvolüsyonu birleşmeli+değişmeli olduğundan takas sırası sadakati değiştirmez; yalnızca bekleme süresini etkiler ve bekleme/T2 oranı bu rejimde ~0.01'dir.",
};

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(76));
console.log("BÖLÜM B — QKD GÜVENLİ VERİ AKIŞI (çiftler TÜKETİLİYOR)");
console.log("═".repeat(76));
console.log("Protokol: BBM92. QBER uydurulmaz — doğrudan Bell durumundan türetilir:");
console.log("  Z bazı: QBER = X+Y    ·    X bazı: QBER = Z+Y\n");

const blocks = [];
for (const attempts of [1000, 5000, 20000, 100000]) {
  const r = E.simulate({
    elementaryKm: KM, attemptsPerLink: attempts, memorySlots: 20,
    t1Ms: 50, t2Ms: 10, targetFinalFidelity: 0.85, seed: 0xE17A0BEE,
    policy: "smart", protocol: "dejmps", multiplexing: 1,
  });
  const q = Q.runQkdFlow(r.pairs, {});
  blocks.push({
    attemptsPerLink: attempts,
    pairs: r.totals.finalPairs,
    meanFidelity: r.fidelity.mean,
    sifted: q.measurement ? q.measurement.siftedCount : 0,
    n: q.sampling ? q.sampling.n : 0,
    k: q.sampling ? q.sampling.k : 0,
    qberZ: q.measurement ? q.measurement.zBasis.qber : null,
    qberX: q.measurement ? q.measurement.xBasis.qber : null,
    qberEst: q.sampling ? q.sampling.qberEst : null,
    leakedBits: q.errorCorrection ? q.errorCorrection.leakedBits : null,
    residualErrors: q.errorCorrection ? q.errorCorrection.residualErrors : null,
    ell: q.security ? q.security.ell : 0,
    secure: q.security ? q.security.secure : false,
    ok: q.ok, stage: q.stage,
    dataFlow: q.dataFlow ?? null,
    verdict: q.verdict ?? q.reason,
  });
}
console.log("  çift     elenmiş     n      k    QBER_Z   QBER_X   EC sızıntı   ℓ (güvenli bit)   sonuç");
for (const b of blocks) {
  console.log(`  ${pad(b.pairs, 6)}  ${pad(b.sifted, 8)}  ${pad(b.n, 6)} ${pad(b.k, 6)}  ${pad((b.qberZ ?? 0).toFixed(4), 7)}  ${pad((b.qberX ?? 0).toFixed(4), 7)}  ${pad(b.leakedBits ?? "—", 10)}   ${pad(b.ell, 15)}   ${b.secure ? "GÜVENLİ" : "ABORT"}`);
}
report.sections.qkdScaling = blocks;

const aborted = blocks.filter(b => !b.secure);
const secured = blocks.filter(b => b.secure);
console.log();
check("Küçük blok DÜRÜSTÇE abort ediyor (sonlu-anahtar sınırı)", aborted.length > 0,
  `${aborted.map(b => b.pairs + " çift").join(", ")} → ℓ=0`);
check("Yeterince büyük blokta güvenli anahtar üretiliyor", secured.length > 0,
  secured.length ? `${secured[0].pairs} çift → ℓ=${secured[0].ell} bit` : "yok");
check("QBER faz-baskın gürültüde ASİMETRİK (Z ≈ 0, X > 0)",
  blocks.every(b => (b.qberZ ?? 0) <= (b.qberX ?? 0)),
  `Z=${(blocks[blocks.length - 1].qberZ ?? 0).toFixed(5)} vs X=${(blocks[blocks.length - 1].qberX ?? 0).toFixed(5)}`);
check("Hata düzeltme kalan hata BIRAKMIYOR",
  blocks.every(b => b.residualErrors === null || b.residualErrors === 0));

const best = blocks[blocks.length - 1];
console.log("\n  ── UÇTAN UCA VERİ AKIŞI (en büyük blok) ──");
if (best.dataFlow) {
  console.log(`  Tüketilen çift          : ${best.pairs}`);
  console.log(`  Güvenli anahtar (ℓ)     : ${best.ell} bit`);
  console.log(`  Mesaj                   : ${best.dataFlow.messageChars} karakter / ${best.dataFlow.messageBits} bit`);
  console.log(`  Anahtar yeterli mi      : ${best.dataFlow.keySufficientForOtp ? "evet" : "hayır"}`);
  console.log(`  Şifreli metin ≠ düz metin: ${best.dataFlow.cipherDiffersFromPlaintext ? "evet" : "HAYIR (!)"}`);
  console.log(`  Doğru çözüldü           : ${best.dataFlow.decryptedCorrectly ? "evet" : "HAYIR"}`);
  console.log(`  Çözülen metin (önizleme): "${best.dataFlow.decodedPreview}…"`);
  check("Alice ve Bob'un nihai anahtarları BİREBİR AYNI", best.ok);
  check("OTP ile şifrelenip birebir çözüldü", best.dataFlow.decryptedCorrectly);
  check("Şifreli metin düz metinden farklı (gerçekten şifrelendi)", best.dataFlow.cipherDiffersFromPlaintext);
}

// ── 3 atlamalı zincirden gelen çiftlerle de QKD ──
console.log("\n  ── AYNI AKIŞ, 3 ATLAMALI ZİNCİRDEN (A-R1-R2-B) GELEN ÇİFTLERLE ──");
const chainBig = M.simulateChain({ segmentKm: [KM, KM, KM], swapPolicy: "dynamic", seed: 0xE17A0BEE, attemptsPerSegment: 200000, t2Ms: 10, t1Ms: 50 });
const qChain = Q.runQkdFlow(chainBig.pairs, {});
console.log(`  Zincir: ${chainBig.totals.finalPairs} çift (Fort=${chainBig.fidelity.mean}), toplam ${chainBig.physics.totalKm} km`);
console.log(`  QKD   : elenmiş=${qChain.measurement.siftedCount}, n=${qChain.sampling.n}, ℓ=${qChain.security.ell} bit, ${qChain.security.secure ? "GÜVENLİ" : "ABORT"}`);
if (qChain.dataFlow) console.log(`  Veri  : doğru çözüldü=${qChain.dataFlow.decryptedCorrectly}, "${qChain.dataFlow.decodedPreview}…"`);
report.sections.chainQkd = {
  totalKm: chainBig.physics.totalKm,
  pairs: chainBig.totals.finalPairs,
  meanFidelity: chainBig.fidelity.mean,
  sifted: qChain.measurement.siftedCount,
  n: qChain.sampling.n, ell: qChain.security.ell, secure: qChain.security.secure,
  decryptedCorrectly: qChain.dataFlow ? qChain.dataFlow.decryptedCorrectly : false,
};
check("3 atlamalı zincirden gelen çiftlerle de güvenli anahtar + doğru veri akışı",
  qChain.security.secure && qChain.dataFlow && qChain.dataFlow.decryptedCorrectly,
  `${chainBig.physics.totalKm} km üzerinden ℓ=${qChain.security.ell} bit`);

console.log("\n" + "═".repeat(76));
console.log(failures === 0 ? "GENEL SONUÇ: ✅ TÜM DENETİMLER GEÇTİ" : `GENEL SONUÇ: ❌ ${failures} DENETİM BAŞARISIZ`);
console.log("═".repeat(76));
report.failures = failures;
fs.writeFileSync("/tmp/multihop_qkd_flow_report.json", JSON.stringify(report, null, 2));
console.log("\nRapor: /tmp/multihop_qkd_flow_report.json");
process.exit(failures === 0 ? 0 : 1);
