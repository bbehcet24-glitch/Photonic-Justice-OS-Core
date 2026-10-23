#!/usr/bin/env node
"use strict";
/**
 * mesh_topology_transit_test.js — mesh izolasyonu, PARÇA 1/3: topoloji + transit daraltma
 * ═══════════════════════════════════════════════════════════════════
 *   T1 Kesim düğümleri (Tarjan): hat, halka, yıldız ve test ağı topolojisi
 *   T2 Bypass analizi: test ağında her transit talep düğüm dışlanınca da ulaşılabilir;
 *      hatta kesim düğümünün transit talebi ulaşılamaz olarak DÜRÜSTÇE raporlanıyor
 *   T3 Marj-kademeli ceza eğrisi: sınır değerleri, tekdüzelik, sürekli geçişler
 *   T4 Ağda kademeli daraltma: KDK marjı 23 → 9,5 → 6 dB; küçük cezada transit kalıyor,
 *      büyük cezada BKR↔ATS KDK'yı terk ediyor, KDK'nın kendi uç talepleri sürüyor,
 *      hiçbir düğüm karantinaya alınmıyor (çevreyle açıklanan durum)
 *   T5 Kesim düğümünde ceza trafiği KESMİYOR (alternatif yoksa ceza etkisiz)
 *   T6 Kademeli bypass kapalıyken aynı senaryoda transit KDK'da kalıyor (etkinin kaynağı ceza)
 *   + photonnet_core.js ve yeniden kullanılan modüller değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const M = require("./mesh_isolation.js");

const CORE_SHA = "157d81da543cabfafca4a58b69aac574ce7180ac760563cecd918c666581cf3b";
const GUARDED = ["photonnet_core.js", "adaptive_shielding_mitigation.js", "qkd_network_scale.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = TB.DT;

const eqSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const topoOf = (ids, edges, demands = []) => ({
  nodes: ids.map((id) => ({ id, ambientFieldDbuVm: 80, deliveryPathIsolated: true })),
  links: edges.map(([a, b, km]) => ({ a, b, km: km || 20 })),
  demands,
});

/** Test ağında sabit SE ile kısa koşu; KDK'nın SE'si değiştirilir. */
function runTb({ kdkSe, steps = 60, graded = true }) {
  const topo = TB.TOPOLOGY;
  const net = new NET.ShieldedQkdNetwork({ topology: topo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
  const mesh = new M.MeshIsolationController(net, { enableGradedBypass: graded, enableOpticalBypass: false });
  const se = Object.fromEntries(topo.nodes.map((n) => [n.id, n.id === "KDK" ? kdkSe : n.nominalSeDb]));
  const ambient = Object.fromEntries(topo.nodes.map((n) => [n.id, n.ambientFieldDbuVm]));
  const y0 = Object.fromEntries(net.links.map((l) => [l.key, 1.1e-5]));
  const acc = { transitViaKdkBits: 0, endpointBits: 0, endpointDemand: 0, bkrAtsPaths: new Set(), penalty: null, quarantined: 0 };
  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    const hints = mesh.update(t, { se, y0, ambient });
    acc.penalty = hints.nodePenaltyKm.KDK || 0;
    acc.quarantined += hints.quarantine.length + hints.probation.length;
    const r = net.step(t, { se, y0 }, hints);
    if (i < 2) continue; // ilk aralıkta plan yok (nedensel teslim)
    for (const d of r.demands) {
      const isEnd = d.src === "KDK" || d.dst === "KDK";
      if (isEnd) { acc.endpointBits += d.deliveredBits; acc.endpointDemand += d.demandBits; }
      else if (d.pathNodes.includes("KDK")) acc.transitViaKdkBits += d.deliveredBits;
      if (d.src === "BKR" && d.dst === "ATS") for (const p of d.paths) acc.bkrAtsPaths.add(p);
    }
  }
  acc.bkrAtsPaths = [...acc.bkrAtsPaths];
  acc.endpointFrac = acc.endpointBits / acc.endpointDemand;
  acc.thr = net.seRequiredDb + 1;
  return acc;
}

function main() {
  const out = { generatedAt: new Date().toISOString(), part: "1/3 topoloji + transit daraltma", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ T1 Kesim düğümleri ══
  const line = topoOf(["A", "B", "C", "D"], [["A", "B"], ["B", "C"], ["C", "D"]]);
  const ring = topoOf(["A", "B", "C", "D"], [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"]]);
  const star = topoOf(["H", "A", "B", "C"], [["H", "A"], ["H", "B"], ["H", "C"]]);
  const ap = (t) => [...M.articulationPoints(t.nodes.map((n) => n.id), t.links)];
  const apLine = ap(line), apRing = ap(ring), apStar = ap(star), apTb = ap(TB.TOPOLOGY);
  chk("T1 Kesim düğümleri: hat A–B–C–D → {B, C}; halka → yok; yıldız → merkez; test ağı (6 düğüm, 8 link) → yok",
    eqSet(apLine, ["B", "C"]) && apRing.length === 0 && eqSet(apStar, ["H"]) && apTb.length === 0,
    `hat: {${apLine.join(", ")}} · halka: {${apRing.join(", ")}} · yıldız: {${apStar.join(", ")}} · test ağı: {${apTb.join(", ")}}`);

  // ══ T2 Bypass analizi ══
  const ba = M.bypassAnalysis(TB.TOPOLOGY);
  const kdk = ba.perNode.KDK;
  const allBypassable = Object.values(ba.perNode).every((p) => p.transitDemands.every((d) => d.bypassable));
  const lineDem = topoOf(["A", "B", "C"], [["A", "B"], ["B", "C"]], [{ src: "A", dst: "C", demandBps: 1e4 }, { src: "A", dst: "B", demandBps: 1e4 }]);
  const bl = M.bypassAnalysis(lineDem);
  const bTransit = bl.perNode.B.transitDemands;
  chk("T2 Bypass analizi: test ağında KDK dahil her düğümün transit talepleri o düğüm dışlanınca da ulaşılabilir; KDK'nın kendi talepleri transit listesinde değil; A–B–C hattında B kesim düğümü ve A↔C 'bypass edilemez' raporlanıyor",
    allBypassable && !kdk.articulationPoint && kdk.transitDemands.every((d) => !d.pair.includes("KDK")) && kdk.transitDemands.length === 2
      && bl.perNode.B.articulationPoint && bTransit.length === 1 && bTransit[0].pair === "A↔C" && bTransit[0].bypassable === false,
    `KDK transit: ${kdk.transitDemands.map((d) => `${d.pair}${d.bypassable ? " ✓" : " ✗"}`).join(", ")} · hat B: ${bTransit.map((d) => `${d.pair} bypassable=${d.bypassable}`).join(", ")}`);

  // ══ T3 Ceza eğrisi ══
  const P = (m) => M.transitPenaltyKm(m);
  const pts = [12, 10, 8, 6, 4, 2, 0.5, 0, -3, NaN];
  const vals = pts.map(P);
  const expected = [0, 0, 60, 240, 540, 960, 1500 * 0.95 * 0.95, 1500, 1500, 1500];
  const exact = vals.every((v, i) => Math.abs(v - expected[i]) < 1e-9);
  let mono = true; for (let m = -1; m < 12; m += 0.01) if (P(m + 0.01) > P(m) + 1e-12) mono = false;
  const contTop = P(10 - 1e-6) < 1e-6, contBot = Math.abs(P(1e-6) - 1500) < 1e-3;
  chk("T3 Ceza eğrisi: m ≥ 10 dB → 0; 0 < m < 10 → 1500·(1 − m/10)²; m ≤ 0 veya ölçüm yok → 1500 km (kapalı başarısızlık); marja göre tekdüze azalan, 10 dB ve 0 dB'de sıçrama yok",
    exact && mono && contTop && contBot,
    pts.map((m, i) => `${Number.isNaN(m) ? "NaN" : m} dB→${vals[i].toFixed(0)}`).join(" · ") + ` · tekdüze: ${mono}`);

  // ══ T4 Ağda kademeli daraltma ══
  const healthy = runTb({ kdkSe: 62 });
  const small = runTb({ kdkSe: 39.01 + 9.5 });
  const big = runTb({ kdkSe: 39.01 + 6 });
  const viaKdk = (r) => r.bkrAtsPaths.length > 0 && r.bkrAtsPaths.every((p) => p.includes("KDK"));
  const avoidsKdk = (r) => r.bkrAtsPaths.length > 0 && r.bkrAtsPaths.every((p) => !p.includes("KDK"));
  chk("T4 Kademeli daraltma (test ağı, 3 s): KDK marjı 23 dB → ceza 0, BKR↔ATS KDK üzerinden; 9,5 dB → ceza ~4 km, transit KDK'da KALIYOR (kısa yol farkı 31 km'den küçük); 6 dB → ceza ~240 km, transit KDK'yı terk ediyor; üç durumda da KDK'nın uç talepleri tam karşılanıyor ve hiçbir düğüm karantinaya alınmıyor",
    healthy.penalty === 0 && viaKdk(healthy) && small.penalty > 0 && small.penalty < 15.5 && viaKdk(small)
      && big.penalty > 200 && avoidsKdk(big) && big.transitViaKdkBits === 0
      && [healthy, small, big].every((r) => r.endpointFrac > 0.999 && r.quarantined === 0),
    [["23 dB", healthy], ["9,5 dB", small], ["6 dB", big]].map(([k, r]) => `${k}: ceza ${r.penalty.toFixed(1)} km, BKR↔ATS ${r.bkrAtsPaths.join(" | ")}, KDK uç %${(100 * r.endpointFrac).toFixed(2)}`).join(" · "));

  // ══ T5 Kesim düğümünde ceza kesmiyor ══
  const lt = { nodes: ["A", "B", "C"].map((id) => ({ id, ambientFieldDbuVm: 80, deliveryPathIsolated: true })), links: [{ a: "A", b: "B", km: 20 }, { a: "B", b: "C", km: 20 }], demands: [{ src: "A", dst: "C", demandBps: 50000 }] };
  const ln = new NET.ShieldedQkdNetwork({ topology: lt, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
  const lm = new M.MeshIsolationController(ln, { enableOpticalBypass: false });
  let dl = 0, dm = 0, lpen = 0;
  for (let i = 0; i < 60; i++) {
    const meas = { se: { A: 62, B: 39.01 + 2, C: 62 }, y0: { "A|B": 1.1e-5, "B|C": 1.1e-5 }, ambient: { A: 80, B: 80, C: 80 } };
    const h = lm.update(i * DT, meas); lpen = h.nodePenaltyKm.B || 0;
    const r = ln.step(i * DT, meas, h);
    if (i >= 2) { dl += r.demands[0].deliveredBits; dm += r.demands[0].demandBits; }
  }
  chk("T5 Kesim düğümü: A–B–C hattında B'nin marjı 2 dB (ceza ~960 km); A↔C yine B üzerinden TAM karşılanıyor — ceza bir tercih ağırlığı, dışlama değil",
    lpen > 900 && dl >= 0.999 * dm,
    `B cezası ${lpen.toFixed(0)} km · A↔C teslim %${(100 * dl / dm).toFixed(2)}`);

  // ══ T6 Kademeli bypass kapalı ══
  const off = runTb({ kdkSe: 39.01 + 6, graded: false });
  chk("T6 Karşılaştırma: kademeli bypass kapalıyken aynı 6 dB marjda BKR↔ATS KDK üzerinden kalıyor — T4'teki kayma cezadan geliyor, başka bir yan etkiden değil",
    off.penalty === 0 && viaKdk(off) && off.transitViaKdkBits > 0,
    `kapalı: ceza ${off.penalty}, BKR↔ATS ${off.bkrAtsPaths.join(" | ")}, KDK'dan geçen transit ${Math.round(off.transitViaKdkBits)} bit`);

  const after = hashes();
  chk("Çekirdek ve yeniden kullanılan modüller değişmedi (photonnet_core.js SHA-256 = 157d81da…81cf3b)",
    after["photonnet_core.js"] === CORE_SHA && JSON.stringify(before) === JSON.stringify(after),
    GUARDED.map((f) => `${f} ${after[f].slice(0, 12)}…`).join(" · "));

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "mesh_topology_transit.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}

if (require.main === module) main();
module.exports = { runTb };
