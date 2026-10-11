#!/usr/bin/env node
"use strict";
/**
 * maintenance_traffic_coordinator.js — kestirimci bakım uyarılarını
 * (predictive_maintenance.js) ÇOK-DÜĞÜMLÜ AĞA bağlar: WARNING alan düğümden
 * trafik bakımdan ÖNCE kaydırılır, bakım penceresi planlı kesinti olarak
 * uygulanır, kafes kapısı ancak düğüm boşaltıldıktan sonra açılır.
 * ═══════════════════════════════════════════════════════════════════
 * DÜĞÜM DURUMLARI (zaman birimi: saat — prognostik katmanla aynı):
 *   NORMAL       — kısıt yok
 *   PLANNED      — ADVISORY: bakım planlandı, ağda HENÜZ değişiklik yok
 *   DRAIN        — WARNING / CRITICAL / ani düşüş (STEP_CHANGE): düğüme dokunan
 *                  linkler drainPenaltyKm ceza ağırlığı alır → TRANSİT trafik
 *                  alternatif yola kayar; alternatif yoksa trafik KESİLMEZ
 *                  (ceza, dışlama değil). Düğümün kendi SAE'leri hizmet almaya
 *                  devam eder ve planlı kesinti BİLDİRİMİ alır.
 *                  Ayrıca planlı HER pencereden preDrainHours (vars. 24 saat) önce
 *                  kendiliğinden DRAIN başlar — ADVISORY ile erken planlanan bakımda da.
 *   INCIDENT     — kabin kilidi HAL'i yetkisiz açılış bildirdi (TAMPER/OVERRIDE):
 *                  düğüm HEMEN ağ dışı, clearIncident'a kadar (bkz. cabinet_lock_hal.js).
 *   MAINTENANCE  — bakım penceresi [başlangıç, bitiş): düğüm relay / uç / mTLS
 *                  DIŞI (KME kapısı level=MAINTENANCE, self.mtlsAllowed=false).
 *                  Teknisyen kafes kapısını ANCAK `doorMayOpen()` doğruyken açar:
 *                  pencere başlamış VE ağın yürürlükteki planı düğümü kullanmıyor.
 * Bakım tamamlanınca (completeMaintenance) düğüm NORMAL'e döner; prognostik
 * monitöre notifyMaintenance çağrısı çağıranın işidir.
 *
 * NEDEN ÖNEMLİ (ölçüldü, bkz. maintenance_traffic_shift_test.js): ağ teslimi
 * nedenseldir — her örnekleme aralığı bir ÖNCEKİ okumayla verilen kararla
 * yönlendirilir. Kafes kapısı habersiz açılırsa, açıldığı aralıkta düğümden
 * geçen anahtar materyali açık kafeste işlenmiş olur (izole olmayan düğümde
 * teslimat-yolu maruziyeti). Planlı boşaltma bu aralığı SIFIRLAR; ayrıca transit
 * akışlar kapı açılmadan önce yeni yollarına geçer (önce kur, sonra kes).
 *
 * KAPSAM: production_gate.js ve CI'a bağlanmadı. Bildirimler bir olay listesidir;
 * gerçek bir SAE bildirim kanalı (ör. ETSI 014 dışı yönetim API'si) bu projede yok.
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const DEFAULTS = Object.freeze({
  drainPenaltyKm: 2000,          // HOLD cezasından (1000 km) büyük: yakında kapanacak düğüm en son tercih
  defaultDurationHours: 2,       // conta değişimi için planlanan pencere
  preDrainHours: 24,             // planlı her pencereden bu kadar önce boşaltma başlar (ADVISORY ile planlananlar dahil)
  drainLevels: Object.freeze(["WARNING", "CRITICAL"]),
});

class MaintenanceTrafficCoordinator {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.nodes = new Map(); // nodeId → { mode, since, reason, window:{startH,endH}|null }
    this.notices = [];      // SAE / operatör bildirimleri
    this.log = [];
    this.incidents = [];    // yetkisiz kapı açılışları (kilit HAL'inden)
  }
  _get(id) { if (!this.nodes.has(id)) this.nodes.set(id, { mode: "NORMAL", since: null, reason: null, window: null }); return this.nodes.get(id); }
  _set(id, mode, tH, reason) {
    const n = this._get(id);
    if (n.mode !== mode) { this.log.push({ nodeId: id, from: n.mode, to: mode, atHours: tH, reason }); n.mode = mode; n.since = tH; n.reason = reason; }
    return n;
  }

  /** predictive_maintenance.PrognosticsMonitor olayı. */
  ingestEvent(ev) {
    const n = this._get(ev.nodeId);
    if (ev.kind === "ALERT") {
      if (this.opts.drainLevels.includes(ev.level)) {
        if (n.mode !== "MAINTENANCE" && n.mode !== "INCIDENT") this._set(ev.nodeId, "DRAIN", ev.atHours, `${ev.level} uyarısı (${ev.basis || "RUL"})`);
      } else if (ev.level === "ADVISORY" && n.mode === "NORMAL") this._set(ev.nodeId, "PLANNED", ev.atHours, "ADVISORY: bakım planlandı");
    } else if (ev.kind === "STEP_CHANGE" && ev.direction === "düşüş") {
      if (n.mode !== "MAINTENANCE" && n.mode !== "INCIDENT") this._set(ev.nodeId, "DRAIN", ev.atHours, "ani SE düşüşü — muayene bekleniyor");
    } else if (ev.kind === "DOWNGRADE" && n.mode === "DRAIN" && !n.window) {
      this._set(ev.nodeId, ev.level === "ADVISORY" ? "PLANNED" : "NORMAL", ev.atHours, `uyarı ${ev.level} düzeyine düştü`);
    }
  }

  /** predictive_maintenance.MaintenanceScheduler iş emri: { nodeId, dueH, reason } */
  scheduleMaintenance(order, durationHours = this.opts.defaultDurationHours) {
    const n = this._get(order.nodeId);
    n.window = { startH: order.dueH, endH: order.dueH + durationHours, reason: order.reason };
    this.notices.push({ type: "planned-outage", nodeId: order.nodeId, startH: n.window.startH, endH: n.window.endH, reason: order.reason,
      message: `${order.nodeId} düğümünde planlı bakım: SAE↔KME hizmeti ${n.window.startH.toFixed(1)}–${n.window.endH.toFixed(1)}. saatlerde kesilecek; transit trafik önceden başka yollara kaydırılıyor.` });
    return n.window;
  }

  /** Zamanı ilerlet: pencereye preDrainHours kala DRAIN, pencere başladıysa MAINTENANCE. */
  tick(tH) {
    for (const [id, n] of this.nodes) {
      // Uçtan uca zincir testi bulgusu: ADVISORY ile erken planlanan bakım WARNING'den ÖNCE geldiğinde
      // düğüm hiç DRAIN'den geçmeden MAINTENANCE'a giriyordu → transit trafik pencere anında kesiliyordu.
      if (n.window && tH >= n.window.startH - this.opts.preDrainHours && tH < n.window.startH && (n.mode === "NORMAL" || n.mode === "PLANNED")) {
        this._set(id, "DRAIN", tH, `bakım penceresi öncesi boşaltma (${this.opts.preDrainHours} saat)`);
      }
      // Pencere bitişi aşılsa bile MAINTENANCE sürer — yalnız completeMaintenance kaldırır (bakım uzayabilir).
      if (n.window && tH >= n.window.startH && n.mode !== "MAINTENANCE" && n.mode !== "INCIDENT") this._set(id, "MAINTENANCE", tH, `planlı bakım penceresi (${n.window.reason || "iş emri"})`);
    }
  }

  /** Bakım bitti (conta değişti, kapı kapandı, SE doğrulandı). */
  completeMaintenance(id, tH) { const n = this._get(id); n.window = null; this._set(id, "NORMAL", tH, "bakım tamamlandı"); }

  /** ShieldedQkdNetwork.step(…, hints) için ipuçları. */
  hints(tH) {
    this.tick(tH);
    const drainPenaltyKm = {}, maintenance = [];
    for (const [id, n] of this.nodes) {
      if (n.mode === "DRAIN") drainPenaltyKm[id] = this.opts.drainPenaltyKm;
      if (n.mode === "MAINTENANCE" || n.mode === "INCIDENT") maintenance.push(id);
    }
    return { drainPenaltyKm, maintenance };
  }

  /** Teknisyen kafes kapısını açabilir mi? pencere başlamış + ağ planı düğümü kullanmıyor. */
  doorMayOpen(id, tH, network) {
    const n = this._get(id);
    return n.mode === "MAINTENANCE" && !!n.window && tH >= n.window.startH && !network.planUsesNode(id);
  }

  /**
   * Kabin kilidi HAL'i (cabinet_lock_hal.js) ile bağlantı: doorMayOpen doğruysa Ed25519 imzalı,
   * kısa ömürlü, tek kullanımlık AÇMA YETKİSİ üretir; yetki "boşaltıldı" beyanını taşır.
   * @returns {{granted, token?, reason?}}
   */
  authorizeDoor(id, tH, network, authority, { nowMs, workOrderId, technicianId, ttlMs = 120000 }) {
    const n = this._get(id);
    if (!this.doorMayOpen(id, tH, network)) {
      const reason = n.mode === "INCIDENT" ? "düğümde açık olay (INCIDENT) — önce incelenmeli"
        : n.mode !== "MAINTENANCE" ? `düğüm ${n.mode} — bakım penceresi başlamadı`
        : network.planUsesNode(id) ? "ağ planı düğümü hâlâ kullanıyor (boşaltma bitmedi)" : "planlı pencere yok";
      this.log.push({ nodeId: id, atHours: tH, kind: "UNLOCK_REFUSED", reason });
      return { granted: false, reason };
    }
    const token = authority.issue({ nodeId: id, workOrderId, technicianId, nbfMs: nowMs, expMs: nowMs + ttlMs,
      attestation: { drained: true, planCheckedAtMs: nowMs, windowStartH: n.window.startH } });
    this.log.push({ nodeId: id, atHours: tH, kind: "UNLOCK_AUTHORIZED", workOrderId, technicianId });
    return { granted: true, token };
  }

  /**
   * Kilit/kapı sensörü olayı. Yetkisiz açılış (TAMPER, OVERRIDE, yetkisiz DOOR_OPENED ya da
   * bakım dışı bir düğümde açılış) → INCIDENT: düğüm HEMEN ağ dışı. Çağıran, SE izleyicisinin
   * bir sonraki örneğini beklemeden ağı YENİDEN PLANLAMALIDIR (replanNow).
   */
  onLockEvent(ev, tH) {
    const n = this._get(ev.nodeId);
    const unauthorized = ev.type === "TAMPER" || ev.type === "OVERRIDE" || (ev.type === "DOOR_OPENED" && (!ev.authorized || n.mode !== "MAINTENANCE"));
    if (unauthorized) {
      this._set(ev.nodeId, "INCIDENT", tH, `yetkisiz kabin açılışı (${ev.type})`);
      const inc = { nodeId: ev.nodeId, type: ev.type, atHours: tH, sensorAtMs: ev.atMs, detail: ev.detail };
      this.incidents.push(inc);
      this.notices.push({ type: "security-incident", nodeId: ev.nodeId, message: `${ev.nodeId} kabini yetkisiz açıldı (${ev.type}) — düğüm ağdan çıkarıldı, yerinde inceleme gerekli.` });
      return { replanNow: true, incident: inc };
    }
    if (ev.type === "UNLOCK_FAILED") this.log.push({ nodeId: ev.nodeId, atHours: tH, kind: "UNLOCK_FAILED", reason: ev.reason });
    return { replanNow: false };
  }

  /** Olay incelendi, kafes SE'si doğrulandı → NORMAL. */
  clearIncident(id, tH) { const n = this._get(id); if (n.mode === "INCIDENT") this._set(id, n.window ? "MAINTENANCE" : "NORMAL", tH, "olay incelendi, kapatıldı"); }

  mode(id) { return this._get(id).mode; }
}

module.exports = { MaintenanceTrafficCoordinator, DEFAULTS };
