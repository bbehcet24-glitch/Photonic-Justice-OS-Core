#!/usr/bin/env node
"use strict";
/**
 * decoy_state_protocol.js — Poisson-dağılımlı çoklu-foton riskine karşı
 * Decoy-State protokolünün matematiksel modeli: Y₁ alt-sınırı, e₁ üst-sınırı,
 * ve bunların ÇEKİRDEĞİN ZATEN VAR OLAN `QKDSecurityProof.
 * secureKeyLengthWithMu(n, qBit, mu, opts)` arayüzüne (opts.realLeakEC ile
 * AYNI "gerçek ölçüm teorik tahminin yerine geçer" deseniyle) enjeksiyonu.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM/TÜRETİM: bkz. bb84/docs/DECOY_STATE_PROTOCOL_DESIGN.md — bu
 * dosya o belgenin §4 (türetim) + §5 (kanal modeli) + §6 (entegrasyon)
 * bölümlerinin ÇALIŞTIRILABİLİR hâlidir. §0 DÜRÜSTLÜK NOTU orada
 * geçerlidir: literatür-tipik parametre ARALIKLARI, ölçülmüş DEĞİL.
 *
 * ÇEKİRDEĞE DOKUNULMAZ — bu modül `core`'u PARAMETRE olarak alır
 * (çağıran `require("./photonnet_core.js")` yapıp geçirir), kendisi
 * require ETMEZ (bkz. si3n4_pic_link_budget.js/quantum_phase_buffer.js
 * ile AYNI desen). `core.poissonSample` (dark-count kalibrasyonu için
 * zaten var olan Poisson örnekleyici) ve `core.mulberry32` (deterministik
 * PRNG) doğrudan YENİDEN KULLANILIR — burada YENİDEN UYGULANMAZ.
 *
 * KULLANIM:
 *   const core = require("./photonnet_core.js");
 *   const decoy = require("./decoy_state_protocol.js");
 *   const muRun = decoy.simulateIntensity({ core, mu: 0.5, pulses: 200000, seed: 1, params, channel: decoy.channelYield, errorFn: decoy.channelError });
 *   const nuRun = decoy.simulateIntensity({ core, mu: 0.1, pulses: 200000, seed: 2, params, channel: decoy.channelYield, errorFn: decoy.channelError });
 *   const vacRun = decoy.simulateIntensity({ core, mu: 0,   pulses: 200000, seed: 3, params, channel: decoy.channelYield, errorFn: decoy.channelError });
 *   const proof = decoy.applyDecoyCorrection(core, { nTotal: muRun.detected, mu: 0.5, nu: 0.1,
 *       muStats: { Q: muRun.Q, E: muRun.E }, nuStats: { Q: nuRun.Q, E: nuRun.E }, vacuumStats: { Q: vacRun.Q } });
 * ═══════════════════════════════════════════════════════════════════
 */

// ── Varsayılan parametreler (bkz. DESIGN.md §5 — literatür-tipik, GYS-tarzı) ──
const DEFAULTS = Object.freeze({
  mu: 0.5,            // sinyal yoğunluğu (ortalama foton/darbe)
  nu: 0.1,             // zayıf-decoy yoğunluğu
  Y0: 1e-5,            // karanlık-sayım/arka-plan verimi (vakum darbesi başına)
  e0: 0.5,             // karanlık sayımların temelsiz/rastgele hata olasılığı (geleneksel)
  eDetector: 0.02,     // detektörün içsel hizalama hatası
  eta: 0.10,           // kanal+detektör TOPLAM iletim olasılığı
});

const PARAM_RANGES = Object.freeze({
  mu: [0.01, 2.0],
  nu: [0.001, 1.5],
  Y0: [1e-8, 1e-2],
  e0: [0, 1],
  eDetector: [0, 0.2],
  eta: [1e-6, 1.0],
});

function validateParams(p) {
  const problems = [];
  for (const [key, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    if (p[key] !== undefined && (p[key] < lo || p[key] > hi)) {
      problems.push(`${key}=${p[key]} literatür-tipik aralığın (${lo}..${hi}) DIŞINDA — bkz. DECOY_STATE_PROTOCOL_DESIGN.md §5`);
    }
  }
  return problems;
}

/** Poisson olasılık kütle fonksiyonu P(n|mu) — log-uzayda kararlı hesap (büyük n için taşma önler). */
function poissonPmf(n, mu) {
  if (!(mu >= 0) || !(Number.isInteger(n)) || n < 0) {
    throw new RangeError("poissonPmf: mu>=0 ve n tam-sayı>=0 olmalı.");
  }
  if (mu === 0) return n === 0 ? 1 : 0;
  let logp = -mu + n * Math.log(mu);
  for (let i = 2; i <= n; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

// ── GYS-tipi kanal modeli (bkz. DESIGN.md §5) ──────────────────────────
function channelYield(n, { Y0, eta }) {
  return 1 - (1 - Y0) * Math.pow(1 - eta, n);
}
function channelError(n, { Y0, e0, eDetector, eta }) {
  const y = channelYield(n, { Y0, eta });
  if (y <= 0) return e0;
  return (e0 * Y0 + eDetector * (1 - Math.pow(1 - eta, n))) / y;
}

// ── PNS kötü-durum kanal modeli (bkz. DESIGN.md §5.1 — illüstratif) ────
function pnsWorstCaseYield(n, { Y0 }) {
  if (n === 0) return Y0;
  if (n === 1) return 0;
  return 1;
}
function pnsWorstCaseError(n, { e0, eDetector }) {
  if (n === 0) return e0;
  if (n === 1) return 0; // Y=0 olduğundan katkısı yok; tanımsızlığı önlemek için 0 (kullanılmaz)
  return eDetector;
}

/**
 * Analitik/kesinlik-referansı: μ yoğunluğundaki TEORİK kazanç (Q) ve QBER (E),
 * verilen (yield,error) fonksiyon çiftiyle, n=0..nMax kesilmiş Poisson toplamı.
 * Monte Carlo'nun (simulateIntensity) yakınsadığı "gerçek" değerdir — testte
 * ikisi karşılaştırılır.
 */
function theoreticalGainAndQber(mu, params, yieldFn = channelYield, errorFn = channelError, nMax = 80) {
  let Q = 0, EQ = 0;
  for (let n = 0; n <= nMax; n++) {
    const p = poissonPmf(n, mu);
    if (p < 1e-300 && n > mu) break; // kuyruk ihmal edilebilir düzeye indi
    const y = yieldFn(n, params);
    Q += p * y;
    EQ += p * y * errorFn(n, params);
  }
  return { Q, E: Q > 0 ? EQ / Q : null };
}

/**
 * Monte Carlo darbe simülasyonu: `pulses` adet darbe için gerçek foton sayısı
 * n'i `core.poissonSample(mu)` İLE ÖRNEKLER (çekirdeğin dark-count kalibrasyon
 * fonksiyonu YENİDEN KULLANILIR, yeniden uygulanmaz), ardından n'e bağlı
 * yield/error fonksiyonlarıyla detection/error Bernoulli denemeleri yapar.
 * Deterministik: `core.mulberry32(seed)` ile üretilen TEK bir RNG akışı sırayla
 * (n örneklemi İÇİN core.poissonSample kendi Math.random() kullanır — bu yüzden
 * n örneklemi deterministik DEĞİLDİR; detection/error kararları ise seed'li
 * RNG ile ALINIR — bkz. modül başlığı, poissonSample'ın kendisi çekirdekte
 * Math.random() tabanlıdır, DEĞİŞTİRİLMEDEN yeniden kullanılır).
 */
function simulateIntensity({ core, mu, pulses, params, seed, yieldFn = channelYield, errorFn = channelError }) {
  if (!core || typeof core.poissonSample !== "function" || typeof core.mulberry32 !== "function") {
    throw new TypeError("simulateIntensity: 'core' bb84/photonnet_core.js'in require() edilmiş hâli olmalı (poissonSample + mulberry32 export etmeli).");
  }
  if (!(pulses > 0) || !Number.isInteger(pulses)) {
    throw new RangeError("simulateIntensity: pulses pozitif tam sayı olmalı.");
  }
  const rng = core.mulberry32((seed >>> 0) || 1);
  let detected = 0, errors = 0;
  const photonNumberHistogram = {};
  for (let i = 0; i < pulses; i++) {
    const n = core.poissonSample(mu);
    photonNumberHistogram[n] = (photonNumberHistogram[n] || 0) + 1;
    const y = yieldFn(n, params);
    if (rng() < y) {
      detected++;
      const e = errorFn(n, params);
      if (rng() < e) errors++;
    }
  }
  return {
    pulses, detected, errors,
    Q: detected / pulses,
    E: detected > 0 ? errors / detected : null,
    photonNumberHistogram,
  };
}

/**
 * Y₁ alt-sınırı — bkz. DESIGN.md §4.1 (türetim + sayısal doğrulama).
 * Y₁^L = (μ/(μν−ν²)) · [Q_ν e^ν − Q_μ e^μ (ν/μ)² − ((μ²−ν²)/μ²)·Y₀]
 */
function estimateY1Lower({ Qmu, Qnu, mu, nu, Y0 }) {
  if (!(mu > nu) || !(nu > 0)) {
    throw new RangeError("estimateY1Lower: mu > nu > 0 olmalı (decoy yoğunluğu sinyalden KÜÇÜK olmalı).");
  }
  const fMu = Qmu * Math.exp(mu);
  const fNu = Qnu * Math.exp(nu);
  const raw = (mu / (mu * nu - nu * nu)) * (fNu - fMu * (nu / mu) * (nu / mu) - ((mu * mu - nu * nu) / (mu * mu)) * Y0);
  return Math.max(0, raw); // Y₁ fiziksel olarak negatif olamaz — aşırı-gürültülü/saldırı-altı ölçümlerde formül negatif çıkabilir, 0'a kırpılır (GÜVENLİ taraf: "tek-foton payı yok" demek)
}

/**
 * e₁ üst-sınırı — bkz. DESIGN.md §4.2.
 * e₁^U = (E_ν Q_ν e^ν − Y₀·e₀) / (ν·Y₁^L)
 * Y₁^L=0 ise (yukarıdaki kırpmadan) e₁ tanımsızdır — bu durumda 0.5 (en
 * kötümser/güvenli varsayım, hiçbir bilgi yok) döndürülür.
 */
function estimateE1Upper({ Enu, Qnu, nu, Y0, e0, Y1Lower }) {
  if (Y1Lower <= 0) return 0.5;
  const fNu = Qnu * Math.exp(nu);
  const raw = (Enu * fNu - Y0 * e0) / (nu * Y1Lower);
  return Math.min(0.5, Math.max(0, raw)); // fiziksel hata oranı [0,0.5] aralığına kırpılır
}

/** İkili (Shannon) entropi — çekirdeğin QKDSecurityProof.h2 ile AYNI formül,
 * bilerek DUPLICATE edilmiştir: bu modülün matematiği `core` OLMADAN da test
 * edilebilsin diye (bkz. test dosyasındaki "core.QKDSecurityProof.h2 ile
 * bit-bit eşleşme" kontrolü — iki uygulamanın GERÇEKTEN aynı olduğu ORADA
 * doğrulanır, burada VARSAYILMAZ). */
function binaryEntropy(x) {
  if (x <= 0 || x >= 1) return 0;
  return -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
}

/**
 * Standalone GLLP asimptotik güvenli-anahtar-oranı — bkz. DESIGN.md §4.3.
 * Bu, ÇEKİRDEĞİ ÇAĞIRMAZ (referans/karşılaştırma amaçlı, core'suz test
 * edilebilir) — GERÇEK entegrasyon için bkz. applyDecoyCorrection.
 */
function secureKeyRateLowerBound({ Qmu, Emu, mu, Y1Lower, e1Upper, fEC = 1.16 }) {
  const q = 0.5;
  const Q1Lower = mu * Math.exp(-mu) * Y1Lower;
  const term1 = -Qmu * fEC * binaryEntropy(Emu);
  const term2 = Q1Lower * (1 - binaryEntropy(e1Upper));
  return { R: q * (term1 + term2), Q1Lower, term1: q * term1, term2: q * term2 };
}

/**
 * NAİF denetim — decoy DÜZELTMESİ OLMADAN, tüm sifted anahtarı (n, qBit)
 * tek-foton varsayımıyla (mevcut ProductionSecurityAudit.audit'in de
 * ZATEN yaptığı gibi) doğrudan çekirdeğe verir. Karşılaştırma için.
 */
function naiveSecurityAudit(core, { n, qBit }, opts = {}) {
  const epsPE = opts.epsPE != null ? opts.epsPE : 1e-10;
  const mu = core.QKDSecurityProof.statisticalFluctuation(n, epsPE);
  return core.QKDSecurityProof.secureKeyLengthWithMu(n, qBit, mu, opts);
}

/**
 * GERÇEK entegrasyon noktası — bkz. DESIGN.md §6. Decoy istatistiklerinden
 * (μ,ν yoğunluklarında ölçülen Q/E + vakum-ölçülen Y₀) tek-foton bileşenini
 * (n₁, e₁^U) kestirir ve bunları — `opts.realLeakEC`'in leakEC için yaptığı
 * gibi — çekirdeğin KENDİ `secureKeyLengthWithMu`'suna, TEORİK (n_toplam,
 * qBit_toplam) yerine GEÇİRİR. `core.QKDSecurityProof`'a TEK SATIR
 * DOKUNULMAZ — sadece dışarıdan doğru girdilerle ÇAĞRILIR.
 *
 * @param {object} core - require("./photonnet_core.js")
 * @param {{nTotal:number, mu:number, nu:number, muStats:{Q:number,E:number},
 *           nuStats:{Q:number,E:number}, vacuumStats:{Q:number}}} decoy
 */
function applyDecoyCorrection(core, decoy, opts = {}) {
  if (!core || !core.QKDSecurityProof || typeof core.QKDSecurityProof.secureKeyLengthWithMu !== "function") {
    throw new TypeError("applyDecoyCorrection: 'core' QKDSecurityProof.secureKeyLengthWithMu export etmeli.");
  }
  const { nTotal, mu, nu, muStats, nuStats, vacuumStats } = decoy;
  if (!(nTotal > 0)) throw new RangeError("applyDecoyCorrection: nTotal>0 olmalı.");
  const Y0 = vacuumStats.Q; // vakum darbesinde tek katkı karanlık-sayımdır (Y_0 = Q_0 tanım gereği)
  const e0 = opts.e0 != null ? opts.e0 : DEFAULTS.e0;

  const Y1Lower = estimateY1Lower({ Qmu: muStats.Q, Qnu: nuStats.Q, mu, nu, Y0 });
  const e1Upper = estimateE1Upper({ Enu: nuStats.E, Qnu: nuStats.Q, nu, Y0, e0, Y1Lower });

  const Q1Lower = mu * Math.exp(-mu) * Y1Lower;
  const n1Estimate = Math.round(nTotal * (muStats.Q > 0 ? Q1Lower / muStats.Q : 0));

  const epsPE = opts.epsPE != null ? opts.epsPE : 1e-10;
  const mu1 = core.QKDSecurityProof.statisticalFluctuation(Math.max(0, n1Estimate), epsPE);
  const proof = core.QKDSecurityProof.secureKeyLengthWithMu(n1Estimate, e1Upper, mu1, opts);

  return {
    decoyStats: { Y0, Y1Lower, e1Upper, Q1Lower, n1Estimate, nTotal },
    proof,
  };
}

module.exports = {
  DEFAULTS, PARAM_RANGES, validateParams,
  poissonPmf,
  channelYield, channelError,
  pnsWorstCaseYield, pnsWorstCaseError,
  theoreticalGainAndQber, simulateIntensity,
  estimateY1Lower, estimateE1Upper,
  binaryEntropy, secureKeyRateLowerBound,
  naiveSecurityAudit, applyDecoyCorrection,
};
