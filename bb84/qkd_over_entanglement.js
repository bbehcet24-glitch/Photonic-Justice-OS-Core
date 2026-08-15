#!/usr/bin/env node
"use strict";
/**
 * qkd_over_entanglement.js
 * ═══════════════════════════════════════════════════════════════════
 * ÜST KATMAN: dolanıklık motorunun ürettiği yüksek sadakatli A-B Bell
 * çiftlerini TÜKETEREK gerçek bir QKD güvenli veri akışı kurar.
 *
 * PROTOKOL: BBM92 (dolanıklık-tabanlı BB84). Her çift için Alice ve Bob
 * BAĞIMSIZ olarak Z ya da X bazı seçer; bazlar uyuşursa bit elenmiş
 * (sifted) anahtara girer.
 *
 * HATA MODELİ — DOĞRUDAN BELL DURUMUNDAN TÜRETİLİR (uydurma QBER YOK):
 *   |Φ+> referansına göre Pauli hata olasılıkları (I, X, Y, Z) için
 *     • Z bazında ölçüm: sonuçlar X veya Y hatası varsa ters düşer
 *         QBER_Z = X + Y
 *     • X bazında ölçüm: Z veya Y hatası varsa ters düşer
 *         QBER_X = Z + Y
 *   Bizim gürültümüz SAF faz (Z) olduğundan QBER_Z ≈ 0, QBER_X ≈ Z —
 *   yani QBER BAZA GÖRE ASİMETRİKTİR. Bu, gerçek faz-baskın sistemlerde
 *   gözlenen ve güvenlik analizinde ÖNEMLİ olan bir olgudur; tek bir
 *   ortalama QBER'e düzleştirmek bilgi kaybı olurdu, o yüzden ikisi de
 *   ayrı ayrı ölçülür ve raporlanır.
 *
 * ÇEKİRDEK YENİDEN KULLANIMI (yeniden yazılmadı):
 *   • CascadeReconciliation.reconcile — GERÇEK hata düzeltme, ÖLÇÜLEN
 *     klasik sızıntı (leakedBits) ile
 *   • QKDSecurityProof.statisticalFluctuation2 — iki-parametreli Serfling
 *   • QKDSecurityProof.secureKeyLengthWithMu — sonlu-anahtar ℓ, gerçek
 *     leak_EC ile (teorik tahmin DEĞİL)
 *   • toeplitzPackBits / toeplitzRowsFromPackedWords — gizlilik yükseltme
 *     (2-evrensel Toeplitz özütleyici)
 *   • otpEncryptBits / otpDecryptBits / t2b / b2t — OTP veri akışı
 *
 * DÜRÜSTLÜK NOTU: ℓ ≤ 0 (abort) SONLU-ANAHTAR QKD'DE NORMAL VE BEKLENEN
 * bir sonuçtur — özellikle küçük bloklarda. Bu modül, blok küçükken
 * aborttan KAÇMAZ; tersine, kaç çiftin gerektiğini ölçerek gösterir.
 * ═══════════════════════════════════════════════════════════════════
 */
const core = require("./photonnet_core.js");
const {
  mulberry32, CascadeReconciliation, QKDSecurityProof,
  toeplitzPackBits, toeplitzRowsFromPackedWords,
  otpEncryptBits, otpDecryptBits,
} = core;

/**
 * Bell çiftlerini ölç → elenmiş (sifted) ham anahtar.
 * @param {Array<{state:{I,X,Y,Z}}>} pairs
 */
function measureBBM92(pairs, rng) {
  const aliceBits = [], bobBits = [], bases = [];
  let zUsed = 0, xUsed = 0, zErr = 0, xErr = 0, discardedBasisMismatch = 0;
  for (const p of pairs) {
    const s = p.state;
    const aBasis = rng() < 0.5 ? "Z" : "X";
    const bBasis = rng() < 0.5 ? "Z" : "X";
    if (aBasis !== bBasis) { discardedBasisMismatch++; continue; }  // eleme (sifting)
    const pErr = aBasis === "Z" ? (s.X + s.Y) : (s.Z + s.Y);
    const a = rng() < 0.5 ? 1 : 0;
    const isErr = rng() < pErr;
    aliceBits.push(a);
    bobBits.push(isErr ? a ^ 1 : a);
    bases.push(aBasis);
    if (aBasis === "Z") { zUsed++; if (isErr) zErr++; } else { xUsed++; if (isErr) xErr++; }
  }
  return {
    aliceBits, bobBits, bases,
    siftedCount: aliceBits.length,
    discardedBasisMismatch,
    zBasis: { used: zUsed, errors: zErr, qber: zUsed ? zErr / zUsed : null },
    xBasis: { used: xUsed, errors: xErr, qber: xUsed ? xErr / xUsed : null },
  };
}

// ── UTF-8 GÜVENLİ BİT DÖNÜŞÜMÜ ──
// Çekirdeğin t2b/b2t fonksiyonları 8-BİTLİK'tir (charCodeAt & 0xFF) ve
// ayrıca b2t sıfır baytları ATAR. Türkçe metinde "ı" (U+0131) ve "—"
// (U+2014) gibi karakterler kod noktası 255'i AŞTIĞI için t2b onları
// KESER — bu, ilk koşumda şifre çözmenin bozuk çıkmasına yol açtı
// (hata QKD'de DEĞİL, metin kodlamasındaydı). Burada UTF-8 bayt
// dizisi üzerinden kayıpsız dönüşüm yapılır; çekirdek dosyaya
// DOKUNULMAZ (t2b/b2t'nin kendi çağrı yerlerinde davranışı korunur).
function utf8ToBits(text) {
  const bytes = Buffer.from(text, "utf8");
  const bits = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  return bits;
}
function bitsToUtf8(bits) {
  const len = Math.floor(bits.length / 8);
  const bytes = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    bytes[i] = v;
  }
  return bytes.toString("utf8");
}

/** Gizlilik yükseltme — 2-evrensel Toeplitz özütleyici (çekirdek fonksiyonlarıyla). */
function privacyAmplify(bits, outLen, seedRng) {
  if (outLen <= 0) return [];
  const n = bits.length;
  // Toeplitz satırı `row`, seed dizisinin [row, row+n) penceresidir; bu
  // yüzden seed n+outLen-1 bit uzunluğunda ve KAMUYA AÇIK rastgeleliktir.
  const seedBits = new Array(n + outLen - 1);
  for (let i = 0; i < seedBits.length; i++) seedBits[i] = seedRng() < 0.5 ? 1 : 0;
  // Çekirdeğin sözleşmesi: girdi TERS çevrilmiş olarak paketlenir.
  const rev = new Array(n);
  for (let i = 0; i < n; i++) rev[i] = bits[n - 1 - i];
  const revWords = toeplitzPackBits(rev, 0, n);
  const seedWords = toeplitzPackBits(seedBits, 0, seedBits.length);
  const out = toeplitzRowsFromPackedWords(revWords, n, seedWords, outLen);
  return Array.from(out);
}

/**
 * Uçtan uca QKD akışı: ölçüm → eleme → parametre tahmini → hata düzeltme
 * → sonlu-anahtar kanıtı → gizlilik yükseltme → OTP veri akışı.
 */
function runQkdFlow(pairs, opts = {}) {
  const {
    seed = 0x51D3C0DE,
    testFraction = 0.25,       // parametre tahmini (PE) için ayrılan pay
    message = "PhotonNet — dolanıklık takasıyla üretilen anahtarla korunan gerçek veri akışı.",
    epsPE = 1e-10, epsCor = 1e-15, epsPA = 1e-10,
  } = opts;
  const rng = mulberry32(seed >>> 0);

  // ── 1) Ölçüm + eleme ──
  const m = measureBBM92(pairs, rng);
  if (m.siftedCount < 4) {
    return { ok: false, stage: "sifting", reason: "elenmiş anahtar çok kısa", measurement: m };
  }

  // ── 2) Anahtar / test örneklemi ayrımı (rastgele, çakışmasız) ──
  const idx = Array.from({ length: m.siftedCount }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const kCount = Math.max(1, Math.floor(m.siftedCount * testFraction));
  const testIdx = idx.slice(0, kCount), keyIdx = idx.slice(kCount);
  const n = keyIdx.length, k = testIdx.length;

  // ── 3) Parametre tahmini — QBER TEST ÖRNEKLEMİNDEN SAYILARAK ──
  let testErrors = 0;
  for (const i of testIdx) if (m.aliceBits[i] !== m.bobBits[i]) testErrors++;
  const qberEst = k ? testErrors / k : null;

  // ── 4) GERÇEK hata düzeltme (Cascade) — ölçülen sızıntı ──
  const aliceKey = keyIdx.map(i => m.aliceBits[i]);
  const bobKey = keyIdx.map(i => m.bobBits[i]);
  const rec = CascadeReconciliation.reconcile(aliceKey, bobKey, Math.max(qberEst ?? 0, 1e-4), rng);

  // ── 5) Sonlu-anahtar güvenlik kanıtı (gerçek leak_EC ile) ──
  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
  const proof = QKDSecurityProof.secureKeyLengthWithMu(n, qberEst, mu, {
    epsCor, epsPA, realLeakEC: rec.leakedBits,
  });

  const base = {
    measurement: {
      consumedPairs: pairs.length,
      siftedCount: m.siftedCount,
      discardedBasisMismatch: m.discardedBasisMismatch,
      siftingRate: +(m.siftedCount / pairs.length).toFixed(4),
      zBasis: m.zBasis, xBasis: m.xBasis,
    },
    sampling: { n, k, testFraction, testErrors, qberEst: qberEst == null ? null : +qberEst.toFixed(6) },
    errorCorrection: {
      leakedBits: rec.leakedBits, residualErrors: rec.residualErrors,
      converged: rec.converged,
      leakPerBit: n ? +(rec.leakedBits / n).toFixed(4) : null,
    },
    security: { mu: +mu.toFixed(6), ell: proof.ell, secure: proof.secure, reason: proof.reason ?? null },
  };

  if (!proof.secure || proof.ell <= 0) {
    return { ok: false, stage: "finite-key", ...base,
      verdict: `ABORT — bu blok boyutunda (n=${n}, k=${k}) sonlu-anahtar sınırı güvenli anahtar VERMİYOR. Bu bir HATA DEĞİL, sonlu-anahtar QKD'nin beklenen davranışıdır.` };
  }

  // ── 6) Gizlilik yükseltme (Toeplitz) ──
  // Toeplitz seed'i KAMUYA AÇIK rastgeleliktir: Alice ve Bob AYNI seed'i
  // kullanmak ZORUNDADIR, aksi hâlde farklı anahtarlar çıkarırlar. Bu
  // yüzden her iki taraf için aynı tohumdan BAĞIMSIZ ama ÖZDEŞ akışlar
  // türetilir.
  const correctedBob = rec.correctedBobBits;
  const PA_SEED = (seed ^ 0xA5A5A5A5) >>> 0;
  const aliceKeyFinal = privacyAmplify(aliceKey, proof.ell, mulberry32(PA_SEED));
  const bobKeyFinal = privacyAmplify(correctedBob, proof.ell, mulberry32(PA_SEED));

  const keysMatch = aliceKeyFinal.length === bobKeyFinal.length &&
    aliceKeyFinal.every((b, i) => b === bobKeyFinal[i]);

  // ── 7) OTP veri akışı (gerçek mesaj, gerçek şifreleme/çözme) ──
  const msgBits = utf8ToBits(message);
  const enoughKey = aliceKeyFinal.length >= msgBits.length;
  const cipher = otpEncryptBits(msgBits, aliceKeyFinal);
  const plainBits = otpDecryptBits(cipher, bobKeyFinal);
  const decoded = bitsToUtf8(plainBits);
  const cipherDiffers = cipher.some((b, i) => b !== msgBits[i]);

  return {
    ok: keysMatch && decoded === message && enoughKey,
    stage: "complete",
    ...base,
    privacyAmplification: {
      inputBits: n, outputBits: proof.ell,
      compressionRatio: +(proof.ell / n).toFixed(4),
      aliceBobKeysIdentical: keysMatch,
    },
    dataFlow: {
      messageChars: message.length, messageBits: msgBits.length,
      keyBitsAvailable: aliceKeyFinal.length,
      keySufficientForOtp: enoughKey,
      cipherDiffersFromPlaintext: cipherDiffers,
      decryptedCorrectly: decoded === message,
      decodedPreview: decoded.slice(0, 64),
    },
    verdict: keysMatch && decoded === message
      ? `BAŞARILI — ${pairs.length} dolanık çift tüketildi, ℓ=${proof.ell} bit bilgi-teorik güvenli anahtar üretildi ve mesaj OTP ile şifrelenip birebir çözüldü.`
      : "BAŞARISIZ — anahtarlar eşleşmedi veya çözme hatalı.",
  };
}

module.exports = { measureBBM92, privacyAmplify, runQkdFlow, utf8ToBits, bitsToUtf8 };
