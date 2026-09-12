"use strict";
// ══════════════════════════════════════════════════════════════
// GİRDİ DOĞRULAMA KORUMASI (Input Sanitization Guard)
//
// KÖKEN: bb84/chaos_fuzz_test.js (commit 0d4721c) bozuk/telemetri-
// kaynaklı verinin (NaN, Infinity, null, aşırı büyük integer) bazı
// çekirdek fonksiyonlarına ulaştığında SESSİZCE NaN/Infinity ürettiğini
// veya (propPhoton/bb84Reconcile'da reps/bitCount=Infinity ile) SONSUZ
// DÖNGÜYE girdiğini kanıtladı. Bu dosya o bulguların DÜZELTMESİDİR.
//
// NEDEN ÇEKİRDEĞE DOKUNULMADI: proje kuralı gereği photonnet_core.js
// hiçbir şekilde değiştirilemez. Bu yüzden düzeltme, projenin zaten
// kullandığı "kanca/köprü katmanı" deseniyle (bkz. README §5.6)
// çekirdeğin ÖNÜNE konan bir doğrulama katmanı olarak uygulanıyor:
// gerçek/telemetri kaynaklı çağrılar artık BU dosyadaki guard*
// fonksiyonlarından geçmeli, çekirdek fonksiyonlarını doğrudan
// çağırmamalıdır. Çekirdek fonksiyonlarının kendisi BİREBİR AYNI
// kalır — yalnızca önlerine bir "temizle, sonra çağır" adımı eklendi.
//
// FELSEFE: sessizce "en iyi tahmini" bir sayı üretip yutmak yerine,
// her düzeltme AÇIKÇA loglanır (`_guard` alanı) — bu proje "bulguları
// yumuşatmadan raporla" kültürünü, çalışma zamanı davranışına da taşır.
// ══════════════════════════════════════════════════════════════
const path = require("path");
const core = require(path.join(__dirname, "photonnet_core.js"));

/**
 * Bir sayısal parametreyi doğrular/temizler.
 * - typeof number değilse VEYA NaN/Infinity ise → fallback'e düşer.
 * - [min,max] aralığı dışındaysa → en yakın sınıra kırpılır.
 * @returns {{value:number, corrected:boolean, reason:string|null}}
 */
function sanitizeNumber(raw, { min, max, fallback, label }) {
  // GÜVENLİK NOTU (guard doğrulama testinde bulundu — client_network_report.js
  // entegrasyonu sırasında): çağıran taraf `fallback` olarak KENDİSİ
  // hesaplanmış, henüz doğrulanmamış bir değer verirse (örn.
  // autoReps(henüz-temizlenmemiş-km) gibi türetilmiş bir varsayılan),
  // fallback'in kendisi de [min,max] dışında olabilir — bu, guard'ı
  // sessizce by-pass eder. Bu yüzden fallback DA HER ZAMAN [min,max]'a
  // kırpılır; guard hiçbir koşulda sınırların dışına bir değer döndürmez.
  const safeFallback = Math.min(max, Math.max(min, fallback));
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return { value: safeFallback, corrected: true, reason: `${label}: sayı değil/NaN (${String(raw)}) → varsayılan ${safeFallback}` };
  }
  if (!Number.isFinite(raw)) {
    return { value: safeFallback, corrected: true, reason: `${label}: sonlu değil (${String(raw)}) → varsayılan ${safeFallback}` };
  }
  if (raw < min) {
    return { value: min, corrected: true, reason: `${label}: alt sınırın altında (${raw}) → ${min}'e kırpıldı` };
  }
  if (raw > max) {
    return { value: max, corrected: true, reason: `${label}: üst sınırın üstünde (${raw}) → ${max}'e kırpıldı (sonsuz döngü/DoS koruması)` };
  }
  return { value: raw, corrected: false, reason: null };
}

// Fiziksel/mantıksal olarak makul sınırlar. Üst sınırlar aynı zamanda
// propPhoton/bb84Reconcile'daki "for (i=0; i<N; i++)" döngülerinin
// sonsuza gitmesini engelleyen DoS koruması işlevi görür.
const BOUNDS = {
  km: { min: 0, max: 100000, fallback: 50 }, // Dünya çevresi ~40.000km; cömert üst sınır
  reps: { min: 0, max: 200, fallback: 0 }, // dynamicRedundancyFor'un kendi maxRedundancy'si de 150 civarı
  el: { min: 0, max: 90, fallback: 45 }, // elevasyon açısı, derece
  // DÜZELTME (guard doğrulama testinde bulundu): min/fallback=0 iken
  // bb84Reconcile'ın kendi matchRate=matched/bitCount hesabı 0/0=NaN
  // üretiyordu — guard "geçersiz girdiyi düzelttim" derken YENİ bir
  // sessiz-NaN kaynağı açmış oluyordu. min=1 bu sınıfın tamamını kapatır
  // (hiçbir zaman 0'a bölme oluşmaz). Üst sınır 100.000 (5 milyon değil)
  // — tek bir senkron çağrının makul sürede (<1sn) tamamlanmasını da
  // garanti eder (5 milyon bitlik çağrı guard doğrulama testinde zaman
  // aşımına uğradı).
  bitCount: { min: 1, max: 100000, fallback: 1 },
};

// Bazı çekirdek formülleri (özellikle computeRepeaterGain'in Math.pow(10, x/10)
// hattı) km büyüdükçe ÜSTEL büyür — girdi km=100.000 sınırının İÇİNDE bile
// (segmentLossDb onlarca binlere çıkabildiğinden) double-precision taşmasına
// (Infinity) uğrayabilir. Girdi tarafında bunu matematiksel olarak güvenli
// tek bir sınırla önlemek kırılgan olurdu (reps/nm/ceiling'e bağlı) — bu
// yüzden EK bir savunma katmanı olarak ÇIKTI da doğrulanır: sonuç sonlu
// değilse, fiziksel olarak güvenli/muhafazakar bir varsayılana düşülür ve
// AÇIKÇA loglanır (sessizce yutulmaz).
function sanitizeOutputScalar(value, { fallback, label }) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { value: fallback, corrected: true, reason: `${label}: çıktı sonlu değil (${String(value)}) → güvenli varsayılan ${fallback}` };
  }
  return { value, corrected: false, reason: null };
}

function sanitizeBitsArray(raw, label) {
  if (!Array.isArray(raw)) {
    return { value: [], corrected: true, reason: `${label}: dizi değil (${typeof raw}) → boş dizi kullanıldı` };
  }
  let corrected = false;
  const cleaned = raw.map((b) => {
    if (b === 0 || b === 1) return b;
    corrected = true;
    return typeof b === "number" && !Number.isNaN(b) && b > 0 ? 1 : 0;
  });
  return {
    value: cleaned,
    corrected,
    reason: corrected ? `${label}: 0/1 dışı bit değer(ler)i 0'a/1'e normalize edildi` : null,
  };
}

function withGuardLog(result, notes) {
  const active = notes.filter((n) => n.corrected);
  if (active.length) {
    result._guard = active.map((n) => n.reason);
  }
  return result;
}

// ── Korunan sarmalayıcılar ──
// Her biri: çekirdek fonksiyonu DEĞİŞTİRMEDEN, önce girdiyi temizler,
// sonra orijinal çekirdek fonksiyonunu çağırır.

function guardedFiberT(nm, km) {
  const kmS = sanitizeNumber(km, { ...BOUNDS.km, label: "km" });
  const value = core.fiberT(nm, kmS.value);
  return withGuardLog({ value }, [kmS]);
}

function guardedEavesdropProbability(nm, km) {
  const kmS = sanitizeNumber(km, { ...BOUNDS.km, label: "km" });
  const value = core.eavesdropProbability(nm, kmS.value);
  return withGuardLog({ value }, [kmS]);
}

function guardedComputeRepeaterGain(nm, km, reps, ceilingOverride) {
  const kmS = sanitizeNumber(km, { ...BOUNDS.km, label: "km" });
  const repsS = sanitizeNumber(reps, { ...BOUNDS.reps, label: "reps" });
  const raw = core.computeRepeaterGain(nm, kmS.value, repsS.value, ceilingOverride);
  // Kazanç asla negatif/sonsuz olamaz; taşma durumunda "kazanç yok" (1.0)
  // — yani "sinyal telafi edilmedi" — GÜVENLİ/muhafazakar varsayımdır.
  const outS = sanitizeOutputScalar(raw, { fallback: 1.0, label: "gain" });
  return withGuardLog({ value: outS.value }, [kmS, repsS, outS]);
}

function guardedEstimateLinkSurvival(nm, km, reps, legaCtx) {
  const kmS = sanitizeNumber(km, { ...BOUNDS.km, label: "km" });
  const repsS = sanitizeNumber(reps, { ...BOUNDS.reps, label: "reps" });
  const safeLegaCtx = legaCtx && typeof legaCtx === "object" ? legaCtx : null;
  const raw = core.estimateLinkSurvival(nm, kmS.value, repsS.value, safeLegaCtx);
  // FAIL-CLOSED: hayatta kalma olasılığı hesaplanamıyorsa (taşma/NaN),
  // "hayatta kalmadı" (0) varsayılır — projenin güvenlik felsefesiyle
  // tutarlı: belirsizlikte iyimser değil, kötümser/güvenli tarafta kal.
  const outS = sanitizeOutputScalar(raw, { fallback: 0, label: "survival" });
  return withGuardLog({ value: outS.value }, [kmS, repsS, outS]);
}

function guardedPropPhoton(nm, km, reps, evesdrop, rng, legaCtx, repeaterCeilingOverride) {
  const kmS = sanitizeNumber(km, { ...BOUNDS.km, label: "km" });
  const repsS = sanitizeNumber(reps, { ...BOUNDS.reps, label: "reps" });
  const safeRng = typeof rng === "function" ? rng : Math.random;
  const safeLegaCtx = legaCtx && typeof legaCtx === "object" ? legaCtx : null;
  const value = core.propPhoton(nm, kmS.value, repsS.value, !!evesdrop, safeRng, safeLegaCtx, repeaterCeilingOverride);
  return withGuardLog({ value }, [kmS, repsS]);
}

function guardedSatQ(el) {
  const elS = sanitizeNumber(el, { ...BOUNDS.el, label: "el" });
  const value = core.satQ(elS.value);
  return withGuardLog({ value }, [elS]);
}

function guardedBb84Reconcile(bitCount, rng) {
  const bcS = sanitizeNumber(bitCount, { ...BOUNDS.bitCount, label: "bitCount" });
  const safeRng = typeof rng === "function" ? rng : Math.random;
  const value = core.bb84Reconcile(bcS.value, safeRng);
  // Ek savunma katmanı: bitCount>=1 zaten 0/0 olasılığını kapatıyor, ama
  // matchRate yine de sonlu değilse (beklenmedik bir yol üzerinden) "%0
  // eşleşme" (0) — yani "bu anahtarı güvenme" — güvenli varsayımdır.
  const mrS = sanitizeOutputScalar(value.matchRate, { fallback: 0, label: "matchRate" });
  value.matchRate = mrS.value;
  return withGuardLog({ value }, [bcS, mrS]);
}

function guardedHEnc(bits) {
  const bitsS = sanitizeBitsArray(bits, "bits");
  const value = core.hEnc(bitsS.value);
  return withGuardLog({ value }, [bitsS]);
}

function guardedHDec(bits, withLog = false, bypass = false) {
  const bitsS = sanitizeBitsArray(bits, "bits");
  const value = core.hDec(bitsS.value, withLog, bypass);
  return withGuardLog({ value }, [bitsS]);
}

module.exports = {
  sanitizeNumber,
  sanitizeBitsArray,
  BOUNDS,
  guardedFiberT,
  guardedEavesdropProbability,
  guardedComputeRepeaterGain,
  guardedEstimateLinkSurvival,
  guardedPropPhoton,
  guardedSatQ,
  guardedBb84Reconcile,
  guardedHEnc,
  guardedHDec,
};
