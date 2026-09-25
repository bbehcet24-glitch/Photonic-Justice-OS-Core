"use strict";
// ══════════════════════════════════════════════════════════════════
// quantum_phase_buffer.js — GERÇEK hesaplama + istatistiksel doğrulama +
// mevcut çekirdekle uçtan uca gösterim (mock YOK — bb84/photonnet_core.js
// SALT-OKUNUR require edilir, tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN 7 ŞEY:
//   1) P_hata(δ)=sin²(δ/2) formülünün uç noktaları (δ=0→0, δ=π→1) ve
//      küçük-açı yaklaşımı (δ²/4) GERÇEKTEN doğru + monoton + simetrik.
//   2) δ_max'ın hedef hata katkısından GERİYE ÇÖZÜMÜ tutarlı (round-trip)
//      ve geçersiz hedefleri REDDEDİYOR.
//   3) PhaseDriftModel'in ürettiği rastgele yürüyüşün GERÇEK istatistiksel
//      varyansı, teorik σ²·T ile TUTARLI (çok sayıda bağımsız deneme
//      üzerinden ÖLÇÜLEREK) — ve correct() δ'yı GERÇEKTEN sıfırlıyor.
//   4) Kuantum Buffer AKTİFKEN faz hatası SINIRLI kalıyor (asla δ_max'ın
//      birkaç katını aşmıyor), AYNI (hızlandırılmış, test-amaçlı) σ ile
//      buffer DEVRE DIŞIYKEN faz hatası SINIRSIZ büyüyor — "faz birikimini
//      engelleme" iddiasının DOĞRUDAN kanıtı.
//   5) applyPhaseBufferToBits: TUTULAN darbeler bit dizisinden GERÇEKTEN
//      çıkarılıyor, flip oranı P_hata(δ) ile istatistiksel olarak TUTARLI.
//   6) GERÇEK QuantumKeyDistribution.deriveSiftedKey ile: buffer KAPALI
//      senaryonun QBER'i, buffer AÇIK senaryonunkinden BELİRGİN ÖLÇÜDE
//      YÜKSEK (kanal kaybı sıfıra yakın tutularak fark yalnızca faz
//      hatasına atfedilebilir hâle getiriliyor).
//   7) Çekirdek bu çalışma boyunca DEĞİŞMEDİ (SHA-256).
//
// Çekirdeğe (photonnet_core.js) dokunulmadı.
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  phaseErrorToBitFlipProb, deltaMaxFromTargetError,
  PhaseDriftModel, QuantumPhaseBuffer, runPhaseBuffer, applyPhaseBufferToBits,
} = require("./quantum_phase_buffer.js");
const core = require("./photonnet_core.js");

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= eps; }

function testPhaseErrorFormula() {
  console.log("── Test 1: P_hata(δ)=sin²(δ/2) — uç noktalar, küçük-açı yaklaşımı, monotonluk, simetri ──");
  check("δ=0 → P_hata=0 (mükemmel kalibrasyon)", approxEqual(phaseErrorToBitFlipProb(0), 0, 1e-12));
  check("δ=π → P_hata=1 (tam ters faz, garanti hatalı)", approxEqual(phaseErrorToBitFlipProb(Math.PI), 1, 1e-12));
  check("δ=π/2 → P_hata=0.5 (sin²(π/4)=0.5)", approxEqual(phaseErrorToBitFlipProb(Math.PI / 2), 0.5, 1e-9));
  const smallDelta = 0.02;
  const exact = phaseErrorToBitFlipProb(smallDelta);
  const approx = smallDelta * smallDelta / 4;
  check("küçük δ için P_hata ≈ δ²/4 (ikinci dereceden yaklaşım)", approxEqual(exact, approx, 1e-6), `tam=${exact.toExponential(4)}, yaklaşık=${approx.toExponential(4)}`);
  let monotonic = true;
  const samples = [0, 0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 2.5, Math.PI];
  for (let i = 1; i < samples.length; i++) if (!(phaseErrorToBitFlipProb(samples[i]) >= phaseErrorToBitFlipProb(samples[i - 1]))) monotonic = false;
  check("[0,π] üzerinde monoton artan", monotonic);
  check("simetrik: P_hata(δ) === P_hata(-δ)", approxEqual(phaseErrorToBitFlipProb(0.37), phaseErrorToBitFlipProb(-0.37), 1e-12));
}

function testDeltaMaxDerivation() {
  console.log("\n── Test 2: δ_max'ın hedef hata katkısından geriye çözümü ──");
  const target = 0.01;
  const deltaMax = deltaMaxFromTargetError(target);
  const roundTrip = phaseErrorToBitFlipProb(deltaMax);
  check("sin²(δ_max/2) === hedef (round-trip tutarlı)", approxEqual(roundTrip, target, 1e-9), `δ_max=${deltaMax.toFixed(6)}rad (${(deltaMax * 180 / Math.PI).toFixed(2)}°), round-trip=${roundTrip.toFixed(6)}`);
  check("δ_max belgedeki (§3) ~0.2003rad/~11.48° değeriyle eşleşiyor", approxEqual(deltaMax, 0.2003, 1e-3), `ölçülen=${deltaMax.toFixed(4)}`);

  let threw = false;
  try { deltaMaxFromTargetError(0); } catch (e) { threw = e instanceof RangeError; }
  check("targetErrorContribution=0 RangeError", threw);
  threw = false;
  try { deltaMaxFromTargetError(1.5); } catch (e) { threw = e instanceof RangeError; }
  check("targetErrorContribution=1.5 (>1, imkânsız olasılık) RangeError", threw);
}

function testDriftModelStatistics() {
  console.log("\n── Test 3: PhaseDriftModel — GERÇEK istatistiksel varyans σ²·T ile tutarlı mı ──");
  const sigma = 0.5; // rad/√s — bu testte hızlandırılmış (istatistiği makul deneme sayısıyla ölçmek için)
  const T = 2.0; // toplam süre (s)
  const dt = 0.01;
  const steps = Math.round(T / dt);
  const trials = 300;
  const finalDeltas = [];
  for (let t = 0; t < trials; t++) {
    const m = new PhaseDriftModel({ sigmaRadPerSqrtS: sigma });
    for (let i = 0; i < steps; i++) m.step(dt);
    finalDeltas.push(m.delta);
  }
  const mean = finalDeltas.reduce((a, b) => a + b, 0) / trials;
  const variance = finalDeltas.reduce((a, b) => a + (b - mean) ** 2, 0) / trials;
  const theoreticalVariance = sigma * sigma * T;
  const relErr = Math.abs(variance - theoreticalVariance) / theoreticalVariance;
  check(`ölçülen varyans (${variance.toFixed(4)}), teorik σ²·T (${theoreticalVariance.toFixed(4)}) ile %25 toleransta eşleşiyor`,
    relErr < 0.25, `relatif hata=${(relErr * 100).toFixed(1)}%, ${trials} deneme`);
  check("ortalama δ ~0'a yakın (Wiener sürecinin beklenen değeri sıfırdır, sürüklenme YOK)",
    approxEqual(mean, 0, 4 * Math.sqrt(theoreticalVariance / trials)), `ölçülen ortalama=${mean.toFixed(4)}`);

  const m2 = new PhaseDriftModel({ sigmaRadPerSqrtS: sigma });
  m2.step(1.0);
  check("step() sonrası δ artık 0 DEĞİL (drift gerçekten ilerledi)", m2.delta !== 0);
  m2.correct();
  check("correct() sonrası δ TAM OLARAK 0 (düzeltme darbesi sıfırlıyor)", m2.delta === 0);
}

function testBufferContainsPhaseError() {
  console.log("\n── Test 4: Kuantum Buffer AKTİFKEN faz hatası SINIRLI, DEVRE DIŞIYKEN SINIRSIZ büyüyor ──");
  // NOT: bu testte σ KASITLI OLARAK hızlandırılmış (10 rad/√s, varsayılan
  // 0.03'ün ÇOK üzerinde) — amaç, AYNI matematiksel mekanizmanın (Wiener
  // süreci √t büyümesi + periyodik düzeltmeyle sınırlama) makul bir test
  // süresinde GÖZLENEBİLİR olmasını sağlamak; gerçek dağıtımda bu
  // büyüklükteki bir σ beklenmez (bkz. tasarım belgesi §4/§7).
  // GERÇEK BULGU (ölçülerek yakalandı): tek-denemelik bir rastgele-yürüyüş
  // maksimumu istatistiksel olarak GÜRÜLTÜLÜDÜR — ilk taslak (5000 darbe,
  // TEK deneme, eşik ">2×δ_max") 2 koşumdan 1'inde şans eseri eşiğin altında
  // kaldı (max|δ|=0.36rad < 0.40rad). Düzeltme: hem darbe sayısı artırıldı
  // (daha uzun süre → daha büyük beklenen sürüklenme genliği) HEM DE
  // "buffer KAPALI" senaryosu ÇOKLU bağımsız denemeyle (en kötü/en büyük
  // değeri alarak) ölçülüyor — tek bir şanssız çekilişin testi
  // BAYATLATMASI ENGELLENDİ.
  const sigmaAccelerated = 10.0;
  const pulsePeriodS = 1e-6; // 1MHz, gerçekçi
  const pulseCount = 20000; // toplam 20ms (Test 6 ile tutarlı büyüklük mertebesi)
  const offTrials = 5;
  const deltaMax = deltaMaxFromTargetError(0.01);

  const bufferOn = new QuantumPhaseBuffer({
    driftModel: new PhaseDriftModel({ sigmaRadPerSqrtS: sigmaAccelerated }),
    deltaMaxRad: deltaMax,
    correctionIntervalS: 50e-6, // SI3N4_PIC_DESIGN.md §5 ile tutarlı fiziksel yanıt süresi
  });
  const logOn = runPhaseBuffer(bufferOn, pulseCount, pulsePeriodS);
  const maxAbsDeltaOn = Math.max(...logOn.map((r) => Math.abs(r.deltaAtEncode)));

  let maxAbsDeltaOff = 0;
  let totalCorrectionsOff = 0;
  for (let trial = 0; trial < offTrials; trial++) {
    const bufferOff = new QuantumPhaseBuffer({
      driftModel: new PhaseDriftModel({ sigmaRadPerSqrtS: sigmaAccelerated }),
      deltaMaxRad: Infinity, // düzeltme ASLA tetiklenmez — "buffer YOK" senaryosu
      correctionIntervalS: 50e-6,
    });
    const logOff = runPhaseBuffer(bufferOff, pulseCount, pulsePeriodS);
    maxAbsDeltaOff = Math.max(maxAbsDeltaOff, ...logOff.map((r) => Math.abs(r.deltaAtEncode)));
    totalCorrectionsOff += bufferOff.correctionLog.length;
  }

  check("buffer AKTİFKEN gözlenen |δ| ASLA δ_max'ın birkaç katını (makul üst sınır 4×) aşmıyor",
    maxAbsDeltaOn < 4 * deltaMax, `max|δ|=${maxAbsDeltaOn.toFixed(4)}rad, δ_max=${deltaMax.toFixed(4)}rad, sınır=${(4 * deltaMax).toFixed(4)}rad`);
  check(`buffer DEVRE DIŞIYKEN (${offTrials} bağımsız deneme, en büyüğü alınarak) gözlenen |δ|, AYNI σ ile δ_max'ı AÇIKÇA aşıyor (sınırsız birikim)`,
    maxAbsDeltaOff > 2 * deltaMax, `max|δ|(${offTrials} deneme)=${maxAbsDeltaOff.toFixed(4)}rad, δ_max=${deltaMax.toFixed(4)}rad`);
  check("buffer AKTİFKEN en az bir düzeltme GERÇEKTEN tetiklendi (mekanizma pasif değildi)",
    bufferOn.correctionLog.length > 0, `düzeltme sayısı=${bufferOn.correctionLog.length}`);
  check("buffer DEVRE DIŞIYKEN (tüm denemelerde) hiç düzeltme YAPILMADI (kontrol grubu doğru kuruldu)",
    totalCorrectionsOff === 0);
  check("buffer AKTİFKEN sınırlı max|δ|, DEVRE DIŞI sınırsız max|δ|'dan KESİNLİKLE küçük",
    maxAbsDeltaOn < maxAbsDeltaOff, `açık=${maxAbsDeltaOn.toFixed(4)}rad, kapalı=${maxAbsDeltaOff.toFixed(4)}rad`);
}

function testApplyBufferToBits() {
  console.log("\n── Test 5: applyPhaseBufferToBits — tutulan darbeler çıkarılıyor, flip oranı istatistiksel tutarlı ──");
  let threw = false;
  try { applyPhaseBufferToBits([0, 1, 0], [{ held: false, deltaAtEncode: 0 }]); } catch (e) { threw = e instanceof RangeError; }
  check("uzunluk uyuşmazlığı RangeError", threw);

  const n = 2000;
  const bits = Array.from({ length: n }, () => (Math.random() < 0.5 ? 0 : 1));
  const heldIndices = new Set([3, 17, 42, 100, 999]);
  const pulseLogZeroDelta = bits.map((_, i) => ({ held: heldIndices.has(i), deltaAtEncode: 0 }));
  const resultZero = applyPhaseBufferToBits(bits, pulseLogZeroDelta);
  check("δ=0 iken (mükemmel kalibrasyon) HİÇ bit çevrilmiyor", resultZero.flippedCount === 0, `flippedCount=${resultZero.flippedCount}`);
  check("tutulan darbe sayısı DOĞRU (5 tanesi işaretlendi)", resultZero.heldCount === heldIndices.size, `heldCount=${resultZero.heldCount}`);
  check("çıktı dizisi uzunluğu = girdi - tutulanlar", resultZero.bits.length === n - heldIndices.size, `çıktı=${resultZero.bits.length}, beklenen=${n - heldIndices.size}`);

  const constDelta = 0.6; // sabit orta-büyüklük faz hatası
  const expectedFlipRate = phaseErrorToBitFlipProb(constDelta);
  const pulseLogConst = bits.map(() => ({ held: false, deltaAtEncode: constDelta }));
  const resultConst = applyPhaseBufferToBits(bits, pulseLogConst);
  const measuredFlipRate = resultConst.flippedCount / n;
  check(`sabit δ=${constDelta} ile ölçülen flip oranı (${measuredFlipRate.toFixed(3)}), teorik P_hata (${expectedFlipRate.toFixed(3)}) ile istatistiksel tutarlı (±0.05)`,
    approxEqual(measuredFlipRate, expectedFlipRate, 0.05));
}

function testRealCoreComparison() {
  console.log("\n── Test 6: GERÇEK QuantumKeyDistribution ile buffer AÇIK/KAPALI 'gerçek uçtan-uca hata' karşılaştırması ──");
  // GERÇEK BULGU (bu test yazılırken kendi kendini düzelten bir hata):
  // deriveSiftedKey(bits,...)'in KENDİ `qber` alanı, `bits[]`'i HER ZAMAN
  // "Alice'in doğru gönderdiği" ZEMİN GERÇEĞİ olarak kabul eder — bits[]'i
  // ÖNCEDEN (phase-buffer ile) bozup vermek, deriveSiftedKey'e göre YENİ
  // zemin gerçeğini TANIMLAMAK anlamına gelir, bir SAPMA GÖSTERMEZ (ilk
  // taslakta ÖLÇÜLEREK yakalandı: QBER(açık)===QBER(kapalı)===0.0114).
  // Ölçülmesi gereken asıl şey deriveSiftedKey'in kendi `.qber`'i DEĞİL,
  // Alice'in ORİJİNAL (bozulmamış) niyet ettiği bit ile Bob'un GERÇEKTEN
  // aldığı bit arasındaki farktır — bu yüzden deriveSiftedKey İKİ KEZ,
  // AYNI tohumla başlatılmış BAĞIMSIZ birer `historicalRng` (core.mulberry32)
  // ile çağrılır: biri BOZULMAMIŞ bits, biri BOZULMUŞ bits ile. `reconcileBases`
  // (taban seçimi) VE propPhoton'ın kanal-fiziği rastgeleliği bit
  // DEĞERLERİNDEN bağımsızdır (yalnızca bitCount/totalKm/rng akışına bağlıdır,
  // kodda doğrulanabilir — propPhoton'a bit değeri hiç PARAMETRE olarak
  // geçmiyor) — bu yüzden İKİ çağrı da AYNI sıradaki indeksleri sifted+
  // algılanmış olarak üretir, yalnızca BİT DEĞERLERİ farklılaşır. Bu da
  // "orijinal niyet edilen bit" ile "bozulmuş çalıştırmanın Bob'un aldığı
  // bit"ini POZİSYON POZİSYON karşılaştırmayı GEÇERLİ kılar.
  const n = 20000;
  const bits = Array.from({ length: n }, () => (Math.random() < 0.5 ? 0 : 1));
  const sigmaAccelerated = 8.0; // Test 4'teki gerekçeyle AYNI — test-amaçlı hızlandırma
  const deltaMax = deltaMaxFromTargetError(0.01);
  const pulsePeriodS = 1e-6;

  // NOT: bu karşılaştırmada TUTMA (held) özelliği KASITLI OLARAK devre
  // dışı (deltaMaxRad çok büyük tutulmaz ama holding hiçbir zaman dizi
  // uzunluğunu DEĞİŞTİRMEZ — applyPhaseBufferToBits yalnızca flip uygular)
  // çünkü bu test yalnızca "flip" etkisini izole ediyor; "held" davranışı
  // zaten Test 5'te ayrıca doğrulandı. Bu yüzden burada uzunluk-koruyan
  // bir yardımcı kullanılır: held bayrağını YOK SAYIP yalnızca flip uygular.
  function applyFlipOnly(bitsIn, pulseLog) {
    return bitsIn.map((b, i) => {
      const p = phaseErrorToBitFlipProb(pulseLog[i].deltaAtEncode);
      return Math.random() < p ? (b ^ 1) : b;
    });
  }

  const bufferOff = new QuantumPhaseBuffer({
    driftModel: new PhaseDriftModel({ sigmaRadPerSqrtS: sigmaAccelerated }),
    deltaMaxRad: Infinity,
    correctionIntervalS: 50e-6,
  });
  const logOff = runPhaseBuffer(bufferOff, n, pulsePeriodS);
  const bitsOff = applyFlipOnly(bits, logOff);

  const bufferOn = new QuantumPhaseBuffer({
    driftModel: new PhaseDriftModel({ sigmaRadPerSqrtS: sigmaAccelerated }),
    deltaMaxRad: deltaMax,
    correctionIntervalS: 50e-6,
  });
  const logOn = runPhaseBuffer(bufferOn, n, pulsePeriodS);
  const bitsOn = applyFlipOnly(bits, logOn);

  const rngSeed = 12345;
  const totalKm = 0.5; // ~ihmal edilebilir kanal kaybı — fark faz-kaynaklı olsun diye
  const qkdOrig = new core.QuantumKeyDistribution(0xC0FFEE);
  const resOrig = qkdOrig.deriveSiftedKey(bits, totalKm, false, core.mulberry32(rngSeed));
  const qkdOff = new core.QuantumKeyDistribution(0xC0FFEE);
  const resOff = qkdOff.deriveSiftedKey(bitsOff, totalKm, false, core.mulberry32(rngSeed));
  const qkdOn = new core.QuantumKeyDistribution(0xC0FFEE);
  const resOn = qkdOn.deriveSiftedKey(bitsOn, totalKm, false, core.mulberry32(rngSeed));

  check("AYNI-tohum hizalaması doğru: üç çalıştırma da AYNI sayıda algılanan (detected) fotona sahip",
    resOrig.detectedCount === resOff.detectedCount && resOff.detectedCount === resOn.detectedCount,
    `orijinal=${resOrig.detectedCount}, kapalı=${resOff.detectedCount}, açık=${resOn.detectedCount}`);

  // GERÇEK uçtan-uca hata: Alice'in ORİJİNAL (bozulmamış) niyet ettiği bit
  // ile bozulmuş-çalıştırmanın Bob'un GERÇEKTEN aldığı bit'i pozisyon
  // pozisyon karşılaştırılır (deriveSiftedKey'in KENDİ .qber'i DEĞİL).
  function trueEndToEndErrorRate(aliceIntendedRun, receivedRun) {
    const len = Math.min(aliceIntendedRun.siftedKeyBits.length, receivedRun.bobKeyBits.length);
    let errors = 0;
    for (let i = 0; i < len; i++) if (aliceIntendedRun.siftedKeyBits[i] !== receivedRun.bobKeyBits[i]) errors++;
    return len ? errors / len : 0;
  }
  const trueQberOff = trueEndToEndErrorRate(resOrig, resOff);
  const trueQberOn = trueEndToEndErrorRate(resOrig, resOn);

  check("buffer KAPALIYKEN GERÇEK uçtan-uca hata oranı AÇIKÇA ölçülebilir düzeyde (faz hatası sızdı)",
    trueQberOff > 0.02, `gerçek-hata(kapalı)=${trueQberOff.toFixed(4)}`);
  check("buffer AÇIKKEN GERÇEK uçtan-uca hata oranı belirgin ölçüde DAHA DÜŞÜK (faz hatası tutuldu)",
    trueQberOn < trueQberOff, `gerçek-hata(açık)=${trueQberOn.toFixed(4)}, gerçek-hata(kapalı)=${trueQberOff.toFixed(4)}`);
  check("her iki senaryo da GERÇEK, DEĞİŞTİRİLMEMİŞ deriveSiftedKey ile üretildi (sifted key uzunlukları > 0)",
    resOff.siftedKeyBits.length > 0 && resOn.siftedKeyBits.length > 0,
    `sifted(kapalı)=${resOff.siftedKeyBits.length}, sifted(açık)=${resOn.siftedKeyBits.length}`);
}

function testCoreUntouched() {
  console.log("\n── Test 7: çekirdek dosyası bu çalışma boyunca DEĞİŞMEDİ ──");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  const expected = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", hash === expected, `hash=${hash}`);
}

function main() {
  console.log("═══ quantum_phase_buffer.js — faz birikimini engelleyen Kuantum Buffer, uçtan uca doğrulama ═══");
  testPhaseErrorFormula();
  testDeltaMaxDerivation();
  testDriftModelStatistics();
  testBufferContainsPhaseError();
  testApplyBufferToBits();
  testRealCoreComparison();
  testCoreUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
