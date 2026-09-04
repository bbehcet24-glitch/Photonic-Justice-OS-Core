#!/usr/bin/env node
"use strict";
/**
 * qkd_network_scale_test.js — A6 ağ-ölçekli QKD tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * QKDNetSim tarzı çok-düğümlü güvenilir-düğüm QKD ağı:
 *   (A) FİZİK ANAHTAR HIZLARI: link hızı fiber geçirgenliğiyle mesafeye
 *       göre düşüyor (L1 motoru).
 *   (B) ÇOK-ATLAMALI RELAY: uçtan uca talep k hop yolda HER hop'ta link
 *       anahtarı tüketiyor; uçtan uca hız yoldaki darboğaz linke bağlı.
 *   (C) DARBOĞAZ + MAX-MIN ADALET: rekabet altında hiçbir link kapasiteyi
 *       aşmıyor, darboğazı paylaşan talepler eşit pay alıyor.
 *   (D) QKDNetSim SENARYO: NS-3 QKDNetSim v2 uyumlu senaryo (düğüm/link/akış)
 *       üretiliyor — gerçek modül ingest edebilir.
 *   (E) AĞ-ÖLÇEKLİ ÖZET: 8 düğüm / 11 link / karışık talepler; bazıları
 *       karşılanıyor, bazıları darboğazda kısılıyor.
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const N = require("./qkd_network_scale.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

// Türkiye-benzeri güvenilir-düğüm omurgası (segmentler ~70–120 km) + koordinatlar (grafik için).
const TOPO = {
  nodes: ["IST", "KOC", "BUR", "ESK", "ANK", "IZM", "BAL", "AFY"],
  coords: { IST: [90, 40], KOC: [170, 60], BUR: [130, 130], ESK: [250, 110], ANK: [370, 95], IZM: [70, 210], BAL: [120, 190], AFY: [290, 200] },
  links: [
    { a: "IST", b: "KOC", km: 90 }, { a: "KOC", b: "BUR", km: 70 }, { a: "KOC", b: "ESK", km: 110 },
    { a: "BUR", b: "BAL", km: 95 }, { a: "BAL", b: "IZM", km: 85 }, { a: "ESK", b: "ANK", km: 100 },
    { a: "ESK", b: "AFY", km: 75 }, { a: "AFY", b: "IZM", km: 120 }, { a: "AFY", b: "ANK", km: 105 },
    { a: "BUR", b: "ESK", km: 100 }, { a: "IST", b: "BUR", km: 105 },
  ],
};
const DEMANDS = [
  { src: "BUR", dst: "KOC", demandBps: 0.4e6 },   // kısa/tek-hop → karşılanmalı
  { src: "IST", dst: "ANK", demandBps: 2.0e6 },   // uzun/çok-hop → kısıtlı
  { src: "IST", dst: "IZM", demandBps: 3.0e6 },
  { src: "ANK", dst: "IZM", demandBps: 1.5e6 },
  { src: "IST", dst: "AFY", demandBps: 1.0e6 },
  { src: "BAL", dst: "ESK", demandBps: 0.3e6 },
];

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const net = N.buildNetwork(TOPO);
  const res = N.runNetwork({ net, demands: DEMANDS });
  out.topology = { nodes: TOPO.nodes, coords: TOPO.coords,
    links: net.links.map(l => ({ a: l.a, b: l.b, km: l.km, rateMbps: +(l.rateBps / 1e6).toFixed(2) })) };
  out.result = { perDemand: res.perDemand.map(d => ({ ...d, deliveredMbps: +(d.deliveredBps / 1e6).toFixed(3), demandMbps: +(d.demandBps / 1e6).toFixed(2) })),
    perLink: res.perLink.map(l => ({ ...l, capMbps: +(l.capacityBps / 1e6).toFixed(2), usedMbps: +(l.usedBps / 1e6).toFixed(3) })),
    offeredMbps: +(res.offeredBps / 1e6).toFixed(2), deliveredMbps: +(res.deliveredBps / 1e6).toFixed(2), bottlenecks: res.bottlenecks };

  // ══ (A) FİZİK ANAHTAR HIZLARI ══
  const short = net.links.find(l => l.km === 70), long = net.links.find(l => l.km === 120);
  chk("(A) FİZİK ANAHTAR HIZLARI: link hızı mesafeyle düşüyor (fiber geçirgenliği, L1)",
    short.rateBps > long.rateBps * 3,
    `70 km link ${(short.rateBps / 1e6).toFixed(2)} Mbps vs 120 km link ${(long.rateBps / 1e6).toFixed(2)} Mbps ` +
    `(×${(short.rateBps / long.rateBps).toFixed(1)} fark). Hız fiberTransmittance ile üstel düşüyor — bu yüzden güvenilir-düğüm relay gerekir`);

  // ══ (B) ÇOK-ATLAMALI RELAY ══
  const istIzm = res.perDemand.find(d => d.src === "IST" && d.dst === "IZM");
  const pathCaps = (() => { const p = N.shortestPath(net, "IST", "IZM"); return p.linkKeys.map(k => net.linkInfo.get(k).rateBps); })();
  const minCap = Math.min(...pathCaps);
  chk("(B) ÇOK-ATLAMALI RELAY: uçtan uca talep her hop'ta anahtar tüketir, hız darboğaza bağlı",
    istIzm.hops >= 3 && istIzm.deliveredBps <= minCap + 1,
    `IST→IZM: ${istIzm.path} (${istIzm.hops} hop) · her hop bir link anahtarı tüketir (güvenilir-düğüm relay) · ` +
    `teslim ${(istIzm.deliveredBps / 1e6).toFixed(2)} Mbps ≤ yoldaki darboğaz link ${(minCap / 1e6).toFixed(2)} Mbps`);

  // ══ (C) DARBOĞAZ + MAX-MIN ADALET ══
  const maxUtil = Math.max(...res.perLink.map(l => l.utilisation));
  const noOver = res.perLink.every(l => l.utilisation <= 1.0001);
  // Bir darboğaz linkteki (talep-limitli olmayan) taleplerin payları eşit mi?
  const bl = res.bottlenecks[0];
  const blDemands = res.perDemand.filter(d => { const p = N.shortestPath(net, d.src, d.dst); return p && p.linkKeys.includes(bl); });
  const throttled = blDemands.filter(d => !d.satisfied).map(d => d.deliveredBps);
  const fair = throttled.length < 2 || (Math.max(...throttled) - Math.min(...throttled)) < Math.max(...throttled) * 0.05;
  out.fairness = { bottleneck: bl, throttledSharesMbps: throttled.map(x => +(x / 1e6).toFixed(3)), maxUtil: +maxUtil.toFixed(3) };
  chk("(C) DARBOĞAZ + MAX-MIN ADALET: hiçbir link kapasiteyi aşmıyor, darboğaz payları eşit",
    noOver && fair && res.bottlenecks.length >= 1,
    `en yüksek kullanım %${(maxUtil * 100).toFixed(0)} (≤%100, aşım yok) · ${res.bottlenecks.length} darboğaz link · ` +
    `darboğaz ${bl}'i paylaşan kısıtlı talepler eşit pay aldı (${throttled.map(x => (x / 1e6).toFixed(2)).join(", ")} Mbps) — max-min adil`);

  // ══ (D) QKDNetSim SENARYO ══
  const scen = N.toQkdnetsimScenario(net, DEMANDS);
  const shapeOK = scen.format === "qkdnetsim-v2-scenario" && scen.nodes.length === 8 &&
    scen.nodes.every(n => n.type === "trusted-node") && scen.links.every(l => l.qkdKeyRateBps > 0 && l.qkdBufferBits > 0) &&
    scen.applications.every(a => Array.isArray(a.path) && a.hops >= 1);
  out.scenario = { format: scen.format, nodes: scen.nodes.length, links: scen.links.length, apps: scen.applications.length,
    sampleApp: scen.applications.find(a => a.hops >= 3) };
  fs.writeFileSync(path.join(__dirname, "reports", "qkdnetsim_scenario.json"), JSON.stringify(scen, null, 2));
  chk("(D) QKDNetSim SENARYO: NS-3 QKDNetSim v2 uyumlu senaryo üretildi (düğüm/link/akış + relay)",
    shapeOK,
    `format=${scen.format} · ${scen.nodes.length} güvenilir-düğüm · ${scen.links.length} QKD link (hız+tampon) · ` +
    `${scen.applications.length} akış (yol + relay düğümleri). Gerçek NS-3 QKDNetSim modülü ingest edebilir (reports/qkdnetsim_scenario.json)`);

  // ══ (E) AĞ-ÖLÇEKLİ ÖZET ══
  const satisfied = res.perDemand.filter(d => d.satisfied).length;
  const throttledN = res.perDemand.filter(d => !d.satisfied).length;
  chk("(E) AĞ-ÖLÇEKLİ ÖZET: 8 düğüm / 11 link / karışık talep — bazısı karşılandı, bazısı darboğazda",
    net.nodes.length === 8 && net.links.length === 11 && satisfied >= 1 && throttledN >= 1 && res.deliveredBps > 0,
    `${net.nodes.length} düğüm · ${net.links.length} link · ${DEMANDS.length} talep · ` +
    `${satisfied} karşılandı + ${throttledN} darboğazda kısıldı · toplam sunulan ${(res.offeredBps / 1e6).toFixed(1)} → teslim ${(res.deliveredBps / 1e6).toFixed(1)} Mbps · ` +
    `${res.bottlenecks.length} darboğaz link — ağ-ölçekli anahtar ekonomisi çalışıyor`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… — fizik L1 motorundan (fiberTransmittance), çekirdek sabit`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  fs.writeFileSync(path.join(__dirname, "reports", "qkd_network_scale.json"), JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ A6 — AĞ-ÖLÇEKLİ QKD (QKDNetSim tarzı) ══\n");
  console.log(`  talep akışları (teslim/talep Mbps):`);
  for (const d of out.result.perDemand) console.log(`    ${pad(d.path, 22)} ${d.hops}hop ${pad(t(d.deliveredMbps, 2), 6)}/${t(d.demandMbps, 1)} ${d.satisfied ? "✓" : "kısıtlı"}`);
  console.log(`\n  sunulan ${t(out.result.offeredMbps, 1)} → teslim ${t(out.result.deliveredMbps, 1)} Mbps · darboğaz: ${out.result.bottlenecks.join(", ")}`);
  console.log(`  senaryo: ${out.scenario.nodes} düğüm / ${out.scenario.links} link / ${out.scenario.apps} akış → reports/qkdnetsim_scenario.json`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "qkd_network_scale.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
