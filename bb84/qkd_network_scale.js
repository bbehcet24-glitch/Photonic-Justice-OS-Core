#!/usr/bin/env node
"use strict";
/**
 * qkd_network_scale.js — A6: AĞ-ÖLÇEKLİ QKD (QKDNetSim tarzı)
 * ═══════════════════════════════════════════════════════════════════
 * Mevcut QKDNetSim trafik köprüsü tek-master şekil-tekrarıydı. A6 bunu
 * AĞ ÖLÇEĞİNE taşır: çok-düğümlü güvenilir-düğüm QKD ağı, çok-atlamalı
 * yönlendirme, ve GÜVENİLİR-DÜĞÜM ANAHTAR RELAY'i (QKDNetSim v2.0 / EuroQCI
 * modeli). Uçtan uca bir anahtar, yolundaki HER hop'ta bir link anahtarı
 * tüketir (ara düğümlerde XOR ile relay). Rekabet altında link anahtar
 * havuzları max-min ADİL paylaşılır.
 *
 * Fizik ÇEKİRDEKTEN değil L1 motorundan gelir: link anahtar hızı fiber
 * geçirgenliğiyle (fiberTransmittance) mesafeye göre düşer. Çekirdek
 * photonnet_core.js DEĞİŞTİRİLMEZ.
 */
const SW = require("./entanglement_swap_scheduler.js");

// Link anahtar hızı: kaynak hızı × fiber geçirgenliği × dedektör × sifting × güvenli-fraksiyon
const SRC_RATE_HZ = 1e9, DET_EFF = 0.2, SIFT = 0.5, KEYFRAC = 0.5;
function linkKeyRateBps(km) { return SRC_RATE_HZ * SW.fiberTransmittance(km) * DET_EFF * SIFT * KEYFRAC; }

/** Topoloji: {nodes:[ad], links:[{a,b,km}]} → komşuluk + link hızları. */
function buildNetwork({ nodes, links }) {
  const adj = new Map(nodes.map(n => [n, []]));
  const linkInfo = new Map();
  for (const l of links) {
    const rate = linkKeyRateBps(l.km);
    const key = [l.a, l.b].sort().join("|");
    linkInfo.set(key, { ...l, key, rateBps: rate });
    adj.get(l.a).push({ to: l.b, km: l.km, key });
    adj.get(l.b).push({ to: l.a, km: l.km, key });
  }
  return { nodes, links: [...linkInfo.values()], adj, linkInfo };
}

/** En kısa yol (toplam km, Dijkstra) → düğüm dizisi + link anahtarları. */
function shortestPath(net, src, dst) {
  const dist = new Map(net.nodes.map(n => [n, Infinity])); dist.set(src, 0);
  const prev = new Map(), Q = new Set(net.nodes);
  while (Q.size) {
    let u = null, best = Infinity;
    for (const n of Q) if (dist.get(n) < best) { best = dist.get(n); u = n; }
    if (u === null) break; Q.delete(u);
    if (u === dst) break;
    for (const e of net.adj.get(u)) if (Q.has(e.to) && dist.get(u) + e.km < dist.get(e.to)) { dist.set(e.to, dist.get(u) + e.km); prev.set(e.to, { from: u, key: e.key }); }
  }
  if (!prev.has(dst) && src !== dst) return null;
  const path = [dst], linkKeys = []; let cur = dst;
  while (cur !== src) { const p = prev.get(cur); if (!p) return null; linkKeys.unshift(p.key); path.unshift(p.from); cur = p.from; }
  return { nodes: path, linkKeys, hops: linkKeys.length, totalKm: dist.get(dst) };
}

/**
 * Ağı koştur: talepleri yollara ata, güvenilir-düğüm relay ile HER hop'ta
 * link anahtarı tüket, rekabet altında max-min ADİL tahsis yap.
 * @param demands [{src,dst,demandBps}]
 * @returns per-demand teslim + per-link kullanım + darboğazlar
 */
function runNetwork({ net, demands }) {
  // Her talebi yolla; talep→linkler eşlemesi.
  const routed = demands.map(d => { const p = shortestPath(net, d.src, d.dst); return { ...d, path: p }; }).filter(d => d.path);
  // Link → üstünden geçen talepler.
  const linkLoad = new Map();
  for (const d of routed) for (const lk of d.path.linkKeys) { if (!linkLoad.has(lk)) linkLoad.set(lk, []); linkLoad.get(lk).push(d); }

  // ── MAX-MIN ADİL TAHSİS (progressive filling) ──
  // Her talebin uçtan uca hızı = yolundaki link paylaşımlarının en küçüğü.
  const rate = new Map(routed.map(d => [d, 0]));
  const frozen = new Set();
  const linkCap = new Map([...net.linkInfo].map(([k, v]) => [k, v.rateBps]));
  const linkRemain = new Map(linkCap);
  const linkActive = new Map([...linkLoad].map(([k, ds]) => [k, new Set(ds)]));
  while (frozen.size < routed.length) {
    // Her aktif link için adil pay = kalan / aktif talep sayısı.
    let bottleneckLink = null, minShare = Infinity;
    for (const [lk, actives] of linkActive) {
      const nAct = [...actives].filter(d => !frozen.has(d)).length;
      if (nAct === 0) continue;
      const share = linkRemain.get(lk) / nAct;
      if (share < minShare) { minShare = share; bottleneckLink = lk; }
    }
    if (bottleneckLink === null) { for (const d of routed) if (!frozen.has(d)) frozen.add(d); break; }
    // Darboğaz linkteki dondurulmamış talepleri minShare'de dondur (talebi aşmadan).
    for (const d of [...linkActive.get(bottleneckLink)]) {
      if (frozen.has(d)) continue;
      const r = Math.min(minShare, d.demandBps);
      rate.set(d, r); frozen.add(d);
      for (const lk of d.path.linkKeys) { linkRemain.set(lk, linkRemain.get(lk) - r); linkActive.get(lk).delete(d); }
    }
  }

  const perDemand = routed.map(d => ({ src: d.src, dst: d.dst, demandBps: d.demandBps,
    deliveredBps: +rate.get(d).toFixed(1), hops: d.path.hops, totalKm: d.path.totalKm,
    path: d.path.nodes.join("→"), satisfied: rate.get(d) >= d.demandBps - 1 }));
  const perLink = [...net.linkInfo].map(([k, v]) => {
    const used = (linkLoad.get(k) || []).reduce((s, d) => s + rate.get(d), 0);
    return { link: k, km: v.km, capacityBps: +v.rateBps.toFixed(1), usedBps: +used.toFixed(1),
      utilisation: +(used / v.rateBps).toFixed(4), demands: (linkLoad.get(k) || []).length };
  });
  const offered = demands.reduce((s, d) => s + d.demandBps, 0);
  const delivered = perDemand.reduce((s, d) => s + d.deliveredBps, 0);
  const bottlenecks = perLink.filter(l => l.utilisation > 0.98).map(l => l.link);
  return { perDemand, perLink, offeredBps: offered, deliveredBps: +delivered.toFixed(1),
    bottlenecks, routedCount: routed.length, droppedNoPath: demands.length - routed.length };
}

/** NS-3 QKDNetSim uyumlu senaryo (düğümler, QKD linkleri+tamponlar, akışlar). */
function toQkdnetsimScenario(net, demands) {
  return {
    format: "qkdnetsim-v2-scenario", generatedBy: "photonnet-qkd_network_scale",
    nodes: net.nodes.map((n, i) => ({ id: i, name: n, type: "trusted-node" })),
    links: net.links.map(l => ({ a: l.a, b: l.b, distanceKm: l.km,
      qkdKeyRateBps: +l.rateBps.toFixed(1), qkdBufferBits: Math.round(l.rateBps * 1.0) })),
    applications: demands.map(d => { const p = shortestPath(net, d.src, d.dst); return {
      source: d.src, destination: d.dst, demandBps: d.demandBps,
      path: p ? p.nodes : null, hops: p ? p.hops : null, relayNodes: p ? p.nodes.slice(1, -1) : null }; }),
  };
}

module.exports = { buildNetwork, shortestPath, runNetwork, toQkdnetsimScenario, linkKeyRateBps };
