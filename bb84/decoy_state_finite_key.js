#!/usr/bin/env node
"use strict";
/**
 * decoy_state_finite_key.js — Sonlu-boyutlu (finite-key) decoy istatistiği:
 * Q_μ/Q_ν/Y_0/(E_ν·Q_ν) için Chernoff-tabanlı güven aralıkları, ve bunların
 * decoy_state_protocol.js'in DEĞİŞTİRİLMEMİŞ Y1/e1 formüllerine
 * YÖN-FARKINDALIKLI (monotonluk-korumalı) worst-case birleştirmesi.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM/TÜRETİM: bkz. bb84/docs/DECOY_STATE_FINITE_KEY_DESIGN.md — bu
 * dosya o belgenin §2 (Chernoff türetimi) + §4 (yön-farkındalı birleştirme)
 * + §5 (epsilon bütçesi) bölümlerinin ÇALIŞTIRILABİLİR hâlidir.
 *
 * ÇEKİRDEĞE VE decoy_state_protocol.js'E TEK SATIR DOKUNULMAZ. Bu dosya
 * `decoy_state_protocol.js`'i require EDER (o dosyanın estimateY1Lower/
 * estimateE1Upper'ını PARAMETRE İKAMESİYLE — bkz. §4/kod yorumları —
 * DEĞİŞTİRMEDEN yeniden kullanır) ama `core`'u KENDİSİ require ETMEZ
 * (çağıran geçirir, si3n4_pic_link_budget.js ile AYNI desen).
 *
 * KULLANIM:
 *   const decoy = require("./decoy_state_protocol.js");
 *   const fk = require("./decoy_state_finite_key.js");
 *   const muRun = decoy.simulateIntensity({ core, mu, pulses: 50000, seed: 1, params });
 *   const nuRun = decoy.simulateIntensity({ core, mu: nu, pulses: 50000, seed: 2, params });
 *   const vacRun = decoy.simulateIntensity({ core, mu: 0, pulses: 50000, seed: 3, params });
 *   const y1 = fk.estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE: 1e-6 });
 *   const e1 = fk.estimateE1UpperFinite({ nu, nuRun, vacRun, epsPE: 1e-6, Y1LowerFinite: y1.Y1LowerFinite });
 * ═══════════════════════════════════════════════════════════════════
 */

const decoy = require("./decoy_state_protocol.js");

/**
 * β=ln(1/ε), λ⁺(n,ε) — bkz. DESIGN.md §2.2, alt-kuyruk Chernoff sınırının
 * (P(X≤(1−δ)λ)≤exp(−λδ²/2)) ters-çevirisiyle türetildi. λ⁺, gözlenen n
 * SAYISINDAN, GERÇEK ortalama λ'nın olabileceği en büyük değeri (en fazla
 * ε olasılıkla aşılan) verir.
 */
function chernoffLambdaUpper(n, epsilon) {
  if (!(n >= 0)) throw new RangeError("chernoffLambdaUpper: n>=0 olmalı.");
  if (!(epsilon > 0) || epsilon >= 1) throw new RangeError("chernoffLambdaUpper: epsilon (0,1) aralığında olmalı.");
  const beta = Math.log(1 / epsilon);
  return n + beta + Math.sqrt(2 * n * beta + beta * beta);
}

/**
 * λ⁻(n,ε) — bkz. DESIGN.md §2.2, üst-kuyruk Chernoff sınırının
 * (P(X≥(1+δ)λ)≤exp(−λδ²/(2+δ))) ters-çevirisiyle türetildi.
 */
function chernoffLambdaLower(n, epsilon) {
  if (!(n >= 0)) throw new RangeError("chernoffLambdaLower: n>=0 olmalı.");
  if (!(epsilon > 0) || epsilon >= 1) throw new RangeError("chernoffLambdaLower: epsilon (0,1) aralığında olmalı.");
  const beta = Math.log(1 / epsilon);
  return Math.max(0, n + beta / 2 - Math.sqrt(2 * n * beta + (beta * beta) / 4));
}

/**
 * Herhangi bir Bernoulli-oranı (count/pulses) için — Q_k (count=algılanan
 * darbe sayısı) VEYA E_k·Q_k (count=hem algılanan HEM hatalı darbe sayısı,
 * yani m_k) için AYNI genel fonksiyon (bkz. DESIGN.md §3 — n_k/m_k AYRI
 * Chernoff uygulamaları, birbirine ÇARPILARAK bileşik hâle GETİRİLMEZ).
 */
function finiteRateBounds({ count, pulses, epsilon }) {
  if (!(pulses > 0)) throw new RangeError("finiteRateBounds: pulses>0 olmalı.");
  if (!(count >= 0) || count > pulses) throw new RangeError("finiteRateBounds: count, [0,pulses] aralığında olmalı.");
  return {
    lower: chernoffLambdaLower(count, epsilon) / pulses,
    upper: chernoffLambdaUpper(count, epsilon) / pulses,
  };
}

/**
 * Y1LowerFinite — bkz. DESIGN.md §4 (yön-farkındalı birleştirme). ÜÇ
 * BAĞIMSIZ Chernoff uygulaması (Qμ⁺, Qν⁻, Y0⁺), her biri epsPE/3 payıyla
 * (union bound — bkz. §5). `decoy.estimateY1Lower`'ı DEĞİŞTİRMEDEN çağırır.
 *
 * @param {object} p - {mu, nu, muRun:{pulses,detected}, nuRun:{pulses,detected}, vacRun:{pulses,detected}, epsPE}
 */
function estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE }) {
  if (!(epsPE > 0) || epsPE >= 1) throw new RangeError("estimateY1LowerFinite: epsPE (0,1) aralığında olmalı.");
  const eps3 = epsPE / 3;
  const QmuUpper = finiteRateBounds({ count: muRun.detected, pulses: muRun.pulses, epsilon: eps3 }).upper;
  const QnuLower = finiteRateBounds({ count: nuRun.detected, pulses: nuRun.pulses, epsilon: eps3 }).lower;
  const Y0Upper = finiteRateBounds({ count: vacRun.detected, pulses: vacRun.pulses, epsilon: eps3 }).upper;
  // GÜVENLİ (küçük) Y1L için: Qν→ALT, Qμ→ÜST, Y0→ÜST (bkz. DESIGN.md §4,
  // ∂Y1L/∂Qν>0, ∂Y1L/∂Qμ<0, ∂Y1L/∂Y0<0 işaret analizi).
  const Y1LowerFinite = decoy.estimateY1Lower({ Qmu: QmuUpper, Qnu: QnuLower, mu, nu, Y0: Y0Upper });
  return { Y1LowerFinite, inputs: { QmuUpper, QnuLower, Y0Upper }, epsPerBound: eps3, boundCount: 3 };
}

/**
 * e1UpperFinite — bkz. DESIGN.md §4. İKİ BAĞIMSIZ Chernoff uygulaması
 * daha ((EνQν)⁺, Y0⁻), her biri epsPE/5 payıyla (Y1LowerFinite'ın ÜÇÜYLE
 * BİRLİKTE toplam 5 — bkz. §5). `decoy.estimateE1Upper`'ı `Enu=1,
 * Qnu=(EνQν)⁺` PARAMETRE İKAMESİYLE çağırır — bu, o fonksiyonun içinde
 * `fNu=Qnu·e^ν` sonra `Enu·fNu` hesapladığı formülü, Enu=1 verilince
 * TAM OLARAK `(EνQν)⁺·e^ν`'ye indirger (bkz. DESIGN.md §3 — E_ν'nin
 * KENDİ ayrı bir güven aralığı YOK, gerekmiyor).
 *
 * DİKKAT (DESIGN.md §4'teki asimetri): Y0 burada Y1LowerFinite'takinin
 * TERSİ yönde (ALT değil ÜST) kullanılır — AYNI ölçümün (vacRun) İKİ AYRI
 * ucu, İKİ AYRI Chernoff uygulaması olarak ele alınır.
 *
 * @param {object} p - {nu, nuRun:{pulses,detected,errors}, vacRun:{pulses,detected}, epsPE, Y1LowerFinite, e0}
 */
function estimateE1UpperFinite({ nu, nuRun, vacRun, epsPE, Y1LowerFinite, e0 = decoy.DEFAULTS.e0 }) {
  if (!(epsPE > 0) || epsPE >= 1) throw new RangeError("estimateE1UpperFinite: epsPE (0,1) aralığında olmalı.");
  const eps5 = epsPE / 5; // Y1LowerFinite'ın üçüyle BİRLİKTE toplam 5 pay — bkz. DESIGN.md §5
  const EQnuUpper = finiteRateBounds({ count: nuRun.errors, pulses: nuRun.pulses, epsilon: eps5 }).upper;
  const Y0Lower = finiteRateBounds({ count: vacRun.detected, pulses: vacRun.pulses, epsilon: eps5 }).lower;
  const e1UpperFinite = decoy.estimateE1Upper({ Enu: 1, Qnu: EQnuUpper, nu, Y0: Y0Lower, e0, Y1Lower: Y1LowerFinite });
  return { e1UpperFinite, inputs: { EQnuUpper, Y0Lower }, epsPerBound: eps5, boundCount: 2 };
}

/**
 * TOPLAM boru hattı — Y1LowerFinite + e1UpperFinite'ı BİR ÇAĞRIDA üretir.
 * epsPE, TOPLAM 5 Chernoff uygulaması arasında EŞİT bölünür (bkz. DESIGN.md §5).
 */
function estimateDecoyFiniteKey({ mu, nu, muRun, nuRun, vacRun, epsPE }) {
  const y1 = estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE });
  const e1 = estimateE1UpperFinite({ nu, nuRun, vacRun, epsPE, Y1LowerFinite: y1.Y1LowerFinite });
  return {
    Y1LowerFinite: y1.Y1LowerFinite,
    e1UpperFinite: e1.e1UpperFinite,
    epsPE,
    boundCount: y1.boundCount + e1.boundCount, // =5 — union bound'un kaç bağımsız Chernoff uygulamasına dağıtıldığı
    y1Inputs: y1.inputs,
    e1Inputs: e1.inputs,
  };
}

/**
 * §5 — decoy finite-key epsilon'unu (bu dosyanın epsPE'si), çekirdeğin
 * KENDİ sonlu-anahtar epsilon bütçesiyle (epsPE+epsCor+epsPA,
 * QKDSecurityProof.secureKeyLengthWithMu'nun opts'u) union-bound ile
 * TOPLAR — GERÇEK BULGU (bkz. DESIGN.md §5): decoy_state_protocol.js'in
 * applyDecoyCorrection'ı bu toplamı YAPMIYORDU, iki ε kaynağı BAĞIMSIZMIŞ
 * gibi ele alınıyordu.
 */
function combinedSecurityEpsilon({ decoyEpsPE, coreEpsPE = 1e-10, epsCor = 1e-15, epsPA = 1e-10 }) {
  if (!(decoyEpsPE > 0)) throw new RangeError("combinedSecurityEpsilon: decoyEpsPE>0 olmalı.");
  return {
    decoyEpsPE, coreEpsPE, epsCor, epsPA,
    totalEpsilon: decoyEpsPE + coreEpsPE + epsCor + epsPA,
  };
}

module.exports = {
  chernoffLambdaUpper, chernoffLambdaLower,
  finiteRateBounds,
  estimateY1LowerFinite, estimateE1UpperFinite, estimateDecoyFiniteKey,
  combinedSecurityEpsilon,
};
