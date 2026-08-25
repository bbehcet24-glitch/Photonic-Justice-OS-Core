#!/usr/bin/env node
"use strict";
/**
 * timetag_acquisition_bridge.js — FAZ 1: ACQUISITION KÖPRÜSÜ (B1+B2+B3)
 * ═══════════════════════════════════════════════════════════════════
 * Yol haritasının Faz 1'i: gerçek donanımın (time-tagger) ürettiği ham
 * ps zaman-etiketli dedektör tıklama akışını, klasik yığının (L4 sifting)
 * beklediği forma çeviren "son mil" köprüsü — donanım gelmeden yazılım
 * tarafını inşa eder ve GERÇEK dedektör kusurlarına karşı sınar.
 *
 * ÜÇ PARÇA (roadmap B1/B2/B3):
 *   • TimeTagEmulator — gerçek bir time-tagger'ın göreceği şeyi üretir:
 *     Bob'un 4 dedektör kanalı (H/V/D/A), her tıklamada ps zaman etiketi,
 *     GERÇEK kusurlarla: dedektör VERİMİ, KARANLIK SAYIM, zamanlama JITTER'ı,
 *     ÖLÜ ZAMAN, optik hizasızlık. (Sim'in ideal gürültü modelinin aksine.)
 *   • CoincidenceEngine (B3) — sync saatine göre her tıklamayı bir zaman
 *     yuvasına atar; koinsidans PENCERESİ dışındakileri (jitter/karanlık) atar.
 *   • sift (B1) — Alice/Bob baz uzlaşımı + tek-tıklama yuvaları → ham
 *     elenmiş anahtar + ÖLÇÜLEN QBER (fizikten, sabit kodlu değil).
 *
 * QRNG SEAM (B2): Alice'in baz/bit seçimi enjekte edilebilir bir `qrng`
 * kaynağından gelir — mulberry32 DEĞİL. Varsayılan crypto.randomBytes
 * (gerçek entropi temsilcisi); üretimde donanım QRNG buraya takılır.
 * (Fiziksel rastgelelik — karanlık sayım/jitter/verim — tohumlu PRNG ile
 * modellenir; o ANAHTAR değil, fiziktir.)
 *
 * GÜVENLİK: intercept-resend casusu enjekte edilince QBER ~%25'e sıçrar
 * (BB84 imzası) → BB84 eşiğini (~%11) aşar → anahtar İPTAL. Köprü,
 * gerçekçi veri altında QKD'nin güvenlik özelliğini korur.
 *
 * Çekirdek photonnet_core.js DEĞİŞTİRİLMEZ (yalnız mulberry32 fizik için).
 */
const crypto = require("crypto");
const { mulberry32 } = require("./photonnet_core.js");

const Z = 0, X = 1;                       // bazlar
// Dedektör haritası: 0=Z-bit0(H) 1=Z-bit1(V) 2=X-bit0(D) 3=X-bit1(A)
const basisOf = d => (d < 2 ? Z : X);
const bitOf = d => d & 1;
const detOf = (basis, bit) => (basis === X ? 2 : 0) + bit;
const QBER_ABORT = 0.11;                  // BB84 tek-yönlü EC/PA güvenli eşik (~%11)

/** Gerçek entropi temsilcisi (üretimde donanım QRNG ile değişir). */
function cryptoQrng() { let buf = crypto.randomBytes(4096), i = 0;
  return { bit() { if (i >= buf.length * 8) { buf = crypto.randomBytes(4096); i = 0; }
    const b = (buf[i >> 3] >> (i & 7)) & 1; i++; return b; } }; }
/** Tohumlu QRNG (yalnız tekrarlanabilir test için — seam'i gösterir). */
function seededQrng(seed) { const r = mulberry32(seed >>> 0); return { bit: () => (r() < 0.5 ? 0 : 1) }; }

/**
 * Time-tagger emülatörü — Bob tarafında ham tıklama akışı üretir.
 * @param opts.pulses      — gönderilen darbe sayısı
 * @param opts.periodPs    — darbe periyodu (ps)
 * @param opts.efficiency  — sinyal foton algılama olasılığı (η, kanal+dedektör)
 * @param opts.darkProb    — kapı başına karanlık sayım olasılığı (dedektör başına)
 * @param opts.jitterPs    — zamanlama jitter'ı (Gauss σ, ps)
 * @param opts.deadTimePs  — dedektör ölü zamanı (ps)
 * @param opts.eDetect     — optik hizasızlık hata olasılığı
 * @param opts.eavesdrop   — intercept-resend casusu
 * @param opts.qrng        — Alice/Bob baz/bit kaynağı (B2 seam)
 * @param opts.physSeed    — fiziksel rastgelelik tohumu
 */
class TimeTagEmulator {
  constructor(opts = {}) {
    this.o = Object.assign({ pulses: 100000, periodPs: 1000, efficiency: 0.12, darkProb: 5e-4,
      jitterPs: 80, deadTimePs: 0, eDetect: 0.01, eavesdrop: false, physSeed: 1 }, opts);
    // Bob saat kayması (Faz 2): tüm Bob zaman etiketlerine yuvaya bağlı bir
    // offset ekler. Varsayılan yok (Faz 1 davranışı birebir korunur).
    this.clockOffsetPs = opts.clockOffsetPs || (() => 0);
    this.qrng = opts.qrng || cryptoQrng();
    this.rnd = mulberry32(this.o.physSeed >>> 0);
  }
  _gauss(sigma) { // Box–Muller (fiziksel jitter)
    const u1 = Math.max(this.rnd(), 1e-12), u2 = this.rnd();
    return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  run() {
    const o = this.o;
    const aliceBasis = new Uint8Array(o.pulses), aliceBit = new Uint8Array(o.pulses);
    const events = [];                                   // {tPs, det}
    const lastClickPs = [-1e18, -1e18, -1e18, -1e18];    // ölü zaman izleme
    let darkClicks = 0, signalClicks = 0;
    const tryClick = (det, tPs) => {
      if (tPs - lastClickPs[det] < o.deadTimePs) return false;  // ölü zaman
      lastClickPs[det] = tPs; events.push({ tPs, det }); return true;
    };
    for (let i = 0; i < o.pulses; i++) {
      const aB = this.qrng.bit() ? X : Z, aBit = this.qrng.bit();
      aliceBasis[i] = aB; aliceBit[i] = aBit;
      const slotT = i * o.periodPs + this.clockOffsetPs(i);   // Bob saat kayması dahil
      // Alice'in yolladığı foton durumu (casus varsa değiştirilir)
      let phB = aB, phBit = aBit;
      if (o.eavesdrop) {                                 // intercept-resend
        const eB = this.rnd() < 0.5 ? X : Z;
        const eBit = (eB === aB) ? aBit : (this.rnd() < 0.5 ? 1 : 0);
        phB = eB; phBit = eBit;                          // Eve ölçtüğü bazda yeniden yollar
      }
      // Sinyal algılama (verim)
      if (this.rnd() < o.efficiency) {
        const bB = this.qrng.bit() ? X : Z;              // Bob bazı
        let bBit;
        if (bB === phB) { bBit = (this.rnd() < o.eDetect) ? (phBit ^ 1) : phBit; }  // uyumlu baz + hizasızlık
        else { bBit = this.rnd() < 0.5 ? 1 : 0; }        // uyumsuz baz → rastgele
        const t = slotT + this._gauss(o.jitterPs);
        if (tryClick(detOf(bB, bBit), t)) signalClicks++;
      }
      // Karanlık sayımlar (her dedektör bağımsız)
      for (let d = 0; d < 4; d++) {
        if (this.rnd() < o.darkProb) {
          const t = slotT + (this.rnd() - 0.5) * o.periodPs;  // kapı içinde rastgele
          if (tryClick(d, t)) darkClicks++;
        }
      }
    }
    return { aliceBasis, aliceBit, events, pulses: o.pulses, periodPs: o.periodPs,
      darkClicks, signalClicks };
  }
}

/**
 * Koinsidans motoru (B3): her tıklamayı en yakın sync yuvasına atar;
 * |t − yuva·T| ≤ pencere/2 ise KABUL. Yuva başına tıklamaları toplar.
 * @returns Map<slot, det[]>  (kabul edilen tıklamalar)
 */
function coincidence(events, periodPs, windowPs) {
  const slots = new Map();
  let admitted = 0, rejected = 0;
  for (const e of events) {
    const slot = Math.round(e.tPs / periodPs);
    if (Math.abs(e.tPs - slot * periodPs) <= windowPs / 2) {
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(e.det); admitted++;
    } else rejected++;
  }
  return { slots, admitted, rejected };
}

/**
 * Sifting (B1): tek-tıklama yuvalarında Alice/Bob baz uzlaşımı → elenmiş
 * bit; Alice bitiyle karşılaştırıp QBER ölçer. Çok-tıklamalı yuvalar atılır.
 */
function sift(acq, slots) {
  let sifted = 0, errors = 0, multi = 0, basisMismatch = 0;
  const bits = [];
  for (const [slot, dets] of slots) {
    if (slot < 0 || slot >= acq.pulses) continue;
    if (dets.length !== 1) { multi++; continue; }        // çift-tıklama → at
    const det = dets[0], bB = basisOf(det);
    if (bB !== acq.aliceBasis[slot]) { basisMismatch++; continue; }  // baz uyumsuz → at
    const bBit = bitOf(det);
    sifted++;
    if (bBit !== acq.aliceBit[slot]) errors++;
    bits.push(bBit);
  }
  return { sifted, errors, multi, basisMismatch,
    qber: sifted ? errors / sifted : 0,
    siftYield: acq.pulses ? sifted / acq.pulses : 0, bits };
}

/** Uçtan uca acquisition: emüle et → koinsidans → sift. */
function acquire({ windowPs, ...emuOpts }) {
  const emu = new TimeTagEmulator(emuOpts);
  const acq = emu.run();
  const co = coincidence(acq.events, acq.periodPs, windowPs ?? acq.periodPs * 0.3);
  const s = sift(acq, co.slots);
  return { ...s, windowPs: windowPs ?? acq.periodPs * 0.3,
    admitted: co.admitted, rejected: co.rejected,
    darkClicks: acq.darkClicks, signalClicks: acq.signalClicks,
    secure: s.qber < QBER_ABORT };
}

/**
 * Faz 0 KÖPRÜSÜ: distile edilmiş anahtar bitlerini KME route export
 * biçimine paketler ({routes:{routeKey:[{key_ID,key,sizeBits}]}}).
 * NOT: elenmiş bitler HENÜZ gizli değil — gerçek akışta önce L4 EC +
 * L6/PA çalışır; bu yalnız BİÇİM köprüsünü (Faz 0'a takılabilirlik) gösterir.
 */
function packForKme(bits, { routeKey = "ANK-MASTER", keyBits = 256 } = {}) {
  const perKey = keyBits, nKeys = Math.floor(bits.length / perKey);
  const entries = [];
  for (let k = 0; k < nKeys; k++) {
    const bytes = Buffer.alloc(perKey / 8);
    for (let b = 0; b < perKey; b++) if (bits[k * perKey + b]) bytes[b >> 3] |= (1 << (7 - (b & 7)));
    entries.push({ key_ID: crypto.randomUUID(), key: bytes.toString("base64"), sizeBits: keyBits, blockIndex: k + 1 });
  }
  return { routes: { [routeKey]: entries } };
}

module.exports = { TimeTagEmulator, coincidence, sift, acquire, packForKme,
  cryptoQrng, seededQrng, basisOf, bitOf, detOf, QBER_ABORT };
