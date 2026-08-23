#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * ULTRA-DÜŞÜK GECİKME İÇİN ANAHTAR TEDARİK KATMANI
 * ═══════════════════════════════════════════════════════════════════
 * Sorun: sert ve kısa bir SLA (<350 ms) sistemi kilitliyor — bloklar
 * sonlu-anahtar sınırını geçemiyor ve üretilen çiftlerin %100'ü çöpe
 * gidiyor (ölçüldü: 100 ve 200 ms'de sıfır bit).
 *
 * ── STRATEJİ 1: ELASTİK PENCERE ──
 * Sabit zaman aşımı yerine "ℓ eşiği geçtiği anda kapat". Blok, hedef
 * anahtar uzunluğuna ULAŞTIĞI ilk anda kapanır; gecikme sabit değil,
 * kanal kalitesinin türevidir.
 * DÜRÜSTLÜK: bu, kilidi açar ama ULTRA-DÜŞÜK GECİKME VERMEZ. Sonlu-
 * anahtar sınırı fiziksel bir alt sınır dayatır — hangi politikayı
 * kurarsanız kurun, ilk güvenli bit belli bir süreden önce çıkamaz.
 * Elastik pencere "gecikme garantisi"ni "anahtar garantisi"ne ÇEVİRİR;
 * ikisini aynı anda vermez. Test bunu ölçer.
 *
 * ── STRATEJİ 2: ANAHTAR DEPOSU (asıl çözüm) ──
 * Anahtar ÜRETİM gecikmesi ile anahtar TESLİM gecikmesi aynı şey
 * değildir. Depo bu ikisini AYIRIR: üretim yüksek SLA'da (uzun blok,
 * tavana yakın hız) çalışır, tüketici depodan anında servis alır.
 * Depoda anahtar varsa tüketicinin gördüğü gecikme ≈ 0'dır.
 *
 * Bu, sorunu bir KUYRUK/ENVANTER problemine dönüştürür:
 *   • YETERLİLİK: R(T_b) > D olmalı. Üretim hızı talebi geçmiyorsa
 *     HİÇBİR depo boyutu kurtarmaz — depo yalnızca dalgalanmayı yutar,
 *     açığı kapatmaz.
 *   • BOYUT: anahtar TOPAKLAR hâlinde gelir (T_b'de bir, ℓ bit). Depo
 *     bir tam blok arasını taşımalı:  S_min ≈ D · T_b.
 *     Yani üretim bloğu uzadıkça (hız artar) DEPO DA BÜYÜMELİDİR —
 *     hız ile depo boyutu arasında doğrudan bir takas vardır.
 *   • GÜVENLİK: büyük depo = anahtarların uzun süre BEKLEMESİ. Depoda
 *     bekleyen anahtar, deposu ele geçiren birine toplu hâlde açılır.
 *     Bu yüzden depo boyutu yalnızca maliyetle değil, azami anahtar
 *     YAŞI politikasıyla da sınırlanmalıdır. Ortalama yaş ölçülür.
 *
 * ── ÇEKİRDEK YENİDEN KULLANIMI ──
 * Anahtar muhafazası için çekirdeğin ETSI GS QKD 014 uyumlu
 * `KeyDeliveryStore`'u kullanılır (key_ID üretimi + rota bazlı saklama).
 * O sınıfın YALNIZCA yatırma yolu var (üretim tarafı); tüketim/tahsis
 * politikası burada, ÜSTÜNE yazılır — çekirdek DEĞİŞTİRİLMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const { mulberry32, KeyDeliveryStore, QKDSecurityProof } = require("./photonnet_core.js");
const C = require("./qkd_session_controller.js");

// ══════════════════════════════════════════════════════════
// 1) ELASTİK PENCERE
// ══════════════════════════════════════════════════════════
/**
 * Sabit süre yerine ℓ hedefine göre kapatır.
 * @returns her bloğun kapanış anı + gecikmesi (dağılım için)
 */
function runElastic(pairs, opts = {}) {
  const {
    ellTarget = 128, leakPerBit = 0.02, tickMs = 5,
    maxWaitMs = 60000, seed = 0x51D3C0DE, sessionMs = null,
  } = opts;
  const sorted = [...pairs].sort((a, b) => a.t - b.t);
  if (!sorted.length) return { blocks: [], totals: { blocks: 0, ell: 0 } };
  const tEnd = sessionMs ?? sorted[sorted.length - 1].t;

  const blocks = [];
  let cursor = 0, idx = 0;
  while (cursor < tEnd) {
    let n = 0, sumEPh = 0, closed = null, i = idx;
    for (let T = tickMs; T <= maxWaitMs; T += tickMs) {
      const abs = cursor + T;
      if (abs > tEnd) break;
      while (i < sorted.length && sorted[i].t <= abs) { const s = sorted[i].state; sumEPh += s.Z + s.Y; n++; i++; }
      if (n < 32) continue;
      const ell = C.predictEll(n / 4, n / 4, sumEPh / n, leakPerBit);
      if (ell >= ellTarget) { closed = T; break; }
    }
    if (closed == null) break;
    const real = C.realiseBlock(
      sorted.slice(idx, i).map(p => ({ ...p, t: p.t - cursor })), closed,
      (seed + blocks.length * 7919) >>> 0);
    blocks.push({
      index: blocks.length, startMs: +cursor.toFixed(1), latencyMs: +closed.toFixed(1),
      endMs: +(cursor + closed).toFixed(1), pairs: real.pairs, ell: real.ell,
    });
    cursor += closed; idx = i;
  }
  const lat = blocks.map(b => b.latencyMs).sort((a, b) => a - b);
  const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  const ell = blocks.reduce((s, b) => s + b.ell, 0);
  const span = blocks.reduce((s, b) => s + b.latencyMs, 0);
  return {
    blocks, totals: {
      blocks: blocks.length, ell, spanMs: +span.toFixed(1),
      sustainedRateBps: span > 0 ? +(ell / (span / 1000)).toFixed(2) : 0,
      latencyP50: q(0.5), latencyP95: q(0.95),
      latencyMin: lat[0] ?? null, latencyMax: lat[lat.length - 1] ?? null,
      latencyJitter: lat.length ? +(q(0.95) - lat[0]).toFixed(1) : null,
    },
  };
}

// ══════════════════════════════════════════════════════════
// 2) ANAHTAR DEPOSU — tahsis politikası
// ══════════════════════════════════════════════════════════
/**
 * Çekirdeğin KeyDeliveryStore'u anahtarları key_ID ile saklar ama
 * TÜKETİM yolu yoktur (üretim tarafı sınıfıdır). Burada onun üstüne,
 * ETSI GS QKD 014 `enc_keys` çağrısının anlamını taşıyan bir tahsis
 * katmanı yazılır: istenen bit miktarı depodan karşılanır ya da
 * karşılanamaz — uydurma anahtar ASLA üretilmez.
 */
class KeyAllocator {
  constructor(routeKey = "A-B", opts = {}) {
    const { capacityBits = Infinity, idSeed = 0x0B0BB1E5, pruneHistory = true } = opts;
    this.store = new KeyDeliveryStore();
    this.routeKey = routeKey;
    this.capacityBits = capacityBits;
    this.idRng = mulberry32(idSeed >>> 0);
    this.levelBits = 0;
    this.depositedBits = 0; this.discardedBits = 0;
    this.servedBits = 0; this.deniedBits = 0;
    this.servedCount = 0; this.deniedCount = 0;
    this.ageSum = 0; this.ageSamples = 0; this.maxAgeMs = 0;
    this.fifo = [];                       // {bits, tMs} — yaş takibi için
    // DURUM SIZINTISI DÜZELTMESİ (state_poisoning_drill.js buldu).
    // Çekirdeğin KeyDeliveryStore.byRoute dizisi HER mevduatta bir kayıt
    // ekler ama tüketilen kaydı ASLA silmez: levelBits ve fifo sıfıra
    // dönse bile (sağlık göstergesi düz görünür) geçmiş kaydı sınırsız
    // büyür, heap doğrusal tırmanır. Sürekli çalışan sistemde bu, tarif
    // edilen "kümülatif şişme → kilitlenme"nin ta kendisidir.
    //
    // Çözüm ÇEKİRDEĞE dokunmaz: allocator kendi FIFO'su ile çekirdek
    // deposunun byRoute dizisini AYNI sırada tutar (ikisi de mevduat başına
    // bir öğe). Bir FIFO parçası tümüyle tüketilince ona karşılık gelen en
    // eski depo kaydı da baştan atılır → byRoute canlı envanteri yansıtır
    // (kapasiteyle sınırlı), denetim SAYACI (totalDelivered) monoton kalır.
    this.pruneHistory = pruneHistory;
    this.historyHighWater = 0;
  }
  _liveHistory() {
    const arr = this.store.byRoute[this.routeKey];
    return arr ? arr.length : 0;
  }
  /** Üretim bloğu deposu besler. Kapasite aşılırsa FAZLASI ATILIR (ve sayılır). */
  deposit(bits, tMs, blockIndex) {
    if (bits <= 0) return { stored: 0, discarded: 0 };
    const room = this.capacityBits - this.levelBits;
    const stored = Math.max(0, Math.min(bits, room));
    const discarded = bits - stored;
    if (stored > 0) {
      // Çekirdeğin muhafazası: key_ID üretimi + rota bazlı kayıt.
      // (Bit DEĞERLERİ bu ölçekli benzetimde taşınmaz; envanter
      //  muhasebesi bit SAYISI üzerinden yürür. Gerçek konuşlandırmada
      //  register() nihai anahtar bitleriyle çağrılır — imza aynı.)
      this.store.register(this.routeKey, new Array(Math.min(stored, 64)).fill(0), blockIndex, this.idRng);
      this.fifo.push({ bits: stored, tMs });
      this.levelBits += stored;
      this.depositedBits += stored;
      const live = this._liveHistory();
      if (live > this.historyHighWater) this.historyHighWater = live;
    }
    this.discardedBits += discarded;
    return { stored, discarded };
  }
  /** ETSI-014 `enc_keys` anlamı: ya tamamı karşılanır ya da hata döner. */
  request(bits, tMs) {
    if (bits <= 0) return { ok: true, bits: 0, latencyMs: 0 };
    if (this.levelBits < bits) {
      this.deniedBits += bits; this.deniedCount++;
      return { ok: false, error: "key_unavailable", requested: bits, available: this.levelBits, latencyMs: null };
    }
    const histArr = this.pruneHistory ? this.store.byRoute[this.routeKey] : null;
    let need = bits;
    while (need > 0 && this.fifo.length) {
      const head = this.fifo[0];
      const take = Math.min(need, head.bits);
      const age = tMs - head.tMs;
      this.ageSum += age * take; this.ageSamples += take;
      if (age > this.maxAgeMs) this.maxAgeMs = age;
      head.bits -= take; need -= take;
      if (head.bits === 0) {
        this.fifo.shift();
        // Tüketilen mevduata karşılık gelen en eski depo kaydını at.
        // FIFO ile byRoute aynı sırada büyüdüğü için baştan atmak doğru
        // kaydı hedefler ve O(1) amortize maliyetlidir.
        if (histArr && histArr.length) histArr.shift();
      }
    }
    this.levelBits -= bits;
    this.servedBits += bits; this.servedCount++;
    return { ok: true, bits, latencyMs: 0, storedKeys: this._liveHistory() };
  }
  stats() {
    return {
      depositedBits: this.depositedBits, discardedBits: this.discardedBits,
      servedBits: this.servedBits, deniedBits: this.deniedBits,
      servedCount: this.servedCount, deniedCount: this.deniedCount,
      denialRate: (this.servedCount + this.deniedCount)
        ? +(this.deniedCount / (this.servedCount + this.deniedCount)).toFixed(5) : 0,
      finalLevelBits: this.levelBits,
      meanKeyAgeMs: this.ageSamples ? +(this.ageSum / this.ageSamples).toFixed(1) : null,
      maxKeyAgeMs: +this.maxAgeMs.toFixed(1),
      keyIdsIssued: this.store.totalDelivered,   // monoton denetim SAYACI (bellek değil)
      liveHistoryEntries: this._liveHistory(),   // canlı kayıt (kapasiteyle sınırlı)
      historyHighWaterEntries: this.historyHighWater,
      historyPruned: this.pruneHistory,
    };
  }
}

// ══════════════════════════════════════════════════════════
// 3) İKİ KATMANLI TEDARİK (üretim yüksek SLA + depodan servis)
// ══════════════════════════════════════════════════════════
/**
 * Üretim blokları depoyu besler; tüketici istekleri depodan servis
 * edilir. Talep süreci tohumlanmış üstel varışlarla modellenir.
 */
function runTieredSupply(blocks, opts = {}) {
  const {
    sessionMs, demandBps, requestBits = 256, capacityBits = Infinity,
    seed = 0xD33D4A1D, warmupMs = 0,
  } = opts;
  const rng = mulberry32(seed >>> 0);
  const lambda = demandBps / requestBits;              // istek/saniye
  const alloc = new KeyAllocator("A-B", { capacityBits });

  // Olay birleştirme: mevduatlar (blok sonu) + talepler (üstel varış)
  const deposits = blocks.map(b => ({ t: b.endMs, kind: "dep", bits: b.ell, i: b.index }));
  const demands = [];
  let t = 0;
  while (true) {
    t += -Math.log(1 - rng()) / lambda * 1000;         // üstel arası süre (ms)
    if (t > sessionMs) break;
    demands.push({ t, kind: "req", bits: requestBits });
  }
  const events = deposits.concat(demands).sort((a, b) => a.t - b.t);

  const levelTrace = [];
  let denialsAfterWarmup = 0, requestsAfterWarmup = 0;
  for (const ev of events) {
    if (ev.kind === "dep") alloc.deposit(ev.bits, ev.t, ev.i);
    else {
      const r = alloc.request(ev.bits, ev.t);
      if (ev.t >= warmupMs) { requestsAfterWarmup++; if (!r.ok) denialsAfterWarmup++; }
    }
    if (levelTrace.length < 4000) levelTrace.push({ tMs: +ev.t.toFixed(1), levelBits: alloc.levelBits });
  }
  const s = alloc.stats();
  return {
    ...s, demandBps, requestBits, lambdaPerSec: +lambda.toFixed(3),
    capacityBits: capacityBits === Infinity ? null : capacityBits,
    requestsAfterWarmup, denialsAfterWarmup,
    steadyDenialRate: requestsAfterWarmup ? +(denialsAfterWarmup / requestsAfterWarmup).toFixed(5) : 0,
    peakLevelBits: Math.max(0, ...levelTrace.map(x => x.levelBits)),
    levelTrace,
  };
}

/**
 * TÜRETİLMİŞ DEPO BOYUTU.
 *
 * Anahtar T_b'de bir topak hâlinde gelir; talep sürekli akar. Depo, iki
 * mevduat arasındaki çekilişi karşılayabilmelidir. ORTALAMA çekiliş
 * D·T_b'dir — ama talep POISSON olduğu için asıl bağlayıcı olan
 * ortalama değil KUYRUKTUR. Blok arasındaki istek sayısı Poisson(λ·T_b)
 * olduğundan çekilişin standart sapması:
 *      σ = requestBits · √(λ·T_b),      λ = D / requestBits
 * Sıfır açlık için depo, ortalama çekilişi + kuyruk payını taşımalıdır:
 *      S_min = D·T_b + z·requestBits·√(λ·T_b)          (z ≈ 3)
 *
 * İLK KURGUDA bu terim YOKTU (yalnızca 1,5·D·T_b sabit çarpanı vardı) ve
 * ölçüm formülü YALANLADI: 1,5·D·T_b hâlâ %1,19 ret veriyordu. Sabit
 * çarpan, dalgalanmanın √T_b ile ölçeklendiğini yakalayamaz — bu yüzden
 * çarpanı büyütmek yerine kuyruk terimi TÜRETİLDİ.
 */
function requiredStoreBits(demandBps, blockMs, requestBits = 256, z = 3) {
  const T = blockMs / 1000;
  const lambda = demandBps / requestBits;
  return Math.ceil(demandBps * T + z * requestBits * Math.sqrt(lambda * T));
}

/**
 * TAHLİYE TAVANI PROVİZYONU (safety_margin_drill.js — "bant genişliği
 * illüzyonu" eleştirisinin düzeltmesi).
 *
 * Termal geri-basınç, soğuk-belleğe yazma hızını soğutucu gücüne kenetler:
 *      R_pipe = P_cold / E_op        (tek soğuk-pipeline tavanı, bit/s)
 * BU BİR SİSTEM DUVARI DEĞİLDİR. Gerçek tekrarlayıcı düğümleri tek-modlu
 * değildir: frekans/zaman/uzamsal M paralel mod (motorun 'multiplexing'
 * parametresi) her biri kendi soğutma bütçesiyle çalışır. Toplam tavan:
 *      R_evac(M) = M · P_cold / E_op
 * Yani "50 Gbit/s" sabit bir kelepçe değil, PROVİZYON parametresidir:
 * hedef anahtar hızına göre M pipeline boyutlandırılır. Bu fonksiyon,
 * bir hedef bit/s için gereken M'i ve toplam kapasiteyi döndürür.
 *
 * @param {number} targetBps  karşılanmak istenen soğuk-yazma hızı (bit/s)
 * @param {object} opts  { pColdW: soğutucu gücü/pipeline (W),
 *                          eOpJ: işlem başına dağılım (J) }
 * @returns {{perPipeBps, pipelines, capacityBps, utilisation}}
 */
function provisionForRate(targetBps, opts = {}) {
  const { pColdW = 1.0, eOpJ = 20e-12 } = opts;
  const perPipeBps = pColdW / eOpJ;
  const pipelines = targetBps > 0 ? Math.ceil(targetBps / perPipeBps) : 0;
  const capacityBps = pipelines * perPipeBps;
  return { perPipeBps, pipelines, capacityBps,
    utilisation: capacityBps > 0 ? +(targetBps / capacityBps).toFixed(4) : 0 };
}

module.exports = { runElastic, KeyAllocator, runTieredSupply, requiredStoreBits, provisionForRate };
