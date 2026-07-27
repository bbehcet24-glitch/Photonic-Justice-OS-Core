#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════════════
// DOLANIKLIK-DAĞITIM TEST HARNESS'İ (HOM Girişimi + Bell-Durumu Sadakati)
//
// ÖNEMLİ MİMARİ NOT (dürüstlük): PhotonNet2.jsx'teki ANA motor, BB84
// prepare-and-measure + güvenilir-düğüm relay protokolüdür — dosyanın
// kendisi bunu satır ~1007'de açıkça belirtir: "GERÇEK bir kuantum
// tekrarlayıcı (entanglement swapping, ara düğüme güven GEREKTİRMEZ)
// DEĞİLDİR". Ana motorun foton kaynağı modeli de zayıf-koherent-atım +
// decoy-state (bkz. QKDSecurityProof.secureKeyLengthWithMu, `mu` = ortalama
// foton sayısı) — yani GERÇEK tek-foton kaynağı g²(0)/saflık modeli değil.
// HOM (Hong-Ou-Mandel) girişimi ve Bell-durumu sadakati kavramları ise
// YAPISAL OLARAK dolanıklık-tabanlı dağıtıma özgüdür (iki bağımsız
// kaynaktan gelen fotonların bir ışın bölücüde çakışması, Bell-durumu
// ölçümü/dolanıklık paylaşımı).
//
// Bu yüzden bu istek, mevcut BB84 motoruna "sahte" bir HOM/Bell katmanı
// eklemek yerine — motorun GERÇEK, halihazırda deneysel referanslara
// dayanan sabitlerini (fiber kaybı: WL/fiberT tablosu; SNSPD karanlık
// sayım: DETECTOR_DARK_RATE_HZ=50Hz) YENİDEN KULLANAN, ama fiziksel
// olarak AYRI ve dürüstçe böyle etiketlenmiş bir dolanıklık-dağıtım test
// modülü olarak uygulanıyor. Bu, projenin kendi "didaktik referans
// değer" disiplinine sadık kalır (bkz. PhotonNet2.jsx genelindeki aynı
// üslup).
//
// KULLANILAN FORMÜLLER (hepsi standart, literatürde kabul görmüş,
// yorumlanabilir yaklaşıklıklardır — TEK bir makaleye "birebir" iddiası
// YOKTUR, bu "didaktik referans" ruhuna uygundur):
//
//  1) Foton kaynağı saflığı: g²(0) (kalan çok-fotonlu kirlilik) ve
//     "indistinguishability" (iki bağımsız fotonun ayırt edilemezlik
//     olasılığı) — SPDC kaynakları için tipik literatür aralığı
//     g²(0)≈0.02–0.08, indistinguishability≈%90–%95 (spektral
//     filtresiz). Kaynak: Ma, Herbst, Scheidl et al. "Quantum
//     teleportation over 143km" (2012); Jennewein grubu SPDC
//     karakterizasyonları — DİDAKTİK referans, birebir tekrar değil.
//
//  2) Dedektör verimliliği: SNSPD kuantum verimi ~%80–%85 saha-tipi
//     sistemlerde (laboratuvar rekorları ~%93 mümkün — Marsili et al.
//     2013 — ama gerçek/saha sistemlerinde tipik %80–85 kullanılıyor,
//     kullanıcı isteğiyle birebir örtüşüyor).
//
//  3) HOM görünürlüğü (visibility): V_gözlenen = V_kaynak × (S_gerçek /
//     (S_gerçek + S_tesadüfi)) — yani kaynağın İÇSEL ayırt-edilemezliği,
//     tesadüfi (karanlık-sayım + çok-fotonlu) çakışmalarla SEYRELTİLİR.
//     Bu, gerçek deneylerde raporlanan "gürültü HOM çukurunu sığlaştırır"
//     davranışının doğrudan matematiksel karşılığıdır.
//
//  4) Bell-durumu sadakati: Werner-durumu modeli, F=(1+3p)/4, p=Werner
//     parametresi (Werner 1989; Horodecki 1996). Bu modelde p>1/3 ⟺
//     F>1/2 — YANİ kullanıcının belirttiği "F>0.5 eşiği = gerçek
//     dolanıklık" kriteri, Werner-durumu için TAM OLARAK bu ünlü,
//     ders-kitabı sonucuyla örtüşüyor (rastgele seçilmiş bir sayı değil).
//
//  5) 3-düğümlü zincirde dolanıklık takası (entanglement swapping):
//     ardışık iki bağımsız (depolarize kanal) Werner-durumunun
//     birleştirilmesinde çıkış Werner parametresi p_swap≈p1×p2 (basit
//     çarpımsal-bozulma yaklaşıklığı — Briegel/Dür kuantum-tekrarlayıcı
//     literatüründeki standart yaklaşıklık).
// ══════════════════════════════════════════════════════════════════════════

const { WL, fiberT, poissonSample } = require("./photonnet_core.js");

// ── 1) FOTON KAYNAĞI (kusursuz DEĞİL — "ideal" kapatıldı) ──────────────────
const SOURCE_G2_ZERO = 0.045;              // kalan çok-fotonlu kirlilik olasılığı (didaktik ref. aralık 0.02–0.08)
const SOURCE_INDISTINGUISHABILITY = 0.925; // "saflık" — makaledeki gibi ~%90–95 (kullanıcı isteği: ideal %100 DEĞİL)
const PAIR_GENERATION_RATE_HZ = 5e6;       // kaynağın çift-üretim hızı (tipik SPDC, MHz mertebesi, didaktik ref.)

// ── 2) DEDEKTÖR (SNSPD) — verimlilik artık AYRI, açık bir parametre ────────
const DETECTOR_QUANTUM_EFFICIENCY = 0.82;  // ~%80–85 aralığı (kullanıcı isteği), saha-tipi SNSPD
const DETECTOR_DARK_RATE_HZ = 50;          // PhotonNet2.jsx ile TUTARLI (aynı SNSPD-sınıfı referans değer)
const TIMING_JITTER_NS = 0.4;              // birleşik zamanlama jitter bütçesi (didaktik ref., gerçek SNSPD ~50-100ps + elektronik)

function nm() { return 1550; } // telekom-bant, WL tablosundaki en düşük kayıp

/** İki koldaki (kaynak→A, kaynak→B) fiber iletim olasılığı çarpımı. */
function twoArmTransmittance(kmA, kmB) {
  return fiberT(nm(), kmA) * fiberT(nm(), kmB);
}

/**
 * Bir koridorun (kaynak + iki kol + iki dedektör) GERÇEK (tesadüfi
 * OLMAYAN) çift-algılama (coincidence) oranı ile TESADÜFİ (karanlık-sayım +
 * çok-fotonlu kirlilik kaynaklı) oranını, verilen eşzamanlılık penceresinde
 * (ns) hesaplar. Tüm "ideal" kısayollar KAPALI: kayıp, dedektör verimi,
 * karanlık sayım ve çok-fotonlu kirlilik HEP AKTİF.
 */
function coincidenceRates(kmA, kmB, windowNs) {
  const T = twoArmTransmittance(kmA, kmB);
  const etaA = DETECTOR_QUANTUM_EFFICIENCY, etaB = DETECTOR_QUANTUM_EFFICIENCY;

  // Zamanlama jitter'ı yüzünden dar bir pencerede GERÇEK çiftlerin bir kısmı
  // da kırpılır — "bedava" bir gürültü-reddi YOK (PhotonNet2.jsx'teki
  // REAL_CLICK_MISS_AT_MIN_GATE ödünleşimiyle AYNI dürüstlük ilkesi).
  const windowAcceptance = 1 - Math.exp(-windowNs / TIMING_JITTER_NS);

  const trueRate = PAIR_GENERATION_RATE_HZ * T * etaA * etaB * windowAcceptance;

  // Tekil (singles) sayım oranları — her koldaki dedektöre düşen TOPLAM
  // tetikleme oranı (gerçek foton varışı + karanlık sayım). Rastgele
  // (tesadüfi) çakışma oranı standart formülle: R_acc ≈ 2·τ·S_A·S_B.
  const singlesA = PAIR_GENERATION_RATE_HZ * fiberT(nm(), kmA) * etaA + DETECTOR_DARK_RATE_HZ;
  const singlesB = PAIR_GENERATION_RATE_HZ * fiberT(nm(), kmB) * etaB + DETECTOR_DARK_RATE_HZ;
  const windowS = windowNs * 1e-9;
  const accidentalFromDark = 2 * windowS * singlesA * singlesB;

  // Çok-fotonlu kirlilik: kaynağın g²(0)>0 olması, çift-üretimin
  // istatistiksel olarak "temiz" olmadığı, ekstra sahte-çakışma benzeri
  // olaylar ürettiği anlamına gelir — gerçek çift oranıyla ORANTILI.
  const accidentalFromMultiphoton = trueRate * SOURCE_G2_ZERO;

  const accidentalRate = accidentalFromDark + accidentalFromMultiphoton;
  return { trueRate, accidentalRate, windowAcceptance, T };
}

/** HOM görünürlüğü — kaynağın içsel ayırt-edilemezliği, tesadüfi olaylarla seyreltilmiş. */
function homVisibility(trueRate, accidentalRate) {
  const total = trueRate + accidentalRate;
  if (total <= 0) return 0;
  const signalFraction = trueRate / total; // [0,1]
  return SOURCE_INDISTINGUISHABILITY * signalFraction;
}

/** Werner parametresi p ve Bell-durumu sadakati F=(1+3p)/4. */
function bellFidelityFromVisibility(V) {
  const p = V; // basit izomorfizm: gözlenen görünürlük ≡ Werner parametresi (bkz. dosya başı not 4)
  const F = (1 + 3 * p) / 4;
  return { p, F, entangled: F > 0.5 };
}

/** İki bağımsız elemanter bağın (Werner p1,p2) dolanıklık-takası sonrası birleşik sadakati. */
function swapFidelity(p1, p2) {
  const pSwap = p1 * p2;
  const F = (1 + 3 * pSwap) / 4;
  return { pSwap, F, entangled: F > 0.5 };
}

module.exports = {
  SOURCE_G2_ZERO, SOURCE_INDISTINGUISHABILITY, PAIR_GENERATION_RATE_HZ,
  DETECTOR_QUANTUM_EFFICIENCY, DETECTOR_DARK_RATE_HZ, TIMING_JITTER_NS,
  twoArmTransmittance, coincidenceRates, homVisibility, bellFidelityFromVisibility, swapFidelity,
};
