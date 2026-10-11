#!/usr/bin/env node
"use strict";
/**
 * multinode_shielding_network.js — 4 seviyeli kalkan karar matrisinin
 * (NORMAL/ADAPT/HOLD/BLOCK, adaptive_shielding_mitigation.js) ÇOK-DÜĞÜMLÜ,
 * güvenilir-düğüm (trusted-node) QKD ağına entegrasyonu.
 * ═══════════════════════════════════════════════════════════════════
 * Her adımda (dt, vars. 50 ms):
 *   1) DÜĞÜM düzeyi: her düğümün kendi Faraday kafesi + SE izleyicisi vardır.
 *      ShieldLevelTracker (taban debounce + dışa-sızıntı mandalı) düğüm
 *      durumunu verir → mTLS (BLOCK değilse açık), güvenilir-relay ve SAE
 *      teslim uygunluğu (OK, ya da BLOCK olmayan + teslimat yolu izole).
 *   2) LİNK düzeyi: her QKD linki (a=verici, b=alıcı) için bir
 *      AdaptiveShieldingMitigation. SE girdisi iki ucun ölçülen SE'sinin
 *      KÜÇÜĞÜDÜR (bir uçtaki sızıntı bile o linkin anahtarını tehlikeye
 *      atar); Y0, alıcıdaki vakum-decoy sayımlarından ÖLÇÜLÜR (measuredY0).
 *   3) YÖNLENDİRME + TAHSİS: kullanılabilir linklerle qkd_network_scale.js
 *      (Dijkstra + max-min adil tahsis, DEĞİŞTİRİLMEDEN) koşulur. Link
 *      kapasitesi = o adımda havuzdan verilebilecek bit (grantable). HOLD
 *      linkleri yönlendirmede ceza ağırlığı alır (yalnız temiz yol yoksa).
 *   4) TESLİM: her (talep, link) payı ctl.grant() ile havuzdan düşülür;
 *      çıktı, yer-gerçeği denetimi için (talep, link, bit) dökümünü verir.
 *
 * KARŞILAŞTIRMA POLİTİKALARI (aynı ölçümlerle):
 *   'adaptive'        — bu katman.
 *   'legacy-strict'   — mevcut durumsuz önkoşul (network_shielding_bridge.
 *                       mtlsHandshakePrecondition, hedef 60 dB) düğüm başına;
 *                       linkler devreye alma parametreleriyle SABİT; anahtar
 *                       karantinası YOK.
 *   'legacy-debounce' — aynı önkoşul + mevcut SeFailsafeDebounce.
 *
 * DÜRÜSTLÜK: Bu modül fiziksel kanalı SİMÜLE eder (beklenen sayım tabanlı
 * anahtar hızı, ölçülmüş Y0'a göre). Yer gerçeğini (gerçek SE) GÖRMEZ —
 * yalnız ölçümleri görür; denetim test ağının işidir. Güvenilir-düğüm
 * relay'i her ara düğümün dürüst ve sağlam olduğunu varsayar (standart
 * trusted-node varsayımı) — bu katman yalnız EM-kalkan boyutunu ekler.
 *
 * photonnet_core.js'e DOKUNULMAZ (qkd_network_scale → entanglement_swap_
 * scheduler zinciri onu yalnız OKUR).
 * ═══════════════════════════════════════════════════════════════════
 */
const A = require("./adaptive_shielding_mitigation.js");
const NS = require("./qkd_network_scale.js");
const { mtlsHandshakePrecondition } = require("./network_shielding_bridge.js");
const { SeFailsafeDebounce } = require("./mtls_failsafe_debounce.js");

const POLICIES = Object.freeze(["adaptive", "legacy-strict", "legacy-debounce"]);
const DEFAULT_HOLD_ROUTE_PENALTY_KM = 1000;
const MAX_ROUTING_ROUNDS = 3;

/** Fiber + ekleme kaybı + dedektör verimi → toplam iletim η. */
function linkEta(km, { lossDbPerKm = 0.2, insertionLossDb = 3, detectorEfficiency = 0.1 } = {}) {
  return detectorEfficiency * Math.pow(10, -(lossDbPerKm * km + insertionLossDb) / 10);
}
const linkKey = (a, b) => [a, b].sort().join("|"); // qkd_network_scale ile AYNI biçim

/** Eski önkoşulun beklediği kafes-değerlendirme şekli (ölçülen SE + hedef). */
function cageEvalFromSe(seDb, targetSeDb) {
  const se = Number.isFinite(seDb) ? seDb : -Infinity;
  return { ok: se >= targetSeDb, targetSeDb, marginDb: +(se - targetSeDb).toFixed(1), worst: { combinedSeDb: se }, detail: `ölçülen SE ${Number.isFinite(se) ? se.toFixed(1) : "yok"} dB` };
}

class ShieldedQkdNetwork {
  /**
   * @param cfg.topology { nodes:[{id, ambientFieldDbuVm, deliveryPathIsolated}], links:[{a,b,km}], demands:[{src,dst,demandBps}] }
   * @param cfg.policy 'adaptive' | 'legacy-strict' | 'legacy-debounce'
   * @param cfg.threat   AdaptiveShieldingMitigation.threat ile aynı (ZORUNLU)
   * @param cfg.ingress  { susceptibilityDbuVm, refDarkYield } — ortam alanı düğüm başına topology'den
   * @param cfg.seMeasurementUncertaintyDb, blockPulses, pulseRateHz, initialCleanPoolBits, optimizationCache,
   *        targetSeDb (vars. 60), holdRoutePenaltyKm, etaOpts
   */
  constructor(cfg) {
    if (!POLICIES.includes(cfg.policy)) throw new TypeError(`ShieldedQkdNetwork: policy ${POLICIES.join("/")} olmalı.`);
    const topo = cfg.topology;
    Object.assign(this, {
      policy: cfg.policy, topology: topo, threat: cfg.threat, targetSeDb: cfg.targetSeDb != null ? cfg.targetSeDb : 60,
      holdRoutePenaltyKm: cfg.holdRoutePenaltyKm != null ? cfg.holdRoutePenaltyKm : DEFAULT_HOLD_ROUTE_PENALTY_KM,
      blockPulses: cfg.blockPulses || 1e9, pulseRateHz: cfg.pulseRateHz || 1e9,
    });
    this.blockDurationMs = (this.blockPulses / this.pulseRateHz) * 1000;
    this.seRequiredDb = A.seRequiredForThreatDb(cfg.threat).seRequiredDb;
    const u = cfg.seMeasurementUncertaintyDb != null ? cfg.seMeasurementUncertaintyDb : A.DEFAULT_SE_MEASUREMENT_UNCERTAINTY_DB;
    this.nodeById = new Map(topo.nodes.map((n) => [n.id, n]));
    for (const n of topo.nodes) {
      if (typeof n.deliveryPathIsolated !== "boolean" || !Number.isFinite(n.ambientFieldDbuVm)) {
        throw new TypeError(`ShieldedQkdNetwork: düğüm '${n.id}' için deliveryPathIsolated (boolean) ve ambientFieldDbuVm ZORUNLU.`);
      }
    }
    const cache = cfg.optimizationCache instanceof Map ? cfg.optimizationCache : new Map();

    // ── Düğüm kapıları ──
    this.nodeGate = new Map();
    for (const n of topo.nodes) {
      if (this.policy === "adaptive") this.nodeGate.set(n.id, new A.ShieldLevelTracker({ seRequiredDb: this.seRequiredDb, seMeasurementUncertaintyDb: u }));
      else if (this.policy === "legacy-debounce") this.nodeGate.set(n.id, new SeFailsafeDebounce());
      else this.nodeGate.set(n.id, null); // legacy-strict: durumsuz
    }

    // ── Linkler ──
    this.links = topo.links.map((l) => {
      const eta = linkEta(l.km, cfg.etaOpts);
      const a = this.nodeById.get(l.a), b = this.nodeById.get(l.b);
      const ctl = new A.AdaptiveShieldingMitigation({
        threat: cfg.threat,
        ingress: { ambientFieldDbuVm: b.ambientFieldDbuVm, susceptibilityDbuVm: cfg.ingress.susceptibilityDbuVm, refDarkYield: cfg.ingress.refDarkYield },
        deliveryPathIsolated: a.deliveryPathIsolated && b.deliveryPathIsolated,
        channel: { eta }, blockPulses: this.blockPulses, pulseRateHz: this.pulseRateHz,
        initialCleanPoolBits: cfg.initialCleanPoolBits || 0, optimizationCache: cache, seMeasurementUncertaintyDb: u,
        poolCapacityBits: cfg.poolCapacityBits,
        targetSeDb: this.targetSeDb,
      });
      const rec = { ...l, key: linkKey(l.a, l.b), eta, ctl, blockLogSeen: 0 };
      if (this.policy !== "adaptive") {
        // Eski sistem: devreye alma parametreleri SABİT, karantina YOK, kendi havuzu.
        rec.legacy = { params: { ...ctl.activeParams }, pool: cfg.initialCleanPoolBits || 0, block: null, blockLog: [], released: 0 };
      }
      return rec;
    });
    this.linkByKey = new Map(this.links.map((l) => [l.key, l]));
    this.lastMs = null;
    this.nodeState = new Map();
  }

  /** Bir linkin şu an yürürlükteki parametreleri (vakum payı test ağının Y0 ölçümü için gerekir). */
  activeParams(key) {
    const l = this.linkByKey.get(key);
    return l.legacy ? l.legacy.params : l.ctl.activeParams;
  }

  _nodeStep(id, seDb, nowMs) {
    const g = this.nodeGate.get(id);
    const iso = this.nodeById.get(id).deliveryPathIsolated;
    if (this.policy === "adaptive") {
      const r = g.update(Number.isFinite(seDb) ? seDb : -Infinity, nowMs);
      const usable = r.state === "OK" || (r.state !== "BLOCK" && iso);
      return { state: r.state, mtlsAllowed: r.state !== "BLOCK", relayAllowed: usable, deliveryAllowed: usable };
    }
    const ev = cageEvalFromSe(seDb, this.targetSeDb);
    const allowed = this.policy === "legacy-strict" ? mtlsHandshakePrecondition(ev).allowed : g.ingest(ev, nowMs).effectiveAllowed;
    return { state: allowed ? "OK" : "BLOCK", mtlsAllowed: allowed, relayAllowed: allowed, deliveryAllowed: allowed };
  }

  _legacyLinkStep(l, nowMs, Y0, dt) {
    const L = l.legacy;
    const newBlocks = [];
    if (!L.block) L.block = { startMs: nowMs, maxY0: Y0 };
    L.block.maxY0 = Math.max(L.block.maxY0, Y0);
    while (nowMs - L.block.startMs >= this.blockDurationMs) {
      const end = L.block.startMs + this.blockDurationMs;
      const r = A.finiteKeyRate({ ...L.params, N: this.blockPulses, Y0: L.block.maxY0, eta: l.eta, codeRate: L.params.codeRate });
      const bits = Math.floor(r.R * this.blockPulses);
      L.pool += bits; L.released += bits;
      const rec = { startMs: L.block.startMs, endMs: end, bits, tainted: false, params: { ...L.params } };
      L.blockLog.push(rec); newBlocks.push(rec);
      L.block = { startMs: end, maxY0: Y0 };
    }
    return newBlocks;
  }

  /**
   * @param nowMs
   * @param meas { se: {nodeId: dB|NaN}, y0: {linkKey: ölçülmüş Y0} }
   */
  step(nowMs, meas) {
    const dt = this.lastMs == null ? 0 : nowMs - this.lastMs;
    this.lastMs = nowMs;

    // 1) Düğümler
    const nodes = {};
    for (const n of this.topology.nodes) nodes[n.id] = this._nodeStep(n.id, meas.se[n.id], nowMs);
    this.nodeState = nodes;

    // 2) Linkler
    const links = {};
    for (const l of this.links) {
      const sa = meas.se[l.a], sb = meas.se[l.b];
      const seLink = Number.isFinite(sa) && Number.isFinite(sb) ? Math.min(sa, sb) : NaN;
      const Y0 = meas.y0[l.key];
      let level, budget, newBlocks;
      if (this.policy === "adaptive") {
        const d = l.ctl.ingest({ seDb: seLink, demandBps: 0, measuredY0: Y0 }, nowMs);
        newBlocks = l.ctl.blockLog.slice(l.blockLogSeen).map((b) => ({ ...b }));
        l.blockLogSeen = l.ctl.blockLog.length;
        level = d.level;
        budget = dt > 0 ? l.ctl.grantable(dt) : 0;
      } else {
        newBlocks = this._legacyLinkStep(l, nowMs, Y0, dt);
        const up = nodes[l.a].mtlsAllowed && nodes[l.b].mtlsAllowed;
        level = up ? "NORMAL" : "BLOCK";
        budget = up && dt > 0 ? l.legacy.pool : 0;
      }
      links[l.key] = { level, budgetBits: budget, newBlocks, grantedBits: 0 };
    }

    // 3) Yönlendirme + max-min tahsis (qkd_network_scale, değiştirilmeden), ARTIK-KAPASİTE TURLARIYLA.
    //    qkd_network_scale her talebi TEK en-kısa yola koyar ve kapasiteye bakmaz. Test ağı
    //    bunun bir tuzak olduğunu gösterdi: HOLD'da üstel daralan (neredeyse boş ama >0)
    //    bir link en kısa yolda kalınca talep, 63 Mbit'i duran paralel bir HOLD linki
    //    varken AÇ kalıyordu. Çözüm: karşılanmayan talep kalanı, kullanılan kapasite
    //    düşülmüş ARTIK ağda yeniden yönlendirilir (≤ MAX_ROUTING_ROUNDS tur = çok-yollu
    //    anahtar aktarımı); bir adımda talebin %1'ini bile taşıyamayan linkler dışlanır.
    const usableNode = (id) => nodes[id].relayAllowed;
    const demandsOut = this.topology.demands.map((d) => ({ src: d.src, dst: d.dst, demandBps: d.demandBps,
      demandBits: (d.demandBps * dt) / 1000, deliveredBits: 0, path: null, paths: [], pathNodes: [], tier: null, perLink: [] }));
    if (dt > 0) {
      const residual = new Map(this.links.map((l) => [l.key, links[l.key].budgetBits * (1 - 1e-12)]));
      const perDemandLink = demandsOut.map(() => new Map());
      let pending = demandsOut.map((o, di) => ({ di, src: o.src, dst: o.dst, remBits: o.demandBits }))
        .filter((x) => nodes[x.src].deliveryAllowed && nodes[x.dst].deliveryAllowed);
      for (let round = 0; round < MAX_ROUTING_ROUNDS && pending.length; round++) {
        const minUseful = Math.max(1e-6, 0.01 * Math.min(...pending.map((x) => x.remBits)));
        const netLinks = [];
        for (const l of this.links) {
          const L = links[l.key];
          if (L.level === "BLOCK" || !(residual.get(l.key) > minUseful) || !usableNode(l.a) || !usableNode(l.b)) continue;
          netLinks.push({ a: l.a, b: l.b, km: l.km + (L.level === "HOLD" ? this.holdRoutePenaltyKm : 0) });
        }
        if (!netLinks.length) break;
        const net = NS.buildNetwork({ nodes: this.topology.nodes.map((n) => n.id), links: netLinks });
        for (const [k, v] of net.linkInfo) v.rateBps = (residual.get(k) * 1000) / dt; // kapasite = kalan havuz bütçesi
        const res = NS.runNetwork({ net, demands: pending.map((x) => ({ src: x.src, dst: x.dst, demandBps: (x.remBits * 1000) / dt })) });
        for (const pd of res.perDemand) {
          const x = pending.find((y) => y.src === pd.src && y.dst === pd.dst);
          const p = NS.shortestPath(net, pd.src, pd.dst);
          // runNetwork deliveredBps'i 0,1'e YUVARLAR (yukarı da olabilir) → bütçeyi aşmamak için 0,05 bps düş.
          const bits = Math.min((Math.max(0, pd.deliveredBps - 0.05) * dt) / 1000, x.remBits);
          if (!(bits > 0) || !p) continue;
          const o = demandsOut[x.di];
          o.paths.push(p.nodes.join("→"));
          for (const n of p.nodes) if (!o.pathNodes.includes(n)) o.pathNodes.push(n);
          if (p.linkKeys.some((k) => links[k].level === "HOLD")) o.tier = "hold-pool"; else if (!o.tier) o.tier = "primary";
          o.deliveredBits += bits; x.remBits -= bits;
          for (const k of p.linkKeys) { residual.set(k, residual.get(k) - bits); perDemandLink[x.di].set(k, (perDemandLink[x.di].get(k) || 0) + bits); }
        }
        pending = pending.filter((x) => x.remBits > 0.01 * demandsOut[x.di].demandBits);
      }
      demandsOut.forEach((o, di) => {
        o.path = o.paths.length ? o.paths.join(" + ") : null;
        o.perLink = [...perDemandLink[di]].map(([link, bits]) => ({ link, bits }));
      });
    }
    // 4) Teslim: link başına toplamı TEK grant ile düş (HOLD üstel bütçesi tek seferlik).
    const perLinkTotal = new Map();
    for (const d of demandsOut) for (const pl of d.perLink) perLinkTotal.set(pl.link, (perLinkTotal.get(pl.link) || 0) + pl.bits);
    for (const [k, total] of perLinkTotal) {
      const l = this.linkByKey.get(k);
      let g;
      if (this.policy === "adaptive") g = l.ctl.grant(total, dt);
      else { g = Math.min(total, l.legacy.pool); l.legacy.pool -= g; }
      if (g < total * (1 - 1e-9)) throw new Error(`ShieldedQkdNetwork: link ${k} tahsis edilen ${total} bitten azını verdi (${g}) — bütçe tutarsızlığı`);
      links[k].grantedBits = g;
    }
    return { atMs: nowMs, dtMs: dt, nodes, links, demands: demandsOut };
  }

  poolBits(key) {
    const l = this.linkByKey.get(key);
    return l.legacy ? l.legacy.pool : l.ctl.cleanPoolBits;
  }
}

module.exports = { ShieldedQkdNetwork, POLICIES, linkEta, linkKey, cageEvalFromSe, DEFAULT_HOLD_ROUTE_PENALTY_KM };
