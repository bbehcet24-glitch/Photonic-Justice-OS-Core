#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * PARALEL YÖNLENDİRME → QKD ANAHTAR ÜRETİM HIZI (R_key)
 * ═══════════════════════════════════════════════════════════════════
 * SORU: Paralel yönlendirmenin sağladığı ×2,48'lik ÇİFT kazancı,
 *       BBM92 / E91 üzerindeki ANAHTAR ÜRETİM HIZINA nasıl yansır?
 *
 * Cevap "×2,48" DEĞİLDİR; üç ayrı etken araya girer:
 *
 *   (1) SONLU-ANAHTAR AMORTİSMANI (kazandırır, süper-doğrusal).
 *       ℓ = n·(1 − h₂(e_ph + μ)) − leak_EC − sabitler
 *       μ ∼ 1/√n olduğu için blok büyüdükçe μ KÜÇÜLÜR. Üç yolun
 *       çiftlerini TEK BLOKTA birleştirmek, μ'yü yol başına ayrı
 *       anahtarlamaya göre √3 kat düşürür. Ayrıca corTerm+paTerm
 *       (~115 bit) blok başına SABİT bir vergidir: 3 blok yerine
 *       1 blok kullanmak bu vergiyi 3 kez değil 1 kez ödetir.
 *
 *   (2) QBER SEYRELMESİ (kaybettirir).
 *       Yollar aynı sadakatte DEĞİL (F = 0,957 / 0,951 / 0,919).
 *       Havuzlanınca faz hatası çiftle-ağırlıklı ortalamaya çıkar;
 *       h₂ dışbükey olduğu için bu ℓ'yi düşürür. Bu yüzden "en kötü
 *       yolu havuzdan çıkarmak" bir SEÇENEKTİR — hangisinin baskın
 *       geldiği VARSAYILMAZ, 7 alt kümenin hepsi taranarak ÖLÇÜLÜR.
 *
 *   (3) MAKESPAN UYUŞMAZLIĞI (kaybettirir).
 *       Üç yol aynı anda BİTMEZ (881 / 1175 / 1469 ms). "Toplam çift"
 *       bir HIZ değildir. Bu yüzden burada tek bir anlık fotoğraf
 *       yerine R_key(T) EĞRİSİ ölçülür: her yolun çiftleri ürediği
 *       ZAMAN DAMGASIYLA (pair.t) tutulur, T anına kadar hazır olanlar
 *       alınır, R_key(T) = ℓ(T)/T olarak hesaplanır.
 *
 * ── GÜVENLİK DÜZELTMESİ: BAZ-ÇÖZÜNÜRLÜ MUHASEBE ──
 * Motorun ürettiği çiftler SAF FAZ gürültülüdür (X = Y = 0 tam olarak).
 * Dolayısıyla:
 *       QBER_Z = X + Y = 0        QBER_X = Z + Y = 1 − F
 * Yani hata oranı BAZA GÖRE ÇOK ASİMETRİKTİR. runQkdFlow() elenmiş
 * bitlerin TAMAMINDAN tek bir QBER sayar; bu karışık ortalama ≈ (1−F)/2
 * olur ve güvenlik kanıtına faz hatası ÜST SINIRI olarak girer. Gerçek
 * faz hatası ise (1−F)'tir — yani iki kat. Bu, ℓ'yi İYİMSER gösterir.
 *
 * Bu dosya çekirdeği ya da runQkdFlow'u DEĞİŞTİRMEZ (52 km çalışmasıyla
 * süreklilik korunur); onun yerine standart "verimli BB84" muhasebesini
 * uygular:
 *       anahtar  ← Z bazı  (n = |Z|),  e_bit = QBER_Z
 *       faz kest.← X bazı  (k = |X|),  e_ph  = QBER_X
 *       ℓ = secureKeyLengthWithMu(n, e_ph, μ(n,k), {realLeakEC: Cascade(Z)})
 * secureKeyLengthWithMu, realLeakEC verildiğinde qBit'i YALNIZCA faz
 * teriminde kullanır — bu yüzden qBit yerine e_ph geçmek TAM OLARAK
 * doğru asimetrik formülü verir. Çekirdeğe dokunmadan.
 *
 * İki muhasebe de raporlanır ve aradaki fark ÖLÇÜLÜR.
 *
 * YENİDEN KULLANIM (yazılmadı, çağrıldı):
 *   quantum_network_matrix.js  — matris + yol + tahsis katmanı
 *   entanglement_multihop_router.js — gerçek çok-atlamalı fizik
 *   photonnet_core.js — CascadeReconciliation, QKDSecurityProof,
 *                       Toeplitz, OTP, mulberry32
 *   qkd_over_entanglement.js — measureBBM92, correlation, privacyAmplify,
 *                              chshRoundsForSignificance
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const G = require("./quantum_network_matrix.js");
const M = require("./entanglement_multihop_router.js");
const Q = require("./qkd_over_entanglement.js");
const { mulberry32, CascadeReconciliation, QKDSecurityProof } = require("./photonnet_core.js");

// ── network_matrix_routing_test.js ile AYNI topoloji ──
const NODES = ["A", "R1", "R2", "R3", "R4", "B"];
const LINKS = [
  { a: "A", b: "R1", km: 10, capacity: 20000 }, { a: "R1", b: "B", km: 12, capacity: 20000 },
  { a: "A", b: "R2", km: 8, capacity: 20000 }, { a: "R2", b: "R3", km: 9, capacity: 20000 },
  { a: "R3", b: "B", km: 8, capacity: 20000 }, { a: "A", b: "R4", km: 15, capacity: 20000 },
  { a: "R4", b: "B", km: 14, capacity: 20000 }, { a: "R1", b: "R3", km: 7, capacity: 20000 },
];
const SIM = {
  attemptsPerSegment: 20000, memorySlots: 20, t1Ms: 5000, t2Ms: 1000,
  targetFinalFidelity: 0.85, seed: 0xE17A0BEE, swapPolicy: "dynamic",
};
const EPS = { epsPE: 1e-10, epsCor: 1e-15, epsPA: 1e-10 };

// ══════════════════════════════════════════════════════════
// BAZ-ÇÖZÜNÜRLÜ BBM92 ANAHTAR ÇIKARIMI
// ══════════════════════════════════════════════════════════
/**
 * Z bazından anahtar, X bazından faz hatası. Hiçbir anahtar biti
 * parametre kestirimine FEDA EDİLMEZ (runQkdFlow'un testFraction=0,25
 * davranışından farkı budur ve ayrıca raporlanır).
 */
function bbm92BasisResolved(pairs, seed) {
  if (!pairs.length) return { ok: false, reason: "çift yok", ell: 0, nZ: 0, kX: 0 };
  const rng = mulberry32(seed >>> 0);
  const m = Q.measureBBM92(pairs, rng);

  const zIdx = [], xIdx = [];
  for (let i = 0; i < m.bases.length; i++) (m.bases[i] === "Z" ? zIdx : xIdx).push(i);
  const n = zIdx.length, k = xIdx.length;
  if (n < 8 || k < 8) return { ok: false, reason: "baz örneklemi çok küçük", ell: 0, nZ: n, kX: k, consumed: pairs.length };

  let zErr = 0; for (const i of zIdx) if (m.aliceBits[i] !== m.bobBits[i]) zErr++;
  let xErr = 0; for (const i of xIdx) if (m.aliceBits[i] !== m.bobBits[i]) xErr++;
  const eBit = zErr / n, ePh = xErr / k;

  // GERÇEK hata düzeltme — Z bazı anahtarı üzerinde, ölçülen sızıntı
  const aKey = zIdx.map(i => m.aliceBits[i]);
  const bKey = zIdx.map(i => m.bobBits[i]);
  const rec = CascadeReconciliation.reconcile(aKey, bKey, Math.max(eBit, 1e-4), rng);

  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, EPS.epsPE);
  const proof = QKDSecurityProof.secureKeyLengthWithMu(n, ePh, mu, {
    epsCor: EPS.epsCor, epsPA: EPS.epsPA, realLeakEC: rec.leakedBits,
  });
  return {
    ok: proof.secure, consumed: pairs.length, sifted: m.siftedCount,
    nZ: n, kX: k,
    eBit: +eBit.toFixed(6), ePh: +ePh.toFixed(6),
    mu: +mu.toFixed(6), qPhUpper: +proof.qPhUpper.toFixed(6),
    leakEC: rec.leakedBits, corTerm: +proof.corTerm.toFixed(2), paTerm: +proof.paTerm.toFixed(2),
    ell: proof.ell,
    reason: proof.secure ? null : "sonlu-anahtar sınırı ℓ ≤ 0 verdi (abort)",
  };
}

/** Karşılaştırma için MEVCUT simetrik muhasebe (runQkdFlow ile aynı mantık). */
function bbm92Symmetric(pairs, seed) {
  if (pairs.length < 16) return { ok: false, ell: 0 };
  const r = Q.runQkdFlow(pairs, { seed, testFraction: 0.25, message: "x", ...EPS });
  return { ok: !!r.security?.secure, ell: r.security?.ell ?? 0, qberEst: r.sampling?.qberEst ?? null, n: r.sampling?.n ?? 0 };
}

// ══════════════════════════════════════════════════════════
// BAZ-ÇÖZÜNÜRLÜ E91 (+ CHSH)
// ══════════════════════════════════════════════════════════
/**
 * E91'de anahtar, EŞLEŞEN yönlerden gelir: (45°,45°) ve (90°,90°).
 * Saf fazda bu ikisinin hata oranı FARKLIDIR:
 *   E(45,45) = I = F        → hata (1−F)/2
 *   E(90,90) = T_xx = 2F−1  → hata 1−F
 * Yani (45°,45°) BBM92'nin Z bazının, (90°,90°) ise X bazının rolünü
 * oynar. Anahtar 45°'den, faz kestirimi 90°'den alınır — BBM92 ile
 * TAM OLARAK aynı argüman.
 * Bedeli: her ayar çifti turların yalnızca 1/9'u (BBM92'de 1/2).
 */
const E91_A = [0, 45, 90], E91_B = [45, 90, 135];
const CHSH_SET = [[0, 45], [0, 135], [90, 45], [90, 135]];

function e91BasisResolved(pairs, seed) {
  if (!pairs.length) return { ok: false, reason: "çift yok", ell: 0 };
  const rng = mulberry32(seed >>> 0);
  const key45A = [], key45B = [], key90A = [], key90B = [];
  const counts = CHSH_SET.map(() => ({ pp: 0, pm: 0, mp: 0, mm: 0 }));

  for (const p of pairs) {
    const s = p.state;
    const da = E91_A[Math.floor(rng() * 3)], db = E91_B[Math.floor(rng() * 3)];
    const E = Q.correlation(s, da, db);
    const same = rng() < (1 + E) / 2;
    const a = rng() < 0.5 ? 1 : 0;
    const b = same ? a : a ^ 1;
    if (da === 45 && db === 45) { key45A.push(a); key45B.push(b); continue; }
    if (da === 90 && db === 90) { key90A.push(a); key90B.push(b); continue; }
    const ci = CHSH_SET.findIndex(([x, y]) => x === da && y === db);
    if (ci >= 0) {
      const c = counts[ci];
      if (a && b) c.pp++; else if (a) c.pm++; else if (b) c.mp++; else c.mm++;
    }
  }
  // CHSH — SAYIMLARDAN
  const Em = counts.map(c => { const t = c.pp + c.pm + c.mp + c.mm; return t ? (c.pp + c.mm - c.pm - c.mp) / t : 0; });
  const S = Em[0] - Em[1] + Em[2] + Em[3];
  let varS = 0;
  counts.forEach((c, i) => { const t = c.pp + c.pm + c.mp + c.mm; if (t) varS += (1 - Em[i] * Em[i]) / t; });
  const seS = Math.sqrt(varS);
  const sigma = seS > 0 ? (S - 2) / seS : 0;
  const chshRounds = counts.reduce((t, c) => t + c.pp + c.pm + c.mp + c.mm, 0);

  const bell = {
    S: +S.toFixed(5), standardError: +seS.toFixed(5),
    sigmaAboveClassical: +sigma.toFixed(2), chshRounds,
    violated: S - 2 > 3 * seS,
    roundsNeededFor3Sigma: Number.isFinite(Q.chshRoundsForSignificance(S, 3)) ? Q.chshRoundsForSignificance(S, 3) : null,
  };

  const n = key45A.length, k = key90A.length;
  if (n < 8 || k < 8) return { ok: false, reason: "eşleşen-yön örneklemi çok küçük", ell: 0, bell, nKey: n, kPE: k, consumed: pairs.length };
  let eBitC = 0; for (let i = 0; i < n; i++) if (key45A[i] !== key45B[i]) eBitC++;
  let ePhC = 0; for (let i = 0; i < k; i++) if (key90A[i] !== key90B[i]) ePhC++;
  const eBit = eBitC / n, ePh = ePhC / k;

  const rec = CascadeReconciliation.reconcile(key45A, key45B, Math.max(eBit, 1e-4), rng);
  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, EPS.epsPE);
  const proof = QKDSecurityProof.secureKeyLengthWithMu(n, ePh, mu, {
    epsCor: EPS.epsCor, epsPA: EPS.epsPA, realLeakEC: rec.leakedBits,
  });
  return {
    ok: proof.secure && bell.violated, consumed: pairs.length, bell,
    nKey: n, kPE: k, eBit: +eBit.toFixed(6), ePh: +ePh.toFixed(6),
    mu: +mu.toFixed(6), leakEC: rec.leakedBits, ell: proof.ell,
    reason: proof.secure ? (bell.violated ? null : "Bell ihlali 3σ ile kanıtlanamadı") : "sonlu-anahtar sınırı ℓ ≤ 0 (abort)",
  };
}

// ══════════════════════════════════════════════════════════
// KOŞUM
// ══════════════════════════════════════════════════════════
function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  // ── 1) Matris + tahsis katmanını YENİDEN ÇALIŞTIR (drift koruması) ──
  const g = G.buildMatrices(NODES, LINKS);
  const paths = G.enumeratePaths(g, "A", "B", 4).map(p => G.measurePathYield(p, SIM));
  const greedy = G.greedyAllocate(g, paths);
  const single = G.singlePathAllocate(g, paths);
  const allocated = greedy.allocation.filter(a => a.allocated > 0);

  out.routing = {
    pathsFound: paths.length,
    allocatedPaths: allocated.map(a => a.path),
    singleBestPath: single.path, singlePairs: single.totalPairs,
    parallelPairs: greedy.totalPairs,
    pairGain: +(greedy.totalPairs / single.totalPairs).toFixed(4),
  };
  chk("Tahsis, commit edilmiş yönlendirme sonucunu yeniden üretiyor (10.277 çift, ×2,48)",
    greedy.totalPairs === 10277 && Math.abs(greedy.totalPairs / single.totalPairs - 2.4848) < 0.001,
    `paralel=${greedy.totalPairs}, tek=${single.totalPairs}, kazanç=×${(greedy.totalPairs / single.totalPairs).toFixed(4)}`);

  // ── 2) Tahsis edilen yolların GERÇEK çiftlerini zaman damgasıyla topla ──
  const byLabel = Object.fromEntries(paths.map(p => [p.label, p]));
  const runs = allocated.map(a => {
    const p = byLabel[a.path];
    const r = M.simulateChain({ nodes: p.nodes, segmentKm: p.segmentKm, ...SIM });
    return {
      label: a.path, hops: p.hops, totalKm: p.totalKm,
      pairs: r.pairs, count: r.pairs.length,
      makespanMs: r.totals.makespanMs, meanF: r.fidelity.mean,
      // Saf faz gürültüsü ⇒ analitik beklenti: e_ph = 1 − F, e_bit = 0
      predictedEPh: +(1 - r.fidelity.mean).toFixed(6),
    };
  });
  const totalCollected = runs.reduce((s, r) => s + r.count, 0);
  chk("Toplanan çift sayısı tahsis toplamıyla birebir aynı", totalCollected === greedy.totalPairs,
    `toplandı=${totalCollected}, tahsis=${greedy.totalPairs}`);
  chk("Tüm çiftler saf faz gürültülü (X = Y = 0) — baz asimetrisinin kaynağı",
    runs.every(r => r.pairs.every(p => p.state.X === 0 && p.state.Y === 0)), "her yolda X=Y=0");

  out.paths = runs.map(r => ({
    label: r.label, hops: r.hops, totalKm: r.totalKm, pairs: r.count,
    makespanMs: r.makespanMs, meanFidelity: r.meanF, predictedPhaseError: r.predictedEPh,
  }));

  const best = runs.reduce((a, b) => (a.count >= b.count ? a : b));
  const upto = (rs, T) => rs.flatMap(r => r.pairs.filter(p => p.t <= T));

  // ── 3) TAM SÜRE fotoğrafı: dört strateji ──
  const T_ALL = Math.max(...runs.map(r => r.makespanMs));
  const T_SINGLE = best.makespanMs;

  const pooled = upto(runs, T_ALL);
  const strat = {};
  strat.single = {
    label: `tek yol (${best.label})`, paths: [best.label],
    pairs: best.count, timeMs: T_SINGLE,
    key: bbm92BasisResolved(best.pairs, 0x51D3C0DE),
    symmetric: bbm92Symmetric(best.pairs, 0x51D3C0DE),
    e91: e91BasisResolved(best.pairs, 0x1E91C0DE),
  };
  strat.perPath = (() => {
    const each = runs.map((r, i) => ({ label: r.label, ...bbm92BasisResolved(r.pairs, 0x51D3C0DE + i) }));
    const e91each = runs.map((r, i) => ({ label: r.label, ...e91BasisResolved(r.pairs, 0x1E91C0DE + i) }));
    return {
      label: "paralel — yol başına AYRI blok", paths: runs.map(r => r.label),
      pairs: totalCollected, timeMs: T_ALL, perBlock: each,
      key: { ell: each.reduce((s, e) => s + e.ell, 0), blocks: each.length,
        note: "corTerm+paTerm blok başına AYRI ayrı ödenir; μ her blokta ayrı ve daha büyüktür" },
      e91: { ell: e91each.reduce((s, e) => s + e.ell, 0), perBlock: e91each },
    };
  })();
  strat.pooled = {
    label: "paralel — TEK birleşik blok", paths: runs.map(r => r.label),
    pairs: pooled.length, timeMs: T_ALL,
    key: bbm92BasisResolved(pooled, 0x51D3C0DE),
    symmetric: bbm92Symmetric(pooled, 0x51D3C0DE),
    e91: e91BasisResolved(pooled, 0x1E91C0DE),
  };

  // ── 4) ALT KÜME TARAMASI: en kötü yolu atmak kazandırır mı? ──
  // Varsayılmaz — 2³−1 = 7 alt kümenin hepsi ölçülür.
  const subsets = [];
  for (let mask = 1; mask < (1 << runs.length); mask++) {
    const sel = runs.filter((_, i) => mask & (1 << i));
    const ps = sel.flatMap(r => r.pairs);
    const T = Math.max(...sel.map(r => r.makespanMs));
    const kr = bbm92BasisResolved(ps, 0x51D3C0DE);
    subsets.push({
      paths: sel.map(r => r.label), pairs: ps.length, timeMs: T,
      ePh: kr.ePh, ell: kr.ell, rKeyBps: +(kr.ell / (T / 1000)).toFixed(2),
    });
  }
  subsets.sort((a, b) => b.ell - a.ell);
  out.subsetScan = subsets;
  const bestSubset = subsets[0];
  strat.bestSubset = {
    label: `paralel — en iyi alt küme (${bestSubset.paths.length}/${runs.length} yol)`,
    paths: bestSubset.paths, pairs: bestSubset.pairs, timeMs: bestSubset.timeMs,
    key: bbm92BasisResolved(runs.filter(r => bestSubset.paths.includes(r.label)).flatMap(r => r.pairs), 0x51D3C0DE),
  };
  chk("Havuzlamanın QBER'i seyrelttiği doğrulandı (birleşik e_ph > en iyi yolun e_ph'i)",
    strat.pooled.key.ePh > strat.single.key.ePh,
    `birleşik e_ph=${strat.pooled.key.ePh} > tek yol e_ph=${strat.single.key.ePh}`);
  chk("Seyrelmeye RAĞMEN üç yolu birden havuzlamak en yüksek ℓ'yi veriyor (amortisman baskın)",
    bestSubset.paths.length === runs.length,
    `en iyi alt küme = [${bestSubset.paths.join(", ")}], ℓ=${bestSubset.ell}`);

  // ── 5) R_key hesapları ──
  const bps = (ell, ms) => +(ell / (ms / 1000)).toFixed(2);
  for (const k of ["single", "perPath", "pooled", "bestSubset"]) {
    const s = strat[k];
    s.rKeyBps = bps(s.key.ell, s.timeMs);
    if (s.e91) s.e91RKeyBps = bps(s.e91.ell, s.timeMs);
  }
  out.strategies = strat;

  // ── KAZANÇ, TEK TOHUMDAN OKUNAMAZ ──
  // ℓ_tek ≈ 75 bit, abort sınırına çok yakındır; ölçüm gürültüsü paydayı
  // ±%16 oynatır ve tek tohumluk oran (×9,04) SAHTE HASSASİYETTİR.
  // Bu yüzden 20 tohum üzerinden ölçülür ve ORANLARIN ORTALAMASI değil
  // ORTALAMALARIN ORANI raporlanır (payda sıfıra yaklaşırken oran
  // ortalaması patlar; oranın beklenen değeri ≠ beklenen değerlerin oranı).
  const GSEEDS = 20;
  const ellSamples = { single: [], perPath: [], pooled: [] };
  for (let s = 0; s < GSEEDS; s++) {
    const sd = (0x51D3C0DE + s * 104729) >>> 0;
    ellSamples.single.push(bbm92BasisResolved(best.pairs, sd).ell);
    ellSamples.pooled.push(bbm92BasisResolved(pooled, sd).ell);
    ellSamples.perPath.push(runs.reduce((t, r, i) => t + bbm92BasisResolved(r.pairs, (sd + i * 7919) >>> 0).ell, 0));
  }
  const stat = (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    return { mean: +m.toFixed(1), sd: +sd.toFixed(1), min: Math.min(...v), max: Math.max(...v), aborts: v.filter(x => x === 0).length };
  };
  const eS = stat(ellSamples.single), eP = stat(ellSamples.pooled), ePP = stat(ellSamples.perPath);
  out.ellStability = { seeds: GSEEDS, single: eS, perPath: ePP, pooled: eP };
  const timeRatio = T_SINGLE / T_ALL;
  out.gains = {
    pairGain: out.routing.pairGain,
    pairRateGain: +((totalCollected / T_ALL) / (best.count / T_SINGLE)).toFixed(4),
    ellGainPooled: +(eP.mean / eS.mean).toFixed(3),
    ellGainPerPath: +(ePP.mean / eS.mean).toFixed(3),
    rKeyGainPooled: +((eP.mean / eS.mean) * timeRatio).toFixed(3),
    rKeyGainPerPath: +((ePP.mean / eS.mean) * timeRatio).toFixed(3),
    ellGainRangeAcrossSeeds: `×${(eP.min / eS.max).toFixed(2)} – ×${(eP.max / eS.min).toFixed(2)}`,
    note: `Kazançlar ${GSEEDS} tohumun ORTALAMALARININ ORANIDIR. Tek tohumluk oran ×${(strat.pooled.key.ell / strat.single.key.ell).toFixed(2)} çıkmıştı — bu sahte hassasiyettir.`,
  };
  chk(`ℓ kazancı tohuma karşı kararlı (tek yol ℓ = ${eS.mean} ± ${eS.sd}, birleşik ℓ = ${eP.mean} ± ${eP.sd})`,
    eS.sd / eS.mean < 0.25 && eP.sd / eP.mean < 0.10,
    `değişkenlik: tek yol %${(100 * eS.sd / eS.mean).toFixed(1)}, birleşik %${(100 * eP.sd / eP.mean).toFixed(1)} · kazanç bandı ${out.gains.ellGainRangeAcrossSeeds}`);
  chk("Yol başına AYRI anahtarlama, paralel kazancı tamamen harcıyor (R_key tek yolun ALTINDA)",
    out.gains.rKeyGainPerPath < 1,
    `ayrı bloklarla R_key kazancı = ×${out.gains.rKeyGainPerPath} (< 1) — 2. ve 3. yol tek başına abort ediyor`);
  chk("Birleşik blok, yol başına ayrı anahtarlamayı yeniyor (sonlu-anahtar amortismanı)",
    eP.mean > ePP.mean,
    `birleşik ℓ=${eP.mean} > ayrı bloklar Σℓ=${ePP.mean} (${GSEEDS} tohum ortalaması)`);
  chk("ℓ kazancı, çift kazancından BÜYÜK (süper-doğrusal — μ ∼ 1/√n)",
    out.gains.ellGainPooled > out.gains.pairGain,
    `ℓ kazancı=×${out.gains.ellGainPooled} > çift kazancı=×${out.gains.pairGain}`);

  // ── 6) SİMETRİK vs BAZ-ÇÖZÜNÜRLÜ muhasebe farkı ──
  // DİKKAT: bu İKİ AYRI etkidir ve TERS yönlere çekerler. Tek bir
  // "ℓ oranı" vermek yanıltıcı olurdu, o yüzden ayrıştırılıyor:
  //   (A) GÜVENLİK AÇIĞI  — simetrik muhasebe faz hatasını olduğundan
  //       DÜŞÜK sınırlar (karışık ortalama ≈ e_ph/2) → ℓ'yi FAZLA verir.
  //   (B) VERİMSİZLİK     — simetrik muhasebe (i) elenmiş bitlerin
  //       %25'ini parametre kestirimine feda eder, (ii) anahtarı hatalı
  //       X bitleriyle karıştırdığı için Cascade sızıntısı çok daha
  //       büyüktür → ℓ'yi AZ verir.
  // Bu örnekte (B) sayısal olarak (A)'yı geçtiği için simetrik ℓ daha
  // KÜÇÜK çıkıyor; ama bu bir GÜVENLİK GARANTİSİ DEĞİL, büyüklüklerin
  // rastlantısı. (A) tek başına ölçülür.
  const h2 = (x) => QKDSecurityProof.h2(Math.min(0.5, Math.max(0, x)));
  const sym = strat.pooled.symmetric, res = strat.pooled.key;
  const muSym = QKDSecurityProof.statisticalFluctuation2(sym.n, Math.round(sym.n / 3), EPS.epsPE);
  const overCredited = Math.round(sym.n * (h2(res.ePh + muSym) - h2(sym.qberEst + muSym)));
  out.accountingComparison = {
    pooled: {
      symmetricQber: sym.qberEst, symmetricN: sym.n, symmetricEll: sym.ell,
      resolvedEBit: res.eBit, resolvedEPh: res.ePh, resolvedN: res.nZ, resolvedEll: res.ell,
      qberRatio: +(sym.qberEst / res.ePh).toFixed(3),
      safetyGapBits: overCredited,
      safetyGapNote: `Simetrik muhasebe faz terimini e_ph=${res.ePh} yerine QBER=${sym.qberEst} ile hesaplıyor; bu, n=${sym.n} bitlik blokta ${overCredited} bit FAZLA kredi demek — güvenlik açığı.`,
      efficiencyNote: `Buna karşılık simetrik akış anahtar bitlerinin %25'ini parametre kestirimine feda ediyor ve e_bit≈${sym.qberEst} olduğu için Cascade sızıntısı çok yüksek; baz-çözünürlü akışta e_bit=${res.eBit} olduğundan sızıntı ${res.leakEC} bitte kalıyor.`,
      netEllDifference: res.ell - sym.ell,
    },
  };
  // Baz asimetrisi iddiası (QBER_karışık ≈ e_ph/2) TEK tohumla test
  // edilemez: k≈1300 örneklemde binom saçılımı ±%20'dir. Bu yüzden
  // ÇOK TOHUMLU ortalama alınır ve binom standart hatasıyla kıyaslanır.
  const SEEDS = 15;
  const multiSeed = (pairs, pick) => {
    const v = [];
    for (let s = 0; s < SEEDS; s++) v.push(pick(bbm92BasisResolved(pairs, (0x51D3C0DE + s * 7919) >>> 0)));
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
    return { mean, se: sd / Math.sqrt(v.length) };
  };
  const pooledPredictedEPh = runs.reduce((s, r) => s + r.count * r.predictedEPh, 0) / totalCollected;
  const msPh = multiSeed(pooled, k => k.ePh);
  out.accountingComparison.pooled.predictedEPh = +pooledPredictedEPh.toFixed(6);
  out.accountingComparison.pooled.measuredEPhMultiSeed = +msPh.mean.toFixed(6);
  chk(`Ölçülen faz hatası, analitik çiftle-ağırlıklı 1−F beklentisiyle uyumlu (${SEEDS} tohum, 4σ)`,
    Math.abs(msPh.mean - pooledPredictedEPh) < 4 * msPh.se,
    `ölçülen=${msPh.mean.toFixed(6)} ± ${msPh.se.toFixed(6)}, öngörü=${pooledPredictedEPh.toFixed(6)}, sapma=${(Math.abs(msPh.mean - pooledPredictedEPh) / msPh.se).toFixed(2)}σ`);
  const msBit = multiSeed(pooled, k => k.eBit);
  chk("Anahtar bazı hata oranı TAM sıfır (saf fazda QBER_Z = X+Y = 0)",
    msBit.mean === 0, `${SEEDS} tohumun hepsinde e_bit = 0`);
  // Karışık-baz QBER'in e_ph/2 olduğu iddiası: e_bit=0 ve |Z|≈|X| ise
  // ortalama TAM OLARAK e_ph/2'dir. Binom hatasıyla test edilir.
  const expectedMixed = msPh.mean / 2;
  const kSym = Math.round(sym.n / 3);
  const seMixed = Math.sqrt(expectedMixed * (1 - expectedMixed) / kSym);
  chk("Karışık-baz QBER = e_ph/2 (baz asimetrisinin doğrudan kanıtı, 4σ)",
    Math.abs(sym.qberEst - expectedMixed) < 4 * seMixed,
    `simetrik QBER=${sym.qberEst}, beklenen e_ph/2=${expectedMixed.toFixed(6)} ± ${seMixed.toFixed(6)} → ${(Math.abs(sym.qberEst - expectedMixed) / seMixed).toFixed(2)}σ`);
  chk("Simetrik muhasebe faz terimini FAZLA kredilendiriyor (güvenlik açığı > 0 bit)",
    overCredited > 0, `${overCredited} bit fazla kredi (n=${sym.n})`);
  // ── 7) R_key(T) EĞRİSİ ──
  // "Toplam çift" bir hız değildir; hız ancak süreye göre tanımlıdır.
  const grid = [];
  for (let T = 100; T <= Math.ceil(T_ALL / 50) * 50 + 1; T += 50) grid.push(T);
  if (grid[grid.length - 1] < T_ALL) grid.push(+T_ALL.toFixed(2));
  out.rKeyCurve = grid.map(T => {
    const sPairs = best.pairs.filter(p => p.t <= T);
    const pPairs = upto(runs, T);
    const sk = bbm92BasisResolved(sPairs, 0x51D3C0DE);
    const pk = bbm92BasisResolved(pPairs, 0x51D3C0DE);
    const pe = e91BasisResolved(pPairs, 0x1E91C0DE);
    const se = e91BasisResolved(sPairs, 0x1E91C0DE);
    return {
      tMs: +T.toFixed(2),
      singlePairs: sPairs.length, parallelPairs: pPairs.length,
      singleEll: sk.ell, parallelEll: pk.ell,
      singleRKeyBps: +(sk.ell / (T / 1000)).toFixed(2),
      parallelRKeyBps: +(pk.ell / (T / 1000)).toFixed(2),
      singleE91Ell: se.ell, parallelE91Ell: pe.ell,
      singleE91RKeyBps: +(se.ell / (T / 1000)).toFixed(2),
      parallelE91RKeyBps: +(pe.ell / (T / 1000)).toFixed(2),
      parallelChshS: pe.bell?.S ?? null, parallelChshSigma: pe.bell?.sigmaAboveClassical ?? null,
    };
  });
  const firstKey = (field) => { const r = out.rKeyCurve.find(x => x[field] > 0); return r ? r.tMs : null; };
  out.breakEven = {
    singleFirstKeyMs: firstKey("singleEll"), parallelFirstKeyMs: firstKey("parallelEll"),
    singleFirstE91Ms: firstKey("singleE91Ell"), parallelFirstE91Ms: firstKey("parallelE91Ell"),
    note: "Sonlu-anahtar sınırı yüzünden her iki strateji de bir EŞİK SÜRESİNDEN önce SIFIR anahtar verir; paralel bu eşiğe daha erken ulaşır.",
  };
  chk("Paralel yönlendirme, ilk güvenli anahtara tek yoldan ERKEN ulaşıyor",
    out.breakEven.parallelFirstKeyMs != null && out.breakEven.singleFirstKeyMs != null &&
    out.breakEven.parallelFirstKeyMs < out.breakEven.singleFirstKeyMs,
    `paralel=${out.breakEven.parallelFirstKeyMs} ms, tek=${out.breakEven.singleFirstKeyMs} ms`);
  chk("R_key eğrisi monoton ARTMIYOR olabilir ama ℓ monoton artmalı (çift eklemek anahtarı azaltamaz)",
    out.rKeyCurve.every((r, i, a) => i === 0 || r.parallelEll >= a[i - 1].parallelEll),
    "parallelEll her adımda azalmıyor");

  // ── 8) E91: Bell testi GEÇİYOR ama anahtar ABORT ediyor ──
  // Bu İKİ AYRI KOŞULDUR. "Bell ihlali kanıtlandı" ≠ "anahtar üretildi".
  // Abort'u rapor edip bırakmak yetersiz olurdu: E91'in bu çiftlerle
  // KAÇ tur gerektirdiği TÜRETİLİR, sonra ÖLÇÜLEREK doğrulanır.
  const e91p = strat.pooled.e91;
  const derivedNeed = (() => {
    if (!e91p.nKey) return null;
    const leakPerBit = e91p.leakEC / e91p.nKey;     // ÖLÇÜLEN Cascade sızıntısı (tahmin değil)
    const corTerm = Math.log2(2 / EPS.epsCor), paTerm = 2 * Math.log2(1 / (2 * EPS.epsPA));
    const ellOf = (n) => {
      const mu = QKDSecurityProof.statisticalFluctuation2(n, n, EPS.epsPE);
      return n * (1 - h2(e91p.ePh + mu)) - leakPerBit * n - corTerm - paTerm;
    };
    if (ellOf(1e9) <= 0) return { impossible: true, leakPerBit: +leakPerBit.toFixed(5) };
    let lo = 8, hi = 1e9;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (ellOf(mid) > 0) hi = mid; else lo = mid; }
    return {
      keyRoundsNeeded: Math.ceil(hi),
      pairsNeeded: Math.ceil(hi * 9),               // (45°,45°) turların 1/9'u
      leakPerBit: +leakPerBit.toFixed(5),
      asymptoticRate: +(1 - h2(e91p.ePh) - leakPerBit).toFixed(5),
    };
  })();
  // TÜRETİMİ ÖLÇEREK DOĞRULA: havuzu çoğaltıp 0,7× ve 1,6× katında
  // gerçekten işaret değiştiriyor mu? (Durum dağılımı aynı kaldığı için
  // çoğaltma, "aynı bağlantıyı daha uzun çalıştırmak" ile eşdeğerdir.)
  let derivedVerify = null;
  if (derivedNeed && !derivedNeed.impossible && derivedNeed.pairsNeeded < 4e6) {
    const rep = (mult) => {
      const want = Math.ceil(derivedNeed.pairsNeeded * mult);
      const buf = [];
      while (buf.length < want) for (const p of pooled) { buf.push(p); if (buf.length >= want) break; }
      return e91BasisResolved(buf, 0x1E91C0DE).ell;
    };
    derivedVerify = { below: rep(0.7), above: rep(1.6) };
    chk("E91 için TÜRETİLEN blok eşiği ölçümle doğrulandı (0,7× → abort, 1,6× → anahtar)",
      derivedVerify.below === 0 && derivedVerify.above > 0,
      `0,7×(${Math.ceil(derivedNeed.pairsNeeded * 0.7)} çift) ℓ=${derivedVerify.below} · 1,6×(${Math.ceil(derivedNeed.pairsNeeded * 1.6)} çift) ℓ=${derivedVerify.above}`);
  }
  out.e91 = {
    pooled: e91p, single: strat.single.e91, requiredBlock: derivedNeed, requiredBlockVerified: derivedVerify,
    note: "E91 anahtarı YALNIZCA eşleşen yönlerden alır: (45°,45°) anahtar, (90°,90°) faz kestirimi — her biri turların 1/9'u. BBM92'de bu oran 1/2'dir. Aradaki fark, Bell testinin ÜCRETİDİR.",
    twoConditions: "Bell ihlalinin istatistiksel olarak kanıtlanması ile sonlu-anahtar sınırının aşılması AYRI koşullardır; burada birincisi geçip ikincisi kalıyor.",
  };
  chk("Birleşik havuzda CHSH ihlali 3σ üzerinde kanıtlandı", !!e91p.bell?.violated,
    `S=${e91p.bell?.S} ± ${e91p.bell?.standardError} (${e91p.bell?.sigmaAboveClassical}σ)`);
  chk("CHSH ihlali kanıtlandığı hâlde E91 anahtarı ABORT ediyor — iki koşul ayrıdır",
    e91p.bell?.violated && e91p.ell === 0,
    `S ihlali ${e91p.bell?.sigmaAboveClassical}σ ama ℓ=${e91p.ell} (anahtar turu ${e91p.nKey}, gereken ≈${derivedNeed?.keyRoundsNeeded ?? "—"})`);
  chk("BBM92, aynı çiftlerden E91'den daha fazla anahtar çıkarıyor (eleme oranı 1/2 vs 1/9)",
    strat.pooled.key.ell > e91p.ell,
    `BBM92 ℓ=${strat.pooled.key.ell} > E91 ℓ=${e91p.ell}`);

  out.allChecksPassed = out.checks.every(c => c.ok);

  // ── ÇIKTI ──
  const rep = path.join(__dirname, "reports", "parallel_routing_qkd_rate.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const pad = (s, w) => String(s).padStart(w);
  const trGroup = (v) => Number(v).toLocaleString("tr-TR");
  console.log("\n══ PARALEL YÖNLENDİRME → QKD ANAHTAR ÜRETİM HIZI ══\n");
  console.log("Yol bazında (her biri 20.000 deneme/segment):");
  for (const p of out.paths)
    console.log(`  ${p.label.padEnd(12)} ${pad(p.pairs, 5)} çift  F=${p.meanFidelity}  e_ph≈${p.predictedPhaseError}  makespan ${pad(p.makespanMs, 8)} ms`);

  console.log("\nStratejiler (baz-çözünürlü muhasebe):");
  console.log("  strateji                         çift    süre(ms)   e_ph      μ       ℓ(bit)   R_key(bit/s)");
  for (const k of ["single", "perPath", "pooled"]) {
    const s = strat[k];
    const e = s.key.ePh ?? "—", mu = s.key.mu ?? "—";
    console.log(`  ${s.label.padEnd(32)}${pad(s.pairs, 6)} ${pad(s.timeMs, 9)}  ${pad(e, 8)} ${pad(mu, 7)} ${pad(s.key.ell, 8)} ${pad(s.rKeyBps, 12)}`);
  }
  console.log("\nKazançlar (tek yola göre):");
  console.log(`  çift            : ×${out.gains.pairGain}`);
  console.log(`  çift HIZI       : ×${out.gains.pairRateGain}   (makespan uyuşmazlığı: ${T_SINGLE} → ${T_ALL} ms)`);
  console.log(`  ℓ (birleşik)    : ×${out.gains.ellGainPooled}   (${GSEEDS} tohum; tohumlar arası bant ${out.gains.ellGainRangeAcrossSeeds})`);
  console.log(`  R_key (birleşik): ×${out.gains.rKeyGainPooled}`);
  console.log(`  R_key (ayrı blk): ×${out.gains.rKeyGainPerPath}`);

  console.log("\nMuhasebe karşılaştırması (birleşik havuz):");
  const ac = out.accountingComparison.pooled;
  console.log(`  simetrik (runQkdFlow) : QBER=${ac.symmetricQber} (karışık baz)  n=${ac.symmetricN}  ℓ=${ac.symmetricEll}`);
  console.log(`  baz-çözünürlü         : e_bit=${ac.resolvedEBit}  e_ph=${ac.resolvedEPh}  n=${ac.resolvedN}  ℓ=${ac.resolvedEll}`);
  console.log(`  (A) GÜVENLİK AÇIĞI    : faz terimi ${ac.safetyGapBits} bit FAZLA kredilendiriliyor`);
  console.log(`  (B) VERİMSİZLİK       : %25 anahtar biti PE'ye feda + karışık bazda Cascade sızıntısı`);
  console.log(`  net ℓ farkı           : ${ac.netEllDifference > 0 ? "+" : ""}${ac.netEllDifference} bit (B, A'yı sayısal olarak geçiyor — GARANTİ değil)`);

  console.log(`\nE91 (birleşik): S=${e91p.bell.S} ± ${e91p.bell.standardError} (${e91p.bell.sigmaAboveClassical}σ, ihlal ${e91p.bell.violated ? "KANITLANDI" : "yok"})  ℓ=${e91p.ell} bit`);
  if (derivedNeed && !derivedNeed.impossible)
    console.log(`  E91 anahtarı için gereken blok: ≈${trGroup(derivedNeed.keyRoundsNeeded)} anahtar turu ≈ ${trGroup(derivedNeed.pairsNeeded)} çift (mevcut ${trGroup(e91p.consumed)})`);
  console.log(`İlk güvenli anahtar: tek yol ${out.breakEven.singleFirstKeyMs} ms · paralel ${out.breakEven.parallelFirstKeyMs} ms`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { bbm92BasisResolved, e91BasisResolved, NODES, LINKS, SIM };
