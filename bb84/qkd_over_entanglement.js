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


// ══════════════════════════════════════════════════════════
// E91 — CHSH BELL TESTİ
// BBM92 güvenliğini QBER'e dayandırır. E91'in AYIRT EDİCİ parçası ise
// güvenliği bir BELL EŞİTSİZLİĞİ İHLALİNE dayandırmasıdır: S > 2 ise
// korelasyonlar hiçbir yerel-gizli-değişken modeliyle açıklanamaz,
// dolayısıyla dinleyicinin önceden hazırlanmış bir kopyası olamaz.
//
// Bell-diyagonal durumun korelasyon matrisi (|Φ+> referansına göre):
//   T_xx =  I + X − Y − Z
//   T_yy = −(I − X + Y − Z)
//   T_zz =  I − X − Y + Z
// (|Φ+> için T = diag(1, −1, 1) — doğrulama selfCheck'te.)
//
// x–z düzleminde θ yönünde ölçüm için korelasyon:
//   E(θa, θb) = T_xx·sinθa·sinθb + T_zz·cosθa·cosθb
//
// E91 standart ayarları (ölçüm-yönü açıları):
//   Alice: A1=0°, A2=45°, A3=90°   ·   Bob: B1=45°, B2=90°, B3=135°
//   ANAHTAR: eşleşen yönler (A2,B1)=45° ve (A3,B2)=90°
//   CHSH  : (A1,B1), (A1,B3), (A3,B1), (A3,B3)
//   S = E(A1,B1) − E(A1,B3) + E(A3,B1) + E(A3,B3)
// ══════════════════════════════════════════════════════════
const DEG = Math.PI / 180;
const E91_ALICE = [0, 45, 90];
const E91_BOB = [45, 90, 135];

function correlationMatrix(s) {
  return {
    xx: s.I + s.X - s.Y - s.Z,
    yy: -(s.I - s.X + s.Y - s.Z),
    zz: s.I - s.X - s.Y + s.Z,
  };
}
/** İki ölçüm yönü arasındaki korelasyon E ∈ [−1, 1]. */
function correlation(s, degA, degB) {
  const T = correlationMatrix(s);
  const a = degA * DEG, b = degB * DEG;
  return T.xx * Math.sin(a) * Math.sin(b) + T.zz * Math.cos(a) * Math.cos(b);
}
/** Standart E91 açılarıyla CHSH değeri (analitik). */
function chshStandard(s) {
  return correlation(s, 0, 45) - correlation(s, 0, 135) + correlation(s, 90, 45) + correlation(s, 90, 135);
}
/** Horodecki kriteriyle EN İYİ açılardaki maksimum CHSH: 2√(t₁²+t₂²). */
function chshOptimal(s) {
  const T = correlationMatrix(s);
  const t = [Math.abs(T.xx), Math.abs(T.yy), Math.abs(T.zz)].sort((x, y) => y - x);
  return 2 * Math.sqrt(t[0] * t[0] + t[1] * t[1]);
}

/**
 * E91 akışı: her çift için Alice ve Bob BAĞIMSIZ olarak 3'er ayardan
 * birini seçer. Eşleşen yönler ANAHTARA, CHSH dörtlüsüne düşenler BELL
 * TESTİNE gider, kalanlar atılır. Ölçüm GERÇEKTEN simüle edilir
 * (korelasyondan olasılık türetilip zar atılır) — S formülden
 * OKUNMAZ, sayımlardan HESAPLANIR.
 */
function runE91Flow(pairs, opts = {}) {
  const {
    seed = 0x1E91C0DE,
    testFraction = 0.25,
    message = "PhotonNet E91 — Bell eşitsizliği ihlaliyle doğrulanmış anahtar.",
    epsPE = 1e-10, epsCor = 1e-15, epsPA = 1e-10,
  } = opts;
  const rng = mulberry32(seed >>> 0);

  const keyA = [], keyB = [];
  // CHSH sayaçları: dört ayar çifti için ++/+-/-+/-- sayımları
  const chshPairs = [[0, 45], [0, 135], [90, 45], [90, 135]];
  const counts = chshPairs.map(() => ({ pp: 0, pm: 0, mp: 0, mm: 0 }));
  let keyRounds = 0, chshRounds = 0, discarded = 0;

  for (const p of pairs) {
    const s = p.state;
    const ai = Math.floor(rng() * 3), bi = Math.floor(rng() * 3);
    const da = E91_ALICE[ai], db = E91_BOB[bi];
    const E = correlation(s, da, db);
    // Marjinaller maksimum karışık (Bell-diyagonal) → her sonuç eşit olasılıklı;
    // korelasyon yalnızca AYNI/FARKLI olma olasılığını belirler.
    const same = rng() < (1 + E) / 2;
    const a = rng() < 0.5 ? 1 : 0;
    const b = same ? a : a ^ 1;

    if (da === db) {                    // eşleşen yön → anahtar
      keyA.push(a); keyB.push(b); keyRounds++;
      continue;
    }
    const ci = chshPairs.findIndex(([x, y]) => x === da && y === db);
    if (ci >= 0) {                      // CHSH dörtlüsü → Bell testi
      const sa = a ? 1 : -1, sb = b ? 1 : -1;
      const c = counts[ci];
      if (sa > 0 && sb > 0) c.pp++; else if (sa > 0) c.pm++; else if (sb > 0) c.mp++; else c.mm++;
      chshRounds++;
      continue;
    }
    discarded++;
  }

  // ── CHSH: SAYIMLARDAN hesapla (formülden değil) ──
  const Emeas = counts.map(c => {
    const n = c.pp + c.pm + c.mp + c.mm;
    return n ? (c.pp + c.mm - c.pm - c.mp) / n : 0;
  });
  const S = Emeas[0] - Emeas[1] + Emeas[2] + Emeas[3];
  const meanState = pairs.length ? pairs.reduce((acc, p) => ({
    I: acc.I + p.state.I / pairs.length, X: acc.X + p.state.X / pairs.length,
    Y: acc.Y + p.state.Y / pairs.length, Z: acc.Z + p.state.Z / pairs.length,
  }), { I: 0, X: 0, Y: 0, Z: 0 }) : null;
  // ── S'nin İSTATİSTİKSEL HATA PAYI ──
  // Her E_i, n_i turdan ölçülür; Var(E_i) = (1 − E_i²)/n_i. S dört
  // BAĞIMSIZ korelatörün toplamı olduğu için varyanslar toplanır.
  // Bu OLMADAN "S ≤ 2, ihlal yok" demek YANILTICIDIR: küçük örneklemde
  // gerçek ihlal de gürültüye gömülür. (İlk koşumda 115 turluk taban
  // yapılandırma S=1.98 verdi — analitik 2.44 iken; fark tamamen
  // örneklem büyüklüğündendi.)
  let varS = 0;
  counts.forEach((c, i) => {
    const n = c.pp + c.pm + c.mp + c.mm;
    if (n > 0) varS += (1 - Emeas[i] * Emeas[i]) / n;
  });
  const seS = Math.sqrt(varS);
  const sigma = seS > 0 ? (S - 2) / seS : 0;

  const bell = {
    S: +S.toFixed(5),
    standardError: +seS.toFixed(5),
    sigmaAboveClassical: +sigma.toFixed(3),
    significantViolation: sigma >= 3,
    SanalyticStandard: meanState ? +chshStandard(meanState).toFixed(5) : null,
    SanalyticOptimal: meanState ? +chshOptimal(meanState).toFixed(5) : null,
    tsirelson: +(2 * Math.SQRT2).toFixed(5),
    classicalBound: 2,
    violated: S > 2,
    // Anlamlı ihlal = S, klasik sınırın en az 3σ ÜSTÜNDE.
    chshRounds,
    chshRoundsNeededFor3Sigma: meanState ? chshRoundsForSignificance(chshStandard(meanState), 3) : null,
    perSettingCorrelations: Emeas.map(e => +e.toFixed(5)),
  };

  if (keyA.length < 4) {
    return { ok: false, stage: "e91-sifting", protocol: "E91",
      bell, rounds: { keyRounds, chshRounds, discarded, total: pairs.length },
      reason: "eşleşen-ayar anahtarı çok kısa" };
  }
  if (!bell.significantViolation) {
    const why = bell.violated
      ? `S=${bell.S} > 2 ama yalnızca ${bell.sigmaAboveClassical}σ — ${chshRounds} CHSH turu istatistiksel olarak YETERSİZ (≥3σ gerekli)`
      : `S=${bell.S} ≤ 2, ihlal yok (±${bell.standardError}, ${chshRounds} tur)`;
    return { ok: false, stage: "bell-test", protocol: "E91", bell,
      rounds: { keyRounds, chshRounds, discarded, total: pairs.length },
      verdict: `ABORT — Bell testi geçilemedi: ${why}. E91'de güvenlik ihlalin İSTATİSTİKSEL OLARAK KANITLANMASINA dayanır.` };
  }

  // ── Bundan sonrası BBM92 ile AYNI klasik son-işlem hattı ──
  const idx = Array.from({ length: keyA.length }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const kCount = Math.max(1, Math.floor(keyA.length * testFraction));
  const testIdx = idx.slice(0, kCount), keyIdx = idx.slice(kCount);
  const n = keyIdx.length, k = testIdx.length;
  let testErrors = 0;
  for (const i of testIdx) if (keyA[i] !== keyB[i]) testErrors++;
  const qberEst = k ? testErrors / k : null;

  const aKey = keyIdx.map(i => keyA[i]), bKey = keyIdx.map(i => keyB[i]);
  const rec = CascadeReconciliation.reconcile(aKey, bKey, Math.max(qberEst ?? 0, 1e-4), rng);
  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
  const proof = QKDSecurityProof.secureKeyLengthWithMu(n, qberEst, mu, { epsCor, epsPA, realLeakEC: rec.leakedBits });

  const base = {
    protocol: "E91", bell,
    rounds: { keyRounds, chshRounds, discarded, total: pairs.length,
      keyFraction: +(keyRounds / pairs.length).toFixed(4),
      chshFraction: +(chshRounds / pairs.length).toFixed(4) },
    sampling: { n, k, testErrors, qberEst: qberEst == null ? null : +qberEst.toFixed(6) },
    errorCorrection: { leakedBits: rec.leakedBits, residualErrors: rec.residualErrors, converged: rec.converged },
    security: { mu: +mu.toFixed(6), ell: proof.ell, secure: proof.secure, reason: proof.reason ?? null },
  };
  if (!proof.secure || proof.ell <= 0) {
    return { ok: false, stage: "finite-key", ...base,
      verdict: `ABORT — Bell ihlali İSTATİSTİKSEL OLARAK KANITLANDI (S=${bell.S} ± ${bell.standardError}, ${bell.sigmaAboveClassical}σ) ama blok boyutu (n=${n}) sonlu-anahtar sınırı için yetersiz. İki AYRI güvenlik koşulu; Bell testini geçmek tek başına yetmez.` };
  }

  const PA_SEED = (seed ^ 0xA5A5A5A5) >>> 0;
  const aFinal = privacyAmplify(aKey, proof.ell, mulberry32(PA_SEED));
  const bFinal = privacyAmplify(rec.correctedBobBits, proof.ell, mulberry32(PA_SEED));
  const keysMatch = aFinal.length === bFinal.length && aFinal.every((x, i) => x === bFinal[i]);
  const msgBits = utf8ToBits(message);
  const cipher = otpEncryptBits(msgBits, aFinal);
  const decoded = bitsToUtf8(otpDecryptBits(cipher, bFinal));

  return {
    ok: keysMatch && decoded === message && aFinal.length >= msgBits.length,
    stage: "complete", ...base,
    privacyAmplification: { inputBits: n, outputBits: proof.ell, aliceBobKeysIdentical: keysMatch },
    dataFlow: {
      messageBits: msgBits.length, keyBitsAvailable: aFinal.length,
      keySufficientForOtp: aFinal.length >= msgBits.length,
      cipherDiffersFromPlaintext: cipher.some((b, i) => b !== msgBits[i]),
      decryptedCorrectly: decoded === message,
      decodedPreview: decoded.slice(0, 60),
    },
    verdict: `BAŞARILI — CHSH S=${bell.S} ± ${bell.standardError} (klasik sınırın ${bell.sigmaAboveClassical}σ üstünde) VE ℓ=${proof.ell} bit güvenli anahtar üretildi.`,
  };
}


/**
 * Belirli bir beklenen S için, ihlali `nSigma` anlamlılıkla KANITLAMAK
 * üzere gereken CHSH turu sayısı (analitik).
 *   SE(S) ≈ 4·√((1−Ē²)/N),  Ē ≈ S/4   ⟹   N ≥ nσ²·16·(1−Ē²)/(S−2)²
 * Bu, "kaç tur yeterli" sorusunu TAHMİN ETMEK yerine TÜRETİR — sabit bir
 * eşik (ör. "200 tur yeter") yanlış olurdu, çünkü gereken tur sayısı
 * ihlalin BÜYÜKLÜĞÜNE kuvvetle bağlıdır (S→2 iken karesel patlar).
 */
function chshRoundsForSignificance(expectedS, nSigma = 3) {
  if (!(expectedS > 2)) return Infinity;
  const Ebar = expectedS / 4;
  return Math.ceil((nSigma * nSigma * 16 * (1 - Ebar * Ebar)) / Math.pow(expectedS - 2, 2));
}

/** Cebirsel iddiaların sayısal doğrulaması. */
function selfCheckE91() {
  const near = (a, b, t = 1e-9) => Math.abs(a - b) < t;
  const out = [];
  const phiPlus = { I: 1, X: 0, Y: 0, Z: 0 };
  const T = correlationMatrix(phiPlus);
  out.push({ name: "|Φ+> korelasyon matrisi = diag(1, −1, 1)", ok: near(T.xx, 1) && near(T.yy, -1) && near(T.zz, 1), got: `(${T.xx}, ${T.yy}, ${T.zz})` });
  out.push({ name: "|Φ+> standart CHSH = Tsirelson sınırı 2√2", ok: near(chshStandard(phiPlus), 2 * Math.SQRT2), got: chshStandard(phiPlus).toFixed(6), want: (2 * Math.SQRT2).toFixed(6) });
  out.push({ name: "|Φ+> optimal CHSH = 2√2", ok: near(chshOptimal(phiPlus), 2 * Math.SQRT2), got: chshOptimal(phiPlus).toFixed(6) });
  // Saf faz gürültüsü: standart açılarla S = 2√2·F
  for (const F of [0.95, 0.85, 0.75]) {
    const st = { I: F, X: 0, Y: 0, Z: 1 - F };
    out.push({ name: `Saf faz F=${F}: standart CHSH = 2√2·F`, ok: near(chshStandard(st), 2 * Math.SQRT2 * F, 1e-9), got: chshStandard(st).toFixed(6), want: (2 * Math.SQRT2 * F).toFixed(6) });
  }
  // Z bazında (0°,0°) saf fazda korelasyon TAM olmalı → QBER 0
  const st85 = { I: 0.85, X: 0, Y: 0, Z: 0.15 };
  out.push({ name: "Saf fazda Z bazı korelasyonu tam (QBER_Z = 0)", ok: near(correlation(st85, 0, 0), 1), got: correlation(st85, 0, 0).toFixed(6) });
  out.push({ name: "Saf fazda X bazı korelasyonu = 2F−1", ok: near(correlation(st85, 90, 90), 2 * 0.85 - 1), got: correlation(st85, 90, 90).toFixed(6) });
  // Ayrılabilir (F=0.5) durumda ihlal YOK
  const sep = { I: 0.5, X: 0, Y: 0, Z: 0.5 };
  out.push({ name: "F=0.5'te standart CHSH ≤ 2 (ihlal yok)", ok: chshStandard(sep) <= 2 + 1e-12, got: chshStandard(sep).toFixed(6) });
  return out;
}

module.exports = {
  measureBBM92, privacyAmplify, runQkdFlow, utf8ToBits, bitsToUtf8,
  correlationMatrix, correlation, chshStandard, chshOptimal, runE91Flow, selfCheckE91,
  chshRoundsForSignificance,
  E91_ALICE, E91_BOB,
};
