#!/usr/bin/env node
"use strict";
/**
 * network_shielding_bridge.js — Faraday kalkanlama BAŞARISINI ağ katmanına
 * (ETSI GS QKD 014 mTLS el sıkışması + koinsidans penceresi/jitter hizalama)
 * BAĞLAYAN köprü. Çekirdeğe dokunmaz; gerçek etsi014_kme_server.js sunucu
 * sürecini de DEĞİŞTİRMEZ — bunun yerine o sürecin ÖNÜNE konabilecek,
 * bağımsız test edilebilir bir ÖN-KOŞUL/OPTİMİZASYON katmanı sunar.
 * ═══════════════════════════════════════════════════════════════════
 * KAPSAM NOTU (dürüstçe): etsi014_kme_server.js gerçek bir HTTPS sunucu
 * sürecidir (Node'un TLS katmanını gerçek mTLS için kullanır — bkz. o
 * dosyanın başlığı). Bu köprü o sunucunun TLS kabul mantığını YENİDEN
 * YAZMAZ (riskli/kapsam-dışı); bunun yerine bir DAĞITICI/orkestratörün
 * sunucuyu BAŞLATMADAN ÖNCE çağırabileceği bir fail-closed ÖN-KOŞUL
 * fonksiyonu sağlar: "fiziksel katman (EM kalkanlama) hedefi karşılanmıyorsa,
 * SAE↔KME mTLS el sıkışmasına hiç izin verme." Bu, production_gate.js'in
 * zaten kurduğu "yazılımın kapatabildiği / donanımın kapatması gereken"
 * ayrımıyla AYNI fail-closed felsefesini ağ/kimlik-doğrulama katmanına taşır.
 *
 * İKİNCİ PARÇA — KOİNSİDANS PENCERESİ (ODL/jitter hizalama): kalkanlama
 * EM-kaynaklı sahte tıklamaları bastırdıkça, aynı verim hedefini tutturmak
 * için gereken koinsidans penceresi (dolayısıyla optik geciktirme hattının
 * tutması gereken zamanlama toleransı) DARALTILABİLİR — bkz.
 * shielded_detector_physics.js'teki findOptimalCoincidenceWindow(). Bu
 * dosya o sonucu "önerilen pencere" biçiminde ağ/zamanlama katmanına sunar.
 *
 * ACİL-DURUM TABANI (EMERGENCY_SE_FLOOR_DB) — KULLANICI GERİ BİLDİRİMİYLE
 * EKLENDİ: "kalkanlama 30 dB'in altına düştüğü an acımadan mTLS kapılarını
 * kilitlemesi gerekir" talebi üzerine. ÖNCEKİ davranış (cageEvaluation.ok,
 * yalnız ÇAĞIRANIN verdiği targetSeDb'ye göre pass/fail) DOĞRUYDU ve hâlâ
 * birincil kontroldür — hardware_aging_model_test.js'in (E) kontrolü, 60 dB
 * hedefiyle sistemin döngü 335'te (SE hedefin altına düşer düşmez) KESİNTİSİZ
 * blokladığını, 250-400 arası TEK BİR döngüde bile "kör nokta" OLMADIĞINI
 * döngü-döngü doğruladı (bkz. o dosyanın (H) kontrolü). AMA bu, targetSeDb'yi
 * DÜŞÜK ayarlayan (ör. yanlışlıkla 15 dB) bir çağırana karşı KORUMASIZDI —
 * o durumda cageEvaluation.ok, SE=20 dB gibi GERÇEKTE tehlikeli bir durumda
 * bile true olurdu. Bu taban, targetSeDb NE OLURSA OLSUN, SE bu MUTLAK
 * eşiğin altına düşerse mTLS'i KOŞULSUZ REDDEDER — savunma-derinliği,
 * yanlış-yapılandırmaya karşı ikinci bir fail-closed katmanı.
 */
const D = require("./shielded_detector_physics.js");

const EMERGENCY_SE_FLOOR_DB = 30; // targetSeDb'den BAĞIMSIZ, koşulsuz acil-durum tabanı (kullanıcı talebiyle eklendi)

/**
 * mTLS EL SIKIŞMA ÖN-KOŞULU — fail-closed. cageEvaluation,
 * faraday_cage_shielding.js'nin evaluateFaradayCage() çıktısıdır (veya
 * hardware_aging_model.js'nin applyFieldAging() ile üretilen, AYNI şekle
 * sahip "yaşlanmış" bir değerlendirme). İKİ BAĞIMSIZ kontrol uygulanır:
 * (1) cageEvaluation.ok — çağıranın verdiği targetSeDb'ye göre; (2) SE'nin
 * EMERGENCY_SE_FLOOR_DB'nin altına düşüp düşmediği — targetSeDb'den
 * TAMAMEN BAĞIMSIZ, sabit bir mutlak taban.
 */
function mtlsHandshakePrecondition(cageEvaluation) {
  const seDb = cageEvaluation && cageEvaluation.worst ? cageEvaluation.worst.combinedSeDb : -Infinity;
  const emergencyBreach = seDb < EMERGENCY_SE_FLOOR_DB;
  const targetMet = !!(cageEvaluation && cageEvaluation.ok === true);
  const allowed = targetMet && !emergencyBreach;
  let reason;
  if (allowed) {
    reason = `fiziksel katman kalkanlama hedefi karşılanıyor (marj +${cageEvaluation.marginDb} dB, SE ${seDb.toFixed(1)} dB ≥ acil-durum tabanı ${EMERGENCY_SE_FLOOR_DB} dB) — SAE↔KME mTLS el sıkışmasına İZİN VERİLİR`;
  } else if (!cageEvaluation) {
    reason = `fiziksel katman kalkanlama hedefi KARŞILANMIYOR (kafes değerlendirmesi yok) — mTLS el sıkışması REDDEDİLİR (fail-closed): EM yan-kanal riski çözülene kadar SAE↔KME bağlantısı açılmamalı`;
  } else if (emergencyBreach) {
    reason = `ACİL-DURUM TABANI İHLALİ: SE ${seDb.toFixed(1)} dB < ${EMERGENCY_SE_FLOOR_DB} dB (targetSeDb'nin KENDİSİ karşılanıyor olsa BİLE koşulsuz reddedilir) — mTLS el sıkışması REDDEDİLİR (fail-closed): fiziksel katman pratikte kalkansız, EM yan-kanal riski çözülene kadar SAE↔KME bağlantısı açılmamalı`;
  } else {
    reason = `fiziksel katman kalkanlama hedefi KARŞILANMIYOR (${cageEvaluation.detail}) — mTLS el sıkışması REDDEDİLİR (fail-closed): EM yan-kanal riski çözülene kadar SAE↔KME bağlantısı açılmamalı`;
  }
  return { allowed, emergencyBreach, targetMet, seDb: seDb === -Infinity ? null : +seDb.toFixed(2), reason };
}

/**
 * ODL/jitter hizalama önerisi: kirli (ESKİ kafes) ile temiz (YENİ kafes)
 * EM-darkProb'una göre optimal koinsidans penceresini karşılaştırır ve
 * ağ/zamanlama katmanına "önerilen pencere + beklenen kazanım" döndürür.
 */
function recommendJitterAlignment({ periodPs = 1000, jitterPs = 80, emDarkProbDirty, emDarkProbClean, thermalDarkProb = D.THERMAL_DARK_PROB_GROUND, yieldFraction = 0.95 }) {
  const darkDirty = D.combinedDarkProb(emDarkProbDirty, thermalDarkProb);
  const darkClean = D.combinedDarkProb(emDarkProbClean, thermalDarkProb);
  const dirty = D.findOptimalCoincidenceWindow({ periodPs, jitterPs, darkProb: darkDirty, yieldFraction });
  const clean = D.findOptimalCoincidenceWindow({ periodPs, jitterPs, darkProb: darkClean, yieldFraction });
  const windowNarrowedPct = dirty.optimal.windowPs > 0 ? +(((dirty.optimal.windowPs - clean.optimal.windowPs) / dirty.optimal.windowPs) * 100).toFixed(1) : 0;
  const qberImprovedPct = dirty.optimal.qberPct > 0 ? +(((dirty.optimal.qberPct - clean.optimal.qberPct) / dirty.optimal.qberPct) * 100).toFixed(1) : 0;
  return {
    dirty, clean, windowNarrowedPct, qberImprovedPct,
    detail: `ESKİ kafes (kirli EM): en dar uygun pencere ${dirty.optimal.windowPs} ps (${dirty.optimal.multiple}σ), QBER %${dirty.optimal.qberPct}. ` +
      `YENİ kafes (temiz): ${clean.optimal.windowPs} ps (${clean.optimal.multiple}σ) yeterli, QBER %${clean.optimal.qberPct} — ` +
      `pencere %${windowNarrowedPct} daraltılabilir, aynı verim hedefinde QBER %${qberImprovedPct} iyileşir (ODL zamanlama toleransı gevşer).`,
  };
}

module.exports = { mtlsHandshakePrecondition, recommendJitterAlignment, EMERGENCY_SE_FLOOR_DB };
