#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * ell_audit.js — ℓ denetim tablosu (hakem bulguları P0-1, P0-2, P0-4, P1-1).
 *
 * Her senaryo için sonlu-anahtar formülünün tüm terimleri sayı olarak yazılır:
 *   ℓ = ⌊ n·(1 − h(Q + μ)) − leak_EC − log₂(2/ε_cor) − 2·log₂(1/(2·ε_PA)) ⌋,  μ = Serfling(n, k, ε_PE) — durdurmalı satırlarda ε_PE / M (M = maxPeEvaluations), kapasite satırlarında tek değerlendirme
 * İki ölçü ayrılır:
 *   • "stop" (durdurmalı ℓ): SecureMessageSession bir atlamada ℓ ≥ mesaj biti olur olmaz toplamayı DURDURUR (anahtar isteğe
 *     göre üretilir). Bu bir bağlantı kalitesi ölçüsü DEĞİLDİR; mesaj uzunluğuna ve ilk denetim eşiğine bağlıdır.
 *   • "capacity" (kapasite ℓ): aynı atlama sabit bir darbe bütçesinin TAMAMINI kullanır (durdurma yok) — bağlantı ölçüsü budur.
 * Kanal: oturumun kendi deriveSiftedKey'i; PE alt kümesi, Cascade ve formül çekirdeğin kendi fonksiyonları.
 *
 * Kullanım: node bb84/tools/ell_audit.js   → bb84/reports/ell_audit.json + docs/ELL_AUDIT.md
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const core = require(path.join(ROOT, "bb84", "photonnet_core.js"));
const { SecureMessageSession: S, QKDSecurityProof: P, CascadeReconciliation: C } = core;
const D = S.DEFAULTS;
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const MSG = "Merhaba Dünya";
const ctx = (night = true, extra = {}) => ({ isNight: night, freeSpace: false, detectorProfile: "snspd", ...extra });
core.setActiveDetectorProfile("snspd");

/** Formülün terimleri — çekirdeğin kendi fonksiyonlarıyla (μ ve ℓ), ayrıca toplamın ℓ'yi verdiği denetlenir. */
function terms({ n, k, q, leakEC, eps, epsPEUsed }) {
  const mu = P.statisticalFluctuation2(n, k, epsPEUsed ?? eps.epsPE);
  const qPh = Math.min(0.5, q + mu);
  const main = n * (1 - P.h2(qPh)), cor = Math.log2(2 / eps.epsCor), pa = 2 * Math.log2(1 / (2 * eps.epsPA));
  const r = P.secureKeyLengthWithMu(n, q, mu, { epsCor: eps.epsCor, epsPA: eps.epsPA, fEC: D.fEC, realLeakEC: leakEC });
  return { n, k, qTest: q, epsPEUsed: epsPEUsed ?? eps.epsPE, mu, qPhUpper: qPh, main, leakEC, corTerm: cor, paTerm: pa, ellRaw: main - leakEC - cor - pa, ell: r.ell };
}

/** Durdurmalı ℓ: SecureMessageSession'ın bulduğu atlama kontrolü (ve kullandığı ε'lar). */
function stopRun({ label, totalKm, nHops = 1, hopChannels, night = true, maxPulses }) {
  const s = new S({ msg: MSG, totalKm, nHops, evesdrop: false, detectorCtx: ctx(night), entropyBits: rb, publicSeed: 1,
    hopChannels, opts: maxPulses ? { maxPulses } : undefined });
  const r = s.run();
  const hops = (r.hopChecks || []).filter((h) => Number.isFinite(h.ell) || Number.isFinite(h.ellEstimate));
  const weakest = hops.reduce((w, h) => (w == null || (h.ell ?? h.ellEstimate) < (w.ell ?? w.ellEstimate) ? h : w), null);
  const eps = s.hopEps ? s.hopEps : { epsPE: D.epsPE, epsPA: D.epsPA, epsCor: D.epsCor };
  const epsPEUsed = r.epsTotal ? r.epsTotal.epsPEPerEvaluation : eps.epsPE;
  return { label, mode: "stop", status: r.status, code: r.code, pulsesPerLink: r.pulses, needBits: r.needBits, nHops: r.nHops,
    epsTotal: r.epsTotal || null, eps, hop: weakest ? { hop: weakest.hop, kind: weakest.kind, ...terms({ n: weakest.n, k: weakest.k, q: weakest.qTest, leakEC: weakest.leakEC ?? 0, eps, epsPEUsed }), coreEll: weakest.ell, evals: weakest.evals } : null };
}

/** Kapasite ℓ: tek atlama, sabit darbe bütçesinin tamamı; PE + Cascade + formül. */
function capacityRun({ label, km, pulses, channelEta = null, night = true }) {
  const qkd = new core.QuantumKeyDistribution(0x5eed);
  const chan = core.mulberry32(crypto.randomBytes(4).readUInt32BE(0));
  const A = [], B = [];
  let sent = 0;
  const c = channelEta != null ? ctx(night, { freeSpace: true, channelEta }) : ctx(night);
  while (sent < pulses) {
    const m = Math.min(D.roundPulses, pulses - sent);
    const r = qkd.deriveSiftedKey(rb(m), km, false, chan, c);
    for (let i = 0; i < r.siftedKeyBits.length; i++) { A.push(r.siftedKeyBits[i]); B.push(r.bobKeyBits[i]); }
    sent += m;
  }
  const N = A.length, k = Math.max(D.minTestBits, Math.round(D.testFraction * N));
  if (N <= k + 1) return { label, mode: "capacity", pulses, sifted: N, hop: null, note: "PE için yetersiz elenmiş bit" };
  const test = core._sampleSubset(N, k, rb), isT = new Uint8Array(N); for (const i of test) isT[i] = 1;
  let e = 0; for (const i of test) if (A[i] !== B[i]) e++;
  const q = e / k, a = [], b = [];
  for (let i = 0; i < N; i++) if (!isT[i]) { a.push(A[i]); b.push(B[i]); }
  const casc = C.reconcile(a, b, Math.max(q, 0.005), core.mulberry32(7));
  const eps = { epsPE: D.epsPE, epsPA: D.epsPA, epsCor: D.epsCor };
  return { label, mode: "capacity", pulses, sourceSeconds: pulses / D.pulseRateHz, sifted: N, cascadeConverged: casc.converged,
    hop: { ...terms({ n: a.length, k, q, leakEC: casc.leakedBits, eps }),
      coreEll: P.secureKeyLengthWithMu(a.length, q, P.statisticalFluctuation2(a.length, k, eps.epsPE), { epsCor: eps.epsCor, epsPA: eps.epsPA, fEC: D.fEC, realLeakEC: casc.leakedBits }).ell } };
}

const pass = new core.LeoPassGeometry({ altitudeKm: 550, maxElevationDeg: 75 });
const sat = (t) => [{ kind: "free-space", pass, passTimeS: t, env: { turbulenceStrength: 0.4, pointingPrecision: 0.7 } }];
const satEta = (t) => new core.SatelliteDownlinkChannel().link(pass.state(t), { turbulenceStrength: 0.4, pointingPrecision: 0.7 }).eta;

const t0 = Date.now();
const rows = [
  stopRun({ label: "60 km fiber, single hop", totalKm: 60 }),
  capacityRun({ label: "60 km fiber, single hop", km: 60, pulses: D.maxPulses }),
  stopRun({ label: "Satellite zenith (t = 0), single hop", totalKm: 0, nHops: 1, hopChannels: sat(0), maxPulses: 2 ** 24 }),
  capacityRun({ label: "Satellite zenith (t = 0), single hop", km: 0, pulses: 2 ** 24, channelEta: satEta(0) }),
  stopRun({ label: "Satellite t = −60 s, single hop", totalKm: 0, nHops: 1, hopChannels: sat(-60), maxPulses: 2 ** 24 }),
  capacityRun({ label: "Satellite t = −60 s, single hop", km: 0, pulses: 2 ** 24, channelEta: satEta(-60) }),
  stopRun({ label: "147 km fiber (Zagreb → Ljubljana)", totalKm: 147 }),
  capacityRun({ label: "147 km fiber (Zagreb → Ljubljana)", km: 147, pulses: D.maxPulses }),
  stopRun({ label: "Istanbul → Baghdad, 31 × 59.4 km", totalKm: 1842, nHops: 31 }),
];
const out = { generatedAt: new Date().toISOString(), coreSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "bb84", "photonnet_core.js"))).digest("hex"),
  message: { text: MSG, bits: core.t2b(MSG).length }, defaults: { roundPulses: D.roundPulses, maxPulses: D.maxPulses, pulseRateHz: D.pulseRateHz, firstCheckSifted: D.firstCheckSifted,
    testFraction: D.testFraction, minTestBits: D.minTestBits, epsPE: D.epsPE, epsPA: D.epsPA, epsCor: D.epsCor, fEC: D.fEC }, rows, elapsedS: (Date.now() - t0) / 1000 };
// tutarlılık: formül terimlerinin toplamı çekirdeğin ℓ'sini veriyor mu (⌊·⌋ ve 0 tabanı dahil)
// stop satırlarında çekirdeğin oturum içinde hesapladığı ℓ (hopChecks.ell), kapasite satırlarında secureKeyLengthWithMu
out.consistent = rows.filter((r) => r.hop).every((r) => r.hop.ell === Math.max(0, Math.floor(r.hop.ellRaw)) && (r.hop.coreEll == null || r.hop.coreEll === r.hop.ell));
fs.writeFileSync(path.join(ROOT, "bb84", "reports", "ell_audit.json"), JSON.stringify(out, null, 2));

const f = (x, d = 0) => (x == null ? "—" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
let md = `# ℓ audit (finite-key length, term by term)\n\nGenerated by \`node bb84/tools/ell_audit.js\` on ${out.generatedAt}, core SHA-256 \`${out.coreSha256.slice(0, 8)}…${out.coreSha256.slice(-6)}\`.\n` +
  `**Simulation figures:** channel model of this simulator, platform CSPRNG entropy; ℓ is not a certified security level.\n\n` +
  `Formula (core \`QKDSecurityProof.secureKeyLengthWithMu\`): ℓ = ⌊ n·(1 − h(Q + μ)) − leak_EC − log₂(2/ε_cor) − 2·log₂(1/(2ε_PA)) ⌋, ` +
  `μ = √((n+k)(k+1)·ln(1/ε_PE) / (n·k²)) (Serfling, two-parameter). The bit error rate Q is measured on the k test bits; the phase error ` +
  `is bounded by Q + μ, so the security decision already uses an upper confidence bound.\n\n` +
  `Two measures: **stop** = \`SecureMessageSession\` stops collecting on a hop as soon as ℓ ≥ message bits (${out.message.bits} bits for "${MSG}"), ` +
  `so its ℓ follows the message, not the link. **capacity** = the same hop uses its whole pulse budget with no stop; this is the link measure. ` +
  `Source rate ${f(D.pulseRateHz / 1e6)} MHz; fiber budget ${f(D.maxPulses)} pulses per link, satellite budget ${f(2 ** 24)}.\n\n` +
  `| Scenario | Measure | Result | Pulses | n (key) | k (test) | Q_test | μ | n·(1−h(Q+μ)) | leak_EC | ε terms | ℓ |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  const h = r.hop;
  md += `| ${r.label} | ${r.mode} | ${r.mode === "capacity" ? (h ? (h.ell > 0 ? "key" : "ℓ = 0") : "too few bits") : `${r.status}${r.code && r.code !== "OK" ? ` ${r.code}` : ""}`} | ${f(r.pulsesPerLink ?? r.pulses)} | ${h ? f(h.n) : f(r.sifted)} | ${h ? f(h.k) : "—"} | ${h ? (h.qTest * 100).toFixed(2) + " %" : "—"} | ${h ? h.mu.toFixed(4) : "—"} | ${h ? f(h.main) : "—"} | ${h ? f(h.leakEC) : "—"} | ${h ? f(h.corTerm + h.paTerm) : "—"} | ${h ? f(h.ell) : "—"} |\n`;
}
const stopEps = rows.filter((r) => r.epsTotal).sort((a, b) => b.epsTotal.nHops - a.epsTotal.nHops)[0];
md += `\nThe stop rows report the weakest hop at the moment collection stopped, not a property of the link. ` +
  `Stop rows: per-hop ε = target / nHops (ε_PE ${rows[0].eps.epsPE}, ε_PA ${rows[0].eps.epsPA}, ε_cor ${rows[0].eps.epsCor} for one hop), and μ uses ε_PE / M with ` +
  `M = ${D.maxPeEvaluations} because a hop that falls short is re-tested (union bound over evaluations). Capacity rows: one evaluation, μ uses the full ε_PE. ` +
  `${stopEps ? `For the ${stopEps.epsTotal.nHops}-hop route ε_e2e ≤ ${stopEps.epsTotal.endToEnd.toExponential(2)} (per hop ${stopEps.epsTotal.perHop.sum.toExponential(2)}). ` : ""}` +
  `ℓ is an upper bound on the extractable secret length under this simulator's channel model; it is not a certified security level. ` +
  `Terms sum to the core's ℓ in every row: ${out.consistent}.\n\n`;
const prof = core.activeDetectorProfile ? core.activeDetectorProfile("snspd") : null;
md += `## Parameters\n\n*Simulation inputs. "Assumption" means chosen, not measured on hardware.*\n\n| Parameter | Value | Where | Status |\n|---|---|---|---|\n` +
  `| Source | ideal single-photon BB84, no multi-photon pulses, no decoy states | \`QuantumKeyDistribution.deriveSiftedKey\` | simplification |\n` +
  `| Wavelength | 1550 nm | \`propPhoton\` | assumption |\n` +
  `| Fiber loss | ≈ 0.20–0.21 dB/km (measured from the model: 0.203 at 25 km, 0.209 at 100 km) | \`propPhoton\` | assumption |\n` +
  `| Misalignment error e_d | ${core.QKD_MISALIGNMENT_E_D ?? 0.015} | \`QKD_MISALIGNMENT_E_D\` | assumption |\n` +
  `| Detector efficiency | ${prof ? prof.efficiency : 0.8} | config.json \`snspd\` | assumption (ID Quantique ID281 range) |\n` +
  `| Dark count rate | ${prof ? prof.darkCountRateHz : 50} Hz, window ${prof ? prof.detectionWindowS : 1.25e-8} s | config.json \`snspd\` | assumption |\n` +
  `| Night sky background (free space) | 200 Hz (day 5 MHz) | \`NIGHTTIME_BACKGROUND_RATE_HZ\` | assumption |\n` +
  `| Satellite beam | half-angle 15 µrad (1/e² radius), 1 m receiver, T_zenith 0.8, optics 0.5 | \`SatelliteDownlinkChannel\` | assumption |\n` +
  `| Source rate | ${f(D.pulseRateHz / 1e6)} MHz | \`SAT_PULSE_RATE_HZ\` | assumption |\n` +
  `| Round / budget | ${f(D.roundPulses)} pulses per round, ${f(D.maxPulses)} per fiber link, ${f(2 ** 24)} per satellite pass | \`SecureMessageSession.DEFAULTS\` | simulation budget |\n` +
  `| First check / test fraction / min k | ${f(D.firstCheckSifted)} sifted bits, ${D.testFraction}, k ≥ ${D.minTestBits} | \`SecureMessageSession.DEFAULTS\` | engineering choice |\n` +
  `| ε target (end to end) | ε_PE ${D.epsPE}, ε_PA ${D.epsPA}, ε_cor ${D.epsCor}; split across hops; M = ${D.maxPeEvaluations} evaluations per hop | \`SecureMessageSession.DEFAULTS\` | choice |\n` +
  `| Error correction | Cascade, leak counted from the parity bits actually disclosed (f_EC ${D.fEC} only if no count) | \`CascadeReconciliation\` | implemented |\n` +
  `| Privacy amplification | Toeplitz, seed n+ℓ−1 bits from entropy | \`QKDSecurityProof.toeplitzHash\` | implemented |\n`;
fs.writeFileSync(path.join(ROOT, "docs", "ELL_AUDIT.md"), md);
console.log(md);
console.log(`(${out.elapsedS.toFixed(1)} s)`);
process.exit(out.consistent ? 0 : 1);
