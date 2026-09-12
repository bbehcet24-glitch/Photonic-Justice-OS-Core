#!/usr/bin/env node
"use strict";
/**
 * exact_slot_time.js — timetag_acquisition_bridge.js'in run() içindeki
 * ÇARPIM satırının (`slotT = i * o.periodPs + clockOffsetPs(i)`, satır 97)
 * BigInt/keyfi-hassasiyetli YENİDEN TASARIMI (kullanıcı talebi: "BigInt
 * Geçişi" + "çarpım hesaplamasının yapıldığı fonksiyon satırını tasarla").
 * ═══════════════════════════════════════════════════════════════════
 * BULGU (floating_point_accumulation_test.js'in (D) kontrolünden): i*periodPs
 * çarpımı KENDİ BAŞINA KESİNDİR (yuvarlama BİRİKMEZ, her çağrı TAZE hesaplanır)
 * ama Number'ın 2^53'lük tamsayı-temsil TAVANI nedeniyle KENDİ SABİT bir
 * çarpım-tavanına sahiptir: i × periodPs > Number.MAX_SAFE_INTEGER olduğu an
 * çarpım artık TAM temsil edilemez. periodPs=1000 ps (1 GHz) için bu tavan
 * i ≈ 9.007×10¹² civarında (yaklaşık 2.5 saatlik KESİNTİSİZ TEK bir run()
 * çağrısı, saniyede 1e9 darbeyle) — döngü SAYACININ (i'nin KENDİSİ, Number
 * olarak) kendi tavanı olan 2^53 ≈ 9.007×10¹⁵'ten TAM 1000× daha ERKEN gelir
 * (periodPs'nin çarpanı mantissa'nın ~10 bitini "yer" için harcadığından).
 *
 * BU MODÜL bu ÇARPIMI BigInt'e taşıyarak bu tavanı TAMAMEN KALDIRIR — BigInt
 * keyfi hassasiyetlidir, i ve periodPs ne kadar büyük olursa olsun çarpım
 * HER ZAMAN KESİNDİR (yuvarlama SIFIR).
 *
 * KAPSAM DÜRÜSTLÜĞÜ (ÖNEMLİ — abartılmıyor): bu modül timetag_acquisition_
 * bridge.js'in run()'unu DEĞİŞTİRMEZ/YERİNE GEÇMEZ — o dosyaya HİÇ
 * dokunulmadı, mevcut tüm testler/davranış BİREBİR korunur. Ayrıca BigInt
 * çarpımın KENDİSİ kesin olsa BİLE, run()'un aşağı akışı (coincidence()'daki
 * `Math.round(e.tPs/periodPs)` gibi) hâlâ Number/kesirli aritmetik kullanır
 * (jitter SÜREKLİ bir fiziksel niceliktir, BigInt'e doğal olarak taşınamaz)
 * — yani BigInt sonucu SONUNDA Number'a çevrilip aşağı akışa verilirse, i
 * ZATEN 2^53'ü aşıyorsa AYNI temsil kaybı GERİ GELİR (bkz. (J) kontrolü).
 * Bu modülün KESİN garantisi şu ANDA yalnız: (1) BAĞIMSIZ/denetim amaçlı
 * kesin hesaplama (ör. "pulse #N'in TAM zamanı nedir" sorusuna BigInt'te
 * sıfır-hata cevap), ve (2) run()'un Number tavanını AŞIP AŞMADIĞINI
 * ÖNCEDEN tespit eden bir "kanarya" fonksiyonu (numberSlotTimeMatchesExact /
 * safePulseCountForPeriod) — coincidence()/sift() aşağı akışını da tam
 * BigInt/tamsayı aritmetiğine taşımak AYRI, DAHA BÜYÜK bir mimari iştir ve
 * BURADA YAPILMADI (mevcut çalışan sistemi bozma riskini almamak için).
 */

/** Number'ı (tamsayı KABUL edilerek) veya zaten BigInt'i BigInt'e çevirir. */
function toBigIntSafe(v) {
  if (typeof v === "bigint") return v;
  if (!Number.isFinite(v)) throw new RangeError(`toBigIntSafe: sonlu olmayan değer: ${v}`);
  return BigInt(Math.trunc(v));
}

/**
 * ÇARPIMIN KESİN/keyfi-hassasiyetli YENİDEN TASARIMI: i × periodPs.
 * i ve periodPs Number (tamsayı) veya BigInt olabilir — HER İKİSİ DE BigInt'e
 * çevrilip TAM çarpılır. Sonuç HER ZAMAN BigInt'tir — i/periodPs ne kadar
 * büyük olursa olsun YUVARLAMA SIFIRDIR (BigInt keyfi hassasiyetlidir).
 * Bu, run()'daki `i * o.periodPs` satırının doğrudan, ceiling'siz karşılığıdır.
 */
function slotTimePsExact(i, periodPs) {
  return toBigIntSafe(i) * toBigIntSafe(periodPs);
}

/**
 * Number formülünün (i*periodPs, doğrudan run()'daki gibi) KESİN BigInt
 * sonuçla EŞLEŞİP EŞLEŞMEDİĞİNİ sınayan "KANARYA" — savunma-derinliği:
 * bir dağıtımın Number tavanına YAKLAŞTIĞINI ÖNCEDEN (sessiz bozulmadan
 * ÖNCE) tespit etmek için kullanılabilir (EMERGENCY_SE_FLOOR_DB'nin "erken
 * uyarı" felsefesiyle AYNI desen — bkz. network_shielding_bridge.js).
 */
function numberSlotTimeMatchesExact(i, periodPs) {
  const numberResult = i * periodPs;              // run()'daki MEVCUT satırla BİREBİR AYNI hesap
  const exact = slotTimePsExact(i, periodPs);      // BigInt zemin-gerçeklik
  return BigInt(Math.trunc(numberResult)) === exact;
}

/**
 * Belirli bir periodPs için, i*periodPs'in Number'da GARANTİLİ kesin kaldığı
 * en büyük pulse indeksi: floor(MAX_SAFE_INTEGER/periodPs). Bu KORUYUCU
 * (sufficient ama NECESSARY/sıkı DEĞİL) bir sınırdır — i ≤ bu değer İSE
 * i*periodPs ≤ MAX_SAFE_INTEGER olur ve TÜM tamsayılar bu tavanın altında
 * KESİN temsil edilir (MATEMATİKSEL OLARAK KOŞULSUZ garanti).
 *
 * DÜRÜSTLÜK NOTU (ÖNEMLİ, deneyle keşfedildi — bkz. exact_slot_time_test.js
 * (B)/(C)): bu sınırın ÖTESİNDE kesinlik "hemen ve her zaman" BOZULMAZ —
 * i'nin KENDİ ikili (binary) yapısına bağlı olarak (periodPs=1000 gibi
 * 2'nin kuvvetlerini çarpan içeren değerlerde ÖZELLİKLE) BAZI i değerleri
 * bu tavanın ÇOK ötesinde bile YİNE DE kesin kalabilir (ör. i, 2'nin yüksek
 * kuvvetleriyle "hizalıysa"). Bu YALNIZCA ŞANSA bağlı bir durumdur —
 * GÜVENİLİR bir garanti DEĞİLDİR — bu yüzden precisionRiskForConfig() bu
 * KORUYUCU (her zaman doğru) sınırı kullanır, "genelde çalışan" gevşek bir
 * tahmini DEĞİL.
 */
function maxExactPulseIndex(periodPs) {
  const periodBig = toBigIntSafe(periodPs);
  return BigInt(Math.floor(Number.MAX_SAFE_INTEGER / Number(periodBig)));
}

/**
 * Bir dağıtımın (pulses, periodPs) yapılandırmasının run()'un Number çarpım
 * tavanını AŞIP AŞMAYACAĞINI, hiç o kadar döngü ÇALIŞTIRMADAN, ÖNCEDEN
 * söyler — gerçek bir "epoch reset" veya "BigInt'e geç" kararını TETİKLEMEK
 * için kullanılabilecek bir ön-koşul kontrolü (network_shielding_bridge.js'in
 * mtlsHandshakePrecondition() ile AYNI "ÖNCEDEN REDDET" felsefesi).
 */
function precisionRiskForConfig(pulses, periodPs) {
  const maxSafe = maxExactPulseIndex(periodPs);
  const pulsesBig = toBigIntSafe(pulses);
  const lastIndex = pulsesBig > 0n ? pulsesBig - 1n : 0n; // döngü i=0..pulses-1 çalıştırır
  const safe = lastIndex <= maxSafe;
  return {
    safe, maxExactPulseIndex: maxSafe, lastIndexReached: lastIndex,
    headroomPulses: safe ? maxSafe - lastIndex : 0n,
    detail: safe
      ? `GÜVENLİ: son pulse indeksi (${lastIndex}) ≤ Number çarpım tavanı (${maxSafe}) — i*periodPs run() içinde KESİN kalır`
      : `RİSKLİ: son pulse indeksi (${lastIndex}) > Number çarpım tavanı (${maxSafe}) — run() bu yapılandırmada i*periodPs hassasiyet KAYBEDER (bkz. slotTimePsExact/BigInt geçişi)`,
  };
}

module.exports = { slotTimePsExact, numberSlotTimeMatchesExact, maxExactPulseIndex, precisionRiskForConfig, toBigIntSafe };
