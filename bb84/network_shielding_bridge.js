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
 */
const D = require("./shielded_detector_physics.js");

/**
 * mTLS EL SIKIŞMA ÖN-KOŞULU — fail-closed. cageEvaluation,
 * faraday_cage_shielding.js'nin evaluateFaradayCage() çıktısıdır.
 */
function mtlsHandshakePrecondition(cageEvaluation) {
  const allowed = !!(cageEvaluation && cageEvaluation.ok === true);
  return {
    allowed,
    reason: allowed
      ? `fiziksel katman kalkanlama hedefi karşılanıyor (marj +${cageEvaluation.marginDb} dB) — SAE↔KME mTLS el sıkışmasına İZİN VERİLİR`
      : `fiziksel katman kalkanlama hedefi KARŞILANMIYOR${cageEvaluation ? ` (${cageEvaluation.detail})` : " (kafes değerlendirmesi yok)"} — mTLS el sıkışması REDDEDİLİR (fail-closed): EM yan-kanal riski çözülene kadar SAE↔KME bağlantısı açılmamalı`,
  };
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

module.exports = { mtlsHandshakePrecondition, recommendJitterAlignment };
