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
    this._cfg = cfg; this._cache = cache;
    this.links = topo.links.map((l) => this._makeLink(l));
    this.linkByKey = new Map(this.links.map((l) => [l.key, l]));
    this.lastMs = null;
    this.nodeState = new Map();
    this.plan = null;              // bir sonraki aralığın tahsis planı (nedensel teslim için)
    this.prevLinkUp = null;
    this.nominalDtMs = cfg.nominalDtMs || 50;
  }

  _makeLink(l, { insertionLossDb = 0, initialPoolBits } = {}) {
    const cfg = this._cfg, cache = this._cache;
    {
      const etaOpts = { ...(cfg.etaOpts || {}) };
      etaOpts.insertionLossDb = (etaOpts.insertionLossDb != null ? etaOpts.insertionLossDb : 3) + insertionLossDb;
      const eta = linkEta(l.km, etaOpts);
      const a = this.nodeById.get(l.a), b = this.nodeById.get(l.b);
      const ctl = new A.AdaptiveShieldingMitigation({
        threat: cfg.threat,
        ingress: { ambientFieldDbuVm: b.ambientFieldDbuVm, susceptibilityDbuVm: cfg.ingress.susceptibilityDbuVm, refDarkYield: cfg.ingress.refDarkYield },
        deliveryPathIsolated: a.deliveryPathIsolated && b.deliveryPathIsolated,
        channel: { eta }, blockPulses: this.blockPulses, pulseRateHz: this.pulseRateHz,
        initialCleanPoolBits: initialPoolBits != null ? initialPoolBits : (cfg.initialCleanPoolBits || 0), optimizationCache: cache,
        seMeasurementUncertaintyDb: cfg.seMeasurementUncertaintyDb != null ? cfg.seMeasurementUncertaintyDb : A.DEFAULT_SE_MEASUREMENT_UNCERTAINTY_DB,
        poolCapacityBits: cfg.poolCapacityBits,
        targetSeDb: this.targetSeDb,
      });
      const rec = { ...l, key: linkKey(l.a, l.b), eta, ctl, blockLogSeen: 0, insertionLossDb };
      if (this.policy !== "adaptive") {
        // Eski sistem: devreye alma parametreleri SABİT, karantina YOK, kendi havuzu.
        rec.legacy = { params: { ...ctl.activeParams }, pool: cfg.initialCleanPoolBits || 0, block: null, blockLog: [], released: 0 };
      }
      return rec;
    }
  }

  /**
   * Çalışırken link ekle — OPTİK BYPASS sanal linki (A–X–B fiberleri X'te pasif olarak birleştirilir,
   * X anahtar materyali GÖRMEZ). Aynı uç çiftinde doğrudan link varsa reddedilir (qkd_network_scale
   * anahtarı [a,b] sıralı; çakışma birleşmeye yol açardı).
   */
  addLink({ a, b, km, insertionLossDb = 0, virtual = true, via = null, initialPoolBits = 0 }) {
    const key = linkKey(a, b);
    if (this.linkByKey.has(key)) throw new Error(`addLink: ${key} zaten var`);
    if (this.policy !== "adaptive") throw new Error("addLink: yalnız 'adaptive' politikada");
    const rec = this._makeLink({ a, b, km }, { insertionLossDb, initialPoolBits });
    Object.assign(rec, { virtual, via });
    this.links.push(rec); this.linkByKey.set(key, rec);
    return key;
  }
  /** Fiber anahtarlandı → link askıda (anahtar üretimi yok, havuz verilemez) / geri bağlandı. */
  setLinkEnabled(key, enabled) {
    const l = this.linkByKey.get(key);
    if (!l) throw new Error(`setLinkEnabled: ${key} yok`);
    if (enabled) l.ctl.resume(); else l.ctl.suspend(this.lastMs);
  }
  linkEnabled(key) { const l = this.linkByKey.get(key); return !!l && !l.ctl.suspended; }

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

  /** Bu aralık için bir linkten verilebilecek bit — ÖNCEKİ kararla (ingest'ten ÖNCE çağrılır). */
  _availableBits(l, dt) {
    if (!(dt > 0)) return 0;
    if (this.policy === "adaptive") return l.ctl.grantable(dt);
    return this.prevLinkUp && this.prevLinkUp.get(l.key) ? l.legacy.pool : 0;
  }

  /**
   * (t_prev, t_now] aralığını, t_prev'de yapılan PLANLA teslim eder (NEDENSEL).
   * Önceki sürüm teslimi aralığın SONUNDAKİ okumayla verilen kararla yapıyordu —
   * yani sızıntının başladığı örnekleme aralığında olanı "zaten bilerek" yönlendiriyordu.
   * Gerçek bir sistemde karar ancak okumadan SONRA değişir; bu yüzden bir örnekleme
   * aralığı kadar maruziyet kaçınılmazdır (planlı bakım bunu sıfırlar, bkz. koordinatör).
   * Plan oran (bit/ms) olarak saklanır; link bütçesi plandan azsa o linkten geçen tüm
   * yollar orantılı kısılır, bir talebin teslimi yolundaki en dar linkle sınırlıdır.
   */
  _deliverPlanned(dt) {
    const demandsOut = this.topology.demands.map((d) => ({ src: d.src, dst: d.dst, demandBps: d.demandBps,
      demandBits: (d.demandBps * dt) / 1000, deliveredBits: 0, path: null, paths: [], pathNodes: [], tier: null, perLink: [] }));
    const granted = new Map();
    if (!(dt > 0) || !this.plan) return { demandsOut, granted };
    const planned = new Map();
    for (const pd of this.plan) for (const seg of pd.segments) for (const k of seg.linkKeys) planned.set(k, (planned.get(k) || 0) + seg.bitsPerMs * dt);
    const frac = new Map();
    for (const [k, tot] of planned) frac.set(k, Math.min(1, this._availableBits(this.linkByKey.get(k), dt) * (1 - 1e-12) / tot));
    const perLinkTotal = new Map();
    for (const pd of this.plan) {
      const o = demandsOut[pd.di];
      const perLink = new Map();
      for (const seg of pd.segments) {
        const f = Math.min(...seg.linkKeys.map((k) => frac.get(k)));
        const bits = Math.min(seg.bitsPerMs * dt * f, o.demandBits - o.deliveredBits);
        if (!(bits > 0)) continue;
        o.deliveredBits += bits;
        o.paths.push(seg.nodes.join("→"));
        for (const n of seg.nodes) if (!o.pathNodes.includes(n)) o.pathNodes.push(n);
        o.tier = seg.hold ? "hold-pool" : (o.tier || "primary");
        for (const k of seg.linkKeys) { perLink.set(k, (perLink.get(k) || 0) + bits); perLinkTotal.set(k, (perLinkTotal.get(k) || 0) + bits); }
      }
      o.path = o.paths.length ? o.paths.join(" + ") : null;
      o.perLink = [...perLink].map(([link, bits]) => ({ link, bits }));
    }
    for (const [k, total] of perLinkTotal) {
      const l = this.linkByKey.get(k);
      let g;
      if (this.policy === "adaptive") g = l.ctl.grant(total, dt);
      else { g = Math.min(total, l.legacy.pool); l.legacy.pool -= g; }
      if (g < total * (1 - 1e-9)) throw new Error(`ShieldedQkdNetwork: link ${k} planlanan ${total} bitten azını verdi (${g}) — bütçe tutarsızlığı`);
      granted.set(k, g);
    }
    return { demandsOut, granted };
  }

  /**
   * @param nowMs
   * @param meas  { se: {nodeId: dB|NaN}, y0: {linkKey: ölçülmüş Y0} }
   * @param hints { drainPenaltyKm: {nodeId: km}, maintenance: Set|Array<nodeId> } — maintenance_traffic_coordinator.js'ten
   *   DRAIN: düğüme dokunan linkler ceza ağırlığı alır (transit trafik alternatif yola kayar; alternatif yoksa KESİLMEZ).
   *   MAINTENANCE: planlı kesinti — düğüm relay/uç/mTLS dışı (kapı ANCAK bundan sonra açılır).
   */
  step(nowMs, meas, hints = {}) {
    const dt = this.lastMs == null ? 0 : nowMs - this.lastMs;
    this.lastMs = nowMs;

    // A) Geçen aralığı ÖNCEKİ planla teslim et (link kararları henüz güncellenmedi → nedensel)
    const { demandsOut, granted } = this._deliverPlanned(dt);

    // B) Yeni okumalar: düğümler (+ planlı bakım durumu)
    const maint = new Set(hints.maintenance || []);
    const quar = new Set(hints.quarantine || []);
    const prob = new Set(hints.probation || []);
    const drain = {};
    for (const src of [hints.drainPenaltyKm || {}, hints.nodePenaltyKm || {}]) for (const [k, v] of Object.entries(src)) drain[k] = (drain[k] || 0) + v;
    const nodes = {};
    for (const n of this.topology.nodes) {
      const st = this._nodeStep(n.id, meas.se[n.id], nowMs);
      if (quar.has(n.id)) Object.assign(st, { shieldState: st.state, state: "QUARANTINE", planned: "QUARANTINE", mtlsAllowed: false, relayAllowed: false, deliveryAllowed: false });
      else if (maint.has(n.id)) Object.assign(st, { shieldState: st.state, state: "MAINTENANCE", planned: "MAINTENANCE", mtlsAllowed: false, relayAllowed: false, deliveryAllowed: false });
      else {
        if (prob.has(n.id)) Object.assign(st, { planned: "PROBATION", relayAllowed: false }); // gözetim: yalnız uç, transit YOK
        if (drain[n.id] > 0) st.planned = st.planned || "DRAIN";
      }
      nodes[n.id] = st;
    }
    this.nodeState = nodes;

    // B') Linkler
    const links = {};
    const linkUp = new Map();
    for (const l of this.links) {
      const sa = meas.se[l.a], sb = meas.se[l.b];
      const seLink = Number.isFinite(sa) && Number.isFinite(sb) ? Math.min(sa, sb) : NaN;
      const Y0 = meas.y0[l.key];
      let level, newBlocks;
      if (this.policy === "adaptive") {
        // y0Invalid: sensör beslemesi bu linkin Y0 ölçümünü DOĞRULAYAMADI (shield_sensor_hal.js) → aralık lekelenir
        const d = l.ctl.ingest({ seDb: seLink, demandBps: 0, measuredY0: Y0, y0Invalid: !!(meas.y0Invalid && meas.y0Invalid[l.key]) }, nowMs);
        newBlocks = l.ctl.blockLog.slice(l.blockLogSeen).map((b) => ({ ...b }));
        l.blockLogSeen = l.ctl.blockLog.length;
        level = d.level;
      } else {
        newBlocks = this._legacyLinkStep(l, nowMs, Y0, dt);
        const up = nodes[l.a].mtlsAllowed && nodes[l.b].mtlsAllowed;
        linkUp.set(l.key, up);
        level = up ? "NORMAL" : "BLOCK";
      }
      links[l.key] = { level, newBlocks, grantedBits: granted.get(l.key) || 0, budgetBits: 0 };
    }
    this.prevLinkUp = linkUp;

    // C) Bir SONRAKİ aralığın planı (qkd_network_scale, değiştirilmeden), ARTIK-KAPASİTE TURLARIYLA.
    //    qkd_network_scale her talebi TEK en-kısa yola koyar ve kapasiteye bakmaz. Test ağı
    //    bunun bir tuzak olduğunu gösterdi: HOLD'da üstel daralan (neredeyse boş ama >0)
    //    bir link en kısa yolda kalınca talep, paralel bir HOLD linkinde 63 Mbit dururken
    //    AÇ kalıyordu. Çözüm: karşılanmayan talep kalanı, kullanılan kapasite düşülmüş
    //    ARTIK ağda yeniden yönlendirilir (≤ MAX_ROUTING_ROUNDS tur = çok-yollu aktarım).
    const dtPlan = dt > 0 ? dt : this.nominalDtMs;
    for (const l of this.links) {
      if (this.policy === "adaptive") links[l.key].budgetBits = l.ctl.grantable(dtPlan);
      else links[l.key].budgetBits = linkUp.get(l.key) ? l.legacy.pool : 0;
    }
    const usableNode = (id) => nodes[id].relayAllowed;
    const residual = new Map(this.links.map((l) => [l.key, links[l.key].budgetBits * (1 - 1e-12)]));
    const plan = [];
    let pending = this.topology.demands.map((d, di) => ({ di, src: d.src, dst: d.dst, remBits: (d.demandBps * dtPlan) / 1000, full: (d.demandBps * dtPlan) / 1000 }))
      .filter((x) => nodes[x.src].deliveryAllowed && nodes[x.dst].deliveryAllowed);
    // UÇ-YALNIZ düğümler (teslim alabilir ama transit yasak — ör. PROBATION): bu düğümün linkleri yalnız
    // o düğümde BİTEN/BAŞLAYAN talepler için ağa eklenir; diğer talepler onları göremez → transit imkânsız.
    // Uç-yalnız düğüm yoksa davranış önceki sürümle birebir aynı (tek grup).
    const endpointOnly = new Set(this.topology.nodes.filter((n) => !nodes[n.id].relayAllowed && nodes[n.id].deliveryAllowed).map((n) => n.id));
    for (let round = 0; round < MAX_ROUTING_ROUNDS && pending.length; round++) {
      const minUseful = Math.max(1e-6, 0.01 * Math.min(...pending.map((x) => x.remBits)));
      const groups = new Map();
      for (const x of pending) {
        const own = [x.src, x.dst].filter((id) => endpointOnly.has(id)).sort().join(",");
        if (!groups.has(own)) groups.set(own, []);
        groups.get(own).push(x);
      }
      for (const [own, members] of groups) {
        const allowedEndOnly = new Set(own ? own.split(",") : []);
        const nodeOk = (id) => usableNode(id) || allowedEndOnly.has(id);
        const netLinks = [];
        for (const l of this.links) {
          const L = links[l.key];
          if (L.level === "BLOCK" || L.level === "SUSPENDED" || !(residual.get(l.key) > minUseful) || !nodeOk(l.a) || !nodeOk(l.b)) continue;
          const pen = (L.level === "HOLD" ? this.holdRoutePenaltyKm : 0) + (drain[l.a] || 0) + (drain[l.b] || 0);
          netLinks.push({ a: l.a, b: l.b, km: l.km + pen });
        }
        if (!netLinks.length) continue;
        const net = NS.buildNetwork({ nodes: this.topology.nodes.map((n) => n.id), links: netLinks });
        for (const [k, v] of net.linkInfo) v.rateBps = (residual.get(k) * 1000) / dtPlan; // kapasite = kalan havuz bütçesi
        const res = NS.runNetwork({ net, demands: members.map((x) => ({ src: x.src, dst: x.dst, demandBps: (x.remBits * 1000) / dtPlan })) });
        for (const pd of res.perDemand) {
          const x = members.find((y) => y.src === pd.src && y.dst === pd.dst);
          const p = NS.shortestPath(net, pd.src, pd.dst);
          // runNetwork deliveredBps'i 0,1'e YUVARLAR (yukarı da olabilir) → bütçeyi aşmamak için 0,05 bps düş.
          const bits = Math.min((Math.max(0, pd.deliveredBps - 0.05) * dtPlan) / 1000, x.remBits);
          if (!(bits > 0) || !p) continue;
          let e = plan.find((q) => q.di === x.di); if (!e) { e = { di: x.di, segments: [] }; plan.push(e); }
          e.segments.push({ nodes: p.nodes, linkKeys: p.linkKeys, bitsPerMs: bits / dtPlan, hold: p.linkKeys.some((k) => links[k].level === "HOLD") });
          x.remBits -= bits;
          for (const k of p.linkKeys) residual.set(k, residual.get(k) - bits);
        }
      }
      pending = pending.filter((x) => x.remBits > 0.01 * x.full);
    }
    this.plan = plan;
    return { atMs: nowMs, dtMs: dt, nodes, links, demands: demandsOut, plan };
  }

  /** Yürürlükteki planda bu düğümden geçen (uç ya da transit) akış var mı? — koordinatör "boşaltıldı" teyidi için. */
  planUsesNode(id) { return !!(this.plan && this.plan.some((pd) => pd.segments.some((s) => s.nodes.includes(id)))); }

  poolBits(key) {
    const l = this.linkByKey.get(key);
    return l.legacy ? l.legacy.pool : l.ctl.cleanPoolBits;
  }
}

module.exports = { ShieldedQkdNetwork, POLICIES, linkEta, linkKey, cageEvalFromSe, DEFAULT_HOLD_ROUTE_PENALTY_KM };
