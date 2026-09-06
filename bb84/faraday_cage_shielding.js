#!/usr/bin/env node
"use strict";
/**
 * faraday_cage_shielding.js — EK: Faraday kafesi elektromanyetik sızıntı
 * kalkanlama etkinliği modeli (donanım-güvenlik katmanı, çekirdeğe DOKUNMAZ)
 * ═══════════════════════════════════════════════════════════════════
 * Amaç: gerçek donanıma (lazer sürücü, dedektör ön-yükselteci, zaman-
 * damgası elektroniği) geçildiğinde, bu elektroniğin ürettiği bit-
 * korelasyonlu elektromanyetik (EM) emisyonların bir Faraday kafesiyle
 * ne kadar bastırıldığını, TEMPEST/EM yan-kanal tehdit modeliyle uyumlu
 * standart EMC (Schelkunoff) kalkanlama teorisiyle hesaplar.
 *
 * Neden gerekli: production_gate.js'in "yan-kanal monitörü" kriteri
 * QBER/dedektör-verimi üzerinden GÖZLEMLENEBİLEN yan kanalları yakalar
 * (bkz. detector_recalibration.js). Ama bir kafesin dışına sızan RF
 * emisyon üzerinden yapılan bir EM yan-kanal saldırısı, QBER'de HİÇBİR
 * İZ BIRAKMAZ — tamamen AYRI bir fiziksel güvence katmanı gerektirir.
 * Bu dosya o katmanı modeller.
 *
 * FİZİK (standart EMC/Schelkunoff kalkanlama teorisi — ör. H. Ott,
 * "Electromagnetic Compatibility Engineering"):
 *   Kalkanlama etkinliği (Shielding Effectiveness, SE) dB cinsinden:
 *     SE = A (soğurma kaybı) + R (yansıma kaybı) + B (çoklu-yansıma düzeltmesi)
 *   Bir Faraday kafesinin GERÇEK zayıf noktası düz duvar DEĞİL, en büyük
 *   açıklıktır (kaynak, havalandırma deliği, kapı contası, kablo geçişi)
 *   — "kesilmemiş dalga kılavuzu altı zayıflaması" yaklaşımıyla ayrıca
 *   modellenir ve düz-duvar/açıklık İKİ BAĞIMSIZ SIZINTI YOLU olarak
 *   güç alanında birleştirilir (en zayıf yol baskın olur).
 *
 * DÜRÜSTLÜK NOTU (HAL'deki binary_click_hardware.py ile aynı ilkeyle):
 *   Aşağıdaki malzeme sabitleri (σr, μr) ders kitabı/mühendislik el
 *   kitabı değerleridir, GERÇEK bir malzeme datasheet'i DEĞİLDİR —
 *   özellikle ferromanyetik malzemelerde (çelik, mu-metal) μr frekansla
 *   ve doyma ile GÜÇLÜ şekilde değişir; burada düşük-frekans/statik
 *   yaklaşık değerler kullanılmıştır. Gerçek bir kafes tasarımı için
 *   üreticinin ölçülmüş kalkanlama-etkinliği eğrileriyle doğrulanmalıdır.
 *   AYRICA: apertureLeakageDb() basit "delik derinliği YOK" yaklaşımıdır —
 *   gerçek dalga-kılavuzu-altı bal peteği (honeycomb) havalandırma
 *   filtreleri, delik derinliği/çapı oranıyla EK zayıflama sağlar (bu
 *   modelde YOK); yani bu fonksiyon düz bir deliğin EN KÖTÜ durumunu
 *   verir, gerçek bir honeycomb filtre bundan DAHA İYİ (daha çok
 *   zayıflatan) sonuç verebilir — bkz. faraday_cage_shielding_test.js (H).
 *
 * Bu modül photonnet_core.js'ten HİÇBİR ŞEY import ETMEZ ve çekirdeği
 * hiçbir şekilde değiştirmez — bağımsız, kendi başına test edilebilir
 * bir fizik hesaplayıcısıdır (bkz. faraday_cage_shielding_test.js).
 */

const C_MM_PER_S = 299792458 * 1000; // ışık hızı, mm/s

// ── Malzeme sabitleri (bakıra göreli σr, μr — ders kitabı/el kitabı değerleri) ──
const MATERIALS = {
  copper:   { label: "Bakır (Cu)",        sigmaR: 1.00, muR: 1 },
  aluminum: { label: "Alüminyum (Al)",    sigmaR: 0.61, muR: 1 },
  steel:    { label: "Yumuşak çelik (Fe)", sigmaR: 0.10, muR: 1000 },   // μr: düşük-frekans yaklaşık değer
  muMetal:  { label: "Mu-metal",          sigmaR: 0.03, muR: 20000 },  // μr: düşük-frekans yaklaşık değer
};

function material(name) {
  const m = MATERIALS[name];
  if (!m) throw new Error(`Bilinmeyen kalkan malzemesi: "${name}" — geçerli: ${Object.keys(MATERIALS).join(", ")}`);
  return m;
}

/** Soğurma kaybı A (dB) — Schelkunoff: A = 131.4 · t[mm] · √(f[MHz]·μr·σr) */
function absorptionLossDb(thicknessMm, freqHz, mat) {
  const fMHz = freqHz / 1e6;
  return 131.4 * thicknessMm * Math.sqrt(Math.max(fMHz, 0) * mat.muR * mat.sigmaR);
}

/** Yansıma kaybı R (dB) — uzak-alan düzlem dalga: R = 168 − 10·log10(μr·f[MHz]/σr) */
function reflectionLossDb(freqHz, mat) {
  const fMHz = freqHz / 1e6;
  return 168 - 10 * Math.log10((mat.muR * fMHz) / mat.sigmaR);
}

/** Çoklu-yansıma düzeltmesi B (dB) — yalnız A < 15 dB iken anlamlı, aksi hâlde ≈0. */
function multipleReflectionCorrectionDb(absorptionDb) {
  if (absorptionDb >= 15) return 0;
  const x = 1 - Math.pow(10, -absorptionDb / 10);
  if (x <= 1e-6) return -20; // dejenere durum (A≈0): pratikte kalkanlama yok say, sonsuza gitmesin
  return 20 * Math.log10(x);
}

/** Düz duvarın toplam kalkanlama etkinliği (dB) + bileşenleri. */
function solidWallShieldingDb(thicknessMm, freqHz, mat) {
  const A = absorptionLossDb(thicknessMm, freqHz, mat);
  const R = reflectionLossDb(freqHz, mat);
  const B = multipleReflectionCorrectionDb(A);
  return { A, R, B, totalDb: A + R + B };
}

/**
 * Açıklık (kaynak/delik/kapı contası) sızıntısı — "kesilmemiş dalga
 * kılavuzu" yaklaşımı: SE ≈ 20·log10(λ / (2·L)). L, açıklığın EN BÜYÜK
 * doğrusal boyutudur (alanı değil!) — EMC'nin en temel kuralı budur.
 * L ≥ λ/2 olduğunda açıklık rezonansa girer, kalkanlama etkin biçimde
 * SIFIRA (0 dB) düşer.
 */
function apertureLeakageDb(apertureMaxDimMm, freqHz) {
  if (apertureMaxDimMm <= 0) return Infinity; // açıklık yok → bu yoldan sızıntı yok
  const lambdaMm = C_MM_PER_S / freqHz;
  const ratio = lambdaMm / (2 * apertureMaxDimMm);
  if (ratio <= 1) return 0; // rezonans/üstü: kalkanlama yok
  return 20 * Math.log10(ratio);
}

/**
 * Bağımsız sızıntı yollarını GÜÇ alanında birleştir: her yoldan sızan
 * güç oranı 10^(-SE/10)'dur; toplam sızıntı bu oranların TOPLAMIdır
 * (en zayıf yol baskın çıkar). SE=Infinity olan yol (sızıntı yolu yok)
 * toplam sızıntıya hiç katkı vermez.
 */
function combineShieldingPathsDb(seDbList) {
  const totalLeak = seDbList.reduce((sum, se) => sum + (se === Infinity ? 0 : Math.pow(10, -se / 10)), 0);
  if (totalLeak <= 0) return Infinity;
  return -10 * Math.log10(totalLeak);
}

/**
 * ANA GİRİŞ NOKTASI — bir Faraday kafesi tasarımını, verilen tehdit
 * frekansı/frekans aralığında değerlendirir.
 *
 * @param {Object} cfg
 *   materialName: 'copper'|'aluminum'|'steel'|'muMetal'
 *   thicknessMm: duvar kalınlığı (mm)
 *   apertureMaxDimMm: en büyük açıklığın en büyük doğrusal boyutu (mm) — 0 = açıklık yok
 *   freqHz: değerlendirilecek tek frekans (Hz) — VEYA freqRangeHz: [f1, f2, ...]
 *   targetSeDb: hedef minimum kalkanlama etkinliği (dB) — bir tasarım/tehdit-modeli
 *     parametresidir, sertifikalı bir standart DEĞİLDİR; çağıran taraf belirler
 *     (varsayılan 60 dB: yaygın kullanılan orta-düzey RF-sızdırmazlık hedefi).
 */
function evaluateFaradayCage(cfg) {
  const mat = material(cfg.materialName);
  const freqs = cfg.freqRangeHz && cfg.freqRangeHz.length ? cfg.freqRangeHz : [cfg.freqHz];
  const targetSeDb = cfg.targetSeDb != null ? cfg.targetSeDb : 60;
  const apertureMaxDimMm = cfg.apertureMaxDimMm || 0;

  const perFreq = freqs.map((freqHz) => {
    const wall = solidWallShieldingDb(cfg.thicknessMm, freqHz, mat);
    const apertureSeDb = apertureMaxDimMm > 0 ? apertureLeakageDb(apertureMaxDimMm, freqHz) : Infinity;
    const combinedSeDb = combineShieldingPathsDb([wall.totalDb, apertureSeDb]);
    const bottleneck = apertureSeDb < wall.totalDb ? "aperture" : "wall";
    return { freqHz, wallSeDb: wall.totalDb, apertureSeDb, combinedSeDb, bottleneck, wall };
  });

  const worst = perFreq.reduce((a, b) => (b.combinedSeDb < a.combinedSeDb ? b : a));
  const ok = worst.combinedSeDb >= targetSeDb;
  const marginDb = +(worst.combinedSeDb - targetSeDb).toFixed(1);

  const fMHzStr = (hz) => (hz / 1e6 >= 1 ? `${(hz / 1e6).toFixed(1)} MHz` : `${(hz / 1e3).toFixed(0)} kHz`);
  const detail = ok
    ? `en zayıf nokta ${fMHzStr(worst.freqHz)}'de ${worst.bottleneck === "aperture" ? "açıklık" : "duvar"} — birleşik SE ${worst.combinedSeDb.toFixed(1)} dB ≥ hedef ${targetSeDb} dB (marj +${marginDb} dB)`
    : `en zayıf nokta ${fMHzStr(worst.freqHz)}'de ${worst.bottleneck === "aperture" ? `açıklık (en büyük boyut ${apertureMaxDimMm} mm)` : "duvar kalınlığı/malzemesi"} — birleşik SE ${worst.combinedSeDb.toFixed(1)} dB < hedef ${targetSeDb} dB (açık ${Math.abs(marginDb)} dB)`;

  return { ok, targetSeDb, marginDb, worst, perFreq, material: mat.label, thicknessMm: cfg.thicknessMm, apertureMaxDimMm, detail };
}

/**
 * Kaynak emisyon seviyesi + kalkanlama + gözlemci mesafesindeki serbest-
 * uzay yayılım kaybını birleştirip, bit-korelasyonlu bir EM emisyonun
 * kafesin DIŞINDA gözlemcinin gürültü tabanının ÜZERİNDE kalıp
 * kalmadığını (yani hâlâ tespit edilebilir olup olmadığını) değerlendirir.
 * Serbest-uzay yol kaybı (Friis, dB): FSPL = 20·log10(4πd·f/c).
 */
function emissionDetectabilityCheck({ sourceLevelDbuVm, cage, observerDistanceM, noiseFloorDbuVm }) {
  const gate = evaluateFaradayCage(cage);
  const freqHz = gate.worst.freqHz;
  const fspl = 20 * Math.log10((4 * Math.PI * observerDistanceM * freqHz) / (C_MM_PER_S / 1000));
  const receivedDbuVm = sourceLevelDbuVm - gate.worst.combinedSeDb - fspl;
  const detectable = receivedDbuVm > noiseFloorDbuVm;
  return {
    detectable, receivedDbuVm: +receivedDbuVm.toFixed(1), noiseFloorDbuVm, fsplDb: +fspl.toFixed(1),
    cageResult: gate,
    detail: detectable
      ? `kafes SONRASI sinyal ${receivedDbuVm.toFixed(1)} dBµV/m, ${observerDistanceM} m'de gürültü tabanının (${noiseFloorDbuVm} dBµV/m) ÜZERİNDE — EM yan-kanal tespit edilebilir kalır`
      : `kafes SONRASI sinyal ${receivedDbuVm.toFixed(1)} dBµV/m, ${observerDistanceM} m'de gürültü tabanının (${noiseFloorDbuVm} dBµV/m) ALTINDA — EM yan-kanal bastırılmış`,
  };
}

module.exports = {
  MATERIALS, material,
  absorptionLossDb, reflectionLossDb, multipleReflectionCorrectionDb, solidWallShieldingDb,
  apertureLeakageDb, combineShieldingPathsDb,
  evaluateFaradayCage, emissionDetectabilityCheck,
};
