#!/usr/bin/env node
"use strict";
/**
 * qber_abort_policy.js — QBER İPTAL POLİTİKASI (çekirdeğe dokunmayan katman)
 * ═══════════════════════════════════════════════════════════════════
 * SORUN (analizde bulundu, çekirdek DEĞİŞTİRİLEMEZ — SHA-256 sabit):
 *   1) Çekirdeğin mesaj yolu (QuantumKeyDistribution.deriveSiftedKey) QBER'i TÜM bitleri
 *      karşılaştırarak (kâhin) hesaplar ve QBER > %11'de yalnız BAYRAK kaldırır; anahtar
 *      yine kullanılır — İPTAL yoktur.
 *   2) %11, ideal hata düzeltme + sonsuz blok için BB84 eşiğidir. Gerçek eşik, blok boyuna
 *      ve EC verimine bağlı ℓ = 0 "uçurumudur": n = 10⁶, f = 1,16'da ≈ %9,5; mesaj boyunda
 *      (n ≈ 1600) ≈ %0,8. %11 bayrağı bu yüzden HER ZAMAN uçurumun ÜSTÜNDE kalır.
 *
 * BU KATMAN:
 *   • qberCliff(n, k) — çekirdeğin KENDİ sonlu-anahtar formülüyle (QKDSecurityProof.
 *     secureKeyLengthWithMu, Serfling iki-parametreli μ) ℓ = 0 olduğu QBER'i ikili aramayla bulur.
 *   • parameterEstimate() — kâhin yerine GERÇEK parametre kestirimi: rastgele bir test alt
 *     kümesi açıklanır (kurban edilir), QBER yalnız ondan tahmin edilir, anahtar kalan bitlerdir.
 *   • QberAbortPolicy.evaluateBlock() — ℓ ≤ 0 ya da QBER_test ≥ uçurum → ABORT (anahtar YOK).
 *   • guardSession(coreResult) — çekirdeğin deriveSiftedKey çıktısını bu politikadan geçirir.
 *   • gateEvidence() — production_gate.js kriter 5 için KANITLI öz-test (boolean beyan değil).
 *
 * DÜRÜSTLÜK: çekirdek ve UI (PhotonNet2.jsx) değişmedi; arayüzdeki mesaj başına gösterim hâlâ
 * eski bayrağı kullanır. Bu katman, anahtarı TÜKETEN yollar (KME, havuz, kapı) içindir. Sonuç
 * dürüstçe şudur: mesaj başına (n ≈ 10³) oturumlar sonlu-anahtar anlamında güvenli anahtar
 * ÜRETEMEZ; anahtar ≥ 10⁵ bitlik havuzlanmış bloklardan gelmelidir.
 * photonnet_core.js'i yalnız OKUR.
 */
const core = require("./photonnet_core.js");
const P = core.QKDSecurityProof;

const POLICY_DEFAULTS = Object.freeze({
  testFraction: 0.2, epsPE: 1e-10, epsCor: 1e-15, epsPA: 1e-10, fEC: 1.16,
  theoreticalThreshold: 0.11,   // BB84, ideal EC, n → ∞ — yalnız üst sınır olarak
});

/** ℓ(n, k, q) — çekirdeğin formülü (ham, tabana yuvarlanmamış). */
function ellRaw(n, k, q, o = POLICY_DEFAULTS) {
  const mu = P.statisticalFluctuation2(n, k, o.epsPE);
  return P.secureKeyLengthWithMu(n, q, mu, { epsCor: o.epsCor, epsPA: o.epsPA, fEC: o.fEC }).ellRaw;
}
/** ℓ = 0 uçurumu: ℓ > 0 olan en büyük QBER (ikili arama). Hiçbir QBER'de ℓ > 0 değilse 0. */
function qberCliff(n, k, o = POLICY_DEFAULTS) {
  if (!(n > 0) || !(k > 0)) return 0;
  if (!(ellRaw(n, k, 0, o) > 0)) return 0;
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (ellRaw(n, k, m, o) > 0) lo = m; else hi = m; }
  return lo;
}

/**
 * Kâhinsiz parametre kestirimi: rastgele (rng) k = round(testFraction·N) konum açıklanır.
 * @returns { k, n, testErrors, qberTest, keyIdx }  — keyIdx test konumlarını İÇERMEZ.
 */
function parameterEstimate(aliceBits, bobBits, { testFraction = POLICY_DEFAULTS.testFraction, rng = Math.random } = {}) {
  const N = Math.min(aliceBits.length, bobBits.length);
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const k = Math.min(N, Math.max(N > 0 ? 1 : 0, Math.round(testFraction * N)));
  const test = idx.slice(0, k), keyIdx = idx.slice(k).sort((a, b) => a - b);
  let e = 0; for (const i of test) if (aliceBits[i] !== bobBits[i]) e++;
  return { k, n: keyIdx.length, testErrors: e, qberTest: k ? e / k : NaN, keyIdx };
}

class QberAbortPolicy {
  constructor(o = {}) { this.o = { ...POLICY_DEFAULTS, ...o }; }
  /** Etkin iptal eşiği: min(%11, ℓ = 0 uçurumu). */
  threshold(n, k) { return Math.min(this.o.theoreticalThreshold, qberCliff(n, k, this.o)); }
  evaluateBlock({ n, k, qberTest }) {
    const cliff = qberCliff(n, k, this.o);
    const thr = Math.min(this.o.theoreticalThreshold, cliff);
    const ell = Number.isFinite(qberTest) ? Math.max(0, Math.floor(ellRaw(n, k, qberTest, this.o))) : 0;
    let decision = "PROCEED", reason = null;
    if (!Number.isFinite(qberTest)) { decision = "ABORT"; reason = "test örneklemi yok — QBER kestirilemedi"; }
    else if (cliff === 0) { decision = "ABORT"; reason = `blok çok küçük (n=${n}, k=${k}): hiçbir QBER'de ℓ > 0 değil`; }
    else if (qberTest >= thr) { decision = "ABORT"; reason = `QBER_test %${(100 * qberTest).toFixed(2)} ≥ etkin eşik %${(100 * thr).toFixed(2)} (ℓ = 0 uçurumu, n=${n}, k=${k})`; }
    else if (ell <= 0) { decision = "ABORT"; reason = "ℓ ≤ 0"; }
    return { decision, reason, n, k, qberTest, cliff, threshold: thr, ell };
  }
  /**
   * Çekirdek oturumunu politikadan geçirir. coreResult: deriveSiftedKey çıktısı.
   * ABORT'ta anahtar DÖNMEZ. Çekirdeğin kâhin QBER'i ve bayrağı yalnız KARŞILAŞTIRMA için döner.
   */
  guardSession(coreResult, { rng = Math.random } = {}) {
    const pe = parameterEstimate(coreResult.siftedKeyBits, coreResult.bobKeyBits, { testFraction: this.o.testFraction, rng });
    const ev = this.evaluateBlock({ n: pe.n, k: pe.k, qberTest: pe.qberTest });
    const out = { ...ev, coreOracleQber: coreResult.qber, coreFlag: !!coreResult.eavesdropDetected,
      coreWouldUseKey: !coreResult.eavesdropDetected, siftedBits: coreResult.siftedKeyBits.length };
    if (ev.decision === "PROCEED") { out.aliceKey = pe.keyIdx.map((i) => coreResult.siftedKeyBits[i]); out.bobKey = pe.keyIdx.map((i) => coreResult.bobKeyBits[i]); }
    return out;
  }
  /** production_gate.js kriter 5 için kanıt: eşik ≤ uçurum VE uçurumun iki yanında doğru karar. */
  gateEvidence({ n = 1e6, k = 2.5e5 } = {}) {
    const cliff = qberCliff(n, k, this.o), thr = this.threshold(n, k);
    const above = this.evaluateBlock({ n, k, qberTest: cliff + 0.002 });
    const below = this.evaluateBlock({ n, k, qberTest: Math.max(0, cliff - 0.01) });
    const eve = this.evaluateBlock({ n, k, qberTest: 0.25 });
    const verified = thr <= cliff + 1e-12 && above.decision === "ABORT" && below.decision === "PROCEED" && below.ell > 0 && eve.decision === "ABORT";
    return { source: "qber_abort_policy.js", n, k, thresholdQber: thr, cliffQber: cliff, theoreticalThreshold: this.o.theoreticalThreshold, verified,
      checks: { aboveCliff: above.decision, belowCliff: below.decision, intercept25: eve.decision } };
  }
}

module.exports = { POLICY_DEFAULTS, ellRaw, qberCliff, parameterEstimate, QberAbortPolicy };
