#!/usr/bin/env node
"use strict";
/**
 * predictive_jitter_test.js — TAHMİNSEL JITTER HİZALAMA tatbikatı
 *
 * predictive_jitter_alignment.js'i (Kalman saat kestiricisi + ön-besleme)
 * uçtan uca sınar. Ölçülen sorular:
 *   (A) DRIFT: saf sürüklenmede artık → 0'a iniyor mu? (öngörülebilir yapı)
 *   (B) CANLI-KİLİT UÇURUMU KALKIYOR MU: async_sync'i kilitleyen drift
 *       taramasında ön-besleme drop'u ~0'da tutuyor mu?
 *   (C) TERMAL: yavaş sinüzoidal + drift altında artık jitter tabanına
 *       yakın mı?
 *   (D) DÜRÜST SINIR: saf beyaz jitter'da (öngörülebilir yapı YOK) artık =
 *       tam jitter — kestirici yapı UYDURMUYOR mu?
 *   (E) ADAPTASYON: ani offset sıçraması (yeniden yönlendirme) sonrası
 *       kaç adımda toparlıyor?
 *   (F) PERSISTENCE'İ YENİYOR MU: "son değeri tekrarla" saf tahmincisine
 *       göre öngörü hatası daha küçük mü?
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PJA = require("./predictive_jitter_alignment.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const N = 4000, W = 5, JIT = 1.5;

  // ══ (A) SAF DRIFT: artık sıfıra iniyor mu ══
  const drift = 0.05;
  const srcDrift = PJA.makeSkewSource({ driftPerStep: drift, jitter: JIT, seed: 7 });
  const alignedD = PJA.runAligned({ N, windowMs: W, skewSource: srcDrift, predict: true });
  const naiveD = PJA.runAligned({ N, windowMs: W, skewSource: srcDrift, predict: false });
  // artık, ilk yakınsamadan sonra (ikinci yarı) ölçülür
  const half = Math.floor(N / 2);
  const tailRes = (r) => { const a = r.residuals.slice(half).map(Math.abs); return a.reduce((s, x) => s + x, 0) / a.length; };
  out.drift = { driftPerStep: drift, alignedTailResidual: +tailRes(alignedD).toFixed(3),
    naiveTailResidual: +tailRes(naiveD).toFixed(3), jitterFloor: JIT,
    alignedDropPct: alignedD.dropPct, naiveDropPct: naiveD.dropPct, learnedDrift: alignedD.finalDrift };
  chk("(A) DRIFT ÖĞRENİLDİ: ön-besleme artığı jitter tabanına iniyor",
    tailRes(alignedD) < JIT * 1.5 && tailRes(naiveD) > tailRes(alignedD) * 3,
    `saf drift ${drift} ms/adım · ön-besleme artığı ${tailRes(alignedD).toFixed(2)} ms (jitter tabanı ~${JIT}), ` +
    `öğrenilen drift ${alignedD.finalDrift} · düzeltmesiz artık ${tailRes(naiveD).toFixed(1)} ms (sürükleniyor). ` +
    `Kestirici offset+drift'i öğrenip önceden siliyor`);

  // ══ (B) CANLI-KİLİT UÇURUMU KALKIYOR MU (drift taraması) ══
  const drifts = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8];
  const sweep = drifts.map(d => {
    const src = PJA.makeSkewSource({ driftPerStep: d, jitter: JIT, seed: 11 });
    const al = PJA.runAligned({ N, windowMs: W, skewSource: src, predict: true });
    const na = PJA.runAligned({ N, windowMs: W, skewSource: src, predict: false });
    return { driftPerStep: d, alignedDropPct: al.dropPct, alignedResyncs: al.resyncs,
      naiveDropPct: na.dropPct, naiveResyncs: na.resyncs };
  });
  out.livelock = { windowMs: W, rows: sweep };
  const worstNaive = Math.max(...sweep.map(r => r.naiveDropPct));
  const worstAligned = Math.max(...sweep.map(r => r.alignedDropPct));
  chk("(B) CANLI-KİLİT UÇURUMU KALKTI: ön-besleme her drift'te drop'u düşük tutuyor",
    worstAligned < 5 && worstNaive > 40,
    sweep.map(r => `${r.driftPerStep}→ön-besleme %${r.alignedDropPct}/naif %${r.naiveDropPct}`).join(" · ") +
    ` — düzeltmesiz drop en kötü %${worstNaive.toFixed(0)} (canlı-kilit), ön-beslemeli en kötü %${worstAligned.toFixed(1)}. ` +
    `Uçurum kaldırıldı: pencere hiç açılmadan skew telafi ediliyor`);

  // ══ (C) TERMAL (yavaş sinüzoidal + drift) ══
  const srcTh = PJA.makeSkewSource({ driftPerStep: 0.02, thermalAmp: 8, thermalPeriod: 500, jitter: JIT, seed: 21 });
  const alTh = PJA.runAligned({ N, windowMs: W, skewSource: srcTh, predict: true, q: 5e-3 });
  const naTh = PJA.runAligned({ N, windowMs: W, skewSource: srcTh, predict: false });
  out.thermal = { thermalAmp: 8, alignedTailResidual: +tailRes(alTh).toFixed(3),
    naiveTailResidual: +tailRes(naTh).toFixed(3), alignedDropPct: alTh.dropPct, naiveDropPct: naTh.dropPct };
  chk("(C) TERMAL SÜRÜKLENME: yavaş sinüzoidal + drift artığı pencere altında",
    tailRes(alTh) < W && alTh.dropPct < naTh.dropPct * 0.5,
    `termal genlik 8 ms (pencere ${W}) · ön-besleme artığı ${tailRes(alTh).toFixed(2)} ms, drop %${alTh.dropPct} · ` +
    `düzeltmesiz artık ${tailRes(naTh).toFixed(1)} ms, drop %${naTh.dropPct}. Kalman yavaş termali izliyor`);

  // ══ (D) DÜRÜST SINIR: saf beyaz jitter (öngörülebilir yapı YOK) ══
  const srcNoise = PJA.makeSkewSource({ driftPerStep: 0, thermalAmp: 0, jitter: JIT, seed: 33 });
  const alN = PJA.runAligned({ N, windowMs: W, skewSource: srcNoise, predict: true });
  const naN = PJA.runAligned({ N, windowMs: W, skewSource: srcNoise, predict: false });
  const ratio = tailRes(alN) / tailRes(naN);
  out.limit = { alignedResidual: +tailRes(alN).toFixed(3), naiveResidual: +tailRes(naN).toFixed(3),
    ratio: +ratio.toFixed(3) };
  chk("(D) DÜRÜST SINIR: saf jitter'da kestirici YAPI UYDURMUYOR (artık ≈ tam jitter)",
    ratio > 0.85 && ratio < 1.25,
    `öngörülebilir yapı YOKken: ön-besleme artığı ${tailRes(alN).toFixed(2)} ms ≈ düzeltmesiz ${tailRes(naN).toFixed(2)} ms ` +
    `(oran ×${ratio.toFixed(2)}). Kestirici olmayan bir örüntüyü UYDURMUYOR — yalnız gerçek yapıyı siliyor. ` +
    `Bu, modülün kendi sınırının dürüst kanıtı`);

  // ══ (E) ADAPTASYON: ani offset sıçraması (yeniden yönlendirme) ══
  const stepAt = Math.floor(N / 2), stepSize = 30;
  const kf = new PJA.JitterPredictor({ q: 1e-4, r: 1.0 });
  const rngSeed = PJA.makeSkewSource({ driftPerStep: 0.02, jitter: JIT, seed: 41 });
  let recovery = null;
  for (let k = 0; k < N; k++) {
    const trueSkew = rngSeed(k) + (k >= stepAt ? stepSize : 0);
    const est = kf.predict();
    const res = Math.abs(trueSkew - est);
    if (k >= stepAt && recovery === null && k > stepAt + 2 && res < W) recovery = k - stepAt;
    kf.update(trueSkew);
  }
  // Adaptasyon izi (sıçrama çevresi, sıkıştırılmış) — grafiğe.
  const kf3 = new PJA.JitterPredictor({ q: 1e-4, r: 1.0 });
  const stepTrace = [];
  for (let k = 0; k < N; k++) {
    const trueSkew = rngSeed(k) + (k >= stepAt ? stepSize : 0);
    const res = trueSkew - kf3.predict();
    if (k >= stepAt - 40 && k <= stepAt + 80) stepTrace.push(+res.toFixed(3));
    kf3.update(trueSkew);
  }
  out.adaptation = { stepSize, recoverySteps: recovery, stepAt, trace: stepTrace, traceStart: -40 };

  // Yakınsama izi (drift, sıkıştırılmış 120 nokta) — grafiğe.
  const down = (arr, n = 120) => { const o = []; for (let i = 0; i < n; i++) { const a = Math.floor(i * arr.length / n), b = Math.floor((i + 1) * arr.length / n); let m = 0, c = 0; for (let j = a; j < b; j++) { m += Math.abs(arr[j]); c++; } o.push(+(c ? m / c : 0).toFixed(3)); } return o; };
  out.convergence = { alignedTrace: down(alignedD.residuals), naiveTrace: down(naiveD.residuals.map(x => Math.min(x, 40))) };
  chk("(E) ADAPTASYON: ani offset sıçraması sonrası hızlı toparlanma",
    recovery !== null && recovery < 60,
    `t=${stepAt}'te ${stepSize} ms ani offset sıçraması (fiber yeniden yönlendirme) · ` +
    `kestirici ${recovery} adımda artığı pencere (${W} ms) altına indirdi. Kalman kazancı ani değişimi yakalıyor`);

  // ══ (F) PERSISTENCE BASELINE'INI YENİYOR MU ══
  // "son değeri tekrarla" (persistence) vs Kalman öngörü hatası.
  const src2 = PJA.makeSkewSource({ driftPerStep: 0.05, jitter: JIT, seed: 51 });
  const kf2 = new PJA.JitterPredictor({ q: 1e-4, r: 1.0 });
  let sumKf = 0, sumPersist = 0, prev = 0, cnt = 0;
  for (let k = 0; k < N; k++) {
    const z = src2(k);
    if (k > 20) { sumKf += Math.abs(z - kf2.predict()); sumPersist += Math.abs(z - prev); cnt++; }
    kf2.update(z); prev = z;
  }
  const kfErr = sumKf / cnt, persistErr = sumPersist / cnt;
  out.vsPersistence = { kalmanMAE: +kfErr.toFixed(3), persistenceMAE: +persistErr.toFixed(3),
    improvementPct: +(100 * (1 - kfErr / persistErr)).toFixed(1) };
  chk("(F) ÖĞRENEN MODEL 'son değeri tekrarla'yı YENİYOR",
    kfErr < persistErr,
    `öngörü hatası (MAE): Kalman ${kfErr.toFixed(2)} ms vs persistence ${persistErr.toFixed(2)} ms ` +
    `(%${(100 * (1 - kfErr / persistErr)).toFixed(0)} daha iyi). Drift varken 'son değeri tekrarla' hep bir ` +
    `adım geride kalır; öğrenen model trendi ekstrapole eder`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter,
    `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — modül bağımsız L5.5, yalnız mulberry32 çağrılıyor`);

  out.params = { N, windowMs: W, jitter: JIT };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "predictive_jitter.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ TAHMİNSEL JITTER HİZALAMA ══\n");
  console.log(`  (A) DRIFT: ön-besleme artığı ${t(out.drift.alignedTailResidual, 2)} ms (jitter tabanı ${t(out.drift.jitterFloor, 1)}) · düzeltmesiz ${t(out.drift.naiveTailResidual, 1)} ms`);
  console.log(`\n  (B) CANLI-KİLİT UÇURUMU (drop %)`);
  console.log("       drift(ms/adım)   ön-besleme   düzeltmesiz");
  for (const r of out.livelock.rows)
    console.log(`     ${pad(t(r.driftPerStep, 2), 12)} ${pad("%" + t(r.alignedDropPct, 1), 12)} ${pad("%" + t(r.naiveDropPct, 1), 13)}`);
  console.log(`\n  (C) TERMAL: artık ${t(out.thermal.alignedTailResidual, 2)} ms, drop %${t(out.thermal.alignedDropPct, 1)} (düzeltmesiz %${t(out.thermal.naiveDropPct, 1)})`);
  console.log(`  (D) SINIR: saf jitter'da artık oranı ×${t(out.limit.ratio, 2)} (≈1 → yapı uydurmuyor)`);
  console.log(`  (E) ADAPTASYON: ${t(out.adaptation.stepSize)} ms sıçrama → ${t(out.adaptation.recoverySteps)} adımda toparladı`);
  console.log(`  (F) vs persistence: Kalman ${t(out.vsPersistence.kalmanMAE, 2)} ms vs ${t(out.vsPersistence.persistenceMAE, 2)} ms (%${t(out.vsPersistence.improvementPct, 0)} daha iyi)`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "predictive_jitter.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
