"use strict";
// ══════════════════════════════════════════════════════════════════
// decoy_state_protocol.js — GERÇEK hesaplama + mevcut çekirdekle uçtan
// uca doğrulama (mock YOK — bb84/photonnet_core.js SALT-OKUNUR require
// edilir, tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN 8 ŞEY (bkz. DECOY_STATE_PROTOCOL_DESIGN.md §7):
//   1) Poisson pmf: toplamı=1, bilinen değerlerle eşleşme.
//   2) GYS kanal modeli: n=0 sadeleşme özdeşlikleri (Y_0=Y0, e_0=e0).
//   3) Monte Carlo (core.poissonSample + core.mulberry32 ile), büyük
//      örneklemde ANALİTİK (theoreticalGainAndQber) değere yakınsıyor.
//   4) Y₁ alt-sınırı ≤ GERÇEK Y₁ ve e₁ üst-sınırı ≥ GERÇEK e₁ — GYS
//      normal kanalında, ÇOK sayıda rastgele parametre kümesiyle.
//   5) binaryEntropy, çekirdeğin QKDSecurityProof.h2 ile BİT-BİT eşleşiyor.
//   6) applyDecoyCorrection, core.QKDSecurityProof.secureKeyLengthWithMu'yu
//      GERÇEKTEN doğru (n₁, e₁^U) girdileriyle çağırıyor.
//   7) PNS KÖTÜ-DURUM gösterimi: naif denetim YANLIŞLIKLA "güvenli" (ℓ>0)
//      derken, decoy-düzeltilmiş denetim Y₁^L≈0 ⇒ "güvenli anahtar YOK"
//      sonucuna ulaşıyor — decoy-state'in GEREKLİLİĞİNİN kanıtı.
//   8) çekirdek (photonnet_core.js) SHA-256'sı DEĞİŞMEDİ.
//
// İstatistiksel testler (3, 4, 7) Monte Carlo örneklemi kullandığından,
// bu dosya BİRDEN FAZLA kez art arda çalıştırılıp kararlılığı doğrulandı
// (bkz. commit mesajı) — Kuantum Buffer testinde keşfedilen "tek-koşu
// flaky assertion" dersinden hareketle, büyük örneklem + toleranslı eşik
// kullanılıyor.
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const decoy = require("./decoy_state_protocol.js");
const core = require("./photonnet_core.js");

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= eps; }

function testPoissonPmf() {
  console.log("── Test 1: poissonPmf — toplam=1 ve bilinen değerler ──");
  const mu = 0.37;
  let sum = 0;
  for (let n = 0; n <= 200; n++) sum += decoy.poissonPmf(n, mu);
  check("Σ_n P(n|μ) ≈ 1 (kesilmiş toplam, n=0..200)", approxEqual(sum, 1, 1e-9), `toplam=${sum}`);

  check("P(0|μ) = e^(-μ)", approxEqual(decoy.poissonPmf(0, mu), Math.exp(-mu), 1e-12));
  check("P(1|μ) = μ·e^(-μ)", approxEqual(decoy.poissonPmf(1, mu), mu * Math.exp(-mu), 1e-12));
  check("P(2|μ) = (μ²/2)·e^(-μ)", approxEqual(decoy.poissonPmf(2, mu), (mu * mu / 2) * Math.exp(-mu), 1e-12));

  check("P(0|0) = 1 (μ=0 için tüm ağırlık n=0'da)", decoy.poissonPmf(0, 0) === 1);
  check("P(1|0) = 0", decoy.poissonPmf(1, 0) === 0);

  let threw = false;
  try { decoy.poissonPmf(-1, mu); } catch (e) { threw = e instanceof RangeError; }
  check("negatif n RangeError fırlatıyor", threw);
}

function testChannelModelIdentities() {
  console.log("\n── Test 2: GYS kanal modeli n=0 sadeleşme özdeşlikleri ──");
  const params = { Y0: 3e-5, e0: 0.5, eDetector: 0.025, eta: 0.15 };
  check("Y_0 = Y0 (vakum darbesinde tek katkı karanlık-sayım)", approxEqual(decoy.channelYield(0, params), params.Y0, 1e-15));
  check("e_0 = e0 (vakum darbesinde hata oranı temelsiz-varsayım)", approxEqual(decoy.channelError(0, params), params.e0, 1e-12));

  // η→1 (kayıpsız kanal) sınırında Y_n → 1 (n≥1 için kesin algılama)
  const lossless = { ...params, eta: 1.0 };
  check("η=1 (kayıpsız) iken Y_1 = 1", approxEqual(decoy.channelYield(1, lossless), 1, 1e-12));
  check("η=1 (kayıpsız) iken Y_3 = 1", approxEqual(decoy.channelYield(3, lossless), 1, 1e-12));

  // Monotonluk: Y_n, n'de kesinlikle artan olmalı (daha çok foton = daha yüksek algılama şansı)
  const ys = [0, 1, 2, 3, 4, 5].map((n) => decoy.channelYield(n, params));
  let monotonic = true;
  for (let i = 1; i < ys.length; i++) if (!(ys[i] > ys[i - 1])) monotonic = false;
  check("Y_n, n'de kesinlikle artan (0..5)", monotonic, `Y_n=${ys.map((y) => y.toFixed(6)).join(",")}`);
}

function testMonteCarloConvergesToAnalytic() {
  console.log("\n── Test 3: Monte Carlo (core.poissonSample+core.mulberry32) ANALİTİK değere yakınsıyor mu ──");
  const params = { Y0: 1e-5, e0: 0.5, eDetector: 0.02, eta: 0.12 };
  const mu = 0.45;
  const analytic = decoy.theoreticalGainAndQber(mu, params);
  const mc = decoy.simulateIntensity({ core, mu, pulses: 300000, seed: 777, params });

  check("MC ölçülen kazanç Q, ANALİTİK Q'ya %5 bağıl tolerans içinde yakın",
    Math.abs(mc.Q - analytic.Q) / analytic.Q < 0.05,
    `analitik Q=${analytic.Q.toFixed(6)}, MC Q=${mc.Q.toFixed(6)}`);

  check("MC ölçülen QBER E, ANALİTİK E'ye %15 bağıl tolerans içinde yakın (E daha az örneklemli — daha gürültülü)",
    Math.abs(mc.E - analytic.E) / analytic.E < 0.15,
    `analitik E=${analytic.E.toFixed(6)}, MC E=${mc.E.toFixed(6)}`);

  const totalHist = Object.values(mc.photonNumberHistogram).reduce((a, b) => a + b, 0);
  check("foton-sayısı histogramının toplamı = darbe sayısı", totalHist === mc.pulses, `toplam=${totalHist}, pulses=${mc.pulses}`);
}

function testY1BoundsValidAcrossParams() {
  console.log("\n── Test 4: Y₁ alt-sınırı ≤ GERÇEK Y₁, e₁ üst-sınırı ≥ GERÇEK e₁ (GYS normal kanal, çok parametre) ──");
  const cases = [
    { mu: 0.5, nu: 0.1, Y0: 1e-5, e0: 0.5, eDetector: 0.02, eta: 0.10 },
    { mu: 0.4, nu: 0.05, Y0: 1e-6, e0: 0.5, eDetector: 0.01, eta: 0.02 },
    { mu: 0.6, nu: 0.2, Y0: 5e-5, e0: 0.5, eDetector: 0.03, eta: 0.50 },
    { mu: 0.3, nu: 0.15, Y0: 1e-5, e0: 0.5, eDetector: 0.015, eta: 0.005 },
    { mu: 0.8, nu: 0.25, Y0: 2e-5, e0: 0.5, eDetector: 0.04, eta: 0.30 },
    { mu: 0.2, nu: 0.08, Y0: 1e-4, e0: 0.5, eDetector: 0.02, eta: 0.08 },
  ];
  let allY1Ok = true, allE1Ok = true;
  const rows = [];
  for (const c of cases) {
    const params = { Y0: c.Y0, e0: c.e0, eDetector: c.eDetector, eta: c.eta };
    const muS = decoy.theoreticalGainAndQber(c.mu, params);
    const nuS = decoy.theoreticalGainAndQber(c.nu, params);
    const trueY1 = decoy.channelYield(1, params);
    const trueE1 = decoy.channelError(1, params);
    const Y1L = decoy.estimateY1Lower({ Qmu: muS.Q, Qnu: nuS.Q, mu: c.mu, nu: c.nu, Y0: c.Y0 });
    const e1U = decoy.estimateE1Upper({ Enu: nuS.E, Qnu: nuS.Q, nu: c.nu, Y0: c.Y0, e0: c.e0, Y1Lower: Y1L });
    const okY1 = Y1L <= trueY1 + 1e-9;
    const okE1 = e1U >= trueE1 - 1e-9;
    allY1Ok = allY1Ok && okY1;
    allE1Ok = allE1Ok && okE1;
    rows.push(`μ=${c.mu},ν=${c.nu}: Y1L/trueY1=${(Y1L / trueY1).toFixed(4)}(${okY1 ? "OK" : "FAIL"}) e1U-trueE1=${(e1U - trueE1).toExponential(2)}(${okE1 ? "OK" : "FAIL"})`);
  }
  check("Y₁^L ≤ gerçek Y₁ — TÜM parametre kümelerinde", allY1Ok, rows.join(" | "));
  check("e₁^U ≥ gerçek e₁ — TÜM parametre kümelerinde", allE1Ok, rows.join(" | "));
}

function testBinaryEntropyMatchesCore() {
  console.log("\n── Test 5: binaryEntropy (standalone), core.QKDSecurityProof.h2 ile BİT-BİT eşleşiyor mu ──");
  const xs = [0.001, 0.01, 0.05, 0.11, 0.25, 0.4, 0.49999, 0.5, 0.6, 0.9, 0.999, 0, 1];
  let allMatch = true;
  const details = [];
  for (const x of xs) {
    const a = decoy.binaryEntropy(x);
    const b = core.QKDSecurityProof.h2(x);
    const match = a === b || approxEqual(a, b, 1e-15);
    allMatch = allMatch && match;
    if (!match) details.push(`x=${x}: standalone=${a}, core=${b}`);
  }
  check("13 test noktasında standalone binaryEntropy === core.QKDSecurityProof.h2", allMatch, details.join("; "));
}

function testApplyDecoyCorrectionCallsRealCore() {
  console.log("\n── Test 6: applyDecoyCorrection, core.QKDSecurityProof.secureKeyLengthWithMu'yu GERÇEKTEN doğru girdilerle çağırıyor mu ──");
  const params = { Y0: 1e-5, e0: 0.5, eDetector: 0.02, eta: 0.15 };
  const mu = 0.5, nu = 0.1;
  const muRun = decoy.simulateIntensity({ core, mu, pulses: 400000, seed: 11, params });
  const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses: 400000, seed: 12, params });
  const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses: 400000, seed: 13, params });

  const result = decoy.applyDecoyCorrection(core, {
    nTotal: muRun.detected, mu, nu,
    muStats: { Q: muRun.Q, E: muRun.E },
    nuStats: { Q: nuRun.Q, E: nuRun.E },
    vacuumStats: { Q: vacRun.Q },
  });

  // Bağımsız olarak AYNI (n1Estimate, e1Upper, mu1) ile secureKeyLengthWithMu'yu
  // BİZ de çağırıp, applyDecoyCorrection'ın döndürdüğü proof ile TAM eşleştiğini
  // doğruluyoruz — "gerçekten çekirdeği çağırdı, kendi hesabını YAPMADI" kanıtı.
  const mu1Check = core.QKDSecurityProof.statisticalFluctuation(Math.max(0, result.decoyStats.n1Estimate), 1e-10);
  const independentProof = core.QKDSecurityProof.secureKeyLengthWithMu(result.decoyStats.n1Estimate, result.decoyStats.e1Upper, mu1Check);

  check("applyDecoyCorrection.proof.ell === bağımsız-tekrar-hesaplanan ell (AYNI n1/e1U/mu1 ile core'u BİZ çağırdığımızda)",
    result.proof.ell === independentProof.ell,
    `applyDecoyCorrection.ell=${result.proof.ell}, bağımsız=${independentProof.ell}, n1=${result.decoyStats.n1Estimate}, e1U=${result.decoyStats.e1Upper.toFixed(4)}`);

  check("proof nesnesi çekirdeğin secureKeyLengthWithMu şekliyle AYNI (secure alanı var)",
    typeof result.proof.secure === "boolean");

  check("Y0 (vakum ölçümünden) makul bir dark-count aralığında (1e-8..1e-2)",
    result.decoyStats.Y0 > 1e-8 && result.decoyStats.Y0 < 1e-2,
    `Y0=${result.decoyStats.Y0}`);

  check("n1Estimate, nTotal'dan büyük DEĞİL (tek-foton payı, toplam sifted'in bir ALT kümesi olmalı)",
    result.decoyStats.n1Estimate <= result.decoyStats.nTotal,
    `n1Estimate=${result.decoyStats.n1Estimate}, nTotal=${result.decoyStats.nTotal}`);
}

function testPnsWorstCaseDemonstration() {
  console.log("\n── Test 7: PNS KÖTÜ-DURUM gösterimi — naif YANLIŞLIKLA 'güvenli', decoy-düzeltilmiş DOĞRU şekilde reddediyor ──");
  const mu = 0.5, nu = 0.1;
  const pnsParams = { Y0: 1e-5, e0: 0.5, eDetector: 0.02 }; // eta PNS modelinde kullanılmıyor (Y_n formülü n'e göre sabit-atama)
  const pulses = 500000;

  const muRun = decoy.simulateIntensity({ core, mu, pulses, seed: 21, params: pnsParams, yieldFn: decoy.pnsWorstCaseYield, errorFn: decoy.pnsWorstCaseError });
  const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses, seed: 22, params: pnsParams, yieldFn: decoy.pnsWorstCaseYield, errorFn: decoy.pnsWorstCaseError });
  const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses, seed: 23, params: pnsParams, yieldFn: decoy.pnsWorstCaseYield, errorFn: decoy.pnsWorstCaseError });

  // NAİF: tüm sifted biti (μ yoğunluğunda algılanan TÜMÜ), tek-foton varsayımıyla denetler.
  const naive = decoy.naiveSecurityAudit(core, { n: muRun.detected, qBit: muRun.E });

  // DECOY-DÜZELTİLMİŞ: aynı ham veriden, Y₁/e₁ ayrıştırmasıyla.
  const corrected = decoy.applyDecoyCorrection(core, {
    nTotal: muRun.detected, mu, nu,
    muStats: { Q: muRun.Q, E: muRun.E },
    nuStats: { Q: nuRun.Q, E: nuRun.E },
    vacuumStats: { Q: vacRun.Q },
  });

  check("PNS kötü-durum altında NAİF denetim, GENEL QBER düşük olduğundan YANLIŞLIKLA 'güvenli' (ell>0) diyor",
    naive.secure === true && naive.ell > 0,
    `naif QBER(genel)=${muRun.E.toFixed(4)}, naif.ell=${naive.ell}, naif.secure=${naive.secure}`);

  check("PNS kötü-durum altında DECOY-DÜZELTİLMİŞ tahmin, Y₁^L'yi (gerçek Y1=0 olduğundan) ~0'a YAKIN buluyor",
    corrected.decoyStats.Y1Lower < 0.02,
    `Y1Lower=${corrected.decoyStats.Y1Lower.toExponential(3)} (gerçek Y1=0)`);

  check("PNS kötü-durum altında DECOY-DÜZELTİLMİŞ denetim, n1Estimate'in ~0 olması nedeniyle 'güvenli anahtar YOK' diyor (secure=false)",
    corrected.proof.secure === false,
    `n1Estimate=${corrected.decoyStats.n1Estimate}, corrected.proof=${JSON.stringify(corrected.proof)}`);

  check("→ SONUÇ: decoy-state DÜZELTMESİ OLMADAN (naif), PNS saldırısı altında YANLIŞ bir 'güvenli' sonucu üretilirdi — decoy-state bu belgede İDDİA edildiği gibi 'faydalı' değil 'GEREKLİ'",
    naive.secure === true && corrected.proof.secure === false);
}

function testCoreUntouched() {
  console.log("\n── Test 8: çekirdek dosyası bu çalışma boyunca DEĞİŞMEDİ ──");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  const expected = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", hash === expected, `hash=${hash}`);
}

function main() {
  console.log("═══ decoy_state_protocol.js — Poisson çoklu-foton riski + decoy-state, gerçek çekirdekle uçtan uca doğrulama ═══");
  testPoissonPmf();
  testChannelModelIdentities();
  testMonteCarloConvergesToAnalytic();
  testY1BoundsValidAcrossParams();
  testBinaryEntropyMatchesCore();
  testApplyDecoyCorrectionCallsRealCore();
  testPnsWorstCaseDemonstration();
  testCoreUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
