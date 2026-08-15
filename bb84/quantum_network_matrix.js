#!/usr/bin/env node
"use strict";
/**
 * quantum_network_matrix.js
 * ═══════════════════════════════════════════════════════════════════
 * AĞ YAPISININ MATRİS GÖSTERİMİ + PARALEL (ÇOK-YOLLU) YÖNLENDİRME
 *
 * NEDEN BU ADIM: A—R1—R2—B zincirinde üç farklı takas-SIRASI politikası
 * denenmiş ve aralarında ölçülebilir fark ÇIKMAMIŞTI. Sebebi
 * matematikseldi: Pauli konvolüsyonu birleşmeli+değişmeli olduğu için
 * takas sırası nihai sadakati değiştiremez. O zaman şu tespit edilmişti:
 * gerçek yönlendirme kazancı SIRADAN değil, ALTERNATİF YOLLARDAN gelir.
 * Bu dosya tam olarak onu kurar.
 *
 * MATRİS GÖSTERİMİ
 *   A  (n×n)  bitişiklik (adjacency): A[i][j] = 1 ⟺ i–j arası fiber var
 *   D  (n×n)  mesafe matrisi (km); bağlantı yoksa Infinity
 *   C  (n×n)  kapasite matrisi — bağ başına elemanter dolanıklık üretim
 *             bütçesi (deneme/saniye mertebesinde soyut birim)
 *   Fe (n×n)  o bağda ULAŞILABİLİR elemanter sadakat (mesafeden türetilir)
 *   Matris kuvvetleri A^k, k adımda ulaşılabilirliği verir — yol
 *   sayımı/varlığı bununla DOĞRULANIR (DFS ile bulunan yol kümesi
 *   A^k izleriyle çapraz kontrol edilir).
 *
 * PARALEL YÖNLENDİRME PROBLEMİ (dürüstçe: bu bir AKIŞ problemi)
 *   Her yol p için:
 *     • uçtan uca sadakat, n_p bağın Pauli konvolüsyonundan gelir:
 *         F_p = (1 + Π(2a_i − 1)) / 2
 *     • verim η_p, GERÇEK simülatörden ölçülür (formülle tahmin EDİLMEZ)
 *   Amaç:  maksimize  Σ_p x_p · η_p
 *   Kısıt:  Σ_{p ∋ e} x_p ≤ C_e   (her bağ e için — YOLLAR BAĞ PAYLAŞIR)
 *   Bu bir doğrusal programdır. Burada açgözlü (verim sıralı su-doldurma)
 *   sezgiseli kullanılır ve KÜÇÜK örneklerde kaba-kuvvet ızgara aramasıyla
 *   optimallik farkı ÖLÇÜLÜR — "açgözlü optimaldir" diye VARSAYILMAZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const E = require("./entanglement_swap_scheduler.js");
const M = require("./entanglement_multihop_router.js");

// ══════════════════════════════════════════════════════════
// BÖLÜM 1 — MATRİS İNŞASI
// ══════════════════════════════════════════════════════════
/**
 * @param {string[]} nodes
 * @param {Array<{a:string,b:string,km:number,capacity?:number}>} links
 */
function buildMatrices(nodes, links, opts = {}) {
  const { attenuationDbPerKm = 0.2, defaultCapacity = 100000 } = opts;
  const n = nodes.length;
  const idx = Object.fromEntries(nodes.map((v, i) => [v, i]));
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const D = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  const Fe = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) D[i][i] = 0;

  for (const l of links) {
    const i = idx[l.a], j = idx[l.b];
    if (i === undefined || j === undefined) throw new Error(`bilinmeyen düğüm: ${l.a}/${l.b}`);
    A[i][j] = A[j][i] = 1;
    D[i][j] = D[j][i] = l.km;
    C[i][j] = C[j][i] = l.capacity ?? defaultCapacity;
    // Bu bağda ulaşılabilecek elemanter sadakat: mesafeye bağlı faz hatası.
    const f = 1 - E.phaseErrorForKm(l.km);
    Fe[i][j] = Fe[j][i] = f;
  }
  return { nodes, idx, n, A, D, C, Fe, attenuationDbPerKm };
}

/** Matris çarpımı (tam sayı) — ulaşılabilirlik doğrulaması için. */
function matMul(X, Y) {
  const n = X.length, m = Y[0].length, k = Y.length;
  const R = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let t = 0; t < k; t++) {
      const xit = X[i][t];
      if (!xit) continue;
      for (let j = 0; j < m; j++) R[i][j] += xit * Y[t][j];
    }
  return R;
}
/** A^k — tam olarak k adımlık YÜRÜYÜŞ sayısı (yol değil, yürüyüş). */
function matPow(A, k) {
  let R = A.map(r => r.slice());
  for (let e = 1; e < k; e++) R = matMul(R, A);
  return R;
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 2 — YOL SAYIMI (basit yollar, hop sınırlı)
// ══════════════════════════════════════════════════════════
function enumeratePaths(G, src, dst, maxHops = 4) {
  const s = G.idx[src], d = G.idx[dst];
  const out = [];
  const visited = new Array(G.n).fill(false);
  const path = [s];
  visited[s] = true;
  (function dfs(u) {
    if (path.length - 1 > maxHops) return;
    if (u === d && path.length > 1) { out.push(path.slice()); return; }
    if (path.length - 1 === maxHops) return;
    for (let v = 0; v < G.n; v++) {
      if (!G.A[u][v] || visited[v]) continue;
      visited[v] = true; path.push(v);
      dfs(v);
      path.pop(); visited[v] = false;
    }
  })(s);
  return out.map(p => describePath(G, p));
}

function describePath(G, nodeIdxPath) {
  const segKm = [], edges = [], elemF = [];
  for (let i = 0; i + 1 < nodeIdxPath.length; i++) {
    const a = nodeIdxPath[i], b = nodeIdxPath[i + 1];
    segKm.push(G.D[a][b]);
    edges.push(edgeKey(G.nodes[a], G.nodes[b]));
    elemF.push(G.Fe[a][b]);
  }
  // Uçtan uca sadakat — Pauli konvolüsyonu (saf faz gürültüsü):
  //   F = (1 + Π(2a_i − 1)) / 2
  const prod = elemF.reduce((acc, a) => acc * (2 * a - 1), 1);
  return {
    nodes: nodeIdxPath.map(i => G.nodes[i]),
    label: nodeIdxPath.map(i => G.nodes[i]).join("→"),
    hops: nodeIdxPath.length - 1,
    segmentKm: segKm,
    totalKm: +segKm.reduce((a, b) => a + b, 0).toFixed(3),
    edges,
    elementaryFidelity: elemF.map(f => +f.toFixed(5)),
    // ARITMA YAPILMADAN uçtan uca sadakat (ham üst sınır referansı)
    rawEndToEndFidelity: +((1 + prod) / 2).toFixed(6),
    // Hedefe ulaşmak için bağ başına GEREKEN sadakat
    requiredSegmentFidelity: null,   // hedef verilince doldurulur
    bottleneckCapacity: null,
  };
}
const edgeKey = (a, b) => [a, b].sort().join("|");

// ══════════════════════════════════════════════════════════
// BÖLÜM 3 — YOL FİZİBİLİTESİ + GERÇEK VERİM ÖLÇÜMÜ
// ══════════════════════════════════════════════════════════
/**
 * Her yolun verimini FORMÜLLE TAHMİN ETMEK yerine GERÇEK çok-atlamalı
 * simülatörü çalıştırarak ölçer. Bu, matris katmanının fizikle
 * bağlantısını kuran yerdir.
 */
function measurePathYield(path, opts = {}) {
  const {
    targetFinalFidelity = 0.85, attemptsPerSegment = 20000,
    t2Ms = 1000, t1Ms = 5000, memorySlots = 20, seed = 0xE17A0BEE,
  } = opts;
  const need = M.requiredSegmentFidelity(targetFinalFidelity, path.hops);
  path.requiredSegmentFidelity = +need.toFixed(6);
  // Arıtma F > 0.5 olan her bağı yukarı çekebilir; bağın kendisi 0.5'in
  // altındaysa o yol FİZİKSEL OLARAK imkânsızdır (matristen okunur,
  // simülasyon çalıştırmaya bile gerek yok).
  const infeasible = path.elementaryFidelity.some(f => f <= 0.5 + 1e-9);
  if (infeasible) {
    return { ...path, feasible: false, reason: "bir bağda elemanter sadakat ≤ 0,5 — arıtma imkânsız", yieldPct: 0, pairs: 0, meanFidelity: null };
  }
  const nodeNames = path.nodes;
  const r = M.simulateChain({
    nodes: nodeNames, segmentKm: path.segmentKm, swapPolicy: "dynamic",
    attemptsPerSegment, memorySlots, t1Ms, t2Ms, targetFinalFidelity, seed,
  });
  return {
    ...path,
    feasible: r.totals.finalPairs > 0,
    reason: r.totals.finalPairs > 0 ? null : "simülasyonda uçtan uca çift üretilemedi",
    // η: SEGMENT BAŞINA harcanan denemenin kaçta kaçı uçtan uca çifte dönüştü.
    // (Yol, her segmentinde aynı bütçeyi harcar; bu yüzden ölçüt
    //  "segment başına deneme" üzerinden tanımlanır — yollar arası
    //  adil karşılaştırma ancak böyle olur.)
    etaPerSegmentAttempt: +(r.totals.finalPairs / attemptsPerSegment).toFixed(8),
    pairs: r.totals.finalPairs,
    yieldPct: r.totals.yieldPct,
    meanFidelity: r.fidelity.mean,
    minFidelity: r.fidelity.min,
    attemptsPerSegment,
  };
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 4 — PARALEL YÖNLENDİRME (akış tahsisi)
// ══════════════════════════════════════════════════════════
/**
 * Açgözlü su-doldurma: yollar verime (η) göre sıralanır, her yola
 * darboğaz bağının KALAN kapasitesi kadar tahsis edilir.
 * DÜRÜSTLÜK: bu bir SEZGİSELDİR, genel olarak optimal değildir —
 * bu yüzden bruteForceAllocate() ile küçük örneklerde fark ÖLÇÜLÜR.
 */
function greedyAllocate(G, paths, opts = {}) {
  const { granularity = 1 } = opts;
  const remaining = new Map();
  for (let i = 0; i < G.n; i++)
    for (let j = i + 1; j < G.n; j++)
      if (G.A[i][j]) remaining.set(edgeKey(G.nodes[i], G.nodes[j]), G.C[i][j]);

  const feasible = paths.filter(p => p.feasible && p.etaPerSegmentAttempt > 0);
  const order = [...feasible].sort((a, b) => b.etaPerSegmentAttempt - a.etaPerSegmentAttempt);
  const alloc = [];
  for (const p of order) {
    const bottleneck = Math.min(...p.edges.map(e => remaining.get(e) ?? 0));
    const x = Math.floor(bottleneck / granularity) * granularity;
    if (x <= 0) { alloc.push({ path: p.label, allocated: 0, expectedPairs: 0 }); continue; }
    for (const e of p.edges) remaining.set(e, remaining.get(e) - x);
    alloc.push({ path: p.label, allocated: x, expectedPairs: Math.round(x * p.etaPerSegmentAttempt) });
  }
  const totalPairs = alloc.reduce((s, a) => s + a.expectedPairs, 0);
  return { allocation: alloc, totalPairs, residualCapacity: Object.fromEntries(remaining) };
}

/** Kaba kuvvet: küçük örneklerde açgözlünün optimallik farkını ÖLÇER. */
function bruteForceAllocate(G, paths, opts = {}) {
  const { steps = 12 } = opts;
  const feasible = paths.filter(p => p.feasible && p.etaPerSegmentAttempt > 0);
  if (feasible.length === 0) return { totalPairs: 0, allocation: [], evaluated: 0 };
  const capByEdge = new Map();
  for (let i = 0; i < G.n; i++)
    for (let j = i + 1; j < G.n; j++)
      if (G.A[i][j]) capByEdge.set(edgeKey(G.nodes[i], G.nodes[j]), G.C[i][j]);
  const maxCap = Math.max(...capByEdge.values());
  const grid = Array.from({ length: steps + 1 }, (_, i) => (maxCap * i) / steps);

  let best = { totalPairs: -1, allocation: [] }, evaluated = 0;
  const cur = new Array(feasible.length).fill(0);
  (function rec(k) {
    if (k === feasible.length) {
      evaluated++;
      const used = new Map();
      for (let i = 0; i < feasible.length; i++)
        for (const e of feasible[i].edges) used.set(e, (used.get(e) ?? 0) + cur[i]);
      for (const [e, u] of used) if (u > (capByEdge.get(e) ?? 0) + 1e-9) return;
      const total = feasible.reduce((s, p, i) => s + cur[i] * p.etaPerSegmentAttempt, 0);
      if (total > best.totalPairs) {
        best = { totalPairs: total, allocation: feasible.map((p, i) => ({ path: p.label, allocated: cur[i], expectedPairs: Math.round(cur[i] * p.etaPerSegmentAttempt) })) };
      }
      return;
    }
    for (const g of grid) { cur[k] = g; rec(k + 1); }
  })(0);
  return { ...best, totalPairs: Math.round(best.totalPairs), evaluated };
}

/** Tek-yol (klasik) taban: yalnızca EN İYİ yolu kullan. */
function singlePathAllocate(G, paths) {
  const feasible = paths.filter(p => p.feasible && p.etaPerSegmentAttempt > 0);
  if (!feasible.length) return { path: null, allocated: 0, totalPairs: 0 };
  const best = feasible.reduce((a, b) => (b.etaPerSegmentAttempt > a.etaPerSegmentAttempt ? b : a));
  const capByEdge = new Map();
  for (let i = 0; i < G.n; i++)
    for (let j = i + 1; j < G.n; j++)
      if (G.A[i][j]) capByEdge.set(edgeKey(G.nodes[i], G.nodes[j]), G.C[i][j]);
  const x = Math.min(...best.edges.map(e => capByEdge.get(e) ?? 0));
  return { path: best.label, allocated: x, totalPairs: Math.round(x * best.etaPerSegmentAttempt) };
}

/** Kenar-ayrık yol kümesi (dayanıklılık ölçütü). */
function edgeDisjointSets(paths) {
  const chosen = [];
  const used = new Set();
  for (const p of [...paths].filter(p => p.feasible).sort((a, b) => b.etaPerSegmentAttempt - a.etaPerSegmentAttempt)) {
    if (p.edges.some(e => used.has(e))) continue;
    chosen.push(p.label);
    for (const e of p.edges) used.add(e);
  }
  return chosen;
}

/** Matris kuvvetleriyle yol sayımı doğrulaması (bağımsız kontrol). */
function verifyWithMatrixPowers(G, src, dst, maxHops) {
  const s = G.idx[src], d = G.idx[dst];
  const walks = {};
  for (let k = 1; k <= maxHops; k++) walks[k] = matPow(G.A, k)[s][d];
  return walks;
}

module.exports = {
  buildMatrices, matMul, matPow, enumeratePaths, describePath, edgeKey,
  measurePathYield, greedyAllocate, bruteForceAllocate, singlePathAllocate,
  edgeDisjointSets, verifyWithMatrixPowers,
};
