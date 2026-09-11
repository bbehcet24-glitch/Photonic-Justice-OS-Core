#!/usr/bin/env node
"use strict";
/**
 * network_shielding_bridge_test.js — Üst ağ katmanı entegrasyonu tatbikatı:
 * EM kalkanlama durumunu ETSI GS QKD 014 mTLS el sıkışma ÖN-KOŞULUNA ve
 * koinsidans penceresi/jitter hizalama ÖNERİSİNE bağlar.
 * ═══════════════════════════════════════════════════════════════════
 * KAPSAM NOTU: bu, gerçek etsi014_kme_server.js sunucu sürecinin TLS kabul
 * mantığını DEĞİŞTİRMEZ (o dosyaya HİÇ dokunulmadı) — bağımsız, test
 * edilebilir bir ÖN-KOŞUL/tavsiye katmanıdır (bkz. network_shielding_bridge.js
 * başlığı). Gösterilen:
 *   (A) mTLS ÖN-KOŞULU — YENİ kafes: kalkanlama hedefi karşılanıyor →
 *       el sıkışmaya İZİN VERİLİR.
 *   (B) mTLS ÖN-KOŞULU — ESKİ kafes: hedef karşılanmıyor → fail-closed
 *       REDDEDİLİR (production_gate.js'in kriter-8/9 mantığıyla TUTARLI).
 *   (C) mTLS ÖN-KOŞULU — kafes değerlendirmesi YOK: reddedilir (varsayılan
 *       GÜVENSİZ kabul edilir, sessizce izin VERİLMEZ).
 *   (D) JİTTER HİZALAMA ÖNERİSİ: temiz kanal AYNI/DAHA DAR pencerede DAHA
 *       İYİ QBER veriyor — ODL zamanlama toleransı gevşer.
 *   (E) PRODUCTION_GATE ENTEGRASYONU: mTLS ön-koşulu, production_gate.js'in
 *       9. kriteri olarak state.faraday'dan OTOMATİK türetiliyor — mevcut
 *       hiçbir çağrı sitesi etkilenmiyor (state.faraday sağlanmazsa
 *       "hardware" varsayılanı KORUNUYOR, kriter-8 ile AYNI desen).
 *   + ÇEKİRDEK DOKUNULMADI.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const F = require("./faraday_cage_shielding.js");
const J = require("./network_shielding_bridge.js");
const RF = require("./rf_noise_bridge.js");
const G = require("./production_gate.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const OLD_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 5 };
const NEW_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 3, honeycombDepthMm: 9 };
const HARMONICS = [1, 2, 3, 5, 7, 9, 11, 13, 15, 19].map(n => n * 1e9);

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const evalNew = F.evaluateFaradayCage({ ...NEW_CAGE, freqRangeHz: HARMONICS, targetSeDb: 60 });
  const evalOld = F.evaluateFaradayCage({ ...OLD_CAGE, freqRangeHz: HARMONICS, targetSeDb: 60 });

  // ══ (A) mTLS — YENİ kafes ══
  const gateNew = J.mtlsHandshakePrecondition(evalNew);
  out.mtlsNew = gateNew;
  chk("(A) mTLS ÖN-KOŞULU (YENİ kafes): kalkanlama hedefi karşılanıyor → el sıkışmaya İZİN VERİLİR",
    gateNew.allowed === true, gateNew.reason);

  // ══ (B) mTLS — ESKİ kafes ══
  const gateOld = J.mtlsHandshakePrecondition(evalOld);
  out.mtlsOld = gateOld;
  chk("(B) mTLS ÖN-KOŞULU (ESKİ kafes): hedef karşılanmıyor → fail-closed REDDEDİLİR",
    gateOld.allowed === false, gateOld.reason);

  // ══ (C) mTLS — değerlendirme yok ══
  const gateNone = J.mtlsHandshakePrecondition(null);
  out.mtlsNone = gateNone;
  chk("(C) mTLS ÖN-KOŞULU (değerlendirme yok): varsayılan GÜVENSİZ — sessizce izin VERİLMEZ",
    gateNone.allowed === false, gateNone.reason);

  // ══ (D) JİTTER HİZALAMA ÖNERİSİ ══
  const rfOld = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: 80, cage: { ...OLD_CAGE, freqHz: 19e9 }, observerDistanceM: 0.3, noiseFloorDbuVm: 20 });
  const rfNew = RF.evaluateRfNoiseContribution({ sourceLevelDbuVm: 80, cage: { ...NEW_CAGE, freqHz: 19e9 }, observerDistanceM: 0.3, noiseFloorDbuVm: 20 });
  const rec = J.recommendJitterAlignment({ emDarkProbDirty: rfOld.rfDarkProb, emDarkProbClean: rfNew.rfDarkProb });
  out.jitterAlignment = rec;
  chk("(D) JİTTER HİZALAMA ÖNERİSİ: temiz kanal aynı/daha dar pencerede DAHA İYİ QBER veriyor",
    rec.clean.optimal.windowPs <= rec.dirty.optimal.windowPs && rec.clean.optimal.qberPct < rec.dirty.optimal.qberPct,
    rec.detail);

  // ══ (E) PRODUCTION_GATE ENTEGRASYONU ══
  const baseState = { macMissRatePct: 0, monitorActive: true, qrngFit: true, qrngHardware: false,
    secureKeyPositive: true, realQberPct: "2.78", eavesdropAborts: true, etsiConformant: true };
  const gateNoFaraday = G.productionGate(baseState); // faraday alanı YOK — mevcut davranış korunmalı
  const gateWithGoodCage = G.productionGate({ ...baseState, faraday: evalNew });
  const gateWithBadCage = G.productionGate({ ...baseState, faraday: evalOld });
  const mtlsCritNo = gateNoFaraday.criteria.find(c => c.name.includes("mTLS"));
  const mtlsCritGood = gateWithGoodCage.criteria.find(c => c.name.includes("mTLS"));
  const mtlsCritBad = gateWithBadCage.criteria.find(c => c.name.includes("mTLS"));
  out.productionGateIntegration = {
    noFaraday: { status: mtlsCritNo && mtlsCritNo.status, overallPass: gateNoFaraday.pass },
    goodCage: { status: mtlsCritGood && mtlsCritGood.status, overallPass: gateWithGoodCage.pass },
    badCage: { status: mtlsCritBad && mtlsCritBad.status, overallPass: gateWithBadCage.pass },
  };
  chk("(E) PRODUCTION_GATE ENTEGRASYONU: state.faraday yokken 'hardware' (mevcut davranış korunuyor), iyi/kötü kafesle pass/fail otomatik türetiliyor",
    mtlsCritNo && mtlsCritNo.status === "hardware" && mtlsCritGood && mtlsCritGood.status === "pass" && gateWithGoodCage.pass &&
    mtlsCritBad && mtlsCritBad.status === "fail" && !gateWithBadCage.pass,
    `state.faraday YOK → mTLS kriteri "${mtlsCritNo && mtlsCritNo.status}" (mevcut çağrı siteleri ETKİLENMEDİ). ` +
    `state.faraday=İYİ kafes → "${mtlsCritGood && mtlsCritGood.status}", genel kapı pass=${gateWithGoodCage.pass}. ` +
    `state.faraday=KÖTÜ kafes → "${mtlsCritBad && mtlsCritBad.status}", genel kapı pass=${gateWithBadCage.pass} (fail-closed BLOKLUYOR)`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "network_shielding_bridge.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ Ağ katmanı köprüsü — mTLS ön-koşulu + jitter hizalama ══\n");
  console.log(`  (A) mTLS/YENİ: allowed=${out.mtlsNew.allowed}`);
  console.log(`  (B) mTLS/ESKİ: allowed=${out.mtlsOld.allowed}`);
  console.log(`  (C) mTLS/yok: allowed=${out.mtlsNone.allowed}`);
  console.log(`  (D) jitter: kirli ${out.jitterAlignment.dirty.optimal.windowPs}ps/%${out.jitterAlignment.dirty.optimal.qberPct} → temiz ${out.jitterAlignment.clean.optimal.windowPs}ps/%${out.jitterAlignment.clean.optimal.qberPct}`);
  console.log(`  (E) gate: faraday-yok=${out.productionGateIntegration.noFaraday.status} · iyi-kafes=${out.productionGateIntegration.goodCage.status}/pass=${out.productionGateIntegration.goodCage.overallPass} · kötü-kafes=${out.productionGateIntegration.badCage.status}/pass=${out.productionGateIntegration.badCage.overallPass}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "network_shielding_bridge.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
