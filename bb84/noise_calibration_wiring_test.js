#!/usr/bin/env node
"use strict";
// Çekirdeğe Dönüş doğrulaması: NoiseMatrixCalibration.riskForDistance()
// gerçekten EdgeWeightPolicy.computeWeight()'in maliyetini değiştiriyor mu,
// ve bu değişiklik "daha uzak/kayıplı mesafe = daha yüksek ek maliyet"
// yönünde tutarlı mı (yani gerçekten routing kararını etkileyebilir mi)?
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, noiseMatrixCalibration, EdgeWeightPolicy, defaultWeightPolicy, WL } = core;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

console.log("=== 1) noiseMatrixCalibration varsayılan (DEFAULT_CALIBRATION) yüklü mü? ===");
check("sourceIsRealHardware alanı mevcut ve false (dürüstçe işaretli)", noiseMatrixCalibration.isRealHardware() === false);
check("riskForDistance(1) ve riskForDistance(100) farklı (mesafeye duyarlı)",
  noiseMatrixCalibration.riskForDistance(1) !== noiseMatrixCalibration.riskForDistance(100));
check("riskForDistance monoton artan (uzak mesafe >= yakın mesafe risk)",
  [1, 5, 10, 20, 35, 50, 75, 100].every((km, i, arr) => i === 0 || noiseMatrixCalibration.riskForDistance(km) >= noiseMatrixCalibration.riskForDistance(arr[i - 1]) - 1e-9));

console.log("\n=== 2) EdgeWeightPolicy.computeWeight — measuredRisk verilmezse ESKİ davranış korunuyor mu? ===");
{
  const link = { a: "A", b: "B", km: 50, nm: 1550 };
  const wOld = defaultWeightPolicy.computeWeight(link, {});
  const wNoCtx = defaultWeightPolicy.computeWeight(link);
  check("ctx={} ve ctx=undefined AYNI sonucu veriyor (geriye dönük uyumluluk)", wOld === wNoCtx, `${wOld} vs ${wNoCtx}`);
  check("measuredRisk verilmeden maliyet = saf fiziksel maliyet (50km × 0.20)", Math.abs(wOld - 50 * WL[1550].loss) < 1e-9, `wOld=${wOld}`);
}

console.log("\n=== 3) measuredRisk verilince maliyet ARTIYOR mu (routing bunu 'daha pahalı' görüyor mu)? ===");
{
  const link = { a: "A", b: "B", km: 100, nm: 1550 };
  const riskScore = noiseMatrixCalibration.riskForDistance(100); // en uzak mesafe = tablodaki en yüksek risk (1.0)
  const withoutRisk = defaultWeightPolicy.computeWeight(link, {});
  const withRisk = defaultWeightPolicy.computeWeight(link, { measuredRisk: { "A-B": riskScore } });
  check("100km linkte measuredRisk=1.0 (tablonun en yüksek noktası) maliyeti artırıyor", withRisk > withoutRisk, `without=${withoutRisk} with=${withRisk} risk=${riskScore}`);
  check("artış oranı measuredRiskFactor (varsayılan 0.4) ile tutarlı (±%1 tolerans)",
    Math.abs((withRisk / withoutRisk) - (1 + defaultWeightPolicy.measuredRiskFactor * riskScore)) < 0.01,
    `oran=${(withRisk/withoutRisk).toFixed(4)} beklenen=${(1+defaultWeightPolicy.measuredRiskFactor*riskScore).toFixed(4)}`);
}

console.log("\n=== 4) B-A ters yönlü key eşleşmesi çalışıyor mu (linkKey normalizasyonu)? ===");
{
  const link = { a: "A", b: "B", km: 20, nm: 1550 };
  const risk = noiseMatrixCalibration.riskForDistance(20);
  const w1 = defaultWeightPolicy.computeWeight(link, { measuredRisk: { "A-B": risk } });
  const w2 = defaultWeightPolicy.computeWeight(link, { measuredRisk: { "B-A": risk } });
  check("A-B ve B-A anahtarları aynı maliyeti üretiyor", Math.abs(w1 - w2) < 1e-9, `${w1} vs ${w2}`);
}

console.log("\n=== 5) Gerçek donanım kalibrasyonu yüklendiğinde eski varsayılan devre dışı kalıyor mu? ===");
{
  const fakeRealCalibration = NoiseMatrixCalibration.loadFromJSON({
    sourceIsRealHardware: true,
    measuredRiskByDistanceKm: [{ km: 1, qberMean: 0.01 }, { km: 100, qberMean: 0.30 }], // varsayımsal "kötü" gerçek hat
  });
  check("loadFromJSON ile sourceIsRealHardware=true taşınabiliyor", fakeRealCalibration.isRealHardware() === true);
  check("yeni tablo farklı risk üretiyor (100km artık çok daha riskli)",
    fakeRealCalibration.riskForDistance(100) === 1.0 && fakeRealCalibration.riskForDistance(1) === 0.0);
}

console.log(`\n════════════════════════════════════════`);
console.log(`SONUÇ: ${pass} geçti, ${fail} başarısız (${pass + fail} test)`);
console.log(`════════════════════════════════════════`);
process.exit(fail > 0 ? 1 : 0);
