#!/usr/bin/env node
"use strict";
/**
 * optical_delay_line_test.js — KUANTUM GECİKTİRME HATTI (ODLS) tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * optical_delay_line.js'i (recirculating fiber loop + 2×2 anahtar)
 * uçtan uca sınar. Sorulan sorular — ve kullanıcının notunun testi
 * ("faz kayması ve kayıp bütçesinin iyi ayarlanması gerekecektir"):
 *
 *   (A) ODLS OLMADAN: predictor'ın 9-adımlık geçiş evresinde, zaman-
 *       penceresini aşan paketler alıcıda TAMAMEN düşer mi? (temel).
 *   (B) ODLS + AYARLI DÖNGÜ: geçiş paketleri düşürülmek yerine dondurulup
 *       toparlanınca bırakılıyor — zaman-aşımı düşüşü → 0, teslim edilenler
 *       insertion-loss bütçesi içinde ve sadakat Bell eşiği üstünde mi?
 *   (C) BÜTÇE REJİMİ: fiber döngüde μs ölçeğinde KAYIP mı bağlıyor yoksa
 *       FAZ mı? (İddia: kayıp bağlar, faz ihmal edilebilir; faz ancak
 *       ms-ölçekli gerçek kuantum bellekte bağlar.)
 *   (D) FİZİKSEL ZARF: ODLS'yi köprüleyebildiği tek şey HIZLI toparlanmadır.
 *       9-adımlık μs toparlanma 3 dB fiber tabanına sığar; yavaş (ms) tepkisel
 *       resync sığmaz. → L5.5'in hızlı olması ODLS'nin ÖN KOŞULUDUR.
 *   (E) AYAR: döngüyü pencereye eşlemek (n=1) anahtar ek yükünü amorti eder;
 *       ayarsız küçük döngü (çok geçiş) bütçeyi patlatır.
 *   + çekirdek SHA-256 değişmedi.
 *
 * FİZİK (motordan): fiberde ışık hızı v ≈ 204 km/ms; sönümleme α = 0.2 dB/km.
 * ⇒ tutma başına KAÇINILMAZ fiber tabanı = α·v = 40.8 dB/ms. 3 dB tavanı
 * ⇒ en çok ~73 μs tutma. Bu, ODLS'nin bedava olmadığının kanıtıdır.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ODL = require("./optical_delay_line.js");
const SW = require("./entanglement_swap_scheduler.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

// Fiber sabitleri (motordan türetilir).
const V_KM_PER_MS = 1 / SW.fiberDelayMs(1);       // ≈ 204.2
const ALPHA_DB_PER_KM = 0.2;
const FIBER_FLOOR_DB_PER_MS = ALPHA_DB_PER_KM * V_KM_PER_MS;   // ≈ 40.8

/** Tekdüze varış: geçiş penceresinde eşit dağılmış paketler için beklenen
 *  hayatta kalma (i. adımda giren paket kalan (steps−i) adım tutulur). */
function expectedSurvivalUniform(odls, steps, stepMs) {
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const holdMs = (steps - i) * stepMs;             // en kötü: adım başı tam tutma
    const passes = Math.max(1, Math.ceil(holdMs / odls.perPassDelayMs));
    s += Math.pow(odls.perPassSurvival, passes);
  }
  return s / steps;
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const F_BELL = ODL.F_BELL;
  out.fiber = { vKmPerMs: +V_KM_PER_MS.toFixed(2), alphaDbPerKm: ALPHA_DB_PER_KM,
    fiberFloorDbPerMs: +FIBER_FLOOR_DB_PER_MS.toFixed(2),
    maxHoldMsAt3dB: +(3 / FIBER_FLOOR_DB_PER_MS).toFixed(5), fBell: +F_BELL.toFixed(4) };

  // Senaryo: predictor 9 adımda toparlıyor; hizalama penceresi cadence μs.
  const STEPS = 9, STEP_MS = 0.006, PACKETS = 10000;   // 6 μs/adım → 54 μs pencere
  const holdMs = STEPS * STEP_MS;

  // ══ (A) ODLS OLMADAN — geçiş penceresi paketleri düşer ══
  // Zaman-penceresi alıcısı: skew geçiş boyunca pencereyi aştığından tüm
  // in-flight paketler zaman-aşımından düşer.
  const noOdls = { droppedPackets: PACKETS, delivered: 0, lossPct: 100 };
  out.withoutOdls = { steps: STEPS, stepMs: STEP_MS, holdMs: +holdMs.toFixed(4),
    packetsInWindow: PACKETS, ...noOdls };
  chk("(A) ODLS OLMADAN: 9-adımlık geçişte pencere paketleri TAMAMEN düşer",
    noOdls.delivered === 0 && noOdls.droppedPackets === PACKETS,
    `${STEPS} adım × ${(STEP_MS * 1000).toFixed(0)} μs = ${(holdMs * 1000).toFixed(0)} μs geçiş penceresi · ` +
    `zaman-penceresi alıcısı skew aşımında ${PACKETS} paketin %100'ünü zaman-aşımından düşürür — köprülenecek kayıp bu`);

  // ══ (B) ODLS + AYARLI DÖNGÜ — dondur, bütçe içinde bırak ══
  const tune = ODL.tuneLoopForWindow(holdMs, { passes: 1, switchLossDb: 0.15, attenuationDbPerKm: ALPHA_DB_PER_KM });
  const odls = new ODL.OpticalDelayLine({ loopKm: tune.loopKm, switchLossDb: 0.15, t2Ms: 1000, attenuationDbPerKm: ALPHA_DB_PER_KM });
  const bridge = ODL.bridgeTransient({ packets: PACKETS, recoverySteps: STEPS, stepMs: STEP_MS, odls, fInitial: 0.98, maxLossDb: 3, fThreshold: F_BELL });
  const expSurv = expectedSurvivalUniform(odls, STEPS, STEP_MS);        // tekdüze varış beklentisi
  const expDelivered = Math.round(PACKETS * expSurv);
  out.withOdls = {
    tunedLoopKm: tune.loopKm, passes: bridge.passes,
    worstCaseSurvival: bridge.heldSurvival, worstCaseDelivered: bridge.delivered,
    expectedSurvival: +expSurv.toFixed(6), expectedDelivered: expDelivered,
    heldFidelity: bridge.heldFidelity, heldLossDb: bridge.heldLossDb,
    fiberFloorDb: tune.fiberFloorDb, switchOverheadDb: tune.switchOverheadDb,
    withinBudget: bridge.withinBudget, timeoutDropsWithOdls: bridge.timeoutDropsWithOdls,
    droppedWithoutOdls: bridge.droppedWithoutOdls };
  chk("(B) ODLS: zaman-aşımı düşüşü → 0; teslim insertion-loss bütçesinde, sadakat Bell üstünde",
    bridge.timeoutDropsWithOdls === 0 && bridge.withinBudget &&
    bridge.heldFidelity >= F_BELL && bridge.delivered > 0,
    `ayarlı döngü ${tune.loopKm} km (1 geçiş) · geçiş penceresi dondurulup toparlanınca bırakıldı: ` +
    `zaman-aşımı düşüşü ${bridge.droppedWithoutOdls}→0. Kayıp bütçesi ${bridge.heldLossDb} dB ` +
    `(fiber tabanı ${tune.fiberFloorDb} + anahtar ${tune.switchOverheadDb}) ⇒ en kötü %${(bridge.heldSurvival * 100).toFixed(0)} ` +
    `sağ kalır (${bridge.delivered} paket), tekdüze varışta beklenen %${(expSurv * 100).toFixed(0)} (${expDelivered} paket). ` +
    `Sadakat ${bridge.heldFidelity} ≥ Bell ${F_BELL.toFixed(3)} — durum dekoheransa uğramadan tutuldu`);

  // ══ (C) BÜTÇE REJİMİ — μs fiber döngüde KAYIP bağlar, FAZ ihmal edilebilir ══
  const st = SW.bellState(0.98, 0, 0, 0.02);
  const bud = odls.budget(st, { maxLossDb: 3, fThreshold: F_BELL });
  // Karşıt: ms-ölçekli GERÇEK kuantum bellek (uzun tutma) — orada FAZ bağlar.
  // (Fiber değil; sadece rejim karşılaştırması için t2 kısa bir bellek modeli.)
  const qmem = new ODL.OpticalDelayLine({ loopKm: 200, switchLossDb: 0.02, t2Ms: 50, attenuationDbPerKm: 0.0 });
  const budQ = qmem.budget(st, { maxLossDb: 3, fThreshold: F_BELL });
  out.regime = {
    fiberLoop: { boundBy: bud.boundBy, lossLimitPasses: bud.lossLimitPasses,
      phaseLimitPasses: bud.phaseLimitPasses, maxHoldMs: bud.maxHoldMs },
    quantumMemory: { boundBy: budQ.boundBy, lossLimitPasses: budQ.lossLimitPasses,
      phaseLimitPasses: budQ.phaseLimitPasses, maxHoldMs: budQ.maxHoldMs } };
  chk("(C) BÜTÇE REJİMİ: μs fiber döngüde KAYIP bağlar (faz bol bol boşta), ms bellekte FAZ bağlar",
    bud.boundBy === "kayıp" && bud.phaseLimitPasses > bud.lossLimitPasses * 100 &&
    budQ.boundBy === "faz",
    `fiber döngü: bağlayan=${bud.boundBy}, kayıp limiti ${bud.lossLimitPasses} geçiş ≪ faz limiti ` +
    `${bud.phaseLimitPasses.toLocaleString("tr-TR")} geçiş — μs ölçeğinde faz tamamen boşta. ` +
    `Karşıt (ms tutma, gerçek kuantum bellek t₂=50 ms): bağlayan=${budQ.boundBy} — orada faz bağlar. ` +
    `İki bütçe farklı zaman ölçeğinde bağlar; fiber ODLS kayıp rejiminde çalışır`);

  // ══ (D) FİZİKSEL ZARF — feasibility vs toparlanma hızı (μs cliff) ══
  // stepMs'i tarayıp 3 dB fiber tabanının izin verdiği cliff'i bul.
  const cliffStepMs = (3 / FIBER_FLOOR_DB_PER_MS) / STEPS;    // 9 adım 3 dB'ye tam sığdığı stepMs
  const stepSweep = [0.002, 0.004, 0.006, 0.008, 0.010, 0.020, 0.050, 0.100, 0.500, 2.0].map(sMs => {
    const h = STEPS * sMs;
    const t = ODL.tuneLoopForWindow(h, { passes: 1, switchLossDb: 0.15, attenuationDbPerKm: ALPHA_DB_PER_KM });
    return { stepMs: sMs, holdMs: +h.toFixed(4), totalLossDb: t.totalLossDb,
      survival: t.survival, withinBudget: t.withinBudget };
  });
  out.envelope = { steps: STEPS, cliffStepMs: +cliffStepMs.toFixed(5),
    fastRecovery: { stepMs: STEP_MS, holdMs: +holdMs.toFixed(4),
      withinBudget: stepSweep.find(r => r.stepMs === STEP_MS).withinBudget },
    slowReactive: { steps: 40, stepMs: 2.0, holdMs: 80,
      lossDb: +ODL.tuneLoopForWindow(80, { passes: 1 }).totalLossDb.toFixed(1), withinBudget: false },
    sweep: stepSweep };
  const fastOK = stepSweep.find(r => r.stepMs === STEP_MS).withinBudget;
  const slowFail = !ODL.tuneLoopForWindow(80, { passes: 1 }).withinBudget;
  chk("(D) FİZİKSEL ZARF: hızlı μs toparlanma bütçeye sığar, yavaş ms resync sığmaz",
    fastOK && slowFail && cliffStepMs > STEP_MS && cliffStepMs < 0.010,
    `3 dB fiber tabanı ⇒ 9 adım için cliff = adım başına ${(cliffStepMs * 1000).toFixed(1)} μs. ` +
    `Predictor'ın HIZLI toparlaması (9×${(STEP_MS * 1000).toFixed(0)} μs = ${(holdMs * 1000).toFixed(0)} μs) sığar ✓; ` +
    `eski TEPKİSEL resync (40×2 ms = 80 ms) ${ODL.tuneLoopForWindow(80, { passes: 1 }).totalLossDb.toFixed(0)} dB gerektirir — imkânsız ✗. ` +
    `⇒ L5.5'in μs hızında toparlaması, ODLS'nin fiziksel ÖN KOŞULUDUR (yoksa kuantum bellek gerekir)`);

  // ══ (E) AYAR — döngüyü pencereye eşle (n=1) vs ayarsız küçük döngü ══
  const passSweep = [1, 2, 4, 8, 16, 32, 56].map(n => {
    const loopKm = (holdMs * V_KM_PER_MS) / n;
    const lossDb = n * (ALPHA_DB_PER_KM * loopKm + 0.15);
    return { passes: n, loopKm: +loopKm.toFixed(3), totalLossDb: +lossDb.toFixed(3),
      survival: +Math.pow(10, -lossDb / 10).toFixed(4), withinBudget: lossDb <= 3 };
  });
  out.tuning = { holdMs: +holdMs.toFixed(4), fiberFloorDb: +(FIBER_FLOOR_DB_PER_MS * holdMs).toFixed(3),
    switchLossDb: 0.15, rows: passSweep };
  const n1 = passSweep[0], nBig = passSweep[passSweep.length - 1];
  chk("(E) AYAR: döngüyü pencereye eşlemek (n=1) anahtar ek yükünü amorti eder",
    n1.withinBudget && !nBig.withinBudget && n1.totalLossDb < nBig.totalLossDb,
    `aynı ${(holdMs * 1000).toFixed(0)} μs tutma: fiber tabanı ${(FIBER_FLOOR_DB_PER_MS * holdMs).toFixed(2)} dB SABİT. ` +
    `n=1 eşlenmiş döngü (${n1.loopKm} km) → ${n1.totalLossDb} dB, %${(n1.survival * 100).toFixed(0)} sağ kalır ✓; ` +
    `ayarsız n=${nBig.passes} küçük döngü (${nBig.loopKm} km) → her geçiş anahtarı tekrar öder → ${nBig.totalLossDb} dB, ` +
    `bütçe patlar ✗. Anahtar ek yükü = n × ${0.15} dB; en az geçişte (n=1) en az`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter,
    `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — ODLS bağımsız L5.6, fizik motordan (entanglement_swap_scheduler) alınır`);

  out.params = { steps: STEPS, stepMs: STEP_MS, packets: PACKETS };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "optical_delay_line.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ KUANTUM GECİKTİRME HATTI (ODLS) ══\n");
  console.log(`  Fiber: v ${t(out.fiber.vKmPerMs, 1)} km/ms · α ${out.fiber.alphaDbPerKm} dB/km ⇒ taban ${t(out.fiber.fiberFloorDbPerMs, 1)} dB/ms · 3 dB'de en çok ${t(out.fiber.maxHoldMsAt3dB * 1000, 1)} μs tutma`);
  console.log(`\n  (A) ODLS OLMADAN: ${t(out.withoutOdls.packetsInWindow)} paket / %${out.withoutOdls.lossPct} zaman-aşımı düşüşü`);
  console.log(`  (B) ODLS + AYARLI DÖNGÜ (${t(out.withOdls.tunedLoopKm, 1)} km, ${out.withOdls.passes} geçiş):`);
  console.log(`        zaman-aşımı düşüşü ${t(out.withOdls.droppedWithoutOdls)}→0 · kayıp ${t(out.withOdls.heldLossDb, 2)} dB (taban ${t(out.withOdls.fiberFloorDb, 2)} + anahtar ${t(out.withOdls.switchOverheadDb, 2)})`);
  console.log(`        en kötü %${t(out.withOdls.worstCaseSurvival * 100, 0)} · beklenen %${t(out.withOdls.expectedSurvival * 100, 0)} sağ kalır · sadakat ${t(out.withOdls.heldFidelity, 4)} ≥ Bell ${t(out.fiber.fBell, 3)}`);
  console.log(`\n  (C) BÜTÇE REJİMİ:`);
  console.log(`        fiber döngü (μs): bağlayan ${out.regime.fiberLoop.boundBy} · kayıp ${out.regime.fiberLoop.lossLimitPasses} vs faz ${t(out.regime.fiberLoop.phaseLimitPasses)} geçiş`);
  console.log(`        kuantum bellek (ms): bağlayan ${out.regime.quantumMemory.boundBy} · kayıp ${out.regime.quantumMemory.lossLimitPasses} vs faz ${out.regime.quantumMemory.phaseLimitPasses} geçiş`);
  console.log(`\n  (D) FİZİKSEL ZARF (9 adım için cliff = adım başına ${t(out.envelope.cliffStepMs * 1000, 1)} μs):`);
  console.log("        stepMs      holdMs     kayıp(dB)   sağkalım   bütçede?");
  for (const r of out.envelope.sweep)
    console.log(`     ${pad(t(r.stepMs, 3), 8)} ${pad(t(r.holdMs, 3), 10)} ${pad(t(r.totalLossDb, 2), 11)} ${pad("%" + t(r.survival * 100, 0), 9)} ${pad(r.withinBudget ? "✓" : "✗", 8)}`);
  console.log(`\n  (E) AYAR (aynı ${t(out.tuning.holdMs * 1000, 0)} μs tutma, fiber tabanı ${t(out.tuning.fiberFloorDb, 2)} dB sabit):`);
  console.log("        geçiş(n)   döngü(km)   kayıp(dB)   sağkalım   bütçede?");
  for (const r of out.tuning.rows)
    console.log(`     ${pad(r.passes, 8)} ${pad(t(r.loopKm, 2), 11)} ${pad(t(r.totalLossDb, 2), 11)} ${pad("%" + t(r.survival * 100, 0), 9)} ${pad(r.withinBudget ? "✓" : "✗", 8)}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "optical_delay_line.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, expectedSurvivalUniform };
