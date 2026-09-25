"use strict";
// ══════════════════════════════════════════════════════════════════
// decoy_state_finite_key.js — GERÇEK decoy_state_protocol.js ile uçtan uca
// doğrulama (mock YOK — decoy_state_protocol.js VE photonnet_core.js
// SALT-OKUNUR require edilir, tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN 7 ŞEY (bkz. DECOY_STATE_FINITE_KEY_DESIGN.md §7):
//   1) chernoffLambdaUpper/Lower: λ⁺≥n≥λ⁻ özdeşliği, ve λ⁺/λ⁻ Monte Carlo
//      KAPSAMA testinde (n çok deneme) hedeflenen ε içinde/altında ihlal.
//   2) finiteRateBounds: girdi doğrulaması ve lower≤upper.
//   3) estimateY1LowerFinite/estimateE1UpperFinite: GERÇEK bir GYS kanalında
//      (bilinen trueY1/trueE1), TEKRARLANAN Monte Carlo denemelerinde
//      Y1LowerFinite≤trueY1 VE e1UpperFinite≥trueE1 İHLAL ORANI ≤ epsPE.
//   4) Y1LowerFinite, AYNI verinin ASİMPTOTİK (nokta-tahmin) Y1Lower'ından
//      HER ZAMAN küçük/eşit (finite-key düzeltmesi GERÇEKTEN daha muhafazakâr).
//   5) pulses→∞ iken Y1LowerFinite → asimptotik Y1Lower (yakınsama).
//   6) combinedSecurityEpsilon: union-bound toplamı doğru.
//   7) çekirdek VE decoy_state_protocol.js bu çalışma boyunca DEĞİŞMEDİ.
//
// İstatistiksel testler (1, 3) rastgele-örneklem tabanlı olduğundan, bu
// dosya BİRDEN FAZLA kez art arda çalıştırılıp kararlılığı doğrulandı
// (bkz. commit mesajı).
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("./photonnet_core.js");
const decoy = require("./decoy_state_protocol.js");
const fk = require("./decoy_state_finite_key.js");

const DECOY_JS_HASH_BEFORE = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "decoy_state_protocol.js"))).digest("hex");

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= eps; }

function testChernoffIdentitiesAndCoverage() {
  console.log("── Test 1: chernoffLambdaUpper/Lower — özdeşlikler + Monte Carlo kapsama ──");
  for (const [n, eps] of [[500, 0.01], [10, 0.05], [0, 0.1], [10000, 1e-6]]) {
    const up = fk.chernoffLambdaUpper(n, eps);
    const lo = fk.chernoffLambdaLower(n, eps);
    if (!(up >= n)) { check(`λ⁺(${n},${eps}) ≥ n`, false, `λ⁺=${up}`); return; }
    if (!(lo <= n)) { check(`λ⁻(${n},${eps}) ≤ n`, false, `λ⁻=${lo}`); return; }
  }
  check("λ⁺(n,ε) ≥ n VE λ⁻(n,ε) ≤ n — 4 test noktasında", true);

  let threw = false;
  try { fk.chernoffLambdaUpper(5, 1.5); } catch (e) { threw = e instanceof RangeError; }
  check("epsilon (0,1) dışında RangeError fırlatıyor", threw);

  // Monte Carlo kapsama — Binomiyal(N,p) tekrarlı örneklem, gerçek λ=Np'nin
  // λ⁺'ı AŞMA / λ⁻'nin ALTINA İNME oranı ölçülüyor (bkz. DESIGN.md §2.3).
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const N = 3000, p = 0.2, eps = 0.02, trials = 30000;
  const lambdaTrue = N * p;
  const rng = mulberry32(123);
  let aboveUpper = 0, belowLower = 0;
  for (let t = 0; t < trials; t++) {
    let n = 0;
    for (let i = 0; i < N; i++) if (rng() < p) n++;
    if (lambdaTrue > fk.chernoffLambdaUpper(n, eps)) aboveUpper++;
    if (lambdaTrue < fk.chernoffLambdaLower(n, eps)) belowLower++;
  }
  check(`λ⁺ ihlal oranı (${(aboveUpper / trials).toFixed(5)}) ≤ hedef ε=${eps} (kapsama GEÇERLİ)`, aboveUpper / trials <= eps);
  check(`λ⁻ ihlal oranı (${(belowLower / trials).toFixed(5)}) ≤ hedef ε=${eps} (kapsama GEÇERLİ)`, belowLower / trials <= eps);
}

function testFiniteRateBoundsValidation() {
  console.log("\n── Test 2: finiteRateBounds — girdi doğrulaması ve lower≤upper ──");
  const b = fk.finiteRateBounds({ count: 42, pulses: 1000, epsilon: 0.01 });
  check("lower ≤ upper", b.lower <= b.upper, `lower=${b.lower}, upper=${b.upper}`);
  check("lower ≥ 0", b.lower >= 0);
  check("upper ≤ 1 civarı (count/pulses'a yakın makul bir aralıkta)", b.upper < 1);

  let threw = false;
  try { fk.finiteRateBounds({ count: 1001, pulses: 1000, epsilon: 0.01 }); } catch (e) { threw = e instanceof RangeError; }
  check("count > pulses RangeError fırlatıyor", threw);

  threw = false;
  try { fk.finiteRateBounds({ count: 5, pulses: 0, epsilon: 0.01 }); } catch (e) { threw = e instanceof RangeError; }
  check("pulses=0 RangeError fırlatıyor", threw);
}

function testFiniteKeyBoundsValidAgainstRealChannel() {
  console.log("\n── Test 3: estimateDecoyFiniteKey — GERÇEK GYS kanalında (bilinen Y1/e1), tekrarlı Monte Carlo ile geçerlilik ──");
  const params = { Y0: 1e-4, e0: 0.5, eDetector: 0.02, eta: 0.15 };
  const mu = 0.5, nu = 0.1;
  const trueY1 = decoy.channelYield(1, params);
  const trueE1 = decoy.channelError(1, params);
  const epsPE = 0.05;
  const pulsesPerIntensity = 8000;
  const outerTrials = 2000;

  let y1Violations = 0, e1Violations = 0;
  for (let t = 0; t < outerTrials; t++) {
    const seedBase = t * 7 + 1;
    const muRun = decoy.simulateIntensity({ core, mu, pulses: pulsesPerIntensity, seed: seedBase, params });
    const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses: pulsesPerIntensity, seed: seedBase + 1, params });
    const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses: pulsesPerIntensity, seed: seedBase + 2, params });
    const result = fk.estimateDecoyFiniteKey({ mu, nu, muRun, nuRun, vacRun, epsPE });
    if (result.Y1LowerFinite > trueY1) y1Violations++;
    if (result.e1UpperFinite < trueE1) e1Violations++;
  }
  check(`Y1LowerFinite > gerçek Y1 (${trueY1.toFixed(5)}) ihlal oranı (${(y1Violations / outerTrials).toFixed(4)}) ≤ epsPE=${epsPE}`,
    y1Violations / outerTrials <= epsPE, `ihlal=${y1Violations}/${outerTrials}`);
  check(`e1UpperFinite < gerçek e1 (${trueE1.toFixed(5)}) ihlal oranı (${(e1Violations / outerTrials).toFixed(4)}) ≤ epsPE=${epsPE}`,
    e1Violations / outerTrials <= epsPE, `ihlal=${e1Violations}/${outerTrials}`);
}

function testFiniteMoreConservativeThanAsymptotic() {
  console.log("\n── Test 4: Y1LowerFinite, AYNI verinin ASİMPTOTİK (nokta-tahmin) Y1Lower'ından HER ZAMAN küçük/eşit ──");
  const params = { Y0: 5e-5, e0: 0.5, eDetector: 0.025, eta: 0.2 };
  const mu = 0.5, nu = 0.1;
  let allOk = true;
  const rows = [];
  for (let seedBase = 1; seedBase <= 20; seedBase++) {
    const muRun = decoy.simulateIntensity({ core, mu, pulses: 5000, seed: seedBase * 11, params });
    const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses: 5000, seed: seedBase * 11 + 1, params });
    const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses: 5000, seed: seedBase * 11 + 2, params });
    const finite = fk.estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE: 0.05 });
    const asymptotic = decoy.estimateY1Lower({ Qmu: muRun.Q, Qnu: nuRun.Q, mu, nu, Y0: vacRun.Q });
    const ok = finite.Y1LowerFinite <= asymptotic + 1e-12;
    allOk = allOk && ok;
    rows.push(`${finite.Y1LowerFinite.toFixed(5)}≤${asymptotic.toFixed(5)}:${ok}`);
  }
  check("20 bağımsız denemenin TAMAMINDA Y1LowerFinite ≤ asimptotik Y1Lower", allOk, rows.join(" | "));
}

function testConvergenceAsPulsesGrow() {
  console.log("\n── Test 5: pulses→∞ iken Y1LowerFinite → asimptotik Y1Lower (yakınsama) ──");
  const params = { Y0: 1e-4, e0: 0.5, eDetector: 0.02, eta: 0.15 };
  const mu = 0.5, nu = 0.1;
  const trueY1 = decoy.channelYield(1, params);

  // NOT: decoy.simulateIntensity() içindeki n (foton sayısı) örneklemesi
  // core.poissonSample() ile yapılır — o fonksiyon KENDİ İÇİNDE Math.random()
  // kullanır (seed'li rng'DEN BAĞIMSIZ, bkz. decoy_state_protocol.js'in
  // KENDİ modül-başı yorumu) — yani simulateIntensity, `seed` SABİT olsa
  // BİLE, n-örneklemi YÜZÜNDEN çalıştırma-arası DETERMİNİSTİK DEĞİLDİR. Bu
  // yüzden en büyük darbe sayısında TEK bir koşu yerine BİRDEN FAZLA
  // BAĞIMSIZ koşunun ORTALAMASI alınıyor (varyansı küçültmek için) —
  // Kuantum Buffer testinde keşfedilen "tek-koşu flaky assertion" dersinden
  // hareketle (bkz. commit mesajı).
  const pulseCounts = [500, 5000, 50000];
  const gaps = [];
  for (const pulses of pulseCounts) {
    const muRun = decoy.simulateIntensity({ core, mu, pulses, seed: 999, params });
    const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses, seed: 998, params });
    const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses, seed: 997, params });
    const finite = fk.estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE: 0.01 });
    gaps.push(trueY1 - finite.Y1LowerFinite); // GERÇEK Y1 ile finite-key alt-sınır arası MESAFE — küçülmeli
  }
  const largePulses = 500000, largeTrials = 6;
  let largeGapSum = 0;
  for (let i = 0; i < largeTrials; i++) {
    const muRun = decoy.simulateIntensity({ core, mu, pulses: largePulses, seed: 2000 + i, params });
    const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses: largePulses, seed: 3000 + i, params });
    const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses: largePulses, seed: 4000 + i, params });
    const finite = fk.estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE: 0.01 });
    largeGapSum += trueY1 - finite.Y1LowerFinite;
  }
  const largeGapMean = largeGapSum / largeTrials;
  gaps.push(largeGapMean);

  let monotonicShrink = true;
  for (let i = 1; i < gaps.length; i++) if (!(gaps[i] <= gaps[i - 1] + 1e-9)) monotonicShrink = false;
  check("darbe sayısı arttıkça (gerçek Y1 − Y1LowerFinite) farkı KÜÇÜLÜYOR (yakınsama)",
    monotonicShrink, `pulseCounts=${pulseCounts.concat([largePulses]).join(",")} → farklar=${gaps.map((g) => g.toFixed(5)).join(",")}`);
  check(`en büyük darbe sayısında (${largePulses}, ${largeTrials} bağımsız koşunun ORTALAMASI) fark çok küçük (<0.02)`,
    largeGapMean < 0.02, `ortalama fark=${largeGapMean.toFixed(6)}`);
}

function testCombinedSecurityEpsilon() {
  console.log("\n── Test 6: combinedSecurityEpsilon — union-bound toplamı ──");
  const r = fk.combinedSecurityEpsilon({ decoyEpsPE: 1e-6, coreEpsPE: 1e-10, epsCor: 1e-15, epsPA: 1e-10 });
  const expected = 1e-6 + 1e-10 + 1e-15 + 1e-10;
  check("totalEpsilon === decoyEpsPE+coreEpsPE+epsCor+epsPA (basit toplama, union bound)",
    approxEqual(r.totalEpsilon, expected, 1e-20), `totalEpsilon=${r.totalEpsilon}, beklenen=${expected}`);
  check("totalEpsilon, decoyEpsPE'den BÜYÜK (diğer terimler EKLENDİ, kaybolmadı)", r.totalEpsilon > r.decoyEpsPE);

  let threw = false;
  try { fk.combinedSecurityEpsilon({ decoyEpsPE: 0 }); } catch (e) { threw = e instanceof RangeError; }
  check("decoyEpsPE<=0 RangeError fırlatıyor", threw);
}

function testCoreAndDecoyProtocolUntouched() {
  console.log("\n── Test 7: çekirdek VE decoy_state_protocol.js bu çalışma boyunca DEĞİŞMEDİ ──");
  const coreHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  const expectedCoreHash = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", coreHash === expectedCoreHash, `hash=${coreHash}`);

  const decoyHashAfter = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "decoy_state_protocol.js"))).digest("hex");
  check("bb84/decoy_state_protocol.js SHA-256, modül-yükleme ANINDAKİYLE (bu çalışmanın başı) AYNI",
    decoyHashAfter === DECOY_JS_HASH_BEFORE, `önce=${DECOY_JS_HASH_BEFORE}, sonra=${decoyHashAfter}`);
}

function main() {
  console.log("═══ decoy_state_finite_key.js — sonlu-boyutlu decoy istatistiği, gerçek decoy_state_protocol.js ile uçtan uca doğrulama ═══");
  testChernoffIdentitiesAndCoverage();
  testFiniteRateBoundsValidation();
  testFiniteKeyBoundsValidAgainstRealChannel();
  testFiniteMoreConservativeThanAsymptotic();
  testConvergenceAsPulsesGrow();
  testCombinedSecurityEpsilon();
  testCoreAndDecoyProtocolUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
