#!/usr/bin/env node
"use strict";
/**
 * mesh_isolation.js — AĞ DÜZEYİNDE AKILLI MESH İZOLASYONU
 * ═══════════════════════════════════════════════════════════════════
 * İki mekanizma, ShieldedQkdNetwork'ün (multinode_shielding_network.js) üstünde:
 *
 * (1) OTONOM BYPASS — düğümü tamamen kapatmak yerine ROLÜNÜ daraltır:
 *   a) Marj-kademeli TRANSİT cezası: ölçülen SE ile dışa-sızıntı eşiği arasındaki
 *      marj m küçüldükçe düğüme dokunan linklere artan ceza ağırlığı eklenir
 *      (m ≥ 10 dB → 0; 0 < m < 10 → cezaMax·(1 − m/10)²). Uç talepleri her yolda
 *      AYNI cezayı (tek uç linki) gördüğü için etkilenmez; yalnız TRANSİT kayar.
 *      Marj sıfırın altına inince mevcut HOLD mantığı devreye girer.
 *   b) OPTİK BYPASS: karantinadaki düğüm X'in iki komşusu A, B arasında X'teki
 *      optik anahtarla fiberler PASİF olarak birleştirilir (A–X–B → sanal A–B linki).
 *      Fotonlar X'ten geçer ama X'te ÖLÇÜLMEZ: X anahtar materyali görmez, güvenilir
 *      düğüm olmaktan çıkar — X'te dinleme kuantum kanalda QBER olarak görünür (QKD
 *      güvenlik kanıtının kapsamında). Bedeli: daha uzun fiber + anahtar kaybı → düşük
 *      hız; yeniden yapılandırma süresi (Cambridge optik anahtarlı ağ çalışmasında en çok
 *      ~20 s bildirilmiş); X'in o fiberlerdeki kendi linkleri askıya alınır.
 *
 * (2) KARANTİNA ALT AĞI — şüpheli RF/optik gürültü üreten düğüm:
 *   • Kanıt FÜZYONU, güven alanlarıyla:
 *       self        — düğümün kendi ölçtüğü Y0 (alıcı olduğu linkler) çevre modeliyle
 *                     AÇIKLANAMAYAN fazlalık (ortam alanı sensörü + SE ile beklenenin ≥3 katı)
 *       neighbor    — düğümün VERİCİ olduğu linklerde KOMŞU alıcının ölçtüğü açıklanamayan Y0
 *       independent — operatöre ait bağımsız RF probu (ayrı güven alanı)
 *       lock        — kabin kilidi HAL'i INCIDENT (TAMPER/OVERRIDE)
 *   • HERHANGİ bir alandan güçlü kanıt → ANINDA QUARANTINED: düğüm relay/uç/mTLS dışı;
 *     dokunduğu linklerin mevcut havuzu İPTAL (revokePool — düğüm sızdırmış olabilir);
 *     linkler 'quarantine' BÖLMESİNDE çalışmaya devam eder (telemetri), ürettikleri anahtar
 *     ana havuza GİRMEZ ve bölme kapanınca imha edilir.
 *   • SERBEST BIRAKMA ASİMETRİKTİR: kendi-raporu (self) temiz olsa bile YETMEZ — düğüm
 *     ele geçirilmişse yalan söyleyebilir. En az bir BAĞIMSIZ alan (neighbor/independent)
 *     probationMs boyunca temiz olmalı → PROBATION (yalnız uç, transit yok) → CLEAR.
 *     Bağımsız kanıt kaynağı olmayan düğüm otomatik serbest BIRAKILAMAZ (operatorClear).
 *
 * DÜRÜSTLÜK / KAPSAM:
 *   • Karantina bir GÜVEN kararıdır (güvenilir-düğüm modeli), link anahtarının gizliliği
 *     zaten sonlu-anahtar analiziyle korunur; QBER/Y0 artışının NEDENİNİ (saldırı mı,
 *     donanım mı) güvenlik kanıtı ayırt etmez — bu katman da etmez, yalnız "çevreyle
 *     açıklanamıyor" der (bkz. chaos_eavesdrop_discriminator.js ile aynı ilke).
 *   • Optik anahtar donanımı, ekleme kaybı (vars. 1,5 dB) ve yeniden yapılandırma süresi
 *     (vars. 20 s) varsayımdır; projede optik anahtar yoktur.
 *   • Kesim düğümü (articulation point) karantinaya alınınca bazı talepler ancak optik
 *     bypass fizibılse kurtarılabilir; aksi hâlde kesinti DÜRÜSTÇE raporlanır.
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const A = require("./adaptive_shielding_mitigation.js");
const NETM = require("./multinode_shielding_network.js");

const DEFAULTS = Object.freeze({
  fullMarginDb: 10, maxTransitPenaltyKm: 1500,          // kademeli transit cezası
  switchInsertionLossDb: 1.5, reconfigMs: 20000,         // optik bypass (varsayım; ~20 s kaynağa dayanır)
  minBypassBps: 10000,                                   // bundan düşük hızlı sanal link önerilmez
  unexplainedRatio: 3.0, unexplainedConsecutive: 20,     // Y0_ölçülen / Y0_beklenen ≥ 3, ardışık 20 örnek (≈1 s)
  probeUnexplainedDb: 6,                                 // bağımsız RF probu: açıklanamayan alan ≥ 6 dB
  probationMs: 30000,                                    // bağımsız alan temiz kalmalı (karantina→gözetim→temiz)
});

// ═══ 1) Topoloji analizi ═══
/** Tarjan: kesim düğümleri (articulation points). */
function articulationPoints(nodes, links) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const l of links) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  const disc = new Map(), low = new Map(), ap = new Set(); let time = 0;
  const dfs = (u, parent) => {
    disc.set(u, ++time); low.set(u, time); let children = 0;
    for (const v of adj.get(u)) {
      if (!disc.has(v)) { children++; dfs(v, u); low.set(u, Math.min(low.get(u), low.get(v))); if (parent !== null && low.get(v) >= disc.get(u)) ap.add(u); }
      else if (v !== parent) low.set(u, Math.min(low.get(u), disc.get(v)));
    }
    if (parent === null && children > 1) ap.add(u);
  };
  for (const n of nodes) if (!disc.has(n)) dfs(n, null);
  return ap;
}
/** X dışlanınca src→dst yolu var mı (BFS)? */
function reachableAvoiding(nodes, links, src, dst, avoid) {
  if (src === avoid || dst === avoid) return false;
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const l of links) if (l.a !== avoid && l.b !== avoid) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  const seen = new Set([src]), q = [src];
  while (q.length) { const u = q.shift(); if (u === dst) return true; for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  return false;
}
function bypassAnalysis(topology) {
  const nodes = topology.nodes.map((n) => n.id);
  const ap = articulationPoints(nodes, topology.links);
  const perNode = {};
  for (const x of nodes) {
    perNode[x] = { articulationPoint: ap.has(x), transitDemands: [] };
    for (const d of topology.demands) {
      if (d.src === x || d.dst === x) continue;
      perNode[x].transitDemands.push({ pair: `${d.src}↔${d.dst}`, bypassable: reachableAvoiding(nodes, topology.links, d.src, d.dst, x) });
    }
  }
  return { articulationPoints: [...ap], perNode };
}

// ═══ 2) Marj-kademeli transit cezası ═══
function transitPenaltyKm(marginDb, o = DEFAULTS) {
  if (!Number.isFinite(marginDb)) return o.maxTransitPenaltyKm;
  if (marginDb >= o.fullMarginDb) return 0;
  if (marginDb <= 0) return o.maxTransitPenaltyKm; // eşik altı: zaten HOLD; ceza da tam
  const f = 1 - marginDb / o.fullMarginDb;
  return o.maxTransitPenaltyKm * f * f;
}

// ═══ 3) Optik bypass planlayıcı ═══
/**
 * X'in komşu çiftleri için sanal A–B linkleri; her X-fiberi en çok BİR çifte girer
 * (eşleştirme). Değer = X dışlanınca o sanal linkle kurtarılan/kısalan talepler
 * (güvenilir ara düğüm sayısındaki azalma), eşitlikte hız.
 */
function planOpticalBypass(network, x, { o = DEFAULTS, excluded = new Set() } = {}) {
  const topo = network.topology;
  const fibers = network.links.filter((l) => !l.virtual && (l.a === x || l.b === x)).map((l) => ({ nb: l.a === x ? l.b : l.a, km: l.km, key: l.key }));
  const nbs = fibers.filter((f) => !excluded.has(f.nb));
  const cands = [];
  for (let i = 0; i < nbs.length; i++) for (let j = i + 1; j < nbs.length; j++) {
    const a = nbs[i], b = nbs[j];
    if (network.linkByKey.has(NETM.linkKey(a.nb, b.nb))) continue; // doğrudan link var
    const km = a.km + b.km;
    const eta = NETM.linkEta(km, { insertionLossDb: 3 + o.switchInsertionLossDb });
    const opt = A.optimizeDecoyParameters({ N: network.blockPulses, Y0: 1e-5, eta });
    const bps = opt.R * network.pulseRateHz;
    cands.push({ a: a.nb, b: b.nb, km, eta, rateBps: bps, feasible: bps >= o.minBypassBps, fibers: [a.key, b.key] });
  }
  // değer: X dışlanmış topolojide, bu sanal linkle her X-dışı talebin ara-düğüm sayısındaki azalma
  const baseLinks = topo.links.filter((l) => l.a !== x && l.b !== x && !excluded.has(l.a) && !excluded.has(l.b));
  const hops = (links, s, t) => { const adj = new Map(topo.nodes.map((n) => [n.id, []])); for (const l of links) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); } const d = new Map([[s, 0]]), q = [s]; while (q.length) { const u = q.shift(); for (const v of adj.get(u)) if (!d.has(v)) { d.set(v, d.get(u) + 1); q.push(v); } } return d.has(t) ? d.get(t) : Infinity; };
  const demands = topo.demands.filter((d) => d.src !== x && d.dst !== x && !excluded.has(d.src) && !excluded.has(d.dst));
  const score = (set) => demands.reduce((s, d) => { const h0 = hops(baseLinks, d.src, d.dst), h1 = hops(baseLinks.concat(set), d.src, d.dst); return s + (h0 === Infinity ? (h1 < Infinity ? 100 : 0) : h0 - h1); }, 0);
  const feas = cands.filter((c) => c.feasible);
  let best = { set: [], score: 0, rate: 0 };
  const rec = (i, used, set) => {
    // Yalnız YARARLI (sc > 0) kümeler: tasarrufsuz bir bypass fiberleri boşuna askıya alır ve kanıt kaybettirir
    // (parça-3 testi B2'de eşitlik bozucunun tasarrufu 0 olan BKR–ASY'yi seçtiği görüldü).
    if (i === feas.length) { const sc = score(set), rt = set.reduce((s, c) => s + c.rateBps, 0); if (sc > 0 && (sc > best.score || (sc === best.score && rt > best.rate))) best = { set: [...set], score: sc, rate: rt }; return; }
    rec(i + 1, used, set);
    const c = feas[i];
    if (!used.has(c.a) && !used.has(c.b)) { used.add(c.a); used.add(c.b); set.push(c); rec(i + 1, used, set); set.pop(); used.delete(c.a); used.delete(c.b); }
  };
  rec(0, new Set(), []);
  return { candidates: cands, chosen: best.set, relayHopsSaved: best.score };
}

// ═══ 4) Karantina yöneticisi (kanıt füzyonu + güven alanları) ═══
const QSTATES = Object.freeze({ CLEAR: "CLEAR", QUARANTINED: "QUARANTINED", PROBATION: "PROBATION" });

class QuarantineManager {
  constructor({ nodes, o = DEFAULTS, independentSources = {} } = {}) {
    this.o = { ...DEFAULTS, ...o };
    this.n = new Map(nodes.map((id) => [id, { state: QSTATES.CLEAR, since: null, run: { self: 0, neighbor: 0 }, cleanSince: null, reason: null, hasIndependent: !!independentSources[id] }]));
    this.log = [];
  }
  _set(id, state, t, reason) { const n = this.n.get(id); if (n.state !== state) { this.log.push({ nodeId: id, from: n.state, to: state, atMs: t, reason }); n.state = state; n.since = t; n.reason = reason; } }
  state(id) { return this.n.get(id).state; }
  /**
   * Bir örnek. ev: { self: oran, neighbor: oran|null, probeDb: dB|null, lockIncident: bool, selfVisible: bool }
   * oran = Y0_ölçülen / Y0_beklenen (çevre modeliyle). null = o alandan veri yok.
   * @returns geçiş varsa { from, to }
   */
  observe(id, t, ev) {
    const n = this.n.get(id), o = this.o;
    const before = n.state;
    const selfBad = ev.self != null && ev.self >= o.unexplainedRatio;
    const nbBad = ev.neighbor != null && ev.neighbor >= o.unexplainedRatio;
    n.run.self = selfBad ? n.run.self + 1 : 0;
    n.run.neighbor = nbBad ? n.run.neighbor + 1 : 0;
    const probeBad = ev.probeDb != null && ev.probeDb >= o.probeUnexplainedDb;
    const trigger = ev.lockIncident ? "kabin kilidi INCIDENT" : probeBad ? `bağımsız RF probu ${ev.probeDb.toFixed(1)} dB açıklanamayan alan`
      : n.run.neighbor >= o.unexplainedConsecutive ? `komşu alıcıda açıklanamayan Y0 (×${ev.neighbor.toFixed(1)})`
      : n.run.self >= o.unexplainedConsecutive ? `kendi alıcılarında açıklanamayan Y0 (×${ev.self.toFixed(1)}, çevre sensörleri bunu açıklamıyor)` : null;
    if (trigger) { this._set(id, QSTATES.QUARANTINED, t, trigger); n.cleanSince = null; }
    else if (n.state !== QSTATES.CLEAR) {
      // SERBEST BIRAKMA: bağımsız alan(lar)dan veri VAR ve temiz; kendi-raporu yalnız başına sayılmaz.
      const indepAvailable = ev.neighbor != null || ev.probeDb != null;
      const indepClean = indepAvailable && !nbBad && !probeBad && !selfBad;
      if (indepClean) { if (n.cleanSince == null) n.cleanSince = t; } else n.cleanSince = null;
      if (n.cleanSince != null && t - n.cleanSince >= o.probationMs) {
        if (n.state === QSTATES.QUARANTINED) { this._set(id, QSTATES.PROBATION, t, "bağımsız kanıt temiz — gözetim (yalnız uç, transit yok)"); n.cleanSince = t; }
        else if (n.state === QSTATES.PROBATION) { this._set(id, QSTATES.CLEAR, t, "gözetim temiz tamamlandı"); n.cleanSince = null; }
      }
    }
    return before !== n.state ? { from: before, to: n.state } : null;
  }
  operatorClear(id, t) { const n = this.n.get(id); if (n.state === QSTATES.QUARANTINED) { this._set(id, QSTATES.PROBATION, t, "operatör onayı"); n.cleanSince = t; } }
}

// ═══ 5) Orkestratör ═══
/**
 * Her adımda: ölçümler → karantina kararları → ağ eylemleri (havuz iptali, bölme, optik bypass)
 * → ipuçları (nodePenaltyKm, quarantine, probation). Çağıran: hints = mesh.update(...); net.step(t, meas, hints).
 */
class MeshIsolationController {
  constructor(network, { o = {}, independentSources = {}, enableGradedBypass = true, enableOpticalBypass = true, enableQuarantine = true } = {}) {
    this.net = network; this.o = { ...DEFAULTS, ...o };
    Object.assign(this, { enableGradedBypass, enableOpticalBypass, enableQuarantine });
    this.qm = new QuarantineManager({ nodes: network.topology.nodes.map((n) => n.id), o: this.o, independentSources });
    this.bypass = new Map();   // x → { phase:'SWITCHING'|'ACTIVE'|'REVERTING', untilMs, plan, virtualKeys }
    this.actions = [];
  }
  /** Çevre modeline göre beklenen Y0 (ağın kendi ingress modeli; ortam alanı SENSÖRDEN). */
  expectedY0(ambientDbuVm, seDb) {
    const ing = this.net._cfg.ingress;
    return A.ingressEffectiveY0({ seDb, ambientFieldDbuVm: ambientDbuVm, susceptibilityDbuVm: ing.susceptibilityDbuVm, refDarkYield: ing.refDarkYield, baseY0: 1e-5 }).Y0eff;
  }
  /**
   * KANIT ATFI. a→b linkindeki Y0'ı b'nin dedektörü ölçer; açıklanamayan bir artışın kaynağı
   * verici a (fibere ışık enjeksiyonu) da olabilir alıcı b (dedektöre RF girişi) de. Tek link bunu
   * ayırt edemez. İlk sürüm her artışı vericiye "komşu kanıtı" olarak yazıyordu; parça-2 testi
   * bunun, gürültülü bir alıcının (KDK) ona ışık gönderen MASUM komşularını (BKR, MSL, ASY)
   * karantinaya soktuğunu gösterdi. Kural (en az sayıda düğümle açıklama ilkesi):
   *   • b'nin ≥ 2 alıcı linki VAR ve HEPSİ açıklanamayan → ortak etken alıcı: neden 'rx' (b'nin kendi kanıtı)
   *   • b'nin başka bir alıcı linki TEMİZ → b'nin dedektörü sağlam: neden 'tx' (a'nın komşu kanıtı)
   *   • a'nın başka bir verici linki de (alıcı-kaynaklı olmayan biçimde) açıklanamayan → ortak etken verici: 'tx'
   *   • aksi hâlde 'ambiguous' → KAPALI BAŞARISIZLIK: kanıt İKİ uca da yazılır (ikisi de karantinaya
   *     girebilir). Tek alıcı linkli düğümlerde kaynak ayırt EDİLEMEZ; bağımsız RF probu bunu çözebilir.
   * Varsayım: RF girişi bir kabindeki tüm alıcıları birlikte etkiler; seçici enjeksiyon tek fiberde olabilir.
   */
  attributeEvidence(meas) {
    const net = this.net, thr = this.o.unexplainedRatio;
    const ls = net.links.filter((l) => !l.virtual && net.linkEnabled(l.key)).map((l) => {
      const y = meas.y0[l.key], rx = l.b;
      const r = Number.isFinite(y) ? y / this.expectedY0(meas.ambient[rx], meas.se[rx]) : null;
      return { l, r, anom: r != null && r >= thr };
    }).filter((x) => x.r != null);
    const rxOf = (id) => ls.filter((x) => x.l.b === id), txOf = (id) => ls.filter((x) => x.l.a === id);
    const rxExplained = (id) => { const r = rxOf(id); return r.length >= 2 && r.every((x) => x.anom); };
    for (const x of ls) {
      if (!x.anom) { x.cause = null; continue; }
      const a = x.l.a, b = x.l.b;
      if (rxExplained(b)) x.cause = "rx";
      else if (rxOf(b).some((m) => m !== x && !m.anom)) x.cause = "tx";
      else if (txOf(a).some((m) => m !== x && m.anom && !rxExplained(m.l.b))) x.cause = "tx";
      else x.cause = "ambiguous";
    }
    const med = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const perNode = {};
    for (const n of net.topology.nodes) {
      const self = rxOf(n.id).filter((x) => x.cause !== "tx").map((x) => x.r);
      const nb = txOf(n.id).filter((x) => x.cause !== "rx").map((x) => x.r);
      perNode[n.id] = { self: med(self), neighbor: nb.length ? Math.max(...nb) : null };
    }
    return { perLink: Object.fromEntries(ls.map((x) => [x.l.key, { ratio: x.r, cause: x.cause }])), perNode };
  }
  /**
   * @param meas { se:{node:dB}, y0:{linkKey:Y0}, ambient:{node:dBµV/m}, probe:{node:dB|undefined}, lockIncident:{node:bool} }
   */
  update(t, meas) {
    const net = this.net, hints = { nodePenaltyKm: {}, quarantine: [], probation: [] };
    const thr = net.seRequiredDb + A.DEFAULT_SE_MEASUREMENT_UNCERTAINTY_DB;
    const ev = this.attributeEvidence(meas);
    this.lastEvidence = ev;
    for (const n of net.topology.nodes) {
      const id = n.id;
      if (this.enableQuarantine) {
        const e = ev.perNode[id];
        const tr = this.qm.observe(id, t, { self: e.self, neighbor: e.neighbor, probeDb: meas.probe ? meas.probe[id] : null, lockIncident: !!(meas.lockIncident && meas.lockIncident[id]) });
        if (tr) this._onTransition(id, tr, t);
      }
      const qs = this.qm.state(id);
      if (qs === QSTATES.QUARANTINED) hints.quarantine.push(id);
      else if (qs === QSTATES.PROBATION) hints.probation.push(id);
      // ── kademeli transit cezası (marj) ──
      if (this.enableGradedBypass && qs === QSTATES.CLEAR) { const p = transitPenaltyKm((meas.se[id] ?? -Infinity) - thr, this.o); if (p > 0) hints.nodePenaltyKm[id] = p; }
    }
    this._advanceBypass(t);
    return hints;
  }
  _onTransition(id, tr, t) {
    const net = this.net;
    const touching = net.links.filter((l) => !l.virtual && (l.a === id || l.b === id));
    if (tr.to === QSTATES.QUARANTINED) {
      let revoked = 0;
      for (const l of touching) { revoked += l.ctl.cleanPoolBits; l.ctl.revokePool(); l.ctl.setPartition("quarantine"); }
      this.actions.push({ atMs: t, nodeId: id, action: "KARANTİNA", revokedBits: revoked, reason: this.qm.n.get(id).reason });
      if (this.enableOpticalBypass && !this.bypass.has(id)) {
        const otherQuarantined = new Set([...this.qm.n].filter(([k, v]) => k !== id && v.state === QSTATES.QUARANTINED).map(([k]) => k));
        const plan = planOpticalBypass(net, id, { o: this.o, excluded: otherQuarantined });
        if (plan.chosen.length) {
          // anahtarlama başlar: X'in seçilen fiberlerindeki linkler HEMEN askıya (fiber yerinden alınıyor)
          for (const c of plan.chosen) for (const k of c.fibers) net.setLinkEnabled(k, false);
          this.bypass.set(id, { phase: "SWITCHING", untilMs: t + this.o.reconfigMs, plan, virtualKeys: [] });
          this.actions.push({ atMs: t, nodeId: id, action: "OPTİK BYPASS ANAHTARLAMA BAŞLADI", pairs: plan.chosen.map((c) => `${c.a}–${c.b} (${c.km} km, ~${(c.rateBps / 1e3).toFixed(0)} kbps)`) });
        } else this.actions.push({ atMs: t, nodeId: id, action: "OPTİK BYPASS YOK", reason: plan.candidates.length ? "fizibıl/yararlı çift yok" : "komşu çifti yok" });
      }
    } else if (tr.to === QSTATES.PROBATION) {
      for (const l of touching) l.ctl.setPartition("main"); // bölme anahtarı İMHA, yeni anahtar ana havuza
      const b = this.bypass.get(id);
      if (b && b.phase !== "REVERTING") { for (const k of b.virtualKeys) net.setLinkEnabled(k, false); b.phase = "REVERTING"; b.untilMs = t + this.o.reconfigMs; }
      this.actions.push({ atMs: t, nodeId: id, action: "GÖZETİM (PROBATION)" });
    } else if (tr.to === QSTATES.CLEAR) this.actions.push({ atMs: t, nodeId: id, action: "TEMİZ" });
  }
  _advanceBypass(t) {
    for (const [id, b] of this.bypass) {
      if (b.phase === "SWITCHING" && t >= b.untilMs) {
        for (const c of b.plan.chosen) {
          const key = NETM.linkKey(c.a, c.b);
          if (this.net.linkByKey.has(key)) this.net.setLinkEnabled(key, true);
          else this.net.addLink({ a: c.a, b: c.b, km: c.km, insertionLossDb: this.o.switchInsertionLossDb, via: id });
          b.virtualKeys.push(key);
        }
        b.phase = "ACTIVE"; this.actions.push({ atMs: t, nodeId: id, action: "OPTİK BYPASS ETKİN", links: b.virtualKeys });
      } else if (b.phase === "REVERTING" && t >= b.untilMs) {
        for (const c of b.plan.chosen) for (const k of c.fibers) this.net.setLinkEnabled(k, true);
        this.bypass.delete(id); this.actions.push({ atMs: t, nodeId: id, action: "OPTİK BYPASS GERİ ALINDI" });
      }
    }
  }
}

module.exports = { DEFAULTS, QSTATES, articulationPoints, reachableAvoiding, bypassAnalysis, transitPenaltyKm, planOpticalBypass, QuarantineManager, MeshIsolationController };
