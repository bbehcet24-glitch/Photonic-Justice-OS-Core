#!/usr/bin/env node
"use strict";
/**
 * timing_coincidence_engine.js — FAZ 2: ZAMANLAMA & KOİNSİDANS MOTORU
 * ═══════════════════════════════════════════════════════════════════
 * Faz 1 acquisition köprüsü MÜKEMMEL saat varsaydı (yuva = round(t/T)).
 * Gerçekte Alice ile Bob'un saatleri BİRBİRİNE GÖRE KAYAR (drift). Bu,
 * async_sync tatbikatının bulduğu asimetrik-senkronizasyon sorununun
 * acquisition katmanındaki yüzü: kayma biriktikçe koinsidans penceresi
 * gerçek tıklamalardan UZAKLAŞIR, tıklamalar YANLIŞ YUVAYA düşer →
 * elenmiş bit yanlış Alice slotuyla karşılaştırılır → QBER YÜKSELİR.
 *
 * KRİTİK DÜRÜST BULGU: düzeltilmemiş saat kayması bir CASUS gibi görünür
 * (QBER fırlar) ama bir SENKRONİZASYON sorunudur. İki mekanizmayı bağlar:
 *   • L5.5 (Kalman saat kurtarma / predictive_jitter_alignment): saat
 *     offsetini çevrimiçi öğrenip pencere merkezini ÖN-BESLEMELİ kaydırır
 *     → kayma artefaktını siler, QBER fizik tabanına döner. Casusu SÜREKLİ
 *     drift'ten AYIRIR — ama gerçek bir casusu MASKELEMEZ (Eve'in hatası
 *     öngörülebilir zaman yapısı değil; Kalman onu silemez).
 *   • L5.6 (ODLS / optical_delay_line): ani bir saat SIÇRAMASI sonrası
 *     Kalman ~birkaç adımda toparlanır; o geçiş penceresinde tıklamalar
 *     hizasız kalır → ODLS onları bütçe içinde DONDURUP toparlanınca
 *     bırakır → geçiş kaybı ~0.
 *
 * "Model ilk kez gerçekle yüzleşiyor": L5.5 + L5.6 soyut olarak
 * doğrulanmıştı; burada somut bir acquisition problemine (saat kayması)
 * uygulanıp uçtan uca sınanıyorlar. Çekirdek DEĞİŞTİRİLMEZ.
 */
const B = require("./timetag_acquisition_bridge.js");
const { JitterPredictor } = require("./predictive_jitter_alignment.js");
const ODL = require("./optical_delay_line.js");
const { mulberry32 } = require("./photonnet_core.js");

/** Saat offset modeli (ps): doğrusal drift + opsiyonel ani sıçrama. */
function makeOffset({ driftPerSlotPs = 0, jumpPs = 0, jumpAtSlot = Infinity } = {}) {
  const fn = (k) => driftPerSlotPs * k + (k >= jumpAtSlot ? jumpPs : 0);
  fn.driftPerSlotPs = driftPerSlotPs; fn.jumpPs = jumpPs; fn.jumpAtSlot = jumpAtSlot;
  return fn;
}

/** Emülatörü verilen saat offsetiyle koştur. */
function acquireWithClock({ offset, ...emuOpts }) {
  const emu = new B.TimeTagEmulator({ ...emuOpts, clockOffsetPs: offset });
  return emu.run();
}

/** SABİT-yuva (naif) sift — Faz 1 davranışı; drift altında bozulur. */
function siftFixed(acq, windowPs) {
  const co = B.coincidence(acq.events, acq.periodPs, windowPs);
  const s = B.sift(acq, co.slots);
  return { ...s, admitted: co.admitted, rejected: co.rejected };
}

/**
 * KALMAN SAAT KURTARMALI sift (L5.5). Sync kadansında (syncEverySlots)
 * gürültülü bir offset ölçümü alınır; JitterPredictor öğrenir; aralarda
 * ÖN-BESLEMELİ tahmin edilir. Her tıklama t_corr = t_obs − tahmin(slot)
 * ile düzeltilip yeniden yuvalanır. Ani sıçrama sonrası toparlanma da ölçülür.
 */
function siftRecovered(acq, { windowPs, offset, syncEverySlots = 200, syncNoisePs = 30,
  q = 5e-3, r = 1.0, physSeed = 9 }) {
  const T = acq.periodPs, N = acq.pulses;
  const rnd = mulberry32(physSeed >>> 0);
  const gauss = (sig) => { const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    return sig * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
  // Sync kadansında Kalman'ı sür; her sync sonrası [s, s+S) için offset tahmini doldur.
  const kf = new JitterPredictor({ q, r });
  const est = new Float64Array(N);
  const S = syncEverySlots;
  for (let s = 0; s < N; s += S) {
    const z = offset(s) + gauss(syncNoisePs);          // gürültülü sync ölçümü
    kf.update(z);                                        // L5.5 çevrimiçi güncelleme
    const b = kf.b, d = kf.d;                            // offset@s, drift/sync-adımı
    for (let k = s; k < Math.min(s + S, N); k++) est[k] = b + d * ((k - s) / S);
  }
  // Düzeltilmiş yeniden-yuvalama.
  const slots = new Map();
  for (const e of acq.events) {
    const naiveSlot = Math.round(e.tPs / T);
    const off = est[Math.min(Math.max(naiveSlot, 0), N - 1)] || 0;
    const tCorr = e.tPs - off;
    const slot = Math.round(tCorr / T);
    if (Math.abs(tCorr - slot * T) <= windowPs / 2) {
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(e.det);
    }
  }
  const s = B.sift(acq, slots);
  // Toparlanma metriği: sıçrama sonrası |tahmin − gerçek| < pencere/2 olana dek kaç slot.
  let recoverySlots = null;
  if (offset.jumpAtSlot < N) {
    const j = offset.jumpAtSlot;
    for (let k = j; k < N; k++) {
      if (Math.abs(est[k] - offset(k)) < windowPs / 2) { recoverySlots = k - j; break; }
    }
  }
  return { ...s, est, recoverySlots };
}

/**
 * ODLS ile ani-sıçrama geçişini köprüle (L5.6). Toparlanma süresi boyunca
 * hizasız kalan tıklamalar, düşürülmek yerine optik tamponda tutulur.
 * @returns geçiş kaybı ODLS'siz vs ODLS'li + bütçe fizibilitesi.
 */
function bridgeClockJump(acq, recoverySlots, { windowPs, mediumKey = "smf" } = {}) {
  const periodMs = acq.periodPs * 1e-9;                  // 1000 ps = 1e-6 ms
  const holdMs = (recoverySlots || 0) * periodMs;
  // ODLS provizyonu: toparlanma penceresini SMF fiber döngüde köprüle.
  const prov = ODL.provisionOdls({ recoverySteps: recoverySlots || 1, stepMs: periodMs, medium: mediumKey });
  // Geçiş penceresindeki sinyal tıklama ~ verim × toparlanma slotları.
  const transientClicks = Math.round((acq.signalClicks / acq.pulses) * (recoverySlots || 0));
  const heldDelivered = prov.feasible ? Math.round(transientClicks * prov.survival) : 0;
  return { recoverySlots, holdUs: +(holdMs * 1000).toFixed(3),
    transientClicks, withoutOdlsDropped: transientClicks,
    withOdlsDelivered: heldDelivered, withOdlsTimeoutDrops: 0,
    odlsFeasible: prov.feasible, odlsLossDb: prov.totalLossDb, odlsSurvivalPct: prov.survivalPct };
}

module.exports = { makeOffset, acquireWithClock, siftFixed, siftRecovered, bridgeClockJump };
