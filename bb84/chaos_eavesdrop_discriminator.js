"use strict";
// ══════════════════════════════════════════════════════════════
// YANLIŞ-ANLAMA (YANLIŞ EAVESDROP ALARMI) EŞİĞİNİN DÜZELTİLMESİ
//
// KAYNAK BULGU (bkz. chaos_stochastic_noise_test.js / commit a63e0b9):
// deriveSiftedKey içindeki SABİT eşik (`qber > 0.11`) yalnızca QBER'in
// SEVİYESİNE bakar, NEDENİNE bakmaz. Monte Carlo testinde şiddetli
// çevresel patlama (burst) gürültüsü — SALDIRGAN HİÇ YOKKEN — denemelerin
// %100'ünde bu eşiği aşıp "eavesdropDetected=true" üretti (bkz. rapor:
// bb84/reports/chaos_stochastic_noise_report.json, "burst_severe":
// QBER ort=%14.91, falseEavesdropRate=%100).
//
// KAPSAM/SINIR (KRİTİK — DÜRÜSTLÜK): bu dosya, deriveSiftedKey'in
// `qber > 0.11` bayrağını (çekirdekte, satır ~945) DEĞİŞTİRMEZ/EZMEZ VE
// EZMEMELİDİR. Gerçek BB84 güvenlik kanıtları (Shor-Preskill, GLLP,
// Renner) KASITLI OLARAK yüksek QBER'in NEDENİNİ (gerçek Eve mi, kanal
// gürültüsü mü) AYIRT ETMEZ — çünkü onu güvenilir şekilde ayırt etmenin
// hiçbir yolu YOKTUR (Eve, kendi saldırısını kanal gürültüsü gibi
// GÖSTERECEK şekilde optimize edebilir); bu yüzden güvenlik kanıtı HER
// İKİSİNİ DE aynı fail-closed matematikle (h2(qPhUpper) üzerinden azalan
// ℓ, gerekirse abort) ele alır. QKDSecurityProof'un bu davranışı
// KASITLIDIR ve DEĞİŞTİRİLMEMİŞTİR — "düzeltilen" şey GÜVENLİK KARARI
// DEĞİL, bir OPERATÖRE/teşhis katmanına sunulan YORUMDUR: "bu alarm,
// muhtemelen bir donanım/EMI olayı mı, yoksa gerçek bir dinleyicinin
// İMZASI mı?" — anahtar YİNE DE aynı şekilde reddedilir/kısalır; tek
// fark, operatörün "git donanımı kontrol et" ile "güvenlik ekibini
// ara" arasında doğru önceliklendirme yapabilmesidir.
//
// FİZİKSEL AYIRT EDİCİ SİNYAL (deriveSiftedKey'in kendi yorumlarından —
// DÜZELTME 7 — türetildi): gerçek intercept-resend saldırısında Eve HER
// fotonu BAĞIMSIZ/aynı-dağılımlı (IID) olarak ölçer — sifted küme
// üzerinde ~%25 hata, KANALDAKI KONUMDAN/ZAMANDAN TAMAMEN BAĞIMSIZ,
// DÜZGÜN YAYILMIŞ. Çevresel/donanım kaynaklı bir "anlık sıçrama" (EMI
// olayı, titreşim, lazer-modu-atlaması vb.) ise TANIM GEREĞİ ZAMANSAL
// OLARAK KÜMELENMİŞTİR — bir kısa pencerede yoğun hata, pencere dışında
// neredeyse hiç hata. Bu iki örüntü, sifted hata dizisinin KENDİSİ
// üzerinde bir Wald–Wolfowitz KOŞU (runs) testiyle AYIRT EDİLEBİLİR.
//
// AMPİRİK DOĞRULAMA (bkz. chaos_eavesdrop_discriminator_test.js):
//   • SADECE gerçek Eve (evesdrop=true, patlama yok): runsZ ort ≈ +0.05,
//     yalnızca %1-3'ü yanlışlıkla "kümelenmiş" işaretleniyor.
//   • SADECE şiddetli çevresel patlama (evesdrop=false): runsZ ort ≈
//     -5.26, denemelerin %100'ü doğru şekilde "kümelenmiş" işaretleniyor.
//   • KRİTİK GÜVENLİK KONTROLÜ — Eve + ÜSTÜNE şiddetli patlama BİRLİKTE:
//     runsZ ort ≈ -0.22, yalnızca %3'ü "kümelenmiş" — yani bir saldırganın
//     kendi saldırısını çevresel gürültünün ARDINA SAKLAMASI bu teşhis
//     katmanını YANILTAMIYOR (gerçek Eve'in İD katkısı domine ediyor).
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz — bu modül
// yalnızca deriveSiftedKey'in ZATEN döndürdüğü ÇIKTIYI (siftedKeyBits,
// bobKeyBits, qber, eavesdropDetected) girdi olarak alır.
// ══════════════════════════════════════════════════════════════

const CLUSTER_Z_THRESHOLD = -2; // standart normalde tek-yönlü ~%2.3 yanlış-pozitif oranı

/** Alice/Bob sifted bit çiftlerinden, konum-sıralı (zaman-sıralı) hata bayrağı dizisi. */
function computeErrorFlags(siftedKeyBits, bobKeyBits) {
  const n = Math.min(siftedKeyBits.length, bobKeyBits.length);
  const flags = new Array(n);
  for (let i = 0; i < n; i++) flags[i] = (siftedKeyBits[i] ^ bobKeyBits[i]) !== 0 ? 1 : 0;
  return flags;
}

/**
 * Wald–Wolfowitz koşu (runs) testi — ikili bir dizinin KÜMELENİP
 * kümelenmediğini (aynı değerin ardışık tekrarı, "runs" sayısının
 * İİD-beklenenden AZ olması) ölçer. z << 0 → güçlü kümelenme (burst-tipi);
 * z ≈ 0 → İİD (gerçek-Eve-tipi, konumdan bağımsız düzgün yayılım).
 */
function runsTest(flags) {
  const n = flags.length;
  const n1 = flags.reduce((a, b) => a + b, 0);
  const n0 = n - n1;
  if (n < 2 || n1 === 0 || n0 === 0) {
    // Hiç hata yok VEYA her şey hata — kümelenme tanımsız (dejenere durum).
    return { z: 0, runs: n > 0 ? 1 : 0, n0, n1, n, insufficientData: true };
  }
  let runs = 1;
  for (let i = 1; i < n; i++) if (flags[i] !== flags[i - 1]) runs++;
  const muR = 1 + (2 * n0 * n1) / n;
  const varR = (2 * n0 * n1 * (2 * n0 * n1 - n)) / (n * n * (n - 1));
  const z = varR > 0 ? (runs - muR) / Math.sqrt(varR) : 0;
  return { z, runs, n0, n1, n, insufficientData: false };
}

/**
 * PAYLAŞILAN VERDICT MANTIĞI — hem diagnoseAlarm (bit-dizisi girdili,
 * deriveSiftedKey'in TAM çıktısı) hem de diagnoseFromErrorFlags (hazır
 * hata-bayrağı dizisi girdili — bkz. client_network_report.js gibi
 * KENDİ yerel per-bit döngüsünü çalıştıran, bit DEĞERLERİNİ değil
 * yalnızca doğru/yanlış bayrağını tutan çağıranlar) TARAFINDAN kullanılır
 * — mantık TEK YERDE, tekrarsız.
 */
function buildVerdict(errFlags, qber, eavesdropDetected) {
  const runs = runsTest(errFlags);
  const clusteringDetected = !runs.insufficientData && runs.z < CLUSTER_Z_THRESHOLD;

  let verdict, verdictDetail;
  if (!eavesdropDetected) {
    verdict = "TEMİZ";
    verdictDetail = `QBER (%${(qber * 100).toFixed(2)}) eşiğin (>%11) altında — alarm yok.`;
  } else if (clusteringDetected) {
    verdict = "MUHTEMELEN_CEVRESEL_PATLAMA";
    verdictDetail =
      `QBER eşiği (>%11) AŞILDI (%${(qber * 100).toFixed(2)}) AMA hata dağılımı istatistiksel olarak ` +
      `KÜMELENMİŞ (koşu-testi z=${runs.z.toFixed(2)}, eşik ${CLUSTER_Z_THRESHOLD}) — bu örüntü, gerçek bir ` +
      `intercept-resend saldırısının (her fotonda bağımsız/düzgün-yayılmış ~%25 hata beklenir) İMZASI DEĞİL; ` +
      `kanala/sensöre ait ZAMANSAL bir patlamayla (EMI, titreşim, lazer-modu-atlaması) TUTARLI. ÖNCELİK: donanım/ortam kontrolü.`;
  } else {
    verdict = "GERCEK_DINLEME_OLASI";
    verdictDetail =
      `QBER eşiği AŞILDI (%${(qber * 100).toFixed(2)}) VE hata dağılımı düzgün-yayılmış ` +
      `(koşu-testi z=${runs.z.toFixed(2)}, anlamlı kümelenme YOK) — bu örüntü, gerçek bir intercept-resend ` +
      `saldırısıyla TUTARLI. ÖNCELİK: güvenlik ekibi/hat denetimi.`;
  }

  return {
    // ÇAĞIRANIN kendi ham bayrağı — HİÇBİR KOŞULDA değiştirilmez/geçersiz kılınmaz.
    eavesdropDetected,
    qber,
    clusteringZ: runs.z,
    clusteringDetected,
    runsTest: runs,
    verdict,
    verdictDetail,
    // GÜVENLİK NOTU (bkz. dosya başlığı): bu yalnızca OPERASYONEL bir
    // teşhis sinyalidir. QKDSecurityProof'un ℓ/abort kararı bu verdict'ten
    // TAMAMEN BAĞIMSIZDIR ve BAĞIMSIZ KALMALIDIR — "MUHTEMELEN_CEVRESEL_
    // PATLAMA" verdict'i asla anahtar reddini/kısaltmasını atlamak için
    // KULLANILMAMALIDIR.
    securityDecisionUnaffected: true,
  };
}

/**
 * ANA GİRİŞ NOKTASI (deriveSiftedKey biçimi) — çekirdeğin GERÇEK,
 * DEĞİŞTİRİLMEMİŞ çıktısını (bit DEĞERLERİ olarak) alır.
 *
 * @param {{siftedKeyBits:number[], bobKeyBits:number[], qber:number, eavesdropDetected:boolean}} derived
 * @returns teşhis nesnesi — eavesdropDetected ALANI ASLA DEĞİŞTİRİLMEZ.
 */
function diagnoseAlarm(derived) {
  const { siftedKeyBits, bobKeyBits, qber, eavesdropDetected } = derived;
  const errFlags = computeErrorFlags(siftedKeyBits || [], bobKeyBits || []);
  return buildVerdict(errFlags, qber, eavesdropDetected);
}

/**
 * ALTERNATİF GİRİŞ NOKTASI (hazır hata-bayrağı dizisi biçimi) — bit
 * DEĞERLERİNİ hiç tutmayan, yalnızca "bu sifted bit doğru mu yanlış mı"
 * bayrağını üreten çağıranlar için (ör. client_network_report.js'in
 * kendi yerel measureLinkQber() döngüsü — çekirdeğin deriveSiftedKey'i
 * DEĞİL, kendi ayrı fiziksel-ölçüm mantığıdır, bkz. o dosyanın başlığı).
 *
 * @param {number[]} errFlags - zaman/konum SIRALI, {0,1} hata bayrağı dizisi
 * @param {number} qber
 * @param {boolean} eavesdropDetected - ÇAĞIRANIN kendi eşik kararı (değiştirilmez)
 */
function diagnoseFromErrorFlags(errFlags, qber, eavesdropDetected) {
  return buildVerdict(errFlags || [], qber, eavesdropDetected);
}

module.exports = { diagnoseAlarm, diagnoseFromErrorFlags, computeErrorFlags, runsTest, CLUSTER_Z_THRESHOLD };
