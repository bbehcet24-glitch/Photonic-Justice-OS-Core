#!/usr/bin/env node
"use strict";
/**
 * mesh_optical_bypass_test.js — mesh izolasyonu, PARÇA 3/3: optik bypass
 * ═══════════════════════════════════════════════════════════════════
 *   B1 Planlayıcı (test ağı, KDK): doğrudan linki olan komşu çiftleri aday değil; sanal link
 *      uzunluğu iki fiberin toplamı, kayıp 3 + 1,5 dB; hız uzunlukla azalıyor; her fiber en çok
 *      bir çifte giriyor; seçilen çift en çok güvenilir ara düğüm tasarrufu sağlayan
 *   B2 Dışlama: karantinadaki ikinci komşu eşleştirmeye girmiyor; tasarrufsuz bypass seçilmiyor
 *   B3 Fizibilite: çok uzun fiberlerde sanal link hızı eşik altı → bypass önerilmiyor (dürüst rapor)
 *   B4 Kesim düğümü kurtarma (A–X–B hattı): X karantinada; bypass yokken A↔B tamamen kesik;
 *      bypass ile 20 s anahtarlama sonrası A↔B, X'e anahtar göstermeden sanal link üzerinden
 *   B5 Zaman çizelgesi (test ağı, 100 s): kilit INCIDENT → SWITCHING (fiberler hemen askıda)
 *      → 20 s → ACTIVE: BKR↔ATS doğrudan sanal linkte (güvenilir ara düğüm 3 → 0), KDK yolda yok;
 *      bağımsız prob temiz → PROBATION → sanal link askıda, REVERTING → 20 s → fiberler geri
 *      → CLEAR → transit KDK'ya dönüyor
 *   B6 Bilinen sınır: bypass KDK'nın tek verici fiberini aldığı için komşu kanıtı kayboluyor;
 *      bağımsız prob olmadan otomatik serbest bırakma YOK (operatör onayı gerekiyor)
 *   + photonnet_core.js ve yeniden kullanılan modüller değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const M = require("./mesh_isolation.js");

const CORE_SHA = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
const GUARDED = ["photonnet_core.js", "adaptive_shielding_mitigation.js", "qkd_network_scale.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = TB.DT;
const Q = M.QSTATES;
const Y0_BASE = 1.1e-5;

const mkNet = (topology) => new NET.ShieldedQkdNetwork({ topology, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
const lineTopo = (km) => ({
  nodes: ["A", "X", "B"].map((id) => ({ id, ambientFieldDbuVm: 80, deliveryPathIsolated: true, nominalSeDb: 62 })),
  links: [{ a: "A", b: "X", km }, { a: "X", b: "B", km }],
  demands: [{ src: "A", dst: "B", demandBps: 30000 }],
});

/**
 * Senaryo koşucusu. lockAt: {node: ms} tek örnekte kilit olayı; probeFn(t,id) → dB|null.
 * onStep(t, mesh) — operatör eylemleri için.
 */
function run(topology, { ms, lockAt = {}, probeFn = () => null, onStep = () => {}, meshOpts = {} }) {
  const net = mkNet(topology);
  const mesh = new M.MeshIsolationController(net, meshOpts);
  const se = Object.fromEntries(topology.nodes.map((n) => [n.id, n.nominalSeDb]));
  const ambient = Object.fromEntries(topology.nodes.map((n) => [n.id, n.ambientFieldDbuVm]));
  const steps = [];
  for (let i = 0; i < ms / DT; i++) {
    const t = i * DT;
    onStep(t, mesh);
    const y0 = Object.fromEntries(net.links.map((l) => [l.key, Y0_BASE])); // sanal linkler eklendikçe dahil
    const lockIncident = Object.fromEntries(Object.entries(lockAt).map(([id, at]) => [id, t === at]));
    const probe = Object.fromEntries(topology.nodes.map((n) => [n.id, probeFn(t, n.id)]));
    const hints = mesh.update(t, { se, y0, ambient, lockIncident, probe });
    const r = net.step(t, { se, y0 }, hints);
    steps.push({ t, r, phase: [...mesh.bypass.values()].map((b) => b.phase)[0] || null, q: Object.fromEntries(topology.nodes.map((n) => [n.id, mesh.qm.state(n.id)])) });
  }
  return { net, mesh, steps };
}
const demandOf = (s, src, dst) => s.r.demands.find((d) => d.src === src && d.dst === dst);
const firstT = (steps, pred) => { const s = steps.find(pred); return s ? s.t : null; };

function main() {
  const out = { generatedAt: new Date().toISOString(), part: "3/3 optik bypass", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ B1 Planlayıcı ══
  {
    const net = mkNet(TB.TOPOLOGY);
    const plan = M.planOpticalBypass(net, "KDK");
    const pairs = plan.candidates.map((c) => `${c.a}–${c.b}`).sort();
    const fiberKm = Object.fromEntries(net.links.filter((l) => l.a === "KDK" || l.b === "KDK").map((l) => [l.a === "KDK" ? l.b : l.a, l.km]));
    const kmOk = plan.candidates.every((c) => c.km === fiberKm[c.a] + fiberKm[c.b] && Math.abs(c.eta - NET.linkEta(c.km, { insertionLossDb: 4.5 })) < 1e-15);
    const byKm = [...plan.candidates].sort((x, y) => x.km - y.km);
    const mono = byKm.every((c, i) => i === 0 || c.rateBps < byKm[i - 1].rateBps);
    const used = plan.chosen.flatMap((c) => c.fibers);
    const disjoint = new Set(used).size === used.length;
    const ch = plan.chosen.map((c) => `${c.a}–${c.b}`);
    chk("B1 Planlayıcı (KDK): 6 komşu çiftinden doğrudan linki olan 2'si (MSL–ASY, ASY–ATS) aday değil → 4 aday; sanal link uzunluğu = iki fiberin toplamı, η 3 + 1,5 dB kayıpla; hız uzunlukla kesin azalıyor; seçilen fiberler ayrık; seçim BKR–ATS (BKR↔ATS'nin güvenilir ara düğümü 3 → 0)",
      plan.candidates.length === 4 && !pairs.some((p) => /MSL–ASY|ASY–MSL|ASY–ATS|ATS–ASY/.test(p)) && kmOk && mono && disjoint
        && ch.length === 1 && /^(BKR–ATS|ATS–BKR)$/.test(ch[0]) && plan.relayHopsSaved === 3,
      byKm.map((c) => `${c.a}–${c.b} ${c.km} km ${(c.rateBps / 1e3).toFixed(1)} kbps${c.feasible ? "" : " (eşik altı)"}`).join(" · ") + ` · seçilen: ${ch.join(", ")} · tasarruf ${plan.relayHopsSaved} ara düğüm`);
  }

  // ══ B2 Dışlama ══
  {
    const net = mkNet(TB.TOPOLOGY);
    const plan = M.planOpticalBypass(net, "KDK", { excluded: new Set(["ATS"]) });
    const touchesAts = plan.candidates.some((c) => c.a === "ATS" || c.b === "ATS") || plan.chosen.some((c) => c.a === "ATS" || c.b === "ATS");
    chk("B2 Dışlama + yarar şartı: ATS de karantinadayken KDK bypass planı ATS'yi hiçbir adaya koymuyor (kalan komşular BKR, MSL, ASY; MSL–ASY doğrudan bağlı → 2 aday); kalan adayların hiçbiri güvenilir ara düğüm tasarrufu sağlamadığı için bypass SEÇİLMİYOR (boşuna fiber askıya alınmaz)",
      !touchesAts && plan.candidates.length === 2 && plan.chosen.length === 0 && plan.relayHopsSaved === 0,
      `adaylar: ${plan.candidates.map((c) => `${c.a}–${c.b}`).join(", ")} · seçilen: ${plan.chosen.map((c) => `${c.a}–${c.b}`).join(", ") || "yok"} (tasarruf ${plan.relayHopsSaved})`);
  }

  // ══ B3 Fizibilite ══
  {
    const r = run(lineTopo(150), { ms: 200, lockAt: { X: 50 } });
    const plan = M.planOpticalBypass(r.net, "X", { excluded: new Set() });
    const act = r.mesh.actions.find((a) => a.nodeId === "X" && /OPTİK BYPASS/.test(a.action));
    chk("B3 Fizibilite: A–X–B hattında fiberler 150 + 150 km → sanal link 300 km'de hız eşik (10 kbps) altında; bypass ÖNERİLMİYOR ve neden raporlanıyor",
      plan.candidates.length === 1 && !plan.candidates[0].feasible && act && act.action === "OPTİK BYPASS YOK" && r.mesh.bypass.size === 0,
      `aday A–B ${plan.candidates[0].km} km, ${plan.candidates[0].rateBps.toExponential(2)} bps · eylem: ${act && act.action} (${act && act.reason})`);
  }

  // ══ B4 Kesim düğümü kurtarma ══
  {
    const off = run(lineTopo(20), { ms: 30000, lockAt: { X: 1000 }, meshOpts: { enableOpticalBypass: false } });
    const on = run(lineTopo(20), { ms: 30000, lockAt: { X: 1000 } });
    const win = (r, a, b) => r.steps.filter((s) => s.t > a && s.t <= b);
    const frac = (ss) => ss.reduce((x, s) => x + s.r.demands[0].deliveredBits, 0) / ss.reduce((x, s) => x + s.r.demands[0].demandBits, 0);
    const tAct = firstT(on.steps, (s) => s.phase === "ACTIVE");
    const firstDeliv = firstT(on.steps.filter((s) => s.t > 1000), (s) => s.r.demands[0].deliveredBits > 0);
    const late = win(on, 25000, 30000);
    const viaX = late.some((s) => s.r.demands[0].pathNodes.includes("X"));
    const vl = on.net.linkByKey.get("A|B");
    chk("B4 Kesim düğümü: A–X–B hattında X kilit olayıyla karantinada. Bypass YOKKEN A↔B 29 s boyunca %0 (dürüst kesinti); bypass ile 20 s anahtarlama → sanal A–B linki (40 km, via X) etkin, ilk blok sonrası A↔B tam karşılanıyor ve X hiçbir teslim yolunda değil",
      frac(win(off, 1050, 30000)) === 0 && tAct === 21000 && vl && vl.virtual && vl.via === "X" && vl.km === 40 && frac(late) > 0.999 && !viaX && firstDeliv > tAct,
      `bypass yok: %${(100 * frac(win(off, 1050, 30000))).toFixed(1)} · bypass: ACTIVE @${tAct} ms, ilk teslim @${firstDeliv} ms (sanal linkin havuzu boş başlıyor, ilk blok ${on.net.blockDurationMs} ms) · 25–30 s: %${(100 * frac(late)).toFixed(2)}, yol ${[...new Set(late.flatMap((s) => s.r.demands[0].paths))].join(" | ")}`);
  }

  // ══ B5 Zaman çizelgesi ══
  {
    const LOCK = 1000, PROBE_FROM = 30000;
    const r = run(TB.TOPOLOGY, { ms: 100000, lockAt: { KDK: LOCK }, probeFn: (t, id) => (id === "KDK" && t >= PROBE_FROM ? 0 : null) });
    const S = r.steps;
    const acts = r.mesh.actions.filter((a) => a.nodeId === "KDK");
    const at = (name) => (acts.find((a) => a.action === name) || {}).atMs;
    const tSw = at("OPTİK BYPASS ANAHTARLAMA BAŞLADI"), tAct = at("OPTİK BYPASS ETKİN"), tProb = at("GÖZETİM (PROBATION)"), tRev = at("OPTİK BYPASS GERİ ALINDI"), tClr = at("TEMİZ");
    const swStep = S.find((s) => s.t === LOCK);
    const suspendedAtLock = ["BKR|KDK", "ATS|KDK"].every((k) => swStep.r.links[k].level === "SUSPENDED");
    const active = S.filter((s) => s.t > tAct + 2000 && s.t < tProb);
    const bkr = (s) => demandOf(s, "BKR", "ATS");
    const direct = active.every((s) => bkr(s).paths.length && bkr(s).paths.every((p) => p === "BKR→ATS"));
    const kdkInActive = active.some((s) => s.r.demands.some((d) => d.pathNodes.includes("KDK")));
    const bkrFrac = active.reduce((x, s) => x + bkr(s).deliveredBits, 0) / active.reduce((x, s) => x + bkr(s).demandBits, 0);
    const reverting = S.filter((s) => s.t > tProb && s.t < tRev);
    const noVirtualInRev = reverting.every((s) => !bkr(s).paths.includes("BKR→ATS") && s.r.links["ATS|BKR"].level === "SUSPENDED");
    const afterClr = S.filter((s) => s.t > tClr + 2000);
    const backViaKdk = afterClr.length > 0 && afterClr.every((s) => bkr(s).paths.length && bkr(s).paths.every((p) => p.includes("KDK")));
    chk("B5a Bypass kurulumu: kilit INCIDENT @1 s → aynı adımda karantina + anahtarlama başladı, BKR–KDK ve KDK–ATS fiberleri HEMEN askıda; 20 s sonra sanal BKR–ATS linki etkin; etkin dönemde BKR↔ATS doğrudan BKR→ATS (güvenilir ara düğüm 0) ve hiçbir talep KDK'dan geçmiyor",
      tSw === LOCK && tAct === LOCK + 20000 && suspendedAtLock && direct && !kdkInActive && bkrFrac > 0.999,
      `anahtarlama @${tSw} · etkin @${tAct} · askıdaki fiberler: ${suspendedAtLock} · etkin dönemde BKR↔ATS: ${[...new Set(active.flatMap((s) => bkr(s).paths))].join(" | ")}, teslim %${(100 * bkrFrac).toFixed(2)} · KDK yolda: ${kdkInActive}`);
    chk("B5b Geri dönüş: bağımsız prob @30 s'den itibaren temiz → PROBATION @60 s; sanal link AYNI adımda askıda (REVERTING) ve BKR↔ATS uzun yola dönüyor; 20 s sonra fiberler geri bağlandı; CLEAR @90 s ve transit yeniden KDK üzerinden",
      tProb === PROBE_FROM + 30000 && tRev === tProb + 20000 && tClr === tProb + 30000 && noVirtualInRev && backViaKdk,
      `PROBATION @${tProb} · geri alındı @${tRev} · CLEAR @${tClr} · REVERTING'de BKR↔ATS: ${[...new Set(reverting.flatMap((s) => bkr(s).paths))].join(" | ") || "—"} · CLEAR sonrası: ${[...new Set(afterClr.flatMap((s) => bkr(s).paths))].join(" | ")}`);
  }

  // ══ B6 Bilinen sınır: komşu kanıtı kayboluyor ══
  {
    let cleared = null;
    const noProbe = run(TB.TOPOLOGY, { ms: 70000, lockAt: { KDK: 1000 } });
    const stuck = noProbe.steps.filter((s) => s.t > 1000).every((s) => s.q.KDK === Q.QUARANTINED);
    const ev = noProbe.mesh.lastEvidence.perNode.KDK;
    const withOp = run(TB.TOPOLOGY, { ms: 3000, lockAt: { KDK: 1000 }, onStep: (t, mesh) => { if (t === 2000) { mesh.qm.operatorClear("KDK", t); cleared = mesh.qm.state("KDK"); } } });
    chk("B6 Bilinen sınır: bypass KDK'nın TEK verici fiberini (KDK→ATS) aldığı için komşu kanıtı kayboluyor (neighbor = null); bağımsız prob yokken KDK 69 s boyunca karantinada kalıyor — kendi-raporu temiz olsa da; serbest bırakma yalnız operatör onayıyla",
      stuck && ev.neighbor === null && ev.self != null && cleared === Q.PROBATION,
      `69 s sonra: ${noProbe.mesh.qm.state("KDK")} · KDK kanıtı: self=${ev.self && ev.self.toFixed(2)}, neighbor=${ev.neighbor} · operatör onayı → ${cleared}`);
  }

  const after = hashes();
  chk("Çekirdek ve yeniden kullanılan modüller değişmedi (photonnet_core.js SHA-256 = 8f879fde…dc7b05)",
    after["photonnet_core.js"] === CORE_SHA && JSON.stringify(before) === JSON.stringify(after),
    GUARDED.map((f) => `${f} ${after[f].slice(0, 12)}…`).join(" · "));

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "mesh_optical_bypass.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}

if (require.main === module) main();
