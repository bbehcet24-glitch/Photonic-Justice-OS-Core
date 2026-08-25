#!/usr/bin/env node
"use strict";
/**
 * odls_provision_test.js — provisionOdls + calibrateQForSteps regresyonu
 * ═══════════════════════════════════════════════════════════════════
 * odls_optimization tatbikatının bulgularını OPERATÖR ÇAĞRILARINA taşıyan
 * iki yardımcının doğruluğunu sabitler:
 *   (A) provisionOdls: SMF 9-adım → L5.6 senaryosuyla (2,36 dB, ~%58) birebir.
 *   (B) provisionOdls: 5-adım × hollow-core → sentezle (~0,87 dB, ~%82) birebir.
 *   (C) provisionOdls: Si₃N₄ çip fizibil DEĞİL (taban ×386 → bütçe patlar).
 *   (D) calibrateQForSteps: 5 adım hedefi ÖLÇÜMLE ulaşılabilir, q sabit değil.
 *   (E) calibrateQForSteps: 1 adım hedefi model tabanının altında → uyarır.
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ODL = require("./optical_delay_line.js");
const PJA = require("./predictive_jitter_alignment.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const STEP_MS = 0.006;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) provisionOdls: SMF 9-adım = L5.6 senaryosu ══
  const smf9 = ODL.provisionOdls({ recoverySteps: 9, stepMs: STEP_MS, medium: "smf" });
  out.smf9 = smf9;
  chk("(A) provisionOdls SMF/9-adım L5.6 senaryosuyla birebir (~2,36 dB, ~%58)",
    Math.abs(smf9.totalLossDb - 2.36) < 0.05 && Math.abs(smf9.survivalPct - 58) < 2 &&
    smf9.feasible && smf9.boundBy === "ikisi de bütçede",
    `9 adım × 6 μs = ${smf9.holdUs} μs, eşlenmiş döngü ${smf9.loopKm} km · kayıp ${smf9.totalLossDb} dB ` +
    `(taban ${smf9.fiberFloorDb} + anahtar ${smf9.switchOverheadDb}) ⇒ sağkalım %${smf9.survivalPct}, ` +
    `sadakat ${smf9.fidelity} · bağlayan: ${smf9.boundBy}`);

  // ══ (B) provisionOdls: 5-adım × hollow-core = sentez ══
  const hc5 = ODL.provisionOdls({ recoverySteps: 5, stepMs: STEP_MS, medium: "hollowCore" });
  out.hollow5 = hc5;
  chk("(B) provisionOdls 5-adım × hollow-core sentezle birebir (~0,87 dB, ~%82)",
    Math.abs(hc5.totalLossDb - 0.87) < 0.05 && Math.abs(hc5.survivalPct - 82) < 2 && hc5.feasible,
    `5 adım × hollow-core NANF → ${hc5.holdUs} μs, döngü ${hc5.loopKm} km · kayıp ${hc5.totalLossDb} dB ⇒ ` +
    `sağkalım %${hc5.survivalPct} (SMF/9-adım %${smf9.survivalPct}'ten). İki gerçek kaldıraç yığılı`);

  // ══ (C) provisionOdls: Si₃N₄ çip fizibil DEĞİL ══
  const si5 = ODL.provisionOdls({ recoverySteps: 5, stepMs: STEP_MS, medium: "si3n4" });
  out.si3n4_5 = si5;
  chk("(C) provisionOdls Si₃N₄ çip FİZİBİL DEĞİL — taban ×386, bütçe patlar",
    !si5.feasible && si5.boundBy === "kayıp" && si5.totalLossDb > 100,
    `aynı 5 adım Si₃N₄ çipte: kayıp ${si5.totalLossDb.toFixed(0)} dB (fiber tabanı ${si5.fiberFloorDb.toFixed(0)}), ` +
    `bütçe-dışı ✗ — çip ayak izinde kazanır, kayıpta değil. provisionOdls bunu fizibilite bayrağıyla reddediyor`);

  // ══ (D) calibrateQForSteps: 5 adım ÖLÇÜMLE ulaşılabilir ══
  const cal5 = PJA.calibrateQForSteps(5, {});
  out.calibrate5 = { targetSteps: cal5.targetSteps, recommendedQ: cal5.recommendedQ,
    achievedSteps: cal5.achievedSteps, steadyDropPct: cal5.steadyDropPct, feasible: cal5.feasible };
  chk("(D) calibrateQForSteps(5): ÖLÇÜMLE ulaşılabilir, q sabit değil, bedel düşük",
    cal5.feasible && cal5.achievedSteps <= 5 && cal5.steadyDropPct < 2 && cal5.recommendedQ > 0,
    `5-adım hedefi için ölçülen en az agresif q = ${cal5.recommendedQ} → ${cal5.achievedSteps} adım, ` +
    `dar-pencere bedeli %${cal5.steadyDropPct}. q sabit KODLANMADI — senaryoda taranıp seçildi`);

  // ══ (E) calibrateQForSteps: 1 adım model tabanının altında → uyarı ══
  const cal1 = PJA.calibrateQForSteps(1, {});
  out.calibrate1 = { targetSteps: 1, feasible: cal1.feasible, belowModelFloor: cal1.belowModelFloor,
    achievedSteps: cal1.achievedSteps, reason: cal1.reason };
  chk("(E) calibrateQForSteps(1): model tabanı altı → uyarır (q ile değil model ile çözülür)",
    cal1.belowModelFloor === true && !cal1.feasible,
    `1-adım hedefi: ${cal1.reason} — en iyi çaba ${cal1.achievedSteps} adım. ` +
    `Sabit-hızlı Kalman sıçrama sonrası drift için ≥2 ölçüm ister; daha ilerisi modeli değiştirmeyi gerektirir`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "odls_provision.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ ODLS PROVİZYON — provisionOdls + calibrateQForSteps ══\n");
  console.log(`  (A) SMF 9-adım:        ${t(out.smf9.holdUs, 0)} μs · ${t(out.smf9.totalLossDb, 2)} dB · %${t(out.smf9.survivalPct)} · ${out.smf9.boundBy}`);
  console.log(`  (B) hollow-core 5-adım: ${t(out.hollow5.holdUs, 0)} μs · ${t(out.hollow5.totalLossDb, 2)} dB · %${t(out.hollow5.survivalPct)} ✓`);
  console.log(`  (C) Si₃N₄ 5-adım:       ${t(out.si3n4_5.totalLossDb, 0)} dB · fizibil ${out.si3n4_5.feasible ? "EVET" : "HAYIR ✗"} (taban ×386)`);
  console.log(`  (D) calibrateQ(5):      q=${out.calibrate5.recommendedQ} → ${out.calibrate5.achievedSteps} adım · bedel %${t(out.calibrate5.steadyDropPct, 2)} · ölçülü`);
  console.log(`  (E) calibrateQ(1):      model tabanı altı → ${out.calibrate1.feasible ? "?" : "uyardı ✓"}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "odls_provision.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
