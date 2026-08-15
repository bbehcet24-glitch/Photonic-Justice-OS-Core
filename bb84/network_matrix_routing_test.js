#!/usr/bin/env node
"use strict";
/**
 * network_matrix_routing_test.js
 * ═══════════════════════════════════════════════════════════════════
 * Ağ matrisi + paralel (çok-yollu) yönlendirme testi.
 *
 * TOPOLOJİ (kurgusal ama gerçekçi: farklı uzunlukta, kısmen kenar-ayrık
 * yollar ve PAYLAŞILAN bir bağ içerir — paylaşım olmadan "paralel
 * yönlendirme" trivial olurdu):
 *
 *        R1 ──12── B
 *      ╱  │
 *    10   7 (paylaşılan)
 *    ╱    │
 *   A     R3 ──8── B
 *    ╲   ╱
 *     8 9
 *      ╲╱
 *      R2
 *   A ──15── R4 ──14── B
 *
 * Çıktı: konsol + /tmp/network_matrix_routing.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const N = require("./quantum_network_matrix.js");

const NODES = ["A", "R1", "R2", "R3", "R4", "B"];
const LINKS = [
  { a: "A", b: "R1", km: 10, capacity: 20000 },
  { a: "R1", b: "B", km: 12, capacity: 20000 },
  { a: "A", b: "R2", km: 8, capacity: 20000 },
  { a: "R2", b: "R3", km: 9, capacity: 20000 },
  { a: "R3", b: "B", km: 8, capacity: 20000 },
  { a: "A", b: "R4", km: 15, capacity: 20000 },
  { a: "R4", b: "B", km: 14, capacity: 20000 },
  { a: "R1", b: "R3", km: 7, capacity: 20000 },   // PAYLAŞILAN bağ
];
const TARGET_F = 0.85;
const MAX_HOPS = 4;
const ATTEMPTS = 20000;

const pad = (v, n) => String(v).padStart(n);
const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { maximumFractionDigits: d } : undefined);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// ══════════════════════════════════════════════════════════
console.log("═".repeat(78));
console.log("BÖLÜM 1 — AĞ MATRİSLERİ");
console.log("═".repeat(78));
const G = N.buildMatrices(NODES, LINKS);
const show = (Mx, fmt) => {
  console.log("       " + NODES.map(n => pad(n, 8)).join(""));
  Mx.forEach((row, i) => console.log(pad(NODES[i], 5) + "  " + row.map(v => pad(fmt(v), 8)).join("")));
};
console.log("\n  Bitişiklik matrisi A:");
show(G.A, v => v);
console.log("\n  Mesafe matrisi D (km):");
show(G.D, v => (v === Infinity ? "∞" : v));
console.log("\n  Elemanter sadakat matrisi Fe (mesafeden türetildi):");
show(G.Fe, v => (v ? v.toFixed(4) : "—"));

const degrees = G.A.map(r => r.reduce((a, b) => a + b, 0));
check("Bitişiklik matrisi simetrik (yönsüz graf)",
  G.A.every((r, i) => r.every((v, j) => v === G.A[j][i])));
check("Derece toplamı = 2 × kenar sayısı (el sıkışma lemması)",
  degrees.reduce((a, b) => a + b, 0) === 2 * LINKS.length,
  `Σderece=${degrees.reduce((a, b) => a + b, 0)} = 2×${LINKS.length}`);
check("Elemanter sadakat mesafeyle MONOTON azalıyor",
  LINKS.every(l => {
    const f = G.Fe[G.idx[l.a]][G.idx[l.b]];
    return LINKS.every(l2 => {
      const f2 = G.Fe[G.idx[l2.a]][G.idx[l2.b]];
      return l.km <= l2.km ? f >= f2 - 1e-9 : true;
    });
  }),
  LINKS.map(l => `${l.km}km→${G.Fe[G.idx[l.a]][G.idx[l.b]].toFixed(4)}`).sort().join(" "));

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 2 — YOL SAYIMI (matris kuvvetleriyle ÇAPRAZ DOĞRULAMA)");
console.log("═".repeat(78));
const paths = N.enumeratePaths(G, "A", "B", MAX_HOPS);
const walks = N.verifyWithMatrixPowers(G, "A", "B", MAX_HOPS);
console.log("  A^k matrisinden A→B arası k-adımlık YÜRÜYÜŞ sayısı:");
for (let k = 1; k <= MAX_HOPS; k++) console.log(`     k=${k}: ${walks[k]} yürüyüş`);
console.log(`\n  DFS ile bulunan BASİT YOL sayısı: ${paths.length}`);
console.log("  (Yürüyüş ≠ basit yol: yürüyüş düğüm tekrarına izin verir, bu yüzden A^k daha büyüktür.)\n");
console.log("  yol                     hop   toplam km   elemanter F (min)   ham uçtan uca F   gereken bağ F");
for (const p of paths) {
  const need = require("./entanglement_multihop_router.js").requiredSegmentFidelity(TARGET_F, p.hops);
  console.log(`  ${p.label.padEnd(22)} ${pad(p.hops, 4)} ${pad(p.totalKm, 11)} ${pad(Math.min(...p.elementaryFidelity).toFixed(4), 18)} ${pad(p.rawEndToEndFidelity.toFixed(4), 17)} ${pad(need.toFixed(4), 15)}`);
}
const hopCounts = paths.map(p => p.hops);
check("Her basit yolun uzunluğu ≤ hop sınırı", hopCounts.every(h => h <= MAX_HOPS));
check("Basit yol sayısı, aynı uzunluktaki yürüyüş sayısını AŞMIYOR",
  [2, 3, 4].every(k => paths.filter(p => p.hops === k).length <= walks[k]),
  [2, 3, 4].map(k => `k=${k}: ${paths.filter(p => p.hops === k).length} yol ≤ ${walks[k]} yürüyüş`).join(" · "));
check("Uçtan uca ham sadakat, hop sayısı arttıkça düşme eğiliminde",
  paths.some(p => p.hops === 2) && paths.some(p => p.hops >= 3) &&
  Math.max(...paths.filter(p => p.hops === 2).map(p => p.rawEndToEndFidelity)) >
  Math.min(...paths.filter(p => p.hops >= 3).map(p => p.rawEndToEndFidelity)));

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 3 — YOL BAŞINA GERÇEK VERİM (simülatör çalıştırılıyor)");
console.log("═".repeat(78));
console.log("  Verim FORMÜLLE TAHMİN EDİLMİYOR — her yol için gerçek çok-atlamalı");
console.log(`  simülatör ${trn(ATTEMPTS)} deneme/segment ile koşturuluyor.\n`);
console.log("  yol                     hop   çift    η (çift/deneme)   F_ort     uygulanabilir");
const measured = paths.map(p => N.measurePathYield(p, {
  targetFinalFidelity: TARGET_F, attemptsPerSegment: ATTEMPTS, t2Ms: 1000, t1Ms: 5000,
}));
for (const p of measured) {
  console.log(`  ${p.label.padEnd(22)} ${pad(p.hops, 4)} ${pad(trn(p.pairs), 6)} ${pad(p.etaPerSegmentAttempt.toFixed(6), 17)} ${pad(p.meanFidelity ?? "—", 9)} ${pad(p.feasible ? "evet" : "HAYIR", 14)}${p.feasible ? "" : " — " + p.reason}`);
}
const feasible = measured.filter(p => p.feasible);
check("En az iki uygulanabilir yol var (paralel yönlendirme anlamlı)",
  feasible.length >= 2, `${feasible.length}/${measured.length} yol uygulanabilir`);
check("Teslim edilen tüm çiftler hedef sadakatin üstünde",
  feasible.every(p => p.minFidelity >= TARGET_F),
  `min F = ${Math.min(...feasible.map(p => p.minFidelity)).toFixed(5)} ≥ ${TARGET_F}`);
check("Daha uzun/çok-hoplu yolların verimi daha düşük (fizik doğru yönde)",
  (() => {
    const s = [...feasible].sort((a, b) => a.totalKm - b.totalKm);
    return s[0].etaPerSegmentAttempt >= s[s.length - 1].etaPerSegmentAttempt;
  })(),
  [...feasible].sort((a, b) => a.totalKm - b.totalKm).map(p => `${p.label}(${p.totalKm}km):${p.etaPerSegmentAttempt.toFixed(5)}`).join(" · "));

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 4 — PARALEL YÖNLENDİRME (akış tahsisi)");
console.log("═".repeat(78));
const single = N.singlePathAllocate(G, measured);
const greedy = N.greedyAllocate(G, measured);
const brute = N.bruteForceAllocate(G, measured, { steps: 10 });
const disjoint = N.edgeDisjointSets(measured);

console.log(`  Tek-yol (klasik)   : ${single.path} · ${trn(single.allocated)} birim → ${trn(single.totalPairs)} çift`);
console.log(`  Paralel (açgözlü)  : ${trn(greedy.totalPairs)} çift`);
for (const a of greedy.allocation) console.log(`      ${a.path.padEnd(22)} ${pad(trn(a.allocated), 7)} birim → ${pad(trn(a.expectedPairs), 7)} çift`);
console.log(`  Kaba kuvvet (üst sınır referansı, ${trn(brute.evaluated)} kombinasyon): ${trn(brute.totalPairs)} çift`);
console.log(`  Kenar-ayrık yol kümesi (dayanıklılık): ${disjoint.join("  ·  ") || "yok"}`);
console.log();
const gain = single.totalPairs > 0 ? greedy.totalPairs / single.totalPairs : null;
check("Paralel yönlendirme tek-yola göre daha fazla çift üretiyor",
  greedy.totalPairs > single.totalPairs,
  gain ? `${trn(single.totalPairs)} → ${trn(greedy.totalPairs)} çift (×${gain.toFixed(2)})` : "taban sıfır");
check("Açgözlü sezgisel, kaba kuvvet üst sınırına yakın (optimallik farkı ÖLÇÜLDÜ)",
  brute.totalPairs > 0 && greedy.totalPairs >= brute.totalPairs * 0.95,
  `açgözlü ${trn(greedy.totalPairs)} vs kaba kuvvet ${trn(brute.totalPairs)} → fark %${(100 * (1 - greedy.totalPairs / brute.totalPairs)).toFixed(2)}`);
check("Hiçbir bağın kapasitesi AŞILMADI (kısıtlar sağlanıyor)",
  Object.values(greedy.residualCapacity).every(v => v >= -1e-9),
  Object.entries(greedy.residualCapacity).map(([e, v]) => `${e}:${trn(v)}`).join(" "));
check("En az 2 kenar-ayrık yol var (tek bağ kesilse de hizmet sürer)",
  disjoint.length >= 2, `${disjoint.length} ayrık yol`);

// Paylaşılan bağın gerçekten çekişme yarattığını göster
const sharedEdge = N.edgeKey("R1", "R3");
const usingShared = measured.filter(p => p.edges.includes(sharedEdge)).map(p => p.label);
console.log(`\n  Paylaşılan bağ ${sharedEdge.replace("|", "–")} şu yollarda ortak: ${usingShared.join(", ") || "yok"}`);
check("Paylaşılan bağ birden fazla yolda kullanılıyor (çekişme gerçek)",
  usingShared.length >= 2, `${usingShared.length} yol bu bağı paylaşıyor`);

const out = {
  generatedAt: new Date().toISOString(),
  topology: { nodes: NODES, links: LINKS, targetFinalFidelity: TARGET_F, maxHops: MAX_HOPS, attemptsPerSegment: ATTEMPTS },
  matrices: { A: G.A, D: G.D.map(r => r.map(v => (v === Infinity ? null : v))), Fe: G.Fe, C: G.C },
  matrixPowerWalks: walks,
  paths: measured.map(p => ({
    label: p.label, hops: p.hops, totalKm: p.totalKm, segmentKm: p.segmentKm, edges: p.edges,
    elementaryFidelity: p.elementaryFidelity, rawEndToEndFidelity: p.rawEndToEndFidelity,
    requiredSegmentFidelity: p.requiredSegmentFidelity, feasible: p.feasible, reason: p.reason,
    pairs: p.pairs, etaPerSegmentAttempt: p.etaPerSegmentAttempt,
    meanFidelity: p.meanFidelity, minFidelity: p.minFidelity,
  })),
  routing: { single, greedy, brute, edgeDisjointPaths: disjoint, sharedEdgeUsers: usingShared, parallelGain: gain },
  failures,
};
fs.writeFileSync("/tmp/network_matrix_routing.json", JSON.stringify(out, null, 2));
console.log("\n" + "═".repeat(78));
console.log(failures === 0 ? "GENEL SONUÇ: ✅ TÜM DENETİMLER GEÇTİ" : `GENEL SONUÇ: ❌ ${failures} DENETİM BAŞARISIZ`);
console.log("═".repeat(78));
console.log("\nVeri: /tmp/network_matrix_routing.json");
process.exit(failures === 0 ? 0 : 1);
