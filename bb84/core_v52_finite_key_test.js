#!/usr/bin/env node
"use strict";
/**
 * core_v52_finite_key_test.js — çekirdek v5.2 kabul testi (hakem bulguları P0-4, P1-1)
 * ═══════════════════════════════════════════════════════════════════
 *   G1 (P0-4) ε atlamalar arasında birleştiriliyor: 31 atlamalı oturumda atlama başına ε = hedef/31 ve uçtan uca
 *      ε_e2e = Σ(ε_cor + ε_PE + ε_PA) tek atlamalı oturumunkine eşit; epsSplitAcrossHops:false ise 31 katı.
 *   G2 (P1-1) Her atlama kontrolü faz-hata üst sınırını Q + μ olarak raporluyor; atlama ℓ < mesaj biti çıkınca yeniden
 *      test edildiği için ε_PE en çok M = 16 değerlendirmeye bölünüyor (birleşim sınırı) ve sayaç M'yi aşmıyor.
 *   G3 (P1-1) Gerçek QBER %12 iken ölçüm şansla %11'in altına düşse bile anahtar çıkmıyor: k = 100…2000 test biti için
 *      20 000'er binom çekilişinde, %11'in altında ölçülen her durumda ℓ = 0 (güvenlik kararı nokta tahmininden değil
 *      Q + μ'den).
 *   G4 (P1-1) Etkin sonlu-anahtar eşiği: 112 bitlik mesaj için ℓ > 112 veren en büyük Q_test, durma noktasındaki tipik
 *      örneklemde (n ≈ 3 400, k ≈ 850) %2,5 civarı — %11'in çok altında; oturum bunun üstünde daha çok bit toplar.
 *   + çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "G1–G4 SNSPD ile ölçüldü");
const core = require("./photonnet_core.js");
const P = core.QKDSecurityProof, D = core.SecureMessageSession.DEFAULTS;

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const ctx = { isNight: true, freeSpace: false, detectorProfile: "snspd" };
const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const target = D.epsCor + D.epsPE + D.epsPA;

// ══ G1 + G2 ══
{
  const mk = (nHops, split) => new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 60 * nHops, nHops, evesdrop: false, detectorCtx: ctx,
    entropyBits: rb, publicSeed: 4, opts: split === false ? { epsSplitAcrossHops: false } : undefined });
  const one = mk(1).run(), many = mk(31).run(), noSplit = new core.SecureMessageSession({ msg: "x", totalKm: 1842, nHops: 31, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 4, opts: { epsSplitAcrossHops: false } });
  const rel = (a, b) => Math.abs(a - b) / b;
  chk("G1 ε birleştirme: 31 atlamada atlama başına ε = hedef/31, uçtan uca ε tek atlamayla aynı; bölmeden 31 katı",
    rel(one.epsTotal.endToEnd, target) < 1e-9 && rel(many.epsTotal.endToEnd, target) < 1e-9 && rel(many.epsTotal.perHop.epsPE, D.epsPE / 31) < 1e-9
      && rel(noSplit.epsTotal.endToEnd, 31 * target) < 1e-9 && many.status === "DELIVERED",
    `hedef ${target.toExponential(3)}; 1 atlama ${one.epsTotal.endToEnd.toExponential(3)}; 31 atlama ${many.epsTotal.endToEnd.toExponential(3)} (atlama başına ε_PE ${many.epsTotal.perHop.epsPE.toExponential(2)}); bölmeden ${noSplit.epsTotal.endToEnd.toExponential(3)}`);
  const hops = many.hopChecks.filter((h) => Number.isFinite(h.ell));
  const okUpper = hops.length === 31 && hops.every((h) => {
    const mu = P.statisticalFluctuation2(h.n, h.k, many.epsTotal.epsPEPerEvaluation);
    return Math.abs(h.qPhUpper - Math.min(0.5, h.qTest + mu)) < 1e-12 && Math.abs(h.mu - mu) < 1e-12;
  });
  const maxU = Math.max(...hops.map((h) => h.qPhUpper));
  const evals = hops.map((h) => h.evals);
  chk("G2 Her atlama Q + μ'yü raporluyor; μ, atlamanın ε_PE'sinin en çok M değerlendirmeye bölünmüş payıyla (birleşim sınırı); değerlendirme sayısı ≤ M",
    okUpper && evals.every((e) => e >= 1 && e <= D.maxPeEvaluations),
    `M = ${D.maxPeEvaluations}, değerlendirme başına ε_PE ${many.epsTotal.epsPEPerEvaluation.toExponential(2)}; atlama başına değerlendirme ${Math.min(...evals)}–${Math.max(...evals)}; en büyük Q_test %${(Math.max(...hops.map((h) => h.qTest)) * 100).toFixed(2)}, en büyük Q + μ %${(maxU * 100).toFixed(1)}, en küçük ℓ ${Math.min(...hops.map((h) => h.ell))} bit`);
}

// ══ G3 ══
{
  const g = core.mulberry32(20261117), rows = [];
  let leaked = 0;
  for (const k of [100, 200, 400, 850, 2000]) {
    const n = 4 * k, mu = P.statisticalFluctuation2(n, k, D.epsPE);
    let below = 0, withKey = 0;
    for (let t = 0; t < 20000; t++) {
      let e = 0; for (let i = 0; i < k; i++) if (g() < 0.12) e++;
      const q = e / k; if (q >= D.theoreticalQberLimit) continue;
      below++;
      if (P.secureKeyLengthWithMu(n, q, mu, { epsCor: D.epsCor, epsPA: D.epsPA, fEC: D.fEC }).ell > 0) withKey++;
    }
    leaked += withKey; rows.push(`k=${k}: %11 altı ${below}, anahtar ${withKey}`);
  }
  chk("G3 Gerçek QBER %12, ölçüm %11'in altına düşse bile ℓ = 0 (5 × 20 000 binom çekilişi)", leaked === 0, rows.join(" · "));
}

// ══ G4 ══
{
  const thr = (n, k) => { let lo = 0, hi = 0.11; const mu = P.statisticalFluctuation2(n, k, D.epsPE);
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (P.secureKeyLengthWithMu(n, m, mu, { epsCor: D.epsCor, epsPA: D.epsPA, fEC: D.fEC }).ell > 112) lo = m; else hi = m; } return lo; };
  const a = thr(3400, 850), b = thr(13897, 3474), c = thr(78779, 19695);
  out.effectiveThreshold = [{ n: 3400, k: 850, qMax: a }, { n: 13897, k: 3474, qMax: b }, { n: 78779, k: 19695, qMax: c }];
  chk("G4 Etkin sonlu-anahtar eşiği (ℓ > 112 için en büyük Q_test) %11'in çok altında ve örneklem büyüdükçe yükseliyor",
    a < 0.03 && a < b && b < c && c < 0.11,
    `n 3 400 / k 850: %${(a * 100).toFixed(2)} · n 13 897 / k 3 474: %${(b * 100).toFixed(2)} · n 78 779 / k 19 695: %${(c * 100).toFixed(2)} (ε_PE ${D.epsPE})`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı", changelog.includes(coreSha), coreSha.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.writeFileSync(path.join(__dirname, "reports", "core_v52_finite_key.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
