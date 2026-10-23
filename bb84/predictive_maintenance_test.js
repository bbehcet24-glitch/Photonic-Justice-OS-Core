#!/usr/bin/env node
"use strict";
/**
 * predictive_maintenance_test.js — çevresel yaşlanma + kestirimci bakım öz-testleri
 * ═══════════════════════════════════════════════════════════════════
 * Fizik birimleri (Peck / Arrhenius / Coffin–Manson / Basquin), filonun 2 yıllık
 * saatlik simülasyonu (40 kafes, 4 saha sınıfı, gizli birim ölçeği, cihaz sapması,
 * sensör artefaktları), çevre-duyarlı ve zaman-tabanlı tahmincinin kıyası, otonom
 * bakım planlayıcının kapalı döngü değeri, ani değişim algılama, yanlış model
 * duyarlılığı ve kalkan karar katmanıyla uyum.
 * Tüm rastgelelik tohumludur (tekrarlanabilir).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const E = require("./environmental_aging_model.js");
const PM = require("./predictive_maintenance.js");
const HW = require("./hardware_aging_model.js");
const A = require("./adaptive_shielding_mitigation.js");
const { mtlsHandshakePrecondition } = require("./network_shielding_bridge.js");

const GUARDED = ["photonnet_core.js", "hardware_aging_model.js", "adaptive_shielding_mitigation.js", "network_shielding_bridge.js", "mtls_failsafe_debounce.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));

// Operasyonel kritik eşik = kalkan karar katmanının dışa-sızıntı eşiği (test ağı tehdit modeli)
const THREAT = { sourceLevelDbuVm: 100, observerDistanceM: 0.3, noiseFloorDbuVm: 40, freqHz: 1e9 };
const THR = A.seRequiredForThreatDb(THREAT).seRequiredDb + A.DEFAULT_SE_MEASUREMENT_UNCERTAINTY_DB; // ≈ 39,0 dB
const H_EVAL = 2 * E.HOURS_PER_YEAR;           // 2 yıl izleme
const H_TRUTH = H_EVAL + 120 * 24;             // gerçek ömrü ufuk sonrasında da bilmek için +120 gün
const NEW_SE = 64;                             // bakım (conta yenileme) sonrası SE
const SITE_CLASSES = {
  dc: { kind: "dc", doorPerWeek: 0.5 },
  dcHvac: { kind: "dc", doorPerWeek: 0.5 },
  cabinet: { kind: "cabinet", doorPerWeek: 1 },
  rail: { kind: "dc", doorPerWeek: 0.5, vibration: { dayG: 0.8, nightG: 0.1 } },
};
const CLIM_UNTIL = E.HOURS_PER_YEAR + H_TRUTH + 2 * E.HOURS_PER_YEAR + 48;
const climCache = new Map();
const climFor = (cls) => { if (!climCache.has(cls)) climCache.set(cls, new PM.ClimatologyExposure(new E.SiteClimate(SITE_CLASSES[cls]), { untilHours: CLIM_UNTIL })); return climCache.get(cls); };
const meanRatePerHour = (cls) => { const c = climFor(cls); return c.ahead(0, E.HOURS_PER_YEAR) / E.HOURS_PER_YEAR; };
const S_PRIOR = { mean: 1, sd: 0.8 };

// ── Filo birimi (gerçek yörünge önceden hesaplanır; artışlar SE durumundan bağımsız) ──
function buildUnit(id, seed, { truthParams = E.DEFAULT_ENV_AGING_PARAMS, cls = null, startSe = null, scale = null, stepAtDay = null, stepDb = 0 } = {}) {
  const r = HW.mulberry32(seed);
  const classes = ["dc", "dc", "dc", "dc", "dcHvac", "dcHvac", "cabinet", "cabinet", "cabinet", "rail", "rail"];
  const c = cls || classes[Math.floor(r() * classes.length)];
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const unitScale = scale != null ? scale : 1.5 * Math.exp(0.5 * g());
  const se0 = startSe != null ? startSe : 44 + 10 * r();
  const bias = 2 * r() - 1;
  const startH = Math.floor(r() * E.HOURS_PER_YEAR);
  const site = { ...SITE_CLASSES[c] };
  if (c === "dcHvac") { const f0 = startH + Math.floor(r() * E.HOURS_PER_YEAR); site.hvacFailures = [{ startH: f0, endH: f0 + 7 * 24 }, { startH: f0 + E.HOURS_PER_YEAR, endH: f0 + E.HOURS_PER_YEAR + 5 * 24 }]; }
  const env = new E.SiteClimate(site).realize({ startH, hours: H_TRUTH, seed: seed * 7 + 1 });
  const model = new E.EnvironmentalAgingModel({ nominalSeDb: se0, params: truthParams, unitScale, seed: seed * 13 + 5 });
  const cum = new Float64Array(H_TRUTH + 1);
  for (let k = 0; k < H_TRUTH; k++) cum[k + 1] = cum[k] + model.step(env[k], 1).lossDb;
  const noise = new Float64Array(H_TRUTH), artefact = new Float64Array(H_TRUTH);
  for (let k = 0; k < H_TRUTH; k++) { noise[k] = 0.15 * g(); artefact[k] = r() < 1 / 400 ? -(5 + 15 * r()) : 0; }
  return { id, cls: c, unitScale, se0, bias, startH, env, cum, noise, artefact, stepAtH: stepAtDay != null ? stepAtDay * 24 : null, stepDb, byChannel: model.byChannel };
}

function makeMonitor(u, mode, seed, se0) {
  if (mode === "environmental") return new PM.PrognosticsMonitor({ nodeId: u.id, mode, thresholdDb: THR, initialSeDb: se0, sPrior: S_PRIOR, climatologyExposure: climFor(u.cls), seed });
  const b0 = meanRatePerHour(u.cls) * S_PRIOR.mean; // aynı önsel bilgi: saha klimatolojisinin ortalama hızı
  return new PM.PrognosticsMonitor({ nodeId: u.id, mode, thresholdDb: THR, initialSeDb: se0, sPrior: { mean: b0, sd: S_PRIOR.sd * b0 }, seed });
}

/**
 * Bir birimi bir politika ile koş.
 * policy: 'open-env' | 'open-time' (bakımsız, uyarı/doğruluk ölçümü) | 'env' | 'time' | 'reactive' (kapalı döngü)
 */
function runUnit(u, policy, { reactiveDelayH = 72, hours = H_EVAL } = {}) {
  const mode = policy.includes("time") ? "time-only" : "environmental";
  const closed = !policy.startsWith("open");
  const seStep = (k) => (u.stepAtH != null && k >= u.stepAtH ? u.stepDb : 0);
  let base = u.se0, km = 0, lastStepApplied = 0;
  const trueAt = (k) => base - (u.cum[k + 1] - u.cum[km]) - (seStep(k) - lastStepApplied);
  const opAt = (k) => trueAt(k) + u.bias; // gürültüsüz ölçülen = operasyonel tetik
  const mon = policy === "reactive" ? null : makeMonitor(u, mode, 1000 + u.id, opAt(0) + u.noise[0]);
  const sched = new PM.MaintenanceScheduler();
  const res = { events: [], holdHours: 0, maint: [], rulChecks: [] };
  let pendingReactiveDue = null;
  for (let k = 0; k < hours; k++) {
    const t = u.startH + k;
    const op = opAt(k);
    if (op < THR) res.holdHours++;
    const meas = op + u.noise[k] + u.artefact[k];
    if (mon) {
      const evs = mon.ingest(t, { seDb: meas, env: u.env[k] });
      for (const ev of evs) { res.events.push({ ...ev, k }); if (closed) sched.consider(ev); }
      if (!closed && mon.lastEvalH === t) res.rulChecks.push({ k, p10: mon.lastRul.p10, p50: mon.lastRul.p50, p90: mon.lastRul.p90 });
    }
    if (policy === "reactive" && op < THR && pendingReactiveDue == null) pendingReactiveDue = k + reactiveDelayH;
    const due = closed && ((policy === "reactive" && pendingReactiveDue != null && k >= pendingReactiveDue) || (mon && sched.due(u.id, t)));
    if (due) {
      // bakım anındaki GERÇEK kalan ömür (bakımsız devam etseydi) → "boşa harcanan ömür"
      let kc = k; while (kc < H_TRUTH - 1 && base - (u.cum[kc + 1] - u.cum[km]) - (seStep(kc) - lastStepApplied) + u.bias >= THR) kc++;
      res.maint.push({ k, trueRulDays: (kc - k) / 24, reason: policy === "reactive" ? "reaktif" : (sched.orders.get(u.id) || {}).reason });
      base = NEW_SE; km = k + 1; lastStepApplied = seStep(k); pendingReactiveDue = null;
      if (mon) { mon.notifyMaintenance(t, NEW_SE + u.bias); sched.complete(u.id); }
    }
  }
  return res;
}

/** Bakımsız gerçek operasyonel eşik geçişi (saat dizini) — yoksa null. */
function trueCrossing(u) {
  for (let k = 0; k < H_TRUTH; k++) {
    const op = u.se0 - u.cum[k + 1] - (u.stepAtH != null && k >= u.stepAtH ? u.stepDb : 0) + u.bias;
    if (op < THR) return k;
  }
  return null;
}

function leadStats(units, runs) {
  const rows = [];
  let prematureWarnings = 0, prematureAdvisories = 0, prematureByMargin = 0;
  for (const u of units) {
    const kc = trueCrossing(u);
    const r = runs.get(u.id);
    // "Erken/gereksiz" alarm: uyarı anında GERÇEK kalan ömür, düzey sınırının 4 katından fazla
    for (const e of r.events) {
      if (e.kind !== "ALERT") continue;
      const rulTrue = kc == null ? Infinity : (kc - e.k) / 24;
      if ((e.level === "WARNING" || e.level === "CRITICAL") && rulTrue > 4 * PM.DEFAULT_POLICY.warningDays) { if (e.basis === "marj") prematureByMargin++; else prematureWarnings++; }
      if (e.level === "ADVISORY" && rulTrue > 4 * PM.DEFAULT_POLICY.advisoryDays) prematureAdvisories++;
    }
    const first = (lvl) => { const e = r.events.find((x) => x.kind === "ALERT" && ["ADVISORY", "WARNING", "CRITICAL"].indexOf(x.level) >= ["ADVISORY", "WARNING", "CRITICAL"].indexOf(lvl)); return e ? e.k : null; };
    rows.push({ id: u.id, cls: u.cls, crossDay: kc != null ? kc / 24 : null, advDay: first("ADVISORY") != null ? first("ADVISORY") / 24 : null, warnDay: first("WARNING") != null ? first("WARNING") / 24 : null });
  }
  const crossing = rows.filter((x) => x.crossDay != null && x.crossDay <= H_EVAL / 24);
  const leadAdv = crossing.map((x) => (x.advDay != null && x.advDay <= x.crossDay ? x.crossDay - x.advDay : -Infinity));
  const leadWarn = crossing.map((x) => (x.warnDay != null && x.warnDay <= x.crossDay ? x.crossDay - x.warnDay : -Infinity));
  const nonCross = rows.filter((x) => x.crossDay == null || x.crossDay > H_EVAL / 24 + 90);
  const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
  return {
    rows, crossingUnits: crossing.length,
    advisoryLate30: leadAdv.filter((x) => x < 30).length,          // ADVISORY 30 günden az önce ya da hiç
    warningMissed: leadWarn.filter((x) => x < 1).length,            // WARNING eşikten 1 gün öncesine kadar gelmedi
    medianAdvisoryLeadDays: med(leadAdv), medianWarningLeadDays: med(leadWarn),
    falseWarnings: nonCross.filter((x) => x.warnDay != null).length, nonCrossingUnits: nonCross.length,
    prematureWarnings, prematureAdvisories, prematureByMargin,
  };
}

function rulAccuracy(units, runs) {
  const at = [90, 60, 30, 14];
  const out = Object.fromEntries(at.map((d) => [d, { absErr: [], covered: 0, n: 0 }]));
  for (const u of units) {
    const kc = trueCrossing(u); if (kc == null || kc > H_EVAL) continue;
    for (const c of runs.get(u.id).rulChecks) {
      const trueDays = (kc - c.k) / 24;
      for (const d of at) if (Math.abs(trueDays - d) <= 0.5) { const o = out[d]; o.n++; o.absErr.push(Math.abs(c.p50 - trueDays)); if (c.p10 <= trueDays && trueDays <= c.p90) o.covered++; }
    }
  }
  return Object.fromEntries(at.map((d) => { const o = out[d]; const s = o.absErr.sort((x, y) => x - y); return [d, { n: o.n, medianAbsErrDays: s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null, coverage80: o.n ? +(o.covered / o.n).toFixed(2) : null }]; }));
}

function main() {
  const out = { generatedAt: new Date().toISOString(), thresholdDb: +THR.toFixed(2), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();
  const t0 = Date.now();

  // ══ P1 Fizik birimleri ══
  const af0 = E.accelerationFactorTH(25, 50), afT = E.accelerationFactorTH(35, 50), afRH = E.accelerationFactorTH(25, 100);
  const arrh = Math.exp((0.79 / E.K_BOLTZMANN_EV) * (1 / 298.15 - 1 / 308.15));
  const cnt = new E.ThermalCycleCounter(2); const hc = [];
  for (let t = 0; t < 24 * 10; t++) hc.push(...cnt.push(20 + 5 * Math.sin((2 * Math.PI * t) / 24) + 0.4 * Math.sin(t * 1.7)));
  const steady = hc.slice(1);
  const cntR = new E.ThermalCycleCounter(2); let ripple = 0; for (let t = 0; t < 500; t++) ripple += cntR.push(20 + 0.8 * Math.sin(t)).length;
  const lossDoor = E.expectedLossDb({ tempC: 25, rh: 50, doorEvents: 3 }, 0, []).door;
  chk("P1 Fizik birimleri: Peck/Arrhenius referansta 1, +10 °C ve RH 50→100 beklenen katsayılar; yarım-döngü sayacı 10 günlük sinüste 2/gün ve aralık≈2A; <2 °C dalgacık sayılmıyor; kapı olayı başına sabit aşınma",
    Math.abs(af0 - 1) < 1e-12 && Math.abs(afT - arrh) < 1e-9 && Math.abs(afRH - Math.pow(2, 2.7)) < 1e-9 && hc.length >= 19 && hc.length <= 20 &&
    steady.every((x) => Math.abs(x - 10) < 1.2) && ripple === 0 && Math.abs(lossDoor - 0.09) < 1e-12,
    `AF(25°C,%50)=${af0} · AF(35°C)=${afT.toFixed(3)} (Arrhenius 0,79 eV: ${arrh.toFixed(3)}) · AF(%100)=${afRH.toFixed(3)} (2^2,7=${Math.pow(2, 2.7).toFixed(3)}) · ` +
    `10 gün sinüs (A=5 °C): ${hc.length} yarım döngü, aralıklar ${Math.min(...steady).toFixed(2)}–${Math.max(...steady).toFixed(2)} °C · 0,8 °C dalgacık: ${ripple} döngü · 3 kapı olayı: ${lossDoor.toFixed(3)} dB`);

  // ══ P2 Referans ortamda zamana-bağlı modele indirgenme + hardware_aging_model ile aynı temsil ══
  const mRef = new E.EnvironmentalAgingModel({ nominalSeDb: 65, params: { ...E.DEFAULT_ENV_AGING_PARAMS, noiseSigma: 0 } });
  const perYear = []; for (let y = 0; y < 3; y++) { const s0 = mRef.seDb; for (let h = 0; h < E.HOURS_PER_YEAR; h++) mRef.step({ tempC: 25, rh: 50, vibGrms: 0, doorEvents: 0 }, 1); perYear.push(s0 - mRef.seDb); }
  const mClamp = new E.EnvironmentalAgingModel({ nominalSeDb: 1, params: { ...E.DEFAULT_ENV_AGING_PARAMS, noiseSigma: 0, th: { ...E.DEFAULT_ENV_AGING_PARAMS.th, dbPerYearAtRef: 50 } } });
  for (let h = 0; h < E.HOURS_PER_YEAR; h++) mClamp.step({ tempC: 25, rh: 50 }, 1);
  chk("P2 Referans ortamda (25 °C, %50, titreşim/kapı yok) model zamana-bağlı DOĞRUSAL dB kaybına indirgenir (her yıl tam 2,0 dB); sızıntı 1'de (0 dB) tavanlanır — hardware_aging_model ile aynı fizik",
    perYear.every((x) => Math.abs(x - 2.0) < 1e-6) && mClamp.seDb === 0,
    `yıllık kayıp ${perYear.map((x) => x.toFixed(6)).join(" / ")} dB · 1 dB'den 50 dB/yıl ile 1 yıl → SE ${mClamp.seDb} dB (tavan)`);

  // ══ P3 Çevre farkı: aynı birim, dört saha ══
  const site = {};
  for (const cls of ["dc", "dcHvac", "cabinet", "rail"]) {
    const u = buildUnit(900, 4242, { cls, startSe: 60, scale: 1 });
    site[cls] = { lossPerYear: +(u.cum[E.HOURS_PER_YEAR] - u.cum[0]).toFixed(2), channels: Object.fromEntries(Object.entries(u.byChannel).map(([k, v]) => [k, +(v * E.HOURS_PER_YEAR / H_TRUTH).toFixed(2)])) };
  }
  chk("P3 Aynı kafes, aynı ölçek: yıllık kayıp sahaya göre farklı ve baskın mekanizma değişiyor (ray yanı: titreşim; sokak dolabı: termal döngü + kapı; HVAC arızası: kısa süreli ısı-nem sıçraması)",
    site.rail.lossPerYear > 2 * site.dc.lossPerYear && site.cabinet.lossPerYear > site.dc.lossPerYear && site.rail.channels.vib > site.rail.channels.th && site.cabinet.channels.tc > 0.3,
    Object.entries(site).map(([k, v]) => `${k}: ${v.lossPerYear} dB/yıl ${JSON.stringify(v.channels)}`).join(" · ") +
    ` — NOT: sokak dolabında ısınma bağıl nemi düşürdüğü için (Magnus ~%6/°C) ısı-nem kanalı veri merkezinden çok yüksek DEĞİL`);

  // ══ Filo: 40 birim, açık döngü (bakımsız) — uyarı öncülüğü, doğruluk ══
  const fleet = Array.from({ length: 40 }, (_, i) => buildUnit(i, 5000 + 31 * i));
  const runEnv = new Map(), runTime = new Map();
  for (const u of fleet) { runEnv.set(u.id, runUnit(u, "open-env")); runTime.set(u.id, runUnit(u, "open-time")); }
  const LS = { env: leadStats(fleet, runEnv), time: leadStats(fleet, runTime) };
  const ACC = { env: rulAccuracy(fleet, runEnv), time: rulAccuracy(fleet, runTime) };
  out.fleet = { units: fleet.map((u) => ({ id: u.id, cls: u.cls, unitScale: +u.unitScale.toFixed(2), se0: +u.se0.toFixed(1), bias: +u.bias.toFixed(2), startDayOfYear: Math.floor(u.startH / 24) })),
    lead: { env: { ...LS.env, rows: undefined }, time: { ...LS.time, rows: undefined } }, rows: LS.env.rows.map((r, i) => ({ ...r, timeAdvDay: LS.time.rows[i].advDay, timeWarnDay: LS.time.rows[i].warnDay })), rulAccuracy: ACC };

  // P4 ölçek öğrenme
  const scaleErr = fleet.map((u) => { const ev = runEnv.get(u.id).events; const m = makeMonitor(u, "environmental", 77, u.se0 + u.bias); for (let k = 0; k < 120 * 24; k++) m.ingest(u.startH + k, { seDb: u.se0 - u.cum[k + 1] + u.bias + u.noise[k] + u.artefact[k], env: u.env[k] }); return { true: u.unitScale, est: m.kf.x[1], sd: Math.sqrt(m.kf.P[1][1]) }; });
  const relErr = scaleErr.map((x) => Math.abs(x.est - x.true) / x.true).sort((a, b) => a - b);
  const cover = scaleErr.filter((x) => Math.abs(x.est - x.true) <= 1.645 * x.sd).length;
  out.scaleLearning = { medianRelErr: +relErr[20].toFixed(3), p90RelErr: +relErr[36].toFixed(3), coverage90: cover / 40 };
  chk("P4 Gizli birim ölçeği 120 günlük veriden öğreniliyor (çevresel sensörler + SE): medyan göreli hata küçük, %90 güven aralığı gerçeği büyük çoğunlukla kapsıyor",
    relErr[20] < 0.2 && cover / 40 >= 0.8,
    `40 birimde medyan |ŝ−s|/s = ${(100 * relErr[20]).toFixed(1)}% · p90 ${(100 * relErr[36]).toFixed(1)}% · %90 aralık kapsaması ${cover}/40 (önsel N(1; 0,8²), gerçek ölçekler 0,5–4,5)`);

  chk("P5 Erken uyarı (filo, bakımsız 2 yıl): eşiği geçen HER birim için WARNING eşikten önce geldi, hiçbir ADVISORY 30 günden az önce gelmedi (bu karışık filoda iki tahminci benzer — fark P7/P13'te)",
    LS.env.crossingUnits >= 10 && LS.env.warningMissed === 0 && LS.env.advisoryLate30 === 0,
    `eşiği geçen ${LS.env.crossingUnits}/40 birim · çevre-duyarlı: WARNING kaçırma ${LS.env.warningMissed}, ADVISORY <30 gün ${LS.env.advisoryLate30}, medyan öncülük ADVISORY ${LS.env.medianAdvisoryLeadDays?.toFixed(0)} gün / WARNING ${LS.env.medianWarningLeadDays?.toFixed(0)} gün · ` +
    `zaman-tabanlı: WARNING kaçırma ${LS.time.warningMissed}, ADVISORY <30 gün ${LS.time.advisoryLate30}, medyan ${LS.time.medianAdvisoryLeadDays?.toFixed(0)} / ${LS.time.medianWarningLeadDays?.toFixed(0)} gün`);
  chk("P6 Yanlış/erken alarm: RUL-tabanlı hiçbir WARNING/CRITICAL gerçek kalan ömür 56 günden fazlayken, hiçbir ADVISORY 240 günden fazlayken gelmiyor; eşiği hiç geçmeyen birimde WARNING yok. Modelden bağımsız marj kuralının erken alarmları AYRICA sayılıyor (bilinçli bedel)",
    LS.env.prematureWarnings === 0 && LS.env.prematureAdvisories === 0 && LS.env.falseWarnings === 0,
    `çevre-duyarlı: RUL-tabanlı erken WARNING ${LS.env.prematureWarnings}, erken ADVISORY ${LS.env.prematureAdvisories}, marj kuralından erken CRITICAL ${LS.env.prematureByMargin} · zaman-tabanlı: ${LS.time.prematureWarnings} / ${LS.time.prematureAdvisories} / ${LS.time.prematureByMargin} · ` +
    `geçmeyen ${LS.env.nonCrossingUnits} birimde WARNING ${LS.env.falseWarnings} · marj kuralı (SE ≤ eşik+0,5 dB) yavaş bozulan birimde ~2 ay erken çalar — model yanlış olsa bile eşiği uyarısız geçirmemenin bedeli`);
  const accTxt = (a) => [90, 60, 30, 14].map((d) => `${d}g: |hata| ${a[d].medianAbsErrDays} g, p10–p90 kapsama ${a[d].coverage80} (n=${a[d].n})`).join(" · ");
  const envBetter = [90, 60, 30].filter((d) => ACC.env[d].medianAbsErrDays <= ACC.time[d].medianAbsErrDays).length;
  chk("P7 Kalan ömür (RUL) doğruluğu: çevre-duyarlı tahminci 90/60/30 gün kala medyan mutlak hatada zaman-tabanlıdan kötü değil (en az 2/3 noktada daha iyi)",
    envBetter >= 2,
    `çevre-duyarlı → ${accTxt(ACC.env)} ║ zaman-tabanlı → ${accTxt(ACC.time)}`);

  // ══ P8 Kapalı döngü: otonom bakım planlayıcı ══
  const CL = {};
  for (const pol of ["env", "time", "reactive"]) {
    let hold = 0, nMaint = 0; const wasted = [];
    for (const u of fleet) { const r = runUnit(u, pol); hold += r.holdHours; nMaint += r.maint.length; for (const m of r.maint) if (pol !== "reactive") wasted.push(m.trueRulDays); }
    wasted.sort((a, b) => a - b);
    CL[pol] = { holdHours: hold, maintenances: nMaint, medianWastedLifeDays: wasted.length ? +wasted[Math.floor(wasted.length / 2)].toFixed(0) : null };
  }
  out.closedLoop = CL;
  chk("P8 Kapalı döngü (40 birim × 2 yıl): kestirimci bakımla kalkan HİÇ (ya da neredeyse hiç) HOLD eşiğine inmiyor; reaktif bakımda her geçiş en az sevk gecikmesi kadar HOLD üretiyor. Bedel: ömür dolmadan yapılan bakım",
    CL.env.holdHours <= 0.05 * CL.reactive.holdHours && CL.reactive.holdHours > 0,
    `HOLD saatleri: çevre-duyarlı ${CL.env.holdHours} · zaman-tabanlı ${CL.time.holdHours} · reaktif ${CL.reactive.holdHours} · bakım sayısı ${CL.env.maintenances} / ${CL.time.maintenances} / ${CL.reactive.maintenances} · ` +
    `bakım anında kalan gerçek ömür (medyan, boşa harcanan): çevre-duyarlı ${CL.env.medianWastedLifeDays} gün, zaman-tabanlı ${CL.time.medianWastedLifeDays} gün`);

  // ══ P9 Ani değişim (gevşeyen panel): öngörülemez, algılanır ══
  const uStep = buildUnit(100, 777, { cls: "dc", startSe: 58, scale: 1, stepAtDay: 400, stepDb: 9 });
  const rStep = runUnit(uStep, "open-env");
  const stepEv = rStep.events.find((e) => e.kind === "STEP_CHANGE");
  const preAlert = rStep.events.find((e) => e.kind === "ALERT" && e.k < 400 * 24);
  const falseSteps = fleet.reduce((s, u) => s + runEnv.get(u.id).events.filter((e) => e.kind === "STEP_CHANGE").length, 0);
  chk("P9 Ani SE düşüşü (400. gün, −9 dB): ÖNCEDEN uyarı yok (öngörülemez), ≤3 saat içinde STEP_CHANGE + muayene önerisi; filoda (adım içermeyen) hiç yanlış STEP_CHANGE yok",
    !preAlert && stepEv && stepEv.k - 400 * 24 <= 3 && falseSteps === 0,
    `STEP_CHANGE ${stepEv ? `${stepEv.k - 400 * 24} saat sonra, yenilik ${stepEv.innovationDb} dB, "${stepEv.action.slice(0, 70)}…"` : "YOK"} · adımdan önce uyarı: ${preAlert ? "VAR" : "yok"} · filoda yanlış STEP_CHANGE ${falseSteps}`);

  // ══ P10 Yanlış model (gerçek üsler farklı): uyarı yine eşikten önce ══
  const mis = { ...E.DEFAULT_ENV_AGING_PARAMS, th: { ...E.DEFAULT_ENV_AGING_PARAMS.th, n: 1.5, eaEv: 0.5 }, tc: { ...E.DEFAULT_ENV_AGING_PARAMS.tc, q: 1.5 }, vib: { ...E.DEFAULT_ENV_AGING_PARAMS.vib, b: 3 } };
  const fleetMis = Array.from({ length: 40 }, (_, i) => buildUnit(i, 5000 + 31 * i, { truthParams: mis }));
  const runMis = new Map(); for (const u of fleetMis) runMis.set(u.id, runUnit(u, "open-env"));
  const LSm = leadStats(fleetMis, runMis), ACCm = rulAccuracy(fleetMis, runMis);
  out.misspecified = { truth: { n: 1.5, eaEv: 0.5, q: 1.5, b: 3 }, lead: { ...LSm, rows: undefined }, rulAccuracy: ACCm };
  chk("P10 Model yanlış (gerçek n=1,5, Ea=0,5 eV, q=1,5, b=3; tahminci 2,7 / 0,79 / 2 / 4 varsayıyor): çevrimiçi ölçek kısmen telafi ediyor, WARNING yine hiçbir birimde kaçmıyor; doğruluk kaybı raporlanıyor",
    LSm.warningMissed === 0,
    `eşiği geçen ${LSm.crossingUnits} · WARNING kaçırma ${LSm.warningMissed} · ADVISORY <30 gün ${LSm.advisoryLate30} (doğru modelde ${LS.env.advisoryLate30}) · RUL |hata| 60 gün kala ${ACCm[60].medianAbsErrDays} g (doğru modelde ${ACC.env[60].medianAbsErrDays} g), kapsama ${ACCm[60].coverage80} — son savunma: tahmini SE ≤ eşik+0,5 dB → CRITICAL kuralı modelden bağımsız`);

  // ══ P13 Mevsimsel durağan-olmayanlık: kışın öğrenen, yazın eşiği geçen sokak dolapları ══
  const seasonal = { env: [], time: [] };
  for (let i = 0; i < 20; i++) {
    const u = buildUnit(200 + i, 9100 + 17 * i, { cls: "cabinet", startSe: 41.2 + 0.12 * i, scale: 2.0 });
    u.startH = 0; // 1 Ocak — çevre ve yörünge bu başlangıçla yeniden üretilir
    u.env = new E.SiteClimate(SITE_CLASSES.cabinet).realize({ startH: 0, hours: H_TRUTH, seed: 9100 + 17 * i });
    const m = new E.EnvironmentalAgingModel({ nominalSeDb: u.se0, unitScale: 2.0, seed: 3 + i });
    u.cum = new Float64Array(H_TRUTH + 1); for (let k = 0; k < H_TRUTH; k++) u.cum[k + 1] = u.cum[k] + m.step(u.env[k], 1).lossDb;
    const kc = trueCrossing(u);
    for (const [key, pol] of [["env", "open-env"], ["time", "open-time"]]) {
      const r = runUnit(u, pol);
      const adv = r.events.find((e) => e.kind === "ALERT");
      const c90 = r.rulChecks.find((c) => Math.abs((kc - c.k) / 24 - 90) <= 0.5);
      seasonal[key].push({ crossDay: kc / 24, advLeadDays: adv ? (kc - adv.k) / 24 : null, err90: c90 ? c90.p50 - (kc - c90.k) / 24 : null });
    }
  }
  const sMed = (a) => { const b = a.filter((x) => x != null && Number.isFinite(x)).map(Math.abs).sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const sMin = (a) => Math.min(...a.filter((x) => x != null));
  const S13 = { env: { medAbsErr90: sMed(seasonal.env.map((x) => x.err90)), meanErr90: seasonal.env.reduce((s, x) => s + (x.err90 || 0), 0) / 20, minAdvLead: sMin(seasonal.env.map((x) => x.advLeadDays)), late30: seasonal.env.filter((x) => x.advLeadDays == null || x.advLeadDays < 30).length },
    time: { medAbsErr90: sMed(seasonal.time.map((x) => x.err90)), meanErr90: seasonal.time.reduce((s, x) => s + (x.err90 || 0), 0) / 20, minAdvLead: sMin(seasonal.time.map((x) => x.advLeadDays)), late30: seasonal.time.filter((x) => x.advLeadDays == null || x.advLeadDays < 30).length } };
  out.seasonal = { units: 20, crossDays: seasonal.env.map((x) => Math.round(x.crossDay)), ...S13 };
  chk("P13 ÇEVRE FARKININ ASIL ÖNEMLİ OLDUĞU YER — kışın (1 Ocak) izlemeye başlanan, bahar/yaz sıcağında eşiği geçen 20 sokak dolabı: zaman-tabanlı tahminci kış hızını yaza taşıyıp kalan ömrü olduğundan UZUN sanıyor; çevre-duyarlı tahminci iklim öngörüsüyle bunu yakalıyor",
    S13.env.medAbsErr90 < S13.time.medAbsErr90 && S13.env.minAdvLead >= 30 && S13.env.late30 <= S13.time.late30,
    `eşik geçişleri ${Math.min(...out.seasonal.crossDays)}–${Math.max(...out.seasonal.crossDays)}. gün · 90 gün kala medyan |RUL hatası|: çevre ${S13.env.medAbsErr90.toFixed(1)} g, zaman ${S13.time.medAbsErr90.toFixed(1)} g · ortalama işaretli hata (+ = iyimser): çevre ${S13.env.meanErr90.toFixed(1)} g, zaman ${S13.time.meanErr90.toFixed(1)} g · ` +
    `en kısa ADVISORY öncülüğü: çevre ${S13.env.minAdvLead.toFixed(0)} g, zaman ${S13.time.minAdvLead.toFixed(0)} g · ADVISORY <30 gün: ${S13.env.late30} / ${S13.time.late30} — NOT: çevre-duyarlı da hafif İYİMSER (hava anomalileri dışbükey Arrhenius'ta ortalamayı yükseltir, klimatoloji bunu bilmez)`);

  // ══ P11 Kalkan karar katmanıyla uyum ══
  const ev60 = E.toCageEvaluation(45), ev25 = E.toCageEvaluation(25);
  const tr = new A.ShieldLevelTracker({ seRequiredDb: A.seRequiredForThreatDb(THREAT).seRequiredDb });
  chk("P11 Çıktı mevcut katmanlara takılıyor: toCageEvaluation → mtlsHandshakePrecondition (aynı şekil), RUL eşiği = ShieldLevelTracker'ın dışa-sızıntı eşiği",
    mtlsHandshakePrecondition(ev60).allowed === false && mtlsHandshakePrecondition(ev25).emergencyBreach === true && Math.abs(tr.egressThresholdDb - THR) < 1e-12,
    `SE 45 → precondition allowed=${mtlsHandshakePrecondition(ev60).allowed} (hedef 60) · SE 25 → acil taban ihlali=${mtlsHandshakePrecondition(ev25).emergencyBreach} · eşik ${THR.toFixed(2)} dB = tracker ${tr.egressThresholdDb.toFixed(2)} dB`);

  // ══ P12 Belirlenimcilik + bütünlük ══
  const again = runUnit(fleet[3], "open-env");
  const same = JSON.stringify(again.events) === JSON.stringify(runEnv.get(3).events);
  const after = hashes();
  const unchanged = GUARDED.every((f) => before[f] === after[f]);
  const srcs = ["environmental_aging_model.js", "predictive_maintenance.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"));
  const noCore = srcs.every((s) => !/require\(["']\.\/photonnet_core\.js["']\)/.test(s));
  chk("P12 Belirlenimcilik ve bütünlük: aynı birim aynı olayları üretiyor; çekirdek + yeniden kullanılan modüllerin SHA-256'sı değişmedi; yeni modüller çekirdeği import etmiyor",
    same && unchanged && noCore && after["photonnet_core.js"] === "157d81da543cabfafca4a58b69aac574ce7180ac760563cecd918c666581cf3b",
    `olaylar ${same ? "birebir" : "FARKLI"} · ${GUARDED.length} dosya SHA-256 ${unchanged ? "değişmedi" : "DEĞİŞTİ"} · core import ${noCore ? "yok" : "VAR"} · süre ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  out.allChecksPassed = out.checks.every((c) => c.ok);
  const rep = path.join(__dirname, "reports", "predictive_maintenance.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ KESTİRİMCİ DONANIM YAŞLANMASI — çevresel sensörler + erken bakım sinyali ══\n");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"} (${out.checks.filter((c) => c.ok).length}/${out.checks.length})`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main, buildUnit, runUnit, trueCrossing, THR };
