#!/usr/bin/env node
"use strict";
/**
 * timing_coincidence_test.js — FAZ 2 zamanlama/koinsidans motoru tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * L5.5 (Kalman saat kurtarma) + L5.6 (ODLS) kontrol fikirlerini Faz 1
 * acquisition hattına bağlar ve saat-kayması problemine karşı sınar.
 *   (A) MÜKEMMEL SAAT: taban QBER/verim (Faz 1 ile birebir).
 *   (B) DÜZELTMESİZ DRIFT: kayma birikince yuvalar kayar → QBER FIRLAR
 *       (casus gibi görünür) + verim çöker. Yanlış-tanı tuzağı.
 *   (C) KALMAN SAAT KURTARMA (L5.5): ön-beslemeli düzeltme → QBER fizik
 *       tabanına döner, verim geri gelir. Drift'i saldırıdan AYIRIR.
 *   (D) ODLS GEÇİŞ KÖPRÜSÜ (L5.6): ani saat sıçraması → toparlanma geçişi
 *       ODLS bütçesinde köprülenir → geçiş kaybı → 0.
 *   (E) CASUS MASKELENMEZ: saat kurtarma AÇIKKEN gerçek casus → QBER hâlâ
 *       > eşik → yakalanır (güvenlik korunur).
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const E = require("./timing_coincidence_engine.js");
const B = require("./timetag_acquisition_bridge.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const PULSES = 120000, W = 300, ABORT = 11;
const BASE = { pulses: PULSES, periodPs: 1000, efficiency: 0.12, jitterPs: 80, eDetect: 0.01, darkProb: 5e-4, physSeed: 3 };
const pct = x => +(x * 100).toFixed(2);

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) MÜKEMMEL SAAT ══
  const off0 = E.makeOffset({});
  const a0 = E.acquireWithClock({ ...BASE, qrng: B.seededQrng(7), offset: off0 });
  const f0 = E.siftFixed(a0, W);
  out.clean = { qber: pct(f0.qber), siftYield: pct(f0.siftYield), sifted: f0.sifted };
  chk("(A) MÜKEMMEL SAAT: taban QBER fizik zemininde, verim tam (Faz 1 birebir)",
    f0.qber < 0.02 && f0.siftYield > 0.04,
    `drift yok · QBER %${pct(f0.qber)} · verim %${pct(f0.siftYield)} · ${f0.sifted} bit — acquisition tabanı`);

  // ══ (B) DÜZELTMESİZ DRIFT — casus gibi görünür ══
  const offD = E.makeOffset({ driftPerSlotPs: 0.008 });
  const aD = E.acquireWithClock({ ...BASE, qrng: B.seededQrng(7), offset: offD });
  const fD = E.siftFixed(aD, W);
  out.driftNaive = { qber: pct(fD.qber), siftYield: pct(fD.siftYield), offsetEndPs: Math.round(offD(PULSES)) };
  chk("(B) DÜZELTMESİZ DRIFT: yuvalar kayar → QBER fırlar (casus gibi) + verim çöker",
    fD.qber > 0.15 && fD.siftYield < f0.siftYield * 0.5,
    `saat kayması (son slot ${Math.round(offD(PULSES))} ps ≈ 1 periyot) → yuva kayması → QBER %${pct(f0.qber)}→%${pct(fD.qber)} ` +
    `(casus eşiği %${ABORT}'i aşıyor!), verim %${pct(f0.siftYield)}→%${pct(fD.siftYield)}. ` +
    `TUZAK: bir casus SANILABİLİR ama bu bir SENKRONİZASYON sorunu`);

  // ══ (C) KALMAN SAAT KURTARMA (L5.5) ══
  const rD = E.siftRecovered(aD, { windowPs: W, offset: offD, syncEverySlots: 200, syncNoisePs: 30, q: 5e-3 });
  out.driftRecovered = { qber: pct(rD.qber), siftYield: pct(rD.siftYield) };
  chk("(C) KALMAN SAAT KURTARMA (L5.5): ön-besleme QBER'i fizik tabanına indirir, verimi geri getirir",
    rD.qber < 0.02 && rD.siftYield > f0.siftYield * 0.9,
    `aynı drift, Kalman saat disiplini AÇIK → QBER %${pct(fD.qber)}→%${pct(rD.qber)} (taban), ` +
    `verim %${pct(fD.siftYield)}→%${pct(rD.siftYield)} (geri geldi). ` +
    `Yüksek QBER'in DRIFT olduğu (casus değil) kanıtlandı — kayma artefaktı silindi`);

  // ══ (D) ODLS GEÇİŞ KÖPRÜSÜ (L5.6) — ani saat sıçraması ══
  const offJ = E.makeOffset({ driftPerSlotPs: 0.002, jumpPs: 500, jumpAtSlot: 60000 });
  const aJ = E.acquireWithClock({ ...BASE, qrng: B.seededQrng(7), offset: offJ });
  const rJ = E.siftRecovered(aJ, { windowPs: W, offset: offJ, syncEverySlots: 200, syncNoisePs: 30, q: 5e-3 });
  const br = E.bridgeClockJump(aJ, rJ.recoverySlots, { windowPs: W, mediumKey: "smf" });
  out.jump = { recoverySlots: rJ.recoverySlots, qber: pct(rJ.qber), ...br };
  chk("(D) ODLS GEÇİŞ KÖPRÜSÜ (L5.6): ani saat sıçraması toparlanma geçişi bütçede köprülenir → kayıp 0",
    br.odlsFeasible && br.withOdlsTimeoutDrops === 0 && br.withOdlsDelivered > br.withoutOdlsDropped * 0.8 &&
    rJ.qber < 0.02,
    `t=60000'de ${offJ.jumpPs} ps ani saat sıçraması (resync/reroute) → Kalman ${rJ.recoverySlots} slotta toparladı ` +
    `(${br.holdUs} μs tutma). Geçiş tıklamaları: ODLS'siz ${br.withoutOdlsDropped} düşer; ODLS ile ` +
    `${br.holdUs} μs << 73 μs bütçe (kayıp ${br.odlsLossDb} dB, sağkalım %${br.odlsSurvivalPct}) → ` +
    `${br.withOdlsDelivered} teslim, zaman-aşımı 0. Genel QBER %${pct(rJ.qber)} (taban)`);

  // ══ (E) CASUS MASKELENMEZ — kurtarma AÇIKKEN gerçek casus ══
  const aE = E.acquireWithClock({ ...BASE, qrng: B.seededQrng(7), offset: offD, eavesdrop: true });
  const rE = E.siftRecovered(aE, { windowPs: W, offset: offD, syncEverySlots: 200, syncNoisePs: 30, q: 5e-3 });
  out.eveRecovered = { qber: pct(rE.qber), thresholdPct: ABORT, secure: rE.qber < ABORT / 100 };
  chk("(E) CASUS MASKELENMEZ: saat kurtarma AÇIKKEN gerçek casus → QBER hâlâ > eşik → yakalanır",
    rE.qber > 0.20 && rE.qber > ABORT / 100,
    `drift + GERÇEK intercept-resend casusu, Kalman kurtarma AÇIK → QBER %${pct(rE.qber)} (hâlâ ~%25). ` +
    `Kalman yalnız ÖNGÖRÜLEBİLİR zaman yapısını (drift) siler; casusun rastgele-baz hatası öngörülebilir ` +
    `DEĞİL → silinemez → %${ABORT} eşiği aşılır, casus YAKALANIR. Kurtarma güvenliği MASKELEMİYOR`);

  // ── Grafik izleri ──
  const down = (fn, n = 100) => { const o = []; for (let i = 0; i < n; i++) o.push(+fn(Math.floor(i * PULSES / n)).toFixed(1)); return o; };
  out.offsetTrace = { trueJump: down(offJ), estJump: Array.from({ length: 100 }, (_, i) => +(rJ.est[Math.floor(i * PULSES / 100)] || 0).toFixed(1)),
    jumpAtSlot: offJ.jumpAtSlot, windowPs: W, nPoints: 100, pulses: PULSES };
  out.summary = [
    { cond: "mükemmel saat", qber: out.clean.qber, yield: out.clean.siftYield, secure: true },
    { cond: "düzeltmesiz drift", qber: out.driftNaive.qber, yield: out.driftNaive.siftYield, secure: false },
    { cond: "Kalman kurtarma (L5.5)", qber: out.driftRecovered.qber, yield: out.driftRecovered.siftYield, secure: true },
    { cond: "kurtarma + gerçek casus", qber: out.eveRecovered.qber, yield: null, secure: false },
  ];

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — L5.5+L5.6 acquisition'a bağlandı, çekirdek sabit`);

  out.params = { pulses: PULSES, windowPs: W, abortPct: ABORT };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "timing_coincidence.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ FAZ 2 — ZAMANLAMA & KOİNSİDANS MOTORU (L5.5 + L5.6) ══\n");
  console.log("  koşul                        QBER%    verim%   güvenli");
  for (const r of out.summary)
    console.log(`   ${pad(r.cond, 26)} ${pad("%" + t(r.qber, 2), 8)} ${pad(r.yield != null ? "%" + t(r.yield, 2) : "—", 8)}   ${r.secure ? "✓" : "✗"}`);
  console.log(`\n  (D) ODLS geçiş köprüsü: sıçrama → ${t(out.jump.recoverySlots)} slot toparlanma (${t(out.jump.holdUs, 2)} μs) · ` +
    `ODLS'siz ${t(out.jump.withoutOdlsDropped)} düşer → ODLS ile ${t(out.jump.withOdlsDelivered)} teslim (kayıp ${t(out.jump.odlsLossDb, 2)} dB, zaman-aşımı 0)`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "timing_coincidence.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
