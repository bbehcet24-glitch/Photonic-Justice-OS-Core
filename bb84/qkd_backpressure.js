#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * ÜRETİM BACKPRESSURE / THROTTLING — depo doluluğuna göre
 * ═══════════════════════════════════════════════════════════════════
 * Depo, uygulama katmanını fiziksel hattın blok uzatma zorunluluğundan
 * yalıtıyor. Ama yalıtım TEK YÖNLÜ kaldığı sürece israf var: sabit
 * bloklu üretimde, talep üretimin yarısı olduğunda üretilen anahtarın
 * %49'u depoya sığmayıp ATILIYOR (ölçüldü). Atılan her bit, karşılığında
 * gerçekten harcanmış foton/bellek/dedektör demektir.
 *
 * Bu modül geri-basıncı kurar: depo doluluğu üretimi geri besler.
 *
 * ── ÜÇ BÖLGE ──
 * φ = doluluk oranı (level/capacity)
 *
 *   φ < φ_high    ÜRETİM    Blok, izin verilen EN UZUN hâline çıkar —
 *                 yani hız maksimize edilir.
 *   φ ≥ φ_high    KISMA     Depo doluyor. Daha fazla üretmek saf israf;
 *                 kaynak boşa harcanmasın diye üretim DURDURULUR ve
 *                 depo talep tarafından φ_high'a inene kadar beklenir.
 *
 * ── ÖLÇÜMÜN ÇÜRÜTTÜĞÜ İLK TASARIM ──
 * İlk kurguda üçüncü bir bölge vardı: "φ düşükken bloğu KISALT, çünkü
 * asıl önemli olan bir sonraki mevduata kalan süredir". Bu sezgi
 * YANLIŞ çıktı ve ölçüm onu açıkça öldürdü: kısa blok hızı düşürür
 * (463 ms blokta hız, 5.000 ms bloğun dörtte biri), depo daha da
 * boşalır, denetleyici daha da kısaltır — ÖLÜM SARMALI. Ölçülen sonuç:
 * denetleyici kalıcı olarak o modda kilitlendi ve ret oranı %0'dan
 * %61'e ÇIKTI, yani tabandan kötü çalıştı.
 * Doğrusu şu: dL/dt = R(T_b) − D olduğundan ve R(T_b) T_b ile monoton
 * arttığından, depo boşken de yapılacak şey HIZI ARTIRMAKTIR. Bloğu
 * kısaltmanın tek meşru gerekçesi TAŞMAYI önlemektir (boş alan kısıtı),
 * açlığı önlemek değil.
 *
 * ── KRİTİK BAĞ: BOŞ ALAN, BLOK UZUNLUĞUNU SINIRLAR ──
 * Bir blok ℓ(T_b) bit üretir. Depoda ℓ(T_b) kadar yer yoksa fazlası
 * ATILIR. Dolayısıyla kullanılabilir azami blok:
 *      T_headroom = ℓ⁻¹(kapasite − seviye)
 * Bu, iki katmanı birbirine bağlayan asıl kısıttır ve türetilir
 * (ℓ modeli üzerinde ikili arama) — sabit bir tavan konmaz.
 *
 * ── HİSTEREZİS ŞART ──
 * Tek eşikli bir denetleyici eşiğin etrafında GİDİP GELİR (chatter):
 * her mevduat φ'yi eşiğin üstüne, her talep altına iter. Mod değişimi
 * bant genişliği kadar gecikmelidir. Test bunu histerezissiz hâliyle
 * ÖLÇEREK gösterir.
 *
 * ── DÜRÜSTLÜK SINIRI ──
 * Geri-basınç israfı önler, KAPASİTE YARATMAZ. Talep azami üretimi
 * aşarsa hiçbir politika kurtarmaz (R > D koşulu değişmez).
 * ═══════════════════════════════════════════════════════════════════
 */
const { mulberry32 } = require("./photonnet_core.js");
const C = require("./qkd_session_controller.js");
const K = require("./qkd_key_supply.js");

// ══════════════════════════════════════════════════════════
// 1) ℓ MODELİ VE TERSİ
// ══════════════════════════════════════════════════════════
/** Blok süresinden öngörülen ℓ (kontrolcünün kullandığı öngörücü). */
function makeEllModel(pairsPerSec, ePh, leakPerBit) {
  return (blockMs) => {
    const n = pairsPerSec * (blockMs / 1000);
    return C.predictEll(n / 4, n / 4, ePh, leakPerBit);
  };
}
/** ℓ⁻¹: hedef bit sayısını üreten en kısa blok (ikili arama). */
function blockForEll(ellModel, targetBits, opts = {}) {
  const { loMs = 10, hiMs = 600000 } = opts;
  if (ellModel(hiMs) < targetBits) return null;
  let lo = loMs, hi = hiMs;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (ellModel(mid) >= targetBits) hi = mid; else lo = mid; }
  return hi;
}
/** ℓ(T) ≤ boşAlan olacak EN UZUN blok. */
function blockForHeadroom(ellModel, headroomBits, opts = {}) {
  const { loMs = 10, hiMs = 600000 } = opts;
  if (ellModel(loMs) > headroomBits) return 0;          // en kısa blok bile taşırır
  if (ellModel(hiMs) <= headroomBits) return hiMs;
  let lo = loMs, hi = hiMs;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (ellModel(mid) <= headroomBits) lo = mid; else hi = mid; }
  return lo;
}

// ══════════════════════════════════════════════════════════
// 2) THROTTLE
// ══════════════════════════════════════════════════════════
class ProductionThrottle {
  constructor(opts = {}) {
    const {
      capacityBits, demandBps, ellModel,
      highFill = RECOMMENDED_PHI_HIGH, hysteresis = HYSTERESIS_BAND,
      maxBlockMs = 10000, minEll = 128, useHysteresis = true, headroomMargin = 0.90,
    } = opts;
    Object.assign(this, { capacityBits, demandBps, ellModel, highFill, hysteresis, maxBlockMs, minEll, useHysteresis, headroomMargin });
    // İKİ EŞİK, TEK BANT. Kullanıcı arayüzünde tek sayı (φ_high) var ama
    // denetleyici iki eşikle çalışır — histerezis tam olarak budur:
    //     φ_up  = φ_high + h   → bu seviyenin ÜSTÜNDE üretim DURUR
    //     φ_low = φ_high − h   → bu seviyenin ALTINDA üretim GERİ BAŞLAR
    // Arada kalan bantta mevcut mod KORUNUR; kararsızlık buradan çıkar.
    const h = useHysteresis ? hysteresis : 0;
    this.phiUp = Math.min(0.999, highFill + h);
    this.phiLow = Math.max(0.001, highFill - h);
    // En kısa ÜRETKEN blok TÜRETİLİR: sonlu-anahtar uçurumunun altında
    // blok sıfır bit verir, yani "kısalt" emri körü körüne uygulanamaz.
    this.minBlockMs = blockForEll(ellModel, minEll) ?? maxBlockMs;
    this.mode = "ÜRETİM";
    this.modeSwitches = 0;
  }
  _region(fill) {
    // Banttayken (φ_low < fill < φ_up) MEVCUT mod korunur.
    if (this.mode === "KISMA") return fill <= this.phiLow ? "ÜRETİM" : "KISMA";
    return fill >= this.phiUp ? "KISMA" : "ÜRETİM";
  }
  /** @returns {{mode, blockMs, idleMs, headroomBits, fill}} */
  next(levelBits) {
    const cap = this.capacityBits;
    const fill = cap > 0 ? levelBits / cap : 0;
    const next = this._region(fill);
    if (next !== this.mode) { this.modeSwitches++; this.mode = next; }
    const headroom = Math.max(0, cap - levelBits);
    // ÖNGÖRÜCÜ HATASI PAYI: boş alan kısıtı ℓ̂ ÜZERİNDEN kurulur ama
    // gerçekleşen ℓ ondan birkaç yüzde sapabilir. Marjsız kurgulamada
    // ölçüm 150 bitlik artık taşma gösterdi; boş alanın %90'ı hedeflenir.
    const tHead = blockForHeadroom(this.ellModel, headroom * this.headroomMargin);

    if (this.mode === "KISMA") {
      // Depo φ_high'a inene kadar üretimi durdur (kaynak harcanmaz).
      const target = this.highFill * cap;
      const idleMs = this.demandBps > 0 ? Math.max(0, (levelBits - target) / this.demandBps * 1000) : 0;
      return { mode: this.mode, blockMs: 0, idleMs, headroomBits: headroom, fill: +fill.toFixed(4) };
    }
    // Hız her zaman maksimize edilir; bloğu kısaltmanın TEK gerekçesi
    // boş alan kısıtıdır (taşma = üretilmiş anahtarın çöpe gitmesi).
    let blockMs = Math.min(this.maxBlockMs, tHead);
    // AÇLIK KORUMASI — yalnızca ÜCRETSİZ olduğunda. Depodaki seviye en
    // az bir üretken blok süresi kadar talebi karşılayabiliyorsa, blok
    // o süreyle sınırlanır ki mevduat depo boşalmadan gelsin. Seviye
    // bunu karşılamıyorsa kısaltmak İŞE YARAMAZ (hızı düşürür, açığı
    // büyütür) — o durumda tam uzunlukta üretip en hızlı toparlanma
    // seçilir.
    if (this.demandBps > 0) {
      const coverMs = (levelBits / this.demandBps) * 1000;
      if (coverMs >= this.minBlockMs) blockMs = Math.min(blockMs, Math.max(this.minBlockMs, coverMs));
    }
    // Boş alan en kısa üretken bloğu bile almıyorsa üretme, bekle.
    if (tHead < this.minBlockMs) {
      const target = this.highFill * cap;
      const idleMs = this.demandBps > 0 ? Math.max(25, (levelBits - target) / this.demandBps * 1000) : 25;
      return { mode: this.mode, blockMs: 0, idleMs, headroomBits: headroom, fill: +fill.toFixed(4) };
    }
    return { mode: this.mode, blockMs: Math.max(0, blockMs), idleMs: 0, headroomBits: headroom, fill: +fill.toFixed(4) };
  }
}

// ══════════════════════════════════════════════════════════
// 3) KAPALI ÇEVRİM KOŞUM
// ══════════════════════════════════════════════════════════
/**
 * Üretici + depo + tüketici, geri-basınçlı ya da sabit bloklu.
 * Talep, zamana göre DEĞİŞEBİLİR (demandAt fonksiyonu) — böylece
 * ani talep sıçraması karşısındaki davranış ölçülebilir.
 */
function runControlled(pairs, opts = {}) {
  const {
    sessionMs, capacityBits, demandAt, requestBits = 128,
    ellModel, throttle = null, fixedBlockMs = 5000,
    seed = 0xB4C4B4C4, leakPerBit = 0.02, warmupMs = 0,
  } = opts;
  const sorted = [...pairs].sort((a, b) => a.t - b.t);
  const alloc = new K.KeyAllocator("A-B", { capacityBits });
  const rng = mulberry32(seed >>> 0);

  // Talep varışları (zamanla değişen hız için ince adımlı üretim)
  const demands = [];
  {
    let t = 0;
    while (t < sessionMs) {
      const d = Math.max(1, demandAt(t));
      const lam = d / requestBits;
      t += -Math.log(1 - rng()) / lam * 1000;
      if (t < sessionMs) demands.push(t);
    }
  }
  let di = 0;
  let requests = 0, denials = 0, pairsSkipped = 0, servedAfterWarmup = 0;
  const skipReason = { KISMA: 0, bosAlanYok: 0 };
  const serveUntil = (T) => {
    while (di < demands.length && demands[di] <= T) {
      const r = alloc.request(requestBits, demands[di]);
      if (demands[di] >= warmupMs) { requests++; if (r.ok) servedAfterWarmup += requestBits; else denials++; }
      di++;
    }
  };

  const lo = (t) => { let a = 0, b = sorted.length; while (a < b) { const m = (a + b) >> 1; if (sorted[m].t > t) b = m; else a = m + 1; } return a; };
  const blocks = [], trace = [];
  let cursor = 0, guard = 0;
  while (cursor < sessionMs && guard++ < 20000) {
    const dec = throttle ? throttle.next(alloc.levelBits)
      : { mode: "SABİT", blockMs: fixedBlockMs, idleMs: 0, headroomBits: capacityBits - alloc.levelBits, fill: alloc.levelBits / capacityBits };
    if (dec.idleMs > 0) {
      const end = Math.min(sessionMs, cursor + dec.idleMs);
      skipReason[dec.mode === "KISMA" ? "KISMA" : "bosAlanYok"] += lo(end) - lo(cursor);
      // Üretim durduğu için o penceredeki çiftler HİÇ ÜRETİLMEZ.
      pairsSkipped += lo(end) - lo(cursor);
      serveUntil(end);
      trace.push({ tMs: +cursor.toFixed(1), mode: dec.mode, fill: dec.fill, blockMs: 0, ell: 0, idleMs: +dec.idleMs.toFixed(1) });
      cursor = end;
      continue;
    }
    if (!(dec.blockMs > 0)) {           // boş alan yok, kısa bir bekleme
      const end = Math.min(sessionMs, cursor + 50);
      skipReason.bosAlanYok += lo(end) - lo(cursor);
      pairsSkipped += lo(end) - lo(cursor);
      serveUntil(end);
      cursor = end;
      continue;
    }
    const end = Math.min(sessionMs, cursor + dec.blockMs);
    const a = lo(cursor), b = lo(end);
    const slice = new Array(Math.max(0, b - a));
    for (let i = a; i < b; i++) slice[i - a] = { ...sorted[i], t: sorted[i].t - cursor };
    let ell = 0;
    if (slice.length > 32) {
      const real = C.realiseBlock(slice, end - cursor, (seed + blocks.length * 7919) >>> 0);
      ell = real.ell;
    }
    serveUntil(end);
    const dep = alloc.deposit(ell, end, blocks.length);
    blocks.push({ index: blocks.length, startMs: +cursor.toFixed(1), endMs: +end.toFixed(1),
      blockMs: +(end - cursor).toFixed(1), mode: dec.mode, ell, stored: dep.stored, discarded: dep.discarded,
      fillBefore: dec.fill });
    if (trace.length < 6000) trace.push({ tMs: +end.toFixed(1), mode: dec.mode, fill: dec.fill, blockMs: +(end - cursor).toFixed(1), ell, idleMs: 0 });
    cursor = end;
  }
  serveUntil(sessionMs);

  const s = alloc.stats();
  const produced = blocks.reduce((t, b) => t + b.ell, 0);
  const pairsUsed = sorted.length - pairsSkipped;
  return {
    blocks: blocks.length, trace,
    modeSwitches: throttle ? throttle.modeSwitches : 0,
    minBlockMs: throttle ? +throttle.minBlockMs.toFixed(1) : fixedBlockMs,
    producedBits: produced, storedBits: s.depositedBits, discardedBits: s.discardedBits,
    discardedPct: produced > 0 ? +(100 * s.discardedBits / produced).toFixed(2) : 0,
    servedBits: s.servedBits, servedAfterWarmup, requests, denials, skipReason,
    denialRate: requests ? +(denials / requests).toFixed(5) : 0,
    pairsTotal: sorted.length, pairsUsed, pairsSkipped,
    pairsSkippedPct: +(100 * pairsSkipped / sorted.length).toFixed(2),
    meanKeyAgeMs: s.meanKeyAgeMs, maxKeyAgeMs: s.maxKeyAgeMs,
    finalLevelBits: s.finalLevelBits,
    blockMsRange: blocks.length ? [Math.min(...blocks.map(b => b.blockMs)), Math.max(...blocks.map(b => b.blockMs))] : null,
    modeHistogram: blocks.reduce((a, b) => (a[b.mode] = (a[b.mode] || 0) + 1, a), {}),
  };
}


// ══════════════════════════════════════════════════════════
// 4) ÖNERİLEN φ_high — ölçüt AÇIK, kısıt TÜRETİLMİŞ
// ══════════════════════════════════════════════════════════
/**
 * ÖNERİLEN ÜRETİM AYARI: φ_high = 0,80  (varsayılan/"dengeli" profil)
 *
 * ── ÖNCE REDDEDİLEN ÖLÇÜT ──
 * İlk yaklaşım "her çalışma noktasında sıçrama reddini tabanın 1 puan
 * içinde tutan en tasarruflu φ" idi. ÖLÇÜM BUNU ÇÜRÜTTÜ: 9 noktalık
 * ızgarada (talep/üretim 0,3–0,7 × depo 1–3 × S_min) diz noktası
 * 0,60 ile 0,95 arasında dolaştı ve ölçüt bıçak sırtı çıktı — 0,8
 * puanlık bir fark uygunluğu ters çevirip seçimi φ=0,85'e (tasarruf
 * %0) kaydırabiliyordu. NOKTA BAZINDA DİZ YOKTUR.
 *
 * ── KABUL EDİLEN ÖLÇÜT: DEĞİŞİM ORANININ ÇÖKÜŞÜ ──
 * Izgara ORTALAMASINDA takas neredeyse doğrusaldır, ama bir yerde
 * kırılır. φ'yi artırmak, birim tasarruf başına ne kadar sıçrama reddi
 * satın alıyor:
 *      0,50→0,60 : 1 puan tasarruf → 1,31 puan ret azalması
 *      0,60→0,70 : 1 → 0,76
 *      0,70→0,80 : 1 → 0,31
 *      0,80→0,85 : 1 → 0,01      ← ÇÖKÜŞ
 *      0,85→0,95 : 1 → 0,07
 * φ = 0,80, φ'yi artırmanın hâlâ ANLAMLI dayanıklılık satın aldığı SON
 * noktadır. Ötesinde 17,4 puan tasarruf verip 0,6 puan ret alınıyor.
 *
 * ── BU BİR KEŞİF DEĞİL, DURUŞ ──
 * Dürüstçe: 0,80 "ölçümden çıkan tek doğru" değildir; "verimliliği,
 * dayanıklılık satın almayı bıraktığı ana kadar tercih et" duruşunun
 * sayısal karşılığıdır. Farklı duruşlar farklı sayı verir ve üçü de
 * ölçüldü (9 noktalık ızgara ortalamaları):
 *
 *   profil            φ_high   kaynak tasarrufu   sıçramada ret
 *   verimlilik-önce    0,50         %43,0              %30,3
 *   DENGELİ (varsayılan) 0,80       %27,3              %19,0
 *   dayanıklılık-önce  0,90          %9,9              %18,4
 *
 * ── SERT KISIT: BANT KURALI (öneriden ÖNCE gelir) ──
 * Üst bant en az bir bloğu almazsa her mevduat eşiği aşar ve
 * denetleyici sürekli kısar:
 *        φ_high ≤ 1 − ℓ(T_b)/S − pay
 * Sağlanamıyorsa φ_high'ı oynatmak ÇÖZMEZ — blok kısaltılmalı ya da
 * depo büyütülmelidir; fonksiyon gereken iki sayıyı da döndürür.
 *
 * ── GEÇERLİLİK ZARFI ──
 * Talep/üretim 0,3–0,7 ve depo 1–3 × S_min. Dışında yeniden ölçün:
 * bb84/phi_high_tuning_test.js ızgarayı olduğu gibi yeniden koşturur.
 */
const PHI_PROFILES = {
  "verimlilik-önce": 0.50,
  "dengeli": 0.80,
  "dayanıklılık-önce": 0.90,
};
const RECOMMENDED_PHI_HIGH = 0.80;
/**
 * HİSTEREZİS BANDI: h = 0,08  (φ_low = 0,72 · φ_up = 0,88)
 *
 * Tek eşikli bir denetleyici eşiğin etrafında GİDİP GELİR: her mevduat
 * doluluğu eşiğin üstüne, her talep altına iter. Bant, mod değişimini
 * geciktirerek bunu keser.
 *
 * BANT GENİŞLİĞİ DE ÖLÇÜLDÜ (bkz. hysteresis_band_test.js). İki yönlü
 * bir maliyeti var ve ikisi de gerçek:
 *   h çok küçük → chatter; her blok bir mod değişimi doğurur.
 *   h çok büyük → denetleyici geç tepki verir: üstte φ_up'a kadar
 *                 üretmeye devam edip TAŞIRIR, altta φ_low'a kadar
 *                 beklediği için depo gereğinden çok boşalır.
 * Seçim ölçütü: anahtarlamayı taban seviyesine indiren EN DAR bant.
 */
const HYSTERESIS_BAND = 0.08;
const EXCHANGE_COLLAPSE_RATIO = 0.1;   // 1 puan tasarruf başına <0,1 puan ret azalması = çöküş

function recommendPhiHigh(opts = {}) {
  const {
    capacityBits, blockMs, ellModel,
    knee = RECOMMENDED_PHI_HIGH, bandMargin = 0.05, minPhi = 0.5,
  } = opts;
  const ell = ellModel(blockMs);
  const bandCap = 1 - ell / capacityBits - bandMargin;
  const base = {
    recommended: knee, bandCap: +bandCap.toFixed(4),
    ellPerBlockBits: Math.round(ell), capacityBits,
    criterion: "ızgara ortalamasında değişim oranının çöktüğü son φ (1 puan tasarruf → <0,1 puan ret azalması)",
  };
  if (bandCap < minPhi) {
    // φ_high'ı düşürmek çözmez — üretim ya da depo değişmelidir.
    return {
      ...base, phiHigh: null, feasible: false,
      reason: "bant kuralı sağlanamıyor: tek blok, üst banda hiçbir φ_high için sığmıyor",
      requiredCapacityBits: Math.ceil(ell / (1 - knee - bandMargin)),
      maxBlockMsForCapacity: Math.round(blockForHeadroom(ellModel, capacityBits * (1 - knee - bandMargin))),
    };
  }
  const phi = Math.min(knee, bandCap);
  return {
    ...base, phiHigh: +phi.toFixed(4), feasible: true,
    boundBy: phi < knee - 1e-9 ? "bant kuralı" : "önerilen diz noktası",
  };
}

module.exports = {
  makeEllModel, blockForEll, blockForHeadroom, ProductionThrottle, runControlled,
  recommendPhiHigh, RECOMMENDED_PHI_HIGH, PHI_PROFILES, EXCHANGE_COLLAPSE_RATIO, HYSTERESIS_BAND,
};
