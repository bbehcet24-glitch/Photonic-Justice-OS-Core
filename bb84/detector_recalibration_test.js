#!/usr/bin/env node
"use strict";
/**
 * detector_recalibration_test.js — FAZ 3 gerçek-gürültü rekalibrasyonu
 * ═══════════════════════════════════════════════════════════════════
 * Emülatörün idealize gürültü modeline gerçek dedektör kusurları
 * (afterpulsing + verim uyumsuzluğu) eklenip güvenlik kararı yeniden
 * oturtulur. Gösterilen:
 *   (A) İDEAL vs GERÇEK QBER: gerçek kusurlar QBER'i ideal tahminin
 *       ÜSTÜNE çıkarır — idealize kalibrasyon İYİMSERDİ.
 *   (B) KUSUR AYRIŞTIRMASI: QBER = hizasızlık + karanlık + afterpulsing;
 *       afterpulsing baskın; verim uyumsuzluğu QBER'e ~0 katkı.
 *   (C) SONLU-ANAHTAR REKALİBRASYONU: gerçek QBER çekirdek kanıta beslenince
 *       güvenli-anahtar oranı (ℓ/n) DÜŞER — marj yeniden oturur.
 *   (D) VERİM UYUMSUZLUĞU = ANAHTAR YANLILIĞI + YAN KANAL: QBER'e katkısı
 *       ~0 ama anahtarı yanlı yapar ve QBER-sınırının GÖRMEDİĞİ bir yan
 *       kanal açar → ayrı gözlemlenebilir olarak İZLENMELİ.
 *   (E) REKALİBRE MARJ: güvenlik uçurumuna (ℓ→0) mesafe gerçek QBER'de
 *       ideal'den DAR — dürüst güvenlik payı daha küçük.
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./detector_recalibration.js");
const B = require("./timetag_acquisition_bridge.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const BASE = { pulses: 300000, periodPs: 1000, efficiency: 0.15, jitterPs: 80,
  eDetect: 0.01, darkProb: 1e-3, afterpulseProb: 0.03, detEff: [1, 0.8, 0.9, 0.75],
  windowPs: 300, qrng: B.seededQrng(7), physSeed: 3 };

/** Verim uyumsuzluğu altında dedektör-başına elenmiş tıklama sayımı (yan-kanal gözlemi). */
function perDetectorCounts(over) {
  const emu = new B.TimeTagEmulator({ ...BASE, eDetect: 0, darkProb: 0, ...over });
  const acq = emu.run();
  const co = B.coincidence(acq.events, acq.periodPs, BASE.windowPs);
  const counts = [0, 0, 0, 0];
  for (const [slot, dets] of co.slots) {
    if (slot < 0 || slot >= acq.pulses || dets.length !== 1) continue;
    if (B.basisOf(dets[0]) === acq.aliceBasis[slot]) counts[dets[0]]++;
  }
  return counts;
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const dec = R.qberByImperfection(BASE);
  out.decomposition = { misalignment: dec.misalignment, dark: dec.dark,
    afterpulse: dec.afterpulse, mismatch: dec.mismatch, idealQber: dec.idealQber, realQber: dec.realQber };

  // ══ (A) İDEAL vs GERÇEK QBER ══
  chk("(A) İDEAL vs GERÇEK: gerçek dedektör kusurları QBER'i ideal tahminin ÜSTÜNE çıkarır",
    dec.realQber > dec.idealQber * 1.6 && dec.realQber > dec.idealQber + 1,
    `idealize model QBER %${dec.idealQber} → gerçek dedektör (afterpulsing + verim uyumsuzluğu) QBER %${dec.realQber} ` +
    `(×${(dec.realQber / dec.idealQber).toFixed(1)}). İdealize kalibrasyon İYİMSERDİ — Faz 1/2'nin sayıları optimistik`);

  // ══ (B) KUSUR AYRIŞTIRMASI ══
  const sumParts = dec.misalignment + dec.dark + dec.afterpulse;
  chk("(B) KUSUR AYRIŞTIRMASI: QBER = hizasızlık + karanlık + afterpulsing (baskın); uyumsuzluk ~0",
    Math.abs(sumParts - dec.realQber) < 0.5 && dec.afterpulse > dec.misalignment * 0.9 && dec.mismatch < 0.2,
    `hizasızlık %${dec.misalignment} + karanlık %${dec.dark} + afterpulsing %${dec.afterpulse} ≈ gerçek %${dec.realQber}. ` +
    `Afterpulsing, hizasızlık kadar (hatta daha) BASKIN bir gerçek-dedektör katkısı; verim uyumsuzluğu QBER'e %${dec.mismatch} (~0)`);

  // ══ (C) SONLU-ANAHTAR REKALİBRASYONU ══
  const fk = R.recalibrateFiniteKey(dec.idealQber, dec.realQber, [1e4, 1e5, 1e6]);
  out.finiteKey = fk;
  const big = fk.find(r => r.n === 1e6);
  chk("(C) SONLU-ANAHTAR REKALİBRASYONU: gerçek QBER güvenli-anahtar oranını (ℓ/n) düşürür",
    fk.every(r => r.realCompR < r.idealCompR) && big.lossPts > 5 && big.realSecure,
    fk.map(r => `n=${r.n.toExponential(0)}: ℓ/n %${r.idealCompR}→%${r.realCompR}`).join(" · ") +
    ` — çekirdek sonlu-anahtar kanıtına gerçek QBER beslenince güvenli oran n=10⁶'da %${big.idealCompR}→%${big.realCompR} ` +
    `(−${big.lossPts} puan). Hâlâ güvenli ama marj küçüldü`);

  // ══ (D) VERİM UYUMSUZLUĞU = ANAHTAR YANLILIĞI + YAN KANAL ══
  const biasMM = R.keyBias(dec.mismatchRun.bits) * 100;
  const biasId = R.keyBias(dec.idealRun.bits) * 100;
  const cntMM = perDetectorCounts({ detEff: BASE.detEff });
  const cntEq = perDetectorCounts({ detEff: [1, 1, 1, 1] });
  const asym = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx ? +((mx - mn) / mx * 100).toFixed(1) : 0; };
  out.mismatch = { qberContribution: dec.mismatch, keyBiasPct: +biasMM.toFixed(1), idealBiasPct: +biasId.toFixed(1),
    detCountsMismatch: cntMM, detCountsEqual: cntEq, asymmetryPct: asym(cntMM), equalAsymmetryPct: asym(cntEq) };
  chk("(D) VERİM UYUMSUZLUĞU: QBER'e ~0 katkı AMA anahtar yanlılığı + dedektör asimetrisi (QBER-sınırı KÖR)",
    dec.mismatch < 0.2 && Math.abs(biasMM - 50) > 3 && asym(cntMM) > asym(cntEq) + 10,
    `verim uyumsuzluğu QBER'e %${dec.mismatch} (~0) ekliyor → sonlu-anahtar sınırı bunu GÖRMEZ. ` +
    `Ama elenmiş anahtar YANLI: bit-1 oranı %${biasMM.toFixed(1)} (ideal %${biasId.toFixed(1)}), ` +
    `dedektör algılama asimetrisi %${asym(cntMM)} (eşit dedektörde %${asym(cntEq)}). ` +
    `Bu bir YAN KANAL (verim-uyumsuzluğu/time-shift saldırısı) — rekalibrasyon bunu AYRI gözlemlenebilir olarak izlemeli`);

  // ══ (E) REKALİBRE MARJ ══
  const cliff = R.qberCliff(1e6);
  out.margin = { qberCliffPct: cliff, idealMarginPts: +(cliff - dec.idealQber).toFixed(2),
    realMarginPts: +(cliff - dec.realQber).toFixed(2) };
  chk("(E) REKALİBRE MARJ: güvenlik uçurumuna (ℓ→0) mesafe gerçek QBER'de daha DAR",
    (cliff - dec.realQber) < (cliff - dec.idealQber) && (cliff - dec.realQber) > 0,
    `güvenlik uçurumu (ℓ→0) QBER ≈ %${cliff} (n=10⁶). İdeal QBER'in marjı ${(cliff - dec.idealQber).toFixed(1)} puan; ` +
    `gerçek QBER'in marjı ${(cliff - dec.realQber).toFixed(1)} puan — dürüst güvenlik payı ` +
    `${((1 - (cliff - dec.realQber) / (cliff - dec.idealQber)) * 100).toFixed(0)}% daha küçük`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — yalnız QKDSecurityProof.secureKeyLength çağrıldı`);

  out.params = { pulses: BASE.pulses, afterpulseProb: BASE.afterpulseProb, detEff: BASE.detEff };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "detector_recalibration.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  const D = out.decomposition;
  console.log("\n══ FAZ 3 — GERÇEK-GÜRÜLTÜ REKALİBRASYONU ══\n");
  console.log(`  (A) İDEAL QBER %${t(D.idealQber, 2)} → GERÇEK QBER %${t(D.realQber, 2)} (×${t(D.realQber / D.idealQber, 1)}) — idealize iyimserdi`);
  console.log(`\n  (B) KUSUR AYRIŞTIRMASI:`);
  console.log(`       hizasızlık %${t(D.misalignment, 2)} · karanlık %${t(D.dark, 2)} · afterpulsing %${t(D.afterpulse, 2)} (baskın) · uyumsuzluk %${t(D.mismatch, 2)} (~0)`);
  console.log(`\n  (C) SONLU-ANAHTAR (ℓ/n):`);
  console.log("       n         ideal%    gerçek%   kayıp(puan)");
  for (const r of out.finiteKey) console.log(`     ${pad(r.n.toExponential(0), 8)} ${pad("%" + t(r.idealCompR, 1), 9)} ${pad("%" + t(r.realCompR, 1), 9)} ${pad("−" + t(r.lossPts, 1), 11)}`);
  console.log(`\n  (D) UYUMSUZLUK: QBER %${t(out.mismatch.qberContribution, 2)} (~0) · bit-1 %${t(out.mismatch.keyBiasPct, 1)} (ideal %${t(out.mismatch.idealBiasPct, 1)}) · dedektör asimetri %${t(out.mismatch.asymmetryPct, 1)} → YAN KANAL`);
  console.log(`  (E) MARJ: uçurum %${t(out.margin.qberCliffPct, 1)} · ideal marj ${t(out.margin.idealMarginPts, 1)} puan → gerçek marj ${t(out.margin.realMarginPts, 1)} puan`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "detector_recalibration.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
