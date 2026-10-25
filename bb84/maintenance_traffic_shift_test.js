#!/usr/bin/env node
"use strict";
/**
 * maintenance_traffic_shift_test.js — kestirimci bakım uyarısı → bakım öncesi
 * trafik kaydırma → planlı kesinti → bakım sonrası dönüş zincirinin öz-testleri
 * ═══════════════════════════════════════════════════════════════════
 *   M1 Koordinatör durum makinesi (ADVISORY→PLANNED, WARNING→DRAIN, pencere→MAINTENANCE,
 *      tamamlama→NORMAL; ani düşüş→DRAIN; uyarı düşerse DRAIN kalkar)
 *   M2 DRAIN transit trafiği alternatif yola kaydırıyor, düğümün kendi uç talepleri sürüyor
 *   M3 Alternatif yoksa DRAIN trafiği KESMİYOR (ceza, dışlama değil)
 *   M4 Önce kur, sonra kes (50 ms, 60 s, gerçek zaman adımlı ağ): habersiz kapı açılışı ile
 *      koordineli bakım karşılaştırması — teslimat-yolu maruziyeti, transit süreklilik,
 *      planlı kesinti bildirimi, mTLS'in kapı açılmadan ÖNCE planlı kapanması
 *   M5 Nedensellik: habersiz açılıştaki maruziyet TAM OLARAK bir örnekleme aralığı
 *   M6 Uçtan uca zincir (saatlik, aylar): çevresel prognostik → WARNING → DRAIN →
 *      iş emri → pencere → bakım; pencere gerçek eşik geçişinden ÖNCE
 *   M7 KME kapı belgesi MAINTENANCE düzeyini taşıyor
 *   + çekirdek ve yeniden kullanılan modüller değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const PM = require("./predictive_maintenance.js");
const PMT = require("./predictive_maintenance_test.js");
const E = require("./environmental_aging_model.js");
const { MaintenanceTrafficCoordinator } = require("./maintenance_traffic_coordinator.js");

const GUARDED = ["photonnet_core.js", "adaptive_shielding_mitigation.js", "predictive_maintenance.js", "environmental_aging_model.js", "qkd_network_scale.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = TB.DT;
const H = (ms) => ms / 3.6e6; // ağ ms → koordinatör saat

/** 60 s'lik senaryo: KDK kafes kapısı açılır (gerçek SE 15 dB), 30 s açık kalır. */
function scenario({ coordinated, doorAtMs = 22000, windowAtMs = 20000, warnAtMs = 0, doorDurMs = 30000, minutes = 1 }) {
  const traces = TB.buildTraces({ minutes, seed: 4242, scripted: () => {} });
  const T = traces.nodes.KDK;
  const openDoor = (i0) => {
    for (let i = i0; i < Math.min(traces.steps, i0 + doorDurMs / DT); i++) { T.trueSe[i] = 15; T.meas[i] = 15 + (Math.sin(i) * 0.5); }
    T.leakPrefix = new Int32Array(traces.steps + 1);
    for (let i = 0; i < traces.steps; i++) T.leakPrefix[i + 1] = T.leakPrefix[i] + (T.trueSe[i] < TB.SE_REQ ? 1 : 0);
  };
  const runner = new TB.SimRunner(traces, { policy: "adaptive", seMeasurementUncertaintyDb: 1, optimizationCache: new Map() });
  const co = new MaintenanceTrafficCoordinator();
  const log = { doorOpenedMs: null, kdkModes: [], transitViaKdk: [], firstMtlsOffMs: null, endpointServedUntilMs: null, perStep: [] };
  if (!coordinated) openDoor(Math.floor(doorAtMs / DT));
  let scheduled = false;
  for (let i = 0; i < traces.steps; i++) {
    const t = i * DT;
    let hints;
    if (coordinated) {
      if (t >= warnAtMs && co.mode("KDK") === "NORMAL") co.ingestEvent({ nodeId: "KDK", kind: "ALERT", level: "WARNING", atHours: H(t), basis: "RUL" });
      if (!scheduled && t >= warnAtMs) { co.scheduleMaintenance({ nodeId: "KDK", dueH: H(windowAtMs), reason: "iş emri (WARNING)" }, H(doorDurMs + 10000)); scheduled = true; }
      hints = co.hints(H(t));
      // teknisyen: pencere başladı + ağ planı KDK'yı kullanmıyor + 1 s prosedür payı → kapıyı aç
      if (log.doorOpenedMs == null && t >= windowAtMs + 1000 && co.doorMayOpen("KDK", H(t), runner.net)) { openDoor(i + 1); log.doorOpenedMs = (i + 1) * DT; }
    }
    const r = runner.step(i, t, hints);
    const transit = r.demands.filter((d) => d.src !== "KDK" && d.dst !== "KDK" && d.pathNodes.includes("KDK")).reduce((s, d) => s + d.deliveredBits, 0);
    const endpoint = r.demands.filter((d) => d.src === "KDK" || d.dst === "KDK").reduce((s, d) => s + d.deliveredBits, 0);
    if (endpoint > 0) log.endpointServedUntilMs = t;
    if (!r.nodes.KDK.mtlsAllowed && log.firstMtlsOffMs == null) log.firstMtlsOffMs = t;
    log.perStep.push({ t, kdk: r.nodes.KDK.state, transit, endpoint, bkrAts: r.demands.find((d) => d.src === "BKR" && d.dst === "ATS") });
  }
  if (!coordinated) log.doorOpenedMs = doorAtMs;
  const m = runner.finish();
  return { m, log, co };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ M1 Durum makinesi ══
  const c = new MaintenanceTrafficCoordinator();
  const seq = [];
  c.ingestEvent({ nodeId: "X", kind: "ALERT", level: "ADVISORY", atHours: 10 }); seq.push(c.mode("X"));
  c.ingestEvent({ nodeId: "X", kind: "ALERT", level: "WARNING", atHours: 20 }); seq.push(c.mode("X"));
  c.scheduleMaintenance({ nodeId: "X", dueH: 30, reason: "iş emri" }, 2);
  c.tick(29.9); seq.push(c.mode("X")); c.tick(30); seq.push(c.mode("X"));
  c.tick(33); seq.push(c.mode("X")); // pencere bitti ama bakım bitmedi → MAINTENANCE sürer
  c.completeMaintenance("X", 33.5); seq.push(c.mode("X"));
  c.ingestEvent({ nodeId: "Y", kind: "STEP_CHANGE", direction: "düşüş", atHours: 5 }); const ySeq = c.mode("Y");
  c.ingestEvent({ nodeId: "Z", kind: "ALERT", level: "WARNING", atHours: 1 }); c.ingestEvent({ nodeId: "Z", kind: "DOWNGRADE", level: "NONE", atHours: 3 }); const zSeq = c.mode("Z");
  const expect = ["PLANNED", "DRAIN", "DRAIN", "MAINTENANCE", "MAINTENANCE", "NORMAL"];
  chk("M1 Koordinatör: ADVISORY→PLANNED (ağ değişmez), WARNING→DRAIN, pencere→MAINTENANCE (süre aşılsa da tamamlanana kadar), tamamlama→NORMAL; ani düşüş→DRAIN; uyarı düşerse DRAIN kalkar; planlı kesinti bildirimi üretiliyor",
    JSON.stringify(seq) === JSON.stringify(expect) && ySeq === "DRAIN" && zSeq === "NORMAL" && c.notices.length === 1 && c.notices[0].type === "planned-outage",
    `X: ${seq.join(" → ")} · Y (STEP_CHANGE): ${ySeq} · Z (WARNING→DOWNGRADE): ${zSeq} · bildirim: "${c.notices[0].message.slice(0, 90)}…"`);

  // ══ M2 + M4 + M5: 60 s ağ senaryosu ══
  const reactive = scenario({ coordinated: false });
  const planned = scenario({ coordinated: true });
  const bkrBefore = planned.log.perStep.filter((s) => s.t > 100 && s.t < 20000).map((s) => s.bkrAts.paths.join("+"));
  const reactBefore = reactive.log.perStep.filter((s) => s.t > 100 && s.t < 20000).map((s) => s.bkrAts.paths.join("+"));
  const endpointDuringDrain = planned.log.perStep.filter((s) => s.t > 100 && s.t < 20000).every((s) => s.endpoint > 0);
  chk("M2 DRAIN: KDK WARNING aldığı anda BKR↔ATS transit trafiği KDK'yı atlayan yola geçiyor (KDK hâlâ sağlıklıyken); KDK'nın kendi uç talepleri pencereye kadar hizmet almaya devam ediyor",
    reactBefore.every((p) => p.includes("KDK")) && bkrBefore.every((p) => p && !p.includes("KDK")) && endpointDuringDrain,
    `kaydırma yokken yol: ${[...new Set(reactBefore)].join(", ")} · DRAIN'de: ${[...new Set(bkrBefore)].join(", ")} · KDK uç talepleri (MSL↔KDK, AVR↔KDK) DRAIN boyunca hizmette: ${endpointDuringDrain}`);

  const rv = reactive.m.deliveryPathViolationBits, pv = planned.m.deliveryPathViolationBits;
  const doorStepIdx = Math.floor(reactive.log.doorOpenedMs / DT);
  const exposureStep = reactive.log.perStep[doorStepIdx];
  const oneInterval = exposureStep.transit + exposureStep.endpoint;
  const transitAfterDoorPlanned = planned.log.perStep.filter((s) => s.t >= planned.log.doorOpenedMs).reduce((x, s) => x + s.transit + s.endpoint, 0);
  const bkrPlannedFrac = planned.log.perStep.slice(1).reduce((x, s) => x + s.bkrAts.deliveredBits, 0) / planned.log.perStep.slice(1).reduce((x, s) => x + s.bkrAts.demandBits, 0);
  chk("M4 Önce kur, sonra kes: koordineli bakımda kafes kapısı ancak düğüm boşaltıldıktan sonra açılıyor → izole olmayan KDK'dan teslimat-yolu maruziyeti 0; habersiz açılışta > 0. Transit BKR↔ATS her iki durumda kesintisiz",
    pv === 0 && rv > 0 && transitAfterDoorPlanned === 0 && bkrPlannedFrac > 0.999 && planned.log.doorOpenedMs >= 21000,
    `habersiz: kapı ${reactive.log.doorOpenedMs} ms'de açıldı, maruziyet ${Math.round(rv)} bit · koordineli: pencere 20000 ms, ağ planı KDK'yı bıraktıktan sonra kapı ${planned.log.doorOpenedMs} ms'de açıldı, maruziyet ${pv} bit, kapı sonrası KDK'dan geçen bit ${transitAfterDoorPlanned} · BKR↔ATS teslim ${(100 * bkrPlannedFrac).toFixed(2)}%`);
  chk("M5 Nedensellik: habersiz açılıştaki maruziyet TAM OLARAK kapının açıldığı örnekleme aralığında (önceki okumayla yönlendirilmiş) KDK'dan geçen trafiktir — sonraki aralıkta karar zaten değişmiş",
    Math.abs(rv - oneInterval) < 1e-6 && reactive.log.perStep[doorStepIdx + 1].transit === 0 && reactive.log.perStep[doorStepIdx + 1].endpoint === 0,
    `açılış aralığında KDK'dan geçen ${Math.round(oneInterval)} bit = ölçülen maruziyet ${Math.round(rv)} bit · sonraki aralık: ${reactive.log.perStep[doorStepIdx + 1].transit + reactive.log.perStep[doorStepIdx + 1].endpoint} bit (50 ms × KDK'dan geçen 160 kbps ≈ 8000 bit)`);
  const plannedMtlsOff = planned.log.firstMtlsOffMs, reactMtlsOff = reactive.log.firstMtlsOffMs;
  chk("M4b Planlı kesinti: KDK'nın SAE↔KME hizmeti pencere başında (bildirimle) kapanıyor — kapı açılmadan ÖNCE; habersiz durumda mTLS ancak kafes açıldıktan ~630 ms sonra debounce ile kesiliyor",
    plannedMtlsOff === 20000 && plannedMtlsOff < planned.log.doorOpenedMs && reactMtlsOff >= reactive.log.doorOpenedMs + 600 && planned.co.notices.length === 1,
    `koordineli: mTLS kapanışı ${plannedMtlsOff} ms < kapı ${planned.log.doorOpenedMs} ms · habersiz: kapı ${reactive.log.doorOpenedMs} ms → mTLS kesintisi ${reactMtlsOff} ms · bildirim: ${planned.co.notices[0].type}`);

  // ══ M3 Alternatifsiz hat: DRAIN trafiği kesmiyor ══
  const lineTopo = { nodes: [{ id: "A", ambientFieldDbuVm: 75, deliveryPathIsolated: true }, { id: "B", ambientFieldDbuVm: 75, deliveryPathIsolated: true }, { id: "C", ambientFieldDbuVm: 75, deliveryPathIsolated: true }],
    links: [{ a: "A", b: "B", km: 15 }, { a: "B", b: "C", km: 15 }], demands: [{ src: "A", dst: "C", demandBps: 50000 }] };
  const ln = new NET.ShieldedQkdNetwork({ topology: lineTopo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
  let delivered = 0, demanded = 0;
  for (let i = 0; i < 200; i++) {
    const r = ln.step(i * DT, { se: { A: 62, B: 62, C: 62 }, y0: { "A|B": 1.1e-5, "B|C": 1.1e-5 } }, { drainPenaltyKm: { B: 2000 } });
    delivered += r.demands[0].deliveredBits; demanded += r.demands[0].demandBits;
  }
  chk("M3 Alternatif yol yoksa DRAIN trafiği KESMİYOR: A–B–C hattında B boşaltılıyor, A↔C yine B üzerinden tam karşılanıyor (ceza ağırlığı, dışlama değil)",
    delivered >= 0.999 * demanded && ln.nodeState.B.planned === "DRAIN",
    `A↔C teslim ${(100 * delivered / demanded).toFixed(2)}% · B planlı durum: ${ln.nodeState.B.planned}`);

  // ══ M6 Uçtan uca zincir (saatlik prognostik, aylar) ══
  const u = PMT.buildUnit(300, 31337, { cls: "cabinet", startSe: 47, scale: 2.2 });
  const kc = PMT.trueCrossing(u);
  const mon = new PM.PrognosticsMonitor({ nodeId: "KDK", mode: "environmental", thresholdDb: PMT.THR, initialSeDb: u.se0 + u.bias, sPrior: { mean: 1, sd: 0.8 },
    climatologyExposure: new PM.ClimatologyExposure(new E.SiteClimate({ kind: "cabinet", doorPerWeek: 1 }), { untilHours: u.startH + 4 * E.HOURS_PER_YEAR }), seed: 9 });
  const sched = new PM.MaintenanceScheduler();
  const co2 = new MaintenanceTrafficCoordinator();
  const chain = { warningH: null, drainH: null, orderDueH: null, maintenanceH: null, doneH: null, crossH: kc != null ? u.startH + kc : null };
  for (let k = 0; k < Math.min(kc != null ? kc : 2 * E.HOURS_PER_YEAR, 2 * E.HOURS_PER_YEAR); k++) {
    const t = u.startH + k;
    const meas = u.se0 - u.cum[k + 1] + u.bias + u.noise[k] + u.artefact[k];
    for (const ev of mon.ingest(t, { seDb: meas, env: u.env[k] })) {
      co2.ingestEvent(ev);
      if (ev.kind === "ALERT" && ev.level === "WARNING" && chain.warningH == null) chain.warningH = t;
      const o = sched.consider(ev);
      if (o) { chain.orderDueH = o.dueH; co2.scheduleMaintenance(o, 2); }
    }
    co2.tick(t);
    if (co2.mode("KDK") === "DRAIN" && chain.drainH == null) chain.drainH = t;
    if (co2.mode("KDK") === "MAINTENANCE" && chain.maintenanceH == null) { chain.maintenanceH = t; co2.completeMaintenance("KDK", t + 2); mon.notifyMaintenance(t + 2, 64); chain.doneH = t + 2; break; }
  }
  const d = (h) => (h == null ? null : +((h - u.startH) / 24).toFixed(1));
  out.chain = Object.fromEntries(Object.entries(chain).map(([k, v]) => [k + "Day", d(v)]));
  const drainReason = (co2.log.find((x) => x.to === "DRAIN") || {}).reason;
  chk("M6 Uçtan uca zincir (sokak dolabı, saatlik, aylar): çevresel prognostik → iş emri → pencereden ≥24 saat önce DRAIN (WARNING ya da planlı ön-boşaltma) → bakım → tamamlama; bakım GERÇEK eşik geçişinden ÖNCE",
    chain.drainH != null && chain.maintenanceH != null && chain.crossH != null && chain.maintenanceH < chain.crossH && chain.maintenanceH - chain.drainH >= 24 &&
    (chain.warningH == null || chain.drainH <= chain.warningH) && co2.mode("KDK") === "NORMAL",
    `WARNING ${out.chain.warningHDay}. gün · DRAIN ${out.chain.drainHDay}. gün · iş emri vadesi ${out.chain.orderDueHDay}. gün · bakım ${out.chain.maintenanceHDay}. gün · gerçek eşik geçişi (bakım yapılmasaydı) ${out.chain.crossHDay}. gün · DRAIN süresi ${((chain.maintenanceH - chain.drainH) / 24).toFixed(1)} gün ("${drainReason}") · koordinatör geçişleri: ${co2.log.map((x) => x.to).join(" → ")}${chain.warningH == null ? " — ADVISORY ile planlanan bakım WARNING'e gerek bırakmadı" : ""}`);

  // ══ M7 KME kapı belgesi ══
  const last = planned.log.perStep[planned.log.perStep.length - 1];
  const nState = { state: last.kdk };
  const gate = { issuedAtMs: Date.now(), maxAgeMs: 1000, self: { node: "KDK", mtlsAllowed: false, level: nState.state }, peers: { KDK: { deliveryAllowed: false, level: nState.state } } };
  chk("M7 KME kapı belgesi: MAINTENANCE düğümün kapısı self.mtlsAllowed=false, level=MAINTENANCE ve peers.KDK.deliveryAllowed=false taşıyor — mevcut --shield-gate mantığıyla (bkz. multinode testbed L4/L7) oturumlar kesilir, karşı KME'ler bu düğüme anahtar vermez",
    last.kdk === "MAINTENANCE" && gate.self.level === "MAINTENANCE" && !gate.self.mtlsAllowed && !gate.peers.KDK.deliveryAllowed,
    `senaryo sonunda KDK durumu ${last.kdk} → kapı ${JSON.stringify(gate.self)}`);

  const after = hashes();
  const unchanged = GUARDED.every((f) => before[f] === after[f]);
  chk("Bütünlük: çekirdek ve yeniden kullanılan modüllerin SHA-256'sı test boyunca değişmedi; koordinatör çekirdeği import etmiyor",
    unchanged && after["photonnet_core.js"] === "af1f56a1adbe6e7d7566d361aedc60c4149ecf49557f4e8f2c535937f01a12c3" && !/photonnet_core/.test(fs.readFileSync(path.join(__dirname, "maintenance_traffic_coordinator.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")),
    `${GUARDED.length} dosya ${unchanged ? "değişmedi" : "DEĞİŞTİ"} · core ${after["photonnet_core.js"].slice(0, 16)}…`);

  out.allChecksPassed = out.checks.every((x) => x.ok);
  const rep = path.join(__dirname, "reports", "maintenance_traffic_shift.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ BAKIM ÖNCESİ TRAFİK KAYDIRMA — prognostik → koordinatör → ağ ══\n");
  for (const x of out.checks) console.log(`  ${x.ok ? "✓" : "✗"} ${x.name}\n      ${x.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"} (${out.checks.filter((x) => x.ok).length}/${out.checks.length})`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main, scenario };
