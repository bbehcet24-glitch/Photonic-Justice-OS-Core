"use strict";
// ══════════════════════════════════════════════════════════════════
// kalman_sigma_estimator.js — GERÇEK QuantumPhaseBuffer + CorrectionLogRecorder
// ile uçtan uca doğrulama (mock YOK — üçü de SALT-OKUNUR require edilir,
// tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN 9 ŞEY (bkz. KALMAN_SIGMA_ESTIMATOR_DESIGN.md §6):
//   1) Kurucu doğrulaması (deltaMaxRad/initialSigmaRadPerSqrtS gerekli).
//   2) update() temel mekanik: tau=null atlanır, Kalman kazancı [0,1],
//      durum (x=σ²) HER ZAMAN pozitif.
//   3) Jensen YANLILIĞI GERÇEKTEN var (kBias=1 ile YÜKSEK yanlı yakınsama)
//      VE kBias≈1.80 düzeltmesi bunu GERÇEKTEN giderir — ÖNCESİ/SONRASI
//      doğrudan karşılaştırma.
//   4) Senaryo A: SABİT gerçek σ, YANLIŞ başlangıç tahmininden, 5 bağımsız
//      tohumda TÜMÜ gerçek σ'nın ±%25'i içine YAKINSIYOR.
//   5) Senaryo B: ADIM DEĞİŞİMİ (σ sıçraması) — filtre yeni değere
//      MAKUL bir sürede YÖNELİYOR (izleme yeteneği).
//   6) attachToBuffer, CorrectionLogRecorder'ın ZATEN zincirlediği
//      onCorrection'ı KAYBETMEDEN zincirleniyor — HER İKİ SIRALAMADA.
//   7) replayCorrectionLog (TOPLU/geçmiş), attachToBuffer (CANLI/anlık)
//      İLE AYNI correctionLog verisinden AYNI sonucu üretiyor.
//   8) sigmaUncertainty() genel eğilimde AZALIYOR (daha çok veri = daha az belirsizlik).
//   9) çekirdek, quantum_phase_buffer.js VE correction_log_recorder.js
//      bu çalışma boyunca DEĞİŞMEDİ.
//
// İstatistiksel testler (3, 4, 5) rastgele-yürüyüş tabanlı olduğundan, bu
// dosya BİRDEN FAZLA kez art arda çalıştırılıp kararlılığı doğrulandı
// (bkz. commit mesajı).
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("./photonnet_core.js");
const { PhaseDriftModel, QuantumPhaseBuffer } = require("./quantum_phase_buffer.js");
const { CorrectionLogRecorder, runPhaseBufferWithRecording } = require("./correction_log_recorder.js");
const { DEFAULTS, KalmanSigmaEstimator, replayCorrectionLog } = require("./kalman_sigma_estimator.js");

const HASH_BEFORE = {
  bufferJs: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex"),
  recorderJs: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "correction_log_recorder.js"))).digest("hex"),
};

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function seededRng(seed) { return core.mulberry32(seed); }

function runBufferAndRecorder({ trueSigmaFn, deltaMax, correctionIntervalS, pulseCount, pulsePeriodS, seed }) {
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: trueSigmaFn(0), rng: seededRng(seed) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
  recorder.attachToBuffer(buffer);
  for (let i = 0; i < pulseCount; i++) {
    drift.sigmaRadPerSqrtS = trueSigmaFn(buffer._elapsedS);
    const r = buffer.tickPulse(pulsePeriodS);
    recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
    buffer.maybeCorrect();
  }
  return { buffer, recorder };
}

function testConstructorValidation() {
  console.log("── Test 1: kurucu doğrulaması ──");
  let threw = false;
  try { new KalmanSigmaEstimator({ initialSigmaRadPerSqrtS: 0.03 }); } catch (e) { threw = e instanceof RangeError; }
  check("deltaMaxRad eksikse RangeError", threw);

  threw = false;
  try { new KalmanSigmaEstimator({ deltaMaxRad: 0.02 }); } catch (e) { threw = e instanceof RangeError; }
  check("initialSigmaRadPerSqrtS eksikse RangeError", threw);

  const k = new KalmanSigmaEstimator({ deltaMaxRad: 0.02, initialSigmaRadPerSqrtS: 0.03 });
  check("başlangıç x = initialSigma²", Math.abs(k.x - 0.03 * 0.03) < 1e-15);
  check("başlangıç P > 0", k.P > 0);
}

function testUpdateMechanics() {
  console.log("\n── Test 2: update() temel mekanik ──");
  const k = new KalmanSigmaEstimator({ deltaMaxRad: 0.02, initialSigmaRadPerSqrtS: 0.05 });
  check("tau=null → update null döner (atlanır)", k.update({ tau: null, tS: 1 }) === null);
  check("tau=0 → update null döner (atlanır)", k.update({ tau: 0, tS: 1 }) === null);
  check("updateCount hâlâ 0 (hiçbir GERÇEK güncelleme olmadı)", k.updateCount === 0);

  let allGainInRange = true, allXPositive = true;
  let tS = 0;
  for (let i = 0; i < 50; i++) {
    tS += 0.1;
    const tau = 0.05 + Math.random() * 0.05; // rastgele ama makul τ değerleri
    const rec = k.update({ tau, tS });
    if (!(rec.kalmanGain >= 0 && rec.kalmanGain <= 1)) allGainInRange = false;
    if (!(rec.xNew > 0)) allXPositive = false;
  }
  check("50 güncellemede Kalman kazancı HER ZAMAN [0,1] aralığında", allGainInRange);
  check("50 güncellemede durum (x=σ²) HER ZAMAN pozitif", allXPositive);
  check("updateCount=50 (her GERÇEK ölçüm sayıldı)", k.updateCount === 50);
  check("history.length=50", k.history.length === 50);
}

function testJensenBiasCorrectionMatters() {
  console.log("\n── Test 3: Jensen yanlılığı GERÇEKTEN var; kBias≈1.80 düzeltmesi GERÇEKTEN giderir ──");
  const trueSigma = 0.05, deltaMax = 0.015;
  const { recorder } = runBufferAndRecorder({
    trueSigmaFn: () => trueSigma, deltaMax, correctionIntervalS: 1e-6,
    pulseCount: 3000000, pulsePeriodS: 1e-6, seed: 42,
  });
  check("bu senaryoda yeterli düzeltme olayı oluştu (≥15)", recorder.correctionLog.length >= 15, `count=${recorder.correctionLog.length}`);

  const kBiased = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: trueSigma, kBias: 1.0 }); // DÜZELTMESİZ (kBias=1, "naif")
  const kCorrected = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: trueSigma }); // varsayılan kBias≈1.80

  replayCorrectionLog(kBiased, recorder.correctionLog);
  replayCorrectionLog(kCorrected, recorder.correctionLog);

  const biasedRatio = kBiased.sigmaEstimate() / trueSigma;
  const correctedRatio = kCorrected.sigmaEstimate() / trueSigma;
  check(`DÜZELTMESİZ (kBias=1) tahmin, gerçek σ'yı ÖNEMLİ ÖLÇÜDE YÜKSEK gösteriyor (oran=${biasedRatio.toFixed(3)} > 1.15)`,
    biasedRatio > 1.15, `kBiased.sigmaEstimate=${kBiased.sigmaEstimate().toFixed(5)}, trueSigma=${trueSigma}`);
  check(`kBias≈1.80 DÜZELTİLMİŞ tahmin, DÜZELTMESİZE göre gerçek σ'ya ÇOK DAHA YAKIN (oran=${correctedRatio.toFixed(3)}, [0.6,1.5] aralığında)`,
    correctedRatio > 0.6 && correctedRatio < 1.5, `kCorrected.sigmaEstimate=${kCorrected.sigmaEstimate().toFixed(5)}`);
  check("düzeltilmiş tahmin, düzeltmesiz tahminden gerçek σ'ya DAHA YAKIN",
    Math.abs(correctedRatio - 1) < Math.abs(biasedRatio - 1));
}

function testScenarioAConvergence() {
  console.log("\n── Test 4: Senaryo A — SABİT gerçek σ, YANLIŞ başlangıçtan yakınsama (5 bağımsız tohum) ──");
  const trueSigma = 0.05, deltaMax = 0.015;
  const wrongInitial = 0.15;
  let allWithinTolerance = true;
  const rows = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const { recorder } = runBufferAndRecorder({
      trueSigmaFn: () => trueSigma, deltaMax, correctionIntervalS: 1e-6,
      pulseCount: 3000000, pulsePeriodS: 1e-6, seed,
    });
    const kalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: wrongInitial, processNoiseRelRate: 0.3 });
    replayCorrectionLog(kalman, recorder.correctionLog);
    const finalEst = kalman.sigmaEstimate();
    const ok = Math.abs(finalEst - trueSigma) / trueSigma < 0.25;
    allWithinTolerance = allWithinTolerance && ok;
    rows.push(`seed${seed}:est=${finalEst.toFixed(4)}(${ok ? "OK" : "FAIL"})`);
  }
  check(`YANLIŞ başlangıçtan (${wrongInitial}) TÜM 5 tohum gerçek σ=${trueSigma}'nın ±%25'i içine yakınsadı`, allWithinTolerance, rows.join(" | "));
}

function testScenarioBTracking() {
  console.log("\n── Test 5: Senaryo B — ADIM DEĞİŞİMİ (0.03→0.09), filtre YENİ değere YÖNELİYOR ──");
  const switchTS = 1.5, sigmaBefore = 0.03, sigmaAfter = 0.09, deltaMax = 0.015;
  const { recorder } = runBufferAndRecorder({
    trueSigmaFn: (tS) => (tS < switchTS ? sigmaBefore : sigmaAfter),
    deltaMax, correctionIntervalS: 2e-6, pulseCount: 6000000, pulsePeriodS: 1e-6, seed: 7,
  });
  check("adım değişimi öncesi VE sonrası yeterli düzeltme olayı oluştu (≥20)", recorder.correctionLog.length >= 20, `count=${recorder.correctionLog.length}`);

  const kalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: sigmaBefore, processNoiseRelRate: 0.5 });
  const updates = replayCorrectionLog(kalman, recorder.correctionLog);

  const beforeSwitch = updates.filter((u) => u.tS < switchTS);
  const lastFew = updates.filter((u) => u.tS > switchTS).slice(-5);
  check("sıçrama ÖNCESİ son tahmin, sigmaBefore'a MAKUL yakın (±%40)",
    beforeSwitch.length > 0 && Math.abs(beforeSwitch[beforeSwitch.length - 1].sigmaEstimate - sigmaBefore) / sigmaBefore < 0.4,
    beforeSwitch.length ? `est=${beforeSwitch[beforeSwitch.length - 1].sigmaEstimate.toFixed(4)}` : "veri yok");
  check("sıçrama SONRASI son 5 güncellemenin ORTALAMASI, YENİ değere (sigmaAfter) doğru YÖNELDİ (eski değerden UZAKLAŞTI)",
    lastFew.length > 0 && (lastFew.reduce((a, b) => a + b.sigmaEstimate, 0) / lastFew.length) > (sigmaBefore + sigmaAfter) / 2,
    `son5 ortalama=${lastFew.length ? (lastFew.reduce((a, b) => a + b.sigmaEstimate, 0) / lastFew.length).toFixed(4) : "n/a"}`);
}

function testAttachToBufferChainingBothOrders() {
  console.log("\n── Test 6: attachToBuffer, CorrectionLogRecorder'ın zincirini HER İKİ SIRALAMADA KAYBETMİYOR ──");
  const deltaMax = 0.01, correctionIntervalS = 2e-6;

  function runOrder(recorderFirst) {
    const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.06, rng: seededRng(55) });
    const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
    const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
    const kalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: 0.06 });
    if (recorderFirst) { recorder.attachToBuffer(buffer); kalman.attachToBuffer(buffer); }
    else { kalman.attachToBuffer(buffer); recorder.attachToBuffer(buffer); }
    for (let i = 0; i < 1500000; i++) {
      const r = buffer.tickPulse(1e-6);
      recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
      buffer.maybeCorrect();
    }
    return { recorder, kalman };
  }

  const a = runOrder(true);
  const b = runOrder(false);
  check("recorder ÖNCE zincirlenince: recorder.correctionLog VE kalman.updateCount İKİSİ DE dolu",
    a.recorder.correctionLog.length > 0 && a.kalman.updateCount > 0,
    `recorder=${a.recorder.correctionLog.length}, kalman=${a.kalman.updateCount}`);
  check("kalman ÖNCE zincirlenince: recorder.correctionLog VE kalman.updateCount İKİSİ DE dolu (SIRALAMA fark etmiyor)",
    b.recorder.correctionLog.length > 0 && b.kalman.updateCount > 0,
    `recorder=${b.recorder.correctionLog.length}, kalman=${b.kalman.updateCount}`);
  check("her iki sıralamada kalman.updateCount === recorder.correctionLog.length−1 (ilk olayda tau=null, atlanır)",
    a.kalman.updateCount === a.recorder.correctionLog.length - 1 && b.kalman.updateCount === b.recorder.correctionLog.length - 1,
    `a: kalman=${a.kalman.updateCount},recorder=${a.recorder.correctionLog.length} | b: kalman=${b.kalman.updateCount},recorder=${b.recorder.correctionLog.length}`);
}

function testReplayMatchesLiveAttach() {
  console.log("\n── Test 7: replayCorrectionLog (TOPLU), attachToBuffer (CANLI) İLE AYNI SONUCU üretiyor ──");
  const deltaMax = 0.012, correctionIntervalS = 2e-6, initialSigma = 0.05;

  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.05, rng: seededRng(77) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
  const liveKalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: initialSigma });
  recorder.attachToBuffer(buffer);
  liveKalman.attachToBuffer(buffer);
  for (let i = 0; i < 2000000; i++) {
    const r = buffer.tickPulse(1e-6);
    recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
    buffer.maybeCorrect();
  }

  const replayedKalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: initialSigma });
  replayCorrectionLog(replayedKalman, recorder.correctionLog);

  check("CANLI (attachToBuffer) VE TOPLU (replayCorrectionLog) AYNI correctionLog'dan AYNI updateCount üretiyor",
    liveKalman.updateCount === replayedKalman.updateCount, `canlı=${liveKalman.updateCount}, toplu=${replayedKalman.updateCount}`);
  check("CANLI VE TOPLU AYNI nihai σ tahminini üretiyor (BİREBİR — aynı τ dizisi, aynı formül)",
    Math.abs(liveKalman.sigmaEstimate() - replayedKalman.sigmaEstimate()) < 1e-12,
    `canlı=${liveKalman.sigmaEstimate()}, toplu=${replayedKalman.sigmaEstimate()}`);
}

function testSigmaUncertaintyGenerallyDecreases() {
  console.log("\n── Test 8: sigmaUncertainty() genel eğilimde AZALIYOR (daha çok veri = daha az belirsizlik) ──");
  const deltaMax = 0.015;
  const { recorder } = runBufferAndRecorder({
    trueSigmaFn: () => 0.05, deltaMax, correctionIntervalS: 1e-6,
    pulseCount: 3000000, pulsePeriodS: 1e-6, seed: 88,
  });
  const kalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: 0.2, processNoiseRelRate: 0.02 }); // KÜÇÜK süreç gürültüsü — azalma trendi daha temiz görünsün
  const updates = replayCorrectionLog(kalman, recorder.correctionLog);
  check("en az 10 güncelleme oluştu (trend testi için)", updates.length >= 10, `count=${updates.length}`);

  const firstHalfAvgP = updates.slice(0, Math.floor(updates.length / 2)).reduce((a, b) => a + b.PNew, 0) / Math.floor(updates.length / 2);
  const secondHalfAvgP = updates.slice(Math.floor(updates.length / 2)).reduce((a, b) => a + b.PNew, 0) / (updates.length - Math.floor(updates.length / 2));
  check("ikinci yarının ORTALAMA P'si (kovaryans), ilk yarınınkinden KÜÇÜK (belirsizlik AZALDI)",
    secondHalfAvgP < firstHalfAvgP, `ilkYarı=${firstHalfAvgP.toExponential(3)}, ikinciYarı=${secondHalfAvgP.toExponential(3)}`);
  check("son sigmaUncertainty() değeri sonlu ve pozitif", Number.isFinite(kalman.sigmaUncertainty()) && kalman.sigmaUncertainty() > 0);
}

function testFilesUntouched() {
  console.log("\n── Test 9: çekirdek, quantum_phase_buffer.js VE correction_log_recorder.js bu çalışma boyunca DEĞİŞMEDİ ──");
  const coreHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", coreHash === "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05", `hash=${coreHash}`);

  const bufferHashAfter = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex");
  check("bb84/quantum_phase_buffer.js SHA-256, modül-yükleme ANINDAKİYLE AYNI", bufferHashAfter === HASH_BEFORE.bufferJs);

  const recorderHashAfter = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "correction_log_recorder.js"))).digest("hex");
  check("bb84/correction_log_recorder.js SHA-256, modül-yükleme ANINDAKİYLE AYNI", recorderHashAfter === HASH_BEFORE.recorderJs);
}

function main() {
  console.log("═══ kalman_sigma_estimator.js — canlı σ kestirimi, gerçek buffer+recorder ile uçtan uca doğrulama ═══");
  testConstructorValidation();
  testUpdateMechanics();
  testJensenBiasCorrectionMatters();
  testScenarioAConvergence();
  testScenarioBTracking();
  testAttachToBufferChainingBothOrders();
  testReplayMatchesLiveAttach();
  testSigmaUncertaintyGenerallyDecreases();
  testFilesUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
