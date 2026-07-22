#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// Gürültü Matrisi Doğrulama — hal/noise_matrix.json (HAL köprüsünden
// GERÇEK HTTP çağrılarıyla toplanmış ölçüm matrisi) ile photonnet_core.js
// içindeki analitik/sezgisel modellerin (statik WL kayıp tablosu, LEGA
// risk skoru) ne kadar örtüştüğünü ölçer — "Hata Yakalama Oranı" (detection
// rate) ve R²/Δ metrikleri üretir.
//
// DÜRÜSTLÜK NOTU: hal/noise_matrix.json şu an SimulatedHardware'den geliyor
// (gerçek fiber DEĞİL, propPhoton ile AYNI kapalı-form formülün Python
// portundan RNG ile örneklenmiş verisi) — bkz. hal/noise_matrix_sweep.py
// başlığı. Bu yüzden (a) atenüasyon karşılaştırması NEREDEYSE TAUTOLOJİKTİR
// (aynı 0.20dB/km sabiti iki dilde de kullanılıyor) — asıl değeri "pipeline
// çalışıyor mu" sorusuna cevap vermesi. (b) LEGA risk-skoru karşılaştırması
// DAHA ANLAMLIDIR çünkü LEGA'nın katsayıları (0.55 taban vb.) kodun kendi
// yorumunda "deneysel doğrulanmamış/sezgisel" olarak işaretli — bu script
// o sezgisel modelin ŞEKLİNİN (mesafeyle artış eğrisi) ölçülen QBER eğrisiyle
// ne kadar örtüştüğünü ilk kez sayısallaştırıyor. (c) eavesdrop-detection
// confusion matrix'i GERÇEK bir sinyal-tespit testidir (QBER>%11 eşiği,
// TimeTagCorrelator.correlate ile TUTARLI).
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { WL, lega, LinkGradedEavesdropThresholdAlgorithm } = core;

// PhotonNet2.jsx'teki NoiseMatrixCalibration._canonicalize ile BİREBİR AYNI
// algoritma — imzalayan (burası) ve doğrulayan (tarayıcı/Node SubtleCrypto)
// taraf FARKLI kanonikleştirme kullanırsa imza asla eşleşmez. Bu fonksiyon
// değiştirilirse KARŞI TARAFTAKİ de değiştirilmelidir.
function canonicalize(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}

function signCalibration(payload, keyHex) {
  const hmac = crypto.createHmac("sha256", Buffer.from(keyHex, "hex"));
  hmac.update(canonicalize(payload));
  return hmac.digest("hex");
}

const matrixPath = path.join(__dirname, "..", "hal", "noise_matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf-8"));

function pearsonR2(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  return { r, r2: r * r };
}
function mae(xs, ys) {
  return xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0) / xs.length;
}

console.log("=== A) Atenüasyon: ölçülen (HAL) vs statik WL[1550].loss ===");
{
  const staticLoss = WL[1550].loss;
  const measured = matrix.summary_clean_channel.map(s => s.attenuation_db_per_km_mean);
  const predicted = matrix.summary_clean_channel.map(() => staticLoss);
  const { r2 } = pearsonR2(measured, predicted.map((_, i) => measured[i])); // r2 anlamsız (predicted sabit) — Δ asıl metrik
  const delta = mae(measured, predicted);
  console.log(`  statik referans = ${staticLoss} dB/km`);
  for (const s of matrix.summary_clean_channel) {
    console.log(`  km=${String(s.distance_km).padStart(3)}  ölçülen=${s.attenuation_db_per_km_mean.toFixed(4)}  Δ=${Math.abs(s.attenuation_db_per_km_mean - staticLoss).toFixed(4)}`);
  }
  console.log(`  Ortalama mutlak hata (Δ) = ${delta.toFixed(5)} dB/km (${(100 * delta / staticLoss).toFixed(2)}% bağıl)`);
  console.log(`  NOT: bu neredeyse tam örtüşme BEKLENEN sonuçtur — SimulatedHardware aynı 0.20dB/km`);
  console.log(`  sabitini kullanıyor (propPhoton'dan portlandı). Asıl doğrulanan şey: ingestion`);
  console.log(`  pipeline'ının (HTTP → JSON → transmittance→dB/km türetme) doğru çalıştığıdır.`);
}

console.log("\n=== B) LEGA risk-skoru şekli vs ölçülen QBER eğrisi (mesafeye göre) ===");
{
  const distances = matrix.summary_clean_channel.map(s => s.distance_km);
  const measuredQber = matrix.summary_clean_channel.map(s => s.qber_mean);
  // LEGA.computeThresholds() context'siz (ctx={}) çağrılırsa fatigue=0,
  // load=0, histBer=0 varsayar — yani yalnızca "taban" scatterDeathProb'u
  // döner (mesafeye göre DEĞİŞMEZ, LEGA'nın kendisi mesafeyi girdi olarak
  // almaz, yalnızca fatigue-bucket key'i için kullanır). Bu yüzden mesafeye
  // duyarlı bir karşılaştırma için LEGA'nın GERÇEKTEN mesafeye duyarlı
  // olan tarafını (fatigue birikimi) simüle ediyoruz: her mesafe için
  // measured lost-oranını "geçmiş kayıp" olarak fatigue'ye besleyip
  // sonra risk skorunu okuyoruz.
  const freshLega = new LinkGradedEavesdropThresholdAlgorithm();
  const legaRisk = [];
  for (const s of matrix.summary_clean_channel) {
    const km = s.distance_km;
    // O mesafedeki ölçülen kayıp oranını fatigue sinyaline dönüştür (20
    // ardışık "lost" olayı = maksimum fatigue=20, bkz. recordOutcome).
    const staticLoss = WL[1550].loss;
    const lossRatio = 1 - Math.pow(10, -(staticLoss * km) / 10); // ölçülenle TUTARLI (bkz. bölüm A)
    const nEvents = Math.round(lossRatio * 20);
    for (let i = 0; i < nEvents; i++) freshLega.recordOutcome(1550, km, true);
    const th = freshLega.computeThresholds(1550, km, { historicalBer: s.qber_mean });
    legaRisk.push(th.scatterDeathProb);
  }
  const { r, r2 } = pearsonR2(measuredQber, legaRisk);
  const delta = mae(
    measuredQber.map(q => (q - Math.min(...measuredQber)) / (Math.max(...measuredQber) - Math.min(...measuredQber))),
    legaRisk.map(v => (v - Math.min(...legaRisk)) / (Math.max(...legaRisk) - Math.min(...legaRisk)))
  );
  for (let i = 0; i < distances.length; i++) {
    console.log(`  km=${String(distances[i]).padStart(3)}  ölçülen_QBER=${(measuredQber[i]*100).toFixed(3)}%  LEGA_scatterDeathProb=${legaRisk[i].toFixed(4)}`);
  }
  console.log(`  Pearson r=${r.toFixed(4)}  R²=${r2.toFixed(4)}  (normalize edilmiş) MAE=${delta.toFixed(4)}`);
  console.log(`  NOT: LEGA'nın histBer girdisi doğrudan ölçülen QBER'den besleniyor (ctx.historicalBer),`);
  console.log(`  bu yüzden R² yüksekliği kısmen bu doğrudan bağlantıdan geliyor — LEGA'nın kendi`);
  console.log(`  BAĞIMSIZ mesafe-duyarlılığı (fatigue biriktirme yoluyla) küçük ama ölçülebilir bir katkı yapıyor.`);
}

console.log("\n=== C) Eavesdrop tespit oranı (Detection Rate) — confusion matrix ===");
{
  const gt = matrix.eavesdrop_ground_truth;
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const r of gt) {
    if (r.eavesdrop_injected && r.eavesdrop_detected) tp++;
    else if (r.eavesdrop_injected && !r.eavesdrop_detected) fn++;
    else if (!r.eavesdrop_injected && r.eavesdrop_detected) fp++;
    else tn++;
  }
  const n = gt.length;
  const tpr = tp / (tp + fn || 1); // detection rate / recall
  const fpr = fp / (fp + tn || 1);
  const accuracy = (tp + tn) / n;
  console.log(`  n=${n}  TP=${tp}  TN=${tn}  FP=${fp}  FN=${fn}`);
  console.log(`  Tespit Oranı (TPR/Recall) = ${(tpr*100).toFixed(2)}%`);
  console.log(`  Yanlış-Alarm Oranı (FPR)  = ${(fpr*100).toFixed(2)}%`);
  console.log(`  Doğruluk (Accuracy)       = ${(accuracy*100).toFixed(2)}%`);
  console.log(`  NOT: bu, QBER>%11 sabit eşiğine dayanan basit bir istatistiksel testtir`);
  console.log(`  (TimeTagCorrelator.correlate ile birebir aynı kural). Intercept-resend saldırısı`);
  console.log(`  ~%25 QBER ürettiği için (%11 eşiğinin 2x üstü) bu mesafe aralığında mükemmel`);
  console.log(`  ayrışma BEKLENİR — asıl zorlu senaryo (kısmi/zayıf dinleme, eşiğe YAKIN QBER) bu`);
  console.log(`  taramada test EDİLMEDİ; B kategorisi bir sonraki adım olarak önerilir.`);
}

// ── Kalibrasyon dosyasını üret (Çekirdeğe Dönüş için girdi) ──
console.log("\n=== D) Kalibrasyon parametreleri türetiliyor (bb84/noise_calibration.json) ===");
{
  const attenValues = matrix.summary_clean_channel.map(s => s.attenuation_db_per_km_mean);
  const attenMean = attenValues.reduce((a, b) => a + b, 0) / attenValues.length;
  const darkValues = matrix.rows.filter(r => !r.eavesdrop).map(r => r.dark_rate_hz_measured);
  const darkMean = darkValues.reduce((a, b) => a + b, 0) / darkValues.length;

  const calibration = {
    generatedFrom: "hal/noise_matrix.json (bkz. hal/noise_matrix_sweep.py)",
    sourceIsRealHardware: false,
    sourceNote: "SimulatedHardware üzerinden; propPhoton ile aynı kapalı-form formülün RNG-örneklenmiş portu. Gerçek donanım (SerialHardware/TCPHardware) bağlandığında bu dosya yeniden üretilmeli.",
    generatedAtSweepWallClockS: matrix.meta.wall_clock_s,
    wavelengthNm: 1550,
    attenuationDbPerKm: { measuredMean: attenMean, staticReference: WL[1550].loss, sampleCount: attenValues.length },
    darkRateHz: { measuredMean: darkMean, sampleCount: darkValues.length },
    eavesdropDetection: (() => {
      const gt = matrix.eavesdrop_ground_truth;
      const tp = gt.filter(r => r.eavesdrop_injected && r.eavesdrop_detected).length;
      const fn = gt.filter(r => r.eavesdrop_injected && !r.eavesdrop_detected).length;
      const fp = gt.filter(r => !r.eavesdrop_injected && r.eavesdrop_detected).length;
      const tn = gt.filter(r => !r.eavesdrop_injected && !r.eavesdrop_detected).length;
      return { tpr: tp / (tp + fn || 1), fpr: fp / (fp + tn || 1), n: gt.length };
    })(),
    // EdgeWeightPolicy.readMeasuredRisk() tarafından tüketilecek — mesafeye
    // göre ölçülen QBER eğrisini (0..1 normalize) bir "measuredRisk" tablosu
    // olarak taşır. Aradaki mesafeler lineer enterpole edilir (bkz.
    // NoiseMatrixCalibration.riskForDistance, PhotonNet2.jsx). NOT: burada
    // linkKey YOK — HAL taraması isimli bir topoloji hattına karşı değil,
    // yalnızca mesafe parametresine karşı çalıştı; bu yüzden tüketici tarafta
    // (riskForLink) bu veri doğru şekilde "network-fallback" sayılacak,
    // belirli bir hatta yanlışlıkla "link-specific" olarak atanmayacak.
    measuredRiskByDistanceKm: matrix.summary_clean_channel.map(s => ({
      km: s.distance_km,
      qberMean: s.qber_mean,
    })),
  };

  // ── KAYNAK DOĞRULAMA: HMAC-SHA256 imzası ──────────────────────────
  // Saldırı simülasyonunun AŞAMA 6 bulgusuna karşı: bu, kalibrasyon
  // verisinin GERÇEKTEN bu hattan (güvenilir kalibrasyon üretim script'i)
  // geldiğini kanıtlayan imzadır — NoiseMatrixCalibration.verifyAndLoad()
  // bu imza olmadan (veya yanlışsa) veriyi REDDEDER. Demo anahtarı bkz.
  // bb84/noise_calibration_signing_key.json (gerçek üretimde SoftHSM2/
  // PKCS#11'de saklanmalı, bkz. o dosyanın uyarısı).
  const signingKey = JSON.parse(fs.readFileSync(path.join(__dirname, "noise_calibration_signing_key.json"), "utf-8"));
  const signatureHex = signCalibration(calibration, signingKey.keyHex);
  const envelope = { payload: calibration, signatureHex, algorithm: "HMAC-SHA256" };

  fs.writeFileSync(path.join(__dirname, "noise_calibration.json"), JSON.stringify(envelope, null, 2));
  console.log("  bb84/noise_calibration.json yazıldı (imzalı zarf: {payload, signatureHex, algorithm}).");
  console.log(`  attenuationDbPerKm.measuredMean=${attenMean.toFixed(4)} darkRateHz.measuredMean=${darkMean.toFixed(3)}`);
  console.log(`  signatureHex=${signatureHex.slice(0, 16)}... (HMAC-SHA256, ${signingKey.keyHex.length/2} baytlık anahtarla)`);
}
