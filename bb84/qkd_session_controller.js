#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * QKD OTURUM KONTROLCÜSÜ — blok kapanışı, kabul eşiği, Bell monitörü
 * ═══════════════════════════════════════════════════════════════════
 *
 * ÖNCE BİR DÜZELTME (ölçümle):
 * R_key(T) eğrisinin T ≈ 850 ms'deki zirvesi bir DOYUM NOKTASI DEĞİL,
 * deneme bütçesinin (20.000/segment) tükendiği andır. Bütçe 5× yapılınca
 * zirve 839 → 3.673 ms'ye kayıyor ve 616 → 1.236 bit/s'e ÇIKIYOR.
 * Dolayısıyla "oturumu 850 ms'de kes" diye SABİT bir timeout, sistemi
 * ulaşabileceği hızın yarısına kilitler. Sezgi doğru, sabit sayı yanlış:
 * kesim noktası ÇEVRİMİÇİ TÜRETİLMELİDİR.
 *
 * ── 1) KAPANIŞ KURALI (türetilmiş, sabit sayı yok) ──
 * Amaç R_key = ℓ(T)/T'yi maksimize etmek. Tepe koşulu:
 *       d(ℓ/T)/dT = 0  ⟺  ℓ'(T)·T − ℓ(T) = 0  ⟺  ℓ'(T) = ℓ(T)/T
 * Yani: MARJİNAL anahtar hızı, ORTALAMA anahtar hızının altına
 * düştüğü anda kapat. Bu kuralın iki güzel özelliği var:
 *   • Arz sınırlıysa (bütçe tükeniyorsa) zirveyi KENDİ BULUR — hangi
 *     bütçeyle çalışıldığını bilmesine gerek yok.
 *   • Sürekli beslenen bir bağlantıda ℓ'(T) ortalamanın ÜSTÜNDE
 *     kaldığı için HİÇ TETİKLENMEZ; orada kapanışı gecikme bütçesi
 *     (SLA) belirler. Sabit timeout'un yapamayacağı şey budur.
 *
 * ── 2) KABUL EŞİĞİ (sadakat-farkında yönlendirme) ──
 * Havuza faz hatası e_b olan bir yol eklemek ℓ'yi ne zaman ARTIRIR?
 * g(e) ≡ 1 − h₂(e) olsun; n çiftlik, ortalama hatası ē olan havuza
 * m çift eklerken (m→0):
 *   d/dm [ (n+m)·g((n·ē + m·e_b)/(n+m)) ] = g(ē) + g'(ē)·(e_b − ē)
 * Pozitif olması koşulu (h₂ içbükey, g' = −log₂((1−e)/e)):
 *       e_b  <  e* = ē + (1 − h₂(ē)) / log₂((1−ē)/ē)
 * Bu ASİMPTOTİK (μ→0) eşiktir; sonlu n'de μ ∼ 1/√n çift eklemekle
 * KÜÇÜLDÜĞÜ için kabul her zaman daha da caziptir. Yani e* bir ALT
 * sınırdır: e_b < e* ise kabul KESİNLİKLE doğrudur.
 * En iyi yolumuzun ē = 0,0335'i için e* = 0,196 — yani faz hatası
 * %19,6'ya kadar olan yollar bile havuza GİRMELİDİR. Bu, "en kötü yolu
 * at" sezgisinin neden yanlış çıktığını AÇIKLAR: en kötü yolumuzun
 * hatası 0,0686, eşiğin 2,86 katı ALTINDA.
 *
 * ── 3) HİBRİT BELL MONİTÖRÜ ──
 * E91 ANAHTAR protokolü olarak pahalıdır (eşleşen yön oranı 1/9), ama
 * DOĞRULAMA monitörü olarak ucuzdur. Üç tasarım kararı ölçümle çıktı:
 *   (i)   ADANMIŞ CHSH PROBU, tam E91 ızgarası değil. Monitör turunda
 *         taraflar zaten "bu bir test turu" bilgisini paylaştığı için
 *         ayarları doğrudan 4 CHSH ikilisinden seçerler; her saptırılan
 *         çift 1 tur üretir. Tam E91 ızgarasında bu oran 4/9'dur.
 *         Ölçüldü: 312 çift / %5,51 hız kaybı  vs  699 çift / %14,40.
 *   (ii)  SAPTIRMA YAYILMIŞ olmalı. Baştan blok halinde saptırmak
 *         yalnızca oturumun başını sertifikalar (Eve testte uslu durup
 *         sonra saldırabilir) ve anahtar bloğunu geciktirir.
 *   (iii) MONİTÖR UYARLANIR olmalı — aşağıya bakınız.
 * Maliyetin saptırılan çift oranından BÜYÜK çıkması beklenen bir
 * şeydir (ℓ, n'de süper-doğrusal); test dosyası bunu gevşetilmiş bir
 * eşikle değil, ℓ formülünden ÖNGÖRÜP ölçerek doğrular (×1,71).
 *
 * YENİDEN KULLANIM: photonnet_core (QKDSecurityProof, Cascade),
 * qkd_over_entanglement (measureBBM92, correlation, chshRoundsForSignificance),
 * parallel_routing_qkd_rate_test (bbm92BasisResolved, e91BasisResolved).
 * ═══════════════════════════════════════════════════════════════════
 */
const { QKDSecurityProof, mulberry32 } = require("./photonnet_core.js");
const Q = require("./qkd_over_entanglement.js");
const R = require("./parallel_routing_qkd_rate_test.js");

const h2 = (x) => QKDSecurityProof.h2(Math.min(0.5, Math.max(1e-12, x)));
const EPS = { epsPE: 1e-10, epsCor: 1e-15, epsPA: 1e-10 };
const COR_TERM = Math.log2(2 / EPS.epsCor);
const PA_TERM = 2 * Math.log2(1 / (2 * EPS.epsPA));

// ══════════════════════════════════════════════════════════
// 1) KABUL EŞİĞİ
// ══════════════════════════════════════════════════════════
/** e* = ē + (1 − h₂(ē)) / log₂((1−ē)/ē) — teğet kriteri. */
function admissionThreshold(eBar) {
  if (!(eBar > 0) || eBar >= 0.5) return 0.5;
  const slope = Math.log2((1 - eBar) / eBar);          // = h₂'(ē)
  return Math.min(0.5, eBar + (1 - h2(eBar)) / slope);
}

/**
 * Bir partiyi havuza almanın ℓ'ye TAM etkisi (yaklaşım değil).
 * Analitik eşik yalnızca m→0 limitinde geçerlidir; burada gerçek
 * sonlu-parti farkı hesaplanır ve ikisi test dosyasında KARŞILAŞTIRILIR.
 */
function admissionDelta(pool, batch, leakPerBit = 0) {
  const ellOf = (nPairs, eBar) => {
    const nZ = nPairs / 4, kX = nPairs / 4;             // eleme 1/2, sonra Z/X yarı yarıya
    if (nZ < 8 || kX < 8) return 0;
    const mu = QKDSecurityProof.statisticalFluctuation2(nZ, kX, EPS.epsPE);
    return nZ * (1 - h2(eBar + mu)) - leakPerBit * nZ - COR_TERM - PA_TERM;
  };
  const nTot = pool.pairs + batch.pairs;
  const eNew = nTot ? (pool.pairs * pool.ePh + batch.pairs * batch.ePh) / nTot : 0;
  const before = ellOf(pool.pairs, pool.ePh), after = ellOf(nTot, eNew);
  return {
    ellBefore: Math.max(0, before), ellAfter: Math.max(0, after),
    delta: after - before, admit: after > before,
    pooledEPh: +eNew.toFixed(6),
    analyticThreshold: +admissionThreshold(pool.ePh).toFixed(6),
    analyticSaysAdmit: batch.ePh < admissionThreshold(pool.ePh),
  };
}

// ══════════════════════════════════════════════════════════
// 2) ℓ ÖNGÖRÜCÜSÜ (kontrolcü her tıkta Cascade koşamaz)
// ══════════════════════════════════════════════════════════
/**
 * Gerçek bir sistemde kontrolcü, kapanış kararını vermek için her
 * tıkta hata düzeltme protokolünü çalıştıramaz — bu, kararın kendisi
 * kadar pahalı olurdu. Bu yüzden ℓ, SAYIMLARDAN öngörülür; Cascade
 * yalnızca blok KAPANDIĞINDA bir kez koşar. Öngörücünün hatası test
 * dosyasında gerçek boru hattına karşı ÖLÇÜLÜR.
 */
function predictEll(nZ, kX, ePh, leakPerBit) {
  if (nZ < 8 || kX < 8) return 0;
  const mu = QKDSecurityProof.statisticalFluctuation2(nZ, kX, EPS.epsPE);
  return Math.max(0, nZ * (1 - h2(ePh + mu)) - leakPerBit * nZ - COR_TERM - PA_TERM);
}

// ══════════════════════════════════════════════════════════
// 3) OTURUM KONTROLCÜSÜ
// ══════════════════════════════════════════════════════════
/**
 * Zaman damgalı çiftleri tüketir, ℓ̂(T)'yi izler ve bloğu şu üç
 * koşuldan HANGİSİ ÖNCE gerçekleşirse ona göre kapatır:
 *   (a) MARJİNAL KURAL  ℓ̂'(T) < ℓ̂(T)/T   → hız zirvesi geçildi
 *   (b) SLA             T ≥ maxLatencyMs   → gecikme bütçesi doldu
 *   (c) ARZ BİTTİ       çift kalmadı
 * (a) yalnızca ℓ̂ > minEll olduktan sonra değerlendirilir: sıfır
 * civarında türev gürültülüdür ve kural erken tetiklenirdi.
 */
class SessionController {
  constructor(opts = {}) {
    const {
      tickMs = 25, maxLatencyMs = Infinity, minEll = 128,
      leakPerBit = 0.02, slopeWindow = 4, patience = 2,
    } = opts;
    Object.assign(this, { tickMs, maxLatencyMs, minEll, leakPerBit, slopeWindow, patience });
  }

  /**
   * @param {Array<{t:number,state:object}>} pairs  zaman damgalı çiftler
   * @returns kapanış kararı + gerekçe (izlenebilirlik için tam iz)
   */
  decide(pairs) {
    const sorted = [...pairs].sort((a, b) => a.t - b.t);
    if (!sorted.length) return { closedAt: null, reason: "çift yok", trace: [] };
    const tEnd = sorted[sorted.length - 1].t;
    const trace = [];
    let idx = 0, sumEPh = 0, n = 0, breach = 0;

    for (let T = this.tickMs; ; T += this.tickMs) {
      while (idx < sorted.length && sorted[idx].t <= T) {
        // Faz hatası beklentisi durumdan OKUNUR (Z + Y); ölçüm
        // gürültüsü kontrolcüye girmesin diye — kontrolcü kestirimi
        // ölçümden değil, izlenen kanal kalitesinden yapar.
        const s = sorted[idx].state;
        sumEPh += s.Z + s.Y; n++; idx++;
      }
      const ePh = n ? sumEPh / n : 0;
      const nZ = n / 4, kX = n / 4;
      const ell = predictEll(nZ, kX, ePh, this.leakPerBit);
      const rate = ell / (T / 1000);
      trace.push({ tMs: +T.toFixed(1), pairs: n, ePh: +ePh.toFixed(6), ellHat: Math.round(ell), rateHat: +rate.toFixed(2) });

      const w = trace.length > this.slopeWindow ? trace[trace.length - 1 - this.slopeWindow] : null;
      // ℓ̂'(T): pencere üzerinden sayısal türev (bit/ms → bit/s)
      const slope = w ? ((ell - w.ellHat) / (T - w.tMs)) * 1000 : Infinity;

      if (T >= this.maxLatencyMs)
        return this._close(T, ell, "SLA — gecikme bütçesi doldu", trace, slope, rate);
      if (idx >= sorted.length && T >= tEnd)
        return this._close(T, ell, "arz bitti", trace, slope, rate);
      if (ell >= this.minEll && w) {
        // (a) MARJİNAL KURAL — art arda `patience` tık ihlal edilmeli
        if (slope < rate) { breach++; if (breach >= this.patience) return this._close(T, ell, "marjinal kural: ℓ̂′(T) < ℓ̂(T)/T", trace, slope, rate); }
        else breach = 0;
      }
      if (T > tEnd + this.tickMs * 4) return this._close(T, ell, "arz bitti", trace, slope, rate);
    }
  }

  _close(T, ell, reason, trace, slope, rate) {
    return {
      closedAtMs: +T.toFixed(1), ellHat: Math.round(ell), rateHat: +rate.toFixed(2),
      marginalRate: Number.isFinite(slope) ? +slope.toFixed(2) : null,
      averageRate: +rate.toFixed(2), reason, trace,
    };
  }
}

/** Kapanış kararını GERÇEK boru hattıyla gerçekleştir (Cascade dahil). */
function realiseBlock(pairs, closedAtMs, seed = 0x51D3C0DE) {
  const sub = pairs.filter(p => p.t <= closedAtMs);
  const k = R.bbm92BasisResolved(sub, seed);
  return { pairs: sub.length, ell: k.ell, ePh: k.ePh, nZ: k.nZ, leakEC: k.leakEC,
    rateBps: +(k.ell / (closedAtMs / 1000)).toFixed(2) };
}

// ══════════════════════════════════════════════════════════
// 4) HİBRİT BELL MONİTÖRÜ
// ══════════════════════════════════════════════════════════
/**
 * E91'i ANAHTAR üretmek için değil, kanalın hâlâ kuantum olduğunu
 * KANITLAMAK için kullan. Gereken CHSH turu analitik türetilir; E91
 * ölçüm ayarlarında turların 4/9'u CHSH dörtlüsüne düştüğü için
 * saptırılacak çift sayısı = tur / (4/9).
 */
function bellMonitorPlan(expectedS, nSigma = 3, mode = "probe") {
  const rounds = Q.chshRoundsForSignificance(expectedS, nSigma);
  if (!Number.isFinite(rounds)) return { feasible: false, reason: "S ≤ 2 — ihlal yok, monitör anlamsız" };
  // "e91": tam E91 ızgarası (Alice 3 × Bob 3) — turların yalnızca 4/9'u
  //        CHSH dörtlüsüne düşer, 2/9 anahtar yönü, 3/9 tamamen ziyan.
  // "probe": ADANMIŞ CHSH PROBU — monitör turlarında taraflar zaten
  //        "bu tur test turudur" bilgisini paylaştığı için ayarları
  //        doğrudan 4 CHSH ikilisinden seçerler. Her saptırılan çift
  //        bir CHSH turu üretir (1:1). E91'i anahtar protokolü olarak
  //        değil DOĞRULAMA probu olarak kullanmanın asıl kazancı budur.
  const perPair = mode === "probe" ? 1 : 4 / 9;
  return { feasible: true, mode, nSigma, expectedS, chshRoundsNeeded: rounds,
    pairsNeeded: Math.ceil(rounds / perPair),
    pairsNeededIfFullE91: Math.ceil(rounds / (4 / 9)) };
}

/**
 * ADANMIŞ CHSH PROBU — yalnızca dört CHSH ayar ikilisi kullanılır.
 * Anahtar üretmez, üretmesi de beklenmez; tek işi ihlali kanıtlamaktır.
 */
function chshProbe(pairs, seed) {
  const rng = mulberry32(seed >>> 0);
  const SET = [[0, 45], [0, 135], [90, 45], [90, 135]];
  const counts = SET.map(() => ({ pp: 0, pm: 0, mp: 0, mm: 0 }));
  for (const p of pairs) {
    const i = Math.floor(rng() * 4);
    const [da, db] = SET[i];
    const E = Q.correlation(p.state, da, db);
    const same = rng() < (1 + E) / 2;
    const a = rng() < 0.5 ? 1 : 0, b = same ? a : a ^ 1;
    const c = counts[i];
    if (a && b) c.pp++; else if (a) c.pm++; else if (b) c.mp++; else c.mm++;
  }
  const Em = counts.map(c => { const t = c.pp + c.pm + c.mp + c.mm; return t ? (c.pp + c.mm - c.pm - c.mp) / t : 0; });
  const S = Em[0] - Em[1] + Em[2] + Em[3];
  let varS = 0;
  counts.forEach((c, i) => { const t = c.pp + c.pm + c.mp + c.mm; if (t) varS += (1 - Em[i] * Em[i]) / t; });
  const se = Math.sqrt(varS), sigma = se > 0 ? (S - 2) / se : 0;
  const rounds = counts.reduce((t, c) => t + c.pp + c.pm + c.mp + c.mm, 0);
  return { bell: { S: +S.toFixed(5), standardError: +se.toFixed(5),
    sigmaAboveClassical: +sigma.toFixed(2), chshRounds: rounds, violated: S - 2 > 3 * se } };
}

/**
 * Hibrit oturum: çiftlerin bir kısmı Bell monitörüne, kalanı
 * birleşik-bloklu BBM92'ye.
 *
 * MONİTÖR SEYRELTİLMİŞ ÖRNEKLEMEYLE ÇALIŞIR — ve bu önce bir GÜVENLİK
 * gereğidir, sonra bir optimizasyon. Monitör çiftleri oturumun BAŞINDAN
 * blok halinde alırsa, Bell testi yalnızca oturumun İLK anını sertifikalar;
 * Eve test penceresinde uslu durup sonrasında saldırabilir. Bu yüzden
 * saptırılan turlar, tohumlanmış bir permütasyonla oturumun TAMAMINA
 * yayılır. Yan faydası ölçüldü: baştan-blok saptırmada anahtar hızı
 * kaybı %16,01 iken (saptırılan çift oranı yalnızca %6,8), yayılmış
 * örneklemede kayıp çift oranına yaklaşır — çünkü blok artık gecikmez.
 *
 * MONİTÖR AYRICA UYARLANIRDIR — ve bu bir tercih değil, zorunluluktur.
 * bellMonitorPlan() gereken tur sayısını BEKLENEN S'ten hesaplar; ama
 * gerçekleşen S dalgalanır. İlk kurguda plan 177 tur (399 çift) dedi,
 * ölçülen S ise 2,68 yerine 2,33 çıktı ve sertifika 3σ değil 1,39σ
 * oldu — yani ÖNCEDEN HESAPLANMIŞ SABİT BİR SAPTIRMA, hedefi ıskalar.
 * (Grafikteki zirveye sabit timeout koymakla tam olarak aynı hata.)
 * Çözüm aynı felsefe: eşiği çevrimiçi izle. Monitör, ÖLÇÜLEN σ hedefe
 * ulaşana kadar parça parça çift saptırır; plan yalnızca başlangıç
 * tahminidir. Böylece kanal beklenenden gürültülüyse monitör kendini
 * uzatır, temizse erken biter.
 */
function runHybridSession(pairs, opts = {}) {
  const {
    nSigma = 3, controller = {}, seed = 0x51D3C0DE, e91Seed = 0x1E91C0DE,
    maxDivertFraction = 0.25, chunkFraction = 0.25, monitorMode = "probe",
  } = opts;
  const measureMonitor = monitorMode === "probe"
    ? (ps) => chshProbe(ps, e91Seed)
    : (ps) => R.e91BasisResolved(ps, e91Seed);
  const sorted = [...pairs].sort((a, b) => a.t - b.t);

  // Monitörü boyutlandır: beklenen S, durumdan analitik olarak okunur
  const meanState = sorted.reduce((a, p) => ({
    I: a.I + p.state.I / sorted.length, X: a.X + p.state.X / sorted.length,
    Y: a.Y + p.state.Y / sorted.length, Z: a.Z + p.state.Z / sorted.length,
  }), { I: 0, X: 0, Y: 0, Z: 0 });
  const expectedS = Q.chshStandard(meanState);
  const plan = bellMonitorPlan(expectedS, nSigma, monitorMode);
  if (!plan.feasible) return { ok: false, plan };

  // Saptırma SIRASI: oturumun tamamına yayılmış, tohumlanmış rastgele
  // permütasyon. Önek alarak büyütmek, daha önce seçilenleri SABİT
  // tutar (merdiven adımları birbirinin üstüne biner, sıfırlanmaz).
  const order = sorted.map((_, i) => i);
  const prng = mulberry32((e91Seed ^ 0x9E3779B9) >>> 0);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(prng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const takeSpread = (d) => {
    const flag = new Uint8Array(sorted.length);
    for (let i = 0; i < d; i++) flag[order[i]] = 1;
    const mon = [], key = [];
    for (let i = 0; i < sorted.length; i++) (flag[i] ? mon : key).push(sorted[i]);
    return { mon, key };
  };

  const cap = Math.floor(sorted.length * maxDivertFraction);
  const chunk = Math.max(32, Math.ceil(plan.pairsNeeded * chunkFraction));
  let divert = Math.min(plan.pairsNeeded, sorted.length, cap);
  let split = takeSpread(divert);
  let bell = measureMonitor(split.mon);
  const ladder = [{ divert, S: bell.bell?.S, sigma: bell.bell?.sigmaAboveClassical }];
  while ((bell.bell?.sigmaAboveClassical ?? 0) < nSigma && divert + chunk <= cap) {
    divert += chunk;
    split = takeSpread(divert);
    bell = measureMonitor(split.mon);
    ladder.push({ divert, S: bell.bell?.S, sigma: bell.bell?.sigmaAboveClassical });
  }
  const monitorPairs = split.mon, keyPairs = split.key;
  // Sertifikanın oturumun TAMAMINI kapsadığının kanıtı: saptırılan
  // turların zaman aralığı, oturumun zaman aralığına oranı.
  const span = monitorPairs.length
    ? (monitorPairs[monitorPairs.length - 1].t - monitorPairs[0].t) / (sorted[sorted.length - 1].t - sorted[0].t) : 0;
  const ctl = new SessionController(controller).decide(keyPairs);
  const block = ctl.closedAtMs != null ? realiseBlock(keyPairs, ctl.closedAtMs, seed) : { pairs: 0, ell: 0, rateBps: 0 };

  // Maliyet: saptırılan çiftler anahtarda kalsaydı ne kazandırırdı?
  const noMonitor = new SessionController(controller).decide(sorted);
  const noMonitorBlock = noMonitor.closedAtMs != null ? realiseBlock(sorted, noMonitor.closedAtMs, seed) : { ell: 0, rateBps: 0 };

  return {
    ok: bell.bell?.violated === true && block.ell > 0,
    plan, monitor: {
      divertedPairs: divert, divertedFraction: +(divert / sorted.length).toFixed(5),
      mode: monitorMode, plannedPairs: plan.pairsNeeded,
      pairsIfFullE91: plan.pairsNeededIfFullE91,
      adaptiveSteps: ladder.length, ladder,
      sessionCoverage: +span.toFixed(4),
      firstTMs: monitorPairs.length ? +monitorPairs[0].t.toFixed(2) : null,
      lastTMs: monitorPairs.length ? +monitorPairs[monitorPairs.length - 1].t.toFixed(2) : null,
      reachedTarget: (bell.bell?.sigmaAboveClassical ?? 0) >= nSigma,
      S: bell.bell?.S, standardError: bell.bell?.standardError,
      sigma: bell.bell?.sigmaAboveClassical, violated: bell.bell?.violated,
      chshRoundsUsed: bell.bell?.chshRounds,
    },
    key: { ...block, closedAtMs: ctl.closedAtMs, closeReason: ctl.reason },
    withoutMonitor: { ell: noMonitorBlock.ell, rateBps: noMonitorBlock.rateBps, closedAtMs: noMonitor.closedAtMs },
    cost: {
      // NOT: ellLost negatif çıkabilir — monitör kapanış anını da
      // kaydırdığı için iki blok AYNI T'de kapanmıyor. Karşılaştırılabilir
      // olan büyüklük HIZ (rateLostPct), mutlak ℓ değil.
      ellLost: noMonitorBlock.ell - block.ell,
      ellLostPct: noMonitorBlock.ell > 0 ? +(100 * (noMonitorBlock.ell - block.ell) / noMonitorBlock.ell).toFixed(2) : null,
      rateLostPct: noMonitorBlock.rateBps > 0 ? +(100 * (noMonitorBlock.rateBps - block.rateBps) / noMonitorBlock.rateBps).toFixed(2) : null,
    },
  };
}


// ══════════════════════════════════════════════════════════
// 5) SÜREKLİ AKIŞ SÜRÜCÜSÜ — ardışık bloklar
// ══════════════════════════════════════════════════════════
/**
 * Tek atışlık bir bütçe yerine, durağan bir çift akışı üzerinde
 * bloğu KAPATIP YENİSİNİ AÇARAK çalışır.
 *
 * Burada asıl tasarım gerilimi ortaya çıkar: durağan akışta marjinal
 * kural HİÇ tetiklenmez (arz incelmez), dolayısıyla blok uzunluğunu
 * SLA belirler. Ve blok başına sabit vergi (corTerm + paTerm ≈ 115 bit,
 * artı μ ∼ 1/√n) HER BLOKTA yeniden ödendiği için:
 *      kısa blok  → düşük gecikme, düşük hız
 *      uzun blok  → yüksek hız, yüksek gecikme
 * Yani sürekli akışta "en iyi T" diye tek bir sayı YOKTUR; bir
 * GECİKME–HIZ ÇALIŞMA EĞRİSİ vardır. Operatör SLA'yı seçer, kontrolcü
 * o SLA'da ulaşılabilir en iyi hızı verir.
 *
 * SLA çok kısaltılırsa bloklar sonlu-anahtar sınırını geçemez ve
 * ℓ = 0 olur — yani ÜRETİLEN TÜM ÇİFTLER ÇÖPE GİDER. Bu bir uçurumdur,
 * yumuşak bir düşüş değil. `holdBelowMinEll` açıkken kontrolcü, ölü
 * blok yaymaktansa SLA'yı `maxHoldMs`e kadar uzatır.
 */

/** t > target olan ilk indeks (dizi t'ye göre sıralı). */
function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t > target) hi = mid; else lo = mid + 1; }
  return lo;
}

function runContinuous(pairs, opts = {}) {
  const {
    maxLatencyMs = 1000, leakPerBit = 0.02, tickMs = 25, minEll = 128,
    seed = 0x51D3C0DE, holdBelowMinEll = false, maxHoldMs = Infinity,
    sessionMs = null,
  } = opts;
  const sorted = [...pairs].sort((a, b) => a.t - b.t);
  if (!sorted.length) return { blocks: [], totals: { ell: 0, blocks: 0 } };
  const tEnd = sessionMs ?? sorted[sorted.length - 1].t;

  const blocks = [];
  let cursor = 0, guard = 0;
  while (cursor < tEnd && guard++ < 10000) {
    // Kalan akışı, blok başlangıcına göre GÖRELİ zamana kaydır.
    // DİKKAT — PENCERELEME: burada TÜM kalan akışı kopyalamak, blok
    // sayısıyla çarpılan O(çift × blok) bir maliyet doğurur (uzun
    // oturumda 500+ blok × 600k çift = kullanılamaz). Blok en fazla
    // `limit` kadar sürebileceği için yalnızca o pencere kopyalanır;
    // dizi zaten sıralı olduğundan sınırlar ikili aramayla bulunur.
    const limit = holdBelowMinEll ? Math.min(maxHoldMs, tEnd - cursor + tickMs)
                                  : Math.min(maxLatencyMs, tEnd - cursor + tickMs);
    const lo = lowerBound(sorted, cursor);            // t > cursor olan ilk indeks
    const hi = lowerBound(sorted, cursor + limit);    // t > cursor+limit olan ilk indeks
    if (lo >= sorted.length) break;
    const slice = new Array(Math.max(0, hi - lo));
    for (let i = lo; i < hi; i++) slice[i - lo] = { ...sorted[i], t: sorted[i].t - cursor };
    if (!slice.length) break;

    let sla = maxLatencyMs;
    let dec = new SessionController({ tickMs, leakPerBit, minEll, maxLatencyMs: sla }).decide(slice);
    // Ölü blok yayma: gerekirse SLA'yı uzat
    if (holdBelowMinEll && dec.ellHat < minEll) {
      while (dec.ellHat < minEll && sla < maxHoldMs && cursor + sla < tEnd) {
        sla = Math.min(sla * 2, maxHoldMs);
        dec = new SessionController({ tickMs, leakPerBit, minEll, maxLatencyMs: sla }).decide(slice);
      }
    }
    const closed = dec.closedAtMs;
    if (closed == null || closed <= 0) break;
    const real = realiseBlock(slice, closed, (seed + blocks.length * 7919) >>> 0);
    // Akış bittiği için kapanan blok, SLA'yı TEMSİL ETMEZ: süresi
    // kısadır ve ortalamayı aşağı çeker. Kesik sayılıp istatistikten
    // düşülür (ölçüm, SLA ile kapanan bloklar üzerinden okunur).
    const truncated = cursor + closed > tEnd + tickMs || dec.reason === "arz bitti";
    blocks.push({
      index: blocks.length, startMs: +cursor.toFixed(1), endMs: +(cursor + closed).toFixed(1),
      durationMs: +closed.toFixed(1), slaUsedMs: sla, reason: dec.reason,
      pairs: real.pairs, ell: real.ell, ePh: real.ePh, rateBps: real.rateBps, truncated,
    });
    cursor += closed;
  }

  const complete = blocks.filter(b => !b.truncated);
  const ell = complete.reduce((s, b) => s + b.ell, 0);
  // Süre, tamamlanmış blokların SÜRELERİ TOPLAMIDIR — son (kesik) blok
  // atıldığı için "son bloğun bitiş anı" kullanılamaz, yoksa atılan
  // sürenin anahtarı payda içinde kalır ve hız olduğundan düşük çıkar.
  const span = complete.reduce((s, b) => s + b.durationMs, 0);
  const dead = complete.filter(b => b.ell === 0);
  return {
    blocks, totals: {
      blocks: complete.length, truncatedBlocks: blocks.length - complete.length,
      ell, spanMs: +span.toFixed(1),
      sustainedRateBps: span > 0 ? +(ell / (span / 1000)).toFixed(2) : 0,
      meanBlockMs: complete.length ? +(span / complete.length).toFixed(1) : null,
      meanEllPerBlock: complete.length ? +(ell / complete.length).toFixed(1) : 0,
      deadBlocks: dead.length,
      pairsConsumed: complete.reduce((s, b) => s + b.pairs, 0),
      pairsWasted: dead.reduce((s, b) => s + b.pairs, 0),
    },
  };
}

module.exports = {
  admissionThreshold, admissionDelta, predictEll,
  SessionController, realiseBlock, bellMonitorPlan, chshProbe, runHybridSession,
  runContinuous,
  h2, EPS, COR_TERM, PA_TERM,
};
