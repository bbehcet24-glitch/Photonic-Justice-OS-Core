#!/usr/bin/env node
"use strict";
/**
 * hybrid_qkd_test.js — çekirdek v5: hibrit uydu + fiber anahtar oturumu ve QBER erken uyarı bandı (TS-HYBRID-QKD-04)
 * ═══════════════════════════════════════════════════════════════════
 *   Y1 Geçiş geometrisi: periyot, görünürlük ≥ 0,1 penceresi, Doppler büyüklüğü ve işareti
 *   Y2 Aşağı-bağlantı kaybı: 645 ve 1200 km eğik mesafede Micius'un bildirdiği aralıkla (yaklaşık 22–35 dB) kaba uyum,
 *      mesafeyle monoton artış
 *   Y3 Gece, tepe noktası: hibrit oturum (uydu + 3 fiber atlaması) teslim; 0. atlama serbest uzay; KEY_DELIVERED olayı
 *   Y4 Görünürlük < 0,1: SAT_NOT_VISIBLE iptali ilk turda, anahtar ve mesaj yok
 *   Y5 Gündüz: gökyüzü arka planı QBER'i %11'in üstüne çıkarır → HOP_QBER (0. atlama); uyarı bandı yükselir ama
 *      iptal eşiği %11 değişmez
 *   Y6 Dinleme yalnız uydu atlamasında ([0]): HOP_QBER 0. atlamada, gerekçe "uydu aşağı-bağlantısı"
 *   Y7 computeDynamicAlpha: DCR arttıkça bant genişler (SNSPD → InGaAs → 100×), abortAt her durumda %11;
 *      sabit α: 20 000 binom denemesinde yanlış uyarı oranı ≈ α
 *   Y8 Geriye uyum: hopChannels verilmeden ve tüm atlamalar açıkça fiber verilerek AYNI tohumlarla aynı sonuç
 *   + çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "Y1–Y8 SNSPD ile ölçüldü; Y7 InGaAs'ı açıkça seçer");
const core = require("./photonnet_core.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const pct = (x) => `%${(x * 100).toFixed(2)}`;
const pass = new core.LeoPassGeometry({ altitudeKm: 550, maxElevationDeg: 75 });
const ch = new core.SatelliteDownlinkChannel();
const env = { turbulenceStrength: 0.4, pointingPrecision: 0.7 };
const HYB_MAX = 16777216;

function hybrid({ passTimeS = 0, night = true, eve = false, fiberHops = 3, seed = 77, entropy = rb }) {
  const events = [];
  const hopChannels = [{ kind: "free-space", pass, passTimeS, env }, ...Array.from({ length: fiberHops }, () => ({ kind: "fiber", km: 60 }))];
  const s = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 60 * fiberHops, nHops: fiberHops + 1, evesdrop: eve ? [0] : false,
    hopChannels, detectorCtx: { isNight: night, freeSpace: false, detectorProfile: "snspd" }, entropyBits: entropy, publicSeed: seed,
    onEvent: (e) => events.push(e), opts: { maxPulses: HYB_MAX } });
  const r = s.run();
  return { r, events, h0: r.hopChecks[0] };
}

// ══ Y1 ══
{
  const win = pass.visibleWindowS();
  const edge = pass.state(-win.toS + 1), tca = pass.state(0);
  chk("Y1 Geçiş geometrisi: periyot ~95,5 dk, görünürlük ≥ 0,1 penceresi ±285 s, kenarda Doppler 20–25 ppm (yaklaşma +), TCA'da 0",
    Math.abs(pass.periodS / 60 - 95.5) < 0.2 && Math.abs(win.toS - 285) < 3 && edge.dopplerPpm > 20 && edge.dopplerPpm < 25 && Math.abs(tca.dopplerPpm) < 1e-9 && pass.state(100).dopplerPpm < 0,
    `periyot ${(pass.periodS / 60).toFixed(2)} dk, pencere ±${win.toS.toFixed(1)} s, kenar ${edge.dopplerPpm.toFixed(2)} ppm (yükselti ${edge.elevationDeg.toFixed(1)}°), Δλ ${edge.dopplerShiftPm.toFixed(1)} pm`);
}

// ══ Y2 ══
{
  // eğik mesafeyi 645 ve 1200 km yapan anlar (ikiye bölme)
  const tAt = (km) => { let lo = 0, hi = 280; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (pass.state(m).rangeKm < km) lo = m; else hi = m; } return (lo + hi) / 2; };
  const l645 = ch.link(pass.state(tAt(645)), env), l1200 = ch.link(pass.state(tAt(1200)), env), l0 = ch.link(pass.state(0), env);
  chk("Y2 Aşağı-bağlantı kaybı: 645 km ve 1200 km'de 20–40 dB (Micius ~22–35 dB ile kaba uyum), tepe noktası en düşük, mesafeyle artıyor",
    l645.lossDb > 20 && l645.lossDb < 40 && l1200.lossDb > 20 && l1200.lossDb < 40 && l0.lossDb < l645.lossDb && l645.lossDb < l1200.lossDb,
    `tepe (568 km) ${l0.lossDb.toFixed(1)} dB · 645 km ${l645.lossDb.toFixed(1)} dB · 1200 km ${l1200.lossDb.toFixed(1)} dB (geometrik ${(-10 * Math.log10(l1200.etaGeo)).toFixed(1)}, atmosfer ${(-10 * Math.log10(l1200.etaAtm)).toFixed(1)}, izleme ${(-10 * Math.log10(l1200.etaPoint)).toFixed(1)}, optik 3,0)`);
}

// ══ Y3 ══
{
  const { r, events, h0 } = hybrid({ passTimeS: 0 });
  chk("Y3 Gece, tepe noktası: hibrit oturum (uydu + 3×60 km fiber) teslim; 0. atlama serbest uzay; KEY_DELIVERED olayı",
    r.status === "DELIVERED" && h0.kind === "free-space" && h0.sat && h0.sat.visible && r.hopChecks.slice(1).every((h) => h.kind === "fiber") && events.some((e) => e.type === "KEY_DELIVERED"),
    `${r.status}, ℓ ${r.proof ? r.proof.ell : 0} bit, 0. atlama QBER ${pct(h0.qTest)} (kayıp ${h0.sat.lossDb.toFixed(1)} dB, yükselti ${h0.sat.elevationDeg.toFixed(1)}°), ${r.pulses.toLocaleString("tr-TR")} darbe/link; olaylar ${[...new Set(events.map((e) => e.type))].join(", ")}`);
}

// ══ Y4 ══
{
  const { r, events } = hybrid({ passTimeS: 400 });
  chk("Y4 Görünürlük < 0,1 (t = +400 s): SAT_NOT_VISIBLE ilk turda, anahtar ve mesaj yok",
    r.status === "ABORTED" && r.code === "SAT_NOT_VISIBLE" && r.rounds === 1 && !r.otpKeyBits && !r.cipherBits && events.some((e) => e.type === "SESSION_ABORTED"),
    r.reason);
}

// ══ Y5 ══
{
  const { r, h0 } = hybrid({ passTimeS: 0, night: false });
  chk("Y5 Gündüz: gökyüzü arka planı → HOP_QBER (0. atlama); beklenen QBER ve uyarı bandı yükseldi, iptal eşiği %11 değişmedi",
    r.code === "HOP_QBER" && r.lastCheck.hop === 0 && h0.expectedQ > 0.3 && core.SecureMessageSession.DEFAULTS.theoreticalQberLimit === 0.11,
    `0. atlama QBER ${pct(h0.qTest)}, beklenen ${pct(h0.expectedQ)}, uyarı bandı ${pct(h0.warnAt)} — iptal %11'de (bant iptali gevşetmez)`);
}

// ══ Y6 ══
{
  const { r, h0 } = hybrid({ passTimeS: 0, eve: true });
  chk("Y6 Dinleme yalnız uydu atlamasında: HOP_QBER 0. atlamada, gerekçe 'uydu aşağı-bağlantısı', fiber atlamaları dinlenmiyor",
    r.code === "HOP_QBER" && r.lastCheck.hop === 0 && /uydu aşağı-bağlantısı/.test(r.reason) && h0.eve === true && r.hopChecks.slice(1).every((h) => h.eve === false),
    `${pct(h0.qTest)} — ${r.reason.slice(0, 110)}`);
}

// ══ Y7 ══
{
  const pDet = 0.05, k = 850;
  const pS = core.activeDetectorProfile("snspd"), pI = core.activeDetectorProfile("ingaas");
  const yS = 1 - Math.exp(-pS.darkCountRateHz * pS.detectionWindowS), yI = pI.darkCountProbPerWindow;
  const bS = core.computeDynamicAlpha({ pDark: yS, pDet, k }), bI = core.computeDynamicAlpha({ pDark: yI, pDet: pDet * pI.efficiency / pS.efficiency, k }),
    bX = core.computeDynamicAlpha({ pDark: yI * 100, pDet: pDet * pI.efficiency / pS.efficiency, k });
  // sabit α: beklenen QBER'de binom örnekleme → yanlış uyarı oranı
  let fa = 0; const N = 20000; const rng = core.mulberry32(12345);
  for (let i = 0; i < N; i++) { let e = 0; for (let j = 0; j < k; j++) if (rng() < bI.expectedQ) e++; if (e / k > bI.warnAt) fa++; }
  chk("Y7 computeDynamicAlpha: DCR arttıkça bant genişliyor (SNSPD < InGaAs < 100× InGaAs), abortAt hep %11; tam binom kuantiliyle yanlış uyarı ≤ α (Monte Carlo payıyla 1,5α)",
    bS.warnAt < bI.warnAt && bI.warnAt < bX.warnAt && [bS, bI, bX].every((b) => b.abortAt === 0.11) && fa / N <= 1.5 * bI.alpha,
    `bant SNSPD ${pct(bS.warnAt)} (beklenen ${pct(bS.expectedQ)}) · InGaAs ${pct(bI.warnAt)} (${pct(bI.expectedQ)}) · 100× ${pct(bX.warnAt)} (${pct(bX.expectedQ)}); ` +
    `yanlış uyarı ${fa}/${N} = ${(fa / N).toExponential(1)} (α = ${bI.alpha}; ayrık binomda tam kuantil α'nın altında kalır)`);
}

// ══ Y8 ══
{
  const seeded = (s) => { const g = core.mulberry32(s); return (n) => Array.from({ length: n }, () => (g() < 0.5 ? 0 : 1)); };
  const base = { msg: "Merhaba Dünya", totalKm: 180, nHops: 3, evesdrop: false, detectorCtx: { isNight: true, freeSpace: false, detectorProfile: "snspd" }, publicSeed: 99 };
  const a = new core.SecureMessageSession({ ...base, entropyBits: seeded(5) }).run();
  const b = new core.SecureMessageSession({ ...base, entropyBits: seeded(5), hopChannels: [0, 1, 2].map(() => ({ kind: "fiber", km: 60 })) }).run();
  chk("Y8 Geriye uyum: hopChannels yokken ve açık fiber atlamalarıyla aynı tohumlarda birebir aynı sonuç (v4.4 davranışı korunuyor)",
    a.status === b.status && a.pulses === b.pulses && JSON.stringify(a.otpKeyBits) === JSON.stringify(b.otpKeyBits) && a.qTest === b.qTest,
    `${a.status}/${b.status}, darbe ${a.pulses}/${b.pulses}, QBER ${pct(a.qTest)}/${pct(b.qTest)}, OTP anahtarı ${JSON.stringify(a.otpKeyBits) === JSON.stringify(b.otpKeyBits) ? "aynı" : "FARKLI"}`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı", changelog.includes(coreSha), coreSha.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "reports", "hybrid_qkd.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
