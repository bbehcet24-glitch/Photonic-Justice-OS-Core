#!/usr/bin/env node
"use strict";
/**
 * cabinet_lock_hal_test.js — kabin kilidi HAL'i: doorMayOpen() → imzalı açma
 * yetkisi → (simüle) akıllı kilit / HTTP kilit API'si → kapı sensörü → koordinatör.
 * ═══════════════════════════════════════════════════════════════════
 *   H1 Yetki belgesi kriptografisi (Ed25519): geçerli kabul; kurcalanmış, başka anahtarla
 *      imzalanmış, başka düğüm, erken/geç, kilit sınırını aşan ömür, tekrar, bayat
 *      boşaltma beyanı → RED (kilitli kalır)
 *   H2 Kilitleme şartı (interlock): pencere başlamadan / ağ planı düğümü kullanırken
 *      koordinatör yetki VERMEZ; yetkisiz kapı açılamaz
 *   H3 Fail-secure: eyleyici arızası, açılmayan kapının otomatik yeniden kilidi,
 *      API yanıtsız (zaman aşımı) → kilit KİLİTLİ
 *   H4 Gerçek HTTP API üzerinden uçtan uca: yetki → açma → yetkili giriş → kapanış →
 *      yeniden kilit; olaylar HTTP ile alınıyor; tekrar ve sahte belge reddi
 *   H5 Zorla açma: kapı sensörü + olay-tetikli yeniden planlama, SE izleyicisini beklemeye
 *      göre teslimat-yolu maruziyetini ölçülebilir biçimde düşürüyor (Monte Carlo, faz rastgele)
 *   H6 Koordineli bakım (ağ + kilit, simülasyon zamanı): maruziyet 0; mekanik acil anahtar →
 *      INCIDENT → düğüm anında ağ dışı → inceleme sonrası NORMAL
 *   + bütünlük
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("./cabinet_lock_hal.js");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const { MaintenanceTrafficCoordinator } = require("./maintenance_traffic_coordinator.js");
const { mulberry32 } = require("./hardware_aging_model.js");

const GUARDED = ["photonnet_core.js", "multinode_shielding_network.js", "adaptive_shielding_mitigation.js", "etsi014_kme_server.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = 50;
const H = (ms) => ms / 3.6e6;
const NOMINAL = Object.fromEntries(TB.TOPOLOGY.nodes.map((n) => [n.id, n.nominalSeDb]));

/** Simülasyon zamanlı ağ sürücüsü + KDK üzerinden geçen trafiğin "kapı açıldıktan sonra" payı. */
class NetDriver {
  constructor(cache) {
    this.net = new NET.ShieldedQkdNetwork({ topology: TB.TOPOLOGY, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6, optimizationCache: cache });
    this.y0 = Object.fromEntries(this.net.links.map((l) => [l.key, 1.1e-5]));
    this.kdkSe = NOMINAL.KDK; this.tOpen = Infinity; this.tClose = Infinity; this.lastT = null; this.exposureBits = 0; this.kdkBits = 0;
  }
  /** sample=true: SE izleyici örneği (KDK okuması güncellenir); false: olay-tetikli ara adım (yeni SE okuması yok). */
  step(t, hints, { sample = true } = {}) {
    if (sample) this.kdkReading = this.kdkSe;
    const se = { ...NOMINAL, KDK: this.kdkReading };
    const r = this.net.step(t, { se, y0: this.y0 }, hints);
    if (this.lastT != null && r.dtMs > 0) {
      // aralığın (tOpen, tClose] ile örtüşen payı — kafes AÇIKKEN geçen trafik
      const after = Math.max(0, Math.min(t, this.tClose) - Math.max(this.lastT, this.tOpen)) / r.dtMs;
      for (const d of r.demands) if (d.pathNodes.includes("KDK")) { this.kdkBits += d.deliveredBits; this.exposureBits += d.deliveredBits * after; }
    }
    this.lastT = t;
    return r;
  }
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();
  const cache = new Map();

  // ══ H1 Yetki belgesi kriptografisi ══
  let simNow = 1_000_000;
  const clock = () => simNow;
  const auth = new L.UnlockGrantAuthority();
  const rogue = new L.UnlockGrantAuthority();
  const mk = (over = {}, A = auth) => A.issue({ nodeId: "KDK", workOrderId: "WO-1", technicianId: "T-7", nbfMs: simNow, expMs: simNow + 120000, attestation: { drained: true, planCheckedAtMs: simNow, windowStartH: 1 }, ...over });
  const lockFresh = () => new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
  const tryTok = (tok) => { const lk = lockFresh(); const r = lk.unlock(tok); return { ok: r.ok, reason: r.reason, state: lk.state }; };
  const valid = tryTok(mk());
  const [pb, sb] = mk().split(".");
  const tamperedPayload = JSON.parse(Buffer.from(pb, "base64url")); tamperedPayload.nodeId = "KDK"; tamperedPayload.exp += 3600e3;
  const cases = {
    "kurcalanmış içerik": tryTok(`${Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url")}.${sb}`),
    "başka anahtarla imza": tryTok(mk({}, rogue)),
    "başka düğüm": tryTok(mk({ nodeId: "MSL" })),
    "henüz geçerli değil": tryTok(mk({ nbfMs: simNow + 60000, expMs: simNow + 120000 })),
    "süresi dolmuş": tryTok(mk({ nbfMs: simNow - 300000, expMs: simNow - 60000 })),
    "ömür kilit sınırını aşıyor": tryTok(mk({ expMs: simNow + 3600e3 })),
    "boşaltma beyanı yok": tryTok(mk({ attestation: { drained: false, planCheckedAtMs: simNow } })),
    "boşaltma beyanı bayat": tryTok(mk({ attestation: { drained: true, planCheckedAtMs: simNow - 60000 } })),
    "çözülemeyen belge": tryTok("çöp"),
  };
  const lkR = lockFresh(); const tok = mk(); const first = lkR.unlock(tok); lkR.lock(); const replay = lkR.unlock(tok);
  cases["tekrar (aynı belge)"] = { ok: replay.ok, reason: replay.reason, state: lkR.state };
  const allDenied = Object.values(cases).every((c) => !c.ok && c.state === "LOCKED");
  chk("H1 Ed25519 açma yetkisi: geçerli belge kabul; kurcalanmış, sahte anahtar, başka düğüm, zaman dışı, aşırı ömür, boşaltma beyanı yok/bayat, çözülemeyen ve TEKRAR kullanılan belgelerin hepsi reddediliyor ve kilit KİLİTLİ kalıyor",
    valid.ok && first.ok && allDenied,
    `geçerli: ${valid.ok ? "AÇILDI" : "✗"} · ` + Object.entries(cases).map(([k, v]) => `${k} → ${v.ok ? "AÇILDI ✗" : "red (" + v.reason + ")"}`).join(" · "));

  // ══ H2 Kilitleme şartı ══
  const d2 = new NetDriver(cache);
  const co2 = new MaintenanceTrafficCoordinator();
  const lk2 = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
  const hal2 = new L.InProcessLockAdapter([lk2]);
  co2.ingestEvent({ nodeId: "KDK", kind: "ALERT", level: "WARNING", atHours: 0 });
  co2.scheduleMaintenance({ nodeId: "KDK", dueH: H(5000), reason: "iş emri" }, H(600000));
  const refusals = [];
  let t = 0;
  for (; t <= 4000; t += DT) d2.step(t, co2.hints(H(t)));
  simNow = t;
  refusals.push(co2.authorizeDoor("KDK", H(t), d2.net, auth, { nowMs: simNow, workOrderId: "WO-2", technicianId: "T-7" }).reason);
  const openedEarly = lk2.physicalOpen({ atMs: simNow });
  for (; t < 5000; t += DT) d2.step(t, co2.hints(H(t)));
  co2.tick(H(5000));                                  // pencere başladı ama ağ henüz yeniden planlamadı
  simNow = 5000;
  refusals.push(co2.authorizeDoor("KDK", H(5000), d2.net, auth, { nowMs: simNow, workOrderId: "WO-2", technicianId: "T-7" }).reason);
  d2.step(5000, co2.hints(H(5000))); t = 5000 + DT;   // plan KDK'yı bırakır
  const g2 = co2.authorizeDoor("KDK", H(5000), d2.net, auth, { nowMs: simNow, workOrderId: "WO-2", technicianId: "T-7" });
  const u2 = await hal2.requestUnlock("KDK", g2.token);
  const opened = lk2.physicalOpen({ atMs: simNow + 2000 });
  chk("H2 Kilitleme şartı: pencereden önce ve ağ planı KDK'yı kullanırken koordinatör yetki VERMİYOR, kilitli kapı açılamıyor; plan KDK'yı bıraktıktan sonra yetki → kilit açılıyor → yetkili giriş",
    refusals.length === 2 && refusals.every(Boolean) && !openedEarly && g2.granted && u2.ok && opened && lk2.events.some((e) => e.type === "DOOR_OPENED" && e.authorized),
    `ret 1: "${refusals[0]}" · kilitliyken kapı açılabildi mi: ${openedEarly} · ret 2: "${refusals[1]}" · plan yenilendi → yetki ${g2.granted ? "verildi" : "✗"} → kilit ${u2.state} → kapı yetkili açıldı: ${opened}`);

  // ══ H3 Fail-secure ══
  const lk3 = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
  lk3.faults.actuatorStuck = true;
  const r3a = lk3.unlock(mk());
  const open3a = lk3.physicalOpen({});
  lk3.faults.actuatorStuck = false;
  const r3b = lk3.unlock(mk());
  simNow += L.LOCK_DEFAULTS.unlockWindowMs + 10; lk3.tick();
  const relocked = lk3.state === "LOCKED" && lk3.events.some((e) => e.type === "RELOCKED" && /penceresi doldu/.test(e.reason));
  // HTTP: denetleyici yanıt vermiyor
  const lockHttpDown = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem() });
  const srvDown = await new L.SimulatedLockApiServer([lockHttpDown]).start();
  srvDown.commsDown = true;
  const adDown = new L.HttpLockAdapter({ baseUrl: srvDown.baseUrl, timeoutMs: 400 });
  const t3 = Date.now();
  const tokLive = auth.issue({ nodeId: "KDK", workOrderId: "WO-3", technicianId: "T-7", nbfMs: Date.now(), expMs: Date.now() + 60000, attestation: { drained: true, planCheckedAtMs: Date.now() } });
  const r3c = await adDown.requestUnlock("KDK", tokLive);
  const waited = Date.now() - t3;
  await srvDown.stop();
  chk("H3 Fail-secure: eyleyici sıkışınca KİLİTLİ kalıyor (UNLOCK_FAILED) ve kapı açılamıyor; açılıp kapısı açılmayan kilit 30 s sonra kendiliğinden kilitleniyor; kilit API'si yanıt vermezse istemci zaman aşımında 'KİLİTLİ varsayılır' dönüyor ve kilit gerçekten kilitli",
    !r3a.ok && r3a.code === 503 && !open3a && lk3.events.some((e) => e.type === "UNLOCK_FAILED") && r3b.ok && relocked && !r3c.ok && /fail-secure/.test(r3c.reason) && waited < 1500 && lockHttpDown.state === "LOCKED",
    `sıkışık eyleyici → ${r3a.reason}, kapı açıldı mı: ${open3a} · onarım sonrası: ${r3b.ok ? "açıldı" : "✗ " + r3b.reason} → ${L.LOCK_DEFAULTS.unlockWindowMs / 1000} s içinde kapı açılmadı → ${lk3.state} · API yanıtsız → ${waited} ms sonra "${r3c.reason}", kilit ${lockHttpDown.state}`);

  // ══ H4 Gerçek HTTP API üzerinden uçtan uca ══
  const lock4 = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem() });
  const srv = await new L.SimulatedLockApiServer([lock4]).start();
  const ad = new L.HttpLockAdapter({ baseUrl: srv.baseUrl, timeoutMs: 2000 });
  const st0 = await ad.status("KDK");
  const tok4 = auth.issue({ nodeId: "KDK", workOrderId: "WO-4", technicianId: "T-9", nbfMs: Date.now(), expMs: Date.now() + 120000, attestation: { drained: true, planCheckedAtMs: Date.now() } });
  const u4 = await ad.requestUnlock("KDK", tok4);
  lock4.physicalOpen({}); lock4.physicalClose({});
  await new Promise((r) => setTimeout(r, 20));
  const ev4 = await ad.pollEvents("KDK", 0);
  const replay4 = await ad.requestUnlock("KDK", tok4);
  const forged4 = await ad.requestUnlock("KDK", rogue.issue({ nodeId: "KDK", workOrderId: "X", technicianId: "X", nbfMs: Date.now(), expMs: Date.now() + 60000, attestation: { drained: true, planCheckedAtMs: Date.now() } }));
  const st1 = await ad.status("KDK");
  await srv.stop();
  const types4 = ev4.map((e) => e.type);
  chk("H4 Gerçek HTTP kilit API'si (127.0.0.1): yetki → POST unlock 200 → yetkili giriş → kapanış → yeniden kilit; olaylar HTTP ile alınıyor; aynı belgenin tekrarı ve sahte imzalı belge 403",
    st0.state === "LOCKED" && u4.ok && u4.httpStatus === 200 && ["UNLOCKED", "DOOR_OPENED", "DOOR_CLOSED", "RELOCKED"].every((x) => types4.includes(x)) && replay4.httpStatus === 403 && forged4.httpStatus === 403 && st1.state === "LOCKED",
    `${srv.baseUrl} · durum ${st0.state} → unlock HTTP ${u4.httpStatus} (${u4.state}) → olaylar [${types4.join(", ")}] · tekrar HTTP ${replay4.httpStatus} "${replay4.reason}" · sahte HTTP ${forged4.httpStatus} "${forged4.reason}" · son durum ${st1.state}`);

  // ══ H5 Zorla açma: kapı sensörü + olay-tetikli yeniden planlama ══
  const trial = (phaseMs, useSensor) => {
    const d = new NetDriver(cache);
    const co = new MaintenanceTrafficCoordinator();
    simNow = 0;
    const lk = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
    const tOpen = 3000 + phaseMs;
    let seen = 0, sensorStepDone = false;
    for (let tt = 0; tt <= 3200; tt += DT) {
      // kapı sensör olayı (gecikmeli) bu aralığa düşüyorsa: olay anında ara adım + yeniden planlama
      if (useSensor && !sensorStepDone && lk.door === "OPEN") {
        const evs = lk.eventsSince(seen, tt);
        for (const ev of evs) {
          seen = ev.seq;
          const res = co.onLockEvent(ev, H(ev.atMs));
          if (res.replanNow && ev.atMs < tt) { d.step(ev.atMs, co.hints(H(ev.atMs)), { sample: false }); sensorStepDone = true; }
        }
      }
      d.step(tt, co.hints(H(tt)));
      // fiziksel dünya: kapı tOpen anında zorla açılır; SE düşüşü yalnız ÖRNEK anlarında okunur
      if (tt < tOpen && tt + DT >= tOpen) { simNow = tOpen; lk.physicalOpen({ forced: true, atMs: tOpen }); d.tOpen = tOpen; d.kdkSe = 15; }
    }
    return { exposureBits: d.exposureBits, incident: co.mode("KDK") === "INCIDENT" };
  };
  const rng = mulberry32(2026);
  const N5 = 40; const exR = [], exS = []; let incidents = 0;
  for (let k = 0; k < N5; k++) { const ph = 1 + rng() * 48; exR.push(trial(ph, false).exposureBits); const s = trial(ph, true); exS.push(s.exposureBits); if (s.incident) incidents++; }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const KDK_BPS = 160000; // MSL↔KDK 60k + AVR↔KDK 40k + BKR↔ATS transit 60k
  out.forcedOpen = { trials: N5, meanExposureBitsSeOnly: Math.round(mean(exR)), maxExposureBitsSeOnly: Math.round(Math.max(...exR)), meanExposureBitsDoorSensor: Math.round(mean(exS)), maxExposureBitsDoorSensor: Math.round(Math.max(...exS)), sensorLatencyMs: L.LOCK_DEFAULTS.sensorLatencyMs };
  chk("H5 Zorla açma (40 deneme, açılış fazı rastgele): yalnız SE izleyicisiyle maruziyet bir sonraki 50 ms örneğine kadar sürüyor; kapı sensörü + olay-tetikli yeniden planlamayla sensör gecikmesine (5 ms) iniyor; her denemede INCIDENT",
    mean(exS) < 0.35 * mean(exR) && Math.max(...exS) <= KDK_BPS * (L.LOCK_DEFAULTS.sensorLatencyMs + 1) / 1000 && incidents === N5,
    `yalnız SE: ortalama ${out.forcedOpen.meanExposureBitsSeOnly} bit, en çok ${out.forcedOpen.maxExposureBitsSeOnly} bit (≈160 bit/ms × açılıştan sonraki örneğe kalan süre) · kapı sensörü: ortalama ${out.forcedOpen.meanExposureBitsDoorSensor} bit, en çok ${out.forcedOpen.maxExposureBitsDoorSensor} bit (160 bit/ms × 5 ms = 800) · INCIDENT ${incidents}/${N5} — NOT: sıfır değil; zorla açmada maruziyet ancak sensör gecikmesine kadar küçülür`);

  // ══ H6 Koordineli bakım + mekanik acil anahtar ══
  const d6 = new NetDriver(cache);
  const co6 = new MaintenanceTrafficCoordinator();
  simNow = 0;
  const lk6 = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
  const hal6 = new L.InProcessLockAdapter([lk6]);
  co6.ingestEvent({ nodeId: "KDK", kind: "ALERT", level: "WARNING", atHours: 0 });
  co6.scheduleMaintenance({ nodeId: "KDK", dueH: H(10000), reason: "iş emri" }, H(20000));
  const tl = []; let doorOpenAt = null, seen6 = 0, granted6 = null;
  for (let tt = 0; tt <= 40000; tt += DT) {
    simNow = tt;
    const r = d6.step(tt, co6.hints(H(tt)));
    for (const ev of await hal6.pollEvents("KDK", seen6, tt)) { seen6 = ev.seq; const res = co6.onLockEvent(ev, H(tt)); tl.push(`${ev.type}@${ev.atMs}${res.replanNow ? "→INCIDENT" : ""}`); }
    if (!granted6 && tt >= 10000) {
      const g = co6.authorizeDoor("KDK", H(tt), d6.net, auth, { nowMs: tt, workOrderId: "WO-6", technicianId: "T-7" });
      if (g.granted) { granted6 = tt; const u = await hal6.requestUnlock("KDK", g.token); tl.push(`yetki+unlock@${tt}:${u.state}`); }
    }
    if (granted6 && doorOpenAt == null && tt >= granted6 + 1000) { lk6.physicalOpen({ atMs: tt }); doorOpenAt = tt; d6.tOpen = tt; d6.kdkSe = 15; }
    if (doorOpenAt != null && tt === doorOpenAt + 15000) { lk6.physicalClose({ atMs: tt }); d6.kdkSe = 64; d6.tClose = tt; }
    if (tt === 30000) { co6.completeMaintenance("KDK", H(tt)); tl.push(`bakım tamamlandı@${tt}`); }
    void r;
  }
  const modeAfterMaint = co6.mode("KDK");
  // mekanik acil anahtar normal işletimde
  const d7 = new NetDriver(cache); const co7 = new MaintenanceTrafficCoordinator(); simNow = 0;
  const lk7 = new L.SimulatedSmartLock({ nodeId: "KDK", authorityPublicKey: auth.publicKeyPem(), clock });
  let incidentAt = null, kdkExcludedAt = null, seen7 = 0;
  for (let tt = 0; tt <= 3000; tt += DT) {
    simNow = tt;
    for (const ev of lk7.eventsSince(seen7, tt)) { seen7 = ev.seq; const res = co7.onLockEvent(ev, H(tt)); if (res.replanNow && incidentAt == null) incidentAt = tt; }
    const r = d7.step(tt, co7.hints(H(tt)));
    if (incidentAt != null && kdkExcludedAt == null && !d7.net.planUsesNode("KDK")) kdkExcludedAt = tt;
    if (tt === 1500) lk7.mechanicalOverride({ atMs: tt });
    void r;
  }
  co7.clearIncident("KDK", H(3000));
  chk("H6 Koordineli bakım (ağ + kilit): yetki ancak boşaltmadan sonra, kapı açıkken KDK'dan geçen bit 0, kapanış → yeniden kilit → bakım tamamlandı → NORMAL; normal işletimde mekanik acil anahtar → OVERRIDE → INCIDENT → aynı adımda düğüm plan dışı → inceleme sonrası NORMAL",
    d6.exposureBits === 0 && granted6 >= 10000 && modeAfterMaint === "NORMAL" && tl.some((x) => x.startsWith("DOOR_OPENED")) && !tl.some((x) => x.includes("INCIDENT")) &&
    incidentAt != null && kdkExcludedAt === incidentAt && co7.incidents.length === 1 && co7.mode("KDK") === "NORMAL",
    `zaman çizelgesi: ${tl.join(" · ")} · kapı açıkken KDK'dan geçen ${d6.exposureBits} bit · bakım sonrası mod ${modeAfterMaint} · acil anahtar 1500 ms → olay ${incidentAt} ms'de işlendi, plan KDK'yı ${kdkExcludedAt} ms'de bıraktı · olay kaydı: ${co7.incidents.map((i) => i.type).join(",")} · bildirim: "${co7.notices[0].message.slice(0, 60)}…"`);

  const after = hashes();
  const unchanged = GUARDED.every((f) => before[f] === after[f]);
  chk("Bütünlük: çekirdek, ağ, karar katmanı ve KME sunucusu SHA-256'sı test boyunca değişmedi; kilit HAL'i çekirdeği import etmiyor",
    unchanged && after["photonnet_core.js"] === "5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313" && !/require\(["']\.\/photonnet_core/.test(fs.readFileSync(path.join(__dirname, "cabinet_lock_hal.js"), "utf8")),
    `${GUARDED.length} dosya ${unchanged ? "değişmedi" : "DEĞİŞTİ"}`);

  out.allChecksPassed = out.checks.every((x) => x.ok);
  const rep = path.join(__dirname, "reports", "cabinet_lock_hal.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ KABİN KİLİDİ HAL'i — doorMayOpen() → imzalı yetki → akıllı kilit API'si ══\n");
  for (const x of out.checks) console.log(`  ${x.ok ? "✓" : "✗"} ${x.name}\n      ${x.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"} (${out.checks.filter((x) => x.ok).length}/${out.checks.length})`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
module.exports = { main };
