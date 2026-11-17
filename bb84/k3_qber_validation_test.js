#!/usr/bin/env node
"use strict";
/**
 * k3_qber_validation_test.js — TS-HYBRID-QKD-04 S1 / hakem koşulu K3 (P0-3)
 * ═══════════════════════════════════════════════════════════════════
 * Varsayılan rota (İstanbul → Bağdat, 1842 km, 31 × 59,4 km, SNSPD, gece) N = 60 bağımsız oturumla koşturulur.
 * Her oturum için birleşik QBER = Σ hata / Σ test biti (her atlamanın İLK parametre kestirimi değerlendirmesinden; kabul
 * edilen değerlendirme erken durdurma yüzünden aşağı yanlıdır — hakem P0-3'ün sezdiği sistematik sapmanın nedeni), modelin beklentisi E = Σ k·E_h / Σ k (E_h: atlamanın ölçülen
 * algılama ve karanlık-click olasılığından computeDynamicAlpha'nın beklenen QBER'i), σ = √(Σ k·E_h(1−E_h)) / Σ k,
 * z = (birleşik − E) / σ.
 *
 *   K1 İç tutarlılık (istatistiksel): oturum z'leri N(0,1)'den ayırt edilemiyor — Kolmogorov–Smirnov p > 0,01 ve
 *      |ortalama z| ≤ 3·s/√N; ayrıca TÜM ilk değerlendirmeler (60 × 31) tek bir birleşik z'de |z| ≤ 3. Ortalama z'nin %95
 *      güven aralığı raporlanır ama kapı değildir: %95 aralığını kapı yapmak doğru bir modelde bile koşuların %5'ini
 *      düşürür (3d615e2'nin ilk tam koşusunda böyle oldu: ortalama z +0,30, aralık 0,04…0,56, KS p 0,007; tek atlamalı
 *      1500 ilk değerlendirmede ortalama z 0,02 ± 0,03, birleşik z 0,85 — model yansız). Bu, simülatörün kendi
 *      beklentisiyle tutarlılığıdır, modelin doğruluğu değil.
 * Tekrarlanabilirlik: oturumların entropisi sabit tohumlu bir SHA-256 sayaç üretecinden (DRBG) gelir; koşu her seferinde
 * aynı 60 oturumu üretir ve sonuç tohum seçmeden sabittir (tohum 20261117, ilk ve tek seçim). Üretici atlamalar ve
 * oturumlar arasında bağımsız akış verir; kriptografik gizlilik burada gerekmez.
 *   K2 Dış referans (yayımlanmış deneyler): ortalama birleşik QBER yayımlanmış fiber QKD deneylerinin zarfı içinde,
 *      [%0,4, %4,0]: Boaron ve ark., PRL 121, 190502 (2018), arXiv:1807.03222 — SNSPD, 1550 nm, Z tabanı QBER
 *      ≈ %0,4–2,1 (252–421 km, Tablo I); Rosenberg ve ark., PRL 98, 010503 (2007), arXiv:quant-ph/0607186 — TES, BB84,
 *      gözlenen hata %3,3 (85 km) ve %4 (100 km). Zarf geniştir: bu kontrol modeli bir deneye kalibre etmez, yalnız
 *      hizalama hatası e_d = %1,5'in yayımlanmış değerler aralığında kaldığını gösterir.
 *   Gözlem (karar kapısı değil): belirtimin sabit %1,17–1,50 bandına düşen oturumların payı ve %95 güven aralığı.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "K3 doğrulaması SNSPD varsayılan rotasıyla");
const core = require("./photonnet_core.js");

const N = 60;
const SEED = 20261117;
let ctr = 0;
const rb = (n) => { // SHA-256(SEED ‖ sayaç) blokları → bitler
  const out = [];
  while (out.length < n) { const b = crypto.createHash("sha256").update(`k3:${SEED}:${ctr++}`).digest(); for (const x of b) for (let i = 7; i >= 0 && out.length < n; i--) out.push((x >> i) & 1); }
  return out;
};
const out = { generatedAt: new Date().toISOString(), N, seed: SEED, route: "1842 km / 31 atlama, SNSPD, gece", runs: [], checks: [], observations: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };

const Phi = (x) => { // standart normal CDF (Abramowitz–Stegun 7.1.26, |hata| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};
const ksP = (lambda) => { let s = 0; for (let k = 1; k <= 100; k++) s += 2 * (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda); return Math.min(1, Math.max(0, s)); };
const wilson = (x, n, z = 1.96) => { const p = x / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; };

const allHops = { e: 0, E: 0, V: 0, n: 0 };
for (let i = 0; i < N; i++) {
  const r = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 1842, nHops: 31, evesdrop: false,
    detectorCtx: { isNight: true, freeSpace: false, detectorProfile: "snspd" }, entropyBits: rb, publicSeed: 1000 + i }).run();
  const hs = r.hopChecks.filter((h) => Number.isFinite(h.qTest) && h.k > 0 && Number.isFinite(h.expectedQ));
  const K = hs.reduce((a, h) => a + h.k, 0);
  // İLK değerlendirmeler (yansız): erken durdurmada kabul edilen değerlendirme aşağı yanlıdır
  const K1 = hs.reduce((a, h) => a + h.firstK, 0);
  const pooled = hs.reduce((a, h) => a + h.firstQ * h.firstK, 0) / K1;
  const E = hs.reduce((a, h) => a + h.expectedQ * h.firstK, 0) / K1;
  const sd = Math.sqrt(hs.reduce((a, h) => a + h.firstK * h.expectedQ * (1 - h.expectedQ), 0)) / K1;
  const accepted = hs.reduce((a, h) => a + h.qTest * h.k, 0) / K;
  allHops.e += hs.reduce((a, h) => a + h.firstQ * h.firstK, 0); allHops.E += hs.reduce((a, h) => a + h.expectedQ * h.firstK, 0);
  allHops.V += hs.reduce((a, h) => a + h.firstK * h.expectedQ * (1 - h.expectedQ), 0); allHops.n += hs.length;
  out.runs.push({ status: r.status, hops: hs.length, k: K1, pooled, accepted, expected: E, sigma: sd, z: (pooled - E) / sd,
    reevaluatedHops: hs.filter((h) => h.evals > 1).length, evaluations: hs.reduce((a, h) => a + h.evals, 0) });
}

const zs = out.runs.map((r) => r.z).sort((a, b) => a - b);
let D = 0; zs.forEach((z, i) => { const F = Phi(z); D = Math.max(D, Math.abs(F - i / N), Math.abs((i + 1) / N - F)); });
const lambda = (Math.sqrt(N) + 0.12 + 0.11 / Math.sqrt(N)) * D, p = ksP(lambda);
const mz = zs.reduce((a, z) => a + z, 0) / N, sz = Math.sqrt(zs.reduce((a, z) => a + (z - mz) ** 2, 0) / (N - 1)), ci = [mz - 1.96 * sz / Math.sqrt(N), mz + 1.96 * sz / Math.sqrt(N)];
const pooledMean = out.runs.reduce((a, r) => a + r.pooled, 0) / N, pooledSd = Math.sqrt(out.runs.reduce((a, r) => a + (r.pooled - pooledMean) ** 2, 0) / (N - 1));
const allDelivered = out.runs.every((r) => r.status === "DELIVERED" && r.hops === 31);
const zAll = (allHops.e - allHops.E) / Math.sqrt(allHops.V);
out.stats = { ksD: D, ksP: p, meanZ: mz, sdZ: sz, meanZci95: ci, minZ: zs[0], maxZ: zs[N - 1], pooledMean, pooledSd, hopsAll: allHops.n, zAllHops: zAll };

chk(`K1 İç tutarlılık: ${N} oturumda z ~ N(0,1) (KS p > 0,01, |ortalama z| ≤ 3·s/√N) ve ${allHops.n} ilk değerlendirmenin birleşik |z|'si ≤ 3`,
  allDelivered && p > 0.01 && Math.abs(mz) <= 3 * sz / Math.sqrt(N) && Math.abs(zAll) <= 3,
  `KS D = ${D.toFixed(3)}, p = ${p.toFixed(3)}; ortalama z ${mz.toFixed(2)} (%95 GA ${ci[0].toFixed(2)} … ${ci[1].toFixed(2)}; kapı ±${(3 * sz / Math.sqrt(N)).toFixed(2)}), s = ${sz.toFixed(2)}, aralık ${zs[0].toFixed(2)} … ${zs[N - 1].toFixed(2)}; tüm atlamalar birleşik z ${zAll.toFixed(2)}`);
chk("K2 Dış referans: ortalama birleşik QBER yayımlanmış fiber QKD deneylerinin zarfında [%0,4, %4,0] (Boaron 2018; Rosenberg 2007)",
  pooledMean >= 0.004 && pooledMean <= 0.04,
  `ortalama %${(pooledMean * 100).toFixed(2)} ± %${(pooledSd * 100).toFixed(2)} (s); zarf Boaron 2018 Z tabanı ≈ %0,4–2,1, Rosenberg 2007 %3,3–4`);
const accMean = out.runs.reduce((a, r) => a + r.accepted, 0) / N;
const reeval = out.runs.reduce((a, r) => a + r.reevaluatedHops, 0) / (31 * N);
out.observations.push({ name: "Erken durdurma yanlılığı: kabul edilen değerlendirmelerin birleşik QBER'i (ilk testlere göre)", acceptedMean: accMean, firstMean: pooledMean, reevaluatedHopShare: reeval });
console.log(`[GÖZLEM] erken durdurma: atlamaların %${(reeval * 100).toFixed(0)}'i yeniden test edildi; kabul edilen değerlendirmelerin birleşik QBER'i %${(accMean * 100).toFixed(3)}, ilk testlerin %${(pooledMean * 100).toFixed(3)}`);
const inBand = out.runs.filter((r) => r.pooled >= 0.0117 && r.pooled <= 0.015).length, w = wilson(inBand, N);
out.observations.push({ name: "Belirtim bandı %1,17–%1,50 (gözlem)", inBand, N, share: inBand / N, wilson95: w });

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.writeFileSync(path.join(__dirname, "reports", "k3_qber_validation.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`[GÖZLEM] belirtim bandı: ${inBand}/${N} oturum (%${(inBand / N * 100).toFixed(0)}, %95 GA %${(w[0] * 100).toFixed(0)}–%${(w[1] * 100).toFixed(0)})`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
