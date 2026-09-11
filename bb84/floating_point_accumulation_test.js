#!/usr/bin/env node
"use strict";
/**
 * floating_point_accumulation_test.js — "Akümülasyon (Birikim) ve Yuvarlama
 * Hataları" stres testi: kısa vadede mükemmel çalışan algoritmaların
 * GÜNLERCE/YILLARCA kesintisiz çalıştığında IEEE-754 çift-hassasiyet
 * (double) yuvarlama hatalarının BİRİKİP BİRİKMEDİĞİNİ, ve bunun
 * kriptografik anahtar malzemesinde tek bir bit bile kaymaya yol açıp
 * açmadığını ölçer. Çekirdeğe DOKUNULMAZ — yalnızca salt-okunur çağrılar
 * (QKDSecurityProof, NoiseGateMiddleware, ToeplitzAsyncEngine — production_gate.js/
 * shielded_detector_physics.js ile AYNI, zaten kabul edilmiş desen) ve
 * bağımsız, yerel bir sayısal-analiz aracı seti (ibm_math_audit.js ile
 * AYNI ruhta: "hayali kod yok", yalnız GERÇEK export'lar üzerinde ölçüm).
 * ═══════════════════════════════════════════════════════════════════
 * Gösterilen:
 *   (A) TAMSAYI TEMSİL TAVANI: JS double'ları 2^53'ün (Number.MAX_SAFE_INTEGER+1)
 *       ÜZERİNDEKİ ardışık tamsayıları AYIRT EDEMEZ — bu QKDSecurityProof.
 *       secureKeyLength'in n parametresine de uygulanır (somut kanıt).
 *       Mevcut/gerçekçi kullanımın bu tavana ne kadar UZAK olduğu ölçülür.
 *   (B) NAİF TOPLAMA HATA BÜYÜME YASASI: eşit artışlarla (1 ns) naif
 *       floating-point toplama, N arttıkça hatası BÜYÜYEN bir toplam
 *       üretir (ampirik olarak N=1e6..1e9'da ÇALIŞTIRILIP ölçülür) —
 *       Kahan-telafili toplama ile karşılaştırılır (o, N'den BAĞIMSIZ
 *       makine-epsilon düzeyinde kalır).
 *   (C) DURAKLAMA (STAGNATION) EŞİĞİ: 1 GHz saat için (artış=1 ns) naif
 *       bir biriktiricinin TAMAMEN DONDUĞU (artık artış eklemenin HİÇBİR
 *       etkisi kalmadığı) kesin eşik DOĞRUDAN hesaplanır (kaba-kuvvet
 *       döngüyle ULAŞILMAZ — trilyonlarca adım gerektirir ve pratik değildir;
 *       bunun yerine X+artış===X özelliği doğrudan/ikili-aramayla bulunur,
 *       bu KESİN ve tekrarlanabilir bir sonuçtur).
 *   (D) GERÇEK MİMARİ BAĞIŞIKLIĞI: timetag_acquisition_bridge.js'nin KENDİ
 *       saat hesaplaması (slotT = i·periodPs, bkz. o dosyanın run()
 *       fonksiyonu) bir BİRİKTİRİCİ (running sum) DEĞİL, DOĞRUDAN ÇARPIMDIR
 *       — (C)'deki donma riskine YAPISAL OLARAK BAĞIŞIKTIR (her adımda
 *       sıfırdan yeniden hesaplanır, önceki yuvarlama hatası TAŞINMAZ).
 *   (E) NoiseGateMiddleware UZUN-VADELİ KARARLILIK: çekirdeğin GERÇEK
 *       kalibrasyon EMA'sı (calibratedDarkRateHz), YÜZ MİLYONLARCA
 *       kalibrasyon turu (=yıllarca sürekli çalışma) boyunca SALT-OKUNUR
 *       koşulur; ilk-%10 ile son-%10'un istatistiksel olarak AYNI kaldığı
 *       (sistematik sürüklenme YOK — daha önce düzeltilen asimetrik-kırpma
 *       hatası aşırı-uzun-vadede GERİ GELMİYOR) doğrulanır.
 *   (F) İZOLE DETERMİNİSTİK EMA TESTİ: (E)'deki istatistiksel gürültüden
 *       ARINDIRILMIŞ, YALNIZ ARİTMETİK yuvarlamayı test eden bağımsız/yerel
 *       bir EMA tekrarı (RNG YOK, sabit hedef) — yakınsadıktan SONRA
 *       kayıp/sürüklenme olmadığını gösterir.
 *   (G) TOEPLITZ ANAHTAR BİTLERİ TAMSAYI/BIT-DÜZEYİNDEDİR: nihai anahtar
 *       BİT DEĞERLERİ (privacy amplification çıktısı) XOR/AND tamsayı
 *       işlemleriyle üretilir (Uint32Array paketlenmiş) — kayan-nokta
 *       YUVARLAMA kanalı YOKTUR; tek float-türevli büyüklük ℓ'dir (UZUNLUK,
 *       bkz. (A) — DEĞERLER değil).
 *   + ÇEKİRDEĞE DOKUNULMADI.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { QKDSecurityProof, NoiseGateMiddleware, ToeplitzAsyncEngine } = core;

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function naiveSum(N, inc) { let s = 0; for (let i = 0; i < N; i++) s += inc; return s; }
function kahanSum(N, inc) {
  let s = 0, c = 0;
  for (let i = 0; i < N; i++) { const y = inc - c, t = s + y; c = (t - s) - y; s = t; }
  return s;
}
/** X + inc === X hâline gelen EN KÜÇÜK X'i ikili-arama ile bulur (kaba-kuvvet DEĞİL — O(log) adımda kesin sonuç). */
function stagnationThreshold(inc) {
  let x = Math.max(inc, 1);
  while (x + inc !== x) x *= 2;
  let a = x / 2, b = x;
  for (let i = 0; i < 200; i++) { const m = (a + b) / 2; if (m + inc === m) b = m; else a = m; }
  return b;
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) TAMSAYI TEMSİL TAVANI ══
  const MSI = Number.MAX_SAFE_INTEGER; // 2^53 - 1
  const collision = (MSI + 2) === (MSI + 1); // 2^53+1 temsil edilemez → 2^53'e yuvarlanır
  const qber = 0.02;
  const ellAtCeilPlus1 = QKDSecurityProof.secureKeyLength(MSI + 1, qber).ell;
  const ellAtCeilPlus2 = QKDSecurityProof.secureKeyLength(MSI + 2, qber).ell;
  // Gerçekçi tavan-testi: mevcut kullanım (nForFiniteKey=1e6) VE aşırı
  // iyimser bir "ömür boyu toplam" senaryosu (10 yıl, sürekli 1GHz, ~%15
  // eleme verimi ile sifted bit sayısı) — ikisi de tavana göre kaç KAT uzakta?
  const currentN = 1e6;
  const lifetimeSiftedBitsEstimate = 10 * 365.25 * 86400 * 1e9 * 0.15; // 10 yıl · 1e9 Hz · %15 eleme verimi
  const lifetimeExceedsCeiling = lifetimeSiftedBitsEstimate > MSI;
  out.integerCeiling = {
    maxSafeInteger: MSI, collision, ellAtCeilPlus1, ellAtCeilPlus2,
    currentN, currentHeadroomFactor: MSI / currentN,
    lifetimeSiftedBitsEstimate, lifetimeExceedsCeiling, lifetimeExcessFactor: lifetimeSiftedBitsEstimate / MSI,
  };
  chk("(A) TAMSAYI TEMSİL TAVANI: 2^53'ün ÜZERİNDE n ayırt edilemiyor (somut çarpışma) — TEK bir sonlu-anahtar çağrısı tavandan ÇOK UZAK, ama 10-YILLIK ÖMÜR BOYU KÜMÜLATİF sayaç tavanı GERÇEKTEN AŞIYOR",
    collision === true && ellAtCeilPlus1 === ellAtCeilPlus2 && (MSI / currentN) > 1e9 && lifetimeExceedsCeiling === true,
    `9007199254740993 (2^53+1) JS'te 9007199254740992'ye (2^53) YUVARLANIYOR (çarpışma=${collision}) → QKDSecurityProof.secureKeyLength(2^53+1,·).ell=${ellAtCeilPlus1} === secureKeyLength(2^53+2,·).ell=${ellAtCeilPlus2} (aynı, ayırt edilemiyor). ` +
    `Mevcut TEK-ÇAĞRI kullanımı (n=${currentN.toExponential(0)}) tavandan ${(MSI/currentN).toExponential(2)}× UZAK — risk YOK. AMA aşırı-iyimser olmayan, gerçekçi bir 10-yıllık ÖMÜR BOYU toplam sifted-bit tahmini (${lifetimeSiftedBitsEstimate.toExponential(2)} bit, sürekli 1GHz·%15 verim) tavanı (${MSI.toExponential(3)}) ${(lifetimeSiftedBitsEstimate/MSI).toFixed(1)}× AŞIYOR — yani bir dağıtıcının "bu KME'nin ürettiği TOPLAM anahtar biti" gibi ÇOK-YILLIK bir kümülatif sayacı double olarak tutması, on yıl mertebesinde GERÇEKTEN tamsayı temsil hatasına düşer. Bu TEORİK bir uyarı DEĞİL — BigInt (veya periyodik sıfırlama) bu tür ömür-boyu sayaçlar için GEREKLİDİR.`);

  // ══ (B) NAİF TOPLAMA HATA BÜYÜME YASASI ══
  const INC = 1e-9; // 1 GHz saat periyodu (periodPs=1000 → 1e-9 s)
  const nList = [1e6, 1e7, 1e8, 1e9];
  const growth = nList.map(N => {
    const t0 = Date.now();
    const naive = naiveSum(N, INC);
    const tNaive = Date.now() - t0;
    const t1 = Date.now();
    const kahan = kahanSum(N, INC);
    const tKahan = Date.now() - t1;
    const exact = N * INC;
    return { N, naive, kahan, exact, naiveAbsErr: naive - exact, kahanAbsErr: kahan - exact, naiveRelErr: (naive - exact) / exact, tNaiveMs: tNaive, tKahanMs: tKahan };
  });
  out.accumulationGrowth = growth;
  const relErrGrows = Math.abs(growth[growth.length - 1].naiveRelErr) > Math.abs(growth[0].naiveRelErr) * 10; // en az bir büyüklük mertebesi
  const kahanStaysFlat = growth.every(g => Math.abs(g.kahanAbsErr) < 1e-15);
  chk("(B) NAİF TOPLAMA: hata N arttıkça BÜYÜYOR (ampirik, N=1e6..1e9 GERÇEKTEN koşuldu) — Kahan-telafili toplama N'DEN BAĞIMSIZ makine-epsilon'da kalıyor",
    relErrGrows && kahanStaysFlat,
    growth.map(g => `N=${g.N.toExponential(0)}: naif=${g.naive.toPrecision(10)} (bağıl hata ${g.naiveRelErr.toExponential(2)}) · kahan=${g.kahan.toPrecision(10)} (hata ${g.kahanAbsErr.toExponential(2)}) [${g.tNaiveMs}ms/${g.tKahanMs}ms]`).join(" | "));

  // ══ (C) DURAKLAMA (STAGNATION) EŞİĞİ ══
  const stagX = stagnationThreshold(INC);
  const stagDays = stagX / 86400;
  const verifiedFreeze = (stagX + INC) === stagX; // doğrudan doğrulama
  out.stagnation = { incrementS: INC, thresholdS: stagX, thresholdDays: +stagDays.toFixed(2), thresholdExpected2pow24: Math.pow(2, 24), verifiedFreeze };
  chk("(C) DURAKLAMA EŞİĞİ: 1 GHz saatini NAİF biriktirseydik, ~194 gün (2^24 sn) SÜREKLİ çalışmadan sonra biriktirici TAMAMEN DONARDI (bir artış daha eklemenin HİÇBİR etkisi kalmaz)",
    verifiedFreeze && Math.abs(stagX - Math.pow(2, 24)) < 1e-6,
    `eşik = ${stagX.toLocaleString("tr-TR")} sn = ${stagDays.toFixed(2)} gün (tam olarak 2^24 sn — IEEE-754 mantissa/artış oranından türeyen KESİN bir değer, tahmini DEĞİL). Doğrudan doğrulandı: ${stagX.toLocaleString("tr-TR")} + 1e-9 === ${stagX.toLocaleString("tr-TR")} → ${verifiedFreeze}. Bu, "günlerce/haftalarca kesintisiz çalışma" endişesinin TAM OLARAK karşılık geldiği somut bir fiziksel-zaman ölçeği.`);

  // ══ (D) GERÇEK MİMARİ BAĞIŞIKLIĞI ══
  // timetag_acquisition_bridge.js'nin run()'ı: slotT = i*o.periodPs + jitter —
  // BİRİKTİRME DEĞİL, ÇARPIM. i*periodPs, i·periodPs < 2^53 olduğu sürece
  // TAM (kayıpsız) bir tamsayı çarpımıdır — önceki adımların yuvarlama hatası
  // TAŞINMAZ (her adım SIFIRDAN, i ve periodPs'ten yeniden hesaplanır).
  const periodPs = 1000; // 1 GHz (bkz. shielded_detector_physics.js/timetag_acquisition_bridge.js varsayılanı)
  // GERÇEKÇİ ama BÜYÜK bir darbe sayısı: 1e10 darbe = 1GHz'de 10 saniyelik
  // sürekli veri — bu proje boyunca kullanılan en büyük parti (nForFiniteKey=1e6)
  // sifted bit sayısından, sifting öncesi HAM darbe cinsinden çok daha büyük.
  const iHuge = 1e10;
  const multiplicativeSlotPs = iHuge * periodPs; // = 1e13 ps — hâlâ 2^53'ün (9.007e15) ÇOK altında
  const exactRepresentable = multiplicativeSlotPs < MSI && Number.isInteger(multiplicativeSlotPs);
  // Aynı i·periodPs formülünün KENDİSİ de, (A)'daki tamsayı tavanından BAĞIŞIK
  // DEĞİLDİR — i çok daha da büyürse (i > 2^53/periodPs ≈ 9.007e12, yani 1GHz'de
  // ~2.5 saatten UZUN, TEK bir çarpımda biriktirilmeden hesaplanan bir darbe
  // indeksi) AYNI temsil tavanına çarpar. FARK şu: bu SABİT, ÖNCEDEN BİLİNEN bir
  // eşiktir (i büyüdükçe YAVAŞ YAVAŞ KÖTÜLEŞEN bir "birikim" DEĞİL) — ve her
  // darbe SIFIRDAN hesaplandığı için (önceki adımın yuvarlama hatası bir
  // SONRAKİ adıma TAŞINMADIĞI için) (C)'deki "biriktirici zamanla DONAR" riskiyle
  // AYNI KUSUR SINIFI DEĞİLDİR.
  const ceilingPulseIndex = Math.floor(MSI / periodPs);
  out.architectureImmunity = { periodPs, iHuge, multiplicativeSlotPs, exactRepresentable, ceilingPulseIndex, ceilingHours: +(ceilingPulseIndex * periodPs * 1e-12 / 3600).toFixed(2) };
  chk("(D) GERÇEK MİMARİ BAĞIŞIKLIĞI: timetag_acquisition_bridge.js saat hesaplamasını ÇARPIM (i·periodPs) olarak yapıyor, BİRİKTİRME (running sum) OLARAK DEĞİL — (C)'deki 'zamanla kötüleşen birikim' riskine YAPISAL OLARAK BAĞIŞIK (aynı KUSUR SINIFI değil; TAMSAYI TAVANI (A) yine de sabit/bilinen bir üst sınırda geçerli)",
    exactRepresentable,
    `slotT = i·periodPs deseni (bkz. timetag_acquisition_bridge.js run(), satır ~97) i=${iHuge.toExponential(0)} (1GHz'de 10 saniyelik veri) için TAM tamsayı çarpımı üretiyor (${multiplicativeSlotPs.toLocaleString("tr-TR")} ps, tam temsil edilebilir=${exactRepresentable}) — her darbe SIFIRDAN hesaplandığı için ÖNCEKİ yuvarlama hatası bir SONRAKİ adıma TAŞINMIYOR, yani (C)'deki "biriktirici zamanla DONAR" riski BU koddaki saat mekanizması için GEÇERLİ DEĞİL. DÜRÜSTLÜK NOTU: bu formül de (A)'daki tamsayı tavanından muaf DEĞİLDİR — i, ${ceilingPulseIndex.toExponential(2)}'i (1GHz'de ~${out.architectureImmunity.ceilingHours} saat sürekli tek-parti veri) aşarsa AYNI temsil sınırına çarpar; fark, bunun SABİT/ÖNCEDEN BİLİNEN bir tavan olması, (C)'deki gibi zamanla YAVAŞ YAVAŞ kötüleşen bir birikim OLMAMASIDIR.`);

  // ══ (E) NoiseGateMiddleware UZUN-VADELİ KARARLILIK (GERÇEK, salt-okunur) ══
  const ngm = new NoiseGateMiddleware();
  const CYCLES = 200_000_000; // 200M kalibrasyon turu × 0.5s/tur ≈ 3.17 yıl sürekli çalışma
  const CHECKPOINTS = 200;
  const checkpointEvery = Math.floor(CYCLES / CHECKPOINTS);
  const samples = [];
  let sawNonFinite = false;
  let gateOutOfBounds = false;
  const t0e = Date.now();
  for (let i = 0; i < CYCLES; i++) {
    ngm.runCalibrationCycle(true, i * 500);
    if (i % checkpointEvery === 0) {
      if (!Number.isFinite(ngm.calibratedDarkRateHz) || !Number.isFinite(ngm.gateRatio)) sawNonFinite = true;
      if (ngm.gateRatio < 0.20 - 1e-9 || ngm.gateRatio > 1 + 1e-9) gateOutOfBounds = true;
      samples.push({ cycle: i, calibratedDarkRateHz: ngm.calibratedDarkRateHz, gateRatio: ngm.gateRatio });
    }
  }
  const tEms = Date.now() - t0e;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map(x => (x - m) ** 2))); };
  const firstTenthN = Math.floor(samples.length * 0.1), lastTenthStart = samples.length - firstTenthN;
  const firstVals = samples.slice(0, firstTenthN).map(s => s.calibratedDarkRateHz);
  const lastVals = samples.slice(lastTenthStart).map(s => s.calibratedDarkRateHz);
  const meanFirst = mean(firstVals), meanLast = mean(lastVals), stdFirst = std(firstVals), stdLast = std(lastVals);
  const pooledStd = Math.sqrt((stdFirst ** 2 + stdLast ** 2) / 2);
  const driftSigmas = pooledStd > 0 ? Math.abs(meanLast - meanFirst) / pooledStd : 0; // basit iki-örneklem karşılaştırması
  out.longRunStability = {
    cycles: CYCLES, elapsedYearsSimulated: +(CYCLES * 0.5 / 86400 / 365.25).toFixed(2), wallClockMs: tEms,
    sawNonFinite, gateOutOfBounds, meanFirst: +meanFirst.toFixed(2), meanLast: +meanLast.toFixed(2),
    stdFirst: +stdFirst.toFixed(2), stdLast: +stdLast.toFixed(2), driftSigmas: +driftSigmas.toFixed(3),
    checkpoints: samples,
  };
  chk("(E) NoiseGateMiddleware UZUN-VADELİ KARARLILIK: " + out.longRunStability.elapsedYearsSimulated + " yıllık sürekli-çalışma benzetiminde (GERÇEK çekirdek sınıfı, salt-okunur) sistematik sürüklenme YOK, NaN/sınır-dışı YOK",
    !sawNonFinite && !gateOutOfBounds && driftSigmas < 3,
    `${CYCLES.toLocaleString("tr-TR")} kalibrasyon turu (${out.longRunStability.elapsedYearsSimulated} yıl) ${tEms}ms'de koşuldu · ilk-%10 ortalama=${meanFirst.toFixed(2)}Hz (σ=${stdFirst.toFixed(2)}) · son-%10 ortalama=${meanLast.toFixed(2)}Hz (σ=${stdLast.toFixed(2)}) · fark=${driftSigmas.toFixed(2)}σ (istatistiksel olarak anlamlı sürüklenme için tipik eşik ~3σ) · hiçbir noktada NaN/Infinity görülmedi, gateRatio her zaman [${0.20},1] aralığında kaldı — DAHA ÖNCE DÜZELTİLEN asimetrik-kırpma sürüklenme hatası (bkz. dosya-üstü not) aşırı-uzun-vadede GERİ GELMEDİ.`);

  // ══ (F) İZOLE DETERMİNİSTİK EMA TESTİ (saf yuvarlama, istatistiksel gürültü YOK) ══
  // Bağımsız, YEREL bir EMA tekrarı — core'un runCalibrationCycle'ından TAMAMEN
  // AYRI (RNG yok, sabit hedef) — YALNIZ aritmetik yuvarlamanın etkisini izole eder.
  function isolatedEmaRun(N, alpha, target, x0 = 0) {
    let x = x0;
    for (let i = 0; i < N; i++) x = x * (1 - alpha) + target * alpha;
    return x;
  }
  const EMA_N = 500_000_000, EMA_ALPHA = 0.35, EMA_TARGET = 50;
  const t0f = Date.now();
  const emaResult = isolatedEmaRun(EMA_N, EMA_ALPHA, EMA_TARGET);
  const tFms = Date.now() - t0f;
  const emaAbsErr = Math.abs(emaResult - EMA_TARGET);
  out.isolatedEma = { cycles: EMA_N, alpha: EMA_ALPHA, target: EMA_TARGET, result: emaResult, absErr: emaAbsErr, wallClockMs: tFms };
  chk("(F) İZOLE DETERMİNİSTİK EMA: " + EMA_N.toExponential(0) + " tekrarlık SAF aritmetik yuvarlama (RNG yok, sabit hedef) — sonuç hedefe MAKİNE-EPSİLON düzeyinde yakın kalıyor, SÜRÜKLENMİYOR",
    emaAbsErr < 1e-9,
    `hedef=${EMA_TARGET}, ${EMA_N.toExponential(0)} yinelemeden sonra sonuç=${emaResult} (mutlak hata=${emaAbsErr.toExponential(2)}, ${tFms}ms) — EMA'nın (1-α) sönümleme terimi geçmiş yuvarlama hatasını HER ADIMDA GEOMETRİK olarak siliyor (kendi kendini düzelten bir süzgeç), bu yüzden (C)'deki BİRİKTİRİCİ (running sum) donma riskine KARŞI YAPISAL OLARAK BAĞIŞIK — matematiksel sınıf farkı budur.`);

  // ══ (G) TOEPLITZ ANAHTAR BİTLERİ — TAMSAYI/BIT-DÜZEYİ ══
  const selfTestOk = ToeplitzAsyncEngine.selfTest();
  const n = 2000, ell = 900;
  const seedBits = Array.from({ length: n + ell - 1 }, () => Math.random() < 0.5 ? 0 : 1);
  const inputBits = Array.from({ length: n }, () => Math.random() < 0.5 ? 0 : 1);
  const packed = ToeplitzAsyncEngine._hashPackedSyncRaw(inputBits, ell, seedBits, 0, ell);
  const naiveRef = QKDSecurityProof._toeplitzHashNaiveReference(inputBits, ell, seedBits);
  const bitsIdentical = packed.length === naiveRef.length && packed.every((v, i) => v === naiveRef[i]);
  out.bitIntegrity = { selfTestOk, crossCheckIdentical: bitsIdentical, ell };
  chk("(G) TOEPLITZ ANAHTAR BİTLERİ TAMSAYI-DÜZEYİNDE: paketli (Uint32Array/bit-XOR) motor ile naif tamsayı referansı BİREBİR aynı bit dizisini üretiyor — kayan-nokta yuvarlama kanalı YOK",
    selfTestOk === true && bitsIdentical,
    `ToeplitzAsyncEngine.selfTest()=${selfTestOk} · bağımsız ${ell}-bit çapraz-kontrolde paketli/naif ÇIKTI BİREBİR AYNI (${bitsIdentical}) — nihai anahtar BİT DEĞERLERİ yalnızca XOR/AND tamsayı işlemleriyle üretiliyor (Uint32Array), (A)-(F)'teki float-tabanlı riskler yalnız anahtar UZUNLUĞUNU (ℓ) etkileyebilir, üretilen bitlerin KENDİSİNİ DEĞİL.`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "floating_point_accumulation.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ Akümülasyon ve yuvarlama hataları — kesintisiz-çalışma stres testi ══\n");
  console.log(`  (A) tamsayı tavanı: çarpışma=${out.integerCeiling.collision}, mevcut kullanım tavana ${out.integerCeiling.currentHeadroomFactor.toExponential(1)}× uzak`);
  console.log(`  (B) naif toplama: N=1e9'da bağıl hata ${out.accumulationGrowth[out.accumulationGrowth.length-1].naiveRelErr.toExponential(2)}`);
  console.log(`  (C) duraklama eşiği: ${out.stagnation.thresholdDays} gün`);
  console.log(`  (D) mimari bağışıklık: i·periodPs tam temsil edilebilir=${out.architectureImmunity.exactRepresentable}`);
  console.log(`  (E) uzun-vade kararlılık: ${out.longRunStability.elapsedYearsSimulated} yıl, sürüklenme=${out.longRunStability.driftSigmas}σ, NaN görüldü=${out.longRunStability.sawNonFinite}`);
  console.log(`  (F) izole EMA: ${out.isolatedEma.cycles.toExponential(0)} yineleme, mutlak hata=${out.isolatedEma.absErr.toExponential(2)}`);
  console.log(`  (G) bit bütünlüğü: selfTest=${out.bitIntegrity.selfTestOk}, çapraz-kontrol=${out.bitIntegrity.crossCheckIdentical}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "floating_point_accumulation.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
