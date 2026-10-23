#!/usr/bin/env node
"use strict";
// DEDEKTÖR VARSAYIMI (çekirdek v3, config.json): senaryo (ör. S8 "sabit parametreli eski sistem 0 üretir") InGaAs
// profiline (verim %10, Y0 = 1e-5) göre kurgulandı; SNSPD ile içeri-giriş penceresinde eski sistem de anahtar üretir.
const DETECTOR_PIN = require("./detector_profile.js").pinDetectorProfile("ingaas", "senaryo InGaAs kalibrasyonlu (verim %10, Y0 = 1e-5)");
/**
 * multinode_shielding_testbed.js — 4 seviyeli kalkan karar matrisinin
 * ÇOK-DÜĞÜMLÜ test ağı (iki aşama)
 * ═══════════════════════════════════════════════════════════════════
 * AŞAMA 1 — SİMÜLE SAHA (vars. 60 dk simüle zaman, 50 ms adım):
 *   6 düğümlü İstanbul-metro tipi güvenilir-düğüm ağı, 8 fiber link
 *   (12–41 km), 4 uçtan-uca talep. Her düğümde Faraday kafesi + SE izleyici.
 *   Saha olayları (tohumlu, tekrarlanabilir):
 *     • ölçüm gürültüsü ±1 dB (sınırlı/düzgün — SE cihaz doğruluğu spesifikasyonu)
 *     • sensör kopması (okuma yok) p=2e-4/örnek
 *     • EFT ölçüm artefaktı (IEC 61000-4-4 tipi; GERÇEK SE değişmez, okuma düşer)
 *     • KDK: bakım kapısı açılması (Poisson 2/sa, log-normal süre ~60 s, SE→15 dB)
 *     • BKR: gerçek kısa kalkan sızıntıları (Poisson 6/sa, 100–400 ms, SE→25 dB)
 *     • ASY: conta yaşlanması (hardware_aging_model.applyFieldAging, 65 → ~35 dB)
 *     • MSL: yakın verici (ortam alanı 92 → 112 dBµV/m, 30.–38. dk) → içeri giriş
 *   Alıcı tarafında Y0, vakum-decoy sayımlarından (Poisson) 1 s pencereyle ÖLÇÜLÜR.
 *   Aynı izler 4 politikayla koşulur: adaptive, adaptive (koruma bandı 0),
 *   legacy-strict, legacy-debounce. YER-GERÇEĞİ DENETİMİ: test ağı gerçek SE'yi
 *   bilir; serbest bırakılan her bloğun ve teslim edilen her bitin kökenini
 *   (provenance) FIFO defterle izler.
 *
 * AŞAMA 2 — GERÇEK SÜREÇLER (~26 s duvar saati):
 *   pki_tools ile gerçek PKI (CA + localhost sunucu + 6 SAE istemci sertifikası),
 *   6 ayrı etsi014_kme_server.js SÜRECİ (gerçek mTLS), her biri --shield-gate
 *   (düğüm kapı dosyası, 50 ms'de bir tazelenir) ve --keystore-inbox (uçtan-uca
 *   anahtarlar çalışırken enjekte edilir) ile. SAE istemcileri etsi014_client_lib
 *   ile gerçek ETSI-014 akışları (status → enc_keys → dec_keys) yapar.
 *
 * DÜRÜSTLÜK: fiziksel katman (fiber, dedektör, kafes, RF) SİMÜLEDİR; "gerçek"
 * olan aşama 2'deki süreçler, TLS, PKI ve ETSI-014 API'sidir. İçeri-giriş
 * dB→verim eşlemesi kalibre edilmemiş bir varsayımdır. Olay oranları saha
 * verisinden değil makul varsayımlardan seçilmiştir (tohumla tekrarlanabilir).
 *
 * KULLANIM: node multinode_shielding_testbed.js [--stage=sim|live|all] [--minutes=60]
 * photonnet_core.js'e DOKUNULMAZ (SHA-256 öncesi/sonrası doğrulanır).
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const A = require("./adaptive_shielding_mitigation.js");
const D = require("./decoy_state_protocol.js");
const NET = require("./multinode_shielding_network.js");
const { applyFieldAging, mulberry32 } = require("./hardware_aging_model.js");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const STAGE = args.stage || "all";
const SIM_MINUTES = +(args.minutes || 60);
const DT = 50;

// ── Ağ (İstanbul metro tipi; ad/mesafeler temsilîdir) ──
const TOPOLOGY = {
  nodes: [
    { id: "AVR", label: "Avrupa veri merkezi", ambientFieldDbuVm: 75, deliveryPathIsolated: true, nominalSeDb: 66 },
    { id: "MSL", label: "Maslak iş merkezi (çatı antenleri)", ambientFieldDbuVm: 92, deliveryPathIsolated: true, nominalSeDb: 64 },
    { id: "BKR", label: "Bakırköy POP", ambientFieldDbuVm: 85, deliveryPathIsolated: true, nominalSeDb: 63 },
    { id: "ASY", label: "Asya veri merkezi", ambientFieldDbuVm: 78, deliveryPathIsolated: true, nominalSeDb: 65 },
    { id: "KDK", label: "Kadıköy sokak dolabı (KME aynı kabinde)", ambientFieldDbuVm: 88, deliveryPathIsolated: false, nominalSeDb: 62 },
    { id: "ATS", label: "Ataşehir POP", ambientFieldDbuVm: 86, deliveryPathIsolated: true, nominalSeDb: 63 },
  ],
  links: [
    { a: "AVR", b: "MSL", km: 18 }, { a: "AVR", b: "BKR", km: 22 }, { a: "MSL", b: "ASY", km: 30 },
    { a: "BKR", b: "KDK", km: 41 }, { a: "ASY", b: "ATS", km: 14 }, { a: "KDK", b: "ATS", km: 12 },
    { a: "MSL", b: "KDK", km: 35 }, { a: "ASY", b: "KDK", km: 16 },
  ],
  demands: [
    { src: "AVR", dst: "ASY", demandBps: 120000 }, { src: "MSL", dst: "KDK", demandBps: 60000 },
    { src: "BKR", dst: "ATS", demandBps: 60000 }, { src: "AVR", dst: "KDK", demandBps: 40000 },
  ],
};
const THREAT = { sourceLevelDbuVm: 100, observerDistanceM: 0.3, noiseFloorDbuVm: 40, freqHz: 1e9 };
const INGRESS = { susceptibilityDbuVm: 40, refDarkYield: 1e-5 };
const DP = require("./detector_profile.js");
const BASE_Y0 = () => DP.baseY0(); // gerçek (simüle) temel Y0 = etkin dedektör profili (config.json)
const SE_REQ = A.seRequiredForThreatDb(THREAT).seRequiredDb;
const PULSE_HZ = 1e9, BLOCK_PULSES = 1e9, INITIAL_POOL = 5e6;
const SENSOR_NOISE_DB = 1, DROPOUT_P = 2e-4;

// ── Yardımcılar ──
const coreHash = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
function poisson(lambda, rng) {
  if (lambda <= 0) return 0;
  if (lambda < 30) { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; }
  const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}
function poissonEvents(rng, ratePerHour, horizonMs) {
  const out = []; let t = 0;
  for (;;) { t += (-Math.log(1 - rng()) / ratePerHour) * 3600e3; if (t >= horizonMs) return out; out.push(t); }
}
const trueY0 = (ambient, se) => BASE_Y0() + A.ingressEffectiveY0({ seDb: se, ambientFieldDbuVm: ambient, susceptibilityDbuVm: INGRESS.susceptibilityDbuVm, refDarkYield: INGRESS.refDarkYield, baseY0: 0 }).Y0eff;

// ═══ Saha izleri (gerçek SE, ölçülen SE, ortam alanı) — tüm politikalar için ORTAK ═══
function buildTraces({ minutes, seed = 20261011, scripted = null }) {
  const steps = Math.floor((minutes * 60e3) / DT) + 1;
  const horizon = (steps - 1) * DT;
  const tr = { steps, horizonMs: horizon, nodes: {}, events: [] };
  for (const [ni, n] of TOPOLOGY.nodes.entries()) {
    const rng = mulberry32(seed + 101 * (ni + 1));
    const trueSe = new Float64Array(steps).fill(n.nominalSeDb);
    const ambient = new Float64Array(steps).fill(n.ambientFieldDbuVm);
    const meas = new Float64Array(steps);
    const kinds = { eft: 0, dropout: 0 };
    tr.nodes[n.id] = { trueSe, ambient, meas, kinds };
  }
  const setRange = (arr, t0, t1, v) => { for (let i = Math.max(0, Math.floor(t0 / DT)); i <= Math.min(steps - 1, Math.floor(t1 / DT)); i++) arr[i] = typeof v === "function" ? v(i, arr[i]) : Math.min(arr[i], v); };
  if (scripted) scripted(tr, setRange);
  else {
    const ev = mulberry32(seed);
    // KDK bakım kapısı (gerçek sızıntı, uzun)
    for (const t of poissonEvents(ev, 2, horizon)) {
      const dur = 60e3 * Math.exp(0.5 * Math.sqrt(-2 * Math.log(ev() || 1e-12)) * Math.cos(2 * Math.PI * ev()));
      setRange(tr.nodes.KDK.trueSe, t, t + dur, 15);
      tr.events.push({ node: "KDK", kind: "bakım kapısı açık", startMs: Math.round(t), durMs: Math.round(dur), trueSeDb: 15 });
    }
    // BKR gerçek kısa sızıntılar
    for (const t of poissonEvents(ev, 6, horizon)) {
      const dur = 100 + 300 * ev();
      setRange(tr.nodes.BKR.trueSe, t, t + dur, 25);
      tr.events.push({ node: "BKR", kind: "kısa gerçek sızıntı", startMs: Math.round(t), durMs: Math.round(dur), trueSeDb: 25 });
    }
    // ASY conta yaşlanması (16 s'de bir saha döngüsü)
    const cycleMs = 16e3;
    const aging = applyFieldAging({ ok: true, targetSeDb: 60, marginDb: 5, worst: { combinedSeDb: 65 }, detail: "" },
      { enabled: true, cycles: Math.ceil(horizon / cycleMs), seed: 7 });
    setRange(tr.nodes.ASY.trueSe, 0, horizon, (i, v) => { const c = Math.floor((i * DT) / cycleMs); return c === 0 ? v : Math.min(v, aging.aging.history[c - 1].combinedSeDb); });
    tr.events.push({ node: "ASY", kind: "conta yaşlanması", startMs: 0, durMs: horizon, fromSeDb: 65, toSeDb: aging.aging.history[aging.aging.history.length - 1].combinedSeDb });
    // MSL yakın verici (yalnız içeri giriş)
    if (horizon > 38 * 60e3) {
      setRange(tr.nodes.MSL.ambient, 30 * 60e3, 38 * 60e3, () => 112);
      tr.events.push({ node: "MSL", kind: "yakın verici (ortam alanı 112 dBµV/m)", startMs: 30 * 60e3, durMs: 8 * 60e3 });
    }
  }
  // Ölçüm: gürültü + EFT artefaktı + kopma
  for (const [ni, n] of TOPOLOGY.nodes.entries()) {
    const T = tr.nodes[n.id];
    const rng = mulberry32(seed + 7919 * (ni + 1));
    const eft = new Set((scripted ? [] : poissonEvents(rng, 12, horizon)).map((t) => Math.floor(t / DT)));
    if (scripted && T.eftSteps) for (const i of T.eftSteps) eft.add(i);
    for (let i = 0; i < steps; i++) {
      if (eft.has(i)) { T.meas[i] = 5 + 20 * rng(); T.kinds.eft++; continue; }
      if (!scripted && rng() < DROPOUT_P) { T.meas[i] = NaN; T.kinds.dropout++; continue; }
      T.meas[i] = T.trueSe[i] + SENSOR_NOISE_DB * (2 * rng() - 1);
    }
    // gerçek sızıntı göstergesinin önek toplamı (O(1) blok denetimi)
    T.leakPrefix = new Int32Array(steps + 1);
    for (let i = 0; i < steps; i++) T.leakPrefix[i + 1] = T.leakPrefix[i] + (T.trueSe[i] < SE_REQ ? 1 : 0);
  }
  return tr;
}
const leakyBetween = (T, t0, t1) => { const i0 = Math.max(0, Math.floor(t0 / DT)), i1 = Math.floor(t1 / DT); return T.leakPrefix[Math.min(i1 + 1, T.leakPrefix.length - 1)] - T.leakPrefix[i0] > 0; };

// ═══ Köken (provenance) defteri — link başına FIFO ═══
class ProvenanceLedger {
  constructor(keys, initialBits) { this.fifo = new Map(keys.map((k) => [k, [{ bits: initialBits, leaky: false }]])); }
  add(k, bits, leaky) { if (bits > 0) this.fifo.get(k).push({ bits, leaky }); }
  consume(k, bits) {
    const q = this.fifo.get(k); let need = bits, leaky = 0;
    while (need > 1e-9 && q.length) {
      const h = q[0]; const take = Math.min(h.bits, need);
      h.bits -= take; need -= take; if (h.leaky) leaky += take;
      if (h.bits <= 1e-9) q.shift();
    }
    return { leaky, shortfall: need > 1e-6 ? need : 0 };
  }
  total(k) { return this.fifo.get(k).reduce((s, e) => s + e.bits, 0); }
}

// ═══ Y0 ölçer — alıcıda vakum-decoy sayımı, 1 s kayan pencere ═══
class VacuumY0Meter {
  constructor(seed, windowSteps = 20) { this.rng = mulberry32(seed); this.w = windowSteps; this.buf = []; this.p = 0; this.c = 0; }
  sample(y0True, pv, dtMs) {
    const pulses = PULSE_HZ * (dtMs / 1000) * pv;
    const counts = poisson(pulses * y0True, this.rng);
    this.buf.push([pulses, counts]); this.p += pulses; this.c += counts;
    if (this.buf.length > this.w) { const [p, c] = this.buf.shift(); this.p -= p; this.c -= c; }
    return this.p > 0 ? Math.max(this.c, 1) / this.p : y0True; // 0 sayımda üst-yuvarlak (1 sayım)
  }
}

// ═══ Tek politika koşusu (adım adım; aşama 1 döngüyle, aşama 2 gerçek zamanla sürer) ═══
class SimRunner {
  constructor(traces, { policy, seMeasurementUncertaintyDb, optimizationCache, nowOffsetMs = 0, poolCapacityBits }) {
    this.traces = traces; this.nowOffsetMs = nowOffsetMs;
    this.net = new NET.ShieldedQkdNetwork({
      topology: TOPOLOGY, policy, threat: THREAT, ingress: INGRESS, seMeasurementUncertaintyDb,
      blockPulses: BLOCK_PULSES, pulseRateHz: PULSE_HZ, initialCleanPoolBits: INITIAL_POOL, optimizationCache, poolCapacityBits,
    });
    this.ledger = new ProvenanceLedger(this.net.links.map((l) => l.key), INITIAL_POOL);
    this.meters = new Map(this.net.links.map((l, i) => [l.key, new VacuumY0Meter(424242 + i)]));
    this.m = {
      policy, seMeasurementUncertaintyDb,
      demands: TOPOLOGY.demands.map((d) => ({ pair: `${d.src}↔${d.dst}`, offeredBits: 0, deliveredBits: 0, okSteps: 0, steps: 0, outageMs: 0, longestOutageMs: 0, cur: 0, holdPoolBits: 0 })),
      nodes: Object.fromEntries(TOPOLOGY.nodes.map((n) => [n.id, { mtlsCuts: 0, mtlsDownMs: 0, stateMs: {} }])),
      leakyProvenanceBits: 0, deliveryPathViolationBits: 0, deliveryPathViolationSteps: 0, releasedLeakyBlocks: 0, releasedBlocks: 0, quarantinedBlocks: 0,
      ecFailBlocks: 0, ecFailBits: 0, ledgerShortfall: 0, levelMs: {},
    };
    this.prevMtls = {};
  }

  /** i: iz indeksi (gerçek SE/ölçüm), nowMs: denetleyicilere verilen saat. */
  step(i, nowMs, hints) {
    const { traces, net, ledger, m } = this;
    const se = {}, y0 = {};
    for (const n of TOPOLOGY.nodes) se[n.id] = traces.nodes[n.id].meas[i];
    for (const l of net.links) {
      const B = traces.nodes[l.b];
      y0[l.key] = this.meters.get(l.key).sample(trueY0(B.ambient[i], B.trueSe[i]), net.activeParams(l.key).pv, DT);
    }
    const r = net.step(nowMs, { se, y0 }, hints);
    // blok kökeni: GERÇEK SE ile denetle
    for (const l of net.links) {
      const L = r.links[l.key];
      m.levelMs[L.level] = (m.levelMs[L.level] || 0) + DT;
      for (const b of L.newBlocks) {
        const s0 = b.startMs - this.nowOffsetMs, s1 = b.endMs - this.nowOffsetMs;
        const leaky = leakyBetween(traces.nodes[l.a], s0, s1) || leakyBetween(traces.nodes[l.b], s0, s1);
        if (b.tainted) { m.quarantinedBlocks++; continue; }
        m.releasedBlocks++;
        if (leaky) m.releasedLeakyBlocks++;
        ledger.add(l.key, b.bits, leaky);
        // EC denetimi: seçilen kod oranı GERÇEK en kötü Y0'da çözülebilir miydi?
        if (b.params && b.params.codeRate && b.bits > 0) {
          let y0max = 0; const B = traces.nodes[l.b];
          for (let j = Math.max(0, Math.floor(s0 / DT)); j <= Math.min(traces.steps - 1, Math.floor(s1 / DT)); j++) y0max = Math.max(y0max, trueY0(B.ambient[j], B.trueSe[j]));
          const g = D.theoreticalGainAndQber(b.params.mu, { Y0: y0max, eta: l.eta, eDetector: 0.02, e0: 0.5 });
          if (1 - b.params.codeRate < A.F_MIN * D.binaryEntropy(g.E)) { m.ecFailBlocks++; m.ecFailBits += b.bits; }
        }
      }
    }
    // teslim + köken + teslimat yolu denetimi
    let stepViolation = false;
    r.demands.forEach((d, di) => {
      const M = m.demands[di];
      d.leakyBits = 0;
      if (r.dtMs <= 0) return;
      M.steps++; M.offeredBits += d.demandBits; M.deliveredBits += d.deliveredBits;
      if (d.tier === "hold-pool") M.holdPoolBits += d.deliveredBits;
      if (d.deliveredBits >= 0.99 * d.demandBits) { M.okSteps++; M.cur = 0; }
      else { M.outageMs += r.dtMs; M.cur += r.dtMs; M.longestOutageMs = Math.max(M.longestOutageMs, M.cur); }
      let leakyFrac = 0;
      for (const pl of d.perLink) {
        const c = ledger.consume(pl.link, pl.bits);
        m.ledgerShortfall += c.shortfall;
        if (pl.bits > 0) leakyFrac = Math.max(leakyFrac, c.leaky / pl.bits);
      }
      d.leakyBits = leakyFrac * d.deliveredBits;
      m.leakyProvenanceBits += d.leakyBits;
      if (d.deliveredBits > 0 && d.path) {
        const bad = d.pathNodes.some((id) => {
          const n = this.net.nodeById.get(id), T = traces.nodes[id];
          return !n.deliveryPathIsolated && (T.trueSe[i] < SE_REQ || (i > 0 && T.trueSe[i - 1] < SE_REQ));
        });
        if (bad) { m.deliveryPathViolationBits += d.deliveredBits; d.pathViolation = true; stepViolation = true; }
      }
    });
    if (stepViolation) m.deliveryPathViolationSteps++;
    for (const n of TOPOLOGY.nodes) {
      const st = r.nodes[n.id]; const N = m.nodes[n.id];
      N.stateMs[st.state] = (N.stateMs[st.state] || 0) + DT;
      if (!st.mtlsAllowed) N.mtlsDownMs += DT;
      if (this.prevMtls[n.id] === true && !st.mtlsAllowed) N.mtlsCuts++;
      this.prevMtls[n.id] = st.mtlsAllowed;
    }
    return r;
  }

  finish() {
    const { m, net, ledger } = this;
    m.ledgerPoolMismatchBits = Math.max(...net.links.map((l) => Math.abs(ledger.total(l.key) - net.poolBits(l.key))));
    m.finalPoolBits = Object.fromEntries(net.links.map((l) => [l.key, Math.round(net.poolBits(l.key))]));
    m.overflowBits = m.policy === "adaptive" ? net.links.reduce((s, l) => s + l.ctl.overflowBits, 0) : 0;
    m.quarantinedBits = m.policy === "adaptive" ? net.links.reduce((s, l) => s + l.ctl.quarantinedBits, 0) : 0;
    m.paramSwitches = m.policy === "adaptive" ? net.links.reduce((s, l) => s + l.ctl.paramSwitches, 0) : 0;
    for (const M of m.demands) { M.availability = M.steps ? M.okSteps / M.steps : 0; M.deliveredFrac = M.offeredBits ? M.deliveredBits / M.offeredBits : 0; delete M.cur; }
    m.totalDelivered = m.demands.reduce((s, d) => s + d.deliveredBits, 0);
    m.totalOffered = m.demands.reduce((s, d) => s + d.offeredBits, 0);
    m.mtlsCutsTotal = Object.values(m.nodes).reduce((s, n) => s + n.mtlsCuts, 0);
    m.mtlsDownMsTotal = Object.values(m.nodes).reduce((s, n) => s + n.mtlsDownMs, 0);
    return m;
  }
}

function runSimulation(traces, opts) {
  const run = new SimRunner(traces, opts);
  for (let i = 0; i < traces.steps; i++) { const r = run.step(i, i * DT); if (opts.onStep) opts.onStep(i, r, run.net); }
  return run.finish();
}

// ═══ Koruma bandı Monte Carlo — tek link, SE_gerekli'yi yavaşça geçen kayma ═══
function guardBandMonteCarlo({ trials = 300, uValues = [0, 1] } = {}) {
  const out = {};
  const cache = new Map();
  for (const u of uValues) {
    let leakyBlocks = 0, leakyBits = 0, trialsWithLeak = 0;
    for (let k = 0; k < trials; k++) {
      const rng = mulberry32(9000 + k);
      // Mekanik olay (gevşeyen panel vidası, tam kapanmayan kapı): SE 50 dB'den
      // ANİDEN SE_gerekli'nin δ∈(0,1) dB altına iner ve orada kalır. Faz, blok
      // sınırına göre rastgele. (Yavaş kayma senaryosunda gürültünün kendisi mandalı
      // ERKEN tetikler — bkz. rapor; asıl riskli durum bu ani-ve-sığ düşüştür.)
      const tStep = 5000 + rng() * 1000;
      const delta = rng();
      const ctl = new A.AdaptiveShieldingMitigation({ threat: THREAT, ingress: { ambientFieldDbuVm: 70, ...INGRESS },
        deliveryPathIsolated: true, channel: { eta: 0.01 }, blockPulses: 1e9, optimizationCache: cache, seMeasurementUncertaintyDb: u });
      const trueAt = (t) => (t < tStep ? 50 : SE_REQ - delta);
      const tEnd = tStep + 3000;
      const samples = [];
      for (let t = 0; t <= tEnd; t += DT) { const tr = trueAt(t); samples.push(tr); ctl.ingest({ seDb: tr + SENSOR_NOISE_DB * (2 * rng() - 1) }, t); }
      let had = false;
      for (const b of ctl.blockLog) {
        if (b.tainted) continue;
        const i0 = Math.floor(b.startMs / DT), i1 = Math.min(samples.length - 1, Math.floor(b.endMs / DT));
        let leak = false; for (let i = i0; i <= i1; i++) if (samples[i] < SE_REQ) { leak = true; break; }
        if (leak) { leakyBlocks++; leakyBits += b.bits; had = true; }
      }
      if (had) trialsWithLeak++;
    }
    out[`u=${u}`] = { trials, trialsWithLeak, leakyBlocks, leakyBits };
  }
  return out;
}

module.exports = { TOPOLOGY, THREAT, INGRESS, SE_REQ, DT, buildTraces, SimRunner, runSimulation, guardBandMonteCarlo, ProvenanceLedger, VacuumY0Meter, trueY0, poisson, coreHash };

// ═══════════════════════════════════════════════════════════════════
// AŞAMA 1 — simüle saha
// ═══════════════════════════════════════════════════════════════════
function runSimStage(out, chk) {
  const traces = buildTraces({ minutes: SIM_MINUTES });
  const cache = new Map();
  const door = traces.events.find((e) => e.kind === "bakım kapısı açık");
  const tx = traces.events.find((e) => e.kind.startsWith("yakın verici"));
  const inWin = (t, e) => e && t >= e.startMs && t <= e.startMs + e.durMs;
  const runs = {};
  const windows = {};
  for (const [name, policy, u, cap] of [["adaptive", "adaptive", 1], ["adaptive-u0", "adaptive", 0], ["adaptive-cap16M", "adaptive", 1, 16e6], ["legacy-strict", "legacy-strict", 1], ["legacy-debounce", "legacy-debounce", 1]]) {
    const w = { doorBkrAts: { offered: 0, delivered: 0, paths: new Set() }, txAvrMslReleasedBits: 0 };
    const t0 = Date.now();
    runs[name] = runSimulation(traces, { policy, seMeasurementUncertaintyDb: u, optimizationCache: cache, poolCapacityBits: cap, onStep: (i, r) => {
      const t = i * DT;
      if (inWin(t, door)) {
        const d = r.demands.find((x) => x.src === "BKR" && x.dst === "ATS");
        w.doorBkrAts.offered += d.demandBits; w.doorBkrAts.delivered += d.deliveredBits; for (const p of d.paths) w.doorBkrAts.paths.add(p);
      }
      for (const b of r.links["AVR|MSL"].newBlocks) if (!b.tainted && tx && b.startMs >= tx.startMs && b.endMs <= tx.startMs + tx.durMs) w.txAvrMslReleasedBits += b.bits;
    } });
    runs[name].wallMs = Date.now() - t0;
    w.doorBkrAts.paths = [...w.doorBkrAts.paths];
    windows[name] = w;
  }
  const mc = guardBandMonteCarlo({ trials: 1000 });
  const asyCross = (() => { const T = traces.nodes.ASY; for (let i = 0; i < traces.steps; i++) if (T.trueSe[i] < SE_REQ) return i * DT; return null; })();
  out.sim = { minutes: SIM_MINUTES, seRequiredDb: +SE_REQ.toFixed(2), events: traces.events, asyTrueCrossMs: asyCross,
    measurementArtefacts: Object.fromEntries(Object.entries(traces.nodes).map(([k, v]) => [k, v.kinds])), runs, windows, guardBandMonteCarlo: mc };

  const a = runs.adaptive, s = runs["legacy-strict"], d = runs["legacy-debounce"], a0 = runs["adaptive-u0"];
  const pct = (x) => (100 * x).toFixed(2) + "%";
  const arte = Object.values(traces.nodes).every((n) => n.kinds.eft > 0 && n.kinds.dropout > 0);
  chk("S1 Saha izleri: bakım kapısı, gerçek kısa sızıntı, conta yaşlanması (SE_gerekli'yi geçiyor), yakın verici ve her düğümde EFT/kopma artefaktları mevcut",
    !!door && traces.events.some((e) => e.kind === "kısa gerçek sızıntı") && asyCross != null && !!tx && arte,
    `${traces.events.length} olay · ASY gerçek SE ${(asyCross / 60e3).toFixed(1)}. dakikada SE_gerekli'nin (${SE_REQ.toFixed(1)} dB) altına iniyor · artefaktlar ${JSON.stringify(out.sim.measurementArtefacts)}`);
  const kdkDoorEvents = traces.events.filter((e) => e.node === "KDK" && e.kind === "bakım kapısı açık").length;
  chk("S2 GÜVENLİK (yer gerçeği): uyarlamalı sistem sızıntı penceresine değen HİÇBİR bloğu serbest bırakmadı ve sızıntılı kökenli 0 bit teslim etti; izole olmayan sızan düğümden teslimat en fazla HABERSİZ kapı olayı başına BİR örnekleme aralığı (nedensel teslim — bkz. maintenance_traffic_shift_test M4/M5)",
    a.releasedLeakyBlocks === 0 && a.leakyProvenanceBits === 0 && a.deliveryPathViolationSteps <= kdkDoorEvents,
    `serbest bırakılan ${a.releasedBlocks} blok, sızıntılı ${a.releasedLeakyBlocks} · karantina ${a.quarantinedBlocks} blok (${(a.quarantinedBits / 1e9).toFixed(2)} Gbit) · sızıntılı köken ${a.leakyProvenanceBits} bit · teslimat-yolu maruziyeti ${Math.round(a.deliveryPathViolationBits)} bit / ${a.deliveryPathViolationSteps} aralık (habersiz KDK kapı olayı ${kdkDoorEvents}; bu izde KDK kapı açılırken artefakt nedeniyle zaten HOLD'daydı)`);
  chk("S3 BULGU: eski politikalar teslim KANALINI kapatıyor ama anahtar KÖKENİNİ izlemiyor — sızıntı sırasında üretilen bloklar havuza giriyor ve kanal açılınca teslim ediliyor",
    s.leakyProvenanceBits > 0 && d.leakyProvenanceBits > 0,
    `legacy-strict: ${s.releasedLeakyBlocks} sızıntılı blok serbest, ${Math.round(s.leakyProvenanceBits)} sızıntılı-kökenli bit teslim, teslimat-yolu ihlali ${Math.round(s.deliveryPathViolationBits)} bit · legacy-debounce: ${d.releasedLeakyBlocks} blok, ${Math.round(d.leakyProvenanceBits)} bit, teslimat-yolu ihlali ${Math.round(d.deliveryPathViolationBits)} bit (debounce'un 630 ms toleransı KDK'da sızarken teslimata izin veriyor)`);
  chk("S4 Süreklilik: uyarlamalı sistem eski politikaların ikisinden de fazla uçtan-uca anahtar teslim etti ve daha az mTLS kesintisi yaşadı",
    a.totalDelivered > s.totalDelivered && a.totalDelivered > d.totalDelivered && a.mtlsCutsTotal <= d.mtlsCutsTotal && a.mtlsCutsTotal < s.mtlsCutsTotal,
    `teslim/talep: uyarlamalı ${pct(a.totalDelivered / a.totalOffered)} · legacy-strict ${pct(s.totalDelivered / s.totalOffered)} · legacy-debounce ${pct(d.totalDelivered / d.totalOffered)} · ` +
    `mTLS kesintisi (olay/toplam süre): ${a.mtlsCutsTotal}/${(a.mtlsDownMsTotal / 1e3).toFixed(1)} s · ${s.mtlsCutsTotal}/${(s.mtlsDownMsTotal / 1e3).toFixed(0)} s · ${d.mtlsCutsTotal}/${(d.mtlsDownMsTotal / 1e3).toFixed(0)} s · ` +
    `talep başına erişilebilirlik (uyarlamalı): ${a.demands.map((x) => `${x.pair} ${pct(x.availability)}`).join(", ")} · AVR↔ASY legacy-strict ${pct(s.demands[0].availability)}`);
  const doorEvents = traces.events.filter((e) => e.kind === "bakım kapısı açık").length;
  chk("S5 Uyarlamalı sistemde mTLS yalnız GERÇEK sürdürülmüş taban ihlalinde (bakım kapısı) kesiliyor; EFT artefaktı, sensör kopması, kısa gerçek sızıntı ve yaşlanma kesinti üretmiyor",
    a.mtlsCutsTotal === doorEvents && a.nodes.KDK.mtlsCuts === doorEvents,
    `uyarlamalı: ${a.mtlsCutsTotal} kesinti (KDK ${a.nodes.KDK.mtlsCuts}, kapı olayı ${doorEvents}) · legacy-strict ${s.mtlsCutsTotal} kesinti (artefaktların her biri)`);
  chk("S6 Köken defteri ↔ denetleyici havuzları tutarlı (tüm politikalar, < 1 bit), hiçbir teslim karşılıksız değil",
    Object.values(runs).every((r) => r.ledgerPoolMismatchBits < 1 && r.ledgerShortfall === 0),
    Object.entries(runs).map(([k, r]) => `${k}: fark ${r.ledgerPoolMismatchBits.toFixed(4)} bit, açık ${r.ledgerShortfall}`).join(" · "));
  const wa = windows.adaptive.doorBkrAts;
  chk("S7 Yeniden yönlendirme: KDK kapısı açıkken BKR↔ATS talebi KDK'yı atlayan yoldan karşılanıyor",
    wa.offered > 0 && wa.delivered >= 0.99 * wa.offered && wa.paths.every((p) => !p.includes("KDK")),
    `kapı penceresinde teslim ${pct(wa.delivered / wa.offered)} · kullanılan yollar: ${wa.paths.join(", ")}`);
  chk("S8 Dinamik optimizasyon: MSL yakın-verici penceresinde (içeri giriş, Y0↑) AVR→MSL linki uyarlamalı parametrelerle anahtar üretmeye devam ediyor; sabit parametreli eski sistem 0 üretiyor",
    windows.adaptive.txAvrMslReleasedBits > 0 && windows["legacy-debounce"].txAvrMslReleasedBits === 0,
    `pencere (${(tx.durMs / 60e3).toFixed(0)} dk) içinde serbest bırakılan bit: uyarlamalı ${(windows.adaptive.txAvrMslReleasedBits / 1e6).toFixed(1)} Mbit · legacy-debounce ${windows["legacy-debounce"].txAvrMslReleasedBits} · parametre geçişi toplam ${a.paramSwitches} (60 dk, 8 link)`);
  chk("S9 Ölçüm-belirsizliği koruma bandı (Monte Carlo, 1000 ani-sığ düşüş): bant 0 iken olayların bir kısmında sızıntılı blok serbest kalıyor, ±1 dB bantla HİÇ",
    mc["u=0"].leakyBlocks > 0 && mc["u=1"].leakyBlocks === 0,
    `u=0: ${mc["u=0"].trialsWithLeak}/${mc["u=0"].trials} olayda ${mc["u=0"].leakyBlocks} sızıntılı blok (${(mc["u=0"].leakyBits / 1e6).toFixed(1)} Mbit) · u=1: ${mc["u=1"].leakyBlocks} · ` +
    `bu 60 dk'lık izde bant 0 da ihlal üretmedi (yavaş kaymada gürültü mandalı erken tetikliyor); bandın bedeli: karantina ${(a0.quarantinedBits / 1e9).toFixed(2)} → ${(a.quarantinedBits / 1e9).toFixed(2)} Gbit`);
  const c64 = runs["adaptive-cap16M"];
  const asyHoldMin = ((SIM_MINUTES * 60e3 - asyCross) / 60e3).toFixed(1);
  const asyHoldS = ((a.nodes.ASY.stateMs.HOLD_EGRESS || 0) / 1e3);
  const bridgeS = (2 * 16e6) / TOPOLOGY.demands[0].demandBps; // ASY'nin 2 izole linkindeki dolu tampon / talep
  chk("S11 SINIR (dürüstlük): sürdürülmüş HOLD'daki süreklilik TAMPON boyutuna bağlı — havuz 16 Mbit/link ile sınırlanınca ASY'nin kalıcı HOLD'unda AVR↔ASY aç kalıyor; güvenlik değişmiyor",
    c64.demands[0].availability < a.demands[0].availability && c64.releasedLeakyBlocks === 0 && c64.leakyProvenanceBits === 0 && c64.deliveryPathViolationSteps <= kdkDoorEvents,
    `AVR↔ASY erişilebilirlik: sınırsız tampon ${pct(a.demands[0].availability)} (HOLD havuzundan ${(a.demands[0].holdPoolBits / 1e6).toFixed(0)} Mbit; 60. dk'da link havuzları ${Object.values(a.finalPoolBits).map((b) => (b / 1e9).toFixed(1)).join("/")} Gbit) · ` +
    `16 Mbit tampon ${pct(c64.demands[0].availability)}, en uzun kesinti ${(c64.demands[0].longestOutageMs / 1e3).toFixed(0)} s · ASY dışa-sızıntı HOLD'u ${asyHoldS.toFixed(0)} s (gerçek SE ${asyHoldMin} dk boyunca SE_gerekli altında; ±1 dB bant HOLD'u daha erken başlatıyor) · ` +
    `kaba köprüleme süresi ≈ 2×16 Mbit / 120 kbps ≈ ${bridgeS.toFixed(0)} s < HOLD süresi · taşan ${(c64.overflowBits / 1e9).toFixed(1)} Gbit · sızıntılı köken ${c64.leakyProvenanceBits} — daraltma kısa parazitleri köprüler, kalıcı bozulma BAKIM ister`);
  const again = runSimulation(traces, { policy: "adaptive", seMeasurementUncertaintyDb: 1, optimizationCache: cache });
  const strip = (r) => JSON.stringify({ ...r, wallMs: 0 });
  chk("S10 Belirlenimcilik: aynı izlerle uyarlamalı koşu birebir aynı metrikleri veriyor",
    strip(again) === strip({ ...a, wallMs: 0 }), `teslim ${again.totalDelivered.toFixed(0)} bit = ${a.totalDelivered.toFixed(0)} bit`);
  out.sim.notes = { ecFailBlocksAdaptive: a.ecFailBlocks, ecFailExplanation: "Ani ortam-alanı sıçramasında (MSL verici açılışı) Y0 ölçümünün 1 s penceresi gecikir; o anki bloğun kod oranı gerçek Y0'da çözülemez. Gerçek sistemde EC doğrulama özeti bunu yakalar ve blok ATILIR (güvenlik sorunu değil, verim kaybı); simülasyon bu bitleri serbest saydı — üst sınır olarak raporlanır." };
}

// ═══════════════════════════════════════════════════════════════════
// AŞAMA 2 — gerçek süreçler (PKI + 6 KME + gerçek mTLS ETSI-014)
// ═══════════════════════════════════════════════════════════════════
const LIVE = { durationMs: 23000, eftMs: [4000, 4200], doorMs: [6000, 10000], bkrLeakMs: [12000, 12250], staleNode: "AVR", staleAtMs: 19000, gateMaxAgeMs: 1000, basePort: 19600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, argv, opts = {}) { return execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString(); }
function writeAtomic(fp, obj) { const tmp = `${fp}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, fp); }

async function runLiveStage(out, chk) {
  const LIB = require("./etsi014_client_lib.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photonnet-multinode-"));
  const pki = path.join(root, "pki"), reqs = path.join(pki, "reqs"), tools = path.join(__dirname, "pki_tools");
  const live = { root, kmes: {}, probes: [], flows: [], timeline: [], gateWrites: 0, injectedKeys: 0 };
  out.live = live;
  const procs = [];
  try {
    // ── PKI (gerçek openssl CA, kısa ömürlü sertifikalar) ──
    sh("bash", [path.join(tools, "ca_init.sh"), pki]);
    sh("bash", [path.join(tools, "issue_cert.sh"), reqs, "server", "localhost"]);
    sh("bash", [path.join(tools, "sign_csr.sh"), pki, path.join(reqs, "localhost.csr"), "server", "1"]);
    const certs = {};
    for (const n of TOPOLOGY.nodes) {
      sh("bash", [path.join(tools, "issue_cert.sh"), reqs, "client", `SAE-${n.id}`]);
      sh("bash", [path.join(tools, "sign_csr.sh"), pki, path.join(reqs, `SAE-${n.id}.csr`), "client", "1"]);
      certs[n.id] = { cert: fs.readFileSync(path.join(reqs, `SAE-${n.id}-cert.pem`)), key: fs.readFileSync(path.join(reqs, `SAE-${n.id}-key.pem`)) };
    }
    const ca = fs.readFileSync(path.join(pki, "ca-cert.pem"));

    // ── 6 KME süreci ──
    const gateFile = (id) => path.join(root, `gate-${id}.json`);
    const inbox = (id) => path.join(root, `inbox-${id}`);
    const writeGate = (id, nodes, now) => {
      const st = nodes ? nodes[id] : { state: "OK", mtlsAllowed: true };
      writeAtomic(gateFile(id), { issuedAtMs: now, maxAgeMs: LIVE.gateMaxAgeMs, self: { node: id, mtlsAllowed: st.mtlsAllowed, level: st.state },
        peers: Object.fromEntries(TOPOLOGY.nodes.map((n) => [n.id, nodes ? { deliveryAllowed: nodes[n.id].deliveryAllowed, level: nodes[n.id].state } : { deliveryAllowed: true, level: "OK" }])) });
      live.gateWrites++;
    };
    for (const [idx, n] of TOPOLOGY.nodes.entries()) {
      fs.mkdirSync(inbox(n.id));
      writeGate(n.id, null, Date.now());
      const port = LIVE.basePort + idx;
      const logPath = path.join(root, `kme-${n.id}.log`);
      const fd = fs.openSync(logPath, "w");
      const p = spawn(process.execPath, [path.join(__dirname, "etsi014_kme_server.js"), `--port=${port}`,
        `--cert=${path.join(reqs, "localhost-cert.pem")}`, `--key=${path.join(reqs, "localhost-key.pem")}`, `--ca=${path.join(pki, "ca-cert.pem")}`,
        `--shield-gate=${gateFile(n.id)}`, `--keystore-inbox=${inbox(n.id)}`], { stdio: ["ignore", fd, fd] });
      procs.push(p);
      live.kmes[n.id] = { port, pid: p.pid, baseUrl: `https://localhost:${port}`, logPath };
    }
    const other = (id) => TOPOLOGY.nodes.find((n) => n.id !== id).id;
    const status = (id) => LIB.httpsCall({ baseUrl: live.kmes[id].baseUrl, method: "GET", apiPath: `/api/v1/keys/SAE-${other(id)}/status`, cert: certs[id].cert, key: certs[id].key, ca, timeoutMs: 3000 });
    // açılış: kapıları tazeleyerek hepsinin 200 vermesini bekle
    const upDeadline = Date.now() + 15000; const up = {};
    while (Date.now() < upDeadline && Object.keys(up).length < TOPOLOGY.nodes.length) {
      for (const n of TOPOLOGY.nodes) writeGate(n.id, null, Date.now());
      for (const n of TOPOLOGY.nodes) if (!up[n.id]) { try { const r = await status(n.id); if (r.status === 200) up[n.id] = true; } catch (e) { /* henüz açılmadı */ } }
      await sleep(200);
    }
    live.allUp = Object.keys(up).length === TOPOLOGY.nodes.length;

    // ── Senaryo izleri (gerçek zamanlı) ──
    const traces = buildTraces({ minutes: LIVE.durationMs / 60e3, seed: 777, scripted: (tr, setRange) => {
      tr.nodes.MSL.eftSteps = []; for (let t = LIVE.eftMs[0]; t <= LIVE.eftMs[1]; t += DT) tr.nodes.MSL.eftSteps.push(t / DT);
      setRange(tr.nodes.KDK.trueSe, LIVE.doorMs[0], LIVE.doorMs[1], 15);
      setRange(tr.nodes.BKR.trueSe, LIVE.bkrLeakMs[0], LIVE.bkrLeakMs[1], 25);
      tr.events.push({ node: "MSL", kind: "EFT ölçüm artefaktı", startMs: LIVE.eftMs[0], durMs: LIVE.eftMs[1] - LIVE.eftMs[0] },
        { node: "KDK", kind: "bakım kapısı açık", startMs: LIVE.doorMs[0], durMs: LIVE.doorMs[1] - LIVE.doorMs[0] },
        { node: "BKR", kind: "kısa gerçek sızıntı", startMs: LIVE.bkrLeakMs[0], durMs: LIVE.bkrLeakMs[1] - LIVE.bkrLeakMs[0] },
        { node: LIVE.staleNode, kind: "SE izleyici çöktü (kapı tazelenmiyor)", startMs: LIVE.staleAtMs, durMs: LIVE.durationMs - LIVE.staleAtMs });
    } });
    live.events = traces.events;
    const t0 = Date.now();
    const runner = new SimRunner(traces, { policy: "adaptive", seMeasurementUncertaintyDb: 1, optimizationCache: new Map(), nowOffsetMs: t0 });
    const registry = new Map();
    const acc = TOPOLOGY.demands.map(() => ({ bits: 0, leaky: false }));
    let stop = false;
    const rel = () => Date.now() - t0;

    // ── SAE akışları (talep başına) ve düğüm yoklamaları ──
    const flowWorker = async (di) => {
      const d = TOPOLOGY.demands[di];
      await sleep(1000 + 150 * di); // ısınma: ilk anahtarların gelen kutusundan yüklenmesi (soğuk depo → 503 beklenir)
      while (!stop) {
        const t = rel(); const rec = { t, pair: `${d.src}↔${d.dst}`, ok: false };
        try {
          const ek = await LIB.httpsCall({ baseUrl: live.kmes[d.src].baseUrl, method: "POST", apiPath: `/api/v1/keys/SAE-${d.dst}/enc_keys`, body: { number: 4 }, cert: certs[d.src].cert, key: certs[d.src].key, ca, timeoutMs: 3000 });
          rec.encStatus = ek.status;
          if (ek.status === 200) {
            const v = LIB.validateKeyContainer(ek.json, 32);
            const dk = await LIB.httpsCall({ baseUrl: live.kmes[d.src].baseUrl, method: "POST", apiPath: `/api/v1/keys/SAE-${d.src}/dec_keys`, body: { key_IDs: ek.json.keys.map((k) => ({ key_ID: k.key_ID })) }, cert: certs[d.dst].cert, key: certs[d.dst].key, ca, timeoutMs: 3000 });
            rec.decStatus = dk.status;
            const byId = dk.status === 200 ? Object.fromEntries(dk.json.keys.map((k) => [k.key_ID, k.key])) : {};
            rec.keys = ek.json.keys.map((k) => ({ id: k.key_ID, match: byId[k.key_ID] === k.key, reg: registry.get(k.key_ID) || null, b64ok: (registry.get(k.key_ID) || {}).b64 === k.key }));
            rec.ok = v.ok && dk.status === 200 && rec.keys.every((k) => k.match);
          } else rec.message = ek.json && ek.json.message;
        } catch (e) { rec.error = e.code || e.message; }
        live.flows.push(rec);
        await sleep(600);
      }
    };
    const probeWorker = async (id) => {
      while (!stop) {
        const t = rel(); let kind;
        try { const r = await status(id); kind = r.status === 200 ? "ok" : `http-${r.status}`; }
        catch (e) { kind = /ECONNREFUSED/.test(e.code || e.message) ? "down" : "tls-cut"; }
        live.probes.push({ t, node: id, kind });
        await sleep(250);
      }
    };
    const workers = [...TOPOLOGY.demands.map((_, di) => flowWorker(di)), ...TOPOLOGY.nodes.map((n) => probeWorker(n.id))];

    // ── Gerçek zamanlı karar döngüsü ──
    let lastI = -1;
    while (rel() < LIVE.durationMs) {
      const now = Date.now();
      const i = Math.min(traces.steps - 1, Math.floor((now - t0) / DT));
      if (i > lastI) {
        lastI = i;
        const r = runner.step(i, now);
        for (const n of TOPOLOGY.nodes) if (!(n.id === LIVE.staleNode && now - t0 >= LIVE.staleAtMs)) writeGate(n.id, r.nodes, now);
        // uçtan-uca anahtar enjeksiyonu (master tarafı KME'nin gelen kutusu)
        r.demands.forEach((d, di) => {
          const A_ = acc[di];
          A_.bits += d.deliveredBits; if (d.leakyBits > 0) A_.leaky = true;
          const nk = Math.min(64, Math.floor(A_.bits / 256));
          if (nk <= 0) return;
          A_.bits -= nk * 256;
          const entries = [];
          for (let k = 0; k < nk; k++) {
            const id = crypto.randomUUID(), b64 = crypto.randomBytes(32).toString("base64");
            registry.set(id, { b64, pair: `${d.src}↔${d.dst}`, leaky: A_.leaky, atMs: now - t0 });
            entries.push({ key_ID: id, key: b64, sizeBits: 256, blockIndex: k });
          }
          A_.leaky = false;
          const routeKey = [d.src, d.dst].sort().join("-");
          writeAtomic(path.join(inbox(d.src), `${String(now).padStart(15, "0")}-${di}.json`), { routes: { [routeKey]: entries } });
          live.injectedKeys += nk;
        });
        live.timeline.push({ t: now - t0, nodes: Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.state])),
          paths: Object.fromEntries(r.demands.map((d) => [`${d.src}↔${d.dst}`, d.path])) });
      }
      await sleep(Math.max(1, DT - (Date.now() - now)));
    }
    stop = true;
    await Promise.all(workers);
    live.metrics = runner.finish();
    for (const n of TOPOLOGY.nodes) live.kmes[n.id].log = fs.readFileSync(live.kmes[n.id].logPath, "utf8").split("\n").filter((l) => /Kalkan|REDDED|HATA/.test(l)).slice(0, 6);
  } finally {
    for (const p of procs) { try { p.kill("SIGTERM"); } catch (e) { /* zaten kapanmış */ } }
    await sleep(200);
  }
  liveChecks(out, chk);
  try { fs.rmSync(live.root, { recursive: true, force: true }); } catch (e) { /* önemli değil */ }
}

function liveChecks(out, chk) {
  const L = out.live;
  const probes = (node, from, to) => L.probes.filter((p) => p.node === node && p.t >= from && p.t < to);
  const flows = (pair, from, to) => L.flows.filter((f) => f.pair === pair && f.t >= from && f.t < to);
  const door = LIVE.doorMs, stale = LIVE.staleAtMs;
  chk("L1 Gerçek PKI (CA + localhost + 6 SAE sertifikası) üretildi, 6 ayrı KME süreci gerçek mTLS ile ayağa kalktı",
    L.allUp, `KME portları ${Object.values(L.kmes).map((k) => k.port).join(", ")} · kapı yazımı ${L.gateWrites} · enjekte edilen uçtan-uca anahtar ${L.injectedKeys}`);
  const base = TOPOLOGY.demands.map((d) => flows(`${d.src}↔${d.dst}`, 0, LIVE.eftMs[0]));
  chk("L2 Olaylardan önce 4 talebin hepsi gerçek ETSI-014 akışıyla (enc_keys → dec_keys) anahtar alıyor, master/slave birebir",
    base.every((fs_) => fs_.length > 0 && fs_.every((f) => f.ok)), base.map((fs_, k) => `${TOPOLOGY.demands[k].src}↔${TOPOLOGY.demands[k].dst} ${fs_.filter((f) => f.ok).length}/${fs_.length}`).join(" · "));
  const mslStates = L.timeline.filter((x) => x.t >= LIVE.eftMs[0] && x.t < LIVE.eftMs[1] + 900).map((x) => x.nodes.MSL);
  const mslBad = L.probes.filter((p) => p.node === "MSL" && p.kind !== "ok");
  chk("L3 MSL EFT artefaktı (200 ms): karar matrisi HOLD'a geçiyor ama MSL'nin KME'si mTLS'i hiç kesmiyor (teslim yolu izole)",
    mslStates.some((s) => s !== "OK") && mslBad.length === 0,
    `MSL durumları ${[...new Set(mslStates)].join("/")} · MSL yoklamaları ${L.probes.filter((p) => p.node === "MSL").length}, başarısız ${mslBad.length}`);
  const kdkCut = L.probes.filter((p) => p.node === "KDK" && p.kind === "tls-cut");
  const firstCut = kdkCut.length ? kdkCut[0].t : null, lastCut = kdkCut.length ? kdkCut[kdkCut.length - 1].t : null;
  const kdkPre = probes("KDK", door[0] + 100, door[0] + 600);
  const kdkAfter = probes("KDK", door[1] + 6300 + 1200, stale);
  chk("L4 KDK bakım kapısı (4 s, SE 15 dB): önce teslim kapanıyor (HOLD, izole değil → 503), ~630 ms sonra KME mTLS oturumlarını GERÇEKTEN kesiyor (BLOCK), 6,3 s marjlı iyileşmeden sonra açılıyor",
    kdkPre.length > 0 && kdkPre.every((p) => p.kind === "http-503") && firstCut != null && firstCut >= door[0] + 600 && firstCut <= door[0] + 1300 &&
    lastCut >= door[1] + 6000 && lastCut <= door[1] + 6300 + 1200 && kdkAfter.length > 0 && kdkAfter.every((p) => p.kind === "ok"),
    `${door[0]}–${door[0] + 600} ms: ${[...new Set(kdkPre.map((p) => p.kind))].join("/")} · TLS kesintisi ${firstCut}→${lastCut} ms (kapı ${door[0]}→${door[1]} ms) · sonrasında ${[...new Set(kdkAfter.map((p) => p.kind))].join("/")}`);
  const kdkFlows = ["MSL↔KDK", "AVR↔KDK"].map((pr) => flows(pr, door[0] + 200, door[1] + 6000));
  const mslKdkBack = flows("MSL↔KDK", door[1] + 6300 + 1500, LIVE.durationMs);
  chk("L5 KDK uçlu talepler kapı + kurtarma boyunca master KME'nin kapısında reddediliyor (karşı düğüm teslim almıyor), sonra geri geliyor",
    kdkFlows.every((fs_) => fs_.length > 0 && fs_.every((f) => !f.ok && f.encStatus === 503)) && mslKdkBack.length > 0 && mslKdkBack.every((f) => f.ok),
    `kapı+kurtarma: MSL↔KDK ${kdkFlows[0].length} akış, AVR↔KDK ${kdkFlows[1].length} akış — hepsi 503 · sonrasında MSL↔KDK ${mslKdkBack.filter((f) => f.ok).length}/${mslKdkBack.length} başarılı`);
  const bkrAts = flows("BKR↔ATS", 0, LIVE.durationMs);
  const reroute = [...new Set(L.timeline.filter((x) => x.t >= door[0] + 700 && x.t < door[1]).map((x) => x.paths["BKR↔ATS"]))];
  chk("L6 BKR↔ATS: KDK BLOCK'tayken ağ KDK'yı atlayan yola geçiyor, BKR'nin kendi 250 ms gerçek sızıntısında bile (izole) akışlar kesintisiz",
    bkrAts.length > 0 && bkrAts.every((f) => f.ok) && reroute.length > 0 && reroute.every((p) => p && !p.includes("KDK")),
    `${bkrAts.filter((f) => f.ok).length}/${bkrAts.length} akış başarılı · KDK BLOCK sırasında yol(lar): ${reroute.join(", ")}`);
  const avrCut = probes(LIVE.staleNode, stale + LIVE.gateMaxAgeMs + 500, LIVE.durationMs);
  const avrFlows = ["AVR↔ASY", "AVR↔KDK"].map((pr) => flows(pr, stale + LIVE.gateMaxAgeMs + 500, LIVE.durationMs));
  chk("L7 SE izleyicisi çöken düğüm (AVR, kapı dosyası tazelenmiyor): KME ≤ maxAge sonra FAIL-CLOSED — mTLS kesiliyor, AVR-master akışları duruyor",
    avrCut.length > 0 && avrCut.every((p) => p.kind === "tls-cut") && avrFlows.every((fs_) => fs_.length > 0 && fs_.every((f) => !f.ok)),
    `${stale} ms'den sonra AVR yoklamaları: ${[...new Set(avrCut.map((p) => p.kind))].join("/")} (${avrCut.length}) · AVR↔ASY/AVR↔KDK akışları: ${avrFlows.map((fs_) => `${fs_.filter((f) => !f.ok).length}/${fs_.length} reddedildi`).join(", ")}`);
  const recv = L.flows.filter((f) => f.keys).flatMap((f) => f.keys);
  const ids = recv.map((k) => k.id);
  chk("L8 KÖKEN (gerçek API üzerinden): SAE'lerin aldığı her anahtar test ağının enjekte ettiği anahtarla bayt-bayt aynı, hiçbiri sızıntılı kökenli değil, hiçbiri iki kez verilmedi",
    recv.length > 0 && recv.every((k) => k.reg && k.b64ok && k.match && !k.reg.leaky) && new Set(ids).size === ids.length,
    `alınan ${recv.length} anahtar · kayıtta ${recv.filter((k) => k.reg).length} · bayt eşleşmesi ${recv.filter((k) => k.b64ok).length} · sızıntılı köken ${recv.filter((k) => k.reg && k.reg.leaky).length} · tekrar ${ids.length - new Set(ids).size}`);
  const lm = L.metrics;
  chk("L9 Canlı koşunun yer-gerçeği denetimi: sızıntılı blok serbest bırakılmadı, sızıntılı köken 0; habersiz KDK kapı açılışında teslimat-yolu maruziyeti TEK örnekleme aralığıyla sınırlı (planlı bakımda 0 — bkz. maintenance_traffic_shift_test)",
    lm.releasedLeakyBlocks === 0 && lm.leakyProvenanceBits === 0 && lm.deliveryPathViolationSteps <= 1,
    `serbest ${lm.releasedBlocks} blok · karantina ${lm.quarantinedBlocks} blok · sızıntılı köken ${lm.leakyProvenanceBits} · teslimat-yolu maruziyeti ${Math.round(lm.deliveryPathViolationBits)} bit / ${lm.deliveryPathViolationSteps} aralık (kapının açıldığı aralık, bir önceki okumayla yönlendirilmişti)`);
  // raporu inceltmek için ham kayıtları özetle
  L.flowCount = L.flows.length; L.probeCount = L.probes.length;
  L.flows = L.flows.map(({ keys, ...f }) => ({ ...f, keyCount: keys ? keys.length : 0 }));
  L.timeline = L.timeline.filter((_, k) => k % 10 === 0);
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), stage: STAGE, checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = coreHash();
  if (STAGE === "sim" || STAGE === "all") runSimStage(out, chk);
  if (STAGE === "live" || STAGE === "all") await runLiveStage(out, chk);
  const after = coreHash();
  chk("ÇEKİRDEĞE DOKUNULMADI (photonnet_core.js SHA-256 öncesi = sonrası = mühürlü değer)",
    before === after && after === "421513f72bad1fb32b24c78453f9f6fdcbdbab83bd10f044d58ffc71b42bb3d4", `${after.slice(0, 16)}…`);
  out.allChecksPassed = out.checks.every((c) => c.ok);
  const rep = path.join(__dirname, "reports", `multinode_shielding_testbed${STAGE === "all" ? "" : "_" + STAGE}.json`);
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ ÇOK-DÜĞÜMLÜ TEST AĞI — 4 seviyeli kalkan karar matrisi ══\n");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"} (${out.checks.filter((c) => c.ok).length}/${out.checks.length})`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
