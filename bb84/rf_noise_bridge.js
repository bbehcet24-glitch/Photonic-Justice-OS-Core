#!/usr/bin/env node
"use strict";
/**
 * rf_noise_bridge.js — Faraday kafesi EM sızıntısını QKD kanalının
 * gürültü modeline BAĞLAYAN köprü katmanı (çekirdeğe dokunmaz).
 * ═══════════════════════════════════════════════════════════════════
 * NEDEN GEREKLİ: faraday_cage_shielding.js yalnız "sinyal kafesin
 * dışında gürültü tabanının üzerinde mi kalıyor" sorusuna cevap verir
 * (emissionDetectabilityCheck). Ama bunun QKD KANALI için ne anlama
 * geldiği — yani gerçek dedektör elektroniğinde kaç sahte ("dark
 * count benzeri") tıklamaya yol açacağı ve bunun ÖLÇÜLEN QBER'i ne
 * kadar etkileyeceği — ayrı bir sorudur. Bu köprü ikisini birleştirir:
 *   emissionDetectabilityCheck() (faraday_cage_shielding.js)
 *     → marj (dB, gürültü tabanına göre)
 *     → rfInducedDarkProb() (BU DOSYA — açık varsayım/kalibrasyon)
 *     → timetag_acquisition_bridge.js'nin darkProb girdisine eklenir
 *     → B.acquire() GERÇEK QKD sifting simülasyonunu koşar → ÖLÇÜLEN QBER
 *     → detector_recalibration.js üzerinden çekirdeğin sonlu-anahtar
 *       kanıtına (QKDSecurityProof.secureKeyLength, SALT OKUNUR çağrı —
 *       production_gate.js/detector_recalibration.js ile AYNI, zaten
 *       kabul edilmiş desen) beslenir → ℓ>0 kalıyor mu?
 *
 * DÜRÜSTLÜK NOTU (KALİBRASYON VARSAYIMI — EN KRİTİK KISIM):
 *   "Alınan EM sinyali gürültü tabanının X dB üzerinde/altında olursa,
 *   dedektör elektroniğinde kapı başına ne kadar sahte tıklama olasılığı
 *   yaratır?" sorusunun GERÇEK, ÖLÇÜLMÜŞ bir cevabı bu projede YOK —
 *   böyle bir bağıntı gerçek analog ön-uç (TIA/karşılaştırıcı) tasarımına,
 *   eşik gerilimine ve gürültü istatistiğine bağlıdır ve ancak gerçek
 *   donanımla ÖLÇÜLEBİLİR. Burada kullanılan model AÇIKÇA bir VARSAYIMDIR:
 *     rfDarkProb = clamp(refDarkProb · 10^(marj[dB]/10), 0, 1)
 *   yani: sinyal gürültü tabanına EŞİTKEN (marj=0), sahte tıklama olasılığı
 *   çekirdek dedektörün intrinsik karanlık-sayım olasılığıyla (refDarkProb,
 *   varsayılan 5e-4) AYNI mertebede kabul edilir; her +10 dB marj bu
 *   olasılığı ×10 büyütür (güç-alanında doğrusal, sinyal-gürültü oranı
 *   sezgisiyle tutarlı bir yaklaşım — ama KALİBRE EDİLMEMİŞ). Bu, gerçek
 *   donanımla DOĞRULANMADAN üretim kararı için kullanılmamalıdır — bkz.
 *   rf_noise_bridge_test.js'teki (A) duyarlılık testi.
 *
 * Bu modül photonnet_core.js'i DOĞRUDAN import ETMEZ — yalnız zaten var
 * olan, test edilmiş katman dosyalarını (faraday_cage_shielding.js,
 * timetag_acquisition_bridge.js, detector_recalibration.js) besler.
 */
const F = require("./faraday_cage_shielding.js");
const B = require("./timetag_acquisition_bridge.js");
const R = require("./detector_recalibration.js");

/**
 * Marjı (dB, gürültü tabanına göre) kapı-başına "RF kaynaklı sahte tıklama"
 * olasılığına çevirir. bkz. modül başlığındaki DÜRÜSTLÜK NOTU — kalibre
 * edilmemiş bir varsayımdır.
 */
function rfInducedDarkProb(marginDb, refDarkProb = 5e-4) {
  const p = refDarkProb * Math.pow(10, marginDb / 10);
  return Math.min(Math.max(p, 0), 1);
}

/**
 * Bir kafes tasarımını + tehdit senaryosunu (kaynak seviyesi, gözlemci
 * mesafesi, gürültü tabanı) değerlendirip RF kaynaklı ek darkProb'u üretir.
 */
function evaluateRfNoiseContribution({ sourceLevelDbuVm, cage, observerDistanceM, noiseFloorDbuVm, refDarkProb = 5e-4 }) {
  const det = F.emissionDetectabilityCheck({ sourceLevelDbuVm, cage, observerDistanceM, noiseFloorDbuVm });
  const marginDb = +(det.receivedDbuVm - noiseFloorDbuVm).toFixed(1);
  const rfDarkProb = rfInducedDarkProb(marginDb, refDarkProb);
  return { ...det, marginDb, rfDarkProb };
}

/**
 * GERÇEK QKD kanal simülasyonunu (timetag_acquisition_bridge.js'nin
 * uçtan-uca sift/QBER motoru) RF kaynaklı ek darkProb ile koşar.
 * baseAcqOpts.darkProb TEMEL (RF'siz) karanlık sayım; rfDarkProb ÜSTÜNE
 * EKLENİR (iki bağımsız gürültü kaynağı → olasılıklar toplanır, kapı
 * başına küçük olasılıklar için standart yaklaşım).
 */
function simulateChannelWithRfNoise(baseAcqOpts, rfDarkProb) {
  const acq = B.acquire({ ...baseAcqOpts, darkProb: (baseAcqOpts.darkProb || 0) + rfDarkProb });
  return { ...acq, baseDarkProb: baseAcqOpts.darkProb || 0, rfDarkProb, totalDarkProb: (baseAcqOpts.darkProb || 0) + rfDarkProb };
}

module.exports = { rfInducedDarkProb, evaluateRfNoiseContribution, simulateChannelWithRfNoise, recalibrateFiniteKey: R.recalibrateFiniteKey };
