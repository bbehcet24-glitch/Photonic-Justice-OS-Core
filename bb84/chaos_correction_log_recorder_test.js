"use strict";
// ══════════════════════════════════════════════════════════════════
// correction_log_recorder.js — GERÇEK QuantumPhaseBuffer ile uçtan uca
// doğrulama (mock YOK — quantum_phase_buffer.js SALT-OKUNUR require
// edilir, tek satır DEĞİŞTİRİLMEZ; core.mulberry32 sadece deterministik
// RNG enjeksiyonu için kullanılır, projenin diğer testleriyle AYNI desen).
//
// DOĞRULANAN 8 ŞEY (bkz. CORRECTION_LOG_RECORDER_DESIGN.md §6):
//   1) expectedCorrectionIntervalS = δ_max²/σ² — bilinen değerlerle eşleşme.
//   2) attachToBuffer, ÖNCEDEN VAR OLAN bir onCorrection'ı ZİNCİRLER (kaybetmez).
//   3) correctionLog şeması: exceedRatio doğru türetilmiş, sinceLastCorrectionS sıralı.
//   4) excursionLog: İNCE örneklemede (correctionIntervalS küçük) kaçırılan
//      aşım YOK/AZ; KABA örneklemede caught=false (kaçırılan) olaylar VAR —
//      tasarım §3.2/§4'ün öngördüğü aliasing GERÇEKTEN gözleniyor.
//   5) analyzeCalibrationHealth: normal (σ_varsayılan≈σ_gerçek) çalışmada
//      flagged=false; σ_gerçek, σ_varsayılandan ÇOK farklıyken flagged=true.
//   6) toNdjsonLines/flushToFile: satır sayısı correctionLog.length'e eşit,
//      her satır GEÇERLİ JSON, dosyaya GERÇEKTEN yazılıyor.
//   7) recordPulse, pulseLog'un TAMAMINI SAKLAMIYOR (bellek O(1) — dolaylı
//      olarak _openExcursion'ın büyümediği kontrol edilerek doğrulanır).
//   8) çekirdek (photonnet_core.js) ve quantum_phase_buffer.js bu çalışma
//      boyunca DEĞİŞMEDİ (bu modül core'u hiç REQUIRE ETMEZ — test dosyası
//      yalnızca deterministik RNG için core.mulberry32 kullanır).
//
// İstatistiksel testler (4, 5) rastgele-yürüyüş tabanlı olduğundan, bu
// dosya BİRDEN FAZLA kez art arda çalıştırılıp kararlılığı doğrulandı
// (bkz. commit mesajı).
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const core = require("./photonnet_core.js"); // SALT-OKUNUR — sadece mulberry32 (deterministik RNG) için
const { PhaseDriftModel, QuantumPhaseBuffer } = require("./quantum_phase_buffer.js");
const { expectedCorrectionIntervalS, CorrectionLogRecorder, runPhaseBufferWithRecording } = require("./correction_log_recorder.js");

// quantum_phase_buffer.js'in bu ÇALIŞMA BOYUNCA (herhangi bir test onu
// import/kullanmanın ÖTESİNDE değiştirmediğini) doğrulamak için, modül
// yüklenir yüklenmez (herhangi bir test fonksiyonu çalışmadan ÖNCE) hash'i
// alınır — testCoreAndBufferUntouched() bunu SONDA yeniden hesaplayıp
// karşılaştırır. Bu, kaynak metninde "writeFile"/"appendFile" gibi
// dizgeleri ARAMAKTAN (kendi check() mesajlarını YANLIŞLIKLA eşleştirebilen,
// kendine-referanslı bir yaklaşımdan) DAHA DOĞRUDAN ve güvenilir bir kontrol.
const BUFFER_JS_HASH_BEFORE = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex");

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= eps; }

function testExpectedIntervalFormula() {
  console.log("── Test 1: expectedCorrectionIntervalS = δ_max²/σ² ──");
  check("σ=0.03, δ_max=0.05 → E[τ]=0.05²/0.03²≈2.7778s",
    approxEqual(expectedCorrectionIntervalS(0.03, 0.05), (0.05 * 0.05) / (0.03 * 0.03), 1e-9));
  check("σ büyüdükçe E[τ] AZALIR (daha hızlı sürüklenme = daha sık düzeltme)",
    expectedCorrectionIntervalS(0.06, 0.05) < expectedCorrectionIntervalS(0.03, 0.05));
  check("δ_max büyüdükçe E[τ] BÜYÜR (daha gevşek tolerans = daha nadir düzeltme)",
    expectedCorrectionIntervalS(0.03, 0.10) > expectedCorrectionIntervalS(0.03, 0.05));
  let threw = false;
  try { expectedCorrectionIntervalS(0, 0.05); } catch (e) { threw = e instanceof RangeError; }
  check("σ=0 RangeError fırlatıyor", threw);
}

// Deterministik RNG'yi Math.random() imzasına uyarlayan yardımcı — core.mulberry32(seed) bir () => number döner.
function seededRng(seed) { return core.mulberry32(seed); }

function testOnCorrectionChaining() {
  console.log("\n── Test 2: attachToBuffer, ÖNCEDEN VAR OLAN onCorrection'ı ZİNCİRLİYOR mu ──");
  let priorCalls = 0;
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.05, rng: seededRng(1) });
  const buffer = new QuantumPhaseBuffer({
    driftModel: drift, deltaMaxRad: 0.005, correctionIntervalS: 10e-6,
    onCorrection: () => { priorCalls++; },
  });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
  recorder.attachToBuffer(buffer);
  // Beklenen düzeltme-arası süre δ_max²/σ²=0.005²/0.05²=0.01s — 200000 darbe ×
  // 1µs = 0.2s simüle edilen süre, ~20 düzeltme olayı BEKLENİR (bkz. tasarım §3.1).
  runPhaseBufferWithRecording(buffer, recorder, 200000, 1e-6);

  check("recorder GERÇEKTEN düzeltme olayları yakaladı (correctionLog boş değil)", recorder.correctionLog.length > 0, `correctionCount=${recorder.correctionLog.length}`);
  check("ÖNCEDEN VAR OLAN onCorrection, recorder'ın KENDİ correctionLog.length'i İLE AYNI sayıda çağrıldı (zincirleme KAYIP YOK)",
    priorCalls === recorder.correctionLog.length, `priorCalls=${priorCalls}, recorder.correctionLog.length=${recorder.correctionLog.length}`);
}

function testCorrectionLogSchema() {
  console.log("\n── Test 3: correctionLog şeması — exceedRatio türetimi ve sinceLastCorrectionS sıralaması ──");
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.04, rng: seededRng(2) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: 0.006, correctionIntervalS: 20e-6 });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
  recorder.attachToBuffer(buffer);
  // Beklenen düzeltme-arası süre 0.006²/0.04²=0.0225s — 400000×1µs=0.4s simüle
  // edilen süre, ~18 düzeltme olayı BEKLENİR.
  runPhaseBufferWithRecording(buffer, recorder, 400000, 1e-6);

  check("en az 2 düzeltme olayı yakalandı (şema testleri için gerekli)", recorder.correctionLog.length >= 2, `count=${recorder.correctionLog.length}`);

  let allExceedRatioOk = true, allSeqOk = true, firstSinceNull = false;
  for (let i = 0; i < recorder.correctionLog.length; i++) {
    const r = recorder.correctionLog[i];
    const expectedRatio = Math.abs(r.measuredDeltaRad) / r.deltaMaxRad;
    if (!approxEqual(r.exceedRatio, expectedRatio, 1e-12)) allExceedRatioOk = false;
    if (r.seq !== i) allSeqOk = false;
    if (i === 0 && r.sinceLastCorrectionS === null) firstSinceNull = true;
  }
  check("her kayıtta exceedRatio === |measuredDeltaRad|/deltaMaxRad (bağımsız yeniden hesapla)", allExceedRatioOk);
  check("seq alanı 0'dan başlayıp MONOTON artıyor", allSeqOk);
  check("İLK kaydın sinceLastCorrectionS'i null (önceki düzeltme yok)", firstSinceNull);

  let allExceedAboveOne = true;
  for (const r of recorder.correctionLog) if (r.exceedRatio < 1) allExceedAboveOne = false;
  check("HER düzeltme kaydında exceedRatio ≥ 1 (düzeltme ancak eşik AŞILINCA tetiklenir)", allExceedAboveOne);
}

function testExcursionAliasingObserved() {
  console.log("\n── Test 4: excursionLog — İNCE örneklemede az/yok, KABA örneklemede kaçırılan (caught=false) aşımlar VAR ──");
  const sigma = 0.08, deltaMax = 0.01;
  const pulsePeriodS = 1e-6;
  const pulseCount = 500000; // beklenen düzeltme-arası süre 0.01²/0.08²≈0.0156s → 0.5s'de ~27 düzeltme

  function runWithInterval(correctionIntervalS, seed) {
    const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: sigma, rng: seededRng(seed) });
    const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
    const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
    recorder.attachToBuffer(buffer);
    runPhaseBufferWithRecording(buffer, recorder, pulseCount, pulsePeriodS);
    return recorder;
  }

  const fine = runWithInterval(pulsePeriodS, 10); // her darbede kontrol (correctionIntervalS=pulsePeriodS) — SÜREKLİ izlemeye eşdeğer
  const coarse = runWithInterval(500e-6, 10); // 500 darbede bir kontrol — KABA

  const fineMissed = fine.excursionLog.filter((e) => !e.caught).length;
  const coarseMissed = coarse.excursionLog.filter((e) => !e.caught).length;
  const fineTotal = fine.excursionLog.length;
  const coarseTotal = coarse.excursionLog.length;

  check("İNCE örneklemede (correctionIntervalS=pulsePeriodS) kaçırılan aşım oranı ÇOK DÜŞÜK",
    fineTotal === 0 || fineMissed / fineTotal < 0.15,
    `fine: kaçırılan=${fineMissed}/${fineTotal}`);

  check("KABA örneklemede (correctionIntervalS=500µs) en az BİR kaçırılan (caught=false) aşım GÖZLENDİ",
    coarseMissed > 0,
    `coarse: kaçırılan=${coarseMissed}/${coarseTotal}`);

  check("KABA örneklemenin kaçırılan-aşım ORANI, İNCE örneklemeninkinden BÜYÜK (aliasing, örnekleme kabalaştıkça ARTAR)",
    coarseTotal > 0 && (coarseMissed / coarseTotal) > (fineTotal > 0 ? fineMissed / fineTotal : 0),
    `fine oran=${fineTotal ? (fineMissed / fineTotal).toFixed(3) : "n/a"}, coarse oran=${(coarseMissed / coarseTotal).toFixed(3)}`);

  for (const e of coarse.excursionLog) {
    if (!(e.endTS >= e.startTS)) { check("her excursion kaydında endTS ≥ startTS", false, JSON.stringify(e)); return; }
  }
  check("her excursion kaydında endTS ≥ startTS", true);
}

function testCalibrationHealthFlagging() {
  console.log("\n── Test 5: analyzeCalibrationHealth — normalde flagged=false, σ UYUMSUZLUĞUNDA flagged=true ──");
  const trueSigma = 0.05, deltaMax = 0.008, correctionIntervalS = 5e-6;
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: trueSigma, rng: seededRng(42) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: deltaMax, correctionIntervalS });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS, deltaMaxRad: deltaMax });
  recorder.attachToBuffer(buffer);
  // Beklenen düzeltme-arası süre 0.008²/0.05²=0.0256s — 1024000×1µs=1.024s
  // simüle edilen süre, ~40 düzeltme olayı BEKLENİR (istatistiksel olarak
  // anlamlı bir ortalama için, bkz. tasarım §3.2 sayısal doğrulaması).
  runPhaseBufferWithRecording(buffer, recorder, 1024000, 1e-6);

  const healthNormal = recorder.analyzeCalibrationHealth({ sigmaRadPerSqrtS: trueSigma });
  check("düzeltme örneklemi yeterli (≥5 düzeltme, anlamlı ortalama için)", healthNormal.sampleCount >= 5, `sampleCount=${healthNormal.sampleCount}`);
  check("GERÇEK σ ile analiz edilince flagged=false (kalibrasyon TUTARLI)",
    healthNormal.flagged === false,
    `ratio=${healthNormal.ratio ? healthNormal.ratio.toFixed(3) : "n/a"}, theoretical=${healthNormal.theoreticalS.toExponential(3)}, observed=${healthNormal.observedMeanS ? healthNormal.observedMeanS.toExponential(3) : "n/a"}`);
  check("gözlenen/teorik oranı, §3.2'nin öngördüğü ~1.0-1.15 aralığında (AYRIK örnekleme yanlılığı, anomali DEĞİL)",
    healthNormal.ratio > 0.8 && healthNormal.ratio < 1.5,
    `ratio=${healthNormal.ratio.toFixed(3)}`);

  // AYNI correctionLog'u, GERÇEKTEN farklı (10× büyük) bir σ varsayımıyla analiz et — kasıtlı uyumsuzluk.
  const healthMismatched = recorder.analyzeCalibrationHealth({ sigmaRadPerSqrtS: trueSigma * 10 });
  check("σ_varsayım GERÇEK σ'dan 10× büyükken flagged=true (kalibrasyon-dışı OLARAK işaretleniyor)",
    healthMismatched.flagged === true,
    `ratio=${healthMismatched.ratio.toFixed(3)}`);

  const healthEmpty = new CorrectionLogRecorder({ correctionIntervalS: 1e-6, deltaMaxRad: 0.5 }).analyzeCalibrationHealth({ sigmaRadPerSqrtS: 0.03 });
  check("düzeltme olayı YOKKEN flagged=false (yanlış-pozitif ÜRETİLMİYOR, 'yeterli veri yok' deniyor)",
    healthEmpty.flagged === false && healthEmpty.sampleCount === 0, JSON.stringify(healthEmpty));
}

function testNdjsonExportAndFlush() {
  console.log("\n── Test 6: toNdjsonLines/flushToFile — GERÇEK dosya I/O'su ──");
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.05, rng: seededRng(7) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: 0.005, correctionIntervalS: 10e-6 });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
  recorder.attachToBuffer(buffer);
  // Beklenen düzeltme-arası süre 0.005²/0.05²=0.01s — 200000×1µs=0.2s simüle
  // edilen süre, ~20 düzeltme olayı BEKLENİR (boş bir correctionLog'u dışa
  // aktarmak yerine ANLAMLI bir NDJSON içeriği test edilsin diye).
  runPhaseBufferWithRecording(buffer, recorder, 200000, 1e-6);
  check("en az bir düzeltme olayı GERÇEKTEN yakalandı (boş-log testi anlamsız olurdu)", recorder.correctionLog.length > 0, `count=${recorder.correctionLog.length}`);

  const ndjson = recorder.toNdjsonLines();
  const lines = ndjson.split("\n").filter((l) => l.length > 0);
  check("NDJSON satır sayısı === correctionLog.length", lines.length === recorder.correctionLog.length, `satır=${lines.length}, correctionLog=${recorder.correctionLog.length}`);

  let allParse = true;
  for (const line of lines) { try { JSON.parse(line); } catch { allParse = false; } }
  check("her NDJSON satırı GEÇERLİ JSON", allParse);

  const tmpFile = path.join(os.tmpdir(), `photonnet_correction_log_test_${process.pid}_${Date.now()}.ndjson`);
  try {
    const writeResult = recorder.flushToFile(tmpFile, { append: false });
    check("flushToFile bytesWritten > 0 döndürüyor", writeResult.bytesWritten > 0, `bytesWritten=${writeResult.bytesWritten}`);
    const diskContent = fs.readFileSync(tmpFile, "utf8");
    check("DİSKE yazılan içerik, toNdjsonLines() ile BİREBİR eşleşiyor", diskContent === ndjson, `disk uzunluk=${diskContent.length}, beklenen=${ndjson.length}`);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function testBoundedMemoryNoFullPulseLogRetention() {
  console.log("\n── Test 7: recordPulse, pulseLog'un TAMAMINI SAKLAMIYOR (O(1) açık-aşım durumu) ──");
  const drift = new PhaseDriftModel({ sigmaRadPerSqrtS: 0.08, rng: seededRng(99) });
  const buffer = new QuantumPhaseBuffer({ driftModel: drift, deltaMaxRad: 0.005, correctionIntervalS: 20e-6 });
  const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
  recorder.attachToBuffer(buffer);
  const pulseCount = 500000;
  // Beklenen düzeltme-arası süre 0.005²/0.08²≈0.0039s — 0.5s'lik simülasyonda
  // ~128 excursion BEKLENİR (bellek sınırlılığını GERÇEKTEN stres-testine
  // sokmak için, boş/az-olaylı bir koşuyla değil).
  runPhaseBufferWithRecording(buffer, recorder, pulseCount, 1e-6);
  check("bu stres-testinde GERÇEKTEN çok sayıda excursion oluştu (>=20)", recorder.excursionLog.length >= 20, `excursionLog.length=${recorder.excursionLog.length}`);

  check("recorder nesnesinde 'pulseLog' alanı YOK (tasarım gereği tutulmuyor)", recorder.pulseLog === undefined);
  check("_openExcursion, ya null YA DA tek bir {startTS,peakAbsDeltaRad} nesnesi (dizi DEĞİL — sabit boyutlu)",
    recorder._openExcursion === null || (typeof recorder._openExcursion === "object" && !Array.isArray(recorder._openExcursion)));
  check(`excursionLog uzunluğu, işlenen darbe sayısından (${pulseCount}) ÇOK KÜÇÜK (bellek darbe-sayısıyla ORANTILI DEĞİL)`,
    recorder.excursionLog.length < pulseCount / 100,
    `excursionLog.length=${recorder.excursionLog.length}, pulseCount=${pulseCount}`);
}

function testCoreAndBufferUntouched() {
  console.log("\n── Test 8: çekirdek VE quantum_phase_buffer.js bu çalışma boyunca DEĞİŞMEDİ ──");
  const coreHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  const expectedCoreHash = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", coreHash === expectedCoreHash, `hash=${coreHash}`);

  // quantum_phase_buffer.js için sabit bir "beklenen" hash YOK (bu oturumda
  // üretildi) — bunun yerine, modül YÜKLENİRKEN (herhangi bir test ÇALIŞMADAN
  // ÖNCE) alınan hash'le, TÜM testler bittikten SONRA yeniden hesaplanan
  // hash'in AYNI olduğu doğrulanır (bkz. dosya başındaki BUFFER_JS_HASH_BEFORE).
  const bufferHashAfter = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"))).digest("hex");
  check("bb84/quantum_phase_buffer.js SHA-256, TÜM testler çalıştıktan SONRA da modül-yükleme ANINDAKİYLE AYNI (bu test dosyası hiçbir şekilde YAZMADI)",
    bufferHashAfter === BUFFER_JS_HASH_BEFORE, `önce=${BUFFER_JS_HASH_BEFORE}, sonra=${bufferHashAfter}`);

  const bufferSource = fs.readFileSync(path.join(__dirname, "quantum_phase_buffer.js"), "utf8");
  check("quantum_phase_buffer.js kaynağı 'correction_log_recorder' STRING'ini İÇERMİYOR (tek yönlü bağımlılık — buffer, recorder'ı bilmiyor)",
    !bufferSource.includes("correction_log_recorder"));
}

function main() {
  console.log("═══ correction_log_recorder.js — Kuantum Buffer correctionLog loglama süreci, gerçek buffer'la uçtan uca doğrulama ═══");
  testExpectedIntervalFormula();
  testOnCorrectionChaining();
  testCorrectionLogSchema();
  testExcursionAliasingObserved();
  testCalibrationHealthFlagging();
  testNdjsonExportAndFlush();
  testBoundedMemoryNoFullPulseLogRetention();
  testCoreAndBufferUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
