"use strict";
/**
 * detector_profile.js — Node katmanları için dedektör profili köprüsü (çekirdek v3).
 * ═══════════════════════════════════════════════════════════════════
 * Tek uygulama çekirdektedir (photonnet_core.js: validateDetectorConfig, activeDetectorProfile, …);
 * bu dosya yalnızca onu yeniden dışa aktarır ki katmanlar (linkEta, adaptif kalkan, mesh, sensör HAL)
 * çekirdekle AYNI etkin profili okusun — iki ayrı kopya/iki ayrı doğrulayıcı olmasın.
 * Değerler depo kökündeki config.json'dan gelir; bkz. docs/DETECTOR_PROFILE_DESIGN.md.
 *
 * Katmanlar profili ÇAĞRI ANINDA okur (modül yüklenirken değil): böylece bir test dosyası başta
 * setActiveDetectorProfile("ingaas") dediğinde, require sırasından bağımsız olarak her şey o profile geçer.
 */
const core = require("./photonnet_core.js");

/** Etkin profilin decoy modeli Y0'ı (pencere başına karanlık tıklama olasılığı). */
const baseY0 = (id) => core.activeDetectorProfile(id).darkCountProbPerWindow;
/** Etkin profilin dedektör verimi. */
const detectorEfficiency = (id) => core.activeDetectorProfile(id).efficiency;

/**
 * Bir test/betik belirli bir dedektöre göre kalibre edilmiş sayılar doğruluyorsa bunu AÇIKÇA beyan eder.
 * @param {string} id profil kimliği (config.json → detector.profiles)
 * @param {string} reason neden bu profil (rapora/konsola yazılır)
 */
function pinDetectorProfile(id, reason) {
  if (typeof reason !== "string" || !reason.trim()) throw new TypeError("pinDetectorProfile: gerekçe (reason) zorunlu");
  const p = core.setActiveDetectorProfile(id);
  return { id: p.id, label: p.label, efficiency: p.efficiency, darkCountProbPerWindow: p.darkCountProbPerWindow, reason };
}

module.exports = {
  activeDetectorProfile: core.activeDetectorProfile,
  setActiveDetectorProfile: core.setActiveDetectorProfile,
  listDetectorProfiles: core.listDetectorProfiles,
  validateDetectorConfig: core.validateDetectorConfig,
  configureDetectorProfiles: core.configureDetectorProfiles,
  onDetectorProfileChange: core.onDetectorProfileChange,
  detectorProfileSource: core.detectorProfileSource,
  baseY0, detectorEfficiency, pinDetectorProfile,
};
