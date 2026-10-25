#!/usr/bin/env node
"use strict";
/**
 * qber_abort_policy_test.js — QBER iptal politikası (çekirdeğe dokunmayan katman)
 * ═══════════════════════════════════════════════════════════════════
 *   Q1 ℓ = 0 uçurumu çekirdeğin kendi formülünden: n = k = 10⁶'da detector_recalibration
 *      raporundaki %9,59 ile aynı; blok boyuyla tekdüze artıyor; her n'de %11'in ALTINDA
 *   Q2 Politika kararları uçurumun iki yanında doğru; NaN / boş test örneklemi → ABORT
 *   Q3 Kâhinsiz kestirim: test bitleri anahtardan ÇIKARILIYOR (ayrık); büyük örnekte QBER_test,
 *      kâhin QBER'in 4σ içinde
 *   Q4 Çekirdek oturumu (50 km, mesaj boyu): çekirdek bayrağı "temiz" deyip anahtarı kullanırdı;
 *      politika ABORT diyor — mesaj başına blok sonlu-anahtar anlamında güvenli anahtar ÜRETEMEZ
 *   Q5 Çekirdek + casus (intercept-resend, ~%25): çekirdek ve politika ikisi de iptal
 *   Q6 Havuzlanmış blok: 200 çekirdek oturumu birleştirilince (n ≈ 3·10⁴) politika PROCEED,
 *      ℓ > 0; aynı havuz casus altında ABORT
 *   Q7 Kapı kanıtı: gateEvidence eşik ≤ uçurum, öz-test doğrulandı
 *   + photonnet_core.js değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const QA = require("./qber_abort_policy.js");

const CORE_SHA = "5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function session(seed, km, eve, nBits = 4096) {
  const rng = core.mulberry32(seed);
  const bits = Array.from({ length: nBits }, () => (rng() < 0.5 ? 0 : 1));
  return new core.QuantumKeyDistribution(seed).deriveSiftedKey(bits, km, eve, core.mulberry32(seed ^ 0x9e3779b9));
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const sha0 = coreSha();
  const pol = new QA.QberAbortPolicy();

  // ══ Q1 ══
  const nk = [[1600, 400], [1e4, 2500], [1e5, 25000], [1e6, 250000], [1e8, 2.5e7]].map(([n, k]) => ({ n, k, c: QA.qberCliff(n, k) }));
  let lo = 0, hi = 0.5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (core.QKDSecurityProof.secureKeyLength(1e6, m).ellRaw > 0) lo = m; else hi = m; }
  const nEqK = QA.qberCliff(1e6, 1e6);
  chk("Q1 ℓ = 0 uçurumu çekirdeğin formülünden: çekirdeğin tek-parametreli n=k kısayolu (secureKeyLength) n = 10⁶'da %9,59 veriyor (detector_recalibration raporuyla aynı); politika iki-parametreli Serfling μ kullanıyor, aynı n = k'da %9,50 (daha muhafazakâr); blok boyuyla tekdüze artıyor; hepsi %11'in altında",
    Math.abs(lo - 0.0959) < 0.0005 && nEqK < lo && lo - nEqK < 0.002 && nk.every((x, i) => i === 0 || x.c > nk[i - 1].c) && nk.every((x) => x.c < 0.11),
    `n=k=10⁶: çekirdek kısayolu %${(100 * lo).toFixed(3)}, politika (iki-parametreli μ) %${(100 * nEqK).toFixed(3)} · k = n/4: ` + nk.map((x) => `n=${x.n.toExponential(0)}: %${(100 * x.c).toFixed(2)}`).join(" · "));

  // ══ Q2 ══
  const c = QA.qberCliff(1e6, 2.5e5);
  const a = pol.evaluateBlock({ n: 1e6, k: 2.5e5, qberTest: c + 1e-4 }), b = pol.evaluateBlock({ n: 1e6, k: 2.5e5, qberTest: c - 1e-3 });
  const nan = pol.evaluateBlock({ n: 1e6, k: 0, qberTest: NaN }), tiny = pol.evaluateBlock({ n: 100, k: 25, qberTest: 0 });
  chk("Q2 Kararlar: uçurumun 0,01 puan üstü ABORT, 0,1 puan altı PROCEED (ℓ > 0); test örneklemi yok → ABORT; hiçbir QBER'de ℓ > 0 olmayan küçük blok → ABORT (QBER 0 olsa bile)",
    a.decision === "ABORT" && b.decision === "PROCEED" && b.ell > 0 && nan.decision === "ABORT" && tiny.decision === "ABORT",
    `uçurum %${(100 * c).toFixed(3)} · üstü: ${a.decision} · altı: ${b.decision}, ℓ=${b.ell} · NaN: ${nan.decision} (${nan.reason}) · n=100: ${tiny.decision} (${tiny.reason})`);

  // ══ Q3 ══
  const rng = core.mulberry32(3), N = 200000, p = 0.03;
  const A = Array.from({ length: N }, () => (rng() < 0.5 ? 0 : 1)), B = A.map((x) => (rng() < p ? x ^ 1 : x));
  const oracle = A.reduce((s, x, i) => s + (x !== B[i] ? 1 : 0), 0) / N;
  const pe = QA.parameterEstimate(A, B, { testFraction: 0.2, rng: core.mulberry32(4) });
  const keySet = new Set(pe.keyIdx);
  const sigma = Math.sqrt(oracle * (1 - oracle) / pe.k);
  chk("Q3 Kâhinsiz kestirim: k = %20 test biti açıklanıp anahtardan çıkarılıyor (k + n = N, ayrık); QBER_test kâhin QBER'in 4σ içinde",
    pe.k + pe.n === N && keySet.size === pe.n && pe.k === 40000 && Math.abs(pe.qberTest - oracle) < 4 * sigma,
    `N=${N}, k=${pe.k}, n=${pe.n} · kâhin %${(100 * oracle).toFixed(3)}, test %${(100 * pe.qberTest).toFixed(3)} (σ=%${(100 * sigma).toFixed(3)})`);

  // ══ Q4 ══
  const s4 = session(101, 50, false);
  const g4 = pol.guardSession(s4, { rng: core.mulberry32(7) });
  chk("Q4 Çekirdek oturumu (50 km, 4096 darbe): çekirdeğin kâhin QBER'i %11'in altında, bayrak YOK, anahtarı kullanırdı; politika ABORT — mesaj boyunda (n ≈ 10³) uçurum çok düşük, sonlu-anahtar anlamında güvenli anahtar ÇIKMIYOR",
    !s4.eavesdropDetected && g4.coreWouldUseKey && g4.decision === "ABORT" && !g4.aliceKey,
    `4096 darbeden sifted ${g4.siftedBits} bit · çekirdek kâhin QBER %${(100 * s4.qber).toFixed(2)}, bayrak ${s4.eavesdropDetected} · politika: n=${g4.n}, k=${g4.k}, QBER_test %${(100 * g4.qberTest).toFixed(2)}, uçurum %${(100 * g4.cliff).toFixed(2)} → ${g4.decision} (${g4.reason})`);

  // ══ Q5 ══
  const s5 = session(202, 50, true);
  const g5 = pol.guardSession(s5, { rng: core.mulberry32(8) });
  chk("Q5 Çekirdek + intercept-resend casusu: QBER ~%25, çekirdek bayrağı ve politika ikisi de iptal",
    s5.eavesdropDetected && g5.decision === "ABORT" && s5.qber > 0.2,
    `çekirdek QBER %${(100 * s5.qber).toFixed(2)}, bayrak ${s5.eavesdropDetected} · politika ${g5.decision}`);

  // ══ Q6 Havuzlanmış blok ══
  const pool = (eve) => { const al = [], bo = []; for (let i = 0; i < 200; i++) { const s = session(1000 + i, 50, eve); al.push(...s.siftedKeyBits); bo.push(...s.bobKeyBits); } return { siftedKeyBits: al, bobKeyBits: bo, qber: al.reduce((x, v, j) => x + (v !== bo[j] ? 1 : 0), 0) / al.length, eavesdropDetected: false }; };
  const pClean = pool(false), gClean = pol.guardSession(pClean, { rng: core.mulberry32(9) });
  const pEve = pool(true), gEve = pol.guardSession(pEve, { rng: core.mulberry32(10) });
  chk("Q6 Havuzlanmış blok (200 çekirdek oturumu, 50 km, ~3·10⁴ anahtar biti): uçurum %7'nin üstüne çıkıyor → PROCEED, ℓ > 0, anahtar test bitlerinden ayrık; aynı havuz casus altında ABORT",
    gClean.decision === "PROCEED" && gClean.ell > 0 && gClean.cliff > 0.07 && gClean.aliceKey.length === gClean.n && gEve.decision === "ABORT",
    `temiz: sifted ${gClean.siftedBits}, n=${gClean.n}, k=${gClean.k}, QBER_test %${(100 * gClean.qberTest).toFixed(2)}, uçurum %${(100 * gClean.cliff).toFixed(2)}, ℓ=${gClean.ell} (n'nin %${(100 * gClean.ell / gClean.n).toFixed(1)}'i) · casus: QBER_test %${(100 * gEve.qberTest).toFixed(2)} → ${gEve.decision}`);

  // ══ Q7 ══
  const ev = pol.gateEvidence();
  chk("Q7 Kapı kanıtı: etkin eşik ≤ ℓ-uçurumu (n = 10⁶, k = 2,5·10⁵) ve öz-test üç kararı doğru veriyor",
    ev.verified && ev.thresholdQber <= ev.cliffQber && ev.thresholdQber < 0.11,
    `eşik %${(100 * ev.thresholdQber).toFixed(2)}, uçurum %${(100 * ev.cliffQber).toFixed(2)} · ${JSON.stringify(ev.checks)}`);

  chk("Çekirdek değişmedi (photonnet_core.js SHA-256)", sha0 === CORE_SHA && coreSha() === CORE_SHA, coreSha().slice(0, 16) + "…");

  out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "qber_abort_policy.json"), JSON.stringify(out, null, 2));
  for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}
main();
