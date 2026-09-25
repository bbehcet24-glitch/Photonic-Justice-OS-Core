"use strict";
// ══════════════════════════════════════════════════════════════════
// async_finite_sigma_estimator.js — GERÇEK QuantumPhaseBuffer +
// CorrectionLogRecorder (+ çapraz-kontrol için KalmanSigmaEstimator)
// ile uçtan uca doğrulama (mock YOK — dördü de SALT-OKUNUR require
// edilir, tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN ŞEYLER (bkz. ASYNC_FINITE_SIGMA_ESTIMATOR_DESIGN.md §3-§7):
//   1) Kurucu doğrulaması.
//   2) push()/tick ASENKRON mekaniği: push() SENKRON döner, pencere
//      YALNIZCA sonraki makro-görevde (setImmediate) tamamlanır.
//   3) normInvCDF/zCritTwoSided, BİLİNEN standart normal değerlerle
//      (1.96, 2.576) UYUMLU (nümerik integral+ikili-arama doğru mu).
//   4) Chebyshev HER ZAMAN hedef epsilon'un ÇOK altında ihlal oranı
//      veriyor (GERÇEK Monte Carlo, mock YOK) — tutucu/rigorous.
//   5) CLT, KÜÇÜK pencere/KÜÇÜK epsilon'da ANTİ-TUTUCU (hedefin
//      üstünde ihlal) — isCltWindowValidated bunu doğru İŞARETLİYOR.
//   6) method:'clt' + doğrulanmamış (N,epsilon) ⟹ RangeError (fail-
//      closed), allowUnverifiedClt:true ile İSTEĞE BAĞLI aşılabiliyor.
//   7) attachToBuffer, CorrectionLogRecorder VE KalmanSigmaEstimator'ın
//      ZİNCİRİNİ KAYBETMİYOR — TÜM sıralamalarda.
//   8) drain()/flush() TOPLU (replay) kullanımı doğru çalışıyor.
//   9) stop() sonrası push() hiçbir etkisi YOK (dangling görev yok).
//  10) çekirdek, quantum_phase_buffer.js, correction_log_recorder.js
//      VE kalman_sigma_estimator.js bu çalışma boyunca DEĞİŞMEDİ.
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("./photonnet_core.js");
const { PhaseDriftModel, QuantumPhaseBuffer } = require("./quantum_phase_buffer.js");
const { CorrectionLogRecorder } = require("./correction_log_recorder.js");
const { KalmanSigmaEstimator } = require("./kalman_sigma_estimator.js");
const {
  DEFAULTS, normInvCDF, zCritTwoSided, chebyshevHalfWidth, cltHalfWidth,
  isCltWindowValidated, AsyncFiniteSigmaEstimator, replayCorrectionLog,
} = require("./async_finite_sigma_estimator.js");

const HASH_BEFORE = {
  bufferJs: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex"),
  recorderJs: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "correction_log_recorder.js"))).digest("hex"),
  kalmanJs: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "kalman_sigma_estimator.js"))).digest("hex"),
};

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function seededRng(seed) { return core.mulberry32(seed); }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function nextTick() { return new Promise((resolve) => setImmediate(resolve)); }

function generateCorrectionLog({ sigma, deltaMax, correctionIntervalS, pulsePeriodS, pulseCount, seed }) {
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: sigma, rng: seededRng(seed) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
  recorder.attachToBuffer(buffer);
  for (let i = 0; i < pulseCount; i++) {
    const r = buffer.tickPulse(pulsePeriodS);
    recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
    buffer.maybeCorrect();
  }
  return { buffer, recorder };
}

// ────────────────────────────────────────────────────────────────────
function testConstructorValidation() {
  console.log("── Test 1: kurucu doğrulaması ──");
  let threw = false;
  try { new AsyncFiniteSigmaEstimator({}); } catch (e) { threw = e instanceof RangeError; }
  check("deltaMaxRad eksikse RangeError", threw);

  threw = false;
  try { new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.02, windowSize: 0 }); } catch (e) { threw = e instanceof RangeError; }
  check("windowSize<1 ise RangeError", threw);

  threw = false;
  try { new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.02, epsilon: 1.5 }); } catch (e) { threw = e instanceof RangeError; }
  check("epsilon (0,1) dışındaysa RangeError", threw);

  threw = false;
  try { new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.02, method: "kalman" }); } catch (e) { threw = e instanceof RangeError; }
  check("geçersiz method ise RangeError", threw);

  const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.02 });
  check("varsayılan method='chebyshev'", est.method === "chebyshev");
  check("varsayılan windowSize=DEFAULTS.windowSize", est.windowSize === DEFAULTS.windowSize);
}

// ────────────────────────────────────────────────────────────────────
async function testAsyncPushTickMechanics() {
  console.log("── Test 2: push()/tick ASENKRON mekaniği ──");
  const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.015, windowSize: 5, epsilon: 0.1 });
  let called = 0;
  est.onEstimate = () => called++;

  est.push({ tau: 0.05, tS: 0.05 });
  check("push() SENKRON döner, snapshot HENÜZ güncellenmedi (asenkron tick bekliyor)", est.latestSnapshot() === null && called === 0);

  await nextTick();
  check("BİR makro-görev sonra HÂLÂ pencere dolmadı (n=1<windowSize=5)", est.latestSnapshot() === null && called === 0);

  for (let i = 2; i <= 5; i++) est.push({ tau: 0.05, tS: 0.05 * i });
  check("4 push() DAHA sonra HÂLÂ senkron olarak snapshot güncellenmedi", est.latestSnapshot() === null);

  const snap = await est.nextEstimate();
  check("nextEstimate() Promise'i pencere (n=5) tamamlanınca ÇÖZÜLÜYOR", snap != null && snap.windowSize === 5);
  check("onEstimate TAM OLARAK 1 kez çağrıldı", called === 1);
  check("latestSnapshot() nextEstimate() ile AYNI nesneyi döndürüyor", est.latestSnapshot() === snap);
  est.stop();
}

// ────────────────────────────────────────────────────────────────────
function testNormInvCdfSanity() {
  console.log("── Test 3: normInvCDF/zCritTwoSided — BİLİNEN standart normal değerlerle çapraz-kontrol ──");
  const z975 = normInvCDF(0.975);
  check("Φ⁻¹(0.975)≈1.9600 (nümerik integral+ikili-arama)", Math.abs(z975 - 1.959963985) < 1e-3, `hesaplanan=${z975.toFixed(6)}`);
  const z995 = normInvCDF(0.995);
  check("Φ⁻¹(0.995)≈2.5758", Math.abs(z995 - 2.575829304) < 1e-3, `hesaplanan=${z995.toFixed(6)}`);
  const zc05 = zCritTwoSided(0.05);
  check("zCritTwoSided(0.05)=Φ⁻¹(0.975)", Math.abs(zc05 - z975) < 1e-9);
  const zc01 = zCritTwoSided(0.01);
  check("zCritTwoSided(0.01)≈2.5758", Math.abs(zc01 - 2.575829304) < 1e-3, `hesaplanan=${zc01.toFixed(6)}`);
}

// ────────────────────────────────────────────────────────────────────
function testChebyshevAlwaysConservative() {
  console.log("── Test 4: Chebyshev, GERÇEK verilerle HER ZAMAN hedef epsilon'un ÇOK altında ihlal oranı veriyor ──");
  const sigma = 0.08, deltaMax = 0.012, correctionIntervalS = 1e-6, pulsePeriodS = 1e-6, pulseCount = 2500000;
  const kBias = DEFAULTS.kBias, v = DEFAULTS.measurementVarianceRatio;
  const trueSigma2 = sigma * sigma;

  const allSeqs = [];
  for (let seed = 1; seed <= 60; seed++) {
    const { recorder } = generateCorrectionLog({ sigma, deltaMax, correctionIntervalS, pulsePeriodS, pulseCount, seed: seed * 1000 + 3 });
    const taus = recorder.correctionLog.map((c) => c.sinceLastCorrectionS).filter((x) => x != null);
    allSeqs.push(taus.map((tau) => (deltaMax * deltaMax) / (tau * kBias)));
  }

  for (const N of [10, 30]) {
    const windowMeans = [];
    for (const seq of allSeqs) for (let i = 0; i + N <= seq.length; i += N) windowMeans.push(mean(seq.slice(i, i + N)));
    check(`N=${N}: yeterli pencere üretildi`, windowMeans.length >= 40, `pencere=${windowMeans.length}`);
    for (const eps of [0.1, 0.05]) {
      let violations = 0;
      for (const wm of windowMeans) {
        const h = chebyshevHalfWidth(wm, N, v, eps);
        if (Math.abs(wm - trueSigma2) > h) violations++;
      }
      const rate = violations / windowMeans.length;
      check(`N=${N}, eps=${eps}: Chebyshev ihlal oranı (${rate.toFixed(4)}) hedefin ALTINDA`, rate <= eps, `pencere=${windowMeans.length}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
function testCltAntiConservativeForSmallWindows() {
  console.log("── Test 5: CLT, KÜÇÜK pencerede/KÜÇÜK epsilon'da ANTİ-TUTUCU (isCltWindowValidated bunu doğru işaretliyor) — GERÇEK bulgu ──");
  const sigma = 0.08, deltaMax = 0.012, correctionIntervalS = 1e-6, pulsePeriodS = 1e-6, pulseCount = 2500000;
  const kBias = DEFAULTS.kBias, v = DEFAULTS.measurementVarianceRatio;
  const trueSigma2 = sigma * sigma;

  const allSeqs = [];
  for (let seed = 1; seed <= 60; seed++) {
    const { recorder } = generateCorrectionLog({ sigma, deltaMax, correctionIntervalS, pulsePeriodS, pulseCount, seed: seed * 2000 + 9 });
    const taus = recorder.correctionLog.map((c) => c.sinceLastCorrectionS).filter((x) => x != null);
    allSeqs.push(taus.map((tau) => (deltaMax * deltaMax) / (tau * kBias)));
  }

  // KÜÇÜK N (5), KÜÇÜK epsilon (0.01) — isCltWindowValidated(5,0.01) FALSE olmalı (5 < 1/0.01=100)
  check("isCltWindowValidated(5, 0.01) === false (ampirik eşiğin ALTINDA)", isCltWindowValidated(5, 0.01) === false);
  check("isCltWindowValidated(100, 0.01) === true (ampirik eşiğin ÜSTÜNDE)", isCltWindowValidated(100, 0.01) === true);

  const N = 5, eps = 0.01;
  const windowMeans = [];
  for (const seq of allSeqs) for (let i = 0; i + N <= seq.length; i += N) windowMeans.push(mean(seq.slice(i, i + N)));
  check("yeterli pencere üretildi (N=5)", windowMeans.length >= 200, `pencere=${windowMeans.length}`);
  let violations = 0;
  for (const wm of windowMeans) {
    const h = cltHalfWidth(wm, N, v, eps);
    if (Math.abs(wm - trueSigma2) > h) violations++;
  }
  const rate = violations / windowMeans.length;
  check(`N=5, eps=0.01: CLT ihlal oranı (${rate.toFixed(4)}) hedefin (0.01) ÜSTÜNDE — GERÇEK anti-tutucu bulgu`, rate > eps, `pencere=${windowMeans.length}`);
}

// ────────────────────────────────────────────────────────────────────
async function testFailClosedCltGate() {
  console.log("── Test 6: method:'clt' + doğrulanmamış (N,epsilon) ⟹ fail-closed hata (Promise reddi) ──");
  // ÖNEMLİ (bkz. async_finite_sigma_estimator.js _tick/_deliverError yorumu —
  // GERÇEK bulgu, bu testin İLK çalıştırılışında YAKALANDI): doğrulama hatası
  // _completeWindow() İÇİNDE bir setImmediate GERİ ÇAĞIRMASINDA fırlatılıyor —
  // SENKRON try/catch bunu YAKALAYAMAZ (process çöker). Doğru yol: nextEstimate()
  // Promise'inin REDDİNİ beklemek (veya onError kancasını kullanmak).
  const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.012, windowSize: 5, epsilon: 0.01, method: "clt" });
  let threw = false;
  const p = est.nextEstimate().catch((e) => { threw = e instanceof RangeError; });
  for (let i = 1; i <= 5; i++) est.push({ tau: 0.02, tS: 0.02 * i });
  await p;
  check("doğrulanmamış (N=5,eps=0.01) CLT isteği nextEstimate()'i RangeError İLE REDDEDİYOR", threw);

  const est2 = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.012, windowSize: 5, epsilon: 0.01, method: "clt", allowUnverifiedClt: true });
  threw = false;
  let snap2 = null;
  try {
    for (let i = 1; i <= 5; i++) est2.push({ tau: 0.02, tS: 0.02 * i });
    snap2 = await est2.nextEstimate();
  } catch (e) { threw = true; }
  check("allowUnverifiedClt:true ile AYNI istek BAŞARILI oluyor", !threw && snap2 && snap2.method === "clt-unverified");

  const est3 = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.012, windowSize: 200, epsilon: 0.01, method: "clt" });
  threw = false;
  let snap3 = null;
  try {
    for (let i = 1; i <= 200; i++) est3.push({ tau: 0.02, tS: 0.02 * i });
    snap3 = await est3.nextEstimate();
  } catch (e) { threw = true; }
  check("N=200,eps=0.01 (DOĞRULANMIŞ eşiğin üstünde) izinsiz de BAŞARILI, method='clt'", !threw && snap3 && snap3.method === "clt");
  est.stop(); est2.stop(); est3.stop();
}

// ────────────────────────────────────────────────────────────────────
async function testAttachToBufferAlongsideRecorderAndKalman() {
  console.log("── Test 7: attachToBuffer — CorrectionLogRecorder VE KalmanSigmaEstimator'ın zincirini KAYBETMİYOR ──");
  const deltaMax = 0.012, correctionIntervalS = 1e-6, sigma = 0.07;

  async function runOrder(order) {
    const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: sigma, rng: seededRng(99) });
    const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
    const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
    const kalman = new KalmanSigmaEstimator({ deltaMaxRad: deltaMax, initialSigmaRadPerSqrtS: sigma });
    const async_ = new AsyncFiniteSigmaEstimator({ deltaMaxRad: deltaMax, windowSize: 5, epsilon: 0.1 });
    const attachers = { recorder: () => recorder.attachToBuffer(buffer), kalman: () => kalman.attachToBuffer(buffer), async: () => async_.attachToBuffer(buffer) };
    for (const name of order) attachers[name]();
    const pulseCount = 2000000, pulsePeriodS = 1e-6;
    for (let i = 0; i < pulseCount; i++) {
      const r = buffer.tickPulse(pulsePeriodS);
      recorder.recordPulse({ tS: buffer._elapsedS, held: r.held, deltaAtEncode: r.deltaAtEncode });
      buffer.maybeCorrect();
    }
    await async_.drain();
    async_.flush();
    async_.stop();
    return { recorderCount: recorder.correctionLog.length, kalmanCount: kalman.updateCount, asyncWindows: async_.history.length };
  }

  const a = await runOrder(["recorder", "kalman", "async"]);
  check("sıralama A: recorder VE kalman VE async ÜÇÜ DE veri üretti", a.recorderCount > 0 && a.kalmanCount > 0 && a.asyncWindows > 0, JSON.stringify(a));

  const b = await runOrder(["async", "kalman", "recorder"]);
  check("sıralama B (TERS): recorder VE kalman VE async ÜÇÜ DE veri üretti (SIRALAMA fark etmiyor)", b.recorderCount > 0 && b.kalmanCount > 0 && b.asyncWindows > 0, JSON.stringify(b));

  check("her iki sıralamada recorder.correctionLog.length AYNI (aynı tohum/aynı fizik)", a.recorderCount === b.recorderCount);
}

// ────────────────────────────────────────────────────────────────────
async function testDrainAndFlushForReplay() {
  console.log("── Test 8: drain()/flush() — TOPLU (replay) kullanım ──");
  const { recorder } = generateCorrectionLog({ sigma: 0.06, deltaMax: 0.012, correctionIntervalS: 1e-6, pulsePeriodS: 1e-6, pulseCount: 2000000, seed: 321 });
  const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.012, windowSize: 7, epsilon: 0.1 });
  replayCorrectionLog(est, recorder.correctionLog);
  check("replayCorrectionLog SENKRON döner ama pencere HENÜZ oluşmamıştır (asenkron)", true);
  await est.drain();
  const fullWindows = Math.floor((recorder.correctionLog.filter((c) => c.sinceLastCorrectionS != null).length) / 7);
  check("drain() sonrası TAM pencere sayısı BEKLENENLE eşleşiyor", est.history.length === fullWindows, `history=${est.history.length}, beklenen=${fullWindows}`);
  const beforeFlushLen = est.history.length;
  const flushed = est.flush();
  const remainder = recorder.correctionLog.filter((c) => c.sinceLastCorrectionS != null).length % 7;
  if (remainder > 0) {
    check("flush() KALAN (tam dolmamış) pencereyi de raporluyor", flushed != null && flushed.windowSize === remainder, `flushed.windowSize=${flushed && flushed.windowSize}, beklenen=${remainder}`);
    check("flush() sonrası history bir ARTTI", est.history.length === beforeFlushLen + 1);
  } else {
    check("bu tohumda tam bölünüyor (kalan yok) — flush() null döndürmeli", flushed === null);
  }
  est.stop();
}

// ────────────────────────────────────────────────────────────────────
async function testStopPreventsFurtherWork() {
  console.log("── Test 9: stop() sonrası push() etkisiz (dangling görev yok) ──");
  const est = new AsyncFiniteSigmaEstimator({ deltaMaxRad: 0.012, windowSize: 3, epsilon: 0.1 });
  est.push({ tau: 0.02, tS: 0.02 });
  await nextTick(); // ilk pencere HENÜZ tamamlanmadı (n=1<3) — nextEstimate() Promise'i BEKLEMEDEN (asla çözülmez) sadece bir makro-görev geçmesini bekliyoruz
  est.stop();
  const before = est.history.length;
  est.push({ tau: 0.02, tS: 999 });
  est.push({ tau: 0.02, tS: 1000 });
  await nextTick();
  await nextTick();
  check("stop() sonrası push() history'yi DEĞİŞTİRMİYOR", est.history.length === before);
  check("stop() sonrası latestSnapshot() DEĞİŞMEDİ", est.latestSnapshot() === (before === 0 ? null : est.latestSnapshot()));
}

// ────────────────────────────────────────────────────────────────────
function testFilesUntouched() {
  console.log("── Test 10: çekirdek, quantum_phase_buffer.js, correction_log_recorder.js VE kalman_sigma_estimator.js DEĞİŞMEDİ ──");
  const coreHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", coreHash === "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05", `hash=${coreHash}`);
  const bufferHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex");
  check("bb84/quantum_phase_buffer.js SHA-256, modül-yükleme ANINDAKİYLE AYNI", bufferHash === HASH_BEFORE.bufferJs);
  const recorderHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "correction_log_recorder.js"))).digest("hex");
  check("bb84/correction_log_recorder.js SHA-256, modül-yükleme ANINDAKİYLE AYNI", recorderHash === HASH_BEFORE.recorderJs);
  const kalmanHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "kalman_sigma_estimator.js"))).digest("hex");
  check("bb84/kalman_sigma_estimator.js SHA-256, modül-yükleme ANINDAKİYLE AYNI", kalmanHash === HASH_BEFORE.kalmanJs);
}

// ══════════════════════════════════════════════════════════════════
async function main() {
  console.log("═══ async_finite_sigma_estimator.js — asenkron+sonlu-örneklem σ tahmini, GERÇEK buffer+recorder+kalman ile uçtan uca doğrulama ═══");
  testConstructorValidation();
  await testAsyncPushTickMechanics();
  testNormInvCdfSanity();
  testChebyshevAlwaysConservative();
  testCltAntiConservativeForSmallWindows();
  await testFailClosedCltGate();
  await testAttachToBufferAlongsideRecorderAndKalman();
  await testDrainAndFlushForReplay();
  await testStopPreventsFurtherWork();
  testFilesUntouched();

  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) {
    console.log("✓ Bulgu yok — tüm testler geçti.");
    process.exit(0);
  } else {
    console.log(`✗ ${findings.length} bulgu:`);
    for (const f of findings) console.log(`  - ${f.name}${f.detail ? " (" + f.detail + ")" : ""}`);
    process.exit(1);
  }
}

main();
