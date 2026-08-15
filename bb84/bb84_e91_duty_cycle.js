#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * BB84/E91 HİBRİT GÖREV DÖNGÜSÜ (DUTY CYCLE)
 * ═══════════════════════════════════════════════════════════════════
 * Amaç: baz eşleşme verimini artırmak. Mevcut durumda oranlar şöyle:
 *
 *   BBM92 (yansız)  Alice/Bob bağımsız Z veya X (½/½)
 *                   → eleme  P(aynı baz)      = 1/2
 *                   → ANAHTAR bazı (Z eşleşme) = 1/4
 *                   → PE bazı    (X eşleşme)   = 1/4
 *   E91             Alice {0°,45°,90°} × Bob {45°,90°,135°}
 *                   → anahtar (45°,45°)        = 1/9
 *                   → PE      (90°,90°)        = 1/9
 *                   → CHSH dörtlüsü            = 4/9
 *                   → tamamen ziyan            = 3/9
 *
 * ── TASARIM: YANLI BAZ SEÇİMİ + BELL GÖREV DÖNGÜSÜ ──
 * Turlar iki moda ayrılır (tohumlanmış, taraflarca paylaşılan seçim):
 *   • BELL MODU (oran f_bell): adanmış CHSH probu — güvenlik sertifikası.
 *   • ANAHTAR MODU (1 − f_bell): BBM92, ama bazlar YANSIZ DEĞİL:
 *        Z olasılığı p,  X olasılığı 1−p        (Lo–Chau–Ardehali 2005)
 *     → anahtar turu p², PE turu (1−p)², gerisi eşleşmeyip elenir.
 *
 * p = ½ iken anahtar turu ¼'tür; p büyüdükçe p² → 1'e gider. Yani baz
 * eşleşme verimi ASİMPTOTİK OLARAK 4 KATINA kadar çıkabilir (¼ → 1).
 *
 * ── AMA BEDAVA DEĞİL: p'nin BİR OPTİMUMU VAR ──
 * p büyüdükçe PE örneklemi k = (1−p)²N ÇÖKER ve sonlu-anahtar payı
 * μ ∼ √((n+k)/(n·k)) patlar. ℓ = n·(1 − h₂(e_ph + μ)) − leak·n − sabit
 * ifadesinde n artarken μ da arttığı için bir İÇ OPTİMUM oluşur.
 * Bu modül p*'yi VARSAYMAZ, blok boyutuna göre TÜRETİR (optimalBias).
 * Optimum p*, N büyüdükçe 1'e yaklaşır — dolayısıyla kazanç da blok
 * boyutuyla birlikte büyür; tek bir "×4,5" sayısı yoktur, KAZANÇ BİR
 * EĞRİDİR ve hangi tabana göre ölçüldüğü söylenmeden anlamsızdır.
 *
 * ── GÜVENLİK NOTLARI ──
 * • Yanlı baz seçimi standart ve güvenlidir (Lo–Chau–Ardehali): baz
 *   seçimi ölçüm ANINDA Eve'e bilinmediği sürece p ≠ ½ güvenliği
 *   bozmaz. Gizli kalması gereken şey seçimin KENDİSİ değil, ölçüm
 *   öncesi ÖNGÖRÜLEMEZ olmasıdır.
 * • Faz hatası YİNE X bazından kestirilir (baz-çözünürlü muhasebe);
 *   karışık QBER kullanılmaz.
 * • Bell modu turları anahtara KATILMAZ; sertifika ile anahtar üretimi
 *   AYRI koşullardır.
 * ═══════════════════════════════════════════════════════════════════
 */
const { mulberry32, CascadeReconciliation, QKDSecurityProof } = require("./photonnet_core.js");
const Q = require("./qkd_over_entanglement.js");
const C = require("./qkd_session_controller.js");

const EPS = C.EPS;
const COR_TERM = C.COR_TERM, PA_TERM = C.PA_TERM;
const h2 = C.h2;
const CHSH_SET = [[0, 45], [0, 135], [90, 45], [90, 135]];

// ══════════════════════════════════════════════════════════
// 1) OPTİMAL YANLILIK — türetilir, varsayılmaz
// ══════════════════════════════════════════════════════════
/**
 * Verilen tur sayısı ve kanal kalitesi için ℓ'yi maksimize eden p.
 * ℓ(p) tek tepeli olduğundan altın-oran yerine ince tarama + yerel
 * iyileştirme yeterli (p ∈ [0,5 , 0,999]).
 */
function optimalBias(rounds, ePh, leakPerBit, opts = {}) {
  const { fBell = 0 } = opts;
  const usable = rounds * (1 - fBell);
  const ellOf = (p) => {
    const n = usable * p * p, k = usable * (1 - p) * (1 - p);
    if (n < 8 || k < 8) return -Infinity;
    const mu = QKDSecurityProof.statisticalFluctuation2(n, k, EPS.epsPE);
    return n * (1 - h2(ePh + mu)) - leakPerBit * n - COR_TERM - PA_TERM;
  };
  let best = { p: 0.5, ell: ellOf(0.5) };
  for (let p = 0.5; p <= 0.999; p += 0.001) {
    const e = ellOf(p);
    if (e > best.ell) best = { p: +p.toFixed(3), ell: e };
  }
  // yerel iyileştirme
  for (let d = 0.0005; d >= 1e-5; d /= 2) {
    for (const q of [best.p - d, best.p + d]) {
      if (q <= 0.5 || q >= 0.9999) continue;
      const e = ellOf(q);
      if (e > best.ell) best = { p: q, ell: e };
    }
  }
  const n = usable * best.p * best.p, k = usable * (1 - best.p) * (1 - best.p);
  return {
    p: +best.p.toFixed(5), ellPredicted: Math.max(0, Math.round(best.ell)),
    keyRoundFraction: +(best.p * best.p * (1 - fBell)).toFixed(5),
    peRoundFraction: +((1 - best.p) * (1 - best.p) * (1 - fBell)).toFixed(5),
    nPredicted: Math.round(n), kPredicted: Math.round(k),
    muPredicted: +QKDSecurityProof.statisticalFluctuation2(n, k, EPS.epsPE).toFixed(6),
  };
}

// ══════════════════════════════════════════════════════════
// 2) GÖREV DÖNGÜSÜ ÖLÇÜMÜ
// ══════════════════════════════════════════════════════════
/**
 * Her tur için mod ve baz seçimi; BBM92 anahtar/PE bitleri ve CHSH
 * sayımları tek geçişte üretilir.
 */
function dutyCycleMeasure(pairs, opts = {}) {
  const { pKey = 0.5, fBell = 0, seed = 0x0DDC1CE5 } = opts;
  const rng = mulberry32(seed >>> 0);
  const aKey = [], bKey = [], aPE = [], bPE = [];
  const counts = CHSH_SET.map(() => ({ pp: 0, pm: 0, mp: 0, mm: 0 }));
  let bellRounds = 0, mismatched = 0;

  for (const p of pairs) {
    const s = p.state;
    if (rng() < fBell) {
      // ── BELL MODU: adanmış CHSH probu ──
      const i = Math.floor(rng() * 4);
      const [da, db] = CHSH_SET[i];
      const E = Q.correlation(s, da, db);
      const same = rng() < (1 + E) / 2;
      const a = rng() < 0.5 ? 1 : 0, b = same ? a : a ^ 1;
      const c = counts[i];
      if (a && b) c.pp++; else if (a) c.pm++; else if (b) c.mp++; else c.mm++;
      bellRounds++;
      continue;
    }
    // ── ANAHTAR MODU: YANLI baz seçimi ──
    const aZ = rng() < pKey, bZ = rng() < pKey;
    if (aZ !== bZ) { mismatched++; continue; }
    // Saf faz gürültüsünde: Z bazı hatası X+Y, X bazı hatası Z+Y
    const pErr = aZ ? (s.X + s.Y) : (s.Z + s.Y);
    const a = rng() < 0.5 ? 1 : 0;
    const b = rng() < pErr ? a ^ 1 : a;
    if (aZ) { aKey.push(a); bKey.push(b); } else { aPE.push(a); bPE.push(b); }
  }

  const Em = counts.map(c => { const t = c.pp + c.pm + c.mp + c.mm; return t ? (c.pp + c.mm - c.pm - c.mp) / t : 0; });
  const S = Em[0] - Em[1] + Em[2] + Em[3];
  let varS = 0;
  counts.forEach((c, i) => { const t = c.pp + c.pm + c.mp + c.mm; if (t) varS += (1 - Em[i] * Em[i]) / t; });
  const se = Math.sqrt(varS), sigma = se > 0 ? (S - 2) / se : 0;

  return {
    total: pairs.length,
    keyRounds: aKey.length, peRounds: aPE.length, bellRounds, mismatched,
    keyRoundFraction: +(aKey.length / pairs.length).toFixed(5),
    peRoundFraction: +(aPE.length / pairs.length).toFixed(5),
    basisMatchFraction: +((aKey.length + aPE.length) / pairs.length).toFixed(5),
    aKey, bKey, aPE, bPE,
    bell: bellRounds > 0 ? {
      S: +S.toFixed(5), standardError: +se.toFixed(5),
      sigmaAboveClassical: +sigma.toFixed(2), chshRounds: bellRounds,
      violated: S - 2 > 3 * se,
    } : null,
  };
}

// ══════════════════════════════════════════════════════════
// 3) TAM AKIŞ — ölçüm → EC → sonlu-anahtar kanıtı
// ══════════════════════════════════════════════════════════
function runDutyCycle(pairs, opts = {}) {
  const { pKey = 0.5, fBell = 0, seed = 0x0DDC1CE5 } = opts;
  const m = dutyCycleMeasure(pairs, { pKey, fBell, seed });
  const n = m.keyRounds, k = m.peRounds;
  if (n < 8 || k < 8) {
    return { ...m, aKey: undefined, bKey: undefined, aPE: undefined, bPE: undefined,
      ok: false, reason: "anahtar veya PE örneklemi çok küçük", ell: 0 };
  }
  let eBitC = 0; for (let i = 0; i < n; i++) if (m.aKey[i] !== m.bKey[i]) eBitC++;
  let ePhC = 0; for (let i = 0; i < k; i++) if (m.aPE[i] !== m.bPE[i]) ePhC++;
  const eBit = eBitC / n, ePh = ePhC / k;

  const rng = mulberry32((seed ^ 0xC45CADE1) >>> 0);
  const rec = CascadeReconciliation.reconcile(m.aKey, m.bKey, Math.max(eBit, 1e-4), rng);
  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, EPS.epsPE);
  const proof = QKDSecurityProof.secureKeyLengthWithMu(n, ePh, mu, {
    epsCor: EPS.epsCor, epsPA: EPS.epsPA, realLeakEC: rec.leakedBits,
  });
  return {
    ...m, aKey: undefined, bKey: undefined, aPE: undefined, bPE: undefined,
    pKey, fBell,
    eBit: +eBit.toFixed(6), ePh: +ePh.toFixed(6), mu: +mu.toFixed(6),
    leakEC: rec.leakedBits, ell: proof.ell, ok: proof.secure,
    reason: proof.secure ? null : "sonlu-anahtar sınırı ℓ ≤ 0 (abort)",
  };
}

/**
 * REFERANS: saf E91 ızgarası (Alice 3 × Bob 3). Karşılaştırmanın
 * tabanını UYDURMAMAK için burada da GERÇEK ölçüm yapılır.
 */
function e91BasisFractions(pairs, seed = 0x1E91C0DE) {
  const rng = mulberry32(seed >>> 0);
  const A = [0, 45, 90], B = [45, 90, 135];
  let key = 0, pe = 0, chsh = 0, wasted = 0;
  for (const _ of pairs) {
    const da = A[Math.floor(rng() * 3)], db = B[Math.floor(rng() * 3)];
    if (da === 45 && db === 45) key++;
    else if (da === 90 && db === 90) pe++;
    else if (CHSH_SET.some(([x, y]) => x === da && y === db)) chsh++;
    else wasted++;
  }
  const N = pairs.length;
  return {
    keyRoundFraction: +(key / N).toFixed(5), peRoundFraction: +(pe / N).toFixed(5),
    chshFraction: +(chsh / N).toFixed(5), wastedFraction: +(wasted / N).toFixed(5),
  };
}

module.exports = { optimalBias, dutyCycleMeasure, runDutyCycle, e91BasisFractions, CHSH_SET };
