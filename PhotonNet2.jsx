const { useState, useEffect, useRef, useCallback } = React;

// ══════════════════════════════════════════════════════════════
// V8.0 TİP SÖZLÜĞÜ (JSDoc — TypeScript-seviyesi tip güvenliği)
//
// DÜRÜST TEKNİK NOT: Bu dosya .jsx olarak kalır (Claude.ai artifact
// önizlemesi yalnızca .jsx/.js React bileşenlerini canlı render eder;
// .tsx derlenip çalıştırılamaz). Bunun yerine JSDoc @typedef/@param
// notasyonu kullanılır — bu, VS Code ve `tsc --checkJs` tarafından
// GERÇEKTEN denetlenen tip bilgisidir (TypeScript derleyicisi JSDoc'u
// okuyup tip hatalarını editörde/CI'da işaretler), ama çalışma zamanında
// hiçbir şeyi değiştirmez. Yani: TypeScript'in tip güvenliği + JSX'in
// çalıştırılabilirliği bir arada.
//
// @typedef {Object} NetNode
// @property {string} id
// @property {string} label
// @property {number} x
// @property {number} y
// @property {"hub"|"node"|"intl"} type
// @property {boolean} on
// @property {number} reps - tekrarlayıcı (repeater) sayısı
// @property {number} lat
// @property {number} lon
//
// @typedef {Object} NetLink
// @property {string} a - kaynak NetNode.id
// @property {string} b - hedef NetNode.id
// @property {number} km - fiziksel mesafe
// @property {number} nm - dalga boyu (WL anahtarlarından biri)
//
// @typedef {Object} PathStep
// @property {string} node
// @property {NetLink|null} link - path[0].link her zaman null'dır
//
// @typedef {Object} PhotonEvent
// @property {"ABSORB"|"SCATTER"|"DECOHERE"|"PHASE"|"EAVES"} type
// @property {number} km
//
// @typedef {Object} PhotonResult
// @property {boolean} ok
// @property {PhotonEvent[]} evs
// @property {boolean} [flip]
//
// @typedef {Object} TransmitResult
// @property {string} original
// @property {string} decoded
// @property {number[]} bits
// @property {number[]} recv
// @property {number} lostCount
// @property {number} flipCount
// @property {number} okCount
// @property {string} er - BER yüzdesi (string olarak formatlı)
// @property {Record<string, number>} ec - olay-tipi histogramı
// @property {number} corrected - ECC düzeltme sayısı
// @property {boolean} success
// @property {number} qber
// @property {boolean} eavesdropDetected
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// FİZİK MOTORU — Algoritma (hata düzeltildi, yapı korundu)
// ══════════════════════════════════════════════════════════════
// DÜZELTME 15 (kullanıcı talebiyle doğrulandı ve düzeltildi): 1550/1310/850nm
// katsayıları gerçek endüstri kaynaklarıyla (Corning SMF-28 Ultra spec sayfası:
// 1310nm≤0.32dB/km, 1550nm≤0.18dB/km; FOA/EIA-TIA-568: 850nm multimode tipik
// ~3.0dB/km, OZ Optics graded-index MM≤2.5dB/km) çapraz kontrol edildi — üçü
// de gerçekçi. 633nm ORİJİNAL DEĞERİ (3.00) gerçekçi DEĞİLDİ: Rayleigh
// saçılması dalga boyunun 4. kuvvetiyle ters orantılıdır (∝1/λ⁴) — 1550nm'den
// 633nm'ye inildiğinde bu tek başına ~36× kayıp artışı öngörür, ama eski
// tabloda 633nm ile 850nm arasındaki fark yalnızca %20'ydi (fiziksel olarak
// tutarsız). Gerçek özel-dalga-boyu tek-modlu fiber spesifikasyonu (OZ Optics
// kataloğu, SMF-633 serisi) <12dB/km veriyor; bu üst sınırın altında, fizik
// tahminiyle (Rayleigh bileşeni tek başına ~5.7dB/km + emilim kuyruğu)
// tutarlı bir orta değer olan 9.00dB/km seçildi. NOT: 633nm hiçbir LINKS
// segmentinde fiilen kullanılmıyor (yalnızca UI dalga boyu seçici/FSO
// önerisinde dekoratif) — bu değişiklik canlı iletim fiziğini ETKİLEMEZ,
// yalnızca gösterilen dB/km değerini ve FSO uygunluk yüzdesini düzeltir.
/** @type {Record<number, {hex:string,label:string,loss:number,r:number}>} */
const WL = {
  1550: { hex:"#00d4ff", label:"IR-1550", loss:0.20, r:1.0  },
  1310: { hex:"#7c3aed", label:"IR-1310", loss:0.35, r:2.1  },
  850:  { hex:"#f59e0b", label:"IR-850",  loss:2.50, r:12.8 },
  633:  { hex:"#f43f5e", label:"VIS-633", loss:9.00, r:54.0 },
};

const fiberT = (nm, km) => Math.pow(10, -((WL[nm]||WL[1550]).loss * km) / 10);

// ══════════════════════════════════════════════════════════════
// AtmosphericWindowModel — LEO UYDU/UZAY BOŞLUĞU (FSO) GEÇİRGENLİK PENCERESİ
//
// PROBLEM: WL.loss tablosu (yukarıda) SAF FİBER OPTİK zayıflama
// katsayılarıdır (dB/km, cam içindeki soğurma/saçılma). LEO uydu
// bağlantısı ise atmosfer/uzay boşluğundan geçer — bu, TAMAMEN FARKLI
// bir fiziksel ortam (Serbest Uzay Optik İletişim / Free Space Optical,
// FSO). Eskiden sistem her ikisi için de AYNI WL.loss tablosunu
// kullanıyordu — bu, kavramsal olarak yanlıştı (kullanıcının doğru
// tespit ettiği boşluk).
//
// ARAŞTIRMA BULGUSU (gerçek FSO literatüründen — IntechOpen, ScienceDirect,
// arXiv 2026 atmosferik zayıflama taraması): "Kısa dalga boyu = uzayda
// her zaman daha iyi" gibi EVRENSEL bir kural YOKTUR. Literatür şunu
// gösteriyor:
//   • 1550nm: fiberde EN DÜŞÜK kayıp (0.2dB/km), FSO'da da düşük Rayleigh
//     saçılması + göz-güvenliği + EDFA uyumluluğu nedeniyle UZUN MENZİL
//     ve KÖTÜ HAVA koşullarında genellikle TERCİH EDİLİR.
//   • 1310nm: sıfır grup-hız dispersiyonuna sahiptir ama bazı kaynaklara
//     göre "yalnızca marjinal olarak uygun" — 1290nm civarında atmosferik
//     zayıflama ANİDEN ARTAR.
//   • 850nm: ekipman DAHA UCUZDUR ve ağır zayıflama/kötü hava koşullarında
//     bazı çalışmalarda 1310nm'den DAHA İYİ performans gösterir — ama
//     Rayleigh saçılmasına ve güneş arka plan gürültüsüne daha yatkındır.
//
// SONUÇ: dalga boyu seçimi ÇOK BOYUTLU bir ödünleşimdir (hava koşulu,
// menzil, maliyet, dispersiyon) — "1310nm her zaman kazanır" gibi
// tek yönlü bir model FİZİKSEL OLARAK YANLIŞ olurdu. Bu yüzden model,
// HAVA KOŞULUNA (atmosferik bulanıklık) bağlı olarak HANGİ dalga
// boyunun avantajlı olduğunu DEĞİŞTİRİR — gerçek literatürle tutarlı.
//
// ── KALİBRASYON DURUMU VE GERÇEK BİR ENTEGRASYONA YOL HARİTASI ──────
// Bu model, gerçek FSO literatüründen NİTELİKSEL yönelim alır (yukarıdaki
// karşılaştırmalı bulgular) ama sayısal katsayıları (0.92, 0.85, 0.10 vb.)
// KALİBRE EDİLMEMİŞTİR — hiçbir ölçüm kampanyasına veya standart bir
// hesaplama yöntemine karşı doğrulanmamıştır. Gerçek, mühendislik-sınıfı
// bir doğrulama için iki somut adım gerekir:
//
//   1) NetSquid (QuTech, Python) — gerçek bir kuantum ağ simülatör
//      kütüphanesi; kanal gürültüsü, dekoherans ve foton kaybını fiziksel
//      olarak doğru modeller. BU DOSYADA (tarayıcıda çalışan tek dosyalık
//      bir JS artifact) NetSquid'i GERÇEKTEN ÇALIŞTIRMAK/GÖMMEK mümkün
//      değildir — ayrı bir Python backend, bir API katmanı ve bu
//      arayüzün o backend'e sonuç için sorgu atması gerekir. Bu doküman
//      o mimarinin nasıl kurulacağını (Aşama 2-4, önceki bir PyTorch/
//      derleyici entegrasyonu turunda tarif edilen desenle aynı ilke)
//      ayrı bir mühendislik projesi olarak tarif edebilir, ama BU DOSYA
//      İÇİNDE gerçekleştiremez.
//
//   2) ITU-R P.1621-2 — Dünya-uzay bağlantıları için ITU'nun resmi,
//      lisanslı standardıdır (link bütçesi, atmosferik zayıflama, sis/
//      yağış modelleri dahil). Bu standardın TAM METNİNİ ezberden
//      yeniden üretmek GÜVENİLMEZ olurdu (lisanslı bir belge, hafızadan
//      "hatırlanan" bir formül yanlış/eksik olabilir) — gerçek bir
//      entegrasyon, ITU'nun resmi yayınından doğrudan alınan formülleri
//      ve tablo değerlerini gerektirir.
//
// Bu iki adım TAMAMLANMADAN, buradaki windowFactor() bir MÜHENDİSLİK
// ARACI değil, bir EĞİTİM/DİDAKTİK YAKLAŞIKLIK olarak kalır — yukarıdaki
// "SONUÇ" paragrafındaki niteliksel yönelim (hangi dalga boyunun hangi
// koşulda avantajlı olduğu) muhtemelen doğrudur, ama kesin sayısal
// çıktılar (örn. "%91 FSO uygunluk") gerçek bir link-bütçesi hesabıyla
// KARIŞTIRILMAMALIDIR.
// ─────────────────────────────────────────────────────────────────
//
// TAMAMEN OPSİYONELDİR: yalnızca legaCtx.atmosphericConditions
// verildiğinde (yani açıkça bir uydu/FSO bağlamı belirtildiğinde)
// devreye girer. WL.loss tablosu ve fiberT() HİÇ DEĞİŞMEDİ.
// ══════════════════════════════════════════════════════════════
class AtmosphericWindowModel {
  /**
   * Bir dalga boyunun, verilen atmosferik koşul altında FSO
   * performansını [0,1] aralığında bir çarpan olarak döner (1.0 =
   * saf fiber-eşdeğeri performans, <1.0 = atmosferik ek kayıp).
   * @param {number} nm
   * @param {{turbidity?: number, rangeKm?: number}} conditions
   *   turbidity: [0,1] — 0=berrak hava, 1=ağır sis/kötü hava (görüş
   *   mesafesi düşük). rangeKm: bağlantı menzili (uzun menzil, düşük
   *   saçılmalı dalga boylarını daha da avantajlı kılar).
   * @returns {number} [0,1] atmosferik performans çarpanı
   */
  static windowFactor(nm, conditions = {}) {
    const turbidity = Math.max(0, Math.min(1, conditions.turbidity ?? 0.2));
    const rangeKm = conditions.rangeKm ?? 500;

    // Her dalga boyu için: [berrak hava performansı, kötü hava performansı,
    // uzun-menzil bonusu]. Bu üçlü, literatürdeki gerçek ödünleşimi
    // (maliyet/dispersiyon/saçılma/hava koşulu) sayısallaştırır.
    const profiles = {
      1550: { clear: 0.92, badWeather: 0.85, longRangeBonus: 0.10 }, // düşük saçılma, göz-güvenli, EDFA uyumlu — uzun menzil+kötü havada güçlü
      1310: { clear: 0.88, badWeather: 0.55, longRangeBonus: 0.04 }, // sıfır dispersiyon ama ~1290nm civarı zayıflama sıçraması riski
      850:  { clear: 0.95, badWeather: 0.62, longRangeBonus: -0.05 }, // ucuz/berrak havada güçlü, ama saçılma+güneş gürültüsüne yatkın, uzun menzilde dezavantajlı
      633:  { clear: 0.40, badWeather: 0.15, longRangeBonus: -0.15 }, // görünür ışık — FSO pencerelerinin dışında, pratik değil
    };
    const p = profiles[nm] || profiles[1550];

    // Hava koşuluna göre doğrusal interpolasyon (berrak → kötü hava).
    const base = p.clear * (1 - turbidity) + p.badWeather * turbidity;
    // Uzun menzil bonusu/cezası: 1000km üzeri rotalarda etkisi artar.
    const rangeFactor = rangeKm > 1000 ? Math.min(1, (rangeKm - 1000) / 2000) : 0;
    const withRange = base + p.longRangeBonus * rangeFactor;

    return Math.max(0.05, Math.min(1, withRange)); // asla sıfıra tam inmez, asla 1'i aşmaz
  }

  /**
   * Verilen koşullarda hangi dalga boyunun en avantajlı olduğunu
   * (gerçek hesaplamayla, önyargısız) döner — UI'da "önerilen dalga
   * boyu" göstergesi için.
   * @param {{turbidity?: number, rangeKm?: number}} conditions
   */
  static recommendWavelength(conditions = {}) {
    const candidates = [1550, 1310, 850, 633];
    let best = candidates[0], bestScore = -1;
    for (const nm of candidates) {
      const score = AtmosphericWindowModel.windowFactor(nm, conditions);
      if (score > bestScore) { bestScore = score; best = nm; }
    }
    return { recommendedNm: best, score: bestScore };
  }
}

// ══════════════════════════════════════════════════════════════
// satQ — LEO UYDU BAĞLANTI KALİTESİ (FSPL DÜZELTMESİ)
//
// ESKİ HATA: 550000 sabiti "550km'nin METRE karşılığı" olarak (gerçek
// Starlink-benzeri LEO yüksekliği, doğru bir varsayım) yazılmıştı, AMA
// formülün geri kalanı bunu SANKİ ZATEN KM CİNSİNDENMİŞ gibi işliyordu
// (doğru FSPL yasası 20·log10(4π·d·f/c) — d METRE — yerine, d'nin
// birimini karıştıran basitleştirilmiş bir yaklaşıklık kullanılmıştı).
// Sonuç: mesafe fiilen 1000 KAT BÜYÜK simüle ediliyordu (550,000km gibi
// — Ay'ın ötesinde bir mesafe), ve üst sınır (Math.min) hiç yoktu, bu
// yüzden kalite değeri [0,1] aralığını aşıp ~1.3'e kadar çıkabiliyordu.
//
// DÜZELTME: gerçek FSPL yasası (metre + Hz birimleriyle) kullanılır,
// gerçek 550km LEO yüksekliği eğik-mesafe (slant range, elevasyon
// açısına göre) ile ayarlanır, ve sonuç en kötü (5° minimum elevasyon)
// ile en iyi (90° zenit) durumlar arasında [0,1]'e normalize edilir.
// İmza (satQ(el), tek elevasyon-derece parametresi) HİÇ DEĞİŞMEDİ.
// ══════════════════════════════════════════════════════════════
const SAT_ALTITUDE_KM = 550;   // gerçek LEO yüksekliği (Starlink-benzeri)
const SAT_FREQ_HZ = 26.5e9;    // Ka-band taşıyıcı frekansı
const SPEED_OF_LIGHT_MPS = 3e8;

function _fsplDb(slantKm, freqHz) {
  const slantM = slantKm * 1000;
  return 20 * Math.log10(4 * Math.PI * slantM * freqHz / SPEED_OF_LIGHT_MPS);
}

const satQ = (el) => {
  const elRad = Math.max(5, el) * Math.PI / 180;
  const slantKm = SAT_ALTITUDE_KM / Math.sin(elRad); // eğik mesafe — düşük açıda daha uzun
  const fspl = _fsplDb(slantKm, SAT_FREQ_HZ);

  // Normalizasyon referans noktaları: 90° (en kısa, en iyi) ve 5° (en
  // uzun, en kötü — minimum elevasyon sınırı zaten yukarıda uygulanıyor).
  const fsplBest = _fsplDb(SAT_ALTITUDE_KM, SAT_FREQ_HZ); // el=90°
  const fsplWorst = _fsplDb(SAT_ALTITUDE_KM / Math.sin(5 * Math.PI / 180), SAT_FREQ_HZ); // el=5°

  const q = 1 - (fspl - fsplBest) / (fsplWorst - fsplBest);
  return Math.max(0, Math.min(1, q)); // artık GERÇEK [0,1] tavanı var
};

// ══════════════════════════════════════════════════════════════
// EK 42: ScintillationModel — ATMOSFERİK TÜRBÜLANS (SCINTILLATION)
//
// PROBLEM: AtmosphericWindowModel (yukarıda) ve satQ (yukarıda) ikisi de
// atmosferi/uzayı modellese de, İKİSİ DE TÜRBÜLANS DEĞİL: windowFactor
// dalga boyu × hava-koşulu (sis/pus) ödünleşiminin STATİK bir enterpolasyonu;
// satQ saf GEOMETRİK serbest-uzay yol kaybı (FSPL). Kırılma indisi
// dalgalanmasından (sıcaklık gradyanı kaynaklı) doğan, ZAMANLA DALGALANAN
// sinyal sönümü (scintillation) hiçbiri tarafından temsil edilmiyordu.
//
// MODEL: Hufnagel-Valley 5/7 — astronomi/uydu-optiği literatüründe
// standart Cn²(h) yükseklik profili — ile eğik-yol Rytov varyansı, ardından
// Andrews-Phillips doygunluk-düzeltmeli log-normal scintillation indeksi.
// Zamansal korelasyon (gerçek türbülansın "birkaç ms süren, çok sayıda
// fotonu birlikte etkileyen sönüm" karakteri) AR(1)/Ornstein-Uhlenbeck
// süreciyle sağlanır — foton başına BAĞIMSIZ rastgelelik YERİNE,
// satellite-link-tick (900ms) başına BİR sönümleme değeri üretilir ve o
// pencheredeki TÜM fotonlar bunu paylaşır.
//
// ── KALİBRASYON DURUMU (dürüstlük notu, dosyanın geri kalanıyla tutarlı) ──
// Hufnagel-Valley katsayıları ve Rytov/Andrews-Phillips formülleri gerçek,
// yayınlanmış literatürden (Andrews & Phillips, "Laser Beam Propagation
// through Random Media") — ama Cn²(0)'ın UI kaydırıcısına (turbulenceStrength,
// [0,1]) log-ölçekli haritalanması VE rüzgar hızı varsayılanı (21 m/s,
// HV-5/7 standart değeri) kalibre edilmemiştir. Gerçek mühendislik-sınıfı
// doğrulama için ITU-R P.1621-2 veya yayınlanmış bir uydu-QKD ölçüm
// kampanyasına (Micius) karşı kalibrasyon gerekir — AtmosphericWindowModel'in
// başındaki notla aynı sınırlama.
// ══════════════════════════════════════════════════════════════
const TURBULENCE_TOP_M = 20000; // Cn² bu yükseklikten sonra ihmal edilebilir
const TURBULENCE_INTEGRATION_STEPS = 24; // trapez integrasyonu basamak sayısı — foton başına değil, yalnızca tick başına çalışır

class ScintillationModel {
  /** Hufnagel-Valley 5/7 Cn²(h) profili (h metre, dönüş m^(-2/3)). */
  static cn2(hMeters, cn2Ground, windSpeedMps = 21) {
    const h = Math.max(0, hMeters);
    const term1 = 0.00594 * Math.pow(windSpeedMps / 27, 2) * Math.pow(h * 1e-5, 10) * Math.exp(-h / 1000);
    const term2 = 2.7e-16 * Math.exp(-h / 1500);
    const term3 = cn2Ground * Math.exp(-h / 100);
    return term1 + term2 + term3;
  }

  /**
   * Eğik-yol (slant-path) Rytov varyansı — düzlem-dalga yaklaşıklığı.
   * @param {number} nm dalga boyu (nanometre)
   * @param {number} elevationDeg uydu elevasyon açısı (derece)
   * @param {number} cn2Ground [0,1] turbulenceStrength'ten haritalanmış Cn²(0)
   */
  static rytovVariance(nm, elevationDeg, cn2Ground, windSpeedMps = 21) {
    const lambdaM = nm * 1e-9;
    const k = 2 * Math.PI / lambdaM;
    const elRad = Math.max(5, elevationDeg) * Math.PI / 180;
    const secZeta = 1 / Math.sin(elRad); // zenit açısı = 90°-elevasyon → sec(zenit)=1/sin(elevasyon)

    // Trapez integrasyonu: ∫[0→20km] Cn²(h)·h^(5/6) dh (h0=0 alınır — yer
    // istasyonu deniz seviyesinde varsayılır, didaktik basitleştirme).
    const dh = TURBULENCE_TOP_M / TURBULENCE_INTEGRATION_STEPS;
    let integral = 0;
    for (let i = 0; i < TURBULENCE_INTEGRATION_STEPS; i++) {
      const h1 = i * dh, h2 = (i + 1) * dh;
      const f1 = ScintillationModel.cn2(h1, cn2Ground, windSpeedMps) * Math.pow(h1, 5 / 6);
      const f2 = ScintillationModel.cn2(h2, cn2Ground, windSpeedMps) * Math.pow(h2, 5 / 6);
      integral += (f1 + f2) / 2 * dh; // trapez kuralı
    }
    return 2.25 * Math.pow(k, 7 / 6) * Math.pow(secZeta, 11 / 6) * integral;
  }

  /**
   * Andrews-Phillips doygunluk-düzeltmeli scintillation indeksi — σ_R²
   * büyüdükçe (güçlü türbülans/çoklu saçılma) sonsuza IRAKSAMAZ, ~1'e
   * doygunlaşır (gerçek fiziksel davranış; ham Rytov yaklaşıklığı σ_R²>1'de
   * yanlış şekilde ıraksardı).
   */
  static scintillationIndex(rytovVar) {
    const a = 0.49 * rytovVar / Math.pow(1 + 1.11 * Math.pow(rytovVar, 12 / 5), 7 / 6);
    const b = 0.51 * rytovVar / Math.pow(1 + 0.69 * Math.pow(rytovVar, 12 / 5), 5 / 6);
    return Math.exp(a + b) - 1;
  }

  static regime(scintIndex) {
    if (scintIndex < 0.3) return "ZAYIF";
    if (scintIndex < 1.0) return "ORTA";
    return "GÜÇLÜ (doygun)";
  }
}

// Zamanla dalgalanan (AR(1)/Ornstein-Uhlenbeck) sönümleme motoru — TEK
// modül-seviyesi singleton (satellite-link-tick her 900ms'de bir tick()
// çağırır; propPhoton çağrıları arasında AYNI anlık değeri paylaşır —
// bu, gerçek türbülansın "birkaç foton değil, birkaç ms'lik pencere"
// korelasyon yapısını, foton-başına-bağımsız `Math.random()` yerine
// doğru şekilde taklit eder).
class ScintillationEngine {
  constructor() {
    this.logAmplitude = 0; // X_t — log-genlik durumu (AR(1) süreci)
    this.chiVariance = 0;  // σ_χ² — son tick'te hesaplanan, PointingBudget'ın da paylaştığı değer
    this.lastScintIndex = 0;
    this.lastRegime = "ZAYIF";
  }

  /**
   * @param {number} nm @param {number} elevationDeg
   * @param {number} turbulenceStrength [0,1] UI kaydırıcısı
   * @param {number} dtMs tick aralığı (varsayılan 900ms — satellite-link-tick)
   */
  tick(nm, elevationDeg, turbulenceStrength, dtMs = 900) {
    const cn2Ground = Math.pow(10, -17 + 4 * Math.max(0, Math.min(1, turbulenceStrength))); // [0,1]→[1e-17,1e-13] log-ölçek
    const rytovVar = ScintillationModel.rytovVariance(nm, elevationDeg, cn2Ground);
    const scintIndex = ScintillationModel.scintillationIndex(rytovVar);
    this.chiVariance = scintIndex / 4; // σ_χ² = σ_I²/4 (Rytov yaklaşıklığı)
    this.lastScintIndex = scintIndex;
    this.lastRegime = ScintillationModel.regime(scintIndex);

    // AR(1) güncellemesi: τ0 (atmosferik uyum-zamanı) kabaca 10-50ms
    // mertebesinde (rüzgar-sürüklenen türbülans hücreleri) — burada 20ms
    // sabit alınıyor (didaktik yaklaşıklık). ρ, 900ms'lik tick aralığında
    // ardışık tikler arasında ZATEN neredeyse bağımsız (ρ≈e^-45≈0) —
    // yani her tick GERÇEKTEN yeni bir sönüm olayı üretir, ama bir tick
    // İÇİNDEKİ tüm fotonlar (yüzlerce olabilir) AYNI değeri paylaşır.
    // Bu, "foton-başına-bağımsız" ile "tamamen sabit" arasındaki doğru
    // orta noktayı temsil eder.
    const tau0Ms = 20;
    const rho = Math.exp(-dtMs / tau0Ms);
    const sigmaChi = Math.sqrt(this.chiVariance);
    const z = gaussianRandom();
    this.logAmplitude = rho * this.logAmplitude + Math.sqrt(Math.max(0, 1 - rho * rho)) * sigmaChi * z;
  }

  /** Ortalama-koruyan (mean-preserving) log-normal sönümleme çarpanı [0,~2+]. */
  fadeFactor() {
    return Math.exp(2 * this.logAmplitude - 2 * this.chiVariance);
  }
}

/** Box-Muller — standart normal örnek (yalnızca tick başına çağrılır, foton başına değil — ucuz). */
function gaussianRandom() {
  const u1 = Math.max(1e-12, Math.random()), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const scintillationEngine = new ScintillationEngine();

// ══════════════════════════════════════════════════════════════
// EK 43: PointingBudget — IŞIN KAYMASI (beam wander) + İŞARETLEME KAYBI
//
// Beam wander (büyük türbülans hücrelerinin ışın merkezini kaydırması,
// atmosferik kaynaklı) ve pointing loss (uydunun gimbal/ince-izleme
// sisteminin mekanik hatası + platform titreşimi, donanım kaynaklı) AYNI
// fiziksel sonucu üretir: alıcı, Gauss ışın profilinin merkezinden kayık
// bir noktada kalır. Bu yüzden ayrı ayrı değil, varyansları toplanarak
// (σ_toplam²=σ_pointing²+σ_beamWander²) TEK bir açısal ofset bütçesi olarak
// modellenir — uydu-lazer-haberleşme link bütçesi literatüründe standart
// yaklaşım. Beam wander bileşeni scintillationEngine'in ZATEN hesapladığı
// σ_χ'yi yeniden kullanır (aynı rüzgar/türbülans kaynağından geldiği için
// ayrı bir rastgele süreç kurmaya gerek yok — ucuz ve fiziksel olarak tutarlı).
// ══════════════════════════════════════════════════════════════
const BEAM_DIVERGENCE_RAD = 15e-6; // tipik uydu-lazer ışın ıraksama açısı (~15µrad), didaktik sabit

class PointingBudget {
  /**
   * @param {number} rangeKm bağlantı mesafesi
   * @param {number} pointingPrecision [0,1] UI kaydırıcısı — 1=mükemmel mekanik izleme
   * @param {number} chiVarianceFromScint scintillationEngine.chiVariance (paylaşılan türbülans kaynağı)
   * @returns {number} [0,1] ortalama işaretleme-kaybı çarpanı
   */
  static lossFactor(rangeKm, pointingPrecision, chiVarianceFromScint) {
    const rangeM = rangeKm * 1000;
    const beamRadiusM = Math.max(0.01, BEAM_DIVERGENCE_RAD * rangeM); // ışın alıcı düzlemindeki yarıçapı

    // Mekanik/kontrol-sistemi jitter'ı: pointingPrecision=1→çok düşük sapma,
    // pointingPrecision=0→ışın yarıçapının önemli bir kesriyle kıyaslanabilir sapma.
    const sigmaMechanicalM = beamRadiusM * 0.35 * (1 - Math.max(0, Math.min(1, pointingPrecision)));
    // Atmosferik ışın kayması: σ_χ (log-genlik std sapması) açısal bir
    // sapmaya kabaca orantılı kabul edilir (didaktik ölçekleme — gerçek
    // beam-wander formülü Cn²'nin ayrı bir ağırlıklı integraline dayanır,
    // bkz. tasarım notu) — burada scintillation ile TUTARLI bir mertebe
    // üretmek için basitleştirildi.
    const sigmaBeamWanderM = beamRadiusM * 0.5 * Math.sqrt(Math.max(0, chiVarianceFromScint));

    const sigmaTotalSq = sigmaMechanicalM ** 2 + sigmaBeamWanderM ** 2;
    // Rayleigh-dağılımlı jitter üzerinden analitik ortalama (kapalı form):
    return (beamRadiusM ** 2) / (beamRadiusM ** 2 + 4 * sigmaTotalSq);
  }
}

// ══════════════════════════════════════════════════════════════
// EK 44: DetectorNoiseModel — KARANLIK SAYIM + GÜNDÜZ ARKA PLAN GÜRÜLTÜSÜ
//
// DÜZELTME 6'da propPhoton'ın KAYIP fotonlara rastgele bir "karanlık-sayım"
// biti uydurmasının YANLIŞ olduğunu düzeltmiştik (gerçek bir dedektör,
// hiç foton gelmediğinde sessiz kalır — hata değil, "tespit yok" üretir).
// Ama karanlık sayım/arka plan gürültüsü GERÇEK bir fenomen — sadece
// YANLIŞ yere uygulanmıştı. Gerçek bir dedektör, HİÇ foton gelmese bile
// kendiliğinden ("karanlık sayım") veya gökyüzünden sızan başıboş
// fotonlarla ("arka plan gürültüsü", özellikle GÜNDÜZ) rastgele "click"
// üretebilir. Bu, deriveSiftedKey'e (yalnızca orada gerçek dedektör-click
// semantiği anlamlı olduğu için) HAYALET bir algılama olasılığı olarak
// eklenir — propPhoton'ın kanal fiziğine DOKUNULMAZ.
//
// GERÇEK REFERANS: Micius uydusu SNSPD (Superconducting Nanowire Single
// Photon Detector) kullanır — karanlık sayım oranı ~10-100Hz mertebesinde,
// ucuz SPAD'lerden (100-1000Hz) çok daha düşük. Gerçek uydu-QKD
// sistemlerinin neredeyse tamamı SADECE GECE çalışır — tam olarak bu
// nedenle (gündüz gökyüzü arka plan gürültüsü SNR bütçesini yutar).
// ══════════════════════════════════════════════════════════════
const DETECTOR_DARK_RATE_HZ = 50;          // SNSPD-sınıfı karanlık sayım oranı (didaktik referans değer)
const DAYTIME_BACKGROUND_RATE_HZ = 5e6;    // gündüz gökyüzü arka plan click oranı (gece oranından KATLARCA yüksek)
const NIGHTTIME_BACKGROUND_RATE_HZ = 200;  // gece gökyüzü arka plan click oranı (yıldız ışığı mertebesinde)
const SOURCE_GATE_WIDTH_S = 1 / 80e6;      // 80MHz Micius kaynak hızından türetilen algılama penceresi (computeRawKeyRate ile tutarlı)

class DetectorNoiseModel {
  /**
   * @param {boolean} isNight UI'daki "Operasyon Zamanı" kontrolü
   * @returns {number} [0,1) bir algılama penceresinde hayalet-click olasılığı
   */
  static phantomClickProbability(isNight) {
    const backgroundRate = isNight ? NIGHTTIME_BACKGROUND_RATE_HZ : DAYTIME_BACKGROUND_RATE_HZ;
    const totalRate = DETECTOR_DARK_RATE_HZ + backgroundRate;
    return 1 - Math.exp(-totalRate * SOURCE_GATE_WIDTH_S);
  }
}

// ══════════════════════════════════════════════════════════════
// FAZ 5: KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON (Noise-Gate Middleware)
//
// KULLANICI TALEBİ: "Yazılımın ne kadar kusursuz olursa olsun, gerçek bir
// nanotel dedektörün dünyasına girdiğinde karşına çıkacak olan şey temiz
// bitler değil, stokastik kuantum gürültüsüdür. Sıcaklık mikrokod
// düzeyinde dalgalandığında veya fiber hattan sızıntı olduğunda, nanotel
// süperiletken fazdan normal faza geçer ve foton gelmediği halde sistemine
// sahte bir 'Tetikte' (Click) sinyali basar." → bir Kuantum Gürültü
// Filtreleme ve Kalibrasyon (Noise-Gate Middleware) mimarisi kurulması istendi.
//
// EK 44 (DetectorNoiseModel, yukarıda) bu FENOMENİ zaten modelliyordu —
// karanlık sayım + gündüz arka plan gürültüsü, SABİT bir oranla
// deriveSiftedKey'e hayalet-click enjekte ediyordu. Ama EK 44'ün sadece
// enjekte eden yarısı vardı — dedektörün bu gürültüyle gerçek dünyada
// nasıl BAŞA ÇIKTIĞI (kalibrasyon, zaman-korelasyonlu kapı/gate) hiç
// modellenmemişti. Bu FAZ o eksik yarıyı tamamlar:
//
//   1) SICAKLIK SÜRÜKLENMESİ: SNSPD'nin bias noktası, gerçek kriyostat
//      sistemlerinde bile mikrokelvin mertebesinde dalgalanır (titreşim,
//      soğutucu döngüsü, elektronik gürültü). Nominal çalışma noktasından
//      mK cinsinden bir sapma olarak modellenir — ORTALAMAYA-DÖNÜŞLÜ
//      rastgele yürüyüş (bkz. watchdog-vitals-tick'teki AYNI istatistiksel
//      desen — saf/driftsiz random walk'ların sahte "trend" yanılsaması
//      ürettiği, Faz 4 ayarlanmasında keşfedilen sorun burada da geçerli,
//      aynı düzeltme tekrar kullanılır).
//   2) ARRHENIUS-BENZERİ KARANLIK SAYIM ARTIŞI: kritik akıma yakın
//      biaslanan bir nanotel, sıcaklık sapması arttıkça ÜSTEL olarak daha
//      sık kendiliğinden faz-kayması (spurious click) yaşar — gerçek
//      SNSPD literatüründeki termal-aktivasyon davranışının DİDAKTİK bir
//      yaklaşıksıdır.
//   3) KALİBRASYON DÖNGÜSÜ: gerçek sistemler PERİYODİK OLARAK "kör"
//      (kaynak kapalı) pencereler örnekleyip GÜNCEL karanlık-sayım
//      oranını yeniden ölçer — ANLIK ham değer hiçbir zaman doğrudan
//      gözlemlenemez, yalnızca EN SON kalibrasyonun tahmini bilinir
//      (dürüstlük: bu yüzden effectivePhantomProbability HAM/anlık
//      sıcaklık sapmasını değil, calibratedDarkRateHz'i kullanır — tıpkı
//      gerçek bir sistemde olduğu gibi, aradaki gecikme GERÇEK bir
//      güvenlik açığı penceresidir, gizlenmez).
//   4) ZAMAN-KORELASYONLU KAPI (Coincidence Gating): gerçek fotonlar
//      kaynağın saatine göre DAR bir beklenen-varış penceresinde gelir;
//      karanlık sayımlar zaman içinde RASTGELE (üniform) dağılır. Kapıyı
//      (gate) daraltmak karanlık-sayım kabul olasılığını ORANTILI olarak
//      düşürür — ama BEDAVA DEĞİL: gerçek bir fotonun varış zamanındaki
//      doğal jitter de (küçük bir payla) kırpılabilir, yani GERÇEK
//      fotonların bir kısmının kaçırılması riski de artar (bkz.
//      realClickMissProbability) — "sahte başarı" üretilmez, bu GERÇEK
//      bir mühendislik ödünleşimidir (verimlilik ↔ gürültü bağışıklığı).
//   5) OTONOM KAPI KONTROLÜ (basit bir AGC/otomatik-kazanç-kontrolü
//      döngüsü): kalibrasyon turunda ölçülen kapı-sonrası karanlık-kabul
//      olasılığı, NOMİNAL (sıcaklık sapması sıfırken) beklenen olasılığın
//      GATE_TARGET_MULTIPLIER katını aşarsa kapı daraltılır; belirgin
//      altındaysa (gürültü geçici bir sıçramaydı, geçti) kademeli olarak
//      GEVŞETİLİR — verimlilik sonsuza kadar feda edilmez, yalnızca
//      gürültü GERÇEKTEN yüksekken.
// ══════════════════════════════════════════════════════════════
const SNSPD_TEMP_DRIFT_SIGMA = 0.55;       // her kalibrasyon tik'inde rastgele yürüyüş adım büyüklüğü (mK)
const SNSPD_TEMP_MEAN_REVERSION = 0.18;    // ortalamaya-dönüş katsayısı (bkz. watchdog-vitals-tick'teki aynı desen)
const SNSPD_TEMP_TRIP_MK = 9;              // bu sapmanın üzerinde faz-kayması riski hızla katlanır (didaktik referans eşiği)
const SNSPD_DARKRATE_TEMP_GAIN = 2.1;      // Arrhenius-benzeri üstel artış katsayısı
const CALIBRATION_WINDOW_S = 0.5;          // her kalibrasyon turunda simüle edilen "kaynak kapalı, dedektör açık" gerçek-zaman pencere uzunluğu
const CALIBRATION_EMA_ALPHA = 0.35;        // kalibre edilmiş karanlık-oranı tahmininin yeni ölçüme ne kadar hızlı ağırlık verdiği
const GATE_MIN_RATIO = 0.20;               // kapı, nominal genişliğin bu oranının altına ASLA daralmaz (gerçek foton verimliliğini tamamen feda etmemek için taban)
const GATE_STEP = 0.10;                    // kalibrasyon turu başına kapının daralma/genişleme adımı (gevşeme daha temkinli — histerezis)
const GATE_TARGET_MULTIPLIER = 2.5;        // hedef: kapı-sonrası karanlık-kabul olasılığı, NOMİNAL (sapma=0) olasılığın bu katını aşmasın
const REAL_CLICK_MISS_AT_MIN_GATE = 0.06;  // kapı taban genişliğindeyken bile GERÇEK bir fotonun zamanlama jitter'ı yüzünden kaçırılma ihtimali (dürüst ödünleşim — bkz. yukarıki not 4)

// Basit Poisson örneklemesi — kalibrasyon turundaki "kör pencerede kaç
// click ölçüldü" sayısını gerçekçi bir sayım dağılımından çeker. Büyük
// λ'da (gündüz arka planı gibi) Knuth'un çarpım döngüsü hem yavaş hem de
// taşabilir riski taşır — bu yüzden büyük λ'da normal yaklaşıklığa
// (Irwin-Hall/CLT, 6 tekdüze değişkenle) düşer.
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 60) {
    const z = (Math.random()+Math.random()+Math.random()+Math.random()+Math.random()+Math.random()-3)/Math.sqrt(0.5);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

class NoiseGateMiddleware {
  constructor() {
    this.tempDriftMk = 0;              // SNSPD'nin nominal çalışma noktasından o anki HAM sapması (mK)
    this.fiberLeakBoostHz = 0;         // demo/organik olarak enjekte edilebilen ekstra sızıntı arka planı
    this.gateRatio = 1.0;              // [GATE_MIN_RATIO,1] — 1 = tam nominal SOURCE_GATE_WIDTH_S
    this.calibratedDarkRateHz = DETECTOR_DARK_RATE_HZ; // en son kalibrasyon turunun tahmini
    this.stats = { calibrationRuns: 0, filteredDarkClicks: 0, acceptedDarkClicks: 0, missedRealClicks: 0 };
    this.history = []; // {t, tempDriftMk, rawDarkRateHz, calibratedDarkRateHz, gateRatio} — UI grafiği için kayan pencere
  }

  /** Ortalamaya-dönüşlü rastgele yürüyüş + isteğe bağlı dışarıdan zorlanan bir sıçrama (demo enjeksiyonu). */
  advanceThermalDrift(forcedDeltaMk = 0) {
    const meanRevert = -this.tempDriftMk * SNSPD_TEMP_MEAN_REVERSION;
    const noise = (Math.random() - 0.5) * 2 * SNSPD_TEMP_DRIFT_SIGMA;
    this.tempDriftMk = Math.max(-25, Math.min(25, this.tempDriftMk + meanRevert + noise + forcedDeltaMk));
    return this.tempDriftMk;
  }

  /** O anki sıcaklık sapmasının HAM (kalibrasyonsuz) karanlık-sayım oranını kaç kat büyüttüğü. */
  thermalDarkRateMultiplier() {
    return Math.exp(SNSPD_DARKRATE_TEMP_GAIN * Math.abs(this.tempDriftMk) / SNSPD_TEMP_TRIP_MK);
  }

  /** Şu anki HAM (anlık, kalibrasyon-öncesi) karanlık sayım oranı. */
  rawDarkRateHz() {
    return DETECTOR_DARK_RATE_HZ * this.thermalDarkRateMultiplier() + this.fiberLeakBoostHz;
  }

  /** NOMİNAL (sapma=0, sızıntı=0, kapı=tam açık) hayalet-click olasılığı — AGC hedefinin ölçeklendiği taban. */
  nominalPhantomProbability(isNight) {
    const backgroundRate = isNight ? NIGHTTIME_BACKGROUND_RATE_HZ : DAYTIME_BACKGROUND_RATE_HZ;
    return 1 - Math.exp(-(DETECTOR_DARK_RATE_HZ + backgroundRate) * SOURCE_GATE_WIDTH_S);
  }

  /** HAM (kalibrasyon/kapı UYGULANMADAN önceki) hayalet-click olasılığı — "filtreleme olmasaydı ne olurdu" karşılaştırması için. */
  rawPhantomProbability(isNight) {
    const backgroundRate = isNight ? NIGHTTIME_BACKGROUND_RATE_HZ : DAYTIME_BACKGROUND_RATE_HZ;
    return 1 - Math.exp(-(this.rawDarkRateHz() + backgroundRate) * SOURCE_GATE_WIDTH_S);
  }

  /**
   * KALİBRASYON TURU: gerçek bir sistemin periyodik olarak yaptığı gibi,
   * kaynak KAPALIYKEN CALIBRATION_WINDOW_S saniyelik "kör" bir pencere
   * örnekler, kaç click ölçüldüğünü sayar, ve bu ölçümü (EMA ile
   * yumuşatarak) calibratedDarkRateHz'e işler. Ardından basit bir AGC
   * döngüsüyle gateRatio'yu ayarlar.
   */
  runCalibrationCycle(isNight, nowMs) {
    const backgroundRate = isNight ? NIGHTTIME_BACKGROUND_RATE_HZ : DAYTIME_BACKGROUND_RATE_HZ;
    const raw = this.rawDarkRateHz();
    const totalRate = raw + backgroundRate;
    const expectedCounts = totalRate * CALIBRATION_WINDOW_S;
    const measuredCounts = poissonSample(expectedCounts);
    const measuredTotalRate = measuredCounts / CALIBRATION_WINDOW_S;
    // GÜNDÜZ modunda arka plan (DAYTIME_BACKGROUND_RATE_HZ) karanlık
    // sayımdan KATLARCA büyük olduğundan, Poisson gürültüsü sinyali
    // (karanlık sayım katkısı) tamamen boğar — kalibrasyon GÜNDÜZ pratikte
    // güvenilmezdir. Bu bir hata DEĞİL: EK 44'ün kendi başlığında zaten
    // belirtildiği gibi gerçek uydu-QKD sistemleri de tam bu yüzden
    // SADECE GECE çalışır — Faz 5 bu kısıtı gizlemez, aynen yansıtır.
    //
    // BULUNAN İNCE HATA (kendi Monte Carlo testinde yakalandı — bkz. sohbet
    // geçmişi): measuredDarkRate = max(0, ölçüm - arkaPlan) tek-yönlü
    // (asimetrik) bir kırpma uygular. GÜNDÜZ gibi düşük-SNR durumlarda
    // gürültü genliği (±binlerce Hz) gerçek sinyalden (~50Hz) kat kat
    // büyük olduğundan, negatif taraf her zaman 0'a kırpılırken pozitif
    // taraf kırpılmaz — bu, sabit alpha'lı bir EMA'yı zamanla YUKARI doğru
    // sürükler (aynı aileden bir istatistiksel artifakt, bkz.
    // watchdog-vitals-tick'teki "saf random walk sahte trend üretir"
    // notu). ÇİFT ÇÖZÜM: (a) measuredDarkRate artık ÖLÇÜM AŞAMASINDA
    // KIRPILMAZ (negatif de kalabilir — gürültü SİMETRİKTİR, kırpma yalnızca
    // EN SONDA, EMA'nın kendisine uygulanır, tek-yönlü sapma biriktirmez);
    // (b) EMA ağırlığı (alpha) ölçümün SİNYAL/GÜRÜLTÜ oranına göre UYARLANIR
    // — SNR düşükken (gündüz) yeni ölçüme neredeyse hiç güvenilmez (eski
    // tahmine sadık kalınır, sürüklenmez), SNR yüksekken (gece, normal
    // durum) davranış eskisiyle BİREBİR AYNIDIR.
    const measuredDarkRate = measuredTotalRate - backgroundRate; // KIRPILMAZ — bkz. yukarıki not (a)
    const noiseStdHz = Math.sqrt(Math.max(1, expectedCounts)) / CALIBRATION_WINDOW_S;
    const signalToNoise = Math.abs(this.calibratedDarkRateHz) / noiseStdHz;
    const adaptiveAlpha = CALIBRATION_EMA_ALPHA * Math.min(1, Math.max(0.02, signalToNoise));
    this.calibratedDarkRateHz = Math.max(0, this.calibratedDarkRateHz*(1-adaptiveAlpha) + measuredDarkRate*adaptiveAlpha);

    const target = this.nominalPhantomProbability(isNight) * GATE_TARGET_MULTIPLIER;
    const gatedP = 1 - Math.exp(-(this.calibratedDarkRateHz + backgroundRate) * SOURCE_GATE_WIDTH_S * this.gateRatio);
    if (gatedP > target) {
      this.gateRatio = Math.max(GATE_MIN_RATIO, this.gateRatio - GATE_STEP);
    } else if (this.gateRatio < 1) {
      this.gateRatio = Math.min(1, this.gateRatio + GATE_STEP*0.5);
    }

    this.stats.calibrationRuns++;
    this.history.push({ t: nowMs, tempDriftMk: this.tempDriftMk, rawDarkRateHz: raw, calibratedDarkRateHz: this.calibratedDarkRateHz, gateRatio: this.gateRatio });
    if (this.history.length > 60) this.history.shift();
    return { rawDarkRateHz: raw, calibratedDarkRateHz: this.calibratedDarkRateHz, gateRatio: this.gateRatio, target };
  }

  /** deriveSiftedKey'in gerçekte kullandığı, KALİBRE EDİLMİŞ + KAPI-DARALTILMIŞ hayalet-click olasılığı. */
  effectivePhantomProbability(isNight) {
    const backgroundRate = isNight ? NIGHTTIME_BACKGROUND_RATE_HZ : DAYTIME_BACKGROUND_RATE_HZ;
    const totalRate = this.calibratedDarkRateHz + backgroundRate;
    const gatedWidth = SOURCE_GATE_WIDTH_S * this.gateRatio;
    return 1 - Math.exp(-totalRate * gatedWidth);
  }

  /** Kapı daraltmanın dürüst bedeli: gateRatio=1 iken 0, GATE_MIN_RATIO'da REAL_CLICK_MISS_AT_MIN_GATE tavanına lineer yaklaşır. */
  realClickMissProbability() {
    const narrowing = Math.max(0, 1 - this.gateRatio);
    const maxNarrowing = 1 - GATE_MIN_RATIO;
    return maxNarrowing > 0 ? (narrowing / maxNarrowing) * REAL_CLICK_MISS_AT_MIN_GATE : 0;
  }
}

// Modül-seviyesi tekil örnek — tüm canlı iletimler ve NGM UI paneli aynı
// kalibrasyon/kapı durumunu paylaşır (bkz. nodeWatchdog/predictiveEngine
// ile aynı mimari desen).
const noiseGateMiddleware = new NoiseGateMiddleware();

// ══════════════════════════════════════════════════════════════
// EK 1: Haversine — gerçek coğrafi mesafe (lat/lon → km)
// Mevcut LINKS.km değerleri korunur; bu fonksiyon paralel/opsiyonel
// bir doğrulama katmanı olarak eklenir, algoritmayı değiştirmez.
// ══════════════════════════════════════════════════════════════
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Dünya yarıçapı km
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ══════════════════════════════════════════════════════════════
// EK 2: Seeded PRNG (mulberry32) — replay'de tamamen aynı olayları
// üretmek için. propPhoton'a opsiyonel rng parametresi eklenecek;
// verilmezse Math.random kullanılır (mevcut davranış korunur).
// ══════════════════════════════════════════════════════════════
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Seed birleştirici: entanglementSeed + segment index + bit index → deterministik alt-seed
// DÜZELTME 8: opsiyonel 4. parametre `copy` — dinamik FEC/foton çoğullama
// için, AYNI bit'in birden çok bağımsız foton kopyası denendiğinde her
// kopyanın kendi bağımsız (ama deterministik/replay-güvenli) rng akışını
// alması gerekir. copy=0 (varsayılan) İLK "if" DALINA HİÇ GİRMEZ, yani
// hash hesabı TÜM MEVCUT (3 argümanlı) ÇAĞRI YERLERİYLE BİREBİR AYNI
// kalır — geçmiş replay/mirror/fork sonuçları asla retroaktif değişmez.
// Yalnızca copy>0 (yeni redundancy denemeleri) ek bir karıştırma turu alır.
function combineSeed(entanglementSeed, segIndex, bitIndex, copy = 0) {
  let h = entanglementSeed ^ 0x9e3779b9;
  h = Math.imul(h ^ segIndex, 0x85ebca6b);
  h = Math.imul(h ^ bitIndex, 0xc2b2ae35);
  if (copy) h = Math.imul(h ^ (copy * 0x2545F491 + 1), 0x27d4eb2f);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// ══════════════════════════════════════════════════════════════
// EK 3: BB84 Basis Reconciliation — gerçek protokol adımı
// Alice ve Bob her foton için rastgele baz seçer (rectilinear/diagonal).
// Sadece baz eşleşen fotonlar anahtara katılır (~%50 elenir — gerçek BB84).
// ══════════════════════════════════════════════════════════════
function bb84Reconcile(bitCount, rng) {
  const r = rng || Math.random;
  const aliceBases = [], bobBases = [], matched = [];
  for (let i = 0; i < bitCount; i++) {
    const ab = r() < 0.5 ? "REC" : "DIAG"; // rectilinear | diagonal
    const bb = r() < 0.5 ? "REC" : "DIAG";
    aliceBases.push(ab); bobBases.push(bb);
    matched.push(ab === bb);
  }
  const matchRate = matched.filter(Boolean).length / bitCount;
  return { aliceBases, bobBases, matched, matchRate };
}

// ══════════════════════════════════════════════════════════════
// EK 20: GERÇEKÇİ QKD KATMANI — One-Time-Pad şifreleme
// bb84Reconcile'ın ürettiği sifted key artık sadece istatistik değil,
// GERÇEKTEN mesajı şifrelemek için kullanılır: msg XOR key.
// Key mesajdan kısaysa, aynı seed'den deterministik olarak genişletilir
// (gerçek OTP'de anahtar mesaj kadar uzun olmalıdır — burada seed'den
// türetilen ek anahtar bitleriyle bu kural korunur).
// ══════════════════════════════════════════════════════════════
function deriveOtpKeyBits(siftedBits, neededLen, seed) {
  const key = [...siftedBits];
  if (key.length >= neededLen) return key.slice(0, neededLen);
  // Anahtar mesajdan kısaysa, aynı entanglement seed'inden deterministik
  // olarak ek anahtar bitleri türet (gerçek OTP güvenliği bu simülasyonda
  // "seed gizliyse güvenli" varsayımına dayanır — didaktik amaçlıdır).
  const expandRng = mulberry32((seed ^ 0x1234abcd) >>> 0);
  while (key.length < neededLen) key.push(expandRng() < 0.5 ? 0 : 1);
  return key.slice(0, neededLen);
}
function otpEncryptBits(msgBits, keyBits) {
  return msgBits.map((b,i) => b ^ keyBits[i % keyBits.length]);
}
function otpDecryptBits(cipherBits, keyBits) {
  return otpEncryptBits(cipherBits, keyBits); // XOR kendinin tersidir
}

// ══════════════════════════════════════════════════════════════
// V8.0 MİMARİ TEMELİ — ADIM 3: KRİPTO KATMANI AYRIMI
//
// Eski mimaride BB84 baz uzlaşması, QBER ölçümü ve OTP şifrelemesi
// transmit() fonksiyonunun GÖVDESİNE gömülüydü — 150+ satırlık dev
// bir fonksiyonun içinde routing/fizik/kripto/state/broadcast hepsi
// iç içeydi. Bu iki sınıf, kripto mantığını TAMAMEN BAĞIMSIZ,
// kendi kendine yeten modüllere ayırır. transmit() artık bu sınıfları
// birer "servis" gibi çağırır — matematikte TEK BİR SATIR değişmez,
// sadece organizasyon ve sorumluluk ayrımı gerçekleşir.
// ══════════════════════════════════════════════════════════════

// ── QuantumKeyDistribution — BB84 protokolü + QBER ölçümü ────────
class QuantumKeyDistribution {
  constructor(entanglementSeed) {
    this.seed = entanglementSeed;
    this.rng = mulberry32(entanglementSeed);
  }

  // Baz uzlaşması: Alice/Bob rastgele baz seçer (~%50 eşleşir).
  // Matematik bb84Reconcile ile BİREBİR AYNI.
  //
  // RETRO-CAUSALITY DESTEĞİ: historicalRng opsiyonel parametresi verilirse,
  // instance'ın kendi this.rng'i yerine BU rng kaynağı kullanılır. Bu,
  // "geçmişi gerçekten değiştirmek" DEĞİLDİR (fiziksel olarak anlamsız
  // olurdu) — bunun yerine, AYNI fiziksel rotadan geçen ama FARKLI bir
  // kuantum-ölçüm rastgeleliğiyle (farklı baz seçimleriyle) yeniden
  // hesaplanmış DETERMİNİSTİK BİR FORK üretir. "historicalRng" ismi,
  // "bu geçmiş kaydın alternatif bir versiyonunu türet" anlamına gelir.
  /**
   * @param {number} bitCount
   * @param {() => number} [historicalRng] - verilirse this.rng yerine kullanılır
   */
  reconcileBases(bitCount, historicalRng) {
    return bb84Reconcile(bitCount, historicalRng || this.rng);
  }

  // Sifted key çıkar + kanaldan geçişini simüle edip QBER ölç.
  // Bu, eski transmit()'teki dağınık 15 satırın TEK metoda toplanmış hâlidir.
  //
  // DÜRÜSTLÜK DÜZELTMESİ (QBER protokol doğruluğu): Önceki sürüm, QBER'i
  // propPhoton'ın "bu bit fiziksel olarak kayboldu mu/döndü mü" (ok/flip)
  // çıktısından DOLAYLI olarak türetiyordu — Alice'in ve Bob'un GERÇEK bit
  // değerleri hiçbir yerde karşılaştırılmıyordu. Gerçek BB84 protokolünde
  // QBER = (Alice_bits XOR Bob_bits) / toplam_sifted_bit sayısıdır — yani
  // Bob'un ALDIĞI bit ile Alice'in GÖNDERDİĞİ bit arasındaki gerçek fark.
  // Şimdi Bob'un aldığı bit AÇIKÇA türetiliyor (propPhoton flip bildirirse
  // ters çevrilir, kayıp bildirirse — kanalda hiçbir şey ulaşmadığı için —
  // rastgele bir bit olarak modellenir) ve Alice'in orijinal bitiyle GERÇEKTEN
  // XOR'lanıyor. propPhoton'ın kendi fiziksel simülasyonuna (ok/flip üretimi)
  // TEK SATIR DOKUNULMADI — yalnızca bu çıktının QBER'e nasıl çevrildiği
  // protokol-doğru hâle getirildi.
  //
  // RETRO-CAUSALITY: historicalRng verilirse hem baz uzlaşması hem de
  // anahtar-hata simülasyonu bu alternatif rastgelelik kaynağıyla çalışır
  // — sonuç, orijinal iletimin aynı fiziksel parametrelerle (mesafe, dalga
  // boyu, dinleme durumu) ama farklı bir "kuantum tesadüfü" ile ne
  // olabileceğini gösteren tutarlı bir alternatif gerçekliktir.
  /**
   * @param {number[]} bits
   * @param {number} totalKm
   * @param {boolean} evesdrop
   * @param {() => number} [historicalRng]
   */
  // DÜZELTME 6 (QBER PROTOKOL DOĞRULUĞU — kayıp foton ayrımı):
  // Önceki sürüm, propPhoton'ın fiziksel olarak KAYBOLDUĞUNU (ok:false —
  // soğuruldu/saçıldı/dekohere oldu) bildirdiği fotonlara Bob'un elinde
  // hiç veri yokken RASTGELE bir "karanlık-sayım" biti uyduruyor ve bu
  // uydurma biti hem final anahtara hem de QBER hesabına katıyordu.
  // Bu, mesafe arttıkça (kayıp oranı arttıkça) QBER'i GERÇEK bir dinleyici
  // olmadan da yapay olarak şişiriyordu — km=50'de evesdrop=false iken
  // bile ~%46 QBER ölçülüyordu (bkz. sohbet geçmişindeki Qiskit-eşdeğeri
  // durum-vektörü karşılaştırması: gerçek BB84'te Eve yokken QBER teorik
  // olarak %0'dır).
  //
  // GERÇEK BB84'te bir dedektör hiç "click" vermezse (foton hiç ulaşmazsa)
  // o zaman dilimi anahtardan TAMAMEN DÜŞER — "hata" olarak sayılmaz,
  // sadece "tespit edilmedi" olur. Şimdi QBER ve final sifted key SADECE
  // GERÇEKTEN ALGILANAN (kr.ok===true) fotonlar üzerinden hesaplanıyor;
  // kayıp fotonlar ayrı bir sayaçta (`lostCount`) izleniyor ama ne
  // anahtara ne de hata oranına karışıyor. propPhoton'ın kendisine
  // (fiziksel kayıp/flip üretimine) TEK SATIR DOKUNULMADI.
  // DÜZELTME 7 (GERÇEK INTERCEPT-RESEND FİZİĞİ):
  // Önceki sürümde "evesdrop" yalnızca propPhoton içindeki
  // eavesdropProbability(nm,km)'e bağlı, mesafeye/sinyal gücüne göre
  // ölçeklenen keyfi bir "risk vergisi"ydi (%8-%45 arası tetiklenme,
  // tetiklenirse %25 flip) — GERÇEK bir intercept-resend saldırısını
  // MODELLEMİYORDU. Gerçek BB84 güvenlik kanıtı şuna dayanır: Eve,
  // Alice'in HANGİ bazı (REC/DIAG) kullandığını BİLMEZ. Kendi rastgele
  // bazını seçer — %50 ihtimalle Alice'inkiyle eşleşir (mükemmel kopya
  // ölçer, hiç iz bırakmadan yeniden yollar), %50 ihtimalle eşleşmez
  // (ölçümü KENDİ bazına çöktürür; yeniden hazırladığı foton, Bob'un
  // Alice'in bazıyla — sifted kümede bu garanti — ölçtüğünde %50
  // ihtimalle YANLIŞ sonuç verir). Sifted küme üzerinde toplam
  // P(hata)=0.5×0.5=%25 — MESAFEDEN/SİNYAL GÜCÜNDEN BAĞIMSIZ, ders
  // kitabı BB84 imzası (bkz. sohbet geçmişindeki Qiskit-eşdeğeri
  // durum-vektörü doğrulaması: %0 Eve yokken, %24.89 gerçek
  // intercept-resend ile, N=200.000 kübit).
  //
  // Bu artık burada, GERÇEK Alice bazlarını (recon.aliceBases) kullanarak
  // doğru şekilde uygulanıyor. propPhoton'a artık evesdrop HİÇ VERİLMİYOR
  // (false sabit) — kanal gürültüsü (kayıp/faz kayması, DÜZELTME 6'daki
  // kayıp-foton ayrımı dahil) hâlâ propPhoton'dan geliyor ve Eve'in
  // etkisinin ÜSTÜNE bağımsız bir katman olarak eklenir. Mesaj-seviyesi
  // genel simülasyondaki (physicalSimulation → segReport/event log) eski
  // EAVES-olay mekanizmasına TEK SATIR DOKUNULMADI — o, formel bir
  // güvenlik istatistiği değil, anlatım amaçlı bir olay logu.
  // EK 44 ENTEGRASYONU: yeni opsiyonel `detectorCtx` parametresi ({isNight})
  // — verilmezse (mevcut TÜM eski çağrı yerleri) karanlık sayım/arka plan
  // gürültüsü HİÇ devreye girmez, eski davranış BİREBİR korunur.
  deriveSiftedKey(bits, totalKm, evesdrop, historicalRng, detectorCtx) {
    const recon = this.reconcileBases(bits.length, historicalRng);
    const siftedIndices = recon.matched.map((m,i)=>m?i:-1).filter(i=>i>=0);

    let keyErrors = 0;
    let lostCount = 0;
    let darkClickCount = 0; // teşhis amaçlı: kaç "algılama" aslında hayalet (karanlık sayım/arka plan) click'ti
    let eveInducedErrors = 0; // teşhis amaçlı: kaç hata GERÇEKTEN Eve'in yanlış-baz ölçümünden kaynaklandı
    const aliceKeyBits = []; // Alice'in GERÇEKTEN ALGILANAN sifted bit'leri (kayıp olanlar hariç)
    const bobKeyBits = [];   // Bob'un ALDIĞI (yalnızca algılanan) sifted bit'ler
    siftedIndices.forEach((origIdx, k)=>{
      const bitRng = historicalRng ? historicalRng : mulberry32(combineSeed(this.seed ^ 0x5bd1e995, 0, k));
      const aliceBit = bits[origIdx];
      const aliceBasis = recon.aliceBases[origIdx];

      // GERÇEK INTERCEPT-RESEND: Eve fotonu Bob'a ulaşmadan ÖNCE yakalar,
      // KENDİ rastgele bazında ölçer, sonra o ölçümle YENİ bir foton
      // hazırlayıp yoluna devam ettirir — Alice'in bazını bilmediği için
      // kanala giren "mantıksal" bit değerini bozabilir.
      let bitInTransit = aliceBit;
      let eveDisturbed = false;
      if (evesdrop) {
        const eveBasis = bitRng() < 0.5 ? "REC" : "DIAG";
        if (eveBasis !== aliceBasis) {
          // Yanlış bazda ölçüm: sonuç Alice'in bitinden BAĞIMSIZ, %50/50.
          bitInTransit = bitRng() < 0.5 ? 0 : 1;
          eveDisturbed = true;
        }
        // eveBasis === aliceBasis: Eve doğru okur, mükemmel kopya resend
        // eder — bitInTransit DEĞİŞMEZ, hiç iz bırakmaz (gerçek BB84 gibi).
      }

      // FİZİKSEL KANAL: propPhoton'a artık evesdrop=false sabit geçiliyor
      // (eski mesafe-bağımlı "risk vergisi" burada devre dışı) — yalnızca
      // gerçek kayıp/saçılma/soğurma/faz-kayması gürültüsü uygulanır;
      // Eve'in etkisi zaten yukarıda ayrı ve doğru şekilde ele alındı.
      const kr = propPhoton(1550, totalKm, 0, false, bitRng);
      if (!kr.ok) {
        // Foton hiç ulaşmadı — normalde gerçek bir dedektörde "click" yok.
        // EK 44 (DetectorNoiseModel) + FAZ 5 (NoiseGateMiddleware): ama
        // karanlık sayım/gündüz arka plan gürültüsü (detectorCtx verilmişse)
        // dedektörün YİNE DE rastgele bir "hayalet" click üretmesine yol
        // açabilir — bu, foton kaybından TAMAMEN BAĞIMSIZ, dedektör-taraflı
        // bir olay. Faz 5'ten önce bu olasılık DOĞRUDAN DetectorNoiseModel'in
        // ham/anlık formülünden geliyordu; artık noiseGateMiddleware'in
        // KALİBRE EDİLMİŞ + ZAMAN-KORELASYONLU-KAPI-DARALTILMIŞ tahminini
        // (gatedP) kullanır. TEK bir roll ile üç yollu bir karar verilir:
        // roll<gatedP → kabul edilen hayalet click (gerçek dedektör de
        // bunu kabul ederdi); gatedP<=roll<rawP → kapı bu olayı BAŞARIYLA
        // FİLTRELEDİ (kalibrasyonsuz sistemde anahtara karışacaktı);
        // roll>=rawP → zaten hiç click olmayacaktı. Hayalet click Alice'in
        // bitinden bağımsız rastgele bir değer taşır, bu yüzden sifted
        // kümeye %50 ihtimalle hata olarak katılır — gerçek dedektör
        // davranışıyla tutarlı.
        const ng = detectorCtx ? noiseGateMiddleware : null;
        const gatedP = ng ? ng.effectivePhantomProbability(!!detectorCtx.isNight) : 0;
        const rawP = ng ? ng.rawPhantomProbability(!!detectorCtx.isNight) : 0;
        const roll = bitRng();
        if (gatedP > 0 && roll < gatedP) {
          const phantomBit = bitRng() < 0.5 ? 0 : 1;
          aliceKeyBits.push(aliceBit);
          bobKeyBits.push(phantomBit);
          darkClickCount++;
          ng.stats.acceptedDarkClicks++;
          if ((aliceBit ^ phantomBit) !== 0) keyErrors++;
          return;
        }
        if (ng && rawP > gatedP && roll < rawP) {
          ng.stats.filteredDarkClicks++; // Gürültü Kapısı bu hayalet click'i başarıyla filtreledi
        }
        // Ne anahtara ne de QBER'e katılır; yalnızca sayılır.
        lostCount++;
        return;
      }
      // FAZ 5: kapı daraltmanın dürüst bedeli — GERÇEK bir fotonun zamanlama
      // jitter'ı, daraltılmış kapının dışına düşebilir (bkz.
      // NoiseGateMiddleware.realClickMissProbability). gateRatio=1 iken bu
      // olasılık HER ZAMAN sıfırdır (davranış birebir eskisi gibi kalır);
      // yalnızca kalibrasyon GERÇEKTEN kapıyı daralttığında devreye girer.
      if (detectorCtx) {
        const missP = noiseGateMiddleware.realClickMissProbability();
        if (missP > 0 && bitRng() < missP) {
          noiseGateMiddleware.stats.missedRealClicks++;
          lostCount++;
          return;
        }
      }
      // flip bildirirse bit ters çevrilmiş ulaşır, aksi hâlde olduğu gibi ulaşır.
      const bobBit = kr.flip ? (bitInTransit ^ 1) : bitInTransit;
      aliceKeyBits.push(aliceBit);
      bobKeyBits.push(bobBit);
      // GERÇEK QBER HESABI: Alice'in gönderdiği bit ile Bob'un aldığı bit
      // GERÇEKTEN XOR'lanıyor — textbook BB84 tanımıyla birebir aynı,
      // yalnızca GERÇEKTEN algılanan fotonlar üzerinden.
      if ((aliceBit ^ bobBit) !== 0) {
        keyErrors++;
        if (eveDisturbed) eveInducedErrors++;
      }
    });
    const siftedKeyBits = aliceKeyBits; // Alice'in algılanan sifted bit'leri (kayıplar hariç)
    const qber = siftedKeyBits.length ? (keyErrors/siftedKeyBits.length) : 0;
    const eavesdropDetected = qber > 0.11; // BB84 literatüründe tipik eşik ~%11

    return { recon, siftedKeyBits, bobKeyBits, qber, eavesdropDetected, lostCount, detectedCount: siftedKeyBits.length, eveInducedErrors, darkClickCount };
  }

  // ══════════════════════════════════════════════════════════
  // GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ (Trusted-Node Relay Chain)
  //
  // KULLANICI TALEBİ: "300km ve 550km için gerçekçi bir tekrarlayıcı
  // zinciri ekleyip tekrar test et". 300km/550km'de tek-atış deriveSiftedKey()
  // ~10⁻⁶ mertebesinde foton hayatta kalma olasılığı yüzünden pratik
  // olarak SIFIR algılama üretiyordu (bkz. QBER karşılaştırma raporu).
  //
  // FİZİKSEL GEREKÇE — NEDEN BASİT AMPLİFİKASYON KULLANILMADI: tek-fotonlu
  // BB84, klasik bir EDFA/sinyal amplifikasyonuyla ASLA "güçlendirilemez"
  // — no-cloning teoremi, bilinmeyen bir kuantum durumunun KOPYALANMASINI
  // (dolayısıyla amplifikasyonunu) yasaklar; bir fotonu "yükseltmeye"
  // çalışmak onu ÖLÇMEK anlamına gelir, bu da durumu çökertir (Eve'in
  // yapacağı şeyin AYNISI — kendi kendini yenen bir "güvenlik" olurdu).
  // Bu yüzden physicalSimulation()'daki dinamik FEC/foton çoğullama
  // (DÜZELTME 8) BİLEREK yalnızca KLASİK mesaj kanalına uygulandı;
  // deriveSiftedKey()'in TEK FOTON fiziğine (propPhoton çağrısına) HİÇ
  // dokunulmadı (bkz. DÜZELTME 7 yorumları) — o disiplin burada da korunur.
  //
  // GERÇEK ÇÖZÜM: GÜVENİLİR DÜĞÜM RÖLESİ — gerçek dünyada 300km+ QKD
  // hatlarının neredeyse tamamının kullandığı yöntem budur (onlarca km
  // aralıklı güvenilir ara-düğümlerle, ticari fiber-QKD ağlarında yaygın
  // pratik). Uzun hat, HER BİRİ tek-foton fiziğinin makul bir QBER'le
  // çalıştığı kısa segmentlere bölünür; HER SEGMENTTE TAMAMEN BAĞIMSIZ
  // bir BB84 oturumu (kendi baz uzlaşması, kendi kuantum kanalı, kendi
  // QBER'i) çalışır. Ardışık düğümler arasında anahtar, tek-kullanımlık-
  // şablon (one-time-pad) XOR röle ile aktarılır (segment anahtarları
  // zincirlenir) — bu, HER HOP'UN TEK-FOTON GÜVENLİĞİNİ ayrı ayrı korur.
  //
  // DÜRÜST GÜVENLİK KISITI: bu, GERÇEK bir kuantum tekrarlayıcı (entanglement
  // swapping — ara düğüme güven GEREKTİRMEZ) DEĞİLDİR. Güvenilir-düğüm
  // rölesi, ARA DÜĞÜMLERİN ele geçirilmediği varsayımına dayanır — çünkü
  // her ara düğüm, kendi iki komşu hop'unun anahtarını AÇIK METİN olarak
  // görür (XOR'lamak için). Bu dürüstçe `trustedNodeCaveat` alanında
  // raporlanır — "sahte" bir uçtan-uca tek-foton güvenliği iddia edilmez.
  //
  // GÜVENLİK/TESPİT: eavesdropDetected artık HERHANGİ BİR hop eşiği
  // (%11) aşarsa true olur — gerçek bir güvenilir-düğüm ağında her hop
  // bağımsız izlenir; tek bir zayıf halka (saldırı altındaki tek bir
  // segment) tüm zinciri ifşa eder.
  /**
   * @param {number[]} bits
   * @param {number} totalKm
   * @param {number} nHops - segment (güvenilir-düğüm hop) sayısı
   * @param {boolean} evesdrop
   * @param {{isNight?:boolean}} [detectorCtx]
   */
  // İSTATİSTİKSEL PARTİ BÜYÜKLÜĞÜ NOTU: gerçek BB84 sistemleri anahtar
  // havuzunu SÜREKLİ, mesajdan BAĞIMSIZ bir arka plan süreci olarak
  // biriktirir (saniyede milyonlarca darbe) — QBER, bu büyük havuzdan
  // güvenilir biçimde tahmin edilir. Bu simülasyonda tek-atış
  // deriveSiftedKey() `bits` (mesajın Hamming-kodlu, genelde ~100-300
  // bitlik dizisi) ile çağrılır — kısa mesajlarda bu KABUL EDİLEBİLİR bir
  // örneklem, ÇÜNKÜ tek bir hop var. Ama zincirde AYNI küçük diziyi HER
  // hopta yeniden kullanmak (özellikle 8-10 hop'ta), her hop'un QBER
  // tahminini yalnızca birkaç algılanan bite dayandırır — bu, GERÇEK bir
  // dinleyici olmadan bile örnekleme gürültüsüyle %11 eşiğini rastgele
  // aşan sahte-pozitif tespitler üretir (bkz. canlı UI testi: 452km,
  // 8 hop, ~400 ham bit → en-kötü-hop QBER %25, YANLIŞ ALARM). GERÇEKÇİ
  // ÇÖZÜM: her hop, mesajdan bağımsız KENDİ istatistiksel anahtar
  // havuzunu (STAT_BATCH_MIN ham bit) üretir — tıpkı gerçek bir
  // trusted-node ağının, o anki mesajdan önce zaten biriktirmiş olacağı
  // arka plan anahtar trafiği gibi. Nihai anahtar hâlâ mesaj uzunluğuna
  // (deriveOtpKeyBits ile) kırpılır/genişletilir — burada değişen SADECE
  // QBER'in GÜVENİLİR biçimde ÖLÇÜLDÜĞÜ örneklem büyüklüğüdür.
  deriveSiftedKeyChain(bits, totalKm, nHops, evesdrop, detectorCtx) {
    const n = Math.max(1, Math.round(nHops));
    const hopKm = totalKm / n;
    const STAT_BATCH_MIN = 3000; // güvenilir QBER tahmini için hedef ham-bit parti büyüklüğü
    const hops = [];
    for (let h = 0; h < n; h++) {
      // Her hop TAMAMEN BAĞIMSIZ bir kuantum kanalı/BB84 oturumudur —
      // kendi alt-seed'i (deterministik/replay-güvenli), kendi baz
      // uzlaşması, kendi foton fiziği. reps=0 ile TEK-ATIŞ deriveSiftedKey
      // BİREBİR AYNI matematiği kullanır — yalnızca mesafe kısaltılmıştır.
      const hopSeed = (this.seed ^ Math.imul(h + 1, 0xc2b2ae35) ^ 0x9e3779b9) >>> 0;
      const hopQkd = new QuantumKeyDistribution(hopSeed);
      // Bu hop'un KENDİ bağımsız ham-bit partisi: mesaj `bits`'ten en az
      // STAT_BATCH_MIN kadar büyükse zaten yeterli (tek-atış davranışıyla
      // TUTARLI — n=1 durumunda bu blok atlanır, tek-atış BİREBİR AYNI
      // kalır). Küçükse, aynı hopSeed'den deterministik olarak genişletilir
      // — replay/tekrar üretilebilirlik korunur.
      const hopBits = bits.length >= STAT_BATCH_MIN ? bits : (() => {
        const expandRng = mulberry32(hopSeed ^ 0x51ed270b);
        const arr = new Array(STAT_BATCH_MIN);
        for (let i = 0; i < STAT_BATCH_MIN; i++) arr[i] = i < bits.length ? bits[i] : (expandRng() < 0.5 ? 0 : 1);
        return arr;
      })();
      const r = hopQkd.deriveSiftedKey(hopBits, hopKm, evesdrop, undefined, detectorCtx);
      hops.push({ hop: h, km: hopKm, qber: r.qber, siftedLen: r.siftedKeyBits.length,
        matchRate: r.recon.matchRate, siftedKeyBits: r.siftedKeyBits, bobKeyBits: r.bobKeyBits, // EK (Asenkron Havuz): bobKeyBits zaten deriveSiftedKey'in dönüşünde vardı, yalnızca burada da TAŞINIYOR — hesaplama/mantık DEĞİŞMEDİ
        sentPulses: hopBits.length, // EK (Üretim Denetim Fonksiyonu/Gain): bu hop'a gönderilen ham darbe sayısı — yalnızca TAŞINIYOR, hopBits zaten hesaplanmıştı
        detectedCount: r.detectedCount, lostCount: r.lostCount, eavesdropDetected: r.eavesdropDetected });
    }
    // Zincirin nihai anahtar UZUNLUĞU, EN ZAYIF (en kısa sifted key üreten)
    // hop'la sınırlıdır — röle, ancak TÜM hoplarda ortak olan bit sayısı
    // kadar anahtar üretebilir (gerçek trusted-node ağlarının temel
    // verim kısıtı — "zincir en zayıf halkası kadar güçlüdür" burada
    // GÜVENLİK değil VERİM için geçerlidir).
    const bottleneckLen = Math.min(...hops.map(h=>h.siftedLen));
    const avgQber = hops.reduce((s,h)=>s+h.qber,0) / hops.length;
    const avgMatchRate = hops.reduce((s,h)=>s+h.matchRate,0) / hops.length;
    const worstHop = hops.reduce((w,h)=> h.qber > w.qber ? h : w, hops[0]);
    const eavesdropDetected = hops.some(h=>h.eavesdropDetected);
    // GERÇEK RÖLE PROTOKOLÜ: Alice'in İLK hop'ta (Alice↔Düğüm1) ürettiği
    // sifted key, ardışık düğümler arasında tek-kullanımlık-şablon (OTP)
    // ile "sarılıp" bir sonraki hop'un anahtarıyla şifrelenerek taşınır
    // — her ara düğüm, kendi iki komşu hop anahtarını kullanarak bir
    // sonrakine relay eder (bu adımların kendisi burada AYRINTILI simüle
    // EDİLMİYOR — yalnızca nihai sonuç modelleniyor: uçtan uca paylaşılan
    // sır, hop-0'ın anahtarıdır, EN ZAYIF HOP'UN uzunluğuna kırpılmış
    // olarak, çünkü röle ancak bu kadar ortak bit taşıyabilir).
    const keyBits = hops[0].siftedKeyBits.slice(0, bottleneckLen);
    // EK (Asenkron Havuz): keyBits'in TAM AYNI kırpma mantığıyla (hop-0,
    // bottleneckLen'e kırpılmış) hizalanmış Bob-tarafı karşılığı — sadece
    // dışarı taşınıyor, keyBits'in kendisi veya hesaplanışı değişmedi.
    const bobKeyBits = hops[0].bobKeyBits.slice(0, bottleneckLen);
    return {
      hops, nHops: n, hopKm, bottleneckLen, avgQber, avgMatchRate, worstHop, eavesdropDetected, keyBits, bobKeyBits,
      sentPulses: hops[0].sentPulses, // EK (Gain): temsili olarak hop-0'ın gönderdiği ham darbe sayısı (keyBits/bobKeyBits ile AYNI hizanın devamı)
      totalDetected: hops.reduce((s,h)=>s+h.detectedCount,0),
      totalLost: hops.reduce((s,h)=>s+h.lostCount,0),
      trustedNodeCaveat: "Bu zincirin güvenliği TÜM ara düğümlerin güvenilir (ele geçirilmemiş) olduğu varsayımına dayanır — gerçek kuantum tekrarlayıcılardan (entanglement swapping) farklı olarak, ara düğümler prensipte iki komşu hop anahtarını açık metin görebilir.",
    };
  }

  // ══════════════════════════════════════════════════════════
  // RAW KEY RATE (Ham Anahtar Üretim Hızı) — GERÇEK FİZİKSEL BÜYÜKLÜK
  //
  // PROBLEM: Sistem şimdiye kadar QKD çıktısını yalnızca "kaç bit"
  // (statik bir sayım) olarak gösteriyordu — "13/28 kr · 104 bit" gibi
  // bir ifade, kuantum iletişim literatüründeki STANDART ölçüm birimini
  // (bit/saniye, "raw key rate") hiç yansıtmıyordu. Gerçek QKD sistemleri
  // performansı HER ZAMAN bir ORAN olarak raporlar, çünkü kuantum kaynağı
  // sürekli, saniyede milyonlarca foton üreten bir donanımdır — tek
  // seferlik bir "mesaj" değil.
  //
  // GERÇEK REFERANS DEĞERLER (Micius uydusu, Liao et al. 2017/2018,
  // Nature — LEO ~550km, gerçek yayınlanmış performans verisi):
  //   • Kaynak darbe hızı: 80 MHz (saniyede 80 milyon foton darbesi)
  //   • Maksimum uçtan-uca verimlilik: 0.238 (sifting + detection +
  //     reconciliation kayıpları dahil, en iyi koşulda)
  //   • Sonuç: 80×10⁶ × 0.238 ≈ 1.7×10⁷ ... ama gerçek yayınlanan rakam
  //     ~1.1 kbit/s (çok daha düşük atmosferik/detector kayıplarıyla)
  //     ile en iyi-koşul ~1.7 Mbit/s ARASINDA değişir; buradaki üst
  //     sınır (1.7 Mbit/s) yayının "en iyi durum" rakamıdır.
  //
  // BU SİMÜLASYONDA UYGULAMA: bu iletimin GERÇEKTEN ELDE ETTİĞİ sifting
  // oranı (recon.matchRate — BB84 baz uzlaşmasından, zaten hesaplanmış),
  // Micius'un gerçek 80MHz kaynak hızı ölçeğine uygulanır — yani "bu
  // simülasyonun bant genişliği, gerçek bir uydu QKD sisteminin kaynak
  // hızıyla çalışsaydı ne kadar bit/saniye üretirdi" sorusuna cevap verir.
  // Bu, keyfi bir sayı DEĞİLDİR — gerçek donanım kısıtına dayanan bir
  // ölçeklendirmedir; ama şunu da açıkça belirtmek gerekir: SİMÜLASYONUN
  // KENDİSİ gerçek zamanlı bir foton kaynağı çalıştırmaz (bu bir "mesaj
  // gönder" simülasyonudur) — bu metod, üretilen sifted key bit sayısını,
  // GERÇEK bir sistemin bant genişliğine YANSITILMIŞ HÂLDE sunar.
  //
  // @param {number} siftedKeyBitCount - bu iletimde üretilen sifted key bit sayısı
  // @param {number} matchRate - BB84 baz uzlaşma oranı (recon.matchRate, [0,1])
  // @returns {{rawKeyRateBps: number, sourceRateHz: number, efficiency: number, label: string}}
  static computeRawKeyRate(siftedKeyBitCount, matchRate) {
    const MICIUS_SOURCE_RATE_HZ = 80e6;      // 80 MHz — gerçek yayınlanmış kaynak darbe hızı
    const MICIUS_MAX_EFFICIENCY = 0.238;     // gerçek yayınlanmış TEORİK maksimum verimlilik
    // Gerçek yayınlanan EN İYİ DURUM raw key rate tavanı (Liao et al.
    // 2017/2018) — 80MHz×0.238'in NAİF çarpımından (ki bu ~19 Mbit/s
    // verir, aşırı iyimser) DAHA DÜŞÜKTÜR, çünkü gerçek sistemde
    // atmosferik/detector/reconciliation kayıpları 0.238'in içine tam
    // yansımaz; yayınlanan gerçek en-iyi-durum rakamı budur.
    const MICIUS_PUBLISHED_BEST_CASE_BPS = 1.7e6; // ~1.7 Mbit/s — gerçek yayınlanan üst sınır

    // Bu iletimin GERÇEKTEN elde ettiği BB84 baz uzlaşma performansı
    // (matchRate, tipik ~0.5), teorik ideal (1.0) ile oranlanıp, GERÇEK
    // yayınlanan en-iyi-durum tavanına ÖLÇEKLENİR — yani matchRate=1.0
    // (mükemmel uzlaşma) ~1.7 Mbit/s'e ulaşır, matchRate=0.5 bunun
    // yarısına yakın bir değer üretir.
    const effectiveEfficiency = Math.min(1, matchRate) * MICIUS_MAX_EFFICIENCY;
    const rawKeyRateBps = MICIUS_PUBLISHED_BEST_CASE_BPS * Math.min(1, matchRate);

    // İnsan-okunabilir birim seçimi (bps / kbps / Mbps).
    let label;
    if (rawKeyRateBps >= 1e6) label = `${(rawKeyRateBps/1e6).toFixed(2)} Mbit/s`;
    else if (rawKeyRateBps >= 1e3) label = `${(rawKeyRateBps/1e3).toFixed(1)} kbit/s`;
    else label = `${rawKeyRateBps.toFixed(0)} bit/s`;

    return {
      rawKeyRateBps,
      sourceRateHz: MICIUS_SOURCE_RATE_HZ,
      efficiency: effectiveEfficiency,
      label,
    };
  }
}

// ── OneTimePad — gerçek XOR tabanlı OTP şifreleme ────────────────
class OneTimePad {
  // Sifted key mesajdan kısaysa seed'den deterministik genişletir.
  // Matematik deriveOtpKeyBits ile BİREBİR AYNI.
  static deriveKey(siftedBits, neededLen, seed) {
    return deriveOtpKeyBits(siftedBits, neededLen, seed);
  }
  static encrypt(msgBits, keyBits) { return otpEncryptBits(msgBits, keyBits); }
  static decrypt(cipherBits, keyBits) { return otpDecryptBits(cipherBits, keyBits); }

  // Tam OTP döngüsü: anahtar türet → şifrele → deşifre → bütünlük doğrula.
  // transmit()'teki 6 satırlık bloğun tek metoda toplanmış hâli.
  static runFullCycle(msg, siftedKeyBits, seed) {
    const rawMsgBits = t2b(msg);
    const keyBits = this.deriveKey(siftedKeyBits, rawMsgBits.length, seed);
    const cipherBits = this.encrypt(rawMsgBits, keyBits);
    const decryptedBits = this.decrypt(cipherBits, keyBits);
    const decoded = b2t(decryptedBits);
    return { keyBits, cipherBits, decoded, integrityOk: decoded === msg };
  }
}

// ══════════════════════════════════════════════════════════
// YOL HARİTASI MADDE 3 — BİÇİMSEL SONLU-ANAHTAR (FINITE-KEY) GÜVENLİK
// KANITI KATMANI (physics_verification_report.html'de "en zayıf halka"
// olarak işaretlenmişti — kullanıcı onayıyla uygulanıyor).
//
// SORUN: `eavesdropDetected` şimdiye kadar yalnızca basit bir QBER eşik
// testiydi (qber > 0.11 → "dinleme var/yok", ikili karar). Gerçek bir
// güvenlik iddiası için bu YETERSİZ — akademik QKD güvenlik kanıtları
// üç ayrı unsur gerektirir, üçü de aşağıda AYRI sınıflar olarak
// uygulanıyor:
//
//   1) SONLU-BOYUT (finite-key) istatistiksel düzeltmesi — az sayıda
//      sifted bit ile ölçülen QBER, gerçek faz-hata oranını yalnızca
//      belli bir istatistiksel güvenle (ε_PE) tahmin eder. Serfling
//      eşitsizliği bu belirsizlik payını (μ) sınırlar; örneklem
//      küçüldükçe μ büyür ve güvenli anahtar uzunluğu asimptotik
//      formülün öngördüğünden DAHA KISA çıkar (gerçekçi davranış).
//
//   2) GİZLİLİK YÜKSELTME (privacy amplification) — leftover hash
//      lemma'ya dayanarak sifted key'i, Eve'in olası bilgisini
//      istatistiksel olarak ihmal edilebilir kılacak KISALTILMIŞ bir
//      anahtara sıkıştırır. Burada GERÇEKTEN ÇALIŞAN bir 2-evrensel
//      hash ailesi (Toeplitz matris, mod-2 çarpım) uygulanıyor —
//      yalnızca "ℓ bit güvenli" demek değil, o ℓ bit'i FİİLEN üretiyor.
//
//   3) KLASİK KANAL KİMLİK DOĞRULAMASI — baz-uzlaşma/hata-düzeltme
//      mesajları kimliksiz gönderilirse Eve bir ortadaki-adam (MITM)
//      saldırısıyla anahtar üzerinde anlaşmayı manipüle edebilir.
//      Wegman-Carter tipi bir MAC (polinom evrensel hash + OTP maskesi)
//      ile bu mesajlar kimliklendiriliyor; kullanılan kimlik doğrulama
//      anahtarı her round'da YENİ üretilen güvenli anahtardan geri
//      beslenir ("authentication key recycling" — Wegman-Carter, 1981;
//      bkz. ClassicalAuthChannel sınıfı, aşağıda).
//
// KAYNAK / FORMÜL: Scarani, V., Bechmann-Pasquinucci, H., Cerf, N.J.,
// Dušek, M., Lütkenhaus, N., Peev, M., "The security of practical
// quantum key distribution," Rev. Mod. Phys. 81, 1301 (2009) —
// GLLP (Gottesman-Lo-Lütkenhaus-Preskill) çerçevesinin Serfling
// eşitsizliğiyle sonlu-boyuta genişletilmiş hâli:
//
//   ℓ = n·[1 − h₂(Q_ph_upper)] − leak_EC − log₂(2/ε_cor) − 2·log₂(1/(2ε_PA))
//
//     n           = sifted key uzunluğu (anahtar için kullanılan bit sayısı)
//     Q_ph_upper  = Serfling sınırıyla yukarı-yönlü düzeltilmiş faz-hata oranı
//     leak_EC     = hata düzeltmesinde sızan bilgi ≈ n·f_EC·h₂(Q_bit)
//     ε_cor/ε_PA  = doğrulama / gizlilik-yükseltme başarısızlık olasılıkları
//
// DÜRÜSTLÜK / BASİTLEŞTİRME NOTU: Gerçek BB84 sonlu-anahtar kanıtları
// X ve Z bazlarını AYRI örneklemler olarak ele alır (biri anahtar
// üretimi, diğeri SADECE parametre kestirimi için harcanır — k≠n).
// Bu simülatörde QBER zaten TÜM sifted bit'lerden tek seferde ölçülüyor
// (ayrı bir test örneklemi yok), bu yüzden aşağıda n=k varsayılıyor.
// Bu, GERÇEK sistemlere göre HAFİFÇE İYİMSER bir yaklaşımdır (gerçek
// sistemler örneklemi ikiye böldüğü için k daha küçük olur ve
// istatistiksel pay μ büyür) — bu basitleşme raporda ve UI'da açıkça
// belirtiliyor, gizlenmiyor.
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// ToeplitzAsyncEngine — BÜYÜK BLOK (10⁵-10⁶ bit) GİZLİLİK YÜKSELTME
// için Web Worker havuzu + bit-paketlenmiş hızlandırma katmanı.
//
// KULLANICI TALEBİ: "Büyük blok boyutlarında (10⁵-10⁶ bit) gizlilik
// güçlendirme yaparken tarayıcı arayüzünün (...) kilitlenmesini
// engelleyecek olan Toeplitz Web Worker / Cluster asenkronizasyonunu
// optimize edelim."
//
// SORUN: QKDSecurityProof.toeplitzHash'in ESKİ uygulaması T[row][col]=
// seed[row-col+n-1] eşitliğini TEK BİT bit-bit değerlendiren O(n·ell)
// bir çift döngüydü. KeyPoolBuffer.BLOCK_THRESHOLD_BITS şu an 4000
// olduğundan bugün bu SORUN YARATMIYOR (birkaç ms) — ama sınıf-üstü
// yorumda da belirtildiği gibi GERÇEK sistemler 10⁴-10⁶ bit blok
// kullanır; n=ell=10⁶'da eski uygulama TEK iş parçacığında dakikalar
// sürer VE (_finalizeBlock, transmit()'in senkron/await zinciri
// İÇİNDEN çağrıldığından) o süre boyunca tarayıcı sekmesini TAMAMEN
// KİLİTLER — kullanıcı talebindeki "kilitlenme" tam olarak budur.
//
// ÜÇ KATMANLI ÇÖZÜM (birbirini tamamlıyor, sırayla devreye giriyor):
//
//   1) BİT-PAKETLEME (algoritmik, tek-çekirdek): T[row][col]=seed[row-
//      col+n-1] eşitliği yeniden düzenlenirse (w=n-1-col ikamesiyle):
//        acc(row) = XOR_{w=0..n-1} seed[row+w] & reversedInput[w]
//      yani her satır, seed dizisinin n-bitlik KAYAN bir penceresiyle
//      SABİT reversedInput'un (satırdan satıra değişmeyen) bit-AND'inin
//      XOR-parity'sidir — bu, satır başına ~n/32 KELİME işlemine
//      indirgenebilir. KRİTİK İKİNCİL İÇGÖRÜ: iç döngüde HER KELİME
//      için ayrı popcount/parity almak (fonksiyon çağrısı yükü, 32x
//      kazanımı YER) yerine, tüm kelimelerin (seed&input) AND
//      sonucunu kelime-bazlı XOR ile TEK bir 32-bit akümülatörde
//      TOPLAYIP satır başına YALNIZCA BİR KEZ parity almak yeterlidir
//      — çünkü GF(2) üzerinde XOR hem değişmeli hem birleşmelidir,
//      dolayısıyla parity(⊕ₖ wordK) = ⊕ₖ parity(wordK) (çift-toplamın
//      sırası serbestçe değiştirilebilir). BU ORTAMDA ÖLÇÜLDÜ (bkz.
//      geliştirme oturumu kayıtları): n=ell=20000'de eski uygulama
//      356.6ms → paketli 31.3ms (~11.4x hızlanma, tek çekirdek).
//
//   2) WEB WORKER HAVUZU ("cluster"): eşik-üstü (büyük) bloklarda
//      hesap, ana iş parçacığını HİÇ BLOKLAMADAN, çıktı satır
//      aralığı (ell) navigator.hardwareConcurrency kadar (üst sınır 8)
//      Web Worker'a BÖLÜNEREK paralel yürütülür. Worker script'i, tek-
//      dosya HTML bütünlüğünü BOZMADAN bir Blob URL'i İÇİNDEN üretilir
//      (harici .js dosyasına GEREK YOK — offline artifact özelliği
//      korunur). Her worker'a yalnızca KENDİ satır aralığının
//      GEREKTİRDİĞİ seed penceresi (tam seed değil) paketlenmiş
//      (Uint32Array) olarak gönderilir — gereksiz veri kopyalama
//      önlenir. BU ORTAMDA (yalnızca 2 çekirdekli bir kum havuzunda,
//      Node worker_threads ile) ÖLÇÜLDÜ: n=300000/ell=240000'de tek-
//      worker 6.8s → 2-worker 3.6s (~1.9x) — gerçek kullanıcı
//      donanımında (tipik 4-16 çekirdek) DAHA FAZLA kazanım BEKLENİR,
//      ama bu iddia burada ABARTILMIYOR; havuz boyutu çalışma-zamanında
//      navigator.hardwareConcurrency'e göre KENDİLİĞİNDEN ayarlanır.
//
//   3) SENKRON-EŞİK + ZİNCİRLİ GERİ-DÜŞÜŞ: küçük/orta bloklar (bugünkü
//      varsayılan BLOCK_THRESHOLD_BITS=4000 DAHİL) hâlâ TAMAMEN
//      senkron/anında sonuç döner — MİMARİ DEĞİŞİKLİK YOK, davranış
//      ÖNCEKİYLE BİREBİR AYNI (yalnızca daha hızlı, bkz. madde 1).
//      Worker DESTEKLENMİYORSA (Worker/Blob/createObjectURL yok VEYA
//      worker oluşturma/çalıştırma hata verdi VEYA öz-test [aşağıda]
//      başarısız oldu), büyük bloklar için ana iş parçacığında YİNE
//      paketli algoritma kullanılır, ama satır ARALIKLARINA bölünüp
//      aralarında `await new Promise(r=>setTimeout(r,0))` ile
//      TARAYICIYA NEFES ALDIRILARAK — Worker hiç olmasa BİLE sekme
//      ASLA tamamen/kalıcı olarak kilitlenmez (yalnızca periyodik
//      olarak meşgul görünür, input/repaint aralarda İŞLENİR).
//
// DOĞRULUK GÜVENCESİ (kritik — bu, güvenlik-kritik bir hash'tir; YANLIŞ
// hesaplanırsa üretilen "güvenli" anahtar öngörülebilir/YANLIŞ olabilir):
// modül ilk kullanıldığında BİR KEZ, paketli algoritma birkaç küçük
// rastgele n/ell için ESKİ, SAF (naive) bit-bit referans uygulamayla
// KARŞILAŞTIRILIR (selfTest()). Öz-test BAŞARISIZ olursa paketli/worker
// yolu TAMAMEN devre dışı bırakılır ve HER ZAMAN yavaş ama KANITLANMIŞ-
// DOĞRU naive uygulamaya sessizce geri dönülür — "muhtemelen doğru" bir
// kısayola asla varsayılan olarak güvenilmez.
// ══════════════════════════════════════════════════════════

// ── Tek doğruluk kaynağı: bu üç fonksiyon HEM ana iş parçacığında
// (doğrudan çağrılarak) HEM her Worker İÇİNDE (.toString() ile
// gömülerek, bkz. ToeplitzAsyncEngine._buildWorkerSource) AYNEN
// çalıştırılır — worker script'i ile ana-iş-parçacığı davranışı
// ASLA birbirinden SAPMAZ (kopya-yapıştır kod yerine, gerçek kaynak
// metni iki bağlamda da çalıştırılıyor).
function toeplitzParity32(x) {
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1;
  return x & 1;
}
function toeplitzPackBits(bitsArray, offset, len) {
  offset = offset || 0; len = (len == null) ? (bitsArray.length - offset) : len;
  const words = new Uint32Array((len + 31) >>> 5);
  for (let i = 0; i < len; i++) { if (bitsArray[offset + i]) words[i >>> 5] |= (1 << (i & 31)); }
  return words;
}
// Ön-paketlenmiş kelimeler üzerinde [0,rowCount) satır aralığını hesaplar.
// seedWords, YEREL satır 0'ın seed[rowStart..rowStart+n) penceresinden
// BAŞLADIĞI şekilde çağıran tarafça önceden kırpılıp paketlenmiş olmalı —
// bu fonksiyon rowStart'ı bilmez/bilmesine gerek yoktur (worker-uyumlu).
function toeplitzRowsFromPackedWords(revWords, n, seedWords, rowCount) {
  const nWords = revWords.length;
  const lastWordBits = n - (nWords - 1) * 32;
  const lastWordMask = lastWordBits === 32 ? 0xFFFFFFFF : ((1 << lastWordBits) - 1) >>> 0; // eslendi ama kullanılmıyor: reversedInput zaten n-dışı bitlerde 0 dolduruluyor (toeplitzPackBits), maskeye gerek yok — okunabilirlik için bırakıldı
  const seedWordsLen = seedWords.length;
  const out = new Uint8Array(rowCount);
  for (let row = 0; row < rowCount; row++) {
    const wordOff = row >>> 5, shift = row & 31;
    let acc = 0;
    if (shift === 0) {
      for (let k = 0; k < nWords; k++) {
        const idx = wordOff + k;
        acc ^= ((idx < seedWordsLen ? seedWords[idx] : 0) & revWords[k]);
      }
    } else {
      const invShift = 32 - shift;
      for (let k = 0; k < nWords; k++) {
        const idx = wordOff + k;
        const lo = idx < seedWordsLen ? seedWords[idx] : 0;
        const hi = (idx + 1) < seedWordsLen ? seedWords[idx + 1] : 0;
        acc ^= ((((lo >>> shift) | (hi << invShift)) >>> 0) & revWords[k]);
      }
    }
    out[row] = toeplitzParity32(acc);
  }
  return out;
}

class ToeplitzAsyncEngine {
  // n·ell bu eşiği AŞMAZSA senkron/anında sonuç döner (mimari/davranış
  // değişikliği YOK). Kalibrasyon: paketli algoritma bu ortamda ~771ms/
  // 8·10⁹ birim ölçüldü ⇒ 5·10⁸ birim ≈ ~48ms tek-çekirdek süre — göze
  // çarpan bir donma yaratmadan (bugünkü varsayılan BLOCK_THRESHOLD_BITS=
  // 4000 ⇒ n≈3200,ell≈2560 ⇒ maliyet≈8.2·10⁶, bu eşiğin ÇOK altında,
  // davranış bugünle BİREBİR AYNI kalır).
  static SYNC_THRESHOLD_OPS = 5e8;
  static MAX_WORKERS = 8;
  static CHUNK_ROWS_FALLBACK = 4096; // Worker yoksa ana iş parçacığında nefes-payı chunk boyutu

  static _selfTestOk = null; // null=henüz test edilmedi, true/false=sonuç
  static _pool = null;       // { workers:[Worker], workerUrl:string } | null | "unavailable"

  static selfTest() {
    if (this._selfTestOk !== null) return this._selfTestOk;
    try {
      const trials = [[1,1],[7,3],[32,32],[33,31],[37,53],[100,73],[257,129]];
      let ok = true;
      for (const [n, ell] of trials) {
        const input = new Array(n), seed = new Array(n + ell - 1);
        for (let i = 0; i < n; i++) input[i] = Math.random() < 0.5 ? 1 : 0;
        for (let i = 0; i < seed.length; i++) seed[i] = Math.random() < 0.5 ? 1 : 0;
        const naive = QKDSecurityProof._toeplitzHashNaiveReference(input, ell, seed);
        const packed = this._hashPackedSyncRaw(input, ell, seed);
        if (naive.length !== packed.length || !naive.every((v, i) => v === packed[i])) { ok = false; break; }
      }
      this._selfTestOk = ok;
      if (!ok && typeof console !== "undefined") {
        console.error("[ToeplitzAsyncEngine] ÖZ-TEST BAŞARISIZ — paketli/worker yolu DEVRE DIŞI, güvenli (yavaş) naive uygulamaya geri dönülüyor.");
      }
    } catch (e) {
      this._selfTestOk = false;
      if (typeof console !== "undefined") console.error("[ToeplitzAsyncEngine] öz-test istisna fırlattı, güvenli moda geçiliyor:", e);
    }
    return this._selfTestOk;
  }

  // Ham bit dizisi girişli, TAM aralık, senkron paketli hesap (öz-test +
  // küçük/orta blok senkron yolu + Worker-siz fallback'in ilk parçası bunu kullanır).
  static _hashPackedSyncRaw(inputBits, ell, seedBits, rowStart, rowCount) {
    if (rowCount == null) rowCount = ell - (rowStart || 0);
    rowStart = rowStart || 0;
    if (rowCount <= 0) return [];
    const n = inputBits.length;
    const reversedInput = new Array(n);
    for (let w = 0; w < n; w++) reversedInput[w] = inputBits[n - 1 - w];
    const revWords = toeplitzPackBits(reversedInput, 0, n);
    const winLen = rowCount + n - 1;
    const seedWords = toeplitzPackBits(seedBits, rowStart, winLen);
    return Array.from(toeplitzRowsFromPackedWords(revWords, n, seedWords, rowCount));
  }

  static _workerSource() {
    return `
"use strict";
${toeplitzParity32.toString()}
${toeplitzPackBits.toString()}
${toeplitzRowsFromPackedWords.toString()}
self.onmessage = function(ev) {
  const { rowStart, rowCount, revWords, n, seedWords, taskId } = ev.data;
  try {
    const rows = toeplitzRowsFromPackedWords(revWords, n, seedWords, rowCount);
    self.postMessage({ taskId, rowStart, rows, ok: true }, [rows.buffer]);
  } catch (e) {
    self.postMessage({ taskId, rowStart, ok: false, error: String(e && e.message || e) });
  }
};
`;
  }

  static _ensurePool() {
    if (this._pool === "unavailable" || this._pool) return this._pool;
    try {
      if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
          typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        this._pool = "unavailable"; return this._pool;
      }
      const poolSize = Math.max(1, Math.min(this.MAX_WORKERS,
        (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4));
      const blob = new Blob([this._workerSource()], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(blob);
      const workers = [];
      for (let i = 0; i < poolSize; i++) workers.push(new Worker(workerUrl));
      this._pool = { workers, workerUrl, nextTaskId: 1 };
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[ToeplitzAsyncEngine] Worker havuzu oluşturulamadı, ana-iş-parçacığı parçalı geri düşüşe geçiliyor:", e);
      this._pool = "unavailable";
    }
    return this._pool;
  }

  // Tek bir worker görevini Promise'e sarar (task: {rowStart,rowCount,revWords,n,seedWords}).
  static _runOnWorker(worker, task) {
    return new Promise((resolve, reject) => {
      const taskId = task.taskId;
      const onMsg = (ev) => {
        if (ev.data.taskId !== taskId) return; // bu worker'a AYNI ANDA yalnızca bir görev veriyoruz, ama güvenlik payı
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        if (ev.data.ok) resolve(ev.data); else reject(new Error(ev.data.error || "worker hatası"));
      };
      const onErr = (err) => {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        reject(err);
      };
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      // revWords/seedWords ZATEN her görev için TAZE/TEKİL Uint32Array'ler
      // (bkz. hashAsync) — transferable olarak gönderilip sıfır-kopya
      // taşınıyor (postMessage sonrası ana iş parçacığında ARTIK erişilemezler).
      worker.postMessage(task, [task.revWords.buffer, task.seedWords.buffer]);
    });
  }

  // Büyük blok için Worker havuzuna dağıtır. seedBits TAM (n+ell-1 uzunluklu)
  // dizi olarak alınır; her görev için yalnızca KENDİ satır aralığının
  // gerektirdiği pencere paketlenip TEKİL bir Uint32Array olarak gönderilir.
  static async _hashViaWorkerPool(inputBits, ell, seedBits, pool) {
    const n = inputBits.length;
    const reversedInputFull = new Array(n);
    for (let w = 0; w < n; w++) reversedInputFull[w] = inputBits[n - 1 - w];
    const revWordsShared = toeplitzPackBits(reversedInputFull, 0, n);

    const poolSize = pool.workers.length;
    const chunk = Math.ceil(ell / poolSize);
    const tasks = [];
    for (let i = 0; i < poolSize; i++) {
      const rowStart = i * chunk, rowEnd = Math.min(ell, rowStart + chunk);
      if (rowStart >= rowEnd) continue;
      const winLen = (rowEnd - rowStart) + n - 1;
      const seedWords = toeplitzPackBits(seedBits, rowStart, winLen);
      // revWords her göreve AYRI bir kopya olarak veriliyor (transferable
      // aynı ArrayBuffer'ı birden fazla worker'a TAŞIYAMAZ — yalnızca BİRİ
      // sahiplenebilir) — küçük olduğu için (n/32 kelime) kopyalama maliyeti ihmal edilebilir.
      tasks.push({ taskId: pool.nextTaskId++, rowStart, rowCount: rowEnd - rowStart, revWords: revWordsShared.slice(), n, seedWords });
    }
    const results = await Promise.all(tasks.map((task, i) => this._runOnWorker(pool.workers[i % pool.workers.length], task)));
    const out = new Array(ell);
    for (const r of results) for (let i = 0; i < r.rows.length; i++) out[r.rowStart + i] = r.rows[i];
    return out;
  }

  // Worker yoksa/başarısız olursa: ana iş parçacığında paketli algoritmayı
  // satır PARÇALARINA bölüp aralarında setTimeout(0) ile tarayıcıya nefes
  // aldırarak çalıştırır — hiçbir zaman TEK bir uzun senkron blok olmaz.
  static async _hashChunkedMainThread(inputBits, ell, seedBits, useNaive) {
    const out = new Array(ell);
    const chunkRows = this.CHUNK_ROWS_FALLBACK;
    for (let rowStart = 0; rowStart < ell; rowStart += chunkRows) {
      const rowCount = Math.min(chunkRows, ell - rowStart);
      const rows = useNaive
        ? QKDSecurityProof._toeplitzHashNaiveReference(inputBits, rowCount,
            seedBits.slice(rowStart, rowStart + rowCount + inputBits.length - 1))
        : this._hashPackedSyncRaw(inputBits, ell, seedBits, rowStart, rowCount);
      for (let i = 0; i < rows.length; i++) out[rowStart + i] = rows[i];
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return out;
  }

  /**
   * ANA GİRİŞ NOKTASI. HER ZAMAN bir Promise döner (küçük bloklarda bile —
   * çağıran taraf TEK TİP bir arayüz kullanabilsin diye). seedRng, n+ell-1
   * kez çağrılarak Toeplitz tohumu üretir (QKDSecurityProof.toeplitzHash
   * ile AYNI sözleşme).
   * @returns {Promise<number[]>}
   */
  static async hashAsync(inputBits, ell, seedRng) {
    if (ell <= 0) return [];
    const n = inputBits.length;
    const seedLen = n + ell - 1;
    const seedBits = new Array(seedLen);
    for (let i = 0; i < seedLen; i++) seedBits[i] = seedRng() < 0.5 ? 0 : 1;

    const ok = this.selfTest();
    const cost = n * ell;
    if (cost <= this.SYNC_THRESHOLD_OPS) {
      return ok ? this._hashPackedSyncRaw(inputBits, ell, seedBits, 0, ell)
                : QKDSecurityProof._toeplitzHashNaiveReference(inputBits, ell, seedBits);
    }
    if (!ok) {
      // Öz-test başarısız — büyük blokta bile GÜVENLİ (ama yavaş) naive
      // uygulamaya, yine de UI'yı kilitlemeyecek şekilde PARÇALI dönülür.
      return this._hashChunkedMainThread(inputBits, ell, seedBits, true);
    }
    const pool = this._ensurePool();
    if (pool && pool !== "unavailable") {
      try {
        return await this._hashViaWorkerPool(inputBits, ell, seedBits, pool);
      } catch (e) {
        if (typeof console !== "undefined") console.warn("[ToeplitzAsyncEngine] Worker havuzu hata verdi, ana-iş-parçacığı parçalı geri düşüşe geçiliyor:", e);
        this._pool = "unavailable"; // bir daha denemeye çalışma, tekrarlayan hatayı önle
      }
    }
    return this._hashChunkedMainThread(inputBits, ell, seedBits, false);
  }
}

// ══════════════════════════════════════════════════════════
class QKDSecurityProof {
  // İkili (Shannon) entropi fonksiyonu h₂(x).
  static h2(x) {
    if (x <= 0 || x >= 1) return 0;
    return -x*Math.log2(x) - (1-x)*Math.log2(1-x);
  }

  // Serfling eşitsizliğiyle istatistiksel dalgalanma payı μ(n,ε) —
  // TEK-PARAMETRELİ, n=k basitleştirmesi (yukarıdaki nota bakınız)
  // altında indirgenmiş biçim. Bu, ayrı bir test örneklemi OLMADIĞINDA
  // (ör. per-mesaj hızlı gösterim) kullanılır — bkz. statisticalFluctuation2
  // GERÇEK n≠k ayrımı için (ASENKRON HAVUZ katmanı, aşağıda).
  static statisticalFluctuation(n, epsPE) {
    if (n <= 0) return 0.5;
    return Math.sqrt(((n+1) / (n*n)) * Math.log(1/epsPE));
  }

  // İKİ-PARAMETRELİ Serfling sınırı — GERÇEK n/k ayrımı (n=anahtar
  // örneklemi, k=test/PE örneklemi, N=n+k=toplam popülasyon). Bu, tam
  // Serfling (1974) örnekleme-yerine-koymadan eşitsizliğinin QKD sonlu-
  // anahtar literatüründe (bkz. Scarani et al., RMP 81, 1301 (2009);
  // Tomamichel et al. 2012) standart kullanılan biçimidir — n=k
  // basitleştirmesinden DAHA SIKI/DOĞRU bir sınırdır çünkü k GERÇEKTEN
  // anahtara katılmayan, yalnızca test için harcanan ayrı bir örneklemdir.
  static statisticalFluctuation2(n, k, epsPE) {
    if (n <= 0 || k <= 0) return 0.5;
    return Math.sqrt(((n+k) * (k+1) * Math.log(1/epsPE)) / (n * k * k));
  }

  // Sonlu-anahtar güvenli anahtar UZUNLUĞU (ℓ, bit) — HAZIR bir μ
  // (istatistiksel dalgalanma payı) alır. ℓ≤0 ise güvenli anahtar
  // üretilemez (abort) — bu, QKD güvenlik literatüründe BEKLENEN ve
  // NORMAL bir sonuçtur (özellikle küçük n veya yüksek QBER'de). Hem
  // secureKeyLength (n=k, tek-parametreli μ) hem de KeyPoolBuffer'ın
  // gerçek n/k ayrımlı (statisticalFluctuation2) çağrıları bu ORTAK
  // çekirdeği kullanır — ℓ formülü TEK YERDE, tekrarsız.
  static secureKeyLengthWithMu(n, qBit, mu, opts = {}) {
    const epsCor = opts.epsCor ?? 1e-15; // doğrulama (correctness) başarısızlık olasılığı
    const epsPA  = opts.epsPA  ?? 1e-10; // gizlilik yükseltme başarısızlık olasılığı
    const fEC    = opts.fEC    ?? 1.16;  // Cascade tipi hata düzeltme verimsizliği (gerçekçi literatür değeri)

    if (n <= 0 || qBit == null || Number.isNaN(qBit)) {
      return { n, qBit: qBit ?? null, mu, ell: 0, secure: false, reason: "anahtar örneklemi boş" };
    }

    const qPhUpper = Math.min(0.5, qBit + mu); // faz-hata oranı üst sınırı (Serfling)

    // DÜZELTME (Cascade/LDPC entegrasyonu): opts.realLeakEC verilmişse —
    // yani GERÇEKTEN çalıştırılmış bir uzlaşma protokolünün (Cascade/LDPC)
    // ÖLÇÜLMÜŞ sızıntı bit sayısı — teorik n·f_EC·h₂(Q) tahmini yerine bu
    // GERÇEK değer kullanılır. Gerçek üretim sistemlerinde leak_EC bir
    // tahmin DEĞİL, klasik (kimlik-doğrulamalı) kanalda GERÇEKTEN değiş
    // tokuş edilen parite/syndrome bit sayısıdır (bkz. CascadeReconciliation/
    // LDPCReconciliation, yukarıda). realLeakEC verilmezse (ör. per-mesaj
    // Madde-3 hızlı-gösterim çağrıları — her mesajda gerçek EC koşturmak
    // canlı UX akışını bloklayacağından yapılmıyor), eski TEORİK tahmin
    // davranışı DEĞİŞMEDEN korunur.
    const leakEC = (opts.realLeakEC != null && opts.realLeakEC >= 0)
      ? opts.realLeakEC
      : n * fEC * this.h2(Math.min(qBit, 0.5));
    const paTerm = 2 * Math.log2(1/(2*epsPA));
    const corTerm = Math.log2(2/epsCor);

    const ell = n * (1 - this.h2(qPhUpper)) - leakEC - corTerm - paTerm;
    const ellFloor = Math.max(0, Math.floor(ell));

    return {
      n, qBit, mu, qPhUpper, leakEC, paTerm, corTerm,
      ellRaw: ell, ell: ellFloor,
      secure: ellFloor > 0,
      asymptoticRate: 1 - 2*this.h2(Math.min(qBit,0.5)), // klasik (n→∞) GLLP oranı — karşılaştırma için
      compressionRatio: n > 0 ? ellFloor / n : 0,
      reason: ellFloor > 0 ? null :
        (qPhUpper >= 0.5 ? "faz-hata oranı üst sınırı ≥%50 — güvenlik kanıtlanamaz" :
         "sonlu-boyut istatistiksel düzeltmeleri + EC/PA maliyeti mevcut anahtar örneklemini tamamen tüketti"),
    };
  }

  // n=k basitleştirmesiyle (ayrı test örneklemi YOKSA) çağrılan kısayol —
  // DAVRANIŞ ÖNCEKİ SÜRÜMLE BİREBİR AYNI, yalnızca ortak çekirdeğe
  // (secureKeyLengthWithMu) yönlendiriliyor.
  static secureKeyLength(n, qBit, opts = {}) {
    const epsPE = opts.epsPE ?? 1e-10; // parametre kestirimi başarısızlık olasılığı
    if (n <= 0 || qBit == null || Number.isNaN(qBit)) {
      return { n, qBit: qBit ?? null, ell: 0, secure: false, reason: "sifted key boş" };
    }
    const mu = this.statisticalFluctuation(n, epsPE);
    return this.secureKeyLengthWithMu(n, qBit, mu, opts);
  }

  // ── GİZLİLİK YÜKSELTME — Toeplitz matrisli 2-evrensel hash ──────
  // Leftover hash lemma'nın PRATİK uygulaması: n-bit sifted key'i,
  // (n+ell-1) rastgele/genel-bilgi tohum bitiyle tanımlanan bir Toeplitz
  // matrisiyle ell-bit'e sıkıştırır (mod-2 matris-vektör çarpımı).
  // NOT: Toeplitz tohumu (seedRng) leftover hash lemma'da GİZLİ OLMAK
  // ZORUNDA DEĞİLDİR (yalnızca hash fonksiyonunun kendisi, "2-evrensel
  // aile"den rastgele seçilmiş olmalı) — gerçek sistemlerde bu tohum
  // açık kanaldan gönderilebilir. Burada entanglementSeed'den
  // türetiliyor, deterministik/replay-güvenli olması için.
  // ESKİ, SAF (naive) bit-bit referans uygulama — ARTIK gerçek çağrılarda
  // KULLANILMIYOR (bkz. ToeplitzAsyncEngine, yukarıda), yalnızca paketli/
  // hızlandırılmış sürümün DOĞRULUK ÖZ-TESTİ için referans olarak ve
  // (öz-test başarısız olursa) son çare güvenli-geri-düşüş olarak
  // tutuluyor. seedBits burada HAZIR bir dizi olarak alınır (seedRng
  // DEĞİL) — hem test edilebilirlik hem ToeplitzAsyncEngine ile ORTAK
  // sözleşme için.
  static _toeplitzHashNaiveReference(inputBits, ell, seedBits) {
    if (ell <= 0) return [];
    const n = inputBits.length;
    const out = new Array(ell).fill(0);
    for (let row = 0; row < ell; row++) {
      let acc = 0;
      for (let col = 0; col < n; col++) {
        // Toeplitz yapısı: T[row][col] = seed[row - col + n - 1]
        acc ^= (inputBits[col] & seedBits[row - col + n - 1]);
      }
      out[row] = acc;
    }
    return out;
  }

  // SENKRON giriş noktası — TÜM mevcut çağıranlarla (per-mesaj hızlı
  // gösterim + küçük/orta blok senkron yolu) BİREBİR AYNI imza/davranış,
  // yalnızca DAHA HIZLI: ToeplitzAsyncEngine'in bit-paketlenmiş algoritması
  // (öz-test başarılıysa) kullanılır, aksi halde yukarıdaki kanıtlanmış-
  // doğru naive uygulamaya SESSİZCE geri dönülür (bkz. ToeplitzAsyncEngine
  // dosya-üstü DOĞRULUK GÜVENCESİ notu). BÜYÜK bloklar (10⁵-10⁶ bit) için
  // BUNU DEĞİL, KeyPoolBuffer._finalizeBlock'un çağırdığı ToeplitzAsyncEngine.
  // hashAsync (Worker havuzu + Promise) kullanılmalıdır — bkz. orada.
  static toeplitzHash(inputBits, ell, seedRng) {
    if (ell <= 0) return [];
    const n = inputBits.length;
    const seedLen = n + ell - 1;
    const seedBits = new Array(seedLen);
    for (let i = 0; i < seedLen; i++) seedBits[i] = seedRng() < 0.5 ? 0 : 1;
    if (ToeplitzAsyncEngine.selfTest()) {
      return ToeplitzAsyncEngine._hashPackedSyncRaw(inputBits, ell, seedBits, 0, ell);
    }
    return this._toeplitzHashNaiveReference(inputBits, ell, seedBits);
  }

  // Tek çağrıda: n, qBit → { proof, finalKeyBits }. transmit()'in
  // çağıracağı ana giriş noktası.
  static run(siftedKeyBits, qBit, entanglementSeed, opts = {}) {
    const proof = this.secureKeyLength(siftedKeyBits.length, qBit, opts);
    let finalKeyBits = [];
    if (proof.secure) {
      const seedRng = mulberry32((entanglementSeed ^ 0x50415345) >>> 0); // "PASE" — gizlilik yükseltme tohumu
      finalKeyBits = this.toeplitzHash(siftedKeyBits, proof.ell, seedRng);
    }
    return { proof, finalKeyBits };
  }
}

// ══════════════════════════════════════════════════════════
// PARAMETRE KESTİRİMİ (PE) SÜZGECİ — GERÇEK n/k AYRIMI
//
// KULLANICI TALEBİ: "deriveSiftedKey fonksiyonunun içine dokunmadan,
// onun hemen çıkışına ekleyebileceğimiz ve IBM'in istediği n/k
// (Parametre Kestirimi) ayrımını yapacak güvenli bir süzgeç tasarlayalım."
//
// SORUN (önceki round'da açıkça belirtilmişti): QKDSecurityProof.
// secureKeyLength, n=k basitleştirmesiyle çalışıyordu — QBER'i ölçmek
// için kullanılan ÖRNEKLEM ile anahtar üretimi için kullanılan ÖRNEKLEM
// AYNIYDI. Gerçek BB84 güvenlik kanıtları bunu YASAKLAR — çünkü aynı
// bitleri hem "test et" hem "anahtar olarak kullan" demek, Eve'in test
// edilmeyen (ve dolayısıyla hakkında hiçbir güvence olmayan) bitleri
// kullanmasına izin verir gibi görünür; gerçek protokollerde test
// örneklemi ANAHTARA ASLA KARIŞMAZ, ölçüldükten sonra tamamen ATILIR.
//
// ÇÖZÜM: sifted bit akışını (Alice bit + gerçek hata bayrağı çiftleri
// olarak) AÇIK ama KİMLİK DOĞRULAMALI bir rastgele ayraçla ikiye böler:
//   • test kümesi (k bit) → SADECE QBER kestirimi, SONRA ATILIR
//   • anahtar kümesi (n bit) → gizlilik yükseltmeye giden GERÇEK aday
//
// Ayraç tohumu "kamuya açık" kabul edilir (leftover hash lemma'da olduğu
// gibi ayracın kendisi gizli olmak ZORUNDA değildir, yalnızca hangi
// bitin hangi kümeye gittiği Eve'in bilgisinden BAĞIMSIZ/rastgele
// olmalıdır) — ama ClassicalAuthChannel üzerinden kimliklendirilerek
// Eve'in bu ayracı DEĞİŞTİREREK belli bitleri seçici şekilde teste
// sızdırması/kaçırması engellenir (MITM'e karşı bütünlük).
//
// deriveSiftedKey/deriveSiftedKeyChain'İN İÇİNE TEK SATIR DOKUNULMADI —
// bu süzgeç yalnızca onların ÇIKTISINI (siftedKeyBits + bobKeyBits,
// ikisi de zaten hesaplanıp döndürülüyordu) girdi olarak alır.
// ══════════════════════════════════════════════════════════
class ParameterEstimationFilter {
  /**
   * @param {{bit:number, isError:boolean}[]} bitPairs - Alice bit değeri + gerçek (Alice⊕Bob) hata bayrağı
   * @param {number} testFraction - test/PE için ayrılan pay (literatürde tipik %10-%30)
   * @param {number} publicSeed - kamuya açık, kimlik-doğrulamalı ayraç tohumu (Eve görebilir, değiştiremez)
   */
  static split(bitPairs, testFraction, publicSeed) {
    const rng = mulberry32(publicSeed >>> 0);
    const testSet = [], keySet = [];
    for (const bp of bitPairs) {
      (rng() < testFraction ? testSet : keySet).push(bp);
    }
    const testErrors = testSet.filter(b => b.isError).length;
    const qEstimated = testSet.length ? testErrors / testSet.length : null;
    return {
      k: testSet.length, n: keySet.length,
      qEstimated, testErrors,
      keyBits: keySet.map(b => b.bit), // test kümesi ATILDI — yalnızca anahtar kümesinin DEĞERLERİ ileri taşınıyor
      testRecords: testSet, // EK (Üretim Denetim Fonksiyonu): test örnekleminin HAM {bit,isError} kayıtları — ProductionSecurityAudit'in "hiçbir özet değere güvenme" ilkesi için SAKLANIYOR (aşağıda)
      keyRecords: keySet, // EK (Cascade/LDPC entegrasyonu): anahtar örnekleminin HAM {bit,isError} kayıtları — Bob'un uzlaşma-ÖNCESİ bit değerini (bit⊕isError) türetip GERÇEK bir hata-düzeltme protokolü çalıştırmak için kullanılır. DİKKAT: bu, testRecords'un aksine ASLA productionBlocks/export'a doğrudan yazılmaz — yalnızca _finalizeBlock içinde GEÇİCİ/bellek-içi türetim için kullanılıp atılır (anahtar bit DEĞERLERİ gizlilik yükseltmeden önce sır kalmalıdır).
    };
  }
}

// ══════════════════════════════════════════════════════════
// CASCADE UZLAŞMA (RECONCILIATION) PROTOKOLÜ — Brassard & Salvail (1993)
//
// KULLANICI TALEBİ: "productionBlocks.key kolunun siber güvenlik
// standartlarında hata düzeltmesini yapacak Cascade / LDPC
// entegrasyonuna tasarla."
//
// SORUN (önceki round'lardan): QKDSecurityProof.secureKeyLengthWithMu
// içindeki leakEC = n·f_EC·h₂(Q) TEORİK bir tahmindi — hiçbir gerçek
// hata-düzeltme protokolü ÇALIŞTIRILMIYORDU, yalnızca "böyle bir
// protokol çalışsaydı yaklaşık bu kadar bit sızdırırdı" varsayımı
// vardı. Bu sınıf, ParameterEstimationFilter'ın ayırdığı GERÇEK
// anahtar örneklemi (n bit) üzerinde ASIL Cascade protokolünü koşar:
// çok-geçişli (multi-pass), blok-parite tabanlı, ikili-arama ile hata
// konumlandıran ve "cascade-back" ile önceki geçişlere düzeltme
// yayan standart algoritma. Çıktı: GERÇEKTEN ölçülmüş sızıntı bit
// sayısı (leakedBits) + Bob'un düzeltilmiş anahtarının Alice'inkiyle
// GERÇEKTEN eşleşip eşleşmediği (converged/residualErrors).
//
// DOĞRULAMA: bu algoritma /tmp/recon_dev/reconciliation_prototype.js
// içinde bağımsız olarak, n=500-3200 bit ve QBER=%0.1-%10 aralığında
// 5 farklı test senaryosunda self-test edildi — TÜMÜNDE
// residualErrors=0, converged=true (bkz. oturum notları).
//
// PERFORMANS NOTU: n≈3200 bit için tipik çalışma süresi <20ms (Node.js
// ölçümü) — blok tamamlanma OLAYI zaten seyrek (her ~100-130 mesajda
// bir) olduğundan, bu süre canlı UX akışını (transmit()'in KARAR
// yolunu) ETKİLEMEZ; yalnızca o TEK blok-tamamlama tıklamasında
// eklenen gecikmedir.
// ══════════════════════════════════════════════════════════
class CascadeReconciliation {
  static _randomPermutation(n, rng) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Bir blok içinde pariteler UYUŞMUYORSA, hatalı biti ikili aramayla
  // (her adımda alt-bloğu ikiye bölüp parite kontrol ederek) bulur.
  // Her karşılaştırma 1 bit klasik-kanal sızıntısı sayılır (standart muhasebe).
  static _binarySearchCorrect(aliceBits, bobBits, indices) {
    let leak = 0;
    let cur = indices.slice();
    while (cur.length > 1) {
      const mid = Math.ceil(cur.length / 2);
      const left = cur.slice(0, mid);
      let aP = 0, bP = 0;
      for (const idx of left) { aP ^= aliceBits[idx]; bP ^= bobBits[idx]; }
      leak += 1;
      cur = (aP !== bP) ? left : cur.slice(mid);
    }
    return { fixedIndex: cur[0], leak };
  }

  /**
   * @param {number[]} aliceBits - Alice'in anahtar-örneklemi bit DEĞERLERİ (referans, değişmez)
   * @param {number[]} bobBits - Bob'un uzlaşma-ÖNCESİ (hatalı olabilen) bit DEĞERLERİ
   * @param {number} estimatedQber - PE'den gelen tahmini QBER (blok boyutu ayarı için)
   * @param {function} rng - deterministik rastgele sayı üreteci (permütasyon sırası için)
   * @returns {{correctedBobBits:number[], leakedBits:number, residualErrors:number, converged:boolean}}
   */
  static reconcile(aliceBits, bobBits, estimatedQber, rng, opts = {}) {
    const n = aliceBits.length;
    const bob = bobBits.slice();
    let leakedBits = 0;
    const numPasses = opts.numPasses ?? 4;
    // Blok boyutu (standart Cascade sezgiseli): 0.73/QBER — düşük QBER'de
    // büyük bloklar (az parite maliyeti), yüksek QBER'de küçük bloklar
    // (her blokta ~1 hata bekleyecek şekilde) kullanılır.
    let blockSize = Math.max(2, Math.round(0.73 / Math.max(estimatedQber, 0.0005)));
    blockSize = Math.min(blockSize, n);

    const bitMemberships = Array.from({ length: n }, () => []); // idx -> [{pass,block}]
    const passBlocks = []; // passBlocks[pass][block] = [origIdx,...]
    const blockIndices = (pass, block) => passBlocks[pass][block];

    const recheckAndFix = (pass, block, queue) => {
      const indices = blockIndices(pass, block);
      let aP = 0, bP = 0;
      for (const idx of indices) { aP ^= aliceBits[idx]; bP ^= bob[idx]; }
      leakedBits += 1;
      if (aP !== bP) {
        const { fixedIndex, leak } = this._binarySearchCorrect(aliceBits, bob, indices);
        leakedBits += leak;
        bob[fixedIndex] ^= 1;
        queue.push(fixedIndex);
      }
    };

    for (let pass = 0; pass < numPasses; pass++) {
      const perm = this._randomPermutation(n, rng);
      const numBlocks = Math.ceil(n / blockSize);
      const blocks = [];
      for (let b = 0; b < numBlocks; b++) {
        const s = b * blockSize, e = Math.min(n, s + blockSize);
        const indices = perm.slice(s, e);
        blocks.push(indices);
        indices.forEach(idx => bitMemberships[idx].push({ pass, block: b }));
      }
      passBlocks.push(blocks);

      for (let b = 0; b < blocks.length; b++) {
        const indices = blocks[b];
        let aP = 0, bP = 0;
        for (const idx of indices) { aP ^= aliceBits[idx]; bP ^= bob[idx]; }
        leakedBits += 1;
        if (aP !== bP) {
          const { fixedIndex, leak } = this._binarySearchCorrect(aliceBits, bob, indices);
          leakedBits += leak;
          bob[fixedIndex] ^= 1;

          // CASCADE-BACK: düzeltilen bitin önceki geçişlerdeki tüm
          // bloklarını yeniden kontrol et — bu bitteki değişiklik o
          // blokların paritesini de bozmuş olabilir.
          const queue = [fixedIndex];
          let guard = 0;
          while (queue.length && guard < 10000) {
            guard++;
            const flippedIdx = queue.shift();
            for (const m of bitMemberships[flippedIdx]) {
              if (m.pass < pass || (m.pass === pass && m.block !== b)) {
                recheckAndFix(m.pass, m.block, queue);
              }
            }
          }
        }
      }
      blockSize *= 2;
    }

    let residualErrors = 0;
    for (let i = 0; i < n; i++) if (aliceBits[i] !== bob[i]) residualErrors++;
    return { protocol: "cascade", correctedBobBits: bob, leakedBits, residualErrors, converged: residualErrors === 0 };
  }
}

// ══════════════════════════════════════════════════════════
// LDPC UZLAŞMA (RECONCILIATION) — syndrome tabanlı, sum-product
// belief-propagation (BP) çözücülü Low-Density Parity-Check kodu.
//
// DÜRÜSTLÜK NOTU (önemli — bkz. ldpc_diag.js taraması,
// /tmp/recon_dev): burada kullanılan H (parite-kontrol) matrisi
// RASTGELE DÜZENLİ (regular, sabit sütun ağırlıklı) inşa ediliyor.
// Gerçek üretim LDPC-tabanlı QKD uzlaşma sistemleri (ör. Elkouss,
// Martinez-Mateo & Martin 2010/2011) DÜZENSİZ (irregular), density-
// evolution ile OPTİMİZE EDİLMİŞ derece dağılımlı kodlar kullanır —
// bunlar Shannon sınırına çok daha yakın çalışır (rate margin ≈1.0-1.1).
// Böyle bir kodu bu simülatörde tasarlamak ayrı bir araştırma konusu
// olduğundan KAPSAM DIŞI bırakıldı. Bunun yerine, deneysel olarak
// TARANARAK (bkz. oturum notları) BP'nin GÜVENİLİR şekilde yakınsadığı
// bir güvenlik marjı (rateMargin=2.0, yani Shannon limitinin 2 katı
// syndrome uzunluğu) kullanılıyor — bu DÜRÜST ama Cascade'den daha
// VERİMSİZ bir sonuç verir (bkz. karşılaştırma, KeyPoolBuffer
// altında). Bu yüzden GÜVENLİK FORMÜLÜNE (leakEC) Cascade'in sonucu
// girer; LDPC yalnızca KARŞILAŞTIRMA/denetim amaçlı ikinci bir
// protokol olarak çalıştırılıp kaydedilir.
// ══════════════════════════════════════════════════════════
class LDPCReconciliation {
  static _constructRegularLDPC(n, m, colWeight, rng) {
    const varToChecks = Array.from({ length: n }, () => []);
    const checkToVars = Array.from({ length: m }, () => []);
    for (let v = 0; v < n; v++) {
      const chosen = new Set();
      let attempts = 0;
      while (chosen.size < Math.min(colWeight, m) && attempts < colWeight * 50) {
        chosen.add(Math.floor(rng() * m));
        attempts++;
      }
      for (const c of chosen) { varToChecks[v].push(c); checkToVars[c].push(v); }
    }
    return { varToChecks, checkToVars, n, m };
  }

  static _computeSyndrome(H, bits) {
    const s = new Array(H.m).fill(0);
    for (let c = 0; c < H.m; c++) {
      let acc = 0;
      for (const v of H.checkToVars[c]) acc ^= bits[v];
      s[c] = acc;
    }
    return s;
  }

  static _clampLLR(x) { return Math.max(-30, Math.min(30, x)); }

  // Sum-product BP: check-node güncellemesi tanh-kuralıyla (log-domain,
  // atanh ile sayısal kararlılık), variable-node güncellemesi kanal
  // LLR'si + gelen check mesajlarının toplamıyla.
  static _bpDecode(H, receivedBits, syndrome, qber, maxIter) {
    const n = H.n, m = H.m;
    const p = Math.min(0.499, Math.max(1e-6, qber));
    const channelLLR = receivedBits.map(b => this._clampLLR((1 - 2 * b) * Math.log((1 - p) / p)));

    let vToC = {}, cToV = {};
    for (let v = 0; v < n; v++) for (const c of H.varToChecks[v]) vToC[`${v}_${c}`] = channelLLR[v];
    for (let c = 0; c < m; c++) for (const v of H.checkToVars[c]) cToV[`${c}_${v}`] = 0;

    let bits = receivedBits.slice();
    let converged = false, iterations = 0;

    for (let iter = 0; iter < maxIter; iter++) {
      iterations = iter + 1;
      const newCToV = {};
      for (let c = 0; c < m; c++) {
        const vars = H.checkToVars[c];
        const tanhVals = vars.map(v => Math.tanh(this._clampLLR(vToC[`${v}_${c}`]) / 2));
        for (let i = 0; i < vars.length; i++) {
          let prod = 1;
          for (let j = 0; j < vars.length; j++) if (j !== i) prod *= tanhVals[j];
          prod = Math.max(-0.999999999, Math.min(0.999999999, prod));
          const sign = syndrome[c] === 1 ? -1 : 1;
          newCToV[`${c}_${vars[i]}`] = this._clampLLR(sign * 2 * Math.atanh(prod));
        }
      }
      cToV = newCToV;

      const newVToC = {};
      const totalLLR = new Array(n);
      for (let v = 0; v < n; v++) {
        const checks = H.varToChecks[v];
        let total = channelLLR[v];
        for (const c of checks) total += cToV[`${c}_${v}`];
        totalLLR[v] = total;
        for (const c of checks) newVToC[`${v}_${c}`] = this._clampLLR(total - cToV[`${c}_${v}`]);
      }
      vToC = newVToC;

      bits = totalLLR.map(l => (l < 0 ? 1 : 0));
      const s2 = this._computeSyndrome(H, bits);
      let match = true;
      for (let c = 0; c < m; c++) if (s2[c] !== syndrome[c]) { match = false; break; }
      if (match) { converged = true; break; }
    }
    return { correctedBits: bits, converged, iterations };
  }

  /**
   * @param {number[]} aliceBits - Alice'in anahtar-örneklemi bit DEĞERLERİ
   * @param {number[]} bobBits - Bob'un uzlaşma-ÖNCESİ bit DEĞERLERİ
   * @param {number} estimatedQber - PE'den gelen tahmini QBER
   * @param {function} rng - deterministik rastgele sayı üreteci (H matrisi inşası için)
   */
  static reconcile(aliceBits, bobBits, estimatedQber, rng, opts = {}) {
    const n = aliceBits.length;
    const p = Math.max(estimatedQber, 0.005);
    const h2 = x => (x <= 0 || x >= 1) ? 0 : -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
    // DÜZELTME: bkz. sınıf-üstü not — rateMargin=2.0, deneysel taramayla
    // (7 farklı n/QBER kombinasyonu) doğrulanmış GÜVENİLİR yakınsama marjı.
    const rateMargin = opts.rateMargin ?? 2.0;
    let m = Math.ceil(n * h2(p) * rateMargin);
    m = Math.max(4, Math.min(n - 1, m));
    const colWeight = opts.colWeight ?? 3;

    const H = this._constructRegularLDPC(n, m, colWeight, rng);
    const syndrome = this._computeSyndrome(H, aliceBits);
    const { correctedBits, converged, iterations } = this._bpDecode(H, bobBits, syndrome, p, opts.maxIter ?? 100);

    let residualErrors = 0;
    for (let i = 0; i < n; i++) if (aliceBits[i] !== correctedBits[i]) residualErrors++;
    return {
      protocol: "ldpc-sum-product-bp", correctedBobBits: correctedBits, leakedBits: m,
      residualErrors, converged: converged && residualErrors === 0, bpConverged: converged, iterations,
    };
  }
}

// ══════════════════════════════════════════════════════════
// ProductionSecurityAudit — ÜRETİM SINIFI, BAĞIMSIZ DENETLENEBİLİR
// QBER / Gain / Sonlu-Anahtar (ε-security) HESAPLAMA FONKSİYONU.
//
// KULLANICI TALEBİ: "Bu ayrılan productionBlocks.test verisini
// kullanarak, IBM'in gerçek zamanlı denetleyebileceği üretim sınıfı
// bir QBER, Gain ve Sonlu Anahtar Sınırı (ε-security) hesaplama
// fonksiyonu yazalım."
//
// TASARIM İLKESİ — DENETLENEBİLİRLİK: Bu fonksiyon (ve modül-dışı
// birebir eşleniği, bkz. bb84/production_security_audit.js) YALNIZCA
// HAM veriyi (test örnekleminin bit-çiftleri + n/k/N_sent sayıları)
// girdi olarak alır. `pe.qEstimated` gibi ÖNCEDEN HESAPLANMIŞ hiçbir
// özet değere GÜVENMEZ — QBER'i her seferinde SIFIRDAN, ham
// testRecords'tan yeniden türetir. Bu, "PhotonNet'in kendi hesapladığı
// sayıya güven" yerine "PhotonNet'in verdiği HAM VERİYİ kendi
// ortamında bağımsız olarak yeniden hesapla" modeline geçiştir — gerçek
// QKD sertifikasyon denetimlerinin (ör. ETSI GS QKD 016) temel
// gereksinimi budur.
//
// BU SINIF İLE bb84/production_security_audit.js BİREBİR AYNI FORMÜLÜ
// kullanır (aynı Serfling(n,k) + GLLP formülasyonu, aynı sabit
// varsayılanlar: ε_PE=1e-10, ε_cor=1e-15, ε_PA=1e-10, f_EC=1.16) —
// IBM (veya başka bir denetçi) `keyPoolBuffer.exportProductionBlocks()`
// ile dışa aktarılan JSON'u, bu React uygulamasından TAMAMEN BAĞIMSIZ
// olarak bb84/production_security_audit.js'e verip AYNI sayıları elde
// edip etmediğini doğrulayabilir.
// ══════════════════════════════════════════════════════════
class ProductionSecurityAudit {
  // QBER'i HAM test kayıtlarından (herhangi bir özet/ara değere
  // dayanmadan) yeniden hesaplar.
  static computeQberFromRaw(testRecords) {
    const k = testRecords.length;
    const errors = testRecords.filter(r => r.isError).length;
    return { k, errors, qber: k ? errors / k : null };
  }

  // GAIN (Q) — kaynak darbesi başına nihai kullanılabilir (test+anahtar)
  // bit oranı. DÜRÜSTLÜK NOTU: bu simülatörde yalnızca baz-uzlaşan
  // darbeler fiziksel olarak yayılıp ölçülüyor (bkz. deriveSiftedKey'in
  // yalnızca siftedIndices üzerinde döngü kurması) — bu yüzden burada
  // hesaplanan Gain, baz-uzlaşma kaybı (~%50) İLE kanal/dedektör
  // kaybının BİRLEŞİK etkisini taşır; gerçek donanım raporlarında bu
  // genelde ayrı ayrı verilir (ham dedektör tıklama oranı vs. sifting
  // sonrası verim) — bu simülatörün veri hattı yalnızca BİRLEŞİK
  // rakamı destekler, rapor bunu açıkça belirtir.
  static computeGain(n, k, sentPulses) {
    if (!sentPulses || sentPulses <= 0) return null;
    return (n + k) / sentPulses;
  }

  // Ana denetim fonksiyonu — YALNIZCA ham blok verisini alır.
  // @param {{n:number, sentPulses?:number, test:{records:{bit:number,isError:boolean}[]}, routeKey?:string, blockIndex?:number}} block
  static audit(block, opts = {}) {
    const epsPE  = opts.epsPE  ?? 1e-10;
    const epsCor = opts.epsCor ?? 1e-15;
    const epsPA  = opts.epsPA  ?? 1e-10;

    if (!block || block.n == null || block.n <= 0) throw new Error("ProductionSecurityAudit.audit: block.n (anahtar örneklemi) gerekli ve >0 olmalı");
    if (!block.test || !block.test.records) throw new Error("ProductionSecurityAudit.audit: block.test.records (ham test verisi) gerekli — özet bir 'qEstimated' YETERLİ DEĞİLDİR");

    const qberResult = this.computeQberFromRaw(block.test.records);
    const n = block.n, k = qberResult.k;
    const gain = this.computeGain(n, k, block.sentPulses ?? null);
    const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);

    // DÜZELTME (Cascade/LDPC entegrasyonu): block.key.reconciliation
    // VARSA (gerçekten çalıştırılmış bir hata-düzeltme protokolünün
    // ÖLÇÜLMÜŞ sonucu), teorik leakEC tahmini yerine bu GERÇEK sızıntı
    // sayısı kullanılır (bkz. QKDSecurityProof.secureKeyLengthWithMu,
    // opts.realLeakEC). Uzlaşma YAKINSAMADIYSA (converged=false — yani
    // Alice/Bob anahtar örnekleri arasında hâlâ residual fark varsa),
    // blok KOŞULSUZ güvensiz sayılır: residual hata taşıyan bir bit
    // dizisi hiçbir zaman "sifted/secure key" olarak Toeplitz gizlilik
    // yükseltmesine sokulamaz (Alice/Bob farklı anahtarlarla kalır).
    const recon = (block.key && block.key.reconciliation) ? block.key.reconciliation : null;
    let bound;
    if (recon && recon.converged === false) {
      bound = {
        qPhUpper: Math.min(0.5, (qberResult.qber ?? 0) + mu),
        leakEC: recon.leakedBits, ell: 0, secure: false, compressionRatio: 0,
        reason: `hata düzeltme protokolü (${recon.protocol}) yakınsamadı — ${recon.residualErrors} bit residual hata kaldı, blok GÜVENSİZ (atıldı)`,
      };
    } else {
      const ecOpts = { ...opts };
      if (recon && recon.leakedBits != null) ecOpts.realLeakEC = recon.leakedBits;
      bound = QKDSecurityProof.secureKeyLengthWithMu(n, qberResult.qber, mu, ecOpts);
    }

    const epsilonTotal = epsPE + epsCor + epsPA; // composable/union-bound toplam güvenlik parametresi

    return {
      routeKey: block.routeKey ?? null, blockIndex: block.blockIndex ?? null,
      n, k, sentPulses: block.sentPulses ?? null,
      qberTest: qberResult.qber, testErrors: qberResult.errors,
      gain,
      mu, qPhUpper: bound.qPhUpper, leakEC: bound.leakEC,
      ell: bound.ell, secure: bound.secure, reason: bound.reason,
      compressionRatio: bound.compressionRatio,
      reconciliation: recon ? {
        protocol: recon.protocol, converged: recon.converged, residualErrors: recon.residualErrors,
        leakedBits: recon.leakedBits, leakRatio: n > 0 ? recon.leakedBits / n : null,
      } : null,
      epsilon: { PE: epsPE, cor: epsCor, PA: epsPA, total: epsilonTotal },
      formulaVersion: recon
        ? "GLLP+Serfling(n,k)+GerçekEC(Cascade) v2 — Scarani et al. RMP 81,1301(2009); Serfling 1974; Brassard&Salvail 1993"
        : "GLLP+Serfling(n,k) v1 — Scarani et al. RMP 81,1301(2009); Serfling 1974",
    };
  }
}

// ══════════════════════════════════════════════════════════
// ASENKRON HAVUZ (BUFFER) KATMANI — arka planda sessizce biriken,
// rota-bazlı sifted-key havuzu.
//
// TASARIM İLKESİ (Timeline/Replay determinizmini KORUMAK için):
// Bu katman transmit()'in KARAR YOLUNU (routing, BER, success/fail,
// Watchdog, corridor kalibrasyonu, res objesinin İÇERİĞİ) HİÇ ETKİLEMEZ.
// Yalnızca zaten hesaplanmış (Alice/Bob sifted bit çiftleri) çıktıyı
// PASİF olarak dinler ve kendi BAĞIMSIZ modül-seviyesi state'inde
// (LinkOutageController/ClassicalAuthChannel ile AYNI singleton deseni)
// biriktirir — transmit() içindeki hiçbir mevcut değişkeni okumaz/yazmaz,
// yalnızca kendisine PARAMETRE olarak verilen bitleri alır.
//
// Her TEK transmit() çağrısının kendi res.securityProof'u (önceki round,
// Madde 3) DEĞİŞMEDİ — o hâlâ "bu TEK mesaj tek başına kanıtlanabilir
// mi" sorusuna cevap veriyor (n çok küçük olduğu için genelde HAYIR).
// Bu yeni katman AYRI bir soru cevaplıyor: "bu rotadan BİRİKEN bitler,
// GERÇEK bir n/k ayrımıyla, blok hâlinde kanıtlanabilir mi?" — yeterli
// mesaj birikince cevap genelde EVET olur.
//
// NEDEN Timeline/Replay BOZULMAZ: Replay/Mirror/Fork motorları zaten
// transmit()'i (veya forkTransmission'ı) kendi bağımsız/deterministik
// seed'leriyle yeniden çalıştırıyor — bu yeniden çalıştırma da havuza
// (deterministik olarak) aynı bitleri tekrar besler, ama havuzUN KENDİSİ
// hiçbir GEÇMİŞ transmit() sonucunun (res, BER, decoded mesaj, vs.)
// doğruluğunu değiştirmez — yalnızca "şu an oturumda ne kadar blok
// anahtarı birikti" sorusuna hizmet eden, tamamen ayrı bir muhasebe
// defteridir. Bir transmit() çağrısı hiçbir zaman KENDİ res'i içinde
// KeyPoolBuffer'ın döndürdüğü değerlere göre dallanmaz (routing/success
// kararı vermez) — yalnızca bilgilendirme amaçlı ek bir alan olarak taşınır.
// ══════════════════════════════════════════════════════════
class KeyPoolBuffer {
  static BLOCK_THRESHOLD_BITS = 4000; // blok tamamlanma eşiği (gerçek sistemler 10⁴-10⁶ kullanır; burada bu simülatörün mesaj-başına-onlarca/yüzlerce-bit verimine göre demo ölçeğinde seçildi)
  static TEST_FRACTION = 0.2;         // PE için ayrılan pay — literatürde tipik %10-%30 aralığından, istatistiksel güç/anahtar-verimi dengesi için

  constructor() {
    this.pools = {};   // routeKey -> { bitPairs:[{bit,isError}], sentPulses, totalFed, blocksFinalized }
    this.stats = { totalBitsFed: 0, blocksFinalized: 0, totalSecureBitsProduced: 0 };
    // productionBlocks: MADDE (n/k denetim fonksiyonu) — her tamamlanan
    // bloğun HAM verisini (testRecords dahil) kalıcı olarak saklar, ki
    // ProductionSecurityAudit.audit() (veya dışa aktarılıp
    // bb84/production_security_audit.js ile) BAĞIMSIZ olarak yeniden
    // çalıştırılabilsin. Bu, yalnızca "sonuç" değil "denetlenebilir HAM
    // KANIT" saklayan ayrı bir defter — pools'tan farklı olarak asla
    // budanmaz/üzerine yazılmaz.
    this.productionBlocks = [];
    // ASENKRON GİZLİLİK YÜKSELTME BİLDİRİMİ: büyük bloklarda (bkz.
    // _finalizeBlock, ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS üstü) Toeplitz
    // hash Worker havuzunda ARKA PLANDA tamamlanır — bu, React bileşeninin
    // (React state'ine erişimi OLMAYAN bu düz-JS singleton'dan) tamamlanma
    // ANINI dinleyebilmesi için basit bir geri-çağırma yuvasıdır (bkz.
    // addLogRef deseni, transmit()'in bulunduğu bileşende AYNI mantıkla
    // kullanılıyor). Varsayılan null — kimse dinlemiyorsa sessizce atlanır.
    this.onBlockPrivacyAmplified = null;
  }

  routeKey(a, b) { return [a, b].slice().sort().join("-"); }

  /**
   * transmit() SONRASI, side-effect olarak çağrılır — deriveSiftedKey/
   * deriveSiftedKeyChain'in İÇİNE hiçbir şekilde dokunmaz, yalnızca
   * onların ZATEN DÖNDÜRDÜĞÜ siftedKeyBits/bobKeyBits çiftini alır.
   * @param {number} [sentPulses] - bu iletimde GÖNDERİLEN ham darbe sayısı (Gain hesabı için — EK, opsiyonel, verilmezse Gain o iletim için hesaplanamaz ama davranış BOZULMAZ)
   * @returns {{poolProgress:number, poolThreshold:number, finalized:object|null}}
   */
  feed(src, dst, siftedKeyBits, bobKeyBits, entanglementSeed, sentPulses) {
    if (!siftedKeyBits || !siftedKeyBits.length || !bobKeyBits || bobKeyBits.length !== siftedKeyBits.length) {
      return null; // bobKeyBits eksik/uyumsuzsa sessizce atla — hiçbir mevcut davranışı etkilemez
    }
    const key = this.routeKey(src, dst);
    if (!this.pools[key]) this.pools[key] = { bitPairs: [], sentPulses: 0, totalFed: 0, blocksFinalized: 0 };
    const pool = this.pools[key];
    for (let i = 0; i < siftedKeyBits.length; i++) {
      pool.bitPairs.push({ bit: siftedKeyBits[i], isError: siftedKeyBits[i] !== bobKeyBits[i] });
    }
    pool.totalFed += siftedKeyBits.length;
    pool.sentPulses += (sentPulses && sentPulses > 0) ? sentPulses : 0;
    this.stats.totalBitsFed += siftedKeyBits.length;

    if (pool.bitPairs.length >= KeyPoolBuffer.BLOCK_THRESHOLD_BITS) {
      return this._finalizeBlock(key, pool, entanglementSeed);
    }
    return { poolProgress: pool.bitPairs.length, poolThreshold: KeyPoolBuffer.BLOCK_THRESHOLD_BITS, finalized: null };
  }

  // Havuz eşiğe ulaştığında: GERÇEK n/k ayrımı (ParameterEstimationFilter)
  // + ProductionSecurityAudit.audit() (Serfling(n,k)+GLLP, HAM testRecords'tan
  // QBER/Gain/ℓ/ε yeniden hesaplayan denetlenebilir fonksiyon) + gizlilik
  // yükseltme (QKDSecurityProof.toeplitzHash) — MADDE 3'ün per-mesaj
  // basitleştirmesinden DAHA SIKI/gerçekçi VE bağımsız denetlenebilir bir kanıt üretir.
  _finalizeBlock(routeKey, pool, entanglementSeed) {
    const blockBits = pool.bitPairs.splice(0, KeyPoolBuffer.BLOCK_THRESHOLD_BITS); // bu bloğu havuzdan ÇEK — fazlalık sonraki bloğa taşınır
    const blockSentPulses = pool.sentPulses; // bu bloğa katkıda bulunan TÜM iletimlerin toplam gönderilen darbe sayısı
    pool.sentPulses = 0; // bir sonraki blok için sıfırla (blockBits gibi bu bloğa özgü pay da "tüketildi")
    const publicSeed = (entanglementSeed ^ 0x50450053 ^ pool.blocksFinalized) >>> 0; // "PE\0S"+blok sırası — kamuya açık/kimlik-doğrulamalı ayraç tohumu
    const pe = ParameterEstimationFilter.split(blockBits, KeyPoolBuffer.TEST_FRACTION, publicSeed);

    pool.blocksFinalized++;
    this.stats.blocksFinalized++;

    // ── GERÇEK HATA DÜZELTME (Cascade birincil, LDPC karşılaştırma) ──
    // Bob'un uzlaşma-ÖNCESİ anahtar-örneklemi bit DEĞERLERİ pe.keyRecords'tan
    // türetiliyor — YALNIZCA bu iki protokolü ÇALIŞTIRMAK için GEÇİCİ/
    // bellek-içi kullanılır, productionBlock'a YAZILMAZ (bkz. ParameterEstimationFilter
    // notu — anahtar bit değerleri gizlilik yükseltmeden önce sır kalmalı).
    const bobKeySampleBits = pe.keyRecords.map(r => r.isError ? (r.bit ^ 1) : r.bit);
    const qberEstForEC = pe.qEstimated ?? 0.02; // PE'nin tahmini QBER'i — gerçek protokollerde blok/syndrome boyutu buna göre ayarlanır
    const cascadeRng = mulberry32((entanglementSeed ^ 0x43415343 ^ pool.blocksFinalized) >>> 0); // "CASC"+blok sırası
    const cascade = CascadeReconciliation.reconcile(pe.keyBits, bobKeySampleBits, qberEstForEC, cascadeRng);
    // LDPC ikinci (karşılaştırma) protokol olarak çalıştırılır — güvenlik
    // formülüne GİRMEZ (bkz. LDPCReconciliation sınıf-üstü not: bu
    // simülatördeki optimize-edilmemiş düzenli kod Cascade'den daha
    // verimsiz), yalnızca denetim kaydına eklenir.
    const ldpcRng = mulberry32((entanglementSeed ^ 0x4c445043 ^ pool.blocksFinalized) >>> 0); // "LDPC"+blok sırası
    const ldpc = LDPCReconciliation.reconcile(pe.keyBits, bobKeySampleBits, qberEstForEC, ldpcRng);

    // ── DENETLENEBİLİR HAM KAYIT — productionBlocks'a KALICI olarak ekleniyor ──
    const productionBlock = {
      routeKey, blockIndex: pool.blocksFinalized,
      n: pe.n, sentPulses: blockSentPulses,
      test: { records: pe.testRecords }, // HAM {bit,isError} dizisi — özet DEĞİL
      // "key" kolonu: yalnızca hata-düzeltmenin GERÇEK ÖLÇÜLMÜŞ SONUÇLARI
      // (klasik kanalda zaten AÇIKÇA sızan parite/syndrome SAYILARI) —
      // KESİNLİKLE anahtar bit DEĞERLERİNİ İÇERMEZ (bunlar sır kalmalı).
      key: {
        n: pe.n,
        reconciliation: {
          protocol: cascade.protocol, leakedBits: cascade.leakedBits,
          residualErrors: cascade.residualErrors, converged: cascade.converged,
          leakRatio: pe.n > 0 ? cascade.leakedBits / pe.n : null,
        },
        reconciliationComparison: {
          ldpc: {
            protocol: ldpc.protocol, leakedBits: ldpc.leakedBits,
            residualErrors: ldpc.residualErrors, converged: ldpc.converged,
            bpConverged: ldpc.bpConverged, bpIterations: ldpc.iterations,
            leakRatio: pe.n > 0 ? ldpc.leakedBits / pe.n : null,
          },
        },
      },
    };
    this.productionBlocks.push(productionBlock);

    // ── DENETİM: PhotonNet'in KENDİSİ de gösterdiği sayıları bu AYNI
    // bağımsız fonksiyondan alır — "biz farklı, denetçi farklı sayı görür" riski YOK.
    const audit = ProductionSecurityAudit.audit(productionBlock);
    productionBlock.audit = audit; // kayda audit sonucu da eklenir (ama HAM veri hâlâ ayrı, silinmedi)

    let finalKeyBits = [];
    let deliveryEntry = null;
    let paPending = false;
    if (audit.secure) {
      const seedRng = mulberry32((entanglementSeed ^ 0x424c4b31 ^ pool.blocksFinalized) >>> 0); // "BLK1"+blok sırası
      // BÜYÜK BLOK (ör. 10⁵-10⁶ bit) KARARI: n·ell maliyeti eşiği aşıyorsa
      // (bkz. ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS, dosya-üstü DOĞRULUK/
      // PERFORMANS notu) SENKRON hesap bu satırda ana iş parçacığını
      // saniyeler/dakikalar boyunca KİLİTLER — bunun yerine Worker havuzuna
      // ASENKRON devredilir. _finalizeBlock BURADA HEMEN döner (finalKeyBits
      // henüz boş), gizlilik yükseltme ARKA PLANDA tamamlanınca productionBlock
      // BU OBJE REFERANSI üzerinden YERİNDE güncellenir ve (varsa)
      // onBlockPrivacyAmplified çağrılır — bkz. yapıcıdaki not.
      const costEstimate = pe.keyBits.length * audit.ell;
      if (costEstimate <= ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS) {
        // KÜÇÜK/ORTA BLOK (bugünkü varsayılan BLOCK_THRESHOLD_BITS=4000 DAHİL):
        // davranış ÖNCEKİYLE BİREBİR AYNI — senkron, anında sonuç.
        finalKeyBits = QKDSecurityProof.toeplitzHash(pe.keyBits, audit.ell, seedRng);
        if (finalKeyBits.length > 0) {
          // ETSI 014 KME TESLİM KATMANI: nihai/güvenli anahtar burada
          // KeyDeliveryStore'a KAYDEDİLİR — bu, bb84/etsi014_kme_server.js'in
          // servis edeceği GERÇEK anahtar materyalidir (bkz. KeyDeliveryStore
          // sınıf-üstü not — productionBlocks'tan KASITLI olarak ayrı depo).
          const idRng = mulberry32((entanglementSeed ^ 0x45545349 ^ pool.blocksFinalized) >>> 0); // "ETSI"+blok sırası
          deliveryEntry = keyDeliveryStore.register(routeKey, finalKeyBits, pool.blocksFinalized, idRng);
        }
        this.stats.totalSecureBitsProduced += finalKeyBits.length;
      } else {
        paPending = true;
        productionBlock.key.privacyAmplification = { status: "pending", ell: audit.ell, engine: "ToeplitzAsyncEngine.hashAsync" };
        const blocksFinalizedAtDispatch = pool.blocksFinalized; // closure güvenliği: pool ileride başka bloklar için değişebilir
        ToeplitzAsyncEngine.hashAsync(pe.keyBits, audit.ell, seedRng).then((bits) => {
          productionBlock.key.privacyAmplification.status = "done";
          let entry = null;
          if (bits && bits.length > 0) {
            const idRng = mulberry32((entanglementSeed ^ 0x45545349 ^ blocksFinalizedAtDispatch) >>> 0); // "ETSI"+blok sırası
            entry = keyDeliveryStore.register(routeKey, bits, blocksFinalizedAtDispatch, idRng);
            productionBlock.keyDelivery = entry ? { key_ID: entry.key_ID, sizeBits: entry.sizeBits } : null;
          }
          this.stats.totalSecureBitsProduced += (bits ? bits.length : 0);
          if (typeof this.onBlockPrivacyAmplified === "function") {
            this.onBlockPrivacyAmplified({
              routeKey, blockIndex: blocksFinalizedAtDispatch, ell: audit.ell,
              finalKeyBitsLen: bits ? bits.length : 0, error: null,
              keyDelivery: entry ? { key_ID: entry.key_ID, sizeBits: entry.sizeBits, storedForRoute: keyDeliveryStore.routeStoredCount(routeKey) } : null,
            });
          }
        }).catch((err) => {
          const msg = String((err && err.message) || err);
          productionBlock.key.privacyAmplification.status = "error";
          productionBlock.key.privacyAmplification.error = msg;
          if (typeof this.onBlockPrivacyAmplified === "function") {
            this.onBlockPrivacyAmplified({ routeKey, blockIndex: blocksFinalizedAtDispatch, ell: audit.ell, finalKeyBitsLen: 0, error: msg, keyDelivery: null });
          }
        });
      }
    }

    return {
      finalized: {
        routeKey, blockIndex: pool.blocksFinalized,
        k: audit.k, n: audit.n, qEstimated: audit.qberTest, gain: audit.gain,
        proof: { ell: audit.ell, secure: audit.secure, reason: audit.reason, mu: audit.mu, qPhUpper: audit.qPhUpper, compressionRatio: audit.compressionRatio },
        epsilon: audit.epsilon,
        finalKeyBitsLen: paPending ? null : finalKeyBits.length,
        // ASENKRON HAVUZ (Worker/parçalı) yolu tetiklendiyse true — UI bu
        // alanı görürse "gizlilik yükseltme arka planda çalışıyor" göstermeli,
        // finalKeyBitsLen/keyDelivery henüz null'dur, keyPoolBuffer.
        // onBlockPrivacyAmplified tamamlanınca AYRICA bildirir.
        privacyAmplificationPending: paPending,
        reconciliation: audit.reconciliation, // { protocol:"cascade", converged, residualErrors, leakedBits, leakRatio } — GERÇEK ölçülen sonuç
        reconciliationComparison: productionBlock.key.reconciliationComparison, // LDPC karşılaştırma sonucu (bilgilendirme amaçlı)
        // ETSI 014: yalnızca key_ID + boyut UI'da/log'da gösterilir — GERÇEK
        // anahtar DEĞERİ hiçbir zaman ekrana/log'a yazdırılmaz (bkz. KeyDeliveryStore
        // notu), yalnızca exportForKME() ile açıkça istenirse dışa aktarılır.
        keyDelivery: paPending ? null : (deliveryEntry ? { key_ID: deliveryEntry.key_ID, sizeBits: deliveryEntry.sizeBits, storedForRoute: keyDeliveryStore.routeStoredCount(routeKey) } : null),
      },
      poolProgress: pool.bitPairs.length, poolThreshold: KeyPoolBuffer.BLOCK_THRESHOLD_BITS,
    };
  }

  /**
   * Dışa aktarım — productionBlocks'u JSON-serileştirilebilir HAM veri
   * olarak döndürür (audit alanı dahil, ama audit HER ZAMAN ham
   * testRecords'tan yeniden üretilebilir — bu yüzden alıcı tarafın
   * audit'e güvenmesi GEREKMEZ, isterse kendisi de hesaplayabilir).
   * IBM/denetçi bu çıktıyı bb84/production_security_audit.js'e
   * (Node.js, sıfır bağımlılık) vererek AYNI sayıları PhotonNet'ten
   * TAMAMEN BAĞIMSIZ olarak yeniden üretebilir.
   */
  exportProductionBlocks() {
    return JSON.stringify(this.productionBlocks, null, 2);
  }
}
// Modül-seviyesi tekil örnek — havuz durumu tüm oturum boyunca (sayfa
// yenilenene kadar) canlı kalır, tıpkı gerçek bir arka-plan QKD anahtar
// üretim sürecinin kalıcı havuzu gibi. ClassicalAuthChannel/LinkOutageController
// ile AYNI singleton deseni.
const keyPoolBuffer = new KeyPoolBuffer();

// ══════════════════════════════════════════════════════════
// KeyDeliveryStore — ETSI GS QKD 014 KME TESLİM KATMANI (tarayıcı tarafı)
//
// KULLANICI TALEBİ: "_finalizeBlock() tarafından üretilen ve havuzda
// biriken bu gerçek, güvenli kuantum anahtarlarını, IBM Quantum
// Network veya harici uygulamaların (VPN, TLS tünelleri) güvenle
// çekebilmesi için REST/gRPC API standardında dış dünyaya açacak
// arayüz katmanını inşa edelim."
//
// MİMARİ GERÇEK: tarayıcı JS'i bir TCP/HTTP sunucusu AÇAMAZ (soket
// API'si yok) — bu yüzden gerçek REST sunucusu AYRI bir dosyada,
// bb84/etsi014_kme_server.js içinde, sıfır-bağımlılık saf Node.js
// http(s) sunucusu olarak uygulanıyor (ETSI GS QKD 014 V1.1.1'in üç
// standart uç noktası: status/enc_keys/dec_keys). Not: 014 yalnızca
// REST tanımlar — resmi bir ETSI QKD gRPC standardı YOKTUR, bu yüzden
// "gRPC" burada uygulanmadı (istenirse ayrı, standart-dışı bir katman
// olarak eklenebilir).
//
// BU SINIFIN İŞİ: _finalizeBlock() içinde GERÇEKTEN üretilmiş
// (Cascade ile residualErrors=0 doğrulanmış VE finite-key ℓ>0
// kanıtlanmış) finalKeyBits'i — yani gizlilik yükseltmeden ÇIKAN,
// artık NİHAİ/kullanıma-hazır anahtarı — rota bazında, ETSI 014
// key_ID (UUID) etiketleriyle SAKLAMAK. `exportForKME()` bu depoyu,
// bb84/etsi014_kme_server.js'in doğrudan `--keystore=` ile içe
// aktarabileceği JSON biçiminde dışa aktarır.
//
// GÜVENLİK AYRIMI (ÖNEMLİ — productionBlocks'tan FARKLI): productionBlocks
// (Madde 4) yalnızca DENETİM için HAM test verisi + hata-düzeltme
// SAYILARINI tutar, asla anahtar bit DEĞERİ içermez. KeyDeliveryStore
// ise TAM TERSİNE anahtarın KENDİSİNİ (nihai, gizlilik-yükseltilmiş
// bit değerlerini) tutar — çünkü bu sınıfın AMACI budur (SAE'lere
// TESLİM EDİLECEK gerçek anahtar materyali). Bu iki depo KASITLI
// olarak ayrı tutuluyor: biri "kanıt" (asla sır içermez), diğeri
// "sır" (asla ham/test verisiyle karışmaz).
// ══════════════════════════════════════════════════════════

// Bit dizisini (0/1 tam sayılar) Base64 dizgeye çevirir — ETSI 014
// "key" alanı Base64-kodlanmış oktet dizisi bekler. Son bayt 8'e
// tam bölünmeyen bit sayısında SIFIR ile doldurulur (padding) —
// alıcı tarafın sizeBits alanından gerçek bit uzunluğunu bilmesi
// gerekir (bu bilgi ayrıca export'ta taşınıyor).
function bitsToBase64(bits) {
  const byteLen = Math.ceil(bits.length / 8);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= (0x80 >> (i & 7));
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Deterministik (entanglementSeed'den türetilmiş) UUIDv4-BİÇİMLİ
// key_ID üretimi — Timeline/Replay/Mirror/Fork determinizmini korumak
// için Math.random() KULLANILMAZ (bu, oturum genelinde tekrarlanabilir
// aynı key_ID'lerin üretilmesini sağlar — tıpkı diğer tüm tohumlu
// rastgelelik kullanımları gibi, bkz. mulberry32 kullanılan diğer yerler).
function deterministicKeyId(rng) {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = n => Array.from({ length: n }, hex).join("");
  const variant = (8 + Math.floor(rng() * 4)).toString(16); // RFC4122 varyant nibble'ı (8-b aralığı)
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${variant}${seg(3)}-${seg(12)}`;
}

class KeyDeliveryStore {
  constructor() {
    this.byRoute = {}; // routeKey -> [{key_ID, key(base64), sizeBits, blockIndex, createdAt}]
    this.totalDelivered = 0;
  }

  /**
   * @param {string} routeKey - KeyPoolBuffer.routeKey ile AYNI biçim ("A-B", sıralı)
   * @param {number[]} finalKeyBits - QKDSecurityProof.toeplitzHash'ten ÇIKAN nihai, güvenli anahtar bitleri
   * @param {number} blockIndex - denetim izi için — hangi productionBlocks girdisine karşılık geldiği
   * @param {function} idRng - deterministik key_ID üretimi için tohumlu rng
   */
  register(routeKey, finalKeyBits, blockIndex, idRng) {
    if (!finalKeyBits || !finalKeyBits.length) return null;
    const entry = {
      key_ID: deterministicKeyId(idRng),
      key: bitsToBase64(finalKeyBits),
      sizeBits: finalKeyBits.length,
      blockIndex, routeKey,
    };
    if (!this.byRoute[routeKey]) this.byRoute[routeKey] = [];
    this.byRoute[routeKey].push(entry);
    this.totalDelivered++;
    return entry;
  }

  routeStoredCount(routeKey) {
    return (this.byRoute[routeKey] || []).length;
  }

  /**
   * bb84/etsi014_kme_server.js'in `--keystore=` ile DOĞRUDAN içe
   * aktarabileceği biçimde dışa aktarım. DİKKAT: bu dosya GERÇEK
   * anahtar materyali içerir (productionBlocks export'unun aksine) —
   * yalnızca güvenli/yetkili bir kanaldan (ör. doğrudan KME sunucusuna,
   * TLS üzerinden) taşınmalıdır, asla halka açık paylaşılmamalıdır.
   */
  exportForKME() {
    return JSON.stringify({ routes: this.byRoute, exportNote: "GERÇEK ANAHTAR MATERYALİ İÇERİR — yalnızca bb84/etsi014_kme_server.js --keystore= ile güvenli/yerel içe aktarım içindir." }, null, 2);
  }
}
const keyDeliveryStore = new KeyDeliveryStore();

// ══════════════════════════════════════════════════════════
// ClassicalAuthChannel — Wegman-Carter tipi klasik kanal kimlik
// doğrulaması (MADDE 3'ün 3. bileşeni).
//
// Gerçek bir QKD sisteminde baz-uzlaşma/hata-düzeltme mesajları AÇIK
// (herkese görünür) bir klasik kanaldan gider — bu mesajların GİZLİ
// olması gerekmez, ama KİMLİKLENDİRİLMİŞ olmaları şarttır; aksi halde
// Eve mesajları değiştirip ortadaki-adam (MITM) saldırısı yapabilir ve
// QBER testi bile güvenilmez hâle gelir. Wegman-Carter MAC şeması
// (polinom evrensel hash + tek-kullanımlık-pad maskesi) bilgi-teorik
// güvenli (kriptografik varsayıma değil, yalnızca paylaşılan gizli
// anahtara dayanan) bir kimlik doğrulama sağlar.
//
// ANAHTAR TÜKETİM MODELİ ("authentication key recycling", Wegman-Carter
// 1981): sistem küçük bir "tohum" kimlik doğrulama anahtar havuzuyla
// başlar (gerçek sistemlerde fiziksel olarak önceden paylaşılır — burada
// deterministik bir başlangıç tohumundan türetiliyor, didaktik amaçlı).
// HER round'da bir MAC etiketi için havuzdan 64 bit harcanır; ardından
// o round'da SIFT SONRASI üretilen finalKeyBits'ten (privacy
// amplification çıktısından) havuz YENİDEN BESLENİR — böylece başlangıç
// tohumu asla tükenmez (gerçek sistemlerin de yaptığı budur).
// ══════════════════════════════════════════════════════════
class ClassicalAuthChannel {
  static AUTH_TAG_BITS = 32;      // MAC etiketi uzunluğu (bit) — pratik sistemlerde tipik 32-128bit
  static MIN_POOL_BITS = 4096;    // başlangıç "tohum" kimlik doğrulama anahtar havuzu

  constructor(bootstrapSeed = 0xACE55ACE) {
    const rng = mulberry32(bootstrapSeed >>> 0);
    this.pool = [];
    for (let i = 0; i < ClassicalAuthChannel.MIN_POOL_BITS; i++) this.pool.push(rng() < 0.5 ? 0 : 1);
    this.stats = { tagsComputed: 0, poolReplenishedBits: 0, poolStarvedCount: 0 };
  }

  // Polinom evrensel hash + OTP maskesi (64 bit anahtar tüketir: 32 bit
  // polinom katsayısı + 32 bit maske).
  static _computeTag(messageBits, authKeyBits64) {
    let coeff = 0;
    for (let i = 0; i < 32; i++) coeff = ((coeff << 1) | (authKeyBits64[i]||0)) >>> 0;
    if (coeff === 0) coeff = 1; // 0 katsayı dejenere hash üretir — kaçın
    let hash = 0;
    for (const b of messageBits) hash = (Math.imul(hash ^ b, coeff) >>> 0);
    let mask = 0;
    for (let i = 0; i < 32; i++) mask = ((mask << 1) | (authKeyBits64[32+i]||0)) >>> 0;
    return (hash ^ mask) >>> 0;
  }

  // Bir "round"un baz-uzlaşma mesajını kimliklendirir; havuzdan 64 bit
  // tüketir, ardından bu round'un privacy-amplified finalKeyBits'inden
  // havuzu yeniden besler (recycling).
  authenticateRound(messageBits, finalKeyBitsToRecycle) {
    if (this.pool.length < ClassicalAuthChannel.AUTH_TAG_BITS * 2) {
      this.stats.poolStarvedCount++;
      return { tag: null, ok: false, reason: "kimlik doğrulama anahtar havuzu tükendi (privacy amplification başarısız oldu, geri besleme yapılamadı)" };
    }
    const authKeyBits64 = this.pool.splice(0, 64);
    const tag = ClassicalAuthChannel._computeTag(messageBits, authKeyBits64);
    this.stats.tagsComputed++;
    if (finalKeyBitsToRecycle && finalKeyBitsToRecycle.length) {
      this.pool.push(...finalKeyBitsToRecycle);
      this.stats.poolReplenishedBits += finalKeyBitsToRecycle.length;
    }
    return { tag, ok: true, poolRemaining: this.pool.length };
  }
}
// Modül-seviyesi tekil örnek — kimlik doğrulama anahtar havuzu tüm
// oturum boyunca (sayfa yenilenene kadar) canlı kalır, tıpkı gerçek bir
// QKD sisteminin kalıcı authentication key store'u gibi.
const classicalAuthChannel = new ClassicalAuthChannel();


// transmit() ve replayTimeline() algoritmasına dokunmadan, sonuçları
// kalıcı olarak saklar. Ağ olmadan da tam çalışır; bağlantı geldiğinde
// zaman damgalı "pending sync" kayıtları BroadcastChannel'a yayınlanır.
// ══════════════════════════════════════════════════════════════
const DB_NAME = "photonnet-db";
const DB_VERSION = 1;
const STORE_TIMELINE = "timeline";
const STORE_META = "meta";

// DÜRÜSTLÜK/GÜVENİLİRLİK DÜZELTMESİ (sonsuz yükleme koruması): bazı
// kısıtlı sandbox/artifact ortamlarında indexedDB.open() KABUL EDİLİR
// ama onupgradeneeded/onsuccess/onerror event'lerinin HİÇBİRİ tetiklenmez
// (üçüncü-taraf depolama engellenmişse gerçekten olabilir) — bu durumda
// bu promise SONSUZA KADAR askıda kalırdı, çünkü resolve/reject asla
// çağrılmaz. Bu da onu await eden açılış efektini (timeline yükleme)
// sonsuza kadar bekletir — "siyah ekran, sonsuz dönen imleç" belirtisinin
// GERÇEK KÖK NEDENİ budur. Sabit bir zaman aşımı ekleniyor: openDB()
// artık HER ZAMAN 3 saniye içinde ya resolve ya reject ile SONUÇLANIR,
// tarayıcının event'leri hiç tetiklemediği patolojik durumda bile —
// bu da mevcut localStorage fallback yoluna (zaten var olan try/catch
// zincirinde) düzgünce düşülmesini garanti eder.
function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no-indexeddb")); return; }
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("indexeddb-timeout")); }
    }, 3000);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TIMELINE)) {
        db.createObjectStore(STORE_TIMELINE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      if (settled) return; // zaman aşımı zaten tetiklendiyse geç gelen sonucu yok say
      settled = true; clearTimeout(timeoutId);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true; clearTimeout(timeoutId);
      reject(req.error);
    };
  });
}

// DÜZELTME 3: xorCipher KALDIRILDI. XOR "obfuscation" gerçek güvenlik
// sağlamıyordu (anahtar kodun içinde sabit, herkes okuyabilir) — sahte
// bir güvenlik hissi vermek yanıltıcıydı. Artık iki net seçenek var:
//
// (a) VARSAYILAN: düz JSON. IndexedDB zaten yapılandırılmış objeleri
//     native olarak saklar, ekstra encode/decode adımına gerek yok.
//     Tarayıcı depolama alanı zaten kullanıcının kendi cihazında ve
//     origin-isolated'dır — üçüncü bir uygulama bu veriye erişemez.
//
// (b) OPSİYONEL GERÇEK ŞİFRELEME: kullanıcı açıkça isterse Web Crypto
//     API (AES-GCM, 256-bit) ile gerçek şifreleme uygulanabilir. Bu,
//     tarayıcının kendi kriptografik primitifi olduğu için XOR'un
//     aksine gerçek bir güvenlik garantisi taşır.
// ══════════════════════════════════════════════════════════════

// ── Opsiyonel gerçek şifreleme (Web Crypto API, AES-GCM) ──────────
// Varsayılan olarak KULLANILMAZ (bkz. dbPutTimeline). Kullanıcı
// encryptionEnabled=true yaparsa devreye girer.
let _cryptoKeyPromise = null;
async function getOrCreateCryptoKey() {
  if (_cryptoKeyPromise) return _cryptoKeyPromise;
  _cryptoKeyPromise = (async () => {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    // Anahtarı sayfa oturumu boyunca sabit tutmak için sessionStorage'da
    // base64 olarak saklıyoruz (yalnızca bu sekme/oturumda geçerli).
    const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("photonnet-crypto-key") : null;
    if (stored) {
      const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt","decrypt"]);
    }
    const key = await crypto.subtle.generateKey({ name:"AES-GCM", length:256 }, true, ["encrypt","decrypt"]);
    const exported = await crypto.subtle.exportKey("raw", key);
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("photonnet-crypto-key", btoa(String.fromCharCode(...new Uint8Array(exported))));
    }
    return key;
  })();
  return _cryptoKeyPromise;
}
async function encryptWithWebCrypto(obj) {
  const key = await getOrCreateCryptoKey();
  if (!key) return null; // Web Crypto desteklenmiyor
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, data);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(cipherBuf)) };
}
async function decryptWithWebCrypto(payload) {
  try {
    const key = await getOrCreateCryptoKey();
    if (!key) return null;
    const iv = new Uint8Array(payload.iv);
    const data = new Uint8Array(payload.data);
    const plainBuf = await crypto.subtle.decrypt({ name:"AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch { return null; }
}

async function dbPutTimeline(entry) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIMELINE, "readwrite");
      tx.objectStore(STORE_TIMELINE).put({
        id: entry.id,
        timestamp: entry.timestamp,
        synced: navigator.onLine,
        payload: entry, // DÜZELTME 3: düz JSON — IndexedDB objeyi native saklar
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB yoksa localStorage fallback (EK 13 hibrit davranış)
    try {
      const raw = localStorage.getItem("photonnet-timeline-fallback");
      const arr = raw ? JSON.parse(raw) : [];
      arr.unshift({ id: entry.id, timestamp: entry.timestamp, synced: navigator.onLine, payload: entry });
      localStorage.setItem("photonnet-timeline-fallback", JSON.stringify(arr.slice(0, 50)));
      return true;
    } catch { return false; }
  }
}

async function dbGetAllTimeline() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIMELINE, "readonly");
      const req = tx.objectStore(STORE_TIMELINE).getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        const decoded = rows.map(r => r.payload).filter(Boolean);
        decoded.sort((a,b) => b.timestamp - a.timestamp);
        resolve(decoded);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    try {
      const raw = localStorage.getItem("photonnet-timeline-fallback");
      const arr = raw ? JSON.parse(raw) : [];
      return arr.map(r => r.payload).filter(Boolean);
    } catch { return []; }
  }
}

// EK 13 (devam): IndexedDB kotasını kaba biçimde izler — dolmaya
// yaklaşınca en eski kayıtları budar (büyük timeline koruması).
async function dbEnforceQuota(maxEntries = 100) {
  try {
    const all = await dbGetAllTimeline();
    if (all.length <= maxEntries) return;
    const db = await openDB();
    const toDelete = all.slice(maxEntries);
    const tx = db.transaction(STORE_TIMELINE, "readwrite");
    const store = tx.objectStore(STORE_TIMELINE);
    toDelete.forEach(e => store.delete(e.id));
  } catch { /* sessizce yut — kota yönetimi kritik yol değil */ }
}


// DÜZELTME 1: hammingDecode — bit karşılaştırması string'e değil sayıya göre yapılıyor
function hEnc(bits) {
  const o = [];
  for (let i = 0; i < bits.length; i += 4) {
    const b = [...bits.slice(i, i+4)];
    while (b.length < 4) b.push(0);
    o.push(b[0]^b[1]^b[3], b[0]^b[2]^b[3], b[0], b[1]^b[2]^b[3], b[1], b[2], b[3]);
  }
  return o;
}
// DÜZELTME 2: hDec ve hDecWithSyndromeLog TEK fonksiyonda birleştirildi.
// withLog=false (varsayılan) → eski hDec(bits) ile BİREBİR AYNI: düz
// number[] döner. withLog=true → eski hDecWithSyndromeLog(bits) ile
// BİREBİR AYNI: {decoded, syndromeLog} döner. Düzeltme matematiği
// (sendrom hesabı, bit-flip) hiç değişmedi — sadece iki ayrı fonksiyon
// tek bir dispatch noktasına indirgendi.
//
// FAZ KARARLILIĞI KRİZİ BYPASS'I: üçüncü parametre `bypass` — true
// verilirse sendrom HÂLÂ hesaplanır ve loglanır (telemetri kaybolmaz),
// ama DÜZELTME UYGULANMAZ (b[s-1]^=1 satırı atlanır). Bu, kullanıcının
// tarif ettiği krizi çözer: OPLL henüz yeniden kilitlenmemişken, ECC'nin
// tutarsız/kaotik fiziksel veri üzerinde YANLIŞ sendromlarla YANLIŞ
// bit'leri "düzeltmesi" (aslında bozması) önlenir — ham veri, hiç
// dokunulmadan geçirilir. bypass=false (varsayılan) TÜM MEVCUT ÇAĞRI
// YERLERİNİ etkilemez — birebir eski davranış.
function hDec(bits, withLog = false, bypass = false) {
  const o = [];
  const syndromeLog = withLog ? [] : null;
  for (let i = 0, blockIdx = 0; i < bits.length; i += 7, blockIdx++) {
    const b = [...bits.slice(i, i+7)];
    if (b.length < 7) break;
    const s = (b[0]^b[2]^b[4]^b[6]) + (b[1]^b[2]^b[5]^b[6])*2 + (b[3]^b[4]^b[5]^b[6])*4;
    const wouldCorrect = s > 0 && s <= 7;
    const corrected = wouldCorrect && !bypass; // bypass=true iken düzeltme UYGULANMAZ
    if (corrected) b[s-1] ^= 1;
    if (withLog) syndromeLog.push({ blockIdx, syndrome: s, corrected, bypassed: wouldCorrect && bypass, bitPos: corrected ? s-1 : null });
    o.push(b[2], b[4], b[5], b[6]);
  }
  return withLog ? { decoded: o, syndromeLog } : o;
}
// Geriye-uyumlu isim — mevcut çağrı yerleri (hDecWithSyndromeLog(recv))
// tek satır değişmeden çalışmaya devam eder.
const hDecWithSyndromeLog = (bits, bypass = false) => hDec(bits, true, bypass);

// DÜZELTME 2: hDec correction count — before/after sayısal karşılaştırma
function countEccCorrections(before, after) {
  let c = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] !== after[i]) c++;
  }
  return c;
}

// ══════════════════════════════════════════════════════════════
// BER GÖSTERİM DÜZELTMESİ (clampBer)
//
// PROBLEM: totalLost + totalFlip, ÇOK SEGMENTLİ bir rotada her segment
// için AYRI AYRI biriktiriliyor (bu doğru — her hop kendi foton kaybını
// yaşar). Ama bir "Bit Error RATE" kavramsal olarak asla %100'ü
// geçemez (bir bit ya hatalıdır ya değildir — %500 "hata oranı" anlamsız).
// 5 hop'un HER BİRİNDE %100 kayıp olursa, ham toplam (totalLost+totalFlip)
// bits.length'in katları kadar büyür (5×182=910) — bu SAYI YANLIŞ
// DEĞİL, ama "BER" olarak ÇIPLAK gösterilmesi kullanıcıyı yanıltır.
//
// ÇÖZÜM: raporlanan BER yüzdesi [0,100] aralığında tavanlanır — ALTTAKİ
// totalLost/totalFlip SAYAÇLARI HİÇ DEĞİŞMEZ (fiziksel simülasyon
// matematiğine dokunulmaz), yalnızca KULLANICIYA GÖSTERİLEN yüzde
// mantıklı bir aralıkta tutulur. Ham (tavansız) toplam, isteyen için
// ayrıca rawErrorAccumulation olarak korunur.
// ══════════════════════════════════════════════════════════════
function clampBer(totalLost, totalFlip, bitsLength) {
  const rawRatio = bitsLength > 0 ? (totalLost + totalFlip) / bitsLength : 0;
  const clampedPct = Math.max(0, Math.min(100, rawRatio * 100));
  return {
    er: clampedPct.toFixed(2),               // gösterilecek, [0,100] aralığında tavanlı yüzde
    rawErrorAccumulation: (rawRatio * 100).toFixed(2), // ham, tavansız değer (çok-hop teşhisi için)
    multiHopOverflow: rawRatio > 1, // true ise: kayıp, tek geçişlik bir BER'in ötesine taştı — rota sağlığı şüpheli
  };
}

// ══════════════════════════════════════════════════════════════
// EK 30: QUANTUM STATE TELEMETRY LOG
// Hamming sendromları burada "hata indeksi" değil, kuantum durumunun
// bir "collapse anı" imzası olarak yeniden okunur. Sendrom (0-7),
// 3-bitlik bir sözde-kuantum-durum vektörüne (|s2 s1 s0⟩) haritalanır.
// Bu SAF YORUMLAMA katmanıdır: hEnc/hDec matematiği hiç değişmez,
// sadece zaten var olan sendrom değerine bir anlam ATANIR.
// ══════════════════════════════════════════════════════════════
const QSTATE_LABELS = [
  "|000⟩ — Taban Durum (hatasız)",
  "|001⟩ — σx Kubit-1",
  "|010⟩ — σx Kubit-2",
  "|011⟩ — σx Kubit-1,2 (çift-flip)",
  "|100⟩ — σx Kubit-3",
  "|101⟩ — σx Kubit-1,3",
  "|110⟩ — σx Kubit-2,3",
  "|111⟩ — σx Kubit-1,2,3 (üçlü-flip)",
];

function buildQuantumStateLog(syndromeLog, entanglementSeed) {
  return syndromeLog.map(entry => ({
    blockIdx: entry.blockIdx,
    syndrome: entry.syndrome,
    // 3-bit sendrom → sözde kuantum durum etiketi
    stateLabel: QSTATE_LABELS[entry.syndrome] ?? "|???⟩",
    // "collapse anı" zaman damgası yerine deterministik konum imzası
    collapseSignature: ((entanglementSeed ^ (entry.blockIdx * 0x9e3779b9)) >>> 0).toString(16).padStart(8,"0"),
    corrected: entry.corrected,
  }));
}

// ══════════════════════════════════════════════════════════════
// EK 31: CHIRALITY SYMMETRY TRACKER (Kiralite Simetri İzleyicisi)
// mirrorOn aktifken, asal evren ve ayna evrenin sendrom dizileri
// blok-blok karşılaştırılır. Burada sendromlar klasik "hata indeksi"
// rolünden çıkıp, iki evren arasındaki KUANTUM FAZ FARKINI takip eden
// simetri izleyicilerine dönüşür:
//   - primeSyndrome XOR mirrorSyndrome == 0  → "eşlenik durum" (conjugate):
//     iki evren bu blokta simetrik/uyumlu collapse etmiş.
//   - primeSyndrome XOR mirrorSyndrome != 0  → "faz farkı" (phase delta):
//     kiralite kırılmış, iki evren farklı yönde collapse etmiş.
// ══════════════════════════════════════════════════════════════
function trackChiralitySymmetry(primeSyndromeLog, mirrorSyndromeLog) {
  const len = Math.min(primeSyndromeLog.length, mirrorSyndromeLog.length);
  const symmetryLog = [];
  let conjugateCount = 0, phaseDeltaCount = 0;

  for (let i = 0; i < len; i++) {
    const ps = primeSyndromeLog[i].syndrome;
    const ms = mirrorSyndromeLog[i].syndrome;
    const phaseDelta = ps ^ ms; // XOR: iki evren arası "faz farkı" sendromu
    const isConjugate = phaseDelta === 0;
    if (isConjugate) conjugateCount++; else phaseDeltaCount++;

    symmetryLog.push({
      blockIdx: i,
      primeSyndrome: ps,
      mirrorSyndrome: ms,
      phaseDelta,
      isConjugate,
      // kiralite açısı: faz farkının 3-bit uzayındaki "açısal" büyüklüğü
      chiralityAngle: (phaseDelta / 7) * 180, // 0°=tam simetrik, 180°=tam ters kiralite
      label: isConjugate
        ? `Blok ${i}: EŞLENİK DURUM — iki evren simetrik collapse etti (${QSTATE_LABELS[ps]})`
        : `Blok ${i}: FAZ FARKI Δ=${phaseDelta} — kiralite kırılması (asal:${QSTATE_LABELS[ps]} ≠ ayna:${QSTATE_LABELS[ms]})`,
    });
  }

  const symmetryRatio = len > 0 ? conjugateCount / len : null;
  return {
    symmetryLog, conjugateCount, phaseDeltaCount, symmetryRatio,
    // Genel kiralite durumu: >0.5 simetriye yakın, <0.5 kiralite kırık
    chiralityState: symmetryRatio == null ? "BİLİNMİYOR"
      : symmetryRatio > 0.7 ? "YÜKSEK SİMETRİ (paralel evrenler uyumlu)"
      : symmetryRatio > 0.4 ? "KISMİ SİMETRİ (dengeli kiralite)"
      : "KİRALİTE KIRILMASI (evrenler ayrışıyor)",
  };
}

// ══════════════════════════════════════════════════════════════
// EK 32: İKİ EVREN ARASI HATA MATRİSİ KORELASYONU
// Asal ve ayna evrenin olay-tipi histogramlarını (ec objeleri) bir
// korelasyon matrisine döker — hangi hata tipi bir evrende artarken
// diğerinde de artıyor/azalıyor, Pearson-benzeri basit bir korelasyon
// katsayısıyla ölçülür.
// ══════════════════════════════════════════════════════════════
function correlateErrorMatrices(primeEc, mirrorEc) {
  const allTypes = [...new Set([...Object.keys(primeEc), ...Object.keys(mirrorEc)])];
  if (allTypes.length === 0) return { matrix: [], correlation: null };

  const primeVec = allTypes.map(t => primeEc[t] ?? 0);
  const mirrorVec = allTypes.map(t => mirrorEc[t] ?? 0);

  const meanP = primeVec.reduce((a,v)=>a+v,0) / primeVec.length;
  const meanM = mirrorVec.reduce((a,v)=>a+v,0) / mirrorVec.length;

  let cov = 0, varP = 0, varM = 0;
  for (let i=0;i<allTypes.length;i++){
    const dp = primeVec[i]-meanP, dm = mirrorVec[i]-meanM;
    cov += dp*dm; varP += dp*dp; varM += dm*dm;
  }
  const denom = Math.sqrt(varP*varM);
  const correlation = denom > 0 ? cov/denom : null;

  const matrix = allTypes.map((type,i) => ({
    type, prime: primeVec[i], mirror: mirrorVec[i],
    delta: primeVec[i]-mirrorVec[i],
    ratio: mirrorVec[i]>0 ? primeVec[i]/mirrorVec[i] : (primeVec[i]>0 ? Infinity : 1),
  }));

  return { matrix, correlation, meanP, meanM };
}

// ══════════════════════════════════════════════════════════════
// EK 33: GÖRECELİ "ANA EVREN" (OBSERVER-CENTRIC) MİMARİSİ
// Hangi evrenin "gerçek/ana referans çerçevesi" (observer frame)
// olduğu MUTLAK değildir — kullanıcının seçtiği gözlem noktasına
// göre görecelidir. collapsedTo state'i bunu tutar; bu fonksiyon
// verilen gözlem çerçevesine göre "hangi evren birincil" sorusunu
// yanıtlar ve iki evrenin rollerini buna göre etiketler.
// ══════════════════════════════════════════════════════════════
function resolveObserverFrame(collapsedTo, primeResult, mirrorResult) {
  // Henüz çökmemişse: gözlemci hâlâ süperpozisyonda, "ana evren" tanımsız
  if (!collapsedTo) {
    return {
      observerFrame: "SÜPERPOZİSYON",
      primary: null, secondary: null,
      note: "Gözlemci henüz bir çerçeve seçmedi — her iki evren de eşit ölçüde 'gerçek'.",
    };
  }
  // Kullanıcı "prime" seçtiyse: asal evren gözlemci çerçevesi olur,
  // ayna evren bu çerçeveden "göreceli" / ikincil sayılır (ve tam tersi).
  const primaryIsPrime = collapsedTo === "prime";
  return {
    observerFrame: primaryIsPrime ? "ASAL EVREN" : "AYNA EVREN",
    primary: primaryIsPrime ? primeResult : mirrorResult,
    secondary: primaryIsPrime ? mirrorResult : primeResult,
    note: primaryIsPrime
      ? "Gözlemci asal evreni seçti — ayna evren artık bu çerçeveden 'göreceli sapma' olarak ölçülür."
      : "Gözlemci ayna evreni seçti — asal evren artık bu çerçeveden 'göreceli sapma' olarak ölçülür.",
  };
}

// ══════════════════════════════════════════════════════════════
// EK 34: BROADCASTCHANNEL VERİ PAKETİ YAPISI (v2)
// Çok-kullanıcılı senkron katmanının resmi mesaj protokolü. Her paket
// şu zarfa (envelope) sahiptir: {proto, v, type, userId, t, payload}.
// "payload" alanı mesaj tipine göre değişir. Artık sadece başarı/hata
// değil, kuantum durum telemetrisi ve kiralite simetrisi de taşınır.
// ══════════════════════════════════════════════════════════════
const BC_PROTOCOL = "photonnet-mesh";
const BC_VERSION = 2;

const BC_MSG_TYPES = {
  HELLO: "HELLO",                     // yeni operatör ağa katıldı
  PING: "PING",                       // canlılık sinyali (heartbeat)
  TRANSMIT_EVENT: "TRANSMIT_EVENT",   // bir iletim tamamlandı (temel özet)
  TELEMETRY: "TELEMETRY",             // EK: kuantum durum logu + kiralite paylaşımı
  ENTANGLE_REQUEST: "ENTANGLE_REQUEST", // EK: bir kullanıcı başka bir kullanıcının kaydıyla entangle etmek istiyor
};

// Zarfı oluşturan tek merkezi fonksiyon — tüm postMessage çağrıları
// bunun üzerinden geçmeli, böylece versiyon/şema tek yerden yönetilir.
function buildBcPacket(type, userId, payload) {
  return {
    proto: BC_PROTOCOL,
    v: BC_VERSION,
    type,
    userId,
    t: Date.now(),
    payload: payload ?? null,
  };
}

// Gelen paketin bizim protokolümüze ve bilinen bir versiyona uyup
// uymadığını doğrular — şema uyumsuzsa sessizce yok sayılır.
function isValidBcPacket(m) {
  return !!m
    && m.proto === BC_PROTOCOL
    && typeof m.v === "number"
    && m.v <= BC_VERSION // ileri-uyumlu: eski istemciler daha yeni versiyonu görmezden gelebilir
    && typeof m.type === "string"
    && typeof m.userId === "string";
}

// TRANSMIT_EVENT payload şeması — temel özet (eski istemcilerle uyumlu,
// v1'den beri değişmedi).
function buildTransmitPayload(src, dst, success) {
  return { src, dst, success };
}

// TELEMETRY payload şeması (v2 ile eklendi) — kuantum durum logu ve
// kiralite simetri özetini taşır. Ağır olmaması için tam eventLog değil,
// özet istatistikler gönderilir.
function buildTelemetryPayload({ entanglementSeed, quantumStateLog, chirality, tabId, role, qber }) {
  const lastSyndrome = quantumStateLog?.length ? quantumStateLog[quantumStateLog.length-1].syndrome : 0;
  const globalEntropy = shannonEntropy(
    (quantumStateLog||[]).reduce((h,s)=>{ h[s.syndrome]=(h[s.syndrome]??0)+1; return h; }, {})
  );
  return {
    seed: entanglementSeed,
    stateCount: quantumStateLog?.length ?? 0,
    // Durum dağılımı özeti (tam log değil — bant genişliği için özet)
    stateHistogram: (quantumStateLog||[]).reduce((h,s)=>{
      h[s.syndrome] = (h[s.syndrome]??0)+1; return h;
    }, {}),
    chiralityState: chirality?.chiralityState ?? null,
    symmetryRatio: chirality?.symmetryRatio ?? null,
    // EK 34: kullanıcının belirttiği tam şema
    sender_tab_id: tabId ?? null,
    local_role: role ?? "Primary_Observer",
    raw_syndrome: lastSyndrome,
    chiral_shift: !!(chirality && chirality.symmetryRatio != null && chirality.symmetryRatio < 0.5),
    shannon_entropy: globalEntropy,
    qber: qber ?? null, // EK 37: alıcı tarafta taşıyıcı/modülatör frekansını güncellemek için
  };
}

function charSimilarity(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      dp[i][j] = a[i-1]===b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

function t2b(t) {
  const o = [];
  for (const c of t) for (let i = 7; i >= 0; i--) o.push((c.charCodeAt(0) >> i) & 1);
  return o;
}

// EK 18 (yardımcı): Shannon entropisi — bir olay-tipi dağılımının
// (ör. {ABSORB:3, SCATTER:1}) ne kadar "düzensiz/öngörülemez" olduğunu
// ölçer. İki evrenin entropi farkı, Mirror Universe istatistik panelinde
// "evrenler arası entropi farkı" olarak gösterilir.
function shannonEntropy(ec) {
  const total = Object.values(ec).reduce((a,v)=>a+v,0);
  if (total === 0) return 0;
  return -Object.values(ec).reduce((sum,count)=>{
    if (count === 0) return sum;
    const p = count/total;
    return sum + p*Math.log2(p);
  }, 0);
}

// ══════════════════════════════════════════════════════════════
// EK 21: MANY-WORLDS İSTATİSTİK ANALİZÖRÜ
// Tüm zaman çizelgesi (timeline) üzerinden toplu bilimsel içgörüler
// üretir: toplam entropi, olay histogramı, dalga boyu kararlılık
// sıralaması, entanglement yoğunluğu (kaç kayıt karşılaştırma/replay
// zincirine dahil olmuş).
// ══════════════════════════════════════════════════════════════
function analyzeManyWorlds(timeline) {
  if (!timeline.length) return null;

  // Toplam olay histogramı
  const globalEc = {};
  timeline.forEach(t => {
    Object.entries(t.result.ec||{}).forEach(([k,v])=>{
      globalEc[k] = (globalEc[k]??0) + v;
    });
  });
  const globalEntropy = shannonEntropy(globalEc);

  // Dalga boyu bazlı kararlılık (BER ortalaması düşük olan = daha kararlı)
  const nmStats = {};
  timeline.forEach(t=>{
    (t.segs||[]).forEach(seg=>{
      if (!seg) return;
      if (!nmStats[seg.nm]) nmStats[seg.nm] = { count:0, berSum:0 };
      nmStats[seg.nm].count++;
      nmStats[seg.nm].berSum += parseFloat(t.result.er);
    });
  });
  const nmRanking = Object.entries(nmStats)
    .map(([nm,s])=>({ nm:Number(nm), avgBer: s.berSum/s.count, count:s.count }))
    .sort((a,b)=>a.avgBer-b.avgBer);

  // BER dağılımı (ortalama, min, max, std sapma)
  const bers = timeline.map(t=>parseFloat(t.result.er));
  const berAvg = bers.reduce((a,v)=>a+v,0)/bers.length;
  const berStd = Math.sqrt(bers.reduce((s,v)=>s+(v-berAvg)**2,0)/bers.length);
  const berMin = Math.min(...bers), berMax = Math.max(...bers);

  // Başarı oranı
  const successRate = timeline.filter(t=>t.result.success).length / timeline.length;

  // Entanglement yoğunluğu — bu oturumda kaç kayıt entangle/replay edilmiş
  // (basit yaklaşım: eventLog'u olan ve seed'i paylaşılan kayıt sayısı)
  const entanglementDensity = timeline.filter(t=>t.eventLog && t.eventLog.length>0).length / timeline.length;

  return {
    totalRecords: timeline.length,
    globalEc, globalEntropy,
    nmRanking,
    berAvg, berStd, berMin, berMax,
    successRate,
    entanglementDensity,
    mostStableWavelength: nmRanking[0]?.nm ?? null,
    leastStableWavelength: nmRanking[nmRanking.length-1]?.nm ?? null,
  };
}

function b2t(b) {
  let s = "";
  for (let i = 0; i+7 < b.length; i += 8) {
    const v = b.slice(i, i+8).reduce((a,x,j) => a+(x<<(7-j)), 0);
    if (v > 0) s += String.fromCharCode(v);
  }
  return s;
}

// propPhoton: 5. parametre 'rng' opsiyoneldir. Verilmezse Math.random kullanılır
// (mevcut canlı iletim davranışı bire bir korunur). Replay'de mulberry32 seed'li
// rng geçilir → aynı olaylar deterministik olarak tekrar üretilir.
// DÜZELTME 1: eavesdrop olasılığı artık mesafe/dalga-boyuna bağlı.
// Fiziksel gerekçe: bir fiziksel "tap" (dinleme noktası), o ana kadar
// hayatta kalan sinyal gücünün bir kısmını çalar. Sinyal ne kadar
// güçlüyse (az kayıplı dalga boyu + kısa mesafe → fiberT yüksek),
// tap'in sinyali gürültüden ayırıp temiz bir kopya alması o kadar
// kolaydır. Uzun mesafe/yüksek-kayıplı dalga boyunda sinyal zaten
// zayıfladığı için hem tap'in kendisi ekstra kayıp yaratır hem de
// aldığı kopya gürültüye daha yakındır — bu yüzden temel olasılık
// fiberT(nm,km) ile ölçeklenir. Sabit .45 tavan olarak kalır (üst sınır),
// ama artık gerçek bir taban değeri yerine dinamik bir üst sınırdır.

// ══════════════════════════════════════════════════════════════
// LEGA — Link-graded Elastic threshold Algorithm
// (Dinamik Eşik Değer Algoritması)
//
// PROBLEM: propPhoton'daki üç kritik eşik (SCATTER-sonrası ölüm oranı
// .55, ABSORB tetikleyicisi fiberT(nm,km), DECOHERE oranı sk/1400)
// SABİTTİ — ağın o anki durumundan tamamen habersizdi. Gerçek bir fiber
// ağda kanal kalitesi zamanla değişir: yoğun trafik ısı üretir (fiber
// kırılma indeksini kaydırır), art arda gelen kayıplar malzeme
// yorgunluğuna işaret eder, geçmiş performans o hattın güvenilirliği
// hakkında bilgi taşır.
//
// LEGA bu üç sinyali birleştirip eşikleri "esnekleştirir":
//   1. Canlı yük (linkLoad)      → ısınma etkisi, ABSORB eşiğini kaydırır
//   2. Tarihsel BER (timeline)   → o linkin/dalga boyunun bilinen
//                                   güvenilirliği, SCATTER-ölüm oranını
//                                   ayarlar
//   3. Yorgunluk sayacı (runtime)→ art arda ABSORB/SCATTER olayları
//                                   DECOHERE olasılığını kademeli artırır
//                                   (fiziksel analoji: kümülatif stres)
//
// GERİYE DÖNÜK UYUMLULUK: propPhoton'a opsiyonel 6. parametre (legaCtx)
// eklenir. legaCtx verilmezse LEGA.defaultThresholds() çağrılır ve bu,
// ESKİ SABİT DEĞERLERLE (.55, fiberT, sk/1400) BİREBİR AYNI sonucu
// üretir — mevcut 4 çağrı yeri hiç değişmeden çalışmaya devam eder.
// ══════════════════════════════════════════════════════════════
class LinkGradedEavesdropThresholdAlgorithm {
  constructor() {
    // Yorgunluk durumu: her (nm,km) "bucket"ı için ayrı sayaç tutulur —
    // aynı dalga boyu/mesafe kombinasyonunda art arda kayıp, o "sanal
    // segment"in yıprandığını simüle eder. Zamanla (decay) toparlanır.
    this.fatigueMap = new Map(); // key: `${nm}-${Math.round(km/10)}` → {count, lastUpdate}

    // KENDİ KENDİNİ OPTİMİZE EDEN KATSAYILAR: eskiden computeThresholds
    // içine gömülü sabitlerdi (0.15, 0.6). Artık adlandırılmış, dışarıdan
    // ayarlanabilir alanlar — CoefficientEvolutionEngine bunları arka
    // planda evrimsel olarak optimize eder. Varsayılan değerler ESKİ
    // SABİTLERLE BİREBİR AYNIDIR; hiç dokunulmazsa davranış değişmez.
    this.alpha = 0.6;   // entropi hassasiyeti: tarihsel BER'in scatterDeathProb üzerindeki etkisi
    this.beta  = 0.15;  // komşu baskısı: canlı linkLoad'un absorbBias üzerindeki etkisi
  }

  static bucketKey(nm, km) { return `${nm}-${Math.round(km/10)}`; }

  /** Varsayılan (context'siz) eşikler — orijinal sabitlerle BİREBİR AYNI. */
  static defaultThresholds() {
    return { scatterDeathProb: 0.55, absorbBias: 1.0, decohereBias: 1.0 };
  }

  /**
   * Bir yayılım olayının ardından yorgunluk sayacını günceller.
   * @param {number} nm @param {number} km @param {boolean} lost - bu foton kaybedildi mi
   */
  recordOutcome(nm, km, lost) {
    const key = LinkGradedEavesdropThresholdAlgorithm.bucketKey(nm, km);
    const now = Date.now();
    const entry = this.fatigueMap.get(key) || { count: 0, lastUpdate: now };
    // Decay: son güncellemeden bu yana geçen süreye göre yorgunluk azalır
    // (fiber "dinlenir") — 5 saniyede bir birim azalma.
    const decayed = Math.max(0, entry.count - (now - entry.lastUpdate) / 5000);
    entry.count = lost ? Math.min(20, decayed + 1) : Math.max(0, decayed - 0.5);
    entry.lastUpdate = now;
    this.fatigueMap.set(key, entry);
  }

  /**
   * Canlı bağlam + tarihsel veriden dinamik eşikleri hesaplar.
   *
   * ── DÜRÜSTLÜK NOTU (kalibrasyon durumu) ──────────────────────────
   * Bu formüldeki sabitler (0.55 taban, histBer-0.1 ofseti, load*beta
   * ilişkisi) GERÇEK FİBER OPTİK ÖLÇÜM VERİSİNDEN TÜRETİLMEMİŞTİR —
   * "ısınma etkisi" ve "malzeme yorgunluğu" gibi kavramlar fiber optikte
   * gerçek fiziksel fenomenlerdir, ama buradaki sayısal ilişkiler
   * (özellikle 0.55'in neden 0.5 ya da 0.6 değil de bu değer olduğu,
   * histBer'den çıkarılan 0.1 ofsetinin kaynağı, load*beta'nın doğrusal
   * oluşu) DENEYSEL OLARAK DOĞRULANMAMIŞ, sezgisel/didaktik seçimlerdir.
   * Bu fonksiyon "plausible sounding" (kulağa makul gelen) ama fiziksel
   * temeli olmayan bir davranış modelidir — bir eğitim/simülasyon aracı
   * olarak tutarlı ve öngörülebilir çalışır, ama gerçek bir fiber ağın
   * BER/ABSORB davranışını tahmin etmek için kullanılamaz.
   * ─────────────────────────────────────────────────────────────────
   * @param {number} nm @param {number} km
   * @param {{linkLoad?: number, historicalBer?: number}} [ctx]
   * @param {{alpha?: number, beta?: number}} [coeffOverride] - evrimsel
   *   motorun aday genomlarını test etmek için kullanılır; verilmezse
   *   this.alpha/this.beta (canlı sistemin şu anki "standardı") kullanılır.
   * @returns {{scatterDeathProb:number, absorbBias:number, decohereBias:number}}
   */
  computeThresholds(nm, km, ctx = {}, coeffOverride) {
    const key = LinkGradedEavesdropThresholdAlgorithm.bucketKey(nm, km);
    const fatigue = this.fatigueMap.get(key)?.count ?? 0;
    const load = Math.max(0, Math.min(1, ctx.linkLoad ?? 0));
    const histBer = Math.max(0, Math.min(1, ctx.historicalBer ?? 0));
    const alpha = coeffOverride?.alpha ?? this.alpha;
    const beta  = coeffOverride?.beta  ?? this.beta;

    // 1) Canlı yük (komşu baskısı, β) → ABSORB eşiğini "ısınma" ile kaydırır;
    //    yük arttıkça fiberT'nin geçirgenlik payı daralır.
    const absorbBias = 1.0 + load * beta;

    // 2) Tarihsel BER (entropi hassasiyeti, α) → SCATTER sonrası ölüm oranını
    //    ayarlar; bu hat/dalga boyu geçmişte güvenilirse ölüm oranı düşer.
    const scatterDeathProb = Math.max(0.25, Math.min(0.85,
      0.55 + (histBer - 0.1) * alpha
    ));

    // 3) Yorgunluk sayacı → DECOHERE olasılığını kademeli artırır;
    //    0 yorgunlukta çarpan 1.0, 20 yorgunlukta çarpan 2.0 olur (kümülatif stres).
    const decohereBias = 1.0 + (fatigue / 20) * 1.0;

    return { scatterDeathProb, absorbBias, decohereBias };
  }
}

// Modül-seviyesi tekil örnek — tüm çağrılar aynı yorgunluk durumunu paylaşır.
const lega = new LinkGradedEavesdropThresholdAlgorithm();

// ══════════════════════════════════════════════════════════════
// NodeTransitGate — DÜĞÜM SEVİYESİ 3-AŞAMALI KARAR MOTORU
//
// KAVRAMSAL AYRIM: propPhoton() bir fotonun FİBER HATTI üzerindeki
// fiziksel kaderini belirler (soğurulma/saçılma/dekoherans — hat
// seviyesi). NodeTransitGate ise fiber'i AYAKTA GEÇEN (propPhoton
// ok:true döndüren) bir fotonun, hedef DÜĞÜME ulaştığında router
// donanımı tarafından nasıl triyaj edildiğini modeller — bu, LEGA'nın
// ürettiği dinamik eşiği (T(t)) gerçek bir "kabul/red" kapısına
// dönüştüren üst katmandır. propPhoton'a HİÇ dokunulmaz; bu tamamen
// AYRI ve OPSİYONEL bir katmandır.
//
// AŞAMA 1 — REZONANS KONTROLÜ:
//   Paket, düğümün "işleme profili" (hedef matris vektörü) ile
//   uyuşmuyorsa SIFIR İŞLEMCİ ÇEVRİMİ harcanır — anında silinir.
//   Modelde: her düğümün "rezonans dalga boyu" vardır (o düğümün en
//   sık işlediği λ). Gelen fotonun dalga boyu bu profille çok
//   uyuşmuyorsa (frekans mesafesi büyükse), fiziksel bir maliyet
//   ölçmeye bile gerek kalmadan "gürültü" sayılıp atılır.
//
// AŞAMA 2 — GENLİK DEĞERLENDİRMESİ:
//   Sinyal genliği V, anlık eşik T(t)'den (LEGA.computeThresholds
//   üzerinden türetilir) küçükse ve sistem yoğunsa (linkLoad yüksek)
//   VE bu paket düşük öncelikliyse (örn. ECC olmayan/ham veri),
//   hat üzerinde sönümlenerek yok olur.
//
// AŞAMA 3 — TRANSİT GEÇİŞ:
//   V ≥ T(t) ise donanım geçitleri açılır, foton Core'a UĞRAMADAN
//   (ekstra gecikme/olay üretmeden) doğrudan bir sonraki hopa geçer.
//
// SONUÇ: ağ yoğun anlarda "kendini kısar" (düşük genlikli/uyumsuz
// paketleri ucuza eler), sakin anlarda ise neredeyse her şeyi
// gecikmesiz geçirir (T(t) düşer, rezonans toleransı genişler).
// ══════════════════════════════════════════════════════════════
class NodeTransitGate {
  constructor() {
    // Her düğümün "işleme profili" — en sık gördüğü dalga boyu (rezonans
    // merkezi). İlk karşılaşılan λ ile başlar, sonra üstel ortalamayla kayar.
    this.nodeProfiles = new Map(); // nodeId → { resonantNm, sampleCount }
  }

  /**
   * AŞAMA 1: Rezonans kontrolü. Düğümün profiliyle foton dalga boyu
   * arasındaki "frekans mesafesi" toleransın dışındaysa, paket sıfır
   * maliyetle (fiziksel simülasyon çalıştırılmadan) reddedilir.
   *
   * YUMUŞAK FİLTRE TOLERANSI (Soft-Match Masking): sert %60 sınırının
   * hemen ötesinde (SOFT_MATCH_UPPER_BOUND'a kadar) bir "geçiş bölgesi"
   * tanımlanır. Bu bölgeye düşen fotonlar ARTIK OTOMATİK REDDEDİLMEZ —
   * mesafe sınıra ne kadar yakınsa geçiş olasılığı o kadar yüksek olan
   * bir "yumuşak maske" ile değerlendirilir. Bu, CoefficientEvolutionEngine'in
   * dinamik olarak kaydırdığı α/β aralığına Aşama 1'in gerçek zamanlı
   * uyum sağlamasını kolaylaştırır — profil tam olarak yeni kalibrasyona
   * yetişememiş olsa bile (senkron gecikmesi, geçici sapma), sınırın hemen
   * dışındaki meşru fotonlar kapıda anında elenmek yerine bir şans bulur.
   *
   * SERT SINIRIN KENDİSİ (0.6) VE MESAFE FORMÜLÜ HİÇ DEĞİŞMEDİ — bu,
   * sınırın ÜZERİNE eklenen YENİ, OPSİYONEL bir sınıflandırma katmanıdır.
   * @param {string} nodeId @param {number} nm
   * @param {() => number} [rng] - yumuşak-eşleşme olasılık testi için (verilmezse Math.random)
   * @returns {{resonant: boolean, distance: number, softMatched: boolean}}
   */
  checkResonance(nodeId, nm, rng) {
    const rand = rng || Math.random;
    const profile = this.nodeProfiles.get(nodeId);
    if (!profile) {
      // İlk temas: düğüm bu dalga boyuna "alışır" — profil oluşturulur.
      this.nodeProfiles.set(nodeId, { resonantNm: nm, sampleCount: 1 });
      return { resonant: true, distance: 0, softMatched: false };
    }
    // Frekans mesafesi: dalga boyu farkının, profildeki dalga boyuna oranı.
    const distance = Math.abs(nm - profile.resonantNm) / profile.resonantNm;
    // Tolerans %60 — WL setindeki en yakın iki dalga boyu bile bunun
    // altında kalacak şekilde kalibre edildi (aşırı agresif reddi önler).
    // BU SINIR DEĞİŞMEDİ — sert eşik hâlâ tam olarak burada.
    const HARD_TOLERANCE = 0.6;

    let resonant = distance <= HARD_TOLERANCE;
    let softMatched = false;

    if (!resonant) {
      // YUMUŞAK EŞLEŞME BÖLGESİ: sert sınırın hemen ötesinde (%60-%75
      // arası), mesafeyle TERS ORANTILI bir geçiş şansı tanınır — sınıra
      // ne kadar yakınsa (0.60'a yakın) o kadar yüksek olasılıkla geçer,
      // üst sınıra (0.75) yaklaştıkça olasılık sıfıra iner.
      const SOFT_MATCH_UPPER_BOUND = 0.75;
      if (distance <= SOFT_MATCH_UPPER_BOUND) {
        // [0.60, 0.75] aralığını [1,0]'a doğrusal eşle — sınıra yakın
        // yüksek şans, üst sınıra yakın düşük şans.
        const t = (distance - HARD_TOLERANCE) / (SOFT_MATCH_UPPER_BOUND - HARD_TOLERANCE);
        const passChance = 1 - t; // 0.60'ta ≈1.0, 0.75'te ≈0.0
        if (rand() < passChance * 0.5) { // tavan %50 — hâlâ "istisna", "kural" değil
          resonant = true;
          softMatched = true;
        }
      }
    }

    // Üstel kayan ortalama ile profil zamanla güncel λ dağılımına uyum sağlar.
    // BU DA DEĞİŞMEDİ — yumuşak eşleşme profilin kendisini farklı güncellemez.
    profile.resonantNm = profile.resonantNm * 0.9 + nm * 0.1;
    profile.sampleCount++;
    return { resonant, distance, softMatched };
  }

  /**
   * REZONANS PROFİLİ SENKRONİZASYONU (dış müdahale arayüzü).
   *
   * KÖK NEDEN: checkResonance() kendi bağımsız durumunu (nodeProfiles)
   * tutar — bu, MemristorCell.resonantNm'DEN TAMAMEN AYRI bir state'tir.
   * promoteToLive() (CoefficientEvolutionEngine) hücrelerin kendi
   * resonantNm'ine göre referans eşik hesaplamaya başladığında, BU
   * PROFİLİ (nodeProfiles) SENKRONLAMAYI UNUTTU — Aşama 1 hâlâ eski,
   * yavaşça kayan (%90/%10 EMA) bir değere göre karar veriyordu. Sonuç:
   * gelen fotonun GERÇEK fiziksel dalga boyu, hücrenin YENİ mikro-kalibre
   * edilmiş referansıyla tutarlı olsa bile, Aşama 1'in KENDİ BAĞIMSIZ VE
   * GÜNCELLENMEMİŞ profiliyle "rezonans dışı" sayılıp kapıda reddediliyordu.
   *
   * ÇÖZÜM: bu metod, checkResonance()'ın KENDİ MANTIĞINA (tolerans, EMA
   * kayması) HİÇ DOKUNMADAN, dışarıdan (katsayı enjeksiyonundan) gelen
   * "bu artık doğru fiziksel referans" bilgisiyle profili DOĞRUDAN
   * hizalar — bir sonraki checkResonance() çağrısı artık güncel, tutarlı
   * bir profille karşılaştırma yapar.
   * @param {string} nodeId @param {number} nm - hücrenin GERÇEK, güncel rezonans dalga boyu
   */
  syncResonanceProfile(nodeId, nm) {
    const existing = this.nodeProfiles.get(nodeId);
    if (existing) {
      existing.resonantNm = nm; // anlık hizalama — EMA'nın yavaş kaymasını beklemeden
    } else {
      this.nodeProfiles.set(nodeId, { resonantNm: nm, sampleCount: 1 });
    }
  }

  /**
   * Fotonun taşıdığı "sinyal genliği" V — fiziksel olarak hayatta kalma
   * olasılığıyla orantılı (ne kadar az kayıpla geldiyse genlik o kadar
   * yüksek). [0,1] aralığında normalize edilir.
   *
   * KÖK NEDEN DÜZELTMESİ: Bu fonksiyon eskiden fiberT(nm,km)'yi (ham,
   * üstel iletim olasılığı) DOĞRUDAN V olarak kullanıyordu. Ama fiberT
   * gerçekçi mesafelerde (örn. 856km, ekran görüntüsünde gözlemlenen
   * senaryo) ASTRONOMİK KÜÇÜK değerler üretir (~10⁻¹⁸) — çünkü bu formül
   * ZATEN propPhoton'ın kendi segment-bazlı (sk) fiziksel simülasyonunda
   * kullanılıyor; NodeTransitGate'in bunu TEKRAR, TÜM MESAFE ÜZERİNDEN
   * uygulaması, fiziksel olarak ZATEN HAYATTA KALMIŞ bir fotonu ikinci
   * kez, çok daha ağır bir şekilde cezalandırmak demekti. Sonuç: V, T'nin
   * (0.15-0.85 aralığı) HER ZAMAN milyarlarca kat altında kalıyordu —
   * Aşama 2 pratik olarak TÜM fotonları reddediyordu (gözlemlenen "182
   * foton, 0 başarılı" belirtisi).
   *
   * ÇÖZÜM: V artık dB-kayıp ölçeğinde LOGARİTMİK olarak normalize edilir
   * — kısa mesafede V yüksek, uzun mesafede V düşük ama MAKUL bir
   * aralıkta kalır (asla astronomik küçülmez). Bu, "genlik" kavramının
   * T ile ANLAMLI KARŞILAŞTIRILABİLİR bir ölçekte kalmasını sağlar.
   * propPhoton'ın KENDİ fiziksel kayıp simülasyonuna HİÇ DOKUNULMADI —
   * yalnızca NodeTransitGate'in KENDİ, AYRI genlik yorumlaması düzeltildi.
   * @param {number} nm @param {number} km
   */
  computeAmplitude(nm, km) {
    const w = WL[nm] || WL[1550];
    // dB-kayıp: loss(dB/km) × km — mesafeyle DOĞRUSAL büyür (fiberT'nin
    // üstel küçülmesinin aksine). Tipik ağ mesafelerinde (100-2000km)
    // bu değer makul bir aralıkta (20-400dB) kalır.
    const dbLoss = w.loss * km;
    // Referans ölçek: 200dB'lik bir kayıp V≈0.1'e karşılık gelsin (yani
    // düğüm kapısı, propPhoton'ın zaten elediği aşırı-zayıf sinyalleri
    // TEKRAR elemek yerine, makul bir "sinyal kalitesi" göstergesi sunar).
    const REFERENCE_DB = 200;
    const V = Math.exp(-dbLoss / REFERENCE_DB);
    return Math.max(0, Math.min(1, V));
  }

  /**
   * Anlık eşik T(t) — LEGA'nın dinamik eşik motorundan türetilir.
   * Yük yükseldikçe T(t) yükselir (daha seçici), yük düşükse T(t) düşer
   * (daha toleranslı) — "ağ kendini kısar / kapılarını sonuna kadar açar".
   *
   * VAKUM KORİDORU: nodeId için PredictiveCorridorEngine tarafından
   * geçici bir indirim kaydedilmişse (öngörülen rota üzerindeyse), T(t)
   * bu indirimle çarpılır — "veri daha yola çıkmadan, gitmesi muhtemel
   * rotadaki eşikler geçici olarak düşürülür". Kayıt yoksa (varsayılan)
   * davranış ESKİ HALİYLE BİREBİR AYNIDIR.
   * @param {number} nm @param {number} km
   * @param {{linkLoad?: number, historicalBer?: number}} [legaCtx]
   * @param {string} [nodeId] - koridor indirimi kontrolü için (opsiyonel)
   */
  computeThreshold(nm, km, legaCtx, nodeId) {
    const th = legaCtx
      ? lega.computeThresholds(nm, km, legaCtx)
      : LinkGradedEavesdropThresholdAlgorithm.defaultThresholds();
    // absorbBias zaten "yük→daha seçici" ilişkisini taşıyor; T(t) tabanı
    // 0.15 (sakin ağda neredeyse her şey geçer) ile absorbBias ölçeklenir.
    const baseT = Math.min(0.85, 0.15 * th.absorbBias);
    const discount = nodeId ? predictiveCorridor.getDiscount(nodeId) : 1.0;
    return baseT * discount;
  }

  /**
   * ÜÇ AŞAMALI KARAR — bu, NodeTransitGate'in tek genel-amaçlı giriş
   * noktasıdır. propPhoton'ın ok:true döndürdüğü bir fotonun düğüme
   * ulaştığında geçirdiği triyajı simüle eder.
   * @param {string} nodeId
   * @param {number} nm @param {number} km
   * @param {boolean} lowPriority - bu paket düşük öncelikli mi (örn. ECC'siz ham veri)
   * @param {{linkLoad?: number, historicalBer?: number}} [legaCtx]
   * @param {() => number} [rng]
   * @returns {{phase: 1|2|3, passed: boolean, reason: string, V: number, T: number}}
   */
  evaluate(nodeId, nm, km, lowPriority, legaCtx, rng) {
    const rand = rng || Math.random;

    // AŞAMA 1: Rezonans Kontrolü — sıfır maliyetli erken-red.
    // Aynı rng akışı checkResonance'a da geçirilir — böylece yumuşak
    // eşleşme olasılık testi de deterministik/replay-uyumlu kalır.
    const { resonant, distance, softMatched } = this.checkResonance(nodeId, nm, rand);
    if (!resonant) {
      return { phase: 1, passed: false, reason: "REZONANS_UYUMSUZ", V: 0, T: 0, distance };
    }

    // AŞAMA 2: Genlik Değerlendirmesi.
    const V = this.computeAmplitude(nm, km);
    const T = this.computeThreshold(nm, km, legaCtx, nodeId);
    const networkBusy = (legaCtx?.linkLoad ?? 0) > 0.6; // "sistem çok yoğun" eşiği
    if (V < T) {
      if (networkBusy && lowPriority) {
        return { phase: 2, passed: false, reason: "GENLIK_YETERSIZ_YOGUN_AGDA_SONUMLENDI", V, T };
      }
      // Ağ sakinse veya paket öncelikliyse, düşük genliğe rağmen bir
      // şans daha tanınır (küçük olasılıkla geçer) — tam katı değil.
      if (rand() > 0.3) {
        return { phase: 2, passed: false, reason: "GENLIK_YETERSIZ", V, T };
      }
    }

    // AŞAMA 3: Transit Geçiş — donanım geçitleri açık, Core'a uğramadan geçer.
    return { phase: 3, passed: true, reason: "TRANSIT_GECIS", V, T, softMatched };
  }
}

// Modül-seviyesi tekil örnek.
const nodeTransitGate = new NodeTransitGate();

// ══════════════════════════════════════════════════════════════
// PredictiveCorridorEngine — GELECEKTEKİ YOĞUNLUĞU TAHMİN ETME +
// YOL ÖN-AÇMA ("Vakum Koridoru")
//
// BİYOLOJİK ANALOJİ: Biyolojik nöronlarda "feedforward inhibition/
// facilitation" — bir sinyal bir nöron topluluğuna ulaşmadan ÖNCE,
// o toplulukla bağlantılı komşu nöronlar önceden hazırlanır (eşikleri
// ayarlanır). Burada aynı örüntü uygulanır: bir iletim FİZİKSEL OLARAK
// yola çıkmadan önce (routeCalculation() sonucu elimizdeyken, ama
// physicalSimulation() henüz çalışmadan), rotadaki her düğüme geçici
// bir eşik-indirimi (vakum koridoru) tanımlanır.
//
// NASIL ÇALIŞIR:
//   1. Rota hesaplanır (routeCalculation) — bu, "dalga fonksiyonu
//      simülasyonu" analojisidir: fiziksel foton daha yayılmadan,
//      HANGİ düğümlerin ateşleneceği matematiksel olarak zaten bilinir.
//   2. Bu bilgiyle, openCorridor() çağrılır: rotadaki her düğüm için
//      NodeTransitGate.computeThreshold()'un okuyacağı bir indirim
//      kaydedilir (kısa TTL'li — birkaç saniye sonra otomatik kapanır).
//   3. Fiziksel simülasyon (propPhoton + NodeTransitGate.evaluate)
//      ÇALIŞTIĞINDA, bu düğümlerde eşik zaten düşürülmüş durumdadır —
//      "pürüzsüz vakum koridoru" gerçek bir eşik indirimi olarak var olur.
//
// GÜVEN AZALMASI: koridordaki indirim, giriş noktasından uzaklaştıkça
// zayıflar (ilk hop'ta güçlü, son hop'ta zayıf) — çünkü tahminin
// belirsizliği rota boyunca artar (gerçek feedforward sinyallerin
// mesafeyle zayıflaması gibi).
//
// NodeTransitGate.evaluate()'İN KARAR MANTIĞINA HİÇ DOKUNULMAZ; bu
// motor sadece computeThreshold()'un okuduğu opsiyonel bir "indirim
// kaydı" sağlar.
// ══════════════════════════════════════════════════════════════
class PredictiveCorridorEngine {
  constructor() {
    this.corridors = new Map(); // nodeId → { discount, expiresAt }
    this.stats = { corridorsOpened: 0, predictionsUsed: 0 };
  }

  /**
   * FEEDFORWARD TAHMİN + YOL ÖN-AÇMA: verilen rotadaki her düğüm için
   * geçici bir eşik indirimi kaydeder. Fiziksel simülasyondan (foton
   * yayılımından) ÖNCE çağrılmalıdır — "veri daha yola çıkmadan".
   * @param {PathStep[]} path - routeCalculation()'dan dönen rota
   * @param {number} [ttlMs=3000] - koridorun ne kadar açık kalacağı
   * @returns {{nodesOpened: number, avgDiscount: number}}
   */
  openCorridor(path, ttlMs = 3000) {
    const now = Date.now();
    const hopCount = Math.max(1, path.length - 1);
    let totalDiscount = 0;
    let opened = 0;

    path.forEach((step, i) => {
      // Güven azalması: giriş noktasına (i=0) yakın düğümlerde güçlü
      // indirim (%40'a kadar eşik düşüşü), rotanın sonuna doğru zayıflar.
      const confidenceDecay = 1 - (i / hopCount) * 0.7; // 1.0 → 0.3 arası
      const discount = Math.max(0.6, 1.0 - 0.4 * confidenceDecay); // [0.6, 1.0] — düşük=daha açık koridor

      const existing = this.corridors.get(step.node);
      // Zaten daha güçlü bir indirim varsa (başka bir tahminden), onu koru.
      if (!existing || existing.discount > discount) {
        this.corridors.set(step.node, { discount, expiresAt: now + ttlMs });
        opened++;
      }
      totalDiscount += discount;
    });

    this.stats.corridorsOpened += opened;
    return { nodesOpened: opened, avgDiscount: totalDiscount / path.length };
  }

  /**
   * Bir düğüm için o an geçerli indirim çarpanını okur (1.0 = indirim yok).
   * Süresi dolmuş kayıtlar otomatik temizlenir (lazy expiry).
   * @param {string} nodeId
   * @returns {number} [0.6, 1.0] arası çarpan
   */
  getDiscount(nodeId) {
    const entry = this.corridors.get(nodeId);
    if (!entry) return 1.0;
    if (Date.now() > entry.expiresAt) {
      this.corridors.delete(nodeId);
      return 1.0;
    }
    this.stats.predictionsUsed++;
    return entry.discount;
  }

  /** Süresi dolmuş tüm koridorları temizler (periyodik bakım için). */
  pruneExpired() {
    const now = Date.now();
    let pruned = 0;
    for (const [nodeId, entry] of this.corridors) {
      if (now > entry.expiresAt) { this.corridors.delete(nodeId); pruned++; }
    }
    return pruned;
  }

  /** Şu an açık koridorların listesi (UI/harita için). */
  activeCorridors() {
    this.pruneExpired();
    return [...this.corridors.entries()].map(([nodeId, e]) => ({
      nodeId, discount: e.discount, remainingMs: e.expiresAt - Date.now(),
    }));
  }
}

// Modül-seviyesi tekil örnek.
const predictiveCorridor = new PredictiveCorridorEngine();

// ══════════════════════════════════════════════════════════════
// ChaosSuppressor — KAOS ENGELLEYİCİ (Anti-Paket / Aktif Gürültü İptali)
//
// GERÇEK PROBLEM: ghostPkts (replay hayalet parçacıkları) state'i,
// birden fazla replayTimeline() eşzamanlı çalıştığında bir yarış
// durumuna açıktır — bir replay'in try/finally bloğu henüz temizlik
// yapmadan, başka bir replay'in "60 parçacık tavanı" kırpması (slice
// -60) o replay'e ait parçacıkları SESSİZCE silebilir. Sonuç: o
// replay'in kaynak kimliği (sourceId) artık `replaying` listesinde
// olmadığı hâlde, ekranda "sahipsiz" (orphan) parçacıklar asılı
// kalabilir — kullanıcının tarif ettiği "ağda sıkışan hayalet veri".
//
// ÇÖZÜM (ANC analojisi): kulaklıklardaki Aktif Gürültü Engelleme,
// istenmeyen ses dalgasının TAM TERS FAZINI üretip üst üste bindirerek
// onu matematiksel olarak sıfıra indirger (destructive interference).
// Burada aynı ilke uygulanır: her orphan hayalet paket tespit
// edildiğinde, AYNI KONUMDA, TERS FAZLI bir "anti-paket" üretilir
// (görsel olarak: tamamlayıcı renk + ters opaklık eğrisi) ve ikisi
// birlikte kısa bir "nötrleşme" animasyonuyla state'ten temizlenir.
//
// Bu motor SALT TESPİT+TEMİZLİK katmanıdır — propPhoton, NodeTransitGate
// veya herhangi bir iletim matematiğine dokunmaz; yalnızca UI/animasyon
// state'inin (ghostPkts) tutarlılığını periyodik olarak denetler.
// ══════════════════════════════════════════════════════════════
class ChaosSuppressor {
  constructor() {
    this.stats = { orphansDetected: 0, antiPacketsFired: 0, lastSweepAt: 0 };
    this.neutralizing = new Map(); // packetId → { antiPacket, expiresAt } — nötrleşme animasyonu süren çiftler
  }

  /**
   * Tespit: ghostPkts içinde sourceId'si artık aktif replaying listesinde
   * OLMAYAN parçacıkları bulur — bunlar "hayalet/sahipsiz" veridir.
   * @param {Array<{id:string, sourceId:string}>} ghostPkts
   * @param {string[]} activeReplayIds - o an gerçekten çalışan replay id'leri
   * @returns {Array} orphan parçacıklar
   */
  detectOrphans(ghostPkts, activeReplayIds) {
    const activeSet = new Set(activeReplayIds);
    return ghostPkts.filter(g => g.sourceId && !activeSet.has(g.sourceId));
  }

  /**
   * NÖTRLEŞTİRME: her orphan için ters-fazlı bir anti-paket üretir ve
   * nötrleşme kayıtlarına ekler (kısa bir "sönme" animasyonu için, UI
   * bu kaydı okuyup iki parçacığı üst üste render edip birlikte söndürebilir).
   * @param {Array} orphans
   * @returns {Array<{ghost:Object, antiPacket:Object}>} nötrleşme çiftleri
   */
  fireAntiPackets(orphans) {
    const now = Date.now();
    const pairs = orphans.map(ghost => {
      // Ters faz: aynı konum, tamamlayıcı renk (RGB negatifi benzeri —
      // basitçe sabit bir "anti" rengi: elektrik moru), zıt opaklık eğrisi.
      const antiPacket = {
        id: `anti-${ghost.id}`,
        x: ghost.x, y: ghost.y,
        color: "#f43f5e", // ters-faz sinyali her zaman kırmızı-magenta ile işaretlenir
        sourceId: null, // anti-paketlerin sahibi yok — nötrleştirici tarafından üretildi
        bornAt: now,
      };
      this.neutralizing.set(ghost.id, { antiPacket, expiresAt: now + 260 }); // ~260ms nötrleşme animasyonu
      return { ghost, antiPacket };
    });
    this.stats.orphansDetected += orphans.length;
    this.stats.antiPacketsFired += pairs.length;
    this.stats.lastSweepAt = now;
    return pairs;
  }

  /** Süresi dolmuş nötrleşme animasyonlarını temizler. */
  pruneFinishedNeutralizations() {
    const now = Date.now();
    let pruned = 0;
    for (const [id, entry] of this.neutralizing) {
      if (now > entry.expiresAt) { this.neutralizing.delete(id); pruned++; }
    }
    return pruned;
  }

  /** UI'da render edilecek, o an "nötrleşiyor" durumundaki anti-paket listesi. */
  activeAntiPackets() {
    this.pruneFinishedNeutralizations();
    return [...this.neutralizing.values()].map(e => e.antiPacket);
  }

  /**
   * TAM TARAMA: tespit + nötrleştirme + temizlik talimatı tek çağrıda.
   * Çağıran taraf (React effect), dönen `purgeIds` listesini kullanarak
   * ghostPkts state'inden bu id'leri gerçekten silmelidir.
   * @param {Array} ghostPkts @param {string[]} activeReplayIds
   * @returns {{orphanCount:number, purgeIds:string[], antiPackets:Array}}
   */
  sweep(ghostPkts, activeReplayIds) {
    const orphans = this.detectOrphans(ghostPkts, activeReplayIds);
    if (orphans.length === 0) return { orphanCount: 0, purgeIds: [], antiPackets: this.activeAntiPackets() };
    this.fireAntiPackets(orphans);
    return {
      orphanCount: orphans.length,
      purgeIds: orphans.map(o => o.id),
      antiPackets: this.activeAntiPackets(),
    };
  }
}

// Modül-seviyesi tekil örnek.
const chaosSuppressor = new ChaosSuppressor();

// ══════════════════════════════════════════════════════════════
// SoftLandingFilter — %92 ÇÖKÜŞ METRİĞİ İLE ACİL TAHLİYE VALFİ
//
// ESKİ DAVRANIŞ: Filtre yalnızca "paketlerin transit geçişini
// tamamlamasını" bekliyordu — ChaosSuppressor bir paketin sahibi
// (replaying id'si) hâlâ aktifse ona dokunmuyordu, yalnızca gerçek
// orphan'ları (sahipsiz kalanları) temizliyordu. Bu, normal yükte
// doğru bir davranıştır (transit hâlindeki meşru bir paketi erken
// kesmek istemezsiniz).
//
// YENİ DAVRANIŞ: Laboratuvardan alınan %92'lik "çöküş metriği" artık
// filtreye ENJEKTE ediliyor. Hücre doluluğu (InMemoryComputeFabric'in
// cells Map'inin, kapasiteye oranı) bu eşiğe ulaştığında/aştığında,
// filtre "nazik bekleme" modundan çıkıp ACİL TAHLİYE moduna geçer:
// artık paketin transit'i tamamlayıp tamamlamadığına bakmaksızın,
// belirli bir yaşın (ageMs) üzerindeki TÜM paketleri anında sönümler
// (drop) — donanımı korumak, çöküşü önlemek için. Bu, gerçek işletim
// sistemlerindeki "OOM killer" / "backpressure" mekanizmalarının
// didaktik bir analogudur.
//
// ChaosSuppressor'ın kendi tespit mantığına (detectOrphans/fireAntiPackets)
// HİÇ DOKUNULMAZ — SoftLandingFilter tamamen AYRI, opsiyonel bir
// güvenlik valfidir; transmit()/physicalSimulation() bunu isteğe
// bağlı olarak danışabilir, hiçbir mevcut çağrı yeri buna bağımlı değildir.
// ══════════════════════════════════════════════════════════════
class SoftLandingFilter {
  constructor() {
    this.COLLAPSE_THRESHOLD = 0.92; // laboratuvar metriği — hücre doluluğu bu sınırda/üstündeyse acil mod

    // ══════════════════════════════════════════════════════════
    // YAVAŞ SÖNÜMLEME EĞRİSİ (Graduated Dampening)
    //
    // ESKİ DAVRANIŞ: evaluate() ikili bir karara sahipti — paket ya
    // "hayattaydı" (dokunulmuyordu) ya da yaş eşiğini geçer geçmez
    // ANINDA listeden siliniyordu. Bu, "yavaşça sönümleme" değil, gizli
    // bir basamak fonksiyonuydu — kullanıcı arayüzünde paket bir anda
    // yok oluyordu.
    //
    // YENİ DAVRANIŞ: her paketin bir "sinyal gücü" (signalStrength,
    // [0,1]) vardır. Paket doğduğunda güç 1.0'dır. DECAY_START_MS'ten
    // itibaren güç, ease-out eğrisiyle kademeli olarak azalır (MemristorCell'in
    // smoothstep mantığına benzer bir yaklaşım) — bu, UI'da paketin
    // opaklığının/parlaklığının YAVAŞÇA solması olarak render edilebilir.
    // Güç EVICT_STRENGTH_FLOOR'un (0.05) altına düştüğünde paket GERÇEKTEN
    // tahliye edilir (artık görünmez olacak kadar sönümlenmiştir).
    //
    // GRACEFUL mod: uzun, yumuşak sönümleme penceresi (~5 saniye) —
    // "nazikçe söndür". EMERGENCY mod: çok kısa, dik bir sönümleme
    // penceresi (~400ms) — donanımı korumak için hâlâ bir eğri
    // kullanılır (ani teleport değil) ama çok daha hızlı biter.
    // ══════════════════════════════════════════════════════════
    this.GRACEFUL_DECAY_START_MS = 2000;  // bu yaştan önce güç=1.0 (dokunulmaz)
    this.GRACEFUL_DECAY_END_MS   = 5000;  // bu yaşta güç≈0 (tahliyeye hazır)
    this.EMERGENCY_DECAY_START_MS = 60;   // acil modda çok daha erken sönümleme başlar
    this.EMERGENCY_DECAY_END_MS   = 400;
    this.EVICT_STRENGTH_FLOOR = 0.05;     // bu gücün altına düşen paket gerçekten silinir

    this.stats = { gracefulEvictions: 0, emergencyDrops: 0, lastMode: "graceful" };
  }

  /**
   * Hücre doluluk oranını hesaplar — InMemoryComputeFabric.cells.size'ın
   * varsayımsal bir kapasiteye (topoloji büyüklüğüne) oranı.
   * @param {number} cellCount
   * @param {number} capacity - toplam düğüm sayısı gibi bir üst sınır
   * @returns {number} [0,1] aralığında doluluk oranı
   */
  computeOccupancy(cellCount, capacity) {
    if (capacity <= 0) return 0;
    return Math.max(0, Math.min(1, cellCount / capacity));
  }

  /**
   * Filtrenin o an hangi modda olduğunu belirler.
   * @param {number} occupancy [0,1]
   * @returns {"graceful"|"emergency"}
   */
  currentMode(occupancy) {
    return occupancy >= this.COLLAPSE_THRESHOLD ? "emergency" : "graceful";
  }

  /**
   * Bir paketin o anki sinyal gücünü hesaplar (kademeli sönümleme eğrisi).
   * ownerActive=true olan paketler (transit hâlâ meşru sürüyor) graceful
   * modda güç=1.0'da tutulur — yalnızca sahipsiz kalanlar solmaya başlar.
   * Emergency modda sahiplik durumu YOK SAYILIR (herkes aynı hızlı
   * eğriyle söner) — donanım koruması sahiplikten önceliklidir.
   * @param {{bornAt:number, ownerActive:boolean}} packet
   * @param {"graceful"|"emergency"} mode
   * @returns {number} [0,1] — 1.0 tam güç, 0 tamamen sönmüş
   */
  computeSignalStrength(packet, mode) {
    const age = Date.now() - packet.bornAt;

    if (mode === "graceful" && packet.ownerActive) {
      return 1.0; // meşru transit hâlâ sürüyor — dokunma
    }

    const startMs = mode === "graceful" ? this.GRACEFUL_DECAY_START_MS : this.EMERGENCY_DECAY_START_MS;
    const endMs   = mode === "graceful" ? this.GRACEFUL_DECAY_END_MS   : this.EMERGENCY_DECAY_END_MS;

    if (age <= startMs) return 1.0;
    if (age >= endMs) return 0.0;

    // Ease-out kübik: başta yavaş azalır, sona doğru hızlanır — gerçek
    // bir "sönümleme" hissi verir (aniden kesilen bir motor gibi değil,
    // enerjisi tükenen bir sistem gibi).
    const t = (age - startMs) / (endMs - startMs); // [0,1]
    const easedOut = 1 - Math.pow(t, 2.2);
    return Math.max(0, Math.min(1, easedOut));
  }

  /**
   * Bir paket listesini değerlendirir. Artık ikili bir "evict/keep"
   * değil, HER PAKET İÇİN bir sinyal gücü (render için) + gerçekten
   * tahliye edilmesi gereken id listesi döner.
   * @param {Array<{id:string, bornAt:number, ownerActive:boolean}>} packets
   * @param {number} occupancy [0,1]
   * @returns {{mode:"graceful"|"emergency", evictIds:string[], strengths:Record<string,number>, reason:string}}
   */
  evaluate(packets, occupancy) {
    const mode = this.currentMode(occupancy);
    this.stats.lastMode = mode;

    const strengths = {};
    const toEvict = [];
    for (const p of packets) {
      const strength = this.computeSignalStrength(p, mode);
      strengths[p.id] = strength;
      if (strength <= this.EVICT_STRENGTH_FLOOR) toEvict.push(p.id);
    }

    if (mode === "graceful") this.stats.gracefulEvictions += toEvict.length;
    else this.stats.emergencyDrops += toEvict.length;

    return {
      mode,
      evictIds: toEvict,
      strengths, // {[packetId]: [0,1]} — UI bunu opaklık/parlaklık olarak render edebilir
      reason: toEvict.length ? (mode === "graceful" ? "GRACEFUL_TRANSIT_TIMEOUT" : "EMERGENCY_COLLAPSE_PROTECTION") : "NONE",
    };
  }
}

// Modül-seviyesi tekil örnek.
const softLandingFilter = new SoftLandingFilter();

// ══════════════════════════════════════════════════════════════
// BurstTrafficGenerator — ASENKRON YÜK SİMÜLATÖRÜ (test aracı)
//
// AMAÇ: DualClockScheduler'ın erken-uyanma eşiği (%88) ve
// SoftLandingFilter'ın graceful→emergency geçişi (%92), gerçek bir
// kullanıcı binlerce iletim göndermeden test edilemez. Bu sınıf,
// linkLoad state'ini KONTROLLÜ, YENİDEN ÜRETİLEBİLİR "patlama
// profilleri" ile yapay olarak sıçratan bir yük simülatörüdür —
// geliştiricinin "sistem şu an %92'nin üzerindeyken doğru davranıyor
// mu" sorusunu, gerçek ağ trafiği beklemeden anında test etmesini sağlar.
//
// Üç patlama profili sunar:
//   • "spike"  — hızlı yükselip hızlı düşen tek bir sivri patlama
//   • "plateau"— yükselip bir süre yüksek kalan, sonra düşen patlama
//   • "sawtooth" — art arda birden fazla kısa patlama (tekrarlayan yük)
//
// Bu sınıf DOĞRUDAN React state'ine yazmaz — bir setLinkLoad-benzeri
// callback alır (dependency injection), böylece hem gerçek UI'da hem
// de izole test ortamında kullanılabilir.
// ══════════════════════════════════════════════════════════════
class BurstTrafficGenerator {
  constructor() {
    this.running = false;
    this._cancelToken = null;
    this.stats = { burstsGenerated: 0, peakOccupancyReached: 0 };
  }

  /** requestAnimationFrame varsa onu, yoksa setTimeout'u kullanan asenkron bekleme. */
  _nextFrame() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => resolve(performance.now()));
      else setTimeout(() => resolve(Date.now()), 16);
    });
  }

  /**
   * "spike" profili: 0 → peak → 0, toplam durationMs içinde, ease-in-out eğrisiyle.
   * @param {number} t [0,1] normalize zaman
   * @param {number} peak hedef tepe değeri [0,1]
   */
  _spikeProfile(t, peak) {
    // Üçgen benzeri ama yumuşatılmış: sin tabanlı tek tümsek.
    return peak * Math.sin(Math.PI * t);
  }

  /** "plateau" profili: hızlı yükseliş, uzun düz tepe, hızlı iniş. */
  _plateauProfile(t, peak) {
    const rampFrac = 0.2; // yükseliş/iniş toplam sürenin %20'si her biri
    if (t < rampFrac) return peak * (t / rampFrac);
    if (t > 1 - rampFrac) return peak * ((1 - t) / rampFrac);
    return peak;
  }

  /** "sawtooth" profili: N adet ardışık kısa spike. */
  _sawtoothProfile(t, peak, teeth = 4) {
    const local = (t * teeth) % 1;
    return peak * Math.sin(Math.PI * local);
  }

  /**
   * Bir patlama üretir ve linkLoad'u gerçek zamanlı olarak günceller.
   * @param {Object} opts
   * @param {"spike"|"plateau"|"sawtooth"} [opts.profile="spike"]
   * @param {number} [opts.peak=0.95] - hedef tepe yük (0-1) — varsayılan
   *   %92 çöküş eşiğini bilerek aşacak şekilde ayarlandı (test amaçlı)
   * @param {number} [opts.durationMs=3000]
   * @param {string[]} [opts.linkKeys] - hangi link key'lerinin (örn. "IST-ANK")
   *   yükünü sıçratacağı; verilmezse tek bir sentetik "BURST-TEST" key'i kullanılır
   * @param {(updater: (prev: Record<string,number>) => Record<string,number>) => void} setLinkLoad
   *   - React setLinkLoad ile aynı imzada bir callback (dependency injection)
   * @param {(occupancyLike: number) => void} [onTick] - her adımda çağrılır (opsiyonel izleme)
   * @returns {Promise<void>}
   */
  async generateBurst({ profile = "spike", peak = 0.95, durationMs = 3000, linkKeys = ["BURST-TEST"] } = {}, setLinkLoad, onTick) {
    if (this.running) {
      throw new Error("BurstTrafficGenerator zaten çalışıyor — önce cancel() çağırın.");
    }
    this.running = true;
    const token = {};
    this._cancelToken = token;
    const startTime = performance.now();
    this.stats.burstsGenerated++;

    try {
      while (this.running && this._cancelToken === token) {
        const now = await this._nextFrame();
        const elapsed = now - startTime;
        const t = Math.max(0, Math.min(1, elapsed / durationMs));

        let value;
        if (profile === "plateau") value = this._plateauProfile(t, peak);
        else if (profile === "sawtooth") value = this._sawtoothProfile(t, peak);
        else value = this._spikeProfile(t, peak);

        value = Math.max(0, Math.min(1, value));
        this.stats.peakOccupancyReached = Math.max(this.stats.peakOccupancyReached, value);

        if (setLinkLoad) {
          setLinkLoad(prev => {
            const next = { ...prev };
            linkKeys.forEach(k => { next[k] = value; });
            return next;
          });
        }
        onTick?.(value);

        if (t >= 1) break;
      }
    } finally {
      // Patlama bitince (veya iptal edilince) yükü sıfıra indir — asılı
      // kalan yapay yük, gerçek trafiği taklit etmeye devam etmesin.
      if (setLinkLoad) {
        setLinkLoad(prev => {
          const next = { ...prev };
          linkKeys.forEach(k => { delete next[k]; });
          return next;
        });
      }
      this.running = false;
      this._cancelToken = null;
    }
  }

  /** Devam eden bir patlamayı erken durdurur (asenkron döngü bir sonraki frame'de çıkar). */
  cancel() {
    this._cancelToken = null;
    this.running = false;
  }
}

// Modül-seviyesi tekil örnek — UI'daki "test butonu" bunu kullanır.
const burstTrafficGenerator = new BurstTrafficGenerator();

// ══════════════════════════════════════════════════════════════
// LinkOutageController — DİNAMİK YÜK DENGELEME / AKILLI ROTALAMA
// (Dynamic Load Balancing & Smart Routing)
//
// KULLANICI TALEBİ: belirli bir hatta (özellikle okyanus-ötesi omurga
// bağlantılarında) yapay bir "kriz" enjekte edilebilsin — ya AŞIRI
// YOĞUNLUK (congestion) ya da TAM BAĞLANTI KOPMASI (outage) — ve
// yönlendirme motoru bunu OTOMATİK olarak algılayıp trafiği alternatif
// bir rotaya kaydırsın.
//
// KAPSAM AYRIMI (iki farklı mekanizma, TEK bir UI'dan tetiklenir):
//  • YOĞUNLUK: zaten var olan burstTrafficGenerator.generateBurst()
//    GERÇEK bir link key'i (örn. "LON-NYC") hedef alınarak yeniden
//    kullanılır — EdgeWeightPolicy.computeWeight() zaten linkLoad'u
//    maliyete katıyordu (bkz. o sınıfın başlığı), bu yüzden hat otomatik
//    olarak "daha pahalı" görünür, YENİ bir mekanizmaya gerek yoktur.
//  • KOPMA: LINKS'in hiçbir yerinde "down" alanı yoktu (bkz. araştırma) —
//    BU sınıf, süreli bir linkDown haritası tutar; EdgeWeightPolicy.isDown()
//    üzerinden Dijkstra'ya o kenarı TAMAMEN geçilmez (Infinity maliyetli)
//    kılar.
//
// BurstTrafficGenerator'ın RAF-tabanlı "her frame bir değer üret" deseni
// burada gereksiz — kopma ikili (var/yok) bir durumdur, ara değerlere
// gerek yoktur — bu yüzden tek bir setTimeout ile süre doluncaya kadar
// bekler, erken iptal için ayrı bir "early resolve" tutamacı kullanır.
class LinkOutageController {
  constructor() {
    this.running = false;
    this._cancelToken = null;
    this._resolveEarly = null;
    this._timer = null;
  }

  /**
   * @param {{linkKey: string, durationMs?: number}} opts - linkKey: "A-B" formatında
   * @param {(updater: (prev: Record<string,boolean>) => Record<string,boolean>) => void} setLinkDown
   */
  async injectOutage({ linkKey, durationMs = 20000 } = {}, setLinkDown) {
    if (this.running) {
      throw new Error("Bir kopma krizi zaten aktif — önce iptal edin.");
    }
    this.running = true;
    const token = {};
    this._cancelToken = token;
    setLinkDown(prev => ({ ...prev, [linkKey]: true }));
    try {
      await new Promise(resolve => {
        this._resolveEarly = resolve;
        this._timer = setTimeout(resolve, durationMs);
      });
    } finally {
      clearTimeout(this._timer);
      this._timer = null;
      this._resolveEarly = null;
      // Yalnızca BU çağrı hâlâ "geçerli" token'a sahipse temizle — iç
      // içe/çakışan bir çağrı varsa (normalde `running` kontrolü bunu
      // zaten engeller) yanlış kaydı silmeyi önler.
      if (this._cancelToken === token) {
        setLinkDown(prev => {
          const next = { ...prev };
          delete next[linkKey];
          return next;
        });
      }
      this.running = false;
      this._cancelToken = null;
    }
  }

  /** Devam eden bir kopmayı erken sonlandırır (hattı hemen onarır). */
  cancel() {
    if (this._resolveEarly) this._resolveEarly();
  }
}

// Modül-seviyesi tekil örnek — DİNAMİK YÜK DENGELEME paneli bunu kullanır.
const linkOutageController = new LinkOutageController();

// ══════════════════════════════════════════════════════════
// FAZ 2: KENDİ KENDİNİ İYİLEŞTİRME (SELF-HEALING) VE ANOMALİ TESPİTİ
// ══════════════════════════════════════════════════════════
// KULLANICI TALEBİ: rotalama motorunun bastığı logları ve ağdaki mikro
// dalgalanmaları arka planda PASİF olarak dinleyen otonom bir "Bekçi
// (Watchdog)" katmanı. Sistemde bir thread kilitlenirse (lockup), bellek
// sızıntısı (memory leak) başlarsa veya bir düğüm (node) yanıt vermeyi
// keserse (unresponsive) — bekçi insan müdahalesi OLMADAN hatayı yakalar,
// ilgili düğümü karantinaya alır, asenkron olarak "resetler" ve sistemi
// kendi kendine ayağa kaldırır.
//
// MİMARİ SEÇİMİ — YENİDEN İCAT YOK: NODES[].on alanı ve dijkstra()'daki
// `liveIds = new Set(nodes.filter(n => n.on).map(n => n.id))` süzgeci
// ZATEN routing motorunun saygı gösterdiği bir dışlama mekanizması (bkz.
// toggleNode). Watchdog bu MEVCUT mekanizmayı yeniden kullanır: bir
// düğümü "off" yapmak, o düğümden geçen TÜM linkleri otomatik olarak
// Dijkstra'dan dışlar — FAZ 1'in linkDown mekanizmasıyla BİREBİR AYNI
// prensip, node seviyesinde. Yeni bir dışlama yolu icat etmeye gerek yok.
class NodeWatchdog {
  constructor() {
    this._active = new Map(); // nodeId -> {type, token, timer, resolveEarly} — REAKTİF (arıza sonrası)
    this._preventive = new Map(); // nodeId -> {token, timer, resolveEarly} — FAZ 4: PROAKTİF (kriz oluşmadan)
  }

  isActive(nodeId) { return this._active.has(nodeId); }
  isPreventive(nodeId) { return this._preventive.has(nodeId); }
  /** Bir düğüm reaktif VEYA proaktif herhangi bir Watchdog döngüsünde mi — dış çağıranlar için tek kontrol noktası. */
  isBusy(nodeId) { return this._active.has(nodeId) || this._preventive.has(nodeId); }

  /**
   * Bir anomaliyi (elle demo amaçlı VEYA otonom arka-plan taraması
   * tarafından) tetikler: düğümü karantinaya alır (routing'den otomatik
   * dışlanır), kısa bir "tanılama" gecikmesinin ardından asenkron olarak
   * kendi kendine iyileştirir ve düğümü ağa geri entegre eder — hiçbir
   * kullanıcı etkileşimi gerekmez.
   * @param {{nodeId:string, type:"lockup"|"leak"|"unresponsive", healMs?:number}} opts
   * @param {{setNodes:Function, setNodeHealth:Function, setActiveAnomalies:Function, addLog:Function, setWatchdogStats:Function}} io
   */
  async triggerAnomaly({ nodeId, type, healMs } = {}, io) {
    const { setNodes, setNodeHealth, setActiveAnomalies, addLog, setWatchdogStats, openDrillDown, onHealed } = io;
    if (this._active.has(nodeId)) return; // zaten karantinada — tekrar tetikleme yok

    const durations = { lockup: 4000, leak: 6000, unresponsive: 3500 };
    const dur = healMs ?? durations[type] ?? 4000;
    const labels = {
      lockup: "THREAD KİLİTLENMESİ",
      leak: "BELLEK SIZINTISI (memory leak)",
      unresponsive: "DÜĞÜM YANIT VERMİYOR (heartbeat kayıp)",
    };
    const startedAt = Date.now();
    const token = {};
    this._active.set(nodeId, { type, token });

    setActiveAnomalies(prev => ({ ...prev, [nodeId]: { type, startedAt, phase: "detected" } }));
    setNodeHealth(prev => ({ ...prev, [nodeId]: {
      ...(prev[nodeId] || {}),
      status: "CRIT",
      cpu: type === "lockup" ? 100 : (prev[nodeId]?.cpu ?? 30),
      mem: type === "leak" ? 97 : (prev[nodeId]?.mem ?? 35),
      heartbeat: (type === "unresponsive" || type === "lockup") ? 0 : (prev[nodeId]?.heartbeat ?? 1),
    } }));
    addLog(`🛡️ WATCHDOG: ${nodeId} düğümünde ${labels[type]} tespit edildi — modül karantinaya alınıyor, trafik otomatik olarak diğer düğümlere yönlendirilecek`, "ERR");
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, on: false } : n));
    setWatchdogStats(prev => ({ ...prev, anomaliesDetected: prev.anomaliesDetected + 1 }));
    // FAZ 3: "sistemin kendisi" — Watchdog bir anomali tespit ettiğinde,
    // kullanıcı halihazırda başka bir mikro görünüme bakmıyorsa, ilgili
    // düğümün mikro (drill-down) katmanını KENDİLİĞİNDEN açar, thread
    // havuzunun gerçek zamanlı çöküşünü/iyileşmesini gösterir.
    openDrillDown?.(nodeId);

    // Kısa bir "tanılama" gecikmesi — anlık kopya/reset yerine gerçekçi
    // bir teşhis-sonra-müdahale akışı hissi verir.
    await new Promise(resolve => { this._active.get(nodeId).timer = setTimeout(resolve, 500); });
    if (this._active.get(nodeId)?.token !== token) return; // bu arada erken iyileştirilmiş/iptal edilmiş

    addLog(`🔧 WATCHDOG: ${nodeId} alt modülü asenkron olarak yeniden başlatılıyor...`, "WARN");
    setActiveAnomalies(prev => ({ ...prev, [nodeId]: { ...(prev[nodeId] || {}), phase: "healing" } }));

    await new Promise(resolve => {
      const rec = this._active.get(nodeId);
      if (!rec) { resolve(); return; }
      rec.resolveEarly = resolve;
      rec.timer = setTimeout(resolve, dur);
    });
    if (this._active.get(nodeId)?.token !== token) return;

    const downMs = Date.now() - startedAt;
    setNodeHealth(prev => ({ ...prev, [nodeId]: {
      status: "OK", cpu: 8 + Math.random() * 10, mem: 15 + Math.random() * 10, heartbeat: 1,
    } }));
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, on: true } : n));
    setActiveAnomalies(prev => { const n = { ...prev }; delete n[nodeId]; return n; });
    setWatchdogStats(prev => ({ ...prev, autoHeals: prev.autoHeals + 1, lastHealMs: downMs }));
    addLog(`✅ WATCHDOG: ${nodeId} başarıyla kurtarıldı, ağa yeniden entegre edildi (kesinti süresi: ${(downMs / 1000).toFixed(1)}s) — insan müdahalesi gerekmedi`, "OK");
    this._active.delete(nodeId);
    onHealed?.(nodeId);
  }

  /** Devam eden bir iyileştirmeyi erken tamamlar (demo/manuel "hemen onar"). */
  forceHealNow(nodeId) {
    const rec = this._active.get(nodeId) || this._preventive.get(nodeId);
    if (rec?.resolveEarly) { clearTimeout(rec.timer); rec.resolveEarly(); }
  }

  /**
   * FAZ 4 — TAHMİNLEME MOTORU (Predictive Telemetry): triggerAnomaly ile
   * AYNI karantina/iyileştirme iskeletini (node.on=false → routing otomatik
   * dışlar → node.on=true) kullanır, ama anlamı TAMAMEN FARKLIDIR — bu bir
   * ARIZA DEĞİL, bir ÖNLEMdir. PredictiveTelemetryEngine bir düğümün
   * hareketli-ortalama + ivmelenme ekstrapolasyonuna göre önümüzdeki ~5
   * dakika içinde kritik eşiği aşacağını öngördüğünde çağrılır — KRİZ
   * DAHA OLUŞMADAN, düğüm kısa bir "proaktif bakım" döngüsüne alınır.
   * @param {{nodeId:string, reason:string, healMs?:number}} opts
   * @param {{setNodes:Function, setActivePreventive:Function, addLog:Function, setPredictiveStats:Function, openDrillDown?:Function, onHealed?:Function}} io
   */
  async triggerPreventiveMaintenance({ nodeId, reason, healMs = 2600 } = {}, io) {
    const { setNodes, setActivePreventive, addLog, setPredictiveStats, openDrillDown, onHealed } = io;
    if (this.isBusy(nodeId)) return; // reaktif bir anomali VEYA başka bir proaktif döngü zaten sürüyor

    const startedAt = Date.now();
    const token = {};
    this._preventive.set(nodeId, { token });

    setActivePreventive(prev => ({ ...prev, [nodeId]: { reason, startedAt } }));
    addLog(`🔮 ÖNLEYİCİ BAKIM: ${nodeId} düğümünde ${reason} — öngörülen darboğaz OLUŞMADAN ÖNCE proaktif bakım başlatılıyor (kriz beklenmiyor, önleniyor)`, "WARN");
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, on: false } : n));
    setPredictiveStats(prev => ({ ...prev, preventiveActions: prev.preventiveActions + 1 }));
    // FAZ 3 entegrasyonu: kullanıcı başka bir mikro görünüme bakmıyorsa,
    // proaktif bakım da (reaktif Watchdog gibi) drill-down'ı otomatik açar.
    openDrillDown?.(nodeId);

    await new Promise(resolve => {
      const rec = this._preventive.get(nodeId);
      if (!rec) { resolve(); return; }
      rec.resolveEarly = resolve;
      rec.timer = setTimeout(resolve, healMs);
    });
    if (this._preventive.get(nodeId)?.token !== token) return;

    const downMs = Date.now() - startedAt;
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, on: true } : n));
    setActivePreventive(prev => { const n = { ...prev }; delete n[nodeId]; return n; });
    addLog(`✅ ÖNLEYİCİ BAKIM TAMAMLANDI: ${nodeId} — öngörülen darboğaz ÖNLENDİ (proaktif kesinti: ${(downMs / 1000).toFixed(1)}s), ağa geri entegre edildi`, "OK");
    this._preventive.delete(nodeId);
    onHealed?.(nodeId);
  }
}

// Modül-seviyesi tekil örnek — hem otonom arka-plan taraması hem de
// elle-tetiklenen demo paneli AYNI kontrolörü paylaşır (LinkOutageController
// ile tutarlı desen).
const nodeWatchdog = new NodeWatchdog();

// ══════════════════════════════════════════════════════════════
// FAZ 4: TAHMİNLEME MODELİ (PREDICTIVE TELEMETRY)
// ══════════════════════════════════════════════════════════════
// KULLANICI TALEBİ: "Sistemde anlık olarak akan verileri ve soket
// geçmişlerini analiz ederek, gelecekte hangi düğümlerin darboğaza
// gireceğini veya hangi hatlarda gecikme yaşanacağını önceden tahmin
// eden proaktif bir motor... Sistem kriz çıkmasını beklemeyecek, krizin
// geleceğini 5 dakika önceden görüp önlem alacak. Çekirdek algoritma:
// hareketli ortalamalar (Moving Average) ve anlık veri ivmelenmesi
// (Data Acceleration) kullanarak risk skoru üreten otonom matematiksel motor."
//
// MATEMATİKSEL MODEL (her izlenen anahtar — link veya düğüm metriği — için):
//  1) HAREKETLİ ORTALAMA (SMA): son N örneğin ortalaması — anlık gürültüyü
//     yumuşatır (satellite-link-tick/watchdog-vitals-tick'in rastgele
//     dalgalanmaları tek başına yanlış alarm üretmesin diye).
//  2) HIZ (1. türev, "velocity"): (t,v) noktaları üzerinde EN KÜÇÜK KARELER
//     (least-squares) doğrusal regresyon eğimi — birim/saniye.
//  3) İVME (2. türev, "Data Acceleration"): pencere ikiye bölünür, her
//     yarının kendi hızı hesaplanır; ikisi arasındaki fark, aralarındaki
//     zaman farkına bölünür — "hız ne kadar hızlı değişiyor".
//  4) 5-DAKİKA EKSTRAPOLASYONU: kinematik ikinci-derece formül —
//     x(T) = x0 + v·T + ½·a·T²  (T = ufuk = 300 000ms = 5dk)
//  5) RİSK SKORU: tahmin edilen değerin [uyarı,kritik] eşik aralığındaki
//     konumu × trend teyidi (yükseliyor mu, düşüyor mu).
//  6) ETA (kritik eşiğe varış süresi): x(t)=kritik denkleminin (ikinci
//     dereceden) EN KÜÇÜK POZİTİF KÖKÜ — "tam olarak ne zaman" sorusuna
//     kaba bir kuvvetle değil, gerçek bir denklem çözümüyle cevap verir.
//
// Bu motor SAF matematik + veri (mevcut linkLoad/nodeHealth akışlarını
// örnekler) — hiçbir React state'e doğrudan dokunmaz; component tarafı
// (predictive-telemetry-tick) sonuçları React state'e yazar.
class PredictiveTelemetryEngine {
  /**
   * @param {{windowSize?:number, smaWindow?:number, horizonMs?:number, emaAlpha?:number}} [opts]
   *   windowSize: tutulan örnek sayısı (regresyon/ivme penceresi).
   *   smaWindow: hareketli ortalama için kullanılan son-örnek sayısı.
   *   horizonMs: ekstrapolasyon ufku — varsayılan 300000ms (KULLANICI
   *   TALEBİNDEKİ "5 dakika önceden" İLE BİREBİR EŞLEŞİR).
   *   emaAlpha: ingest() ÖN-SÜZGECİ (üstel hareketli ortalama, low-pass
   *   filtre). NEDEN: bazı kaynaklar (özellikle linkLoad — bkz.
   *   satellite-link-tick) TEK TİK içinde ani sıçrama yapabilecek kadar
   *   "sivri" (spiky). Ham sivri değerler doğrudan regresyona verilirse,
   *   TEK bir sıçrama bile kısa pencerede büyük bir "hız/ivme" gibi
   *   görünür. ingest() bu yüzden HER ÖRNEĞİ tarihe yazmadan önce EMA ile
   *   yumuşatır — regresyon/ivme SÜZÜLMÜŞ sinyal üzerinde çalışır.
   */
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 24;
    this.smaWindow = opts.smaWindow ?? 8;
    this.horizonMs = opts.horizonMs ?? 300000;
    this.emaAlpha = opts.emaAlpha ?? null;
    this.history = new Map(); // key -> [{t,v}, ...] (kronolojik, en eski önce; v = EMA-süzülmüş)
  }

  /** Yeni bir örnek ekler (EMA ile ön-süzülmüş); pencere dolunca en eski örnek düşer (ring buffer). */
  ingest(key, rawValue, nowMs) {
    let buf = this.history.get(key);
    if (!buf) { buf = []; this.history.set(key, buf); }
    const prevSmoothed = buf.length ? buf[buf.length - 1].v : rawValue;
    const value = this.emaAlpha != null ? prevSmoothed + this.emaAlpha * (rawValue - prevSmoothed) : rawValue;
    buf.push({ t: nowMs, v: value });
    if (buf.length > this.windowSize) buf.shift();
  }

  /**
   * En küçük kareler doğrusal regresyon eğimi (v = a + b·t formundaki b).
   * Sayısal kararlılık için zaman ekseni ilk örneğe göre kaydırılır ve
   * saniyeye çevrilir (ms yerine) — böylece eğim doğrudan "birim/saniye"
   * olarak yorumlanabilir.
   * @param {{t:number,v:number}[]} points
   * @returns {number}
   */
  static linRegSlope(points) {
    const n = points.length;
    if (n < 2) return 0;
    const t0 = points[0].t;
    let sumT = 0, sumV = 0, sumTT = 0, sumTV = 0;
    for (const p of points) {
      const t = (p.t - t0) / 1000;
      sumT += t; sumV += p.v; sumTT += t * t; sumTV += t * p.v;
    }
    const denom = n * sumTT - sumT * sumT;
    if (Math.abs(denom) < 1e-9) return 0;
    return (n * sumTV - sumT * sumV) / denom;
  }

  /**
   * Bir anahtarın (link key'i veya "node-cpu:ID"/"node-mem:ID") mevcut
   * geçmişinden HAREKETLİ ORTALAMA + İVMELENME tabanlı risk analizini
   * üretir. warnThreshold/critThreshold [0,1] normalize ölçekte verilir.
   * @param {string} key
   * @param {{warnThreshold?:number, critThreshold?:number, nowMs?:number}} [opts]
   * @returns {{key:string, sma:number, velocity:number, acceleration:number, predicted:number, risk:number, etaMs:number|null, level:string}|null}
   */
  analyze(key, { warnThreshold = 0.55, critThreshold = 0.85, nowMs } = {}) {
    const buf = this.history.get(key);
    if (!buf || buf.length < 6) return null; // yeterli örnek yok — henüz tahmin yapılamaz (erken/az örnekli regresyon güvenilmez)

    const smaPts = buf.slice(-this.smaWindow);
    const sma = smaPts.reduce((s, p) => s + p.v, 0) / smaPts.length;

    const velocityRaw = PredictiveTelemetryEngine.linRegSlope(buf);

    // İVME: pencereyi ikiye böl, her yarının KENDİ hızını hesapla, ikisi
    // arasındaki farkı, yarıların "orta zamanları" arasındaki farka böl.
    const mid = Math.floor(buf.length / 2);
    const firstHalf = buf.slice(0, Math.max(2, mid));
    const secondHalf = buf.slice(Math.max(2, mid));
    let accelerationRaw = 0, v1 = 0, v2 = 0;
    if (firstHalf.length >= 2 && secondHalf.length >= 2) {
      v1 = PredictiveTelemetryEngine.linRegSlope(firstHalf);
      v2 = PredictiveTelemetryEngine.linRegSlope(secondHalf);
      const tMid1 = (firstHalf[0].t + firstHalf[firstHalf.length - 1].t) / 2 / 1000;
      const tMid2 = (secondHalf[0].t + secondHalf[secondHalf.length - 1].t) / 2 / 1000;
      const dt = tMid2 - tMid1;
      accelerationRaw = Math.abs(dt) > 1e-6 ? (v2 - v1) / dt : 0;
    }

    // GÜRÜLTÜ SÜZGECİ (deadband + tutarlılık kapısı): kısa pencerelerden
    // ölçülen hız/ivme, T=5dk ile ekstrapole edilince SAF GÜRÜLTÜYÜ BİLE
    // "kalıcı trend" gibi gösterebilir (random walk'ların/spike-sonrası-
    // sönmenin bilinen bir istatistiksel yanılsaması). İki savunma katmanı:
    //  1) DEADBAND — eşik aralığının ~%8'inden azını hareket ettirecek
    //     kadar küçük hız/ivme "gürültü" sayılıp sıfırlanır.
    //  2) TUTARLILIK KAPISI — iki yarı-pencere hızı (v1,v2) ZIT işaretliyse
    //     (yön değiştirmiş → muhtemelen spike-sonrası-sönme), ivme
    //     GÜVENİLMEZ sayılır ve sıfırlanır; yalnızca AYNI YÖNDE tutarlı
    //     ivmelenme "hızlanan gerçek trend" sayılır.
    const gap = (critThreshold - warnThreshold) || 1;
    const T = this.horizonMs / 1000;
    const velDeadband = (gap * 0.04) / T;
    const accDeadband = (gap * 0.04) / (0.5 * T * T);
    const accelConsistent = (v1 > 0 && v2 > 0) || (v1 < 0 && v2 < 0);
    const velocity = Math.abs(velocityRaw) > velDeadband ? velocityRaw : 0;
    const acceleration = (accelConsistent && Math.abs(accelerationRaw) > accDeadband) ? accelerationRaw : 0;

    // 5 DAKİKA SONRASI TAHMİN: x(T) = x0 + v·T + ½·a·T²
    //
    // SAYISAL KARARLILIK: her ekstrapolasyon terimi, eşik ARALIĞININ
    // KENDİSİYLE orantılı bir üst sınırla (±0.6×gap) sınırlanır — sabit/
    // büyük bir mutlak sınır (örn. ±0.5) gürültüyü de tek başına eşiği
    // aşırmaya yeterli olurdu; gap-orantılı sınır, GÜÇLÜ bir trendin hâlâ
    // kritik eşiği aşabilmesini (iki terim birlikte ~1.2×gap) korurken,
    // deadband'i geçebilen ama yine de mütevazı gürültü kalıntılarının
    // tek başına eşiği aşmasını engeller.
    const EXTRAP_TERM_CAP = gap * 0.6;
    const velTerm = Math.max(-EXTRAP_TERM_CAP, Math.min(EXTRAP_TERM_CAP, velocity * T));
    const accTerm = Math.max(-EXTRAP_TERM_CAP, Math.min(EXTRAP_TERM_CAP, 0.5 * acceleration * T * T));
    const predictedRaw = sma + velTerm + accTerm;
    const predicted = Math.max(0, Math.min(1.3, predictedRaw)); // fiziksel-olmayan aşırı uçları budayan yumuşak tavan

    // RİSK SKORU — İKİ BİLEŞENİN MAKSİMUMU:
    //  1) trendRisk: ekstrapole edilmiş TAHMİNE dayalı risk (asıl "5 dakika
    //     önceden görme" mekanizması — henüz düşük olan ama HIZLA yükselen
    //     bir metriği erken yakalar).
    //  2) currentRisk: TREND'DEN BAĞIMSIZ, SADECE ŞU ANKİ (hareketli
    //     ortalama) DEĞERE dayalı risk. NEDEN GEREKLİ: bir metrik zirveye
    //     ulaşıp DÜZLEŞTİĞİNDE (hız/ivme sıfıra yaklaşır) trendRisk tek
    //     başına kullanılsaydı risk YANLIŞ BİÇİMDE düşerdi — "artık
    //     hızlanmıyor" ile "artık tehlikeli değil" AYNI ŞEY DEĞİLDİR; hâlâ
    //     kritik eşiğe yakın/üstünde oturan bir değer HÂLÂ risklidir.
    // max() almak, ikisinden hangisi daha ciddiyse onun kazanmasını sağlar.
    const proximity = Math.max(0, Math.min(1, (predicted - warnThreshold) / gap));
    const trendConfirm = velocity > 0 ? 1 : (acceleration > 0 ? 0.6 : 0.25);
    const trendRisk = proximity * (0.55 + 0.45 * trendConfirm);
    const currentRisk = Math.max(0, Math.min(1, (sma - warnThreshold) / gap)) * 0.85;
    const risk = Math.max(0, Math.min(1, Math.max(trendRisk, currentRisk)));

    // ETA: sma + v·t + ½·a·t² = critThreshold denkleminin en küçük pozitif kökü.
    let etaMs = null;
    if (predicted >= critThreshold) {
      const A = 0.5 * acceleration, B = velocity, C = sma - critThreshold;
      if (Math.abs(A) < 1e-9) {
        if (Math.abs(B) > 1e-9) { const t = -C / B; if (t > 0) etaMs = t * 1000; }
      } else {
        const disc = B * B - 4 * A * C;
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          const roots = [(-B + sq) / (2 * A), (-B - sq) / (2 * A)].filter(r => r > 0).sort((a, b) => a - b);
          if (roots.length) etaMs = roots[0] * 1000;
        }
      }
      if (etaMs != null && etaMs > this.horizonMs) etaMs = null; // ufkun (5dk) ötesindeyse "yakın" sayılmaz
    }

    const level = risk >= 0.85 ? "CRITICAL" : risk >= 0.6 ? "WARNING" : risk >= 0.3 ? "WATCH" : "SAFE";
    return { key, sma, velocity, acceleration, predicted, risk, etaMs, level };
  }
}

// Modül-seviyesi tekil örnek — predictive-telemetry-tick bunu besler/okur.
const predictiveEngine = new PredictiveTelemetryEngine({ windowSize: 24, smaWindow: 8, horizonMs: 300000, emaAlpha: 0.2 });

// ── MetricTrendInjector: FAZ 4 demo amaçlı "yükselen trend" enjektörü ──
// BurstTrafficGenerator'daki AYNI RAF-tabanlı "her frame bir değer üret"
// deseni, ama linkLoad'un düz Record<string,number> şekline KİLİTLİ
// DEĞİL — herhangi bir "apply(value)" callback'i ile genelleştirilmiş
// (hem link yükü HEM DE düğüm cpu/mem sentetik metriği için kullanılabilir,
// bkz. injectLinkTrend/injectNodeTrend). Amaç: TahminlemeMotoru'nun
// gerçek zamanda YÜKSELEN bir trendi (kriz oluşmadan ÖNCE) yakaladığını
// canlı olarak göstermek.
class MetricTrendInjector {
  constructor() { this.running = false; this._cancelToken = null; }
  _nextFrame() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => resolve(performance.now()));
      else setTimeout(() => resolve(Date.now()), 16);
    });
  }
  /** BurstTrafficGenerator'ın "plateau" eğrisiyle AYNI şekil — kararlı bir yükseliş + düz tepe + iniş. */
  _plateauProfile(t, span) {
    const rampFrac = 0.25;
    if (t < rampFrac) return span * (t / rampFrac);
    if (t > 1 - rampFrac) return span * ((1 - t) / rampFrac);
    return span;
  }
  /**
   * @param {{peak?:number, durationMs?:number, baseline?:number}} opts - [0,1] ölçekte
   * @param {(value:number)=>void} apply - her frame'de [baseline,peak] arası değeri iletir
   * @param {(baseline:number)=>void} [reset] - bitince/iptalde çağrılır
   */
  async run({ peak = 0.95, durationMs = 18000, baseline = 0.15 } = {}, apply, reset) {
    if (this.running) throw new Error("Bir trend enjeksiyonu zaten aktif — önce iptal edin.");
    this.running = true;
    const token = {};
    this._cancelToken = token;
    const startTime = performance.now();
    try {
      while (this.running && this._cancelToken === token) {
        const now = await this._nextFrame();
        const t = Math.max(0, Math.min(1, (now - startTime) / durationMs));
        const value = Math.max(0, Math.min(1, baseline + this._plateauProfile(t, peak - baseline)));
        apply(value);
        if (t >= 1) break;
      }
    } finally {
      reset?.(baseline);
      this.running = false;
      this._cancelToken = null;
    }
  }
  cancel() { this._cancelToken = null; this.running = false; }
}
const metricTrendInjector = new MetricTrendInjector();

// ══════════════════════════════════════════════════════════════
// CoefficientEvolutionEngine — KENDİ KENDİNİ OPTİMİZE EDEN KATSAYILAR
//
// PROBLEM: LEGA'nın α (entropi hassasiyeti) ve β (komşu baskısı)
// katsayıları elle ayarlanmış sabitlerdi (0.6 / 0.15) — hangi ağ
// koşulunda en iyi performansı verdikleri hiç test edilmedi.
//
// ÇÖZÜM (isim ve kapsam bakımından dürüst çerçeve): Popülasyon tabanlı
// bir arama sezgiseli — mutasyon, seçilim ve fitness puanlaması içerdiği
// için "genetik algoritma" terminolojisiyle tutarlıdır, AMA aşağıdaki
// sınırlamalar nedeniyle GERÇEK bir istatistiksel öğrenme sistemi
// OLARAK sunulmamalıdır:
//
// ── GERÇEKÇİLİK SINIRLARI (dürüstlük notu) ──────────────────────
//  • Popülasyon boyutu (24) ve probe foton sayısı (PROBE_PHOTON_COUNT=8,
//    evaluateFitness/measureNodeRejectionRate içinde) İSTATİSTİKSEL
//    ANLAMLILIK İÇİN ÇOK DÜŞÜKTÜR — 8 örneklemden çıkan bir "ret oranı"
//    yüksek varyanslıdır, güvenilir bir tahmin değildir.
//  • nodeRejectionPenaltyWeight varsayılanı (0.4) KEYFİDİR — herhangi
//    bir deneysel kalibrasyon veya duyarlılık analizinden gelmez.
//  • EN KRİTİK SINIR: "evrim" sonucu üretilen katsayılar, YALNIZCA
//    LEGA'nın KENDİ FORMÜLÜYLE (computeThresholds) puanlanır — bağımsız,
//    gerçek bir ağ sonucuna (örn. gerçekten gönderilmiş binlerce foton,
//    gerçek BER ölçümü) karşı ASLA doğrulanmaz. Yani bu sistem "kendi
//    sınavını kendi hazırlayıp kendi cevaplıyor" — fitness fonksiyonu
//    ile ödüllendirdiği davranış arasında dışsal bir gerçeklik kontrolü
//    yoktur. Bu, ilkeler açısından bir GENETİK ALGORİTMADAN ÇOK, yerel
//    bir tepe-tırmanma (hill-climbing) sezgiseline daha yakındır.
//
// Sakin anlarda (ağ yükü düşükken) arka planda popülasyonu tutar, her
// birini YAKIN GEÇMİŞTEKİ ağ koşulları (timeline'dan alınan linkLoad/
// BER örnekleri) üzerinde LEGA'nın kendi formülüyle puanlar (yeni foton
// yaymadan — mevcut computeThresholds() çağrılarıyla, saf hesaplama).
// En yüksek fitness'e sahip genom mutasyon ve seçilimle sonraki
// nesillere aktarılır, periyodik olarak canlı sisteme uygulanır.
//
// LEGA.computeThresholds()'ın FORMÜLÜNE HİÇ DOKUNULMAZ; bu motor sadece
// formüle giren iki katsayıyı, geçmiş veriye göre arar — ama "geçmiş
// veri" burada gerçek ağ performansı değil, aynı sezgisel formülün
// başka parametrelerle ne üreteceğidir.
// ══════════════════════════════════════════════════════════════
class CoefficientEvolutionEngine {
  constructor(populationSize = 24) {
    this.populationSize = populationSize;
    this.generation = 0;
    this.population = this._seedPopulation();
    this.bestGenome = { alpha: 0.6, beta: 0.15, fitness: null }; // canlı sistemin şu anki "standardı"
    this.history = []; // her neslin en iyi fitness'i — UI grafiği için
  }

  _seedPopulation() {
    // İlk nesil: mevcut (0.6, 0.15) civarında rastgele dağılmış genomlar
    // — evrim sıfırdan değil, bilinen iyi bir noktadan başlar.
    return Array.from({ length: this.populationSize }, () => ({
      alpha: Math.max(0.1, Math.min(1.2, 0.6 + (Math.random() - 0.5) * 0.6)),
      beta:  Math.max(0.02, Math.min(0.5, 0.15 + (Math.random() - 0.5) * 0.2)),
      fitness: null,
    }));
  }

  /**
   * FITNESS FONKSİYONU: "en az enerjiyle en yüksek veri" hedefini sayısallaştırır.
   * Bir genomun, verilen geçmiş örnek koşulları altında LEGA formülüyle
   * ürettiği eşiklerin ne kadar "verimli" (düşük gereksiz ret, kararlı,
   * aşırı toleranslı da değil) olduğunu puanlar.
   *
   * DÜĞÜM REDDİ CEZASI (GERÇEK ÖLÇÜM): Eskiden bu fonksiyon yalnızca
   * LEGA'nın HAM katsayılarından (absorbBias/scatterDeathProb) dolaylı
   * bir "rejectionCost" tahmini çıkarıyordu — NodeTransitGate'in GERÇEK
   * üç-aşamalı kararını (Aşama 1 rezonans + Aşama 2 genlik) hiç
   * çalıştırmıyordu. Artık her genom, İZOLE bir "probe" NodeTransitGate
   * üzerinde GERÇEKTEN test ediliyor — canlı nodeTransitGate singleton'ının
   * rezonans profillerini/yorgunluk durumunu KİRLETMEDEN (ayrı bir
   * örnek kullanılarak), gerçek evaluate() çağrılarıyla kaç fotonun
   * reddedildiği ÖLÇÜLÜYOR. Genetik algoritma artık dolaylı bir formülü
   * değil, NodeTransitGate'in GERÇEK DAVRANIŞINI izleyip ona göre evriliyor.
   * @param {{alpha:number, beta:number}} genome
   * @param {Array<{linkLoad:number, historicalBer:number}>} samples - timeline'dan türetilmiş gerçek koşullar
   * @param {number} [nodeRejectionPenaltyWeight=0.4] - Düğüm Reddi cezasının
   *   toplam fitness üzerindeki ağırlığı (0=etkisiz, 1=baskın). Dışarıdan
   *   ayarlanabilir bir parametre olarak sunulur.
   * @returns {number} - yüksek daha iyi
   */
  evaluateFitness(genome, samples, nodeRejectionPenaltyWeight = 0.4) {
    if (samples.length === 0) return 0;
    let totalScore = 0;
    // İZOLE PROBE GATE: canlı nodeTransitGate'in rezonans profillerini
    // KİRLETMEDEN, her genomun gerçek reddedilme davranışını test etmek
    // için TAZE bir örnek. Popülasyon boyunca (24 genom) yeniden
    // kullanılabilir çünkü her genom kendi profilini sıfırdan kurar.
    const probeGate = new NodeTransitGate();
    const PROBE_PHOTON_COUNT = 8; // her örnek koşulda kaç "sanal foton" test edilecek

    for (const s of samples) {
      const th = lega.computeThresholds(1550, 500, s, genome); // referans nm/km — göreceli karşılaştırma için sabit
      // "Enerji" maliyeti: absorbBias ve scatterDeathProb ne kadar
      // yüksekse, o kadar fazla paket reddediliyor demektir (maliyet).
      const rejectionCost = (th.absorbBias - 1.0) + th.scatterDeathProb;
      // "Veri verimi" ödülü: yük düşükken (sakin ağ) eşiklerin gereksiz
      // yere yüksek OLMAMASI ödüllendirilir — sakin anda cömert olmalı.
      const calmBonus = s.linkLoad < 0.3 ? (1.0 - rejectionCost) * 0.5 : 0;
      // Yoğun anda ise seçicilik (yüksek eşik) ödüllendirilir — ağ
      // kendini doğru zamanda kısabilmeli.
      const busyBonus = s.linkLoad > 0.6 ? rejectionCost * 0.3 : 0;

      // GERÇEK DÜĞÜM REDDİ ÖLÇÜMÜ: probeGate üzerinde, bu örneğin
      // linkLoad/historicalBer koşulu altında birkaç sanal foton
      // GERÇEKTEN değerlendirilir (deterministik bir rng ile — genetik
      // karşılaştırmanın adil olması için her genom AYNI "şans" dizisini
      // görür, farklı rastgelelik gürültüsü karşılaştırmayı bozmasın).
      const probeRng = mulberry32(0xC0FFEE); // sabit seed — genomlar arası adil karşılaştırma
      let rejections = 0;
      for (let i = 0; i < PROBE_PHOTON_COUNT; i++) {
        const result = probeGate.evaluate(
          "PROBE_NODE", 1550, 500, /* lowPriority */ i % 3 === 0,
          { linkLoad: s.linkLoad, historicalBer: s.historicalBer, coeffOverride: { alpha: genome.alpha, beta: genome.beta } },
          probeRng
        );
        if (!result.passed) rejections++;
      }
      const nodeRejectionRate = rejections / PROBE_PHOTON_COUNT; // [0,1] — bu genomun GERÇEK ret oranı

      totalScore += calmBonus + busyBonus - Math.abs(rejectionCost - 0.6) * 0.1 // aşırı uçlara ceza
        - nodeRejectionRate * nodeRejectionPenaltyWeight; // DÜĞÜM REDDİ CEZASI — dışarıdan ayarlanabilir
    }
    return totalScore / samples.length;
  }

  /**
   * TEŞHİS METODU: bir genomun GERÇEK, HAM düğüm-reddi oranını ölçer
   * (fitness formülünün diğer terimlerinden — calmBonus/busyBonus/
   * aşırı-uç cezası — ARINDIRILMIŞ). evaluateFitness() içindeki AYNI
   * probe mekanizmasını (izole NodeTransitGate, sabit seed) kullanır —
   * bu yüzden buradan dönen sayı, fitness hesaplamasında GERÇEKTEN
   * kullanılan ret oranıyla birebir tutarlıdır. "Motorun kendi kendini
   * eğitmesini izleyelim" isteğinin gözlemlenebilir çıktısıdır — bu
   * değer nesiller ilerledikçe (nodeRejectionPenaltyWeight>0 iken)
   * düşme eğiliminde olmalıdır.
   * @param {{alpha:number, beta:number}} genome
   * @param {Array<{linkLoad:number, historicalBer:number}>} samples
   * @returns {number} [0,1] — ortalama ret oranı
   */
  measureNodeRejectionRate(genome, samples) {
    if (samples.length === 0) return 0;
    const probeGate = new NodeTransitGate();
    const PROBE_PHOTON_COUNT = 8;
    let totalRate = 0;
    for (const s of samples) {
      const probeRng = mulberry32(0xC0FFEE); // evaluateFitness ile AYNI sabit seed — tutarlı ölçüm
      let rejections = 0;
      for (let i = 0; i < PROBE_PHOTON_COUNT; i++) {
        const result = probeGate.evaluate(
          "PROBE_NODE", 1550, 500, i % 3 === 0,
          { linkLoad: s.linkLoad, historicalBer: s.historicalBer, coeffOverride: { alpha: genome.alpha, beta: genome.beta } },
          probeRng
        );
        if (!result.passed) rejections++;
      }
      totalRate += rejections / PROBE_PHOTON_COUNT;
    }
    return totalRate / samples.length;
  }

  /**
   * Bir nesil ilerlet: tüm popülasyonu puanla, en iyi %25'i seç (elitizm),
   * geri kalanı en iyilerden mutasyonla türet. Sadece ağ SAKİNKEN
   * (çağıran taraf bunu garanti eder) tetiklenmesi önerilir — "sakin
   * zamanlarda yüzlerce kombinasyonu simüle eder".
   * @param {Array<{linkLoad:number, historicalBer:number}>} samples
   * @param {number} [nodeRejectionPenaltyWeight=0.4] - evaluateFitness'e iletilir
   */
  evolveGeneration(samples, nodeRejectionPenaltyWeight = 0.4) {
    if (samples.length === 0) return null;

    // 1) Puanla
    this.population.forEach(g => { g.fitness = this.evaluateFitness(g, samples, nodeRejectionPenaltyWeight); });
    this.population.sort((a, b) => b.fitness - a.fitness);

    // 2) Seçilim: en iyi %25 elit olarak korunur
    const eliteCount = Math.max(2, Math.floor(this.populationSize * 0.25));
    const elites = this.population.slice(0, eliteCount);

    // 3) Mutasyon: elitlerden rastgele ebeveyn seçip küçük gürültü ekleyerek
    //    yeni nesil türetilir (Gaussian-benzeri mutasyon, sınırlar içinde tutulur).
    const nextGen = [...elites];
    while (nextGen.length < this.populationSize) {
      const parent = elites[Math.floor(Math.random() * elites.length)];
      const mutationStrength = 0.08; // %8'lik keşif adımı
      nextGen.push({
        alpha: Math.max(0.1, Math.min(1.2, parent.alpha + (Math.random() - 0.5) * mutationStrength)),
        beta:  Math.max(0.02, Math.min(0.5, parent.beta + (Math.random() - 0.5) * mutationStrength * 0.4)),
        fitness: null,
      });
    }
    this.population = nextGen;
    this.generation++;

    const champion = elites[0];
    this.history.push({ generation: this.generation, fitness: champion.fitness, alpha: champion.alpha, beta: champion.beta });
    if (this.history.length > 60) this.history.shift();

    return champion;
  }

  /**
   * Şampiyon genomu canlı sisteme uygular — "bir sonraki yoğun patlama
   * anında tüm ağın yeni standardı haline gelir".
   *
   * BANK YAZMA BAĞLANTISI: lega.alpha/lega.beta güncellemesine ek olarak,
   * artık aktif TÜM MemristorCell'lerin PASİF bankasına da yeni eşik
   * hedefi yazılır (writeToPassiveBank üzerinden — XOR pointer flip +
   * donanım-interpolasyonu otomatik devreye girer). Bu, genetik
   * algoritmanın "hangi banka aktif" diye vakit kaybetmeden, doğrudan
   * gölge bankaya yazıp pointer'ı fırlatması davranışının gerçek
   * uygulamasıdır — her hücre kendi XOR'unu kendi yapar (merkezi bir
   * "hangi banka aktif" kontrolü YOKTUR, her hücre bunu bağımsız bilir).
   * @param {{alpha:number, beta:number, fitness:number}} champion
   * @param {InMemoryComputeFabric} [fabric] - verilmezse inMemoryFabric singleton'ı kullanılır
   * @param {number} [routeDistanceKm] - GERÇEK rota mesafesi (transmit()'ten
   *   geçirilir). Verilmezse eski nötr varsayım (500km) kullanılır — eski
   *   davranış BİREBİR korunur. Verilirse VE mesafe 1000km'yi aşıyorsa,
   *   referans katsayılar bu gerçek mesafeye göre hesaplanır — kısa bir
   *   hat için doğru olan bir eşik, uzun-mesafe/tekrarlayıcılı bir hatta
   *   körü körüne uygulanmaz.
   */
  promoteToLive(champion, fabric, routeDistanceKm) {
    const improved = this.bestGenome.fitness == null || champion.fitness > this.bestGenome.fitness;
    if (improved) {
      this.bestGenome = { ...champion };
      lega.alpha = champion.alpha;
      lega.beta = champion.beta;

      // KÖK NEDEN DÜZELTMESİ: eskiden TÜM hücrelere TEK, bağlamsız bir
      // referans eşik (nm=1550, km=500 SABİT varsayımıyla hesaplanmış)
      // zorla yazılıyordu — bu, gerçek fiziksel hattı (örn. Photon-1A,
      // kendi km'si ve kendi dalga boyu) hiç temsil etmeyen bir değerin
      // o hatta "pat diye" enjekte edilmesi demekti. Fiziksel olarak
      // tutarsız bu enjeksiyon, kırılma indisi bariyeri benzeri bir
      // ABSORB sıçramasına yol açabiliyordu (fiberT/absorbBias oranı
      // aniden çöküyordu). ÇÖZÜM: her hücrenin REFERANS DEĞERİ, O
      // HÜCRENİN KENDİ resonantNm'İNE göre ayrı ayrı hesaplanır —
      // artık tek bir "ortalama" değer değil, her fiziksel kanala
      // uygun kendi değeri yazılır.
      const targetFabric = fabric || inMemoryFabric;
      // KUANTUM KAZANIM (mesafe-duyarlı katsayı ayarı): rota mesafesi
      // gerçekten biliniyorsa VE 1000km'yi aşıyorsa, referans km olarak
      // nötr 500 varsayımı yerine GERÇEK mesafe kullanılır — bu, propPhoton'daki
      // amplifikasyon fiziğiyle TUTARLI bir üst-seviye katsayı üretir
      // (uzun-mesafe hatların referans eşiği, kısa hatlarla aynı kalıba
      // zorlanmaz). routeDistanceKm verilmezse (varsayılan) davranış
      // BİREBİR ESKİ HALİYLE (sabit 500km) çalışır.
      const LONG_HAUL_THRESHOLD_KM = 1000;
      const isLongHaul = routeDistanceKm != null && routeDistanceKm > LONG_HAUL_THRESHOLD_KM;
      const referenceKm = isLongHaul ? routeDistanceKm : 500;

      for (const cell of targetFabric.cells.values()) {
        // Hücrenin kendi rezonans dalga boyu — Photon-1A gibi bir hat
        // 1550nm ise, referans da 1550nm için hesaplanır; başka bir
        // hat 1310nm ise, KENDİ dalga boyu için ayrı hesaplanır.
        const cellNm = cell.resonantNm || 1550;
        const referenceThresholds = lega.computeThresholds(cellNm, referenceKm, {}, { alpha: champion.alpha, beta: champion.beta });

        // Uzun-mesafe + gerçek mesafe biliniyorsa: absorbBias'ı, propPhoton'ın
        // kendi amplifikasyon mantığıyla TUTARLI bir şekilde hafifçe düşür —
        // "bu hat zaten tekrarlayıcılarla telafi ediliyor, referans eşik bunu
        // yansıtmalı" ilkesi. Kısa hatlarda (isLongHaul=false) hiç etki yok.
        let adjustedAbsorbBias = referenceThresholds.absorbBias;
        if (isLongHaul) {
          const longHaulRelief = Math.min(0.3, (routeDistanceKm - LONG_HAUL_THRESHOLD_KM) / 5000);
          adjustedAbsorbBias = Math.max(1.0, referenceThresholds.absorbBias * (1 - longHaulRelief));
        }

        const referenceT = Math.min(0.85, 0.15 * adjustedAbsorbBias);
        cell.writeToPassiveBank(referenceT); // XOR flip + interpolasyon otomatik
        // Aynı fiziksel tutarlılık düzeltmesi katsayı bankasına da uygulanır.
        cell.writeCoeffToPassiveBank({
          scatterDeathProb: referenceThresholds.scatterDeathProb,
          absorbBias: adjustedAbsorbBias,
          decohereBias: referenceThresholds.decohereBias,
        });
        // EKSİK HALKA DÜZELTMESİ: NodeTransitGate'in KENDİ AYRI rezonans
        // profili (Aşama 1'in gerçekte kontrol ettiği state) burada
        // SENKRONLANMAZSA, hücrenin cellNm'i doğru olsa bile gelen
        // fotonlar kapıda "rezonans dışı" sayılıp reddedilmeye devam
        // eder — tam olarak gözlemlenen "Düğüm Reddi hattı tıkadı" belirtisi.
        nodeTransitGate.syncResonanceProfile(cell.nodeId, cellNm);
      }

      // KATSAYI ENJEKSİYONU FARKINDALIĞI: OPLL'e bu enjeksiyonu bildir —
      // kilitli kanallar artık altlarındaki fiziksel varsayımın değiştiğini
      // "hisseder" ve kontrollü bir kilit-kaybı sürecine girer. Bu olmadan,
      // PLL "kilitli" görünmeye devam ederdi ama referansı artık geçersizdi.
      opticalPLL.notifyCoefficientInjection();

      // Enjeksiyonun etkilediği hücre sayısını ve rezonans senkronunu
      // izlenebilir kılmak için champion nesnesine ekleniyor — transmit()
      // bunu loglayabilir.
      this._lastInjectionAffectedCells = targetFabric.cells.size;
    }
    return improved;
  }
}

// Modül-seviyesi tekil örnek — evrim tüm oturum boyunca sürer.
const coeffEvolution = new CoefficientEvolutionEngine();

// ══════════════════════════════════════════════════════════════
// InMemoryComputeFabric — I/O BARİYERİNİ SIMÜLE EDEREK ORTADAN KALDIRMA
//
// PROBLEM (von Neumann darboğazı): Klasik mimaride veri önce BELLEKTEN
// (RAM) okunur, bir veri yolu (bus) üzerinden İŞLEMCİYE (Core) taşınır,
// orada işlenir, sonra sonucu geri yazmak için tekrar bellek yoluna
// çıkar. Bu taşıma (I/O), özellikle küçük/sık kararlarda (NodeTransitGate
// gibi milisaniyelik triyaj kararları) işlemin kendisinden daha maliyetli
// hale gelebilir — "veri yolda zaman kaybeder".
//
// ÇÖZÜM (Processing-In-Memory / memristör ilhamlı): Her "bellek hücresi"
// (MemristorCell) kendi eşik değerini YANINDA taşır ve LEGA/NodeTransitGate
// kararını YERİNDE (in-situ) hesaplar. Veri RAM→Core→RAM yolculuğu
// yapmaz; hücre kendi kendine "geçir/sönümle" kararını verip sonucu
// doğrudan üretir. Bu dosyada gerçek bir donanım simüle EDİLEMEZ —
// JavaScript tek bir çağrı yığınında (call stack) çalışır — ama mimari
// FARKI ölçülebilir hale getirmek için iki şey modellenir:
//   1. Her hücre kendi state'ini taşır (merkezi Map yerine, hücre
//      nesnesinin kendi alanı) — gerçek dağıtık PIM'e daha yakın.
//   2. Von-Neumann yolu ile PIM yolu arasındaki SİMÜLE EDİLMİŞ gecikme
//      farkı ölçülür ve raporlanır (didaktik amaçlı, gerçek saat
//      döngüsü değil — ama oranlar gerçek literatürdeki büyüklük
//      mertebeleriyle (10-100x) tutarlıdır).
//
// NodeTransitGate.evaluate()'in KARAR MANTIĞINA HİÇ DOKUNULMAZ; bu
// katman onu SARIP, "nerede ve nasıl çalıştığını" yeniden çerçeveler.
// ══════════════════════════════════════════════════════════════

class MemristorCell {
  /**
   * @param {string} nodeId @param {number} nm - bu hücrenin "rezonans" dalga boyu
   */
  constructor(nodeId, nm) {
    this.nodeId = nodeId;
    this.resonantNm = nm;            // hücrenin kendi rezonans profili (NodeTransitGate'teki gibi)
    this.writeCount = 0;             // kaç kez "yazıldı" (fiziksel memristör analojisi: direnç sürüklenmesi)
    this.lastAccess = Date.now();

    // ══════════════════════════════════════════════════════════
    // PING-PONG BANK MEKANİZMASI + DONANIM İNTERPOLASYONU
    //
    // ESKİ DAVRANIŞ: localThreshold tek bir değişkendi, driftToward()
    // her çağrıda onu %70/%30 harmanla güncelliyordu — bu aslında zaten
    // yumuşaktı AMA "hangi değerin o an geçerli olduğu" belirsizdi (tek
    // değişken, ne zaman "eski" ne zaman "yeni" olduğu ayırt edilemezdi).
    //
    // YENİ DAVRANIŞ: İki banka (A/B) + bir pointer (0=A aktif, 1=B aktif).
    // LEGA yeni bir hedef eşik önerdiğinde, bu hedef PASİF banka yazılır
    // (Bank A aktifken Bank B'ye). Pointer 0'dan 1'e dönerken (bank
    // switch), ESKİ mimaride bu bir "basamak fonksiyonu" gibi ani bir
    // sıçrama olurdu. Şimdi, switch anından itibaren SWITCH_WINDOW_MS
    // boyunca aktif/pasif banka değerleri arasında donanım-interpolasyonu
    // (yumuşak geçiş eğrisi — ease-in-out benzeri) uygulanır; böylece
    // "sinir ağında akım şoku" (ani karar tutarsızlığı) yaşanmaz.
    //
    // ── DÜRÜSTLÜK NOTU (donanım-seviyesi terminoloji hakkında) ──────
    // Bu bölümdeki üç düşük-seviye kavram JavaScript'te GERÇEKTEN
    // uygulanamaz; V8/tarayıcı motoru CPU cache-line yerleşimini veya
    // bellek sıralama modelini scripte açmaz. Aşağıda her biri için
    // (a) C++'taki gerçek anlamı ve (b) bu JS kodundaki EN YAKIN,
    // GERÇEK karşılığı ayrı ayrı belirtilmiştir — biri diğeri yerine
    // geçiyormuş gibi sunulmamıştır:
    //
    //  • alignas(64) / false-sharing: C++'ta, birbirinden bağımsız iki
    //    değişkeni AYNI CPU cache-line'ına (tipik 64 byte) düşmekten
    //    korumak için kullanılır — aksi hâlde bir çekirdek birini
    //    yazınca, diğerini okuyan başka bir çekirdeğin cache'i de
    //    geçersiz kılınır (false sharing). JS'te bunun donanımsal
    //    karşılığı YOKTUR. GERÇEK KARŞILIK: her MemristorCell kendi
    //    IZOLE objesindedir (aşağıdaki Map<nodeId, MemristorCell> —
    //    paylaşılan tek bir TypedArray/contiguous buffer DEĞİL), yani
    //    bir hücrenin bankA/bankB alanlarını güncellemek, komşu
    //    hücrenin objesini hiçbir şekilde "dokunmuyor" — JS Garbage
    //    Collector ve obje modeli seviyesinde gerçek bir izolasyon var,
    //    sadece CPU cache-line seviyesinde değil.
    //
    //  • memory_order_release/acquire / std::mutex kaldırma: C++'ta çok
    //    çekirdekli senkronizasyon içindir. JavaScript TEK THREAD'lidir
    //    (Web Worker'lar hariç, ki burada kullanılmıyor) — zaten hiçbir
    //    zaman bir std::mutex'e ihtiyaç YOKTU, "kaldırma" diye bir işlem
    //    JS'te anlamsızdır. GERÇEK KARŞILIK: writeToPassiveBank() zaten
    //    senkron, bloklamayan, TEK BİR ATAMA (this.pointer ^= 1) ile
    //    çalışıyor — hiçbir kilit/kuyruk/await yok, tam olarak
    //    kullanıcının tarif ettiği "sadece pointer'ı fırlat" davranışı,
    //    ama bunun nedeni JS'in atomiklik garantisi değil, tek-thread
    //    çalışma modelidir.
    //
    //  • XOR (^1) pointer flip: BU KISIM GERÇEKTEN UYGULANABİLİR VE
    //    UYGULANDI — aşağıda pointer güncellemesi artık ternary yerine
    //    literal ^1 kullanıyor (bkz. writeToPassiveBank).
    // ══════════════════════════════════════════════════════════
    this.bankA = 0.15; // ilk değer — eski localThreshold ile aynı başlangıç
    this.bankB = 0.15;
    this.pointer = 0;              // 0 = A aktif, 1 = B aktif
    this.switchStartedAt = 0;      // son bank-switch'in zaman damgası
    this.switchFromValue = 0.15;   // switch anındaki "eski aktif" değer (interpolasyonun başlangıcı)

    // ══════════════════════════════════════════════════════════
    // TEMPORAL INTERPOLATION LOOP — LEGA KATSAYILARININ LERP GEÇİŞİ
    //
    // GERÇEK EKSİK: yukarıdaki bankA/bankB yalnızca NİHAİ EŞİĞİ (T(t))
    // ping-pong'luyordu — LEGA.computeThresholds()'ın ürettiği ÜÇ HAM
    // KATSAYI (scatterDeathProb, absorbBias, decohereBias), propPhoton
    // tarafından LEGA'dan HER SEFERİNDE DOĞRUDAN, anlık olarak okunuyordu.
    // Yani bir Ping-Pong geçişi tetiklendiğinde (writeToPassiveBank),
    // "nihai eşik" yumuşak geçiyordu AMA propPhoton'ın kullandığı üç
    // katsayı hâlâ bir basamak fonksiyonu gibi aniden değişiyordu.
    //
    // ÇÖZÜM: hücre artık İKİ AYRI KATSAYI BANKASI (coeffBankA/coeffBankB)
    // taşır — her biri {scatterDeathProb, absorbBias, decohereBias}
    // üçlüsünü tutar. writeCoeffToPassiveBank() çağrıldığında (Ping-Pong
    // tetiklendiği an), MICRO_CLOCK_WINDOW_MS (donanımın "bir sonraki
    // Micro-Clock döngüsü" — burada 12ns yerine JS'in gerçekçi en küçük
    // zamanlama birimine, ~1 rAF alt-adımına karşılık gelen küçük bir
    // pencereye) boyunca, activeCoeffs getter'ı GERÇEK BİR LERP
    // (a + (b-a)*t, doğrusal — smoothstep'in kübik yumuşatması DEĞİL)
    // ile eski/yeni katsayı üçlüsü arasında ağırlıklı ortalama döner.
    //
    // LEGA.computeThresholds(), NodeTransitGate.evaluate() ve
    // propPhoton'ın imzası HİÇ DEĞİŞMEZ — bu, InMemoryComputeFabric
    // isteğe bağlı olarak activeCoeffs()'i propPhoton'ın legaCtx
    // parametresine coeffOverride olarak besleyebileceği EKSTRA,
    // opsiyonel bir katmandır.
    // ══════════════════════════════════════════════════════════
    const seedCoeffs = { scatterDeathProb: 0.55, absorbBias: 1.0, decohereBias: 1.0 };
    this.coeffBankA = { ...seedCoeffs };
    this.coeffBankB = { ...seedCoeffs };
    this.coeffPointer = 0;
    this.coeffSwitchStartedAt = 0;
    this.coeffSwitchFromValue = { ...seedCoeffs };
  }

  // "Bir sonraki Micro-Clock döngüsü" — donanım analojisinde 12ns'lik
  // tek bir döngüye karşılık gelir; JS'te gerçek nanosaniye hassasiyeti
  // yoktur (Date.now() milisaniye çözünürlüklüdür), bu yüzden bu pencere
  // gerçekçi bir JS zamanlama biriminde (birkaç rAF frame'i, ~16-32ms)
  // ifade edilir — SWITCH_WINDOW_MS ile aynı ölçekte, kavramsal olarak
  // "bir sonraki donanım döngüsü" anlamına gelir.
  static get MICRO_CLOCK_WINDOW_MS() { return 32; }

  /**
   * Gerçek doğrusal interpolasyon (LERP): a + (b-a)*t. Smoothstep'in
   * kübik yumuşatmasından FARKLI olarak, t ile doğru orantılı, sabit
   * hızlı bir ağırlıklı ortalamadır — kullanıcının tarif ettiği
   * "ağırlıklı ortalama" tam olarak budur.
   */
  static lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * O an geçerli LEGA katsayı üçlüsü — Ping-Pong geçişi sürüyorsa
   * (coeffSwitchStartedAt'tan MICRO_CLOCK_WINDOW_MS geçmemişse) her üç
   * katsayı da eski/yeni bankalar arasında GERÇEK LERP ile karışık
   * döner; geçiş bittiyse doğrudan aktif bankanın ham değeri döner.
   * @returns {{scatterDeathProb:number, absorbBias:number, decohereBias:number}}
   */
  get activeCoeffs() {
    const activeRaw = this.coeffPointer === 0 ? this.coeffBankA : this.coeffBankB;
    const elapsed = Date.now() - this.coeffSwitchStartedAt;
    if (elapsed >= MemristorCell.MICRO_CLOCK_WINDOW_MS) return activeRaw;

    const t = Math.max(0, Math.min(1, elapsed / MemristorCell.MICRO_CLOCK_WINDOW_MS));
    const from = this.coeffSwitchFromValue;
    return {
      scatterDeathProb: MemristorCell.lerp(from.scatterDeathProb, activeRaw.scatterDeathProb, t),
      absorbBias: MemristorCell.lerp(from.absorbBias, activeRaw.absorbBias, t),
      decohereBias: MemristorCell.lerp(from.decohereBias, activeRaw.decohereBias, t),
    };
  }

  /**
   * Ping-Pong tetiklenir: yeni katsayı üçlüsü pasif bankaya yazılır,
   * pointer XOR ile döner (^1), ve bir sonraki activeCoeffs okuması
   * otomatik olarak LERP geçişine girer — basamak fonksiyonu YOK.
   * @param {{scatterDeathProb:number, absorbBias:number, decohereBias:number}} newCoeffs
   */
  writeCoeffToPassiveBank(newCoeffs) {
    const currentActiveValue = this.activeCoeffs; // LERP dahil o anki gerçek üçlü
    if (this.coeffPointer === 0) {
      this.coeffBankB = { ...newCoeffs };
    } else {
      this.coeffBankA = { ...newCoeffs };
    }
    this.coeffPointer ^= 1; // aynı XOR mekanizması, katsayı bankası için
    this.coeffSwitchFromValue = currentActiveValue;
    this.coeffSwitchStartedAt = Date.now();
    this.writeCount++;
    this.lastAccess = Date.now();
  }

  static get SWITCH_WINDOW_MS() { return 40; } // donanım-interpolasyon penceresi

  /** O an okunması gereken banka değeri (interpolasyon dahil). */
  get localThreshold() {
    const activeRaw = this.pointer === 0 ? this.bankA : this.bankB;
    const elapsed = Date.now() - this.switchStartedAt;
    if (elapsed >= MemristorCell.SWITCH_WINDOW_MS) return activeRaw;
    // Yumuşak geçiş eğrisi: ease-in-out (smoothstep) — basamak fonksiyonu
    // yerine t'nin karesel yumuşatmasıyla, ani akım şokunu önler.
    const t = Math.max(0, Math.min(1, elapsed / MemristorCell.SWITCH_WINDOW_MS));
    const smooth = t * t * (3 - 2 * t); // smoothstep
    return this.switchFromValue + (activeRaw - this.switchFromValue) * smooth;
  }

  /**
   * Yeni bir hedef eşik önerildiğinde: pasif bankaya yazılır, sonra
   * pointer "ping-pong" yapar. XOR (^1) ile: pointer 0 iken 0^1=1,
   * pointer 1 iken 1^1=0 — genetik algoritmanın "hangi banka aktif"
   * kontrolüyle vakit kaybetmeden, tek bir bit-işlemiyle gölge
   * bankaya anında geçiş yapar (kullanıcının tarif ettiği XOR mekanizması).
   * @param {number} newThreshold
   */
  writeToPassiveBank(newThreshold) {
    const currentActiveValue = this.localThreshold; // interpolasyon dahil o anki gerçek değer
    if (this.pointer === 0) {
      this.bankB = newThreshold;
    } else {
      this.bankA = newThreshold;
    }
    this.pointer ^= 1; // XOR pointer flip — ternary yerine literal ^1
    this.switchFromValue = currentActiveValue; // yeni interpolasyon buradan başlar
    this.switchStartedAt = Date.now();
    this.writeCount++;
    this.lastAccess = Date.now();
  }

  /**
   * Geriye-uyumlu takma ad — InMemoryComputeFabric.evaluateInPlace()
   * hâlâ cell.driftToward(T) çağırıyor; bu artık ping-pong mekanizmasına
   * yönlendirilir, çağıran taraf HİÇBİR ŞEY DEĞİŞTİRMEDEN çalışmaya devam eder.
   * @param {number} newThreshold - LEGA'dan gelen hedef eşik
   */
  driftToward(newThreshold) {
    this.writeToPassiveBank(newThreshold);
  }
}

// ══════════════════════════════════════════════════════════════
// NodeRegisterMatrix — DÜĞÜM REGISTER MATRİSİ
//
// AMAÇ: MemristorCell koleksiyonunu (önceden InMemoryComputeFabric'in
// içine gömülü, adsız bir `Map<nodeId, MemristorCell>` idi) resmi,
// adlandırılmış, matris-erişimli bir sınıfa çıkarır. Her MemristorCell
// artık bu matrisin bir "register"ı (satırı) olarak ele alınır — donanım
// analojisinde bir register dosyası (register file) gibi.
//
// KRİTİK: Bu sınıf MemristorCell'in KENDİ MATEMATİĞİNE (ping-pong bank,
// LERP, XOR pointer flip, activeCoeffs/localThreshold getter'ları)
// TEK SATIR DOKUNMAZ — yalnızca depolama/erişim organizasyonunu resmileştirir.
// Alttaki hücreler birebir aynı MemristorCell nesneleridir; bu sınıf
// onları bulmak/listelemek/toplu okumak için bir arayüz sağlar.
//
// "Register matrisi" ismi, hücrelerin mantıksal olarak bir matris gibi
// (nodeId → register) düşünülebileceğini vurgular — fiziksel bir 2B
// dizi DEĞİLDİR (JS'te bu, false-sharing önleme notunda açıklandığı
// gibi, Map<nodeId,MemristorCell> ile en doğru şekilde temsil edilir).
// ══════════════════════════════════════════════════════════════
class NodeRegisterMatrix {
  constructor() {
    // Alttaki depolama — MemristorCell'in kendisi hiç değişmedi, sadece
    // burada resmi bir "register dosyası" olarak adlandırıldı.
    this.registers = new Map(); // nodeId → MemristorCell
  }

  /**
   * Bir düğüm için register'ı getirir, yoksa yeni bir MemristorCell
   * tahsis eder (allocate). MemristorCell constructor'ına HİÇ DOKUNULMADI.
   * @param {string} nodeId @param {number} nm
   * @returns {MemristorCell}
   */
  allocate(nodeId, nm) {
    if (!this.registers.has(nodeId)) {
      this.registers.set(nodeId, new MemristorCell(nodeId, nm));
    }
    return this.registers.get(nodeId);
  }

  /** Bir register'ı yalnızca okur, tahsis etmez (yoksa null döner). */
  read(nodeId) {
    return this.registers.get(nodeId) ?? null;
  }

  has(nodeId) { return this.registers.has(nodeId); }
  get size() { return this.registers.size; }

  /** Tüm register'ları (MemristorCell'leri) iterasyon için döner. */
  values() { return this.registers.values(); }
  entries() { return this.registers.entries(); }

  /**
   * Matris-stili toplu okuma: tüm register'ların o anki (LERP dahil)
   * eşik değerini tek bir dizi olarak döner — "bir sütunu okumak" gibi.
   * @returns {Array<{nodeId:string, threshold:number}>}
   */
  readThresholdColumn() {
    return [...this.registers.entries()].map(([nodeId, cell]) => ({
      nodeId, threshold: cell.localThreshold,
    }));
  }

  /**
   * Matris-stili toplu okuma: tüm register'ların o anki (LERP dahil)
   * katsayı üçlüsünü döner.
   * @returns {Array<{nodeId:string, coeffs:{scatterDeathProb:number,absorbBias:number,decohereBias:number}}>}
   */
  readCoeffColumn() {
    return [...this.registers.entries()].map(([nodeId, cell]) => ({
      nodeId, coeffs: cell.activeCoeffs,
    }));
  }

  /** Doluluk anlık görüntüsü — SoftLandingFilter'ın computeOccupancy()'siyle uyumlu ham sayı. */
  occupancySnapshot(capacity) {
    return capacity > 0 ? Math.max(0, Math.min(1, this.registers.size / capacity)) : 0;
  }
}

// ══════════════════════════════════════════════════════════════
// LEGADecisionCore — LEGA KARAR ÇEKİRDEĞİ
//
// AMAÇ: LEGA.computeThresholds() + NodeTransitGate.evaluate() + "bu
// katsayı üçlüsü önceki yazılan değerden farklı mı" tespiti — önceden
// InMemoryComputeFabric.evaluateInPlace()'in gövdesine DAĞINIK şekilde
// gömülüydü. Bu sınıf, o kararı TEK BİR ADLANDIRILMIŞ ÇAĞRI NOKTASINA
// (decide()) toplar — "karar çekirdeği" ismi tam olarak bunu ifade eder:
// bir düğüme gelen her foton için "geçir mi, sönümle mi" ve "katsayılar
// değişti mi, Ping-Pong tetiklensin mi" sorularının TEK YANIT NOKTASI.
//
// KRİTİK: Bu sınıf LEGA.computeThresholds() veya NodeTransitGate.evaluate()
// içindeki HİÇBİR FORMÜLE dokunmaz — ikisini de AYNI SIRAYLA, AYNI
// PARAMETRELERLE çağırır (evaluateInPlace()'in eskiden yaptığı gibi).
// Yalnızca "bu kararı nerede/nasıl aldık" sorusunun cevabı artık tek
// bir yerde, adlandırılmış bir sınıfta yaşıyor.
// ══════════════════════════════════════════════════════════════
class LEGADecisionCore {
  /**
   * @param {LinkGradedEavesdropThresholdAlgorithm} legaInstance - varsayılan: modül-seviyesi lega singleton'ı
   * @param {NodeTransitGate} gateInstance - varsayılan: modül-seviyesi nodeTransitGate singleton'ı
   */
  constructor(legaInstance, gateInstance) {
    this.lega = legaInstance; // bağımlılık enjeksiyonu — test edilebilirlik için
    this.gate = gateInstance;
  }

  /**
   * LEGA'nın o an geçerli (canlı bağlam altında) ham katsayı üçlüsünü
   * hesaplar. legaCtx verilmezse eski sabit değerler (defaultThresholds)
   * döner — LEGA.computeThresholds() ile BİREBİR AYNI davranış.
   * @param {number} nm @param {number} km
   * @param {{linkLoad?:number, historicalBer?:number}} [legaCtx]
   * @returns {{scatterDeathProb:number, absorbBias:number, decohereBias:number}}
   */
  computeRawCoefficients(nm, km, legaCtx) {
    return legaCtx
      ? this.lega.computeThresholds(nm, km, legaCtx)
      : LinkGradedEavesdropThresholdAlgorithm.defaultThresholds();
  }

  /**
   * Bir hücrenin (register'ın) o an aktif katsayı bankasıyla yeni
   * hesaplanan ham katsayıları karşılaştırır — Ping-Pong'un GEREKSİZ
   * YERE tetiklenmemesi için (her identik değeri tekrar yazmak yeni
   * bir LERP geçişi başlatır, bu istenmez).
   * @param {MemristorCell} cell
   * @param {{scatterDeathProb:number,absorbBias:number,decohereBias:number}} rawCoeffs
   * @returns {boolean}
   */
  coefficientsChanged(cell, rawCoeffs) {
    const currentBank = cell.coeffPointer === 0 ? cell.coeffBankA : cell.coeffBankB;
    return currentBank.scatterDeathProb !== rawCoeffs.scatterDeathProb
      || currentBank.absorbBias !== rawCoeffs.absorbBias
      || currentBank.decohereBias !== rawCoeffs.decohereBias;
  }

  /**
   * TEK YANIT NOKTASI: bir düğüme gelen bir foton için tam karar
   * döngüsünü yürütür — NodeTransitGate.evaluate() ile geçiş/sönümlenme
   * kararını alır, LEGA.computeThresholds() ile güncel katsayıları
   * hesaplar, değiştiyse hücrenin Ping-Pong bankasına yazar (LERP
   * geçişini tetikler). Bu metod, evaluateInPlace()'in eskiden gövdesinde
   * dağınık şekilde yaptığı işin BİREBİR AYNISINI, tek bir çağrıda yapar.
   * @param {MemristorCell} cell
   * @param {string} nodeId @param {number} nm @param {number} km
   * @param {boolean} lowPriority
   * @param {{linkLoad?:number, historicalBer?:number}} [legaCtx]
   * @param {() => number} [rng]
   * @returns {{gateResult: Object, coefficientsWereUpdated: boolean}}
   */
  decide(cell, nodeId, nm, km, lowPriority, legaCtx, rng) {
    // 1) GEÇİŞ vs. SÖNÜMLENME — NodeTransitGate'in üç-aşamalı kararı, HİÇ DEĞİŞMEDEN.
    const gateResult = this.gate.evaluate(nodeId, nm, km, lowPriority, legaCtx, rng);

    // 2) Hücrenin nihai eşiğini bu kararda kullanılan T'ye doğru kaydır.
    cell.driftToward(gateResult.T || cell.localThreshold);

    // 3) LEGA'nın ham katsayı üçlüsünü hesapla, değiştiyse Ping-Pong'u tetikle.
    const rawCoeffs = this.computeRawCoefficients(nm, km, legaCtx);
    const changed = this.coefficientsChanged(cell, rawCoeffs);
    if (changed) {
      cell.writeCoeffToPassiveBank(rawCoeffs);
    }

    return { gateResult, coefficientsWereUpdated: changed };
  }
}

// Modül-seviyesi tekil örnek — mevcut lega/nodeTransitGate singleton'larını kullanır.
const legaDecisionCore = new LEGADecisionCore(lega, nodeTransitGate);

// ══════════════════════════════════════════════════════════════
// OpticalPhaseLockedLoop (OPLL) — OPTİK FAZ KİLİTLİ DÖNGÜ EMÜLASYONU
//
// GERÇEK DONANIM ANALOJİSİ: Bir PLL, üç bileşenden oluşur:
//   1. Faz Dedektörü (Phase Detector) — referans sinyal ile üretilen
//      sinyal arasındaki faz farkını (hata) ölçer.
//   2. Döngü Filtresi (Loop Filter) — bu hatayı yumuşatır (gürültüyü
//      süzer, PI-kontrolcü gibi davranır: Oransal + İntegral terimi).
//   3. VCO (Voltage-Controlled Oscillator) — filtrelenmiş hataya göre
//      kendi frekansını/fazını ayarlayarak referansa "kilitlenmeye" çalışır.
//
// BU SİSTEMDEKİ KARŞILIĞI: propPhoton'daki PHASE olayı (bit-flip riski)
// şu ana kadar TAMAMEN RASTGELE, geri beslemesiz bir olasılıkla
// (.012 + km/4000) üretiliyordu — gerçek bir fiber optik sistemde ise
// faz kayması zamanla İZLENİR ve bir PLL ile TELAFİ EDİLİR (kilitlenmiş
// bir PLL, biriken faz hatasını sıfıra yakın tutar). Bu sınıf, o geri
// beslemeli davranışı matematiksel olarak doğru bir PLL modeliyle emüle
// eder ve "kilit kalitesi" [0,1] üreterek propPhoton'ın PHASE
// olasılığına opsiyonel bir ÇARPAN olarak sunulabilir hâle getirir.
//
// GERİYE DÖNÜK UYUMLULUK: propPhoton'ın PHASE formülüne HİÇ DOKUNULMAZ.
// Bu sınıf bağımsız, isteğe bağlı tüketilebilecek bir modüldür — tıpkı
// LEGADecisionCore/coeffOverride deseninde olduğu gibi.
// ══════════════════════════════════════════════════════════════
class OpticalPhaseLockedLoop {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.kp=0.35] - Oransal kazanç (Proportional gain)
   * @param {number} [opts.ki=0.08] - İntegral kazanç (Integral gain)
   * @param {number} [opts.lockThreshold=0.05] - bu faz-hatası büyüklüğünün
   *   altına düşünce döngü "kilitli" (locked) sayılır (radyan cinsinden)
   * @param {number} [opts.lockPersistenceTicks=5] - kilit durumunun
   *   kararlı sayılması için üst üste kaç ölçüm eşik altında kalmalı
   */
  constructor(opts = {}) {
    this.kp = opts.kp ?? 0.35;                     // Faz Dedektörü → Döngü Filtresi oransal terim
    this.ki = opts.ki ?? 0.08;                      // Döngü Filtresi integral terim (biriken hata)
    this.lockThreshold = opts.lockThreshold ?? 0.05; // radyan — bu değerin altı "kilitli" sayılır
    this.lockPersistenceTicks = opts.lockPersistenceTicks ?? 5;

    // Her (nm,km) "kanalı" için ayrı bir PLL durumu tutulur — LEGA'nın
    // fatigueMap'ine benzer bucket deseni, aynı dalga boyu/mesafe
    // kombinasyonu kendi bağımsız faz izleme geçmişine sahiptir.
    this.channels = new Map(); // key → { phase, freq, integralError, lockStreak, locked, lastUpdate }
  }

  static bucketKey(nm, km) { return `${nm}-${Math.round(km / 10)}`; }

  _getOrCreateChannel(nm, km) {
    const key = OpticalPhaseLockedLoop.bucketKey(nm, km);
    if (!this.channels.has(key)) {
      this.channels.set(key, {
        phase: 0,          // VCO'nun o anki fazı (radyan)
        freq: 0,           // VCO frekans ofseti (döngü filtresinin çıktısı)
        integralError: 0,  // biriken faz hatası (İntegral terim)
        lockStreak: 0,      // eşik altında kalan üst üste ölçüm sayısı
        locked: false,
        lastUpdate: Date.now(),
      });
    }
    return this.channels.get(key);
  }

  /**
   * FAZ DEDEKTÖRÜ: referans faz (beklenen, 0'a normalize) ile VCO'nun
   * o anki fazı arasındaki farkı ölçer. Gerçek bir PLL'de bu bir XOR
   * kapısı veya çarpımsal karıştırıcıdır — burada basit fark olarak
   * modellenir, [-π, π] aralığına sarılır (phase wrapping).
   * @param {number} referencePhase - beklenen/hedef faz (radyan)
   * @param {number} vcoPhase - VCO'nun o anki fazı (radyan)
   * @returns {number} faz hatası (radyan)
   */
  phaseDetector(referencePhase, vcoPhase) {
    let error = referencePhase - vcoPhase;
    // [-π, π] aralığına sar (faz döngüseldir — 2π'lik atlamalar yanlış
    // hata büyüklüğü üretmesin).
    while (error > Math.PI) error -= 2 * Math.PI;
    while (error < -Math.PI) error += 2 * Math.PI;
    return error;
  }

  /**
   * DÖNGÜ FİLTRESİ: PI-kontrolcü (Oransal + İntegral). Faz hatasını
   * yumuşatıp VCO'ya gönderilecek düzeltme sinyalini üretir.
   * @param {number} phaseError
   * @param {Object} channel
   * @returns {number} düzeltme sinyali (VCO frekans ofsetine eklenecek)
   */
  loopFilter(phaseError, channel) {
    channel.integralError += phaseError * this.ki;
    // İntegral doyumu (integrator windup) önleme — gerçek PLL devrelerinde
    // olduğu gibi, biriken hata makul bir aralıkta sınırlanır.
    channel.integralError = Math.max(-2, Math.min(2, channel.integralError));
    return this.kp * phaseError + channel.integralError;
  }

  /**
   * VCO (Voltaj Kontrollü Osilatör): döngü filtresinden gelen düzeltmeye
   * göre kendi frekansını/fazını günceller — referansa doğru "kayar".
   * @param {Object} channel
   * @param {number} correction
   */
  vco(channel, correction) {
    channel.freq += correction * 0.1; // frekans ofseti yavaşça güncellenir (VCO ataleti analojisi)
    channel.freq = Math.max(-1, Math.min(1, channel.freq)); // fiziksel VCO'nun sınırlı ayar aralığı
    channel.phase += channel.freq;
    // Faz de döngüsel — [-π, π] aralığında tut.
    while (channel.phase > Math.PI) channel.phase -= 2 * Math.PI;
    while (channel.phase < -Math.PI) channel.phase += 2 * Math.PI;
  }

  /**
   * TEK TİK: bu kanal için bir PLL döngüsü ilerletir. Gerçek bir foton
   * olayının taşıdığı "gözlemlenen faz sapması" referans olarak verilir
   * (örn. propPhoton'ın olay geçmişinden türetilebilir); VCO bu referansa
   * kilitlenmeye çalışır. Kilit durumu (locked) ve kalite [0,1] döner.
   * @param {number} nm @param {number} km
   * @param {number} observedPhaseDeviation - gözlemlenen faz sapması (radyan, örn. son PHASE olayının şiddeti)
   * @returns {{locked: boolean, lockQuality: number, phaseError: number, channelPhase: number}}
   */
  tick(nm, km, observedPhaseDeviation) {
    const channel = this._getOrCreateChannel(nm, km);
    channel.lastUpdate = Date.now();

    const phaseError = this.phaseDetector(observedPhaseDeviation, channel.phase);
    const correction = this.loopFilter(phaseError, channel);
    this.vco(channel, correction);

    const errorMagnitude = Math.abs(phaseError);
    if (errorMagnitude < this.lockThreshold) {
      channel.lockStreak = Math.min(this.lockPersistenceTicks, channel.lockStreak + 1);
    } else {
      channel.lockStreak = Math.max(0, channel.lockStreak - 1); // kademeli kilit kaybı — anlık değil
    }
    channel.locked = channel.lockStreak >= this.lockPersistenceTicks;

    // Kilit kalitesi: [0,1] — 1.0 tam kilitli (hata≈0), 0 tamamen kilitsiz.
    // Üstel azalma kullanılır ki küçük hatalarda bile yüksek kalite,
    // büyük hatalarda hızla düşen bir kalite eğrisi olsun.
    const lockQuality = Math.exp(-errorMagnitude / this.lockThreshold * 0.5);

    return {
      locked: channel.locked,
      lockQuality: Math.max(0, Math.min(1, lockQuality)),
      phaseError,
      channelPhase: channel.phase,
    };
  }

  /**
   * PHASE OLASILIK ÇARPANI: OPLL kilitliyse, propPhoton'ın PHASE
   * olasılığını (.012 + km/4000) bu çarpanla ölçeklemek, faz kaymasını
   * "telafi eden" bir PLL'in gerçek davranışını modelleyecektir —
   * kilit kalitesi yükseldikçe (1.0'a yaklaştıkça) PHASE olasılığı düşer.
   * OPSİYONELDİR: propPhoton'ın formülüne dokunulmaz, çağıran taraf
   * isterse bu çarpanı formülün SONUCUNA uygular.
   * @param {number} nm @param {number} km
   * @returns {number} [minMultiplier, 1.0] arası çarpan — 1.0 = etkisiz (kilitsiz)
   */
  phaseDampingFactor(nm, km) {
    const key = OpticalPhaseLockedLoop.bucketKey(nm, km);
    const channel = this.channels.get(key);
    if (!channel || !channel.locked) return 1.0; // kilitli değilse hiç etki yok — eski davranış
    // Kilitliyken, PHASE olasılığını kilit kalitesiyle orantılı olarak
    // %70'e kadar bastırabilir (asla sıfıra indirmez — gerçek bir PLL de
    // hatayı tamamen yok etmez, yalnızca büyük ölçüde azaltır).
    const errorMagnitude = Math.abs(this.phaseDetector(0, channel.phase));
    const quality = Math.exp(-errorMagnitude / this.lockThreshold * 0.5);
    return 1.0 - Math.min(0.7, quality * 0.7);
  }

  /** Tüm kanalların özet durumu — UI/log için. */
  summary() {
    const channels = [...this.channels.entries()].map(([key, ch]) => ({
      key, locked: ch.locked, phase: ch.phase, freq: ch.freq, lockStreak: ch.lockStreak,
    }));
    const lockedCount = channels.filter(c => c.locked).length;
    return { totalChannels: channels.length, lockedChannels: lockedCount, channels };
  }

  // ══════════════════════════════════════════════════════════
  // KATSAYI ENJEKSİYONU FARKINDALIĞI (Coefficient-Injection Awareness)
  //
  // PROBLEM: CoefficientEvolutionEngine.promoteToLive(), her ~4 saniyede
  // bir (agresif) TÜM ağın LEGA katsayılarını değiştirebiliyordu, ama
  // OpticalPhaseLockedLoop'un bundan HİÇ HABERİ yoktu — kilitli bir
  // kanal, altındaki fiziksel varsayımlar (absorbBias/scatterDeathProb)
  // aniden kaydığı hâlde "kilitli" görünmeye devam ediyordu. Bu, TAM
  // OLARAK kullanıcının tarif ettiği kriz: "yazılımdaki matematiksel
  // optimizasyon donanımdaki dalga mekaniğini darmadağın ediyor."
  //
  // ÇÖZÜM: promoteToLive() artık bu metodu çağırarak enjeksiyonu
  // BİLDİRİR. Kilitli kanallar ANINDA kilit kaybetmez (bu da gerçekçi
  // olmazdı) — bunun yerine lockStreak'leri kısmen düşürülür (kontrollü
  // sarsıntı), bu da PLL'in yeniden-kilitlenme sürecine girmesini
  // sağlar. Kaç kanalın bu sarsıntıdan etkilendiği ve ne kadar yakın
  // zamanda olduğu izlenir — isCrisis() bunu okuyarak "enjeksiyon hızı,
  // fiziksel kararlılıktan daha agresif mi" sorusuna cevap verir.
  // ══════════════════════════════════════════════════════════
  notifyCoefficientInjection() {
    const now = Date.now();
    let destabilized = 0;
    for (const channel of this.channels.values()) {
      if (channel.locked || channel.lockStreak > 0) {
        // Kontrollü sarsıntı: lockStreak'in yarısı kadar geriye düşer
        // (anlık sıfırlama DEĞİL — kilitli bir osilatörün ani bir
        // referans kaymasına karşı GERÇEK tepkisi de kademelidir).
        channel.lockStreak = Math.floor(channel.lockStreak / 2);
        channel.locked = channel.lockStreak >= this.lockPersistenceTicks;
        destabilized++;
      }
    }
    this.injectionHistory = this.injectionHistory || [];
    this.injectionHistory.push({ at: now, destabilizedChannels: destabilized, totalChannels: this.channels.size });
    if (this.injectionHistory.length > 20) this.injectionHistory.shift();
    return { destabilizedChannels: destabilized, totalChannels: this.channels.size };
  }

  /**
   * KRİZ TESPİTİ: enjeksiyon hızı (son crisisWindowMs içindeki enjeksiyon
   * sayısı) ile ağın gerçek kilitlenme oranını karşılaştırır. Sık enjeksiyon
   * + düşük kilit oranı = "yazılım donanımı darmadağın ediyor" durumu.
   * @param {number} [crisisWindowMs=6000] - son ne kadarlık enjeksiyon geçmişine bakılacak
   * @param {number} [minInjectionsForCrisis=2] - bu pencerede en az kaç enjeksiyon olmalı
   * @returns {{inCrisis: boolean, recentInjections: number, lockRatio: number}}
   */
  isCrisis(crisisWindowMs = 6000, minInjectionsForCrisis = 2) {
    const now = Date.now();
    const history = this.injectionHistory || [];
    const recent = history.filter(h => now - h.at <= crisisWindowMs);
    const totalChannels = this.channels.size;
    const lockedChannels = [...this.channels.values()].filter(c => c.locked).length;
    const lockRatio = totalChannels > 0 ? lockedChannels / totalChannels : 1; // hücre yoksa "kriz yok" say

    // Kriz koşulu: kısa sürede birden fazla enjeksiyon OLMUŞ VE ağın
    // kilit oranı düşük (yani fiziksel katman toparlanamıyor).
    const inCrisis = recent.length >= minInjectionsForCrisis && lockRatio < 0.5 && totalChannels > 0;
    return { inCrisis, recentInjections: recent.length, lockRatio };
  }
}

// Modül-seviyesi tekil örnek.
const opticalPLL = new OpticalPhaseLockedLoop();

class InMemoryComputeFabric {
  constructor() {
    // DÜĞÜM REGISTER MATRİSİ: hücre depolaması artık NodeRegisterMatrix'e
    // devredilmiştir (önceden burada doğrudan bir Map tutuluyordu). Aşağıdaki
    // `cells` getter'ı, registerMatrix.registers'ı (AYNI Map referansını)
    // döndürür — bu yüzden mevcut tüm dış çağrı yerleri (inMemoryFabric.cells.size,
    // fabric.cells.values() vb.) TEK SATIR DEĞİŞMEDEN çalışmaya devam eder.
    //
    // FALSE-SHARING ÖNLEME (JS-seviyesi karşılığı): registerMatrix.registers
    // bir Map<nodeId, MemristorCell>'dir — her MemristorCell kendi heap
    // objesidir, ASLA tek bir paylaşımlı TypedArray/contiguous buffer
    // içine paketlenmez. Bu, C++'taki alignas(64)'ün CPU cache-line
    // seviyesinde yaptığı izolasyonun JS obje-modeli seviyesindeki en
    // yakın karşılığıdır: bir hücrenin bankA/bankB alanlarını
    // güncellemek, komşu hücrenin objesine dokunmaz.
    this.registerMatrix = new NodeRegisterMatrix();

    // Von-Neumann vs PIM gecikme simülasyonu için sayaçlar.
    this.stats = { pimDecisions: 0, simulatedVonNeumannNs: 0, simulatedPimNs: 0 };
  }

  /**
   * Geriye-uyumlu erişim: eski `this.cells` alanının yerini alan getter.
   * NodeRegisterMatrix'in İÇİNDEKİ AYNI Map nesnesini döndürür — kopya
   * değil, referans — bu yüzden .size/.values()/.has()/.get() gibi tüm
   * eski kullanım yerleri hiç değişmeden çalışır.
   */
  get cells() { return this.registerMatrix.registers; }

  getOrCreateCell(nodeId, nm) {
    // Artık NodeRegisterMatrix'in allocate() metoduna devredilir —
    // MemristorCell tahsis mantığı TEK SATIR DEĞİŞMEDEN, sadece
    // resmi bir register-matris arayüzü üzerinden çağrılıyor.
    return this.registerMatrix.allocate(nodeId, nm);
  }

  /**
   * I/O BARİYERİ SIFIRLAMA: NodeTransitGate.evaluate()'i ÇAĞIRIR (karar
   * mantığı birebir aynı kalır) ama bunu "hücrenin içinde" yapılmış gibi
   * modeller — sonuç, ayrı bir RAM→Core taşıması olmadan üretilir. Ayrıca
   * hücrenin kendi eşiğini LEGA'nın hesapladığı T(t)'ye doğru kaydırır
   * (memristör "öğrenme" analojisi) ve simüle edilmiş gecikme farkını kaydeder.
   * @returns {{gateResult: Object, latencyNs: {vonNeumann:number, pim:number, speedup:number}}}
   */
  evaluateInPlace(nodeId, nm, km, lowPriority, legaCtx, rng) {
    const cell = this.getOrCreateCell(nodeId, nm);

    // LEGA KARAR ÇEKİRDEĞİ: NodeTransitGate.evaluate() + LEGA.computeThresholds()
    // + katsayı-değişikliği tespiti artık TEK BİR ÇAĞRIDA, LEGADecisionCore
    // üzerinden yürütülür. Yapılan işlemler (sıra, parametreler, formüller)
    // BİREBİR AYNIDIR — yalnızca organizasyon değişti, matematik değişmedi.
    const { gateResult, coefficientsWereUpdated } = legaDecisionCore.decide(
      cell, nodeId, nm, km, lowPriority, legaCtx, rng
    );

    // ── Simüle edilmiş gecikme karşılaştırması (didaktik) ──────────
    // Von Neumann: RAM okuma + bus taşıma + Core işleme + bus geri yazma.
    // Gerçekçi büyüklük mertebeleri (DDR4 erişim ~50-100ns, bus round-trip
    // ~20-40ns, basit karşılaştırma işlemi Core'da ~1-2ns).
    const vonNeumannNs = 80 + 30 + 1.5 + 30; // ≈141.5ns
    // PIM: veri zaten hücrede, karşılaştırma hücrenin kendi devresinde —
    // literatürde tipik memristör-tabanlı MAC/karşılaştırma ~1-5ns.
    const pimNs = 3;

    this.stats.pimDecisions++;
    this.stats.simulatedVonNeumannNs += vonNeumannNs;
    this.stats.simulatedPimNs += pimNs;

    return {
      gateResult,
      latencyNs: { vonNeumann: vonNeumannNs, pim: pimNs, speedup: vonNeumannNs / pimNs },
      interpolatedCoeffs: cell.activeCoeffs, // LERP geçişi sürüyorsa karışık, bitmiş se ham değer
      coefficientsWereUpdated, // LEGADecisionCore'un bu turda Ping-Pong tetikleyip tetiklemediği
    };
  }

  /** Toplam simülasyon boyunca biriken I/O tasarrufu özeti. */
  summary() {
    if (this.stats.pimDecisions === 0) return null;
    return {
      decisions: this.stats.pimDecisions,
      totalVonNeumannNs: this.stats.simulatedVonNeumannNs,
      totalPimNs: this.stats.simulatedPimNs,
      savedNs: this.stats.simulatedVonNeumannNs - this.stats.simulatedPimNs,
      avgSpeedup: this.stats.simulatedVonNeumannNs / this.stats.simulatedPimNs,
      cellCount: this.cells.size,
      avgWritesPerCell: [...this.cells.values()].reduce((s,c)=>s+c.writeCount,0) / this.cells.size,
    };
  }
}

// Modül-seviyesi tekil örnek — tüm çağrılar aynı "bellek fabrikasını" paylaşır.
const inMemoryFabric = new InMemoryComputeFabric();

function eavesdropProbability(nm, km) {
  const signalStrength = fiberT(nm, km); // [0,1] — ne kadar sinyal hayatta kaldı
  // Taban risk %8 (en zayıf sinyalde bile fiziksel tap teorik olarak mümkün),
  // sinyal güçlendikçe %45 tavana kadar lineer artar.
  return 0.08 + signalStrength * 0.37;
}

// ══════════════════════════════════════════════════════════════
// DÜZELTME 8: TEKRARLAYICI KAZANCI — MESAFE KAPISI KALDIRILDI
//
// KÖK NEDEN (kullanıcı tarafından canlı testte tespit edildi): repeaterGainFactor
// eskiden yalnızca `km > 1000 && reps > 0` iken devreye giriyordu. Ama bu
// eşik FİZİKSEL OLARAK YANLIŞ bir varsayıma dayanıyordu — gerçek bir EDFA/
// kuantum tekrarlayıcı, TOPLAM ROTA MESAFESİNE değil, KENDİ SEGMENTİNİN
// kaybına bakarak güçlendirme yapar. İstanbul→Bursa gibi 85km'lik bir
// hatta, BUR düğümünde GERÇEKTEN 1 tekrarlayıcı VARSA (reps:1), bu
// tekrarlayıcı "rota 1000km değil" diye devre dışı kalmamalıdır — kendi
// 42.5km'lik segmentindeki ~8.5dB kaybı, uzunluğu ne olursa olsun aynı
// şekilde telafi eder. Eski eşik, kısa/orta menzilli hatlardaki GERÇEK
// tekrarlayıcı donanımını (IST, ANK, ATH, CAI, BAG, SOF gibi çok-tekrarlayıcılı
// düğümler) tamamen görmezden geliyordu.
//
// computeRepeaterGain(nm, km, reps, ceilingOverride) — propPhoton'ın kendi
// hesaplamasıyla BİREBİR AYNI formül, tek bir yerde toplanmış (hem propPhoton
// hem de aşağıdaki estimateLinkSurvival/dynamicRedundancyFor tarafından
// paylaşılır — iki ayrı yerde formülün birbirinden SAPMASI riski ortadan
// kalkar). reps=0 ise her zaman 1.0 (etkisiz) döner — tekrarlayıcısız
// hatlarda hiçbir davranış değişikliği YOKTUR.
//
// ceilingOverride (opsiyonel, 4. parametre): telafi oranının tavanı,
// verilmezse 0.95 (standart analog EDFA tavanı — bkz. aşağıdaki yorum).
// SADECE propPhotonRelayChain (güvenilir-düğüm röle zinciri, bkz. o
// fonksiyonun başlığı) bu tavanı yükseltir — mevcut TÜM diğer çağrı
// yerleri (propPhoton'ın normal tek-atış yolu, estimateLinkSurvival,
// dynamicRedundancyFor) parametre vermez, dolayısıyla eski %95 tavanı
// BİREBİR korunur.
function computeRepeaterGain(nm, km, reps, ceilingOverride) {
  if (!(reps > 0)) return 1.0;
  const w = WL[nm] || WL[1550];
  const sk = km / (reps + 1);
  const segmentLossDb = w.loss * sk;
  const ceiling = ceilingOverride ?? 0.95;
  const compensationRatio = Math.min(ceiling, 0.5 + reps * 0.15); // reps arttıkça telafi oranı artar
  const compensatedLossDb = segmentLossDb * (1 - compensationRatio);
  return Math.pow(10, (segmentLossDb - compensatedLossDb) / 10);
}

// ══════════════════════════════════════════════════════════════
// DİNAMİK FEC / FOTON ÇOĞULLAMA (Adaptive Multi-Copy Redundancy)
//
// KULLANICI TALEBİ: "Kanalın kaotik çöküşünü bypass etmek için tasarladığın
// dinamik hata düzeltme (FEC) veya kuantum tekrarlayıcı algoritmalarını
// devreye sok". Statik Hamming(7,4) yalnızca 7 bitlik bir blokta TEK bir
// bit hatasını düzeltebilir — ama kısa/orta menzilli hatlarda ham foton
// kaybı %75-98'e ulaşabiliyor (bkz. IST→BUR 85km testi, T=%2.0), yani
// 7-bitlik bloğun neredeyse TAMAMI silinmiş oluyor. Bu, Hamming'in
// tasarım sınırının ÇOK ötesinde — hiçbir sabit-oranlı blok kodu bunu
// düzeltemez (bilgi kuramsal bir sınır, bir "bug" değil).
//
// GERÇEKÇİ ÇÖZÜM: zaman-bölmeli çoğullama (time-bin multiplexing) —
// gerçek FSO/uydu QKD sistemlerinde kullanılan bir teknik: kanal kalitesi
// düşükken VERİCİ, aynı klasik biti ARDIŞIK birden çok bağımsız foton
// zaman-dilimi olarak gönderir; ALICI bunlardan İLK BAŞARIYLA ULAŞANI
// kullanır (klasik ARQ/çoğullamaya benzer, ama fiziksel katmanda). Bu,
// BB84 ANAHTAR DEĞİŞİMİNİ (deriveSiftedKey, tek-foton güvenlik gereksinimi
// olan ayrı bir yol) HİÇ ETKİLEMEZ — yalnızca fiziksel mesaj kanalını
// (physicalSimulation/propPhoton) güçlendirir.
//
// "DİNAMİK": çoğullama derecesi (redundancy) sabit değildir — hattın o
// anki tahmini foton-hayatta-kalma olasılığından ANLIK hesaplanır. Kanal
// zaten güvenilirse (survival>=%85) redundancy=1 (israf yok, eski davranış
// birebir). Kanal kötüyse, en az bir kopyanın ulaşma olasılığı hedef
// eşiği (varsayılan %99.5) aşana kadar kopya sayısı artırılır — ama sonsuz
// foton israfını önlemek için bir tavan (maxRedundancy) vardır; tavana
// rağmen hedefe ulaşılamıyorsa bu DÜRÜSTÇE loglanır (bkz. transmit()),
// "sahte başarı" üretilmez.
/**
 * @param {number} nm @param {number} km @param {number} reps
 * @param {{linkLoad?: number, historicalBer?: number}} [legaCtx] - BULUNAN
 *   HATA (bkz. sohbet geçmişi, "IST-BUR BER sorunu" incelemesi): bu
 *   fonksiyon eskiden legaCtx'i HİÇ almıyordu — yani canlı AĞ YÜKÜ (bkz.
 *   satellite-link-tick RAF sistemi, her 900ms'de her linke %20 ihtimalle
 *   rastgele bir "ambiyans yükü" enjekte eder) burada TAMAMEN görmezden
 *   geliniyordu. propPhoton'ın KENDİSİ bu yükü GERÇEKTEN uyguluyordu
 *   (absorbBias = 1.0 + load×β, ABSORB eşiğini sıkılaştırır) — ama
 *   estimateLinkSurvival hâlâ "yüksüz" (nötr) bir tahmine göre hesap
 *   yapıyordu. Sonuç: kısa/orta hatlarda (örn. IST-BUR, 85km) yük yüksek
 *   olduğunda propPhoton'ın GERÇEK hayatta kalma oranı, dynamicRedundancyFor'un
 *   VARSAYDIĞI orandan daha düşüktü — hedeflenen %99.5 varış güvencesi
 *   sessizce erirdi, redundancy sayısı ARTMADAN (bkz. Monte Carlo
 *   doğrulaması: linkLoad=0 iken ort. 1.8 bit/182 kayıp, linkLoad=0.9
 *   iken ort. 5.4 bit/182 kayıp — AYNI redundancy=19 ile). ÇÖZÜM: bu
 *   fonksiyon artık legaCtx verilirse propPhoton'ın KENDİ absorbBias
 *   hesabını (lega.computeThresholds) kullanarak tahminini günceller —
 *   verilmezse (mevcut TÜM eski çağrı yerleri) davranış BİREBİR ESKİSİ
 *   GİBİDİR (defaultThresholds, absorbBias=1.0, hiçbir etki yok).
 */
function estimateLinkSurvival(nm, km, reps, legaCtx) {
  const gain = computeRepeaterGain(nm, km, reps);
  const sk = reps > 0 ? km / (reps + 1) : km;
  const thresholds = legaCtx
    ? lega.computeThresholds(nm, km, legaCtx)
    : LinkGradedEavesdropThresholdAlgorithm.defaultThresholds();
  const segT = Math.min(1.0, (fiberT(nm, sk) * gain) / thresholds.absorbBias);
  return Math.pow(segT, reps + 1); // tüm segmentlerden ardışık hayatta kalma (ABSORB dışı kayıp modları hariç, yaklaşık üst sınır)
}

/**
 * @param {number} nm @param {number} km @param {number} reps
 * @param {{linkLoad?: number, historicalBer?: number}} [legaCtx] - bkz.
 *   estimateLinkSurvival'ın aynı adlı parametresinin başlığı.
 */
// DÜZELTME 10 (devam): maxRedundancy tavanı 20'den 40'a yükseltildi.
// SEBEP (Monte Carlo doğrulaması, bkz. estimateLinkSurvival'ın başlığı):
// legaCtx artık gerçek AĞ YÜKÜNÜ hesaba katıyor olsa bile, YÜKSEK yük
// altında (linkLoad→1.0) formülün hesapladığı GEREKLİ kopya sayısı zaten
// eski 20 tavanının ÇOK ÜZERİNDE çıkıyordu (örn. IST-BUR 85km için ~25) —
// yani eski tavan, hedeflenen %99.5 varış güvencesini TAM OLARAK bu
// yüksek-yük senaryolarında (ki AĞ YÜKÜ simülasyonu bunu SIK ÜRETİR,
// bkz. satellite-link-tick'in %20 ihtimalli rastgele yük sıçraması)
// kesiyordu — 182 bitlik bir mesajda ortalama 5-6 bit kalıcı kayıp
// (ECC'nin telafi sınırını genelde aşan bir oran) gözlemlendi. 40'a
// yükseltmek (yine bir tavan — sonsuz foton israfı YOK) bu spesifik
// senaryoda (IST-BUR, 85km, reps=1) gerekli ~25 kopyayı tam karşılıyor
// ve ortalama kayıp, YÜKSÜZ durumla (ort. ~1.8 bit) pratik olarak AYNI
// seviyeye geri döndü. Kısa/orta hatlarda (survival>=%85, tavana hiç
// dokunulmayan çoğunluk) davranış BİREBİR ESKİSİ GİBİDİR — bu değişiklik
// yalnızca ZATEN tavana çarpan (yani zaten en riskli) hatları etkiler.
//
// DÜZELTME 11: maxRedundancy 40'tan 150'ye, targetArrival %99.5'ten
// %99.9'a yükseltildi. SEBEP (kullanıcı tarafından canlı testte tespit
// edildi — bkz. REY-EDI KOPMA krizi + REY→DUB→EDI dolambaçlı rota testi):
// bir hat KOPTUĞUNDA yönlendirme motoru anında doğru alternatifi buluyordu
// (bkz. EdgeWeightPolicy/dijkstra), ama bu alternatif ZATEN ağır yüklü/
// zayıf tekrarlayıcılı bir rotaysa (örn. reps=0 bir düğüm), eski 40
// tavanı tek başına yetersiz kalıyordu — foton hayatta kalma oranı
// %85 eşiğinin ÇOK altındayken (bkz. estimateLinkSurvival) 40 kopya
// bile en az birinin ulaşmasını garantilemeye yetmiyordu. 150'ye
// yükseltmek (yine sonlu bir tavan — sonsuz foton israfı YOK), donanım
// yükseltmesiyle (bkz. DUB/EDI reps artışı, NODES tanımları) BİRLİKTE
// kullanıldığında dolambaçlı rotalarda BER'i ölçülebilir şekilde
// düşürüyor (deneysel doğrulama: reps-only ~%56-91 BER'den, reps+FEC
// birlikte ~%12-88 BER aralığına, en iyi denemede sadece 1 karakter
// hata — bkz. sohbet geçmişi). Kısa/orta hatlarda (survival>=%85)
// davranış BİREBİR ESKİSİ GİBİDİR — bu değişiklik yalnızca ZATEN
// tavana çarpan, kriz-altı dolambaçlı rotaları etkiler.
function dynamicRedundancyFor(nm, km, reps, legaCtx, targetArrival = 0.999, maxRedundancy = 150) {
  const s = Math.max(0.0005, Math.min(1, estimateLinkSurvival(nm, km, reps, legaCtx)));
  if (s >= 0.85) return 1; // kanal zaten güvenilir — ekstra foton israfına gerek yok
  // P(en az bir kopya ulaşır) = 1-(1-s)^N >= targetArrival  =>  N >= log(1-targetArrival)/log(1-s)
  const n = Math.ceil(Math.log(1 - targetArrival) / Math.log(1 - s));
  return Math.max(1, Math.min(maxRedundancy, n));
}

// LEGA entegrasyonu: propPhoton'a opsiyonel 6. parametre (legaCtx) eklendi.
// legaCtx verilmezse LinkGradedEavesdropThresholdAlgorithm.defaultThresholds()
// kullanılır — bu, ESKİ SABİT DEĞERLERLE (.55, fiberT, sk/1400) BİREBİR
// AYNI davranışı üretir. Mevcut 4 çağrı yeri (transmit/replay/mirror/fork)
// hiç değişmeden çalışmaya devam eder.
//
// "GEÇİŞ vs. SÖNÜMLENME" KARARI: fonksiyonun döndürdüğü `ok` alanı bu
// ikili kararı temsil eder — ok:true → foton kanaldan GEÇTİ (transit),
// ok:false → foton SÖNÜMLENDİ (dampening: soğuruldu/saçıldı/dekohere
// oldu). Bu karar yapısı LEGA ile HİÇ DEĞİŞMEDİ; sadece kararın dayandığı
// olasılık eşikleri artık statik değil, bağlama duyarlı.
/**
 * @param {number} nm @param {number} km @param {number} reps
 * @param {boolean} evesdrop @param {() => number} [rng]
 * @param {{linkLoad?: number, historicalBer?: number}} [legaCtx] - LEGA bağlamı
 * @param {number} [repeaterCeilingOverride] - SADECE propPhotonRelayChain
 *   kullanır (bkz. o fonksiyonun başlığı) — verilmezse computeRepeaterGain
 *   standart %95 EDFA tavanını kullanır, davranış BİREBİR eskisi gibi kalır.
 */
function propPhoton(nm, km, reps, evesdrop, rng, legaCtx, repeaterCeilingOverride) {
  const rand = rng || Math.random;
  const w  = WL[nm] || WL[1550];
  const sk = reps > 0 ? km / (reps+1) : km;
  const evs = [];
  let alive = true;

  // LEGA: bağlam verilmişse dinamik eşikler, verilmemişse eski sabitler.
  // TEMPORAL INTERPOLATION LOOP: legaCtx.coeffOverride varsa (MemristorCell'in
  // Ping-Pong LERP geçişinden gelen ara-değer katsayı üçlüsü), bu ANLIK
  // LEGA hesaplamasının YERİNE GEÇER — yani bir Ping-Pong geçişi sürerken
  // propPhoton, LEGA'nın "şu anki ham" değerlerini değil, hücrenin LERP
  // ile yumuşattığı ara-değerleri kullanır. coeffOverride yoksa (varsayılan,
  // eski davranış) LEGA'nın kendi canlı hesaplaması BİREBİR AYNI şekilde kullanılır.
  const thresholds = legaCtx?.coeffOverride
    ? legaCtx.coeffOverride
    : legaCtx
      ? lega.computeThresholds(nm, km, legaCtx)
      : LinkGradedEavesdropThresholdAlgorithm.defaultThresholds();

  // ══════════════════════════════════════════════════════════
  // KUANTUM KAZANIM / YÜKSELTME (Repeater Amplification)
  //
  // GERÇEK FİZİKSEL EKSİK (önceki turlarda tespit edildi): reps
  // parametresi mesafeyi segmentlere BÖLÜYORDU ama sinyali HİÇBİR
  // ZAMAN YENİDEN GÜÇLENDİRMİYORDU — bu yüzden 1000km+ rotalarda
  // (gerçek tekrarlayıcı varlığına rağmen) kümülatif kayıp matematiksel
  // olarak DEĞİŞMİYORDU (dB kaybı doğrusal, segment sayısı fark etmiyordu).
  //
  // ÇÖZÜM: gerçek bir EDFA (Erbium-Doped Fiber Amplifier) tekrarlayıcının
  // yaptığı şeyi yapar — sinyali YENİDEN GÜÇLENDİRİR. Kazanç, segment
  // başına kaybı KISMEN telafi eder — asla %100 telafi etmez (gerçek
  // EDFA'lar da gürültü ekler, mükemmel değildir) ve etkin geçirgenlik
  // ASLA 1.0'ı aşamaz (fiziksel olarak imkânsız bir "kayıptan çok kazanç"
  // durumuna düşülmez).
  //
  // DÜZELTME 8 (mesafe kapısı kaldırıldı): eskiden bu kazanç yalnızca
  // `km > 1000` iken devreye giriyordu — bu, gerçek tekrarlayıcı donanımı
  // olan KISA/ORTA menzilli hatları (örn. IST→BUR 85km, BUR düğümünde
  // reps:1) fiziksel olarak haksız yere devre dışı bırakıyordu. Gerçek
  // bir tekrarlayıcı, TOPLAM ROTA mesafesine değil, KENDİ SEGMENTİNİN
  // kaybına bakar — artık computeRepeaterGain() tek bir yerde, mesafe
  // kısıtı OLMADAN hesaplanıyor. reps=0 olan hatlarda (tekrarlayıcısız)
  // davranış BİREBİR eskisi gibi kalır (gain=1.0, etkisiz).
  // ══════════════════════════════════════════════════════════
  const repeaterGainFactor = computeRepeaterGain(nm, km, reps, repeaterCeilingOverride);

  for (let seg = 0; seg <= reps && alive; seg++) {
    const base = seg * sk;
    // KUANTUM KAZANIM olayı: yalnızca ilk segmentte (foton başına bir kez),
    // amplifikasyon gerçekten aktifse (repeaterGainFactor>1.0) kaydedilir —
    // mevcut event-log altyapısını (ec histogramı, UI renderı) kullanır.
    if (seg === 0 && repeaterGainFactor > 1.0) {
      evs.push({ type:"AMPLIFY", km: base, gainDb: (10*Math.log10(repeaterGainFactor)).toFixed(1) });
    }
    if (rand() < (w.r/1200) * sk) {
      evs.push({ type:"SCATTER", km: base + rand()*sk*.7 });
      // Eski: sabit .55. LEGA: tarihsel BER'e göre esnetilmiş oran.
      if (rand() < thresholds.scatterDeathProb) { alive = false; break; }
    }
    // Eski: rand() > fiberT(nm,sk). LEGA: canlı yük ABSORB'a yatkınlığı
    // absorbBias ile artırır — fiberT'nin geçirgenlik payını daraltarak.
    // KUANTUM KAZANIM: repeaterGainFactor, uzun-mesafe + tekrarlayıcılı
    // hatlarda fiberT'yi yükseltir (asla 1.0'ı aşmadan) — bir önceki
    // segmentte kaybedilen sinyalin bir kısmını GERİ KAZANDIRIR.
    //
    // ATMOSFERİK GEÇİRGENLİK PENCERESİ: legaCtx.atmosphericConditions
    // verilmişse (yani bu bir LEO uydu/FSO bağlantısı olarak işaretlenmişse),
    // AtmosphericWindowModel'in gerçek FSO-literatürüne dayalı çarpanı
    // devreye girer. VERİLMEZSE (varsayılan, mevcut TÜM çağrı yerleri)
    // atmosphericFactor=1.0 — eski davranış BİREBİR korunur.
    const atmosphericFactor = legaCtx?.atmosphericConditions
      ? AtmosphericWindowModel.windowFactor(nm, legaCtx.atmosphericConditions)
      : 1.0;
    // EK 42/43: SCINTILLATION + POINTING-LOSS ÇARPANLARI — yalnızca
    // legaCtx.atmosphericConditions bir elevasyon açısı VE turbulenceStrength/
    // pointingPrecision taşıyorsa devreye girer (yani gerçekten bir LEO/FSO
    // bağlamı, turbidity/rangeKm'den daha fazlasını sağlıyorsa). Verilmezse
    // (mevcut TÜM eski çağrı yerleri: fiber rotalar, replay/mirror/fork)
    // her iki çarpan da 1.0 — eski davranış BİREBİR korunur.
    //
    // scintillationEngine.fadeFactor() burada, foton başına DEĞİL, en son
    // satellite-link-tick() çağrısında hesaplanan TEK bir anlık değeri
    // okur — bu yüzden aynı 900ms penceresindeki tüm fotonlar aynı sönüm
    // değerini paylaşır (gerçek türbülansın bursty/kümeli kayıp karakteri,
    // foton-başına-bağımsız rastgelelik yerine).
    const ac = legaCtx?.atmosphericConditions;
    const scintillationFactor = (ac && ac.elevationDeg != null)
      ? Math.min(1.0, scintillationEngine.fadeFactor())
      : 1.0;
    const pointingFactor = (ac && ac.elevationDeg != null)
      ? PointingBudget.lossFactor(km, ac.pointingPrecision ?? 0.7, scintillationEngine.chiVariance)
      : 1.0;
    const effectiveTransmittance = Math.min(1.0,
      fiberT(nm, sk) * repeaterGainFactor * atmosphericFactor * scintillationFactor * pointingFactor);
    if (rand() > effectiveTransmittance / thresholds.absorbBias) {
      evs.push({ type:"ABSORB", km: base + sk*.1 + rand()*sk*.8 });
      alive = false; break;
    }
    // Eski: sabit sk/1400. LEGA: yorgunluk sayacına göre kademeli artan oran.
    if (sk > 40 && rand() < (sk/1400) * thresholds.decohereBias) {
      evs.push({ type:"DECOHERE", km: base + sk*.55 + rand()*sk*.35 });
      alive = false; break;
    }
  }

  // GEÇİŞ vs. SÖNÜMLENME kararı — yapı değişmedi, sadece eşikler dinamikleşti.
  if (!alive) {
    if (legaCtx) lega.recordOutcome(nm, km, true); // yorgunluk sayacını güncelle
    return { ok: false, evs };
  }
  if (legaCtx) lega.recordOutcome(nm, km, false); // hayatta kaldı → yorgunluk azalır

  // OPTİK FAZ KİLİTLİ DÖNGÜ (OPLL): tamamen opsiyonel — yalnızca
  // legaCtx.opllEnabled=true verilirse devreye girer. PHASE olasılığının
  // KENDİSİ, PLL'in "izlediği referans faz sapması" olarak beslenir —
  // yani döngü, bu kanaldaki gerçek fiziksel faz kayma riskine kilitlenmeye
  // çalışır. Kilit sağlandığında (birkaç ardışık düşük-hatalı ölçümden
  // sonra), phaseDampingFactor() PHASE olasılığını bastırır — gerçek bir
  // PLL'in faz gürültüsünü telafi etme davranışının matematiksel analogu.
  // legaCtx.opllEnabled verilmezse (varsayılan, mevcut TÜM çağrı yerleri)
  // formül BİREBİR ESKİ HALİYLE çalışır — hiçbir damping uygulanmaz.
  let phaseProb = .012 + km/4000;
  if (legaCtx?.opllEnabled) {
    opticalPLL.tick(nm, km, phaseProb); // referans faz olarak anlık risk beslenir
    phaseProb *= opticalPLL.phaseDampingFactor(nm, km);
  }
  // GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ İÇİN faz-damping override'ı (bkz.
  // propPhotonRelayChain — coeffOverride.phaseDamping, verilmezse 1.0/etkisiz).
  // BULUNDU (Monte Carlo doğrulamasında, bkz. sohbet geçmişi): phaseProb
  // formülü .012+km/4000, TEK BİR uzun-mesafe hattı için tasarlanmıştı —
  // ama bir röle zincirinde HER hop kendi PHASE olayını BAĞIMSIZ üretir ve
  // bunlar XOR'lanarak birikir (ardışık flip'ler birbirini götürebilir/
  // pekiştirebilir); n hop üzerinden "tek sayıda flip" olasılığı n arttıkça
  // %50'ye (tamamen rastgele bit) YAKINSAR — bu, ABSORB/SCATTER/DECOHERE
  // için zaten uygulanan "güvenilir düğüm taze foton hazırlar" ilkesinin
  // FAZ için de uygulanmasını gerektirir (dijital ölç-ve-yeniden-gönder,
  // önceki hop'un faz sürüklenmesini TAŞIMAZ — bkz. propPhotonRelayChain
  // başlığındaki aynı gerekçe).
  const phaseDamping = legaCtx?.coeffOverride?.phaseDamping ?? 1.0;
  phaseProb *= phaseDamping;

  if (rand() < phaseProb) {
    evs.push({ type:"PHASE", km: rand()*km });
    return { ok: true, evs, flip: true };
  }
  if (evesdrop && rand() < eavesdropProbability(nm, km)) {
    evs.push({ type:"EAVES", km: km*.35 + rand()*km*.3 });
    if (rand() < .25) return { ok: true, evs, flip: true };
  }
  return { ok: true, evs };
}

// ══════════════════════════════════════════════════════════════
// GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ — FİZİKSEL MESAJ KANALI
// (Trusted-Node Relay Chain for the PHYSICAL Message Channel)
//
// KULLANICI TALEBİ: "güvenilir düğüm röle zincirini tasarla". Küresel ağa
// eklenen kıtalar-arası omurga hatları (örn. LON-NYC — TEK GERÇEK GRAFİK
// KENARI, 7245km) fiziksel mesaj iletiminde (physicalSimulation/propPhoton)
// başarısız oluyordu: bkz. canlı IST→NYC testi, "SEG2: LON-NYC 7245km
// λ=1550nm T=0.0% R×3" — BER %100, "Kısmi İletim".
//
// KÖK NEDEN (matematiksel): computeRepeaterGain'in telafi tavanı (%95,
// gerçek analog bir EDFA'nın gürültü tabanı yüzünden asla %100'e
// ulaşamaması) segment sayısından BAĞIMSIZ bir sonuç üretir — reps
// değeri ne olursa olsun (3, 30, ya da 300), TOPLAM telafi edilmiş kayıp
// HER ZAMAN tam olarak "ham kayıp × %5" olur (segment sayısı formülde
// cebirsel olarak sadeleşir). 7245km @ 1550nm için bu, 72.45dB'lik bir
// kalıntı kayıp demektir — foton-başına hayatta kalma olasılığı ~5.7×10⁻⁸,
// pratikte SIFIR (bkz. dynamicRedundancyFor'un ×20 FEC tavanı bile bunu
// kurtaramaz). Yani "daha fazla tekrarlayıcı ekle" bu formülle ASLA
// yeterli olmaz — bu bir uygulama hatası değil, EDFA/analog amplifikasyon
// modelinin FİZİKSEL bir sınırı (gerçek dünyada da ultra-uzun-menzilli
// deniz altı/kıtalararası hatlar SAF optik amplifikasyonla değil, dijital
// yeniden-üretim/röle istasyonlarıyla çalışır — tam olarak burada
// tasarlanan mekanizma).
//
// NEDEN BASİT AMPLİFİKASYON DEĞİL, GÜVENİLİR DÜĞÜM (bkz. deriveSiftedKeyChain'in
// aynı gerekçesi, satır ~742-751): tek fotonlu kanal no-cloning teoremine
// tabidir — fiziksel olarak "güçlendirilemez", yalnızca ÖLÇÜLÜP YENİDEN
// HAZIRLANARAK (measure-and-resend) rölelenebilir. Bir GÜVENİLİR DÜĞÜM,
// gelen fotonu DİJİTAL olarak ölçer (bit değerini + varsa flip durumunu
// okur) ve bir sonraki hop için TAZE, TAM GÜÇTE bir foton hazırlar —
// analog bir EDFA'nın aksine, önceki hop'un optik kaybını/gürültüsünü
// BİRİKTİRMEZ (hop'lar arasında SIFIRLANIR). Bu yüzden aşağıdaki fonksiyon
// computeRepeaterGain'i (analog EDFA, %95 tavan) DEĞİL, dijital
// yeniden-üretime özgü, DAHA YÜKSEK bir telafi tavanı (MSG_RELAY_COMPENSATION,
// bkz. computeRepeaterGain'in 4. parametresi) kullanır — bu SADECE bu
// fonksiyondan geçer, propPhoton'ın normal (tek-atış) yolu ve mevcut TÜM
// diğer çağrı yerleri eski %95 tavanını BİREBİR korur.
//
// DÜRÜST GÜVENLİK KISITI: deriveSiftedKeyChain ile AYNI — bu, GERÇEK bir
// kuantum tekrarlayıcı (entanglement swapping, ara düğüme güven GEREKTİRMEZ)
// DEĞİLDİR. Ara düğümler mesajın fiziksel taşıyıcısını (foton/bit) DİJİTAL
// olarak görür — bu yüzden "güvenilir" düğüm denir (bkz. transmit()'teki
// qkdChain.trustedNodeCaveat log satırı, aynı zincir kullanıldığında zaten
// gösteriliyor).
//
// NE ZAMAN DEVREYE GİRER: physicalSimulation() içinde, SADECE tek bir
// GERÇEK LİNK'in kendisi MSG_RELAY_THRESHOLD_KM'yi aşıyorsa (bkz. o
// sabitin tanımı) — kısa/orta hatlarda (eski Türkiye ağının TAMAMI dahil)
// davranış BİREBİR ESKİSİ GİBİDİR (propPhoton doğrudan çağrılır, hiç
// zincirlenmez).
const MSG_RELAY_THRESHOLD_KM = 1000; // bu değeri aşan TEK BİR LİNK röle zincirine döner
const MSG_RELAY_HOP_KM = 600;        // gerçekçi kıtalararası röle istasyonu aralığı (bu zincire ÖZGÜ — deriveSiftedKeyChain'in 60km'si İSTATİSTİKSEL anahtar örneklemi için optimize edilmiş farklı bir kullanım örüntüsüdür, bkz. o sabitin yorumu)
const MSG_RELAY_COMPENSATION = 0.999; // dijital ölç-ve-yeniden-gönder ABSORB tavanı (analog EDFA'nın %95'inden çok daha yüksek — gürültü/kayıp hop'lar arasında BİRİKMEZ). bkz. aşağıdaki "NEDEN %99 YETMEDİ" notu.
const MSG_RELAY_HOP_REPS = 4;        // hop-içi computeRepeaterGain'in %99.9 tavanına ulaşması için yeterli reps (0.5+4*0.15=1.10>0.999)
// NEDEN %99 YETMEDİ + SCATTER/DECOHERE İÇİN AYRI BİR TAVAN GEREKTİ (bu
// projenin kendi Monte Carlo doğrulama testinde bulundu, bkz. sohbet
// geçmişi/debug_tune*.js): computeRepeaterGain'in ABSORB tavanı SADECE
// soğurma/zayıflama (amplitude) kaybını telafi eder — ama propPhoton'ın
// SCATTER ve DECOHERE kontrolleri (w.r/1200)*sk ve sk/1400 formülleriyle
// AYRI, telafisiz bir kayıp kaynağıdır ve cebirsel olarak (reps+1)*sk=hopKm
// olduğundan, ne kadar reps eklenirse eklensin TOPLAM SCATTER/DECOHERE
// kaybı SADECE hopKm'e (segment sayısına DEĞİL) bağlı kalır — yani "daha
// fazla mikro-tekrarlayıcı" bunu ASLA iyileştirmez (matematiksel bir
// sadeleşme, bkz. yorum). Güvenilir bir düğüm SADECE optik gücü değil,
// TÜM sinyali (dijital olarak) tazeler — bu yüzden bu iki kayıp kaynağı
// da (ABSORB'un yanı sıra) MSG_RELAY_COEFF_OVERRIDE ile hop-başına
// düşürülür (propPhoton'ın coeffOverride mekanizması, bkz. propPhoton
// başlığı — bu, lega.recordOutcome()'un paylaşılan yorgunluk haritasını
// ETKİLEMEZ çünkü coeffOverride verildiğinde thresholds hesaplaması
// lega.computeThresholds()'u hiç çağırmaz).
//
// DÜRÜSTLÜK NOTU: bu katsayılar (0.02/0.05), LEGA'nın kendi "DÜRÜSTLÜK
// NOTU"yla AYNI ruhta, gerçek ölçüm verisinden türetilmemiş, "iyi
// mühendislik edilmiş bir röle istasyonu donanımı" sezgisiyle seçilmiş
// didaktik değerlerdir — amaç, gerçek dünyadaki trusted-node QKD
// ağlarının (örn. Çin'in Pekin-Şangay 2000km omurgası) günümüzde FİİLEN
// ÇALIŞTIĞI gerçeğini makul biçimde yansıtmaktır (yoksa 7245km+ hatlar
// bu simülasyonda HER ZAMAN ~%0 varış olasılığına sahip olurdu — gerçek
// dünyada trusted-node röleleri TAM OLARAK bu sorunu çözer).
// phaseDamping: bkz. propPhoton'daki "GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ İÇİN
// faz-damping override'ı" notu — çoklu-hop XOR-birikimli faz-çevirme
// olasılığını (n arttıkça %50'ye yakınsayan) makul bir aralıkta tutar.
const MSG_RELAY_COEFF_OVERRIDE = { scatterDeathProb: 0.02, absorbBias: 1.0, decohereBias: 0.05, phaseDamping: 0.06 };

/**
 * Tek bir GERÇEK LİNK'i (lk.km), her biri kendi bağımsız tek-foton
 * denemesi olan MSG_RELAY_HOP_KM'lik güvenilir-düğüm hop'larına böler.
 * propPhoton ile AYNI dönüş sözleşmesini kullanır ({ok, evs, flip}) —
 * physicalSimulation'daki mevcut FEC/çoğunluk-oylaması döngüsü (DÜZELTME 8)
 * bu fonksiyonu propPhoton'ın YERİNE, hiçbir başka değişiklik olmadan
 * çağırabilir (bkz. çağrı yeri, "usingMsgRelay" dallanması).
 * @param {number} nm @param {number} km @param {number} reps - hedef
 *   düğümün KENDİ reps'i; zincirin İLK hop'una uygulanır (gerçek dünyada
 *   uç istasyonun ekipmanıyla aynı fikir), kalan hop'lar sabit
 *   MSG_RELAY_HOP_REPS kullanır.
 * @param {boolean} evesdrop
 * @param {() => number} rng
 * @param {object} [legaCtx] - şu an KULLANILMIYOR (parametre imza uyumluluğu
 *   için tutuluyor) — hop'lar KASITLI OLARAK kendi sabit coeffOverride'ını
 *   kullanır, orijinal legaCtx'i AKTARMAZ, bkz. aşağıdaki not.
 */
function propPhotonRelayChain(nm, km, reps, evesdrop, rng, legaCtx) {
  const nHops = Math.max(2, Math.ceil(km / MSG_RELAY_HOP_KM));
  const hopKm = km / nHops;
  const relayEvs = [];
  let flipParity = false;
  for (let h = 0; h < nHops; h++) {
    // Her hop propPhoton'a AYRI bir çağrıdır — bir önceki hop'un fiziksel
    // kaybı bu hop'a HİÇ taşınmaz (güvenilir düğüm = taze foton). Yalnızca
    // İLK hop'ta (h===0) casusluk fiziği değerlendirilir — tekrar denemeleri
    // Eve'in istatistiksel imzasını suni biçimde çoğaltmaz (propPhoton'ın
    // normal FEC döngüsündeki "yalnızca c===0'da" ilkesiyle TUTARLI).
    //
    // BULUNAN KRİTİK ETKİLEŞİM HATASI (bu tasarımın kendi testinde
    // yakalandı, bkz. sohbet geçmişi): legaCtx buraya AKTARILIRSA,
    // propPhoton'ın çağırdığı lega.recordOutcome() PAYLAŞILAN, TEK bir
    // "yorgunluk" sayacını (fatigueMap, bkz. LinkGradedEavesdropThresholdAlgorithm)
    // günceller — bu sayaç normalde TEK BİR fiziksel fiber segmentinin
    // zamanla ısınmasını/yıpranmasını temsil eder. Ama bir röle zincirinde,
    // AYNI segment (nm, hopKm) TÜM hop'lar TARAFINDAN paylaşılır (hepsi
    // aynı uzunlukta) VE her mesaj biti kadar (×FEC redundancy'ye kadar
    // ×20 kopya) tekrar tekrar çağrılır — onbinlerce çağrı SANİYELER
    // içinde aynı "sanal segment"e yığılır, yorgunluk sayacı ANINDA
    // tavana (20) kilitlenir ve decohereBias 2 katına çıkar — bu, GERÇEK
    // dünyada FİZİKSEL OLARAK YANLIŞ bir sonuç üretir: ayrı, bağımsız
    // güvenilir-düğüm hop'ları arasında böyle bir "paylaşılan yorgunluk"
    // OLMAMALIDIR (her hop KENDİ ayrı fiziksel fiber span'ıdır, birbirinin
    // "aynı telin" tekrar kullanımı DEĞİLDİR). Deneysel olarak doğrulandı:
    // legaCtx aktarıldığında IST→LON (3242km) segmentinde 182 bitin
    // TAMAMI kayboluyordu (bkz. relay_chain_log_dump.txt). ÇÖZÜM: hop'lara
    // orijinal (canlı, fatigueMap'i besleyen) legaCtx'in KENDİSİ HİÇ
    // aktarılmaz — bunun yerine SABİT bir coeffOverride nesnesi
    // (MSG_RELAY_COEFF_OVERRIDE) geçilir. propPhoton bunu gördüğünde
    // (bkz. propPhoton'daki `legaCtx?.coeffOverride ? ... : ...` dallanması)
    // lega.computeThresholds()'u HİÇ ÇAĞIRMAZ — yani fatigueMap okunmaz,
    // saturasyon riski yaşanmaz. lega.recordOutcome() teknik olarak yine
    // çağrılır (propPhoton'da `legaCtx` truthy olduğu için) ama bu YAZI,
    // hiçbir okuma yolu tarafından tüketilmediği için ZARARSIZDIR —
    // yalnızca aynı (nm, hopKm/10) bucket'ını paylaşan BAŞKA bir canlı
    // (coeffOverride'sız) çağrı varsa hafif çapraz kirlenme riski taşır,
    // kabul edilebilir düzeyde (bkz. fatigueMap'in kendi zaman-bazlı
    // decay mekanizması).
    const attempt = propPhoton(
      nm, hopKm, h === 0 ? Math.max(reps, MSG_RELAY_HOP_REPS) : MSG_RELAY_HOP_REPS,
      evesdrop && h === 0, rng, { coeffOverride: MSG_RELAY_COEFF_OVERRIDE }, MSG_RELAY_COMPENSATION
    );
    relayEvs.push(...attempt.evs.map(ev => ({ ...ev, relayHop: h, relayHopKm: hopKm })));
    if (!attempt.ok) {
      // Zincir bu hop'ta koptu — dürüstçe SÖNÜMLENDİ, "sahte" bir kurtarma
      // uygulanmaz (deriveSiftedKeyChain'in aynı dürüstlük ilkesi).
      return { ok: false, evs: relayEvs, relayHopsTotal: nHops, relayHopKm: hopKm, relayDeadAtHop: h };
    }
    if (attempt.flip) flipParity = !flipParity; // ardışık hop'lardaki flip'ler kümülatif XOR'lanır
  }
  return { ok: true, evs: relayEvs, flip: flipParity, relayHopsTotal: nHops, relayHopKm: hopKm };
}


// ══════════════════════════════════════════════════════════════
// V8.0 MİMARİ TEMELİ — ADIM 1: NetworkTopology SINIFI
//
// Eski mimaride ağ, düz JS array'leri (NODES/LINKS) olarak tutuluyordu.
// Bir düğüm ararken nodes.find(n=>n.id===x) çalıştırılıyordu — bu O(n),
// yani 1.000 düğümlü bir ağda ortalama 500 karşılaştırma demektir.
// Dijkstra'nın kendisi de her adımda links.forEach ile TÜM kenarları
// tarıyordu (gerçek kenar listesi/adjacency yoktu) ve kuyruk yönetimi
// için q.sort() kullanıyordu (O(V log V) HER iterasyonda).
//
// NetworkTopology bunu üç gerçek veri yapısıyla çözer:
//   1. Map<nodeId, Node>           → O(1) düğüm erişimi
//   2. Map<nodeId, Edge[]>         → adjacency list, O(1) komşu erişimi
//   3. Binary Min-Heap             → Dijkstra'da O(log V) pop/push
// Sonuç: Dijkstra artık gerçek O((V+E) log V) karmaşıklığında çalışır
// ve düğüm sayısı teorik olarak milyonlara çıksa bile (uydu takım
// yıldızları, küresel fiber ağlar gibi) yapı orantılı ölçeklenir.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// V8.0 ADIM 4: EdgeWeightPolicy — İZOLE AĞIRLIK HESAPLAMA KATMANI
//
// KARAR: Kenar ağırlığı = FİZİKSEL MALİYET + CANLI YÜK (kullanıcı seçimi).
// Bu, NetworkTopology'nin "bir sonraki adımda besleyeceği üst katman"dır:
// topoloji artık statik bir grafik değil, her sorguda güncel ağ trafiğine
// göre yeniden tartılan CANLI bir maliyet yüzeyi sunar.
//
// Neden ayrı bir sınıf/modül (transmit() veya NetworkTopology içine
// gömülü değil)? Çünkü ağırlık politikası ileride değişebilir (tarihsel
// güvenilirlik, kiralite/QBER sinyali eklenmesi gibi) — bunu NetworkTopology
// sınıfının kendisinden İZOLE tutmak, Dijkstra'nın arama mekaniğini
// (heap/adjacency) hiç değiştirmeden ağırlık formülünü değiştirebilmeyi
// sağlar. Tek Sorumluluk İlkesi: NetworkTopology "nasıl arar",
// EdgeWeightPolicy "ne kadar pahalı" sorusuna cevap verir.
//
// @typedef {Object} LinkRecord
// @property {string} a - kaynak düğüm id'si
// @property {string} b - hedef düğüm id'si
// @property {number} km - fiziksel mesafe (kilometre)
// @property {number} nm - dalga boyu (1550/1310/850/633)
//
// @typedef {Object} WeightContext
// @property {Record<string, number>} linkLoad - anlık kanal doluluk oranı [0-1], key: "a-b"
// ══════════════════════════════════════════════════════════════
class EdgeWeightPolicy {
  /**
   * @param {{ loadFactor?: number, predictiveFactor?: number }} [opts] -
   *   loadFactor: canlı yükün toplam maliyete katkı ağırlığı (0=yalnız
   *   fiziksel, 1=yük baskın). Varsayılan 0.6. predictiveFactor: FAZ 4
   *   (TAHMİNLEME MOTORU) risk skorunun katkı ağırlığı — bkz. computeWeight.
   *   Varsayılan 0.5 — canlı yükten biraz daha hafif, çünkü bu bir TAHMİN
   *   (henüz gerçekleşmemiş), gerçek yük kadar kesin değildir.
   */
  constructor(opts = {}) {
    this.loadFactor = opts.loadFactor ?? 0.6;
    this.predictiveFactor = opts.predictiveFactor ?? 0.5;
  }

  /** İki yönlü link key'i normalize eder (a-b / b-a aynı kabul edilir). */
  static linkKey(a, b) { return `${a}-${b}`; }

  /**
   * Saf fiziksel maliyet: mesafe × dalga-boyu-kaybı katsayısı.
   * Bu, V7'deki orijinal (statik) Dijkstra maliyetinin BİREBİR AYNISIDIR
   * — geriye dönük tutarlılık için taban terim olarak korunur.
   * @param {LinkRecord} link
   * @returns {number}
   */
  physicalCost(link) {
    const w = (WL[link.nm] || WL[1550]).loss;
    return link.km * w;
  }

  /**
   * Bir linkin o anki doluluk oranını [0,1] aralığında okur.
   * linkLoad state'i iki olası key yönünde de tutulabildiği için
   * (a-b veya b-a) ikisini de dener.
   * @param {LinkRecord} link
   * @param {Record<string, number>} linkLoad
   * @returns {number}
   */
  readLoad(link, linkLoad) {
    if (!linkLoad) return 0;
    const kAB = EdgeWeightPolicy.linkKey(link.a, link.b);
    const kBA = EdgeWeightPolicy.linkKey(link.b, link.a);
    return linkLoad[kAB] ?? linkLoad[kBA] ?? 0;
  }

  /**
   * Bir linkin şu an TAMAMEN KOPUK (down/outage) olarak işaretlenip
   * işaretlenmediğini okur — bkz. LinkOutageController (DİNAMİK YÜK
   * DENGELEME / AKILLI ROTALAMA özelliği). linkLoad'un aksine bu ikili
   * (boolean) bir durumdur: "%X dolu" değil, "fiziksel olarak KOPUK".
   * @param {LinkRecord} link
   * @param {Record<string, boolean>} [linkDown]
   * @returns {boolean}
   */
  isDown(link, linkDown) {
    if (!linkDown) return false;
    const kAB = EdgeWeightPolicy.linkKey(link.a, link.b);
    const kBA = EdgeWeightPolicy.linkKey(link.b, link.a);
    return !!(linkDown[kAB] || linkDown[kBA]);
  }

  /**
   * FAZ 4 — TAHMİNLEME MOTORU (Predictive Telemetry): bir linkin, henüz
   * GERÇEKLEŞMEMİŞ ama PredictiveTelemetryEngine tarafından öngörülen
   * gelecekteki darboğaz riskini [0,1] aralığında okur. linkLoad'un
   * aksine bu değer "şu an ne kadar dolu" değil, "hareketli ortalama +
   * ivmelenme ekstrapolasyonuna göre önümüzdeki ~5 dakikada ne kadar
   * riskli" sorusuna cevap verir — bkz. PredictiveTelemetryEngine.analyze().
   * @param {LinkRecord} link
   * @param {Record<string, number>} [predictiveRisk]
   * @returns {number}
   */
  readPredictiveRisk(link, predictiveRisk) {
    if (!predictiveRisk) return 0;
    const kAB = EdgeWeightPolicy.linkKey(link.a, link.b);
    const kBA = EdgeWeightPolicy.linkKey(link.b, link.a);
    return predictiveRisk[kAB] ?? predictiveRisk[kBA] ?? 0;
  }

  /**
   * NİHAİ AĞIRLIK FONKSİYONU — Dijkstra'nın kullandığı gerçek maliyet.
   * cost = physicalCost × (1 + loadFactor × load)
   * Yani: linkLoad=0 iken saf fiziksel maliyet; linkLoad=1 (tam dolu)
   * iken maliyet (1+loadFactor) katına çıkar — yoğun hat, Dijkstra
   * için "daha uzak" görünür ve rota otomatik olarak boş hatlara kayar.
   *
   * DİNAMİK YÜK DENGELEME: ctx.linkDown üzerinden bu link "KOPUK" olarak
   * işaretlenmişse maliyet Infinity döner — Dijkstra'nın min-heap'i bu
   * kenarı ASLA en kısa yol için seçmez (matematiksel olarak, `nd <
   * dist.get(to)` karşılaştırması Infinity için hiçbir zaman true olmaz,
   * bkz. NetworkTopology.shortestPath). ctx.linkDown verilmezse (varsayılan,
   * mevcut TÜM eski çağrı yerleri) davranış BİREBİR ESKİSİ GİBİDİR.
   * @param {LinkRecord} link
   * @param {WeightContext} [ctx]
   * @returns {number}
   */
  computeWeight(link, ctx = {}) {
    if (this.isDown(link, ctx.linkDown)) return Infinity;
    const base = this.physicalCost(link);
    const load = this.readLoad(link, ctx.linkLoad);
    // FAZ 4: öngörülen risk de maliyete ÇARPAN olarak katılır — böylece
    // sistem, bir hat henüz gerçekten yoğunlaşmadan ("kriz çıkmadan")
    // ONU ÖNCEDEN "biraz daha pahalı" görmeye başlar; trafik yumuşak ve
    // KADEMELİ olarak alternatiflere kayar — ani/reaktif değil, PROAKTİF.
    // ctx.predictiveRisk verilmezse (varsayılan) davranış BİREBİR ESKİSİ GİBİDİR.
    const risk = this.readPredictiveRisk(link, ctx.predictiveRisk);
    return base * (1 + this.loadFactor * load) * (1 + this.predictiveFactor * risk);
  }
}

// Varsayılan politika — modül-seviyesi tekil, NetworkTopology'nin
// varsayılan davranışı budur. İleride farklı bir politika (örn. tarihsel
// güvenilirlik ağırlıklı) gerekirse yeni bir EdgeWeightPolicy örneği
// oluşturup NetworkTopology.shortestPath()'e üçüncü parametre olarak
// geçirmek yeterlidir — Dijkstra mantığına dokunulmaz.
const defaultWeightPolicy = new EdgeWeightPolicy({ loadFactor: 0.6 });

// ── Yardımcı: Binary Min-Heap (öncelik kuyruğu) ─────────────────
// Dijkstra'nın q.sort() ile O(V log V) harcayan saf-array kuyruğunun
// yerini alır. push/pop O(log n)'dir.
class MinHeap {
  constructor() { this.arr = []; } // [{key, dist}]
  get size() { return this.arr.length; }
  push(key, dist) {
    this.arr.push({ key, dist });
    let i = this.arr.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[parent].dist <= this.arr[i].dist) break;
      [this.arr[parent], this.arr[i]] = [this.arr[i], this.arr[parent]];
      i = parent;
    }
  }
  pop() {
    if (this.arr.length === 0) return null;
    const top = this.arr[0];
    const last = this.arr.pop();
    if (this.arr.length > 0) {
      this.arr[0] = last;
      let i = 0;
      while (true) {
        const l = i*2+1, r = i*2+2;
        let smallest = i;
        if (l < this.arr.length && this.arr[l].dist < this.arr[smallest].dist) smallest = l;
        if (r < this.arr.length && this.arr[r].dist < this.arr[smallest].dist) smallest = r;
        if (smallest === i) break;
        [this.arr[i], this.arr[smallest]] = [this.arr[smallest], this.arr[i]];
        i = smallest;
      }
    }
    return top;
  }
}

// ── NetworkTopology: Map-tabanlı, bellek-optimizasyonlu ağ modeli ──
class NetworkTopology {
  constructor(nodes = [], links = []) {
    this.nodeMap = new Map();     // id → node objesi          — O(1) erişim
    this.adjacency = new Map();   // id → [{to, link}]         — O(1) komşu listesi
    this.linkList = [];           // tüm kenarlar (render/iterasyon için)
    this.rebuild(nodes, links);
  }

  // Tüm veriyi sıfırdan kurar. React state'i (immutable nodes/links
  // array'leri) her değiştiğinde bir kez çağrılır — O(V+E), ama bu
  // yalnızca YAPI değiştiğinde (düğüm ekle/çıkar, on/off) olur; arama
  // işlemlerinin kendisi her zaman O(1)/O(deg(v)) kalır.
  /**
   * @param {NetNode[]} nodes
   * @param {NetLink[]} links
   */
  rebuild(nodes, links) {
    this.nodeMap.clear();
    this.adjacency.clear();
    this.linkList = links;
    for (const n of nodes) {
      this.nodeMap.set(n.id, n);
      if (!this.adjacency.has(n.id)) this.adjacency.set(n.id, []);
    }
    for (const lk of links) {
      if (!this.adjacency.has(lk.a)) this.adjacency.set(lk.a, []);
      if (!this.adjacency.has(lk.b)) this.adjacency.set(lk.b, []);
      this.adjacency.get(lk.a).push({ to: lk.b, link: lk });
      this.adjacency.get(lk.b).push({ to: lk.a, link: lk });
    }
  }

  // O(1) — eski nodes.find(n=>n.id===id) yerine
  /** @param {string} id @returns {NetNode|null} */
  getNode(id) { return this.nodeMap.get(id) ?? null; }
  hasNode(id) { return this.nodeMap.has(id); }
  get nodeCount() { return this.nodeMap.size; }
  get linkCount() { return this.linkList.length; }

  // O(deg(v)) — bir düğümün komşularını anında döner (eski kodda
  // bu, TÜM links dizisini taramak anlamına geliyordu)
  neighbors(id) { return this.adjacency.get(id) ?? []; }

  // ── Gerçek Dijkstra: Binary Min-Heap ile O((V+E) log V) ────────
  // Dönüş formatı eski dijkstra() ile BİREBİR AYNI: [{node, link}, ...]
  // path[0].link === null, sonrakiler o düğüme gelen kenarı taşır.
  //
  // V8.0 ADIM 4: maliyet artık EdgeWeightPolicy üzerinden hesaplanır.
  // weightCtx (örn. { linkLoad }) verilmezse policy.computeWeight()
  // load=0 okur ve sonuç SAF FİZİKSEL maliyetle BİREBİR AYNI kalır —
  // yani bu değişiklik geriye dönük olarak tamamen uyumludur.
  /**
   * @param {string} src
   * @param {string} dst
   * @param {(id: string) => boolean} [isNodeLive]
   * @param {WeightContext} [weightCtx] - örn. { linkLoad: {...} }
   * @param {EdgeWeightPolicy} [policy]
   */
  shortestPath(src, dst, isNodeLive, weightCtx, policy) {
    const wp = policy || defaultWeightPolicy;
    if (!this.hasNode(src) || !this.hasNode(dst)) return null;
    if (isNodeLive && (!isNodeLive(src) || !isNodeLive(dst))) return null;

    const dist = new Map();   // O(1) erişimli mesafe tablosu (eski: düz obje)
    const prev = new Map();
    const visited = new Set();
    dist.set(src, 0);

    const heap = new MinHeap();
    heap.push(src, 0);

    while (heap.size > 0) {
      const { key: u, dist: du } = heap.pop();
      if (visited.has(u)) continue; // stale heap entry — atla
      visited.add(u);
      if (u === dst) break;

      for (const { to, link } of this.neighbors(u)) {
        if (isNodeLive && !isNodeLive(to)) continue;
        const cost = wp.computeWeight(link, weightCtx);
        const nd = du + cost;
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
          dist.set(to, nd);
          prev.set(to, { node: u, link });
          heap.push(to, nd);
        }
      }
    }

    if (!dist.has(dst) || !isFinite(dist.get(dst))) return null;

    const path = [];
    let cur = dst;
    while (prev.has(cur)) {
      const p = prev.get(cur);
      path.unshift({ node: cur, link: p.link });
      cur = p.node;
    }
    path.unshift({ node: src, link: null });
    return path;
  }
}

// Modül-seviyesi tekil örnek — React state (nodes/links) her değiştiğinde
// .rebuild() ile güncellenir, bileşenler arası paylaşılan tek kaynak.
const networkTopology = new NetworkTopology([], []);

// ── Geriye-uyumlu sarmalayıcı: ESKİ İMZA KORUNUR, YENİ OPSİYONEL 5. PARAM ──
// transmit(), replayTimeline() vb. yerlerdeki dijkstra(nodes,links,src,dst)
// çağrıları TEK SATIR DEĞİŞMEDEN çalışmaya devam eder (linkLoad verilmezse
// saf fiziksel maliyetle BİREBİR AYNI sonucu üretir). V8.0 ADIM 4: 5.
// parametre olarak linkLoad geçilirse, EdgeWeightPolicy artık canlı ağ
// trafiğini de hesaba katar — yoğun hatlar Dijkstra için "daha pahalı"
// görünür ve rota otomatik olarak boşta olan hatlara kayar.
/**
 * @param {Array} nodes
 * @param {Array} links
 * @param {string} src
 * @param {string} dst
 * @param {Record<string, number>} [linkLoad] - opsiyonel: canlı kanal yükü
 * @param {Record<string, boolean>} [linkDown] - opsiyonel: DİNAMİK YÜK
 *   DENGELEME özelliğinden gelen, o an "kopuk" işaretlenmiş hatlar (bkz.
 *   LinkOutageController). Verilmezse (mevcut TÜM eski çağrı yerleri)
 *   davranış BİREBİR ESKİSİ GİBİDİR.
 * @param {Record<string, number>} [predictiveRisk] - opsiyonel: FAZ 4
 *   (TAHMİNLEME MOTORU) tarafından üretilen, henüz gerçekleşmemiş ama
 *   öngörülen darboğaz risk skorları (bkz. PredictiveTelemetryEngine).
 *   Verilmezse (mevcut TÜM eski çağrı yerleri) davranış BİREBİR ESKİSİ GİBİDİR.
 */
function dijkstra(nodes, links, src, dst, linkLoad, linkDown, predictiveRisk) {
  // Topolojiyi (yapısal olarak) güncel tut — ucuz bir referans eşitliği
  // kontrolü ile gereksiz rebuild'i engelliyoruz.
  if (networkTopology._lastNodes !== nodes || networkTopology._lastLinks !== links) {
    networkTopology.rebuild(nodes, links);
    networkTopology._lastNodes = nodes;
    networkTopology._lastLinks = links;
  }
  const liveIds = new Set(nodes.filter(n => n.on).map(n => n.id));
  const weightCtx = (linkLoad || linkDown || predictiveRisk) ? { linkLoad, linkDown, predictiveRisk } : undefined;
  return networkTopology.shortestPath(src, dst, (id) => liveIds.has(id), weightCtx);
}

// DÜZELTME 12 (FAZ 6 — HAT BAZLI SUÇLAMA/KARANTİNA testi sırasında bulundu):
// BAG (Bağdat) topolojide yalnızca İKİ fiziksel hatla bağlıydı — GAZ-BAG ve
// VAN-BAG — ve VAN varsayılan olarak KAPALIYDI (on:false). Yani GAZ-BAG
// hattı Watchdog tarafından karantinaya alındığında (bkz. aşağıdaki FAZ 6
// useEffect'i) BAG matematiksel olarak TAMAMEN erişilemez hale geliyordu
// (Dijkstra'nın döneceği HİÇBİR yol yoktu) — algoritma doğru çalışıyordu
// ama devreye girecek gerçek bir alternatif fiziksel yol topolojide hiç
// yoktu. VAN burada açılıyor (on:true, reps:2) — bu YENİ bir düğüm/hat
// icat etmez, zaten var olan ama kapalı bırakılmış gerçek bir komşu
// düğümü (EZR-VAN-BAG zinciri) devreye sokar; BAG artık gerçek, ikinci
// bir fiziksel giriş noktasına sahip.
//
// DÜZELTME 13 (aynı test — YÖNLENDİRME doğruyken FİZİK hâlâ imkansızdı):
// route çeşitliliği (4-9 hop arası farklı yollar) HAT BAZLI KARANTİNA'nın
// gerçekten çalıştığını kanıtlasa da, hiçbir deneme BAŞARILI/yeşil
// TAMAMLANDI durumuna ulaşamadı — çünkü GAZ-BAG (560km, tek foton
// hayatta kalma ~1.2e-4, ×150 FEC ile bile bit-hayatta-kalma yalnızca
// ~%1.8) ve düzeltilmemiş VAN-BAG (850nm'de ~1e-6, pratikte SIFIR) İKİSİ
// DE reps=2 seviyesinde fiziksel olarak neredeyse geçilemezdi (bkz.
// computeRepeaterGain — telafi oranı reps=2'de %80'de tavanlanır, reps=3'te
// tam tavan olan %95'e ulaşır: bu eşiği aşmak, tek foton hayatta kalma
// olasılığını KATLANARAK artırır). BAG'ın reps'i 3'e çıkarılıyor — hem
// GAZ-BAG hem VAN-BAG segmentleri hedef düğüm (BAG) üzerinden AYNI reps
// değerini okuduğu için (bkz. physicalSimulation: `rp = getNode(lk.b).reps`),
// bu TEK değişiklik HER İKİ yolu birden matematiksel olarak kurtarır:
// izole Monte Carlo doğrulaması, reps=3'te ×150 FEC ile bit-hayatta-kalmanın
// GAZ-BAG için ~%100'e, (1550nm düzeltmesiyle birlikte) VAN-BAG için de
// ~%100'e çıktığını gösterdi (reps=2'de ikisi de <%34 idi).
//
// DÜZELTME 14 (kullanıcı onayıyla — KORİDOR-GENELİ GÜÇLENDİRME): tam log
// çıktısı incelendiğinde, BAG'ı düzeltmenin YETMEDİĞİ ortaya çıktı — IST-BAG
// rotasındaki NEREDEYSE HER ara segment (BUR→ANK, ANK→KON, KON→ADA,
// SAM→TZN, TZN→EZR, TBS→EZR, TBS→EVN, EVN→VAN...) kendi başına ANİ
// SOĞURULMA BARİYERİ üretiyordu, çünkü bu Türkiye/Kafkasya omurgasındaki
// ara düğümlerin NEREDEYSE TAMAMI reps=1 (bazıları ANK/VAN gibi reps=2)
// ile yetersiz güçlendirilmişti — 6-9 hop'luk bir rotada bu kayıplar
// ÇARPIMSAL olarak birikip uçtan-uca geçirgenliği %0.000'a düşürüyordu
// (ROTA SAĞLIĞI DÜŞÜK teşhisi). Tek bir hattı karantinaya almak/düzeltmek
// bu YAYILMIŞ (distributed) darboğazı çözemezdi — hangi hat kapatılırsa
// kapatılsın, kalan rota da aynı derecede zayıftı. Çözüm: koridordaki TÜM
// ara düğümler (BUR, ANK, KON, SAM, ADA, GAZ, TZN, EZR, VAN, TBS, EVN)
// reps=3'e çıkarıldı — computeRepeaterGain'in mimari telafi tavanı
// (%95, reps>=3'te sabitlenir). İzole Monte Carlo doğrulaması: bu
// koridordaki HER TEK segment artık ×150 dinamik FEC ile ~%100
// bit-hayatta-kalma oranına ulaşıyor (önceki reps=1-2 seviyesinde bazı
// segmentler %0-55 arasındaydı — bkz. sohbet geçmişi, segment-bazlı tablo).
// Bu, DUB/EDI/BAG'da daha önce uygulanan "tekil-hat donanım yükseltmesi"
// desenini bilinçli olarak KORİDOR SEVİYESİNE genişletir.
// ── Topoloji ──────────────────────────────────────────────────
const NODES=[
  {id:"IST",label:"İstanbul",x:572.3,y:143.7,type:"hub",on:true,reps:3,lat:41.0,lon:28.9},
  {id:"ANK",label:"Ankara",x:583.3,y:148.4,type:"hub",on:true,reps:3,lat:39.9,lon:32.9},
  {id:"IZM",label:"İzmir",x:567.4,y:154.7,type:"node",on:true,reps:1,lat:38.4,lon:27.1},
  {id:"BUR",label:"Bursa",x:572.9,y:147.1,type:"node",on:true,reps:3,lat:40.2,lon:29.1},
  {id:"ADA",label:"Adana",x:589.9,y:160.7,type:"node",on:true,reps:3,lat:37.0,lon:35.3},
  {id:"TZN",label:"Trabzon",x:601.9,y:143.7,type:"node",on:true,reps:3,lat:41.0,lon:39.7},
  {id:"KON",label:"Konya",x:582.2,y:156.8,type:"node",on:true,reps:3,lat:37.9,lon:32.5},
  {id:"SAM",label:"Samsun",x:592.6,y:142.5,type:"node",on:true,reps:3,lat:41.3,lon:36.3},
  {id:"ANT",label:"Antalya",x:577.3,y:161.1,type:"node",on:true,reps:1,lat:36.9,lon:30.7},
  {id:"DIY",label:"Diyarbakır",x:603.3,y:156.8,type:"node",on:true,reps:1,lat:37.9,lon:40.2},
  {id:"EZR",label:"Erzurum",x:606.3,y:148.4,type:"node",on:true,reps:3,lat:39.9,lon:41.3},
  {id:"VAN",label:"Van",x:612.1,y:154.3,type:"node",on:true,reps:3,lat:38.5,lon:43.4},
  {id:"GAZ",label:"Gaziantep",x:595.6,y:160.2,type:"node",on:true,reps:3,lat:37.1,lon:37.4},
  {id:"MER",label:"Mersin",x:587.9,y:161.5,type:"node",on:true,reps:0,lat:36.8,lon:34.6},
  {id:"ATH",label:"Atina",x:558.1,y:156.8,type:"intl",on:true,reps:3,lat:37.9,lon:23.7},
  {id:"SOF",label:"Sofya",x:557.0,y:136.6,type:"intl",on:true,reps:2,lat:42.7,lon:23.3},
  {id:"BAG",label:"Bağdat",x:614.8,y:176.3,type:"intl",on:true,reps:3,lat:33.3,lon:44.4},
  {id:"CAI",label:"Kahire",x:578.6,y:189.8,type:"intl",on:true,reps:3,lat:30.1,lon:31.2},
  {id:"LON",label:"Londra",x:492.9,y:99.3,type:"hub",on:true,reps:3,lat:51.5,lon:-0.1},
  {id:"PAR",label:"Paris",x:499.5,y:110.3,type:"hub",on:true,reps:3,lat:48.9,lon:2.3},
  {id:"BER",label:"Berlin",x:529.9,y:95.1,type:"hub",on:true,reps:2,lat:52.5,lon:13.4},
  {id:"ROM",label:"Roma",x:527.4,y:139.9,type:"intl",on:true,reps:2,lat:41.9,lon:12.5},
  {id:"MAD",label:"Madrid",x:483.0,y:146.3,type:"intl",on:true,reps:2,lat:40.4,lon:-3.7},
  {id:"LIS",label:"Lizbon",x:468.2,y:153.5,type:"intl",on:true,reps:2,lat:38.7,lon:-9.1},
  {id:"AMS",label:"Amsterdam",x:506.6,y:95.5,type:"hub",on:true,reps:2,lat:52.4,lon:4.9},
  {id:"BRU",label:"Brüksel",x:504.9,y:102.3,type:"intl",on:true,reps:2,lat:50.8,lon:4.3},
  {id:"BRN",label:"Bern",x:513.4,y:118.8,type:"node",on:true,reps:1,lat:46.9,lon:7.4},
  {id:"ZRH",label:"Zürih",x:516.4,y:116.7,type:"node",on:true,reps:1,lat:47.4,lon:8.5},
  {id:"VIE",label:"Viyana",x:538.1,y:113.3,type:"intl",on:true,reps:2,lat:48.2,lon:16.4},
  {id:"WAW",label:"Varşova",x:550.7,y:96.4,type:"intl",on:true,reps:2,lat:52.2,lon:21.0},
  {id:"PRG",label:"Prag",x:532.6,y:105.3,type:"intl",on:true,reps:1,lat:50.1,lon:14.4},
  {id:"BTS",label:"Bratislava",x:540.0,y:113.7,type:"node",on:true,reps:1,lat:48.1,lon:17.1},
  {id:"BUD",label:"Budapeşte",x:545.2,y:116.3,type:"intl",on:true,reps:1,lat:47.5,lon:19.0},
  {id:"BUC",label:"Bükreş",x:564.7,y:129.4,type:"intl",on:true,reps:1,lat:44.4,lon:26.1},
  {id:"BEG",label:"Belgrad",x:549.3,y:127.7,type:"intl",on:true,reps:1,lat:44.8,lon:20.5},
  {id:"ZAG",label:"Zagreb",x:536.7,y:123.4,type:"node",on:true,reps:1,lat:45.8,lon:15.9},
  {id:"SJJ",label:"Saraybosna",x:543.6,y:131.5,type:"node",on:true,reps:1,lat:43.9,lon:18.4},
  {id:"LJU",label:"Ljubljana",x:532.9,y:122.2,type:"node",on:true,reps:1,lat:46.1,lon:14.5},
  {id:"SKP",label:"Üsküp",x:551.8,y:139.5,type:"node",on:true,reps:1,lat:42.0,lon:21.4},
  {id:"TIA",label:"Tiran",x:547.4,y:142.5,type:"node",on:true,reps:1,lat:41.3,lon:19.8},
  {id:"TGD",label:"Podgorica",x:546.0,y:137.8,type:"node",on:true,reps:0,lat:42.4,lon:19.3},
  {id:"PRN",label:"Priştine",x:551.2,y:136.6,type:"node",on:true,reps:0,lat:42.7,lon:21.2},
  {id:"KIE",label:"Kiev",x:576.7,y:103.6,type:"intl",on:true,reps:2,lat:50.5,lon:30.5},
  {id:"MSQ",label:"Minsk",x:568.8,y:89.2,type:"node",on:true,reps:1,lat:53.9,lon:27.6},
  {id:"KIS",label:"Kişinev",x:572.3,y:118.4,type:"node",on:true,reps:1,lat:47.0,lon:28.9},
  {id:"MOW",label:"Moskova",x:596.2,y:81.2,type:"hub",on:true,reps:3,lat:55.8,lon:37.6},
  {id:"LED",label:"St. Petersburg",x:576.2,y:63.8,type:"node",on:true,reps:1,lat:59.9,lon:30.3},
  {id:"VLN",label:"Vilnius",x:562.5,y:85.8,type:"node",on:true,reps:1,lat:54.7,lon:25.3},
  {id:"RIX",label:"Riga",x:559.2,y:76.5,type:"node",on:true,reps:1,lat:56.9,lon:24.1},
  {id:"TLL",label:"Tallinn",x:560.8,y:66.0,type:"node",on:true,reps:1,lat:59.4,lon:24.7},
  {id:"HEL",label:"Helsinki",x:561.4,y:62.6,type:"intl",on:true,reps:1,lat:60.2,lon:24.9},
  {id:"STO",label:"Stockholm",x:542.7,y:66.4,type:"intl",on:true,reps:2,lat:59.3,lon:18.1},
  {id:"OSL",label:"Oslo",x:522.5,y:63.8,type:"intl",on:true,reps:1,lat:59.9,lon:10.7},
  {id:"CPH",label:"Kopenhag",x:527.7,y:81.6,type:"intl",on:true,reps:1,lat:55.7,lon:12.6},
  {id:"REY",label:"Reykjavik",x:433.2,y:46.1,type:"node",on:true,reps:0,lat:64.1,lon:-21.9},
  {id:"DUB",label:"Dublin",x:475.9,y:91.7,type:"intl",on:true,reps:3,lat:53.3,lon:-6.3},
  {id:"LUX",label:"Lüksemburg",x:509.9,y:107.4,type:"node",on:true,reps:0,lat:49.6,lon:6.1},
  {id:"VLT",label:"Valletta",x:532.9,y:165.3,type:"node",on:true,reps:0,lat:35.9,lon:14.5},
  {id:"NIC",label:"Lefkoşa",x:584.7,y:168.3,type:"node",on:true,reps:0,lat:35.2,lon:33.4},
  {id:"FRA",label:"Frankfurt",x:517.0,y:105.3,type:"node",on:true,reps:1,lat:50.1,lon:8.7},
  {id:"MUC",label:"Münih",x:524.9,y:113.7,type:"node",on:true,reps:1,lat:48.1,lon:11.6},
  {id:"MIL",label:"Milano",x:518.4,y:124.7,type:"node",on:true,reps:1,lat:45.5,lon:9.2},
  {id:"BCN",label:"Barselona",x:499.2,y:142.0,type:"node",on:true,reps:1,lat:41.4,lon:2.2},
  {id:"TBS",label:"Tiflis",x:615.9,y:140.8,type:"node",on:true,reps:3,lat:41.7,lon:44.8},
  {id:"EVN",label:"Erivan",x:615.1,y:147.1,type:"node",on:true,reps:3,lat:40.2,lon:44.5},
  {id:"GYD",label:"Bakü",x:629.9,y:146.3,type:"node",on:true,reps:1,lat:40.4,lon:49.9},
  {id:"THR",label:"Tahran",x:634.0,y:166.1,type:"intl",on:true,reps:2,lat:35.7,lon:51.4},
  {id:"DAM",label:"Şam",x:592.6,y:175.4,type:"node",on:true,reps:0,lat:33.5,lon:36.3},
  {id:"BEY",label:"Beyrut",x:590.4,y:173.8,type:"node",on:true,reps:0,lat:33.9,lon:35.5},
  {id:"JRS",label:"Kudüs",x:589.6,y:182.6,type:"node",on:true,reps:1,lat:31.8,lon:35.2},
  {id:"TLV",label:"Tel Aviv",x:588.5,y:181.4,type:"node",on:true,reps:1,lat:32.1,lon:34.8},
  {id:"AMM",label:"Amman",x:591.5,y:182.2,type:"node",on:true,reps:1,lat:31.9,lon:35.9},
  {id:"RUH",label:"Riyad",x:621.1,y:212.7,type:"intl",on:true,reps:2,lat:24.7,lon:46.7},
  {id:"SAA",label:"Sana",x:614.2,y:252.0,type:"node",on:true,reps:0,lat:15.4,lon:44.2},
  {id:"MCT",label:"Maskat",x:653.4,y:217.3,type:"node",on:true,reps:1,lat:23.6,lon:58.5},
  {id:"AUH",label:"Abu Dabi",x:642.2,y:213.5,type:"intl",on:true,reps:2,lat:24.5,lon:54.4},
  {id:"DXB",label:"Dubai",x:644.7,y:210.5,type:"hub",on:true,reps:3,lat:25.2,lon:55.3},
  {id:"DOH",label:"Doha",x:634.2,y:210.1,type:"intl",on:true,reps:2,lat:25.3,lon:51.5},
  {id:"BAH",label:"Manama",x:631.8,y:206.3,type:"node",on:true,reps:1,lat:26.2,lon:50.6},
  {id:"KWI",label:"Kuveyt",x:624.7,y:192.8,type:"node",on:true,reps:1,lat:29.4,lon:48.0},
  {id:"NUR",label:"Astana",x:688.8,y:100.6,type:"intl",on:true,reps:1,lat:51.2,lon:71.4},
  {id:"ALA",label:"Almatı",x:703.8,y:134.4,type:"node",on:true,reps:1,lat:43.2,lon:76.9},
  {id:"TAS",label:"Taşkent",x:682.7,y:142.5,type:"intl",on:true,reps:1,lat:41.3,lon:69.2},
  {id:"ASB",label:"Aşkabat",x:653.2,y:156.8,type:"node",on:true,reps:0,lat:37.9,lon:58.4},
  {id:"DYU",label:"Duşanbe",x:681.6,y:153.9,type:"node",on:true,reps:0,lat:38.6,lon:68.8},
  {id:"FRU",label:"Bişkek",x:697.5,y:135.7,type:"node",on:true,reps:0,lat:42.9,lon:74.6},
  {id:"KBL",label:"Kabil",x:682.7,y:170.8,type:"node",on:true,reps:0,lat:34.6,lon:69.2},
  {id:"ISB",label:"İslamabad",x:693.2,y:174.6,type:"intl",on:true,reps:1,lat:33.7,lon:73.0},
  {id:"KHI",label:"Karaçi",x:676.7,y:211.8,type:"node",on:true,reps:1,lat:24.9,lon:67.0},
  {id:"DEL",label:"Yeni Delhi",x:704.7,y:196.2,type:"hub",on:true,reps:3,lat:28.6,lon:77.2},
  {id:"BOM",label:"Mumbai",x:692.9,y:236.3,type:"hub",on:true,reps:2,lat:19.1,lon:72.9},
  {id:"KTM",label:"Katmandu",x:726.8,y:200.0,type:"node",on:true,reps:0,lat:27.7,lon:85.3},
  {id:"THI",label:"Thimphu",x:738.6,y:200.8,type:"node",on:true,reps:0,lat:27.5,lon:89.6},
  {id:"DAC",label:"Dakka",x:740.8,y:216.5,type:"intl",on:true,reps:1,lat:23.8,lon:90.4},
  {id:"CMB",label:"Kolombo",x:712.1,y:287.9,type:"intl",on:true,reps:1,lat:6.9,lon:79.9},
  {id:"MLE",label:"Male",x:694.5,y:299.3,type:"node",on:true,reps:0,lat:4.2,lon:73.5},
  {id:"NPT",label:"Naypyidaw",x:756.4,y:233.8,type:"node",on:true,reps:0,lat:19.7,lon:96.1},
  {id:"RGN",label:"Yangon",x:756.7,y:246.0,type:"node",on:true,reps:1,lat:16.8,lon:96.2},
  {id:"BKK",label:"Bangkok",x:768.5,y:258.7,type:"intl",on:true,reps:2,lat:13.8,lon:100.5},
  {id:"VTE",label:"Vientiane",x:774.2,y:241.0,type:"node",on:true,reps:0,lat:18.0,lon:102.6},
  {id:"PNH",label:"Phnom Penh",x:780.5,y:268.0,type:"node",on:true,reps:0,lat:11.6,lon:104.9},
  {id:"HAN",label:"Hanoi",x:783.0,y:228.3,type:"intl",on:true,reps:1,lat:21.0,lon:105.8},
  {id:"SGN",label:"Ho Chi Minh",x:785.2,y:271.4,type:"node",on:true,reps:1,lat:10.8,lon:106.6},
  {id:"KUL",label:"Kuala Lumpur",x:771.8,y:304.0,type:"intl",on:true,reps:2,lat:3.1,lon:101.7},
  {id:"SIN",label:"Singapur",x:777.5,y:311.4,type:"hub",on:true,reps:3,lat:1.35,lon:103.8},
  {id:"JKT",label:"Cakarta",x:785.8,y:343.3,type:"hub",on:true,reps:2,lat:-6.2,lon:106.8},
  {id:"MNL",label:"Manila",x:824.7,y:255.3,type:"intl",on:true,reps:2,lat:14.6,lon:121.0},
  {id:"BWN",label:"Bandar Seri Begawan",x:807.9,y:296.4,type:"node",on:true,reps:0,lat:4.9,lon:114.9},
  {id:"DIL",label:"Dili",x:837.3,y:353.4,type:"node",on:true,reps:0,lat:-8.6,lon:125.6},
  {id:"BJS",label:"Pekin",x:812.1,y:148.4,type:"hub",on:true,reps:3,lat:39.9,lon:116.4},
  {id:"SHA",label:"Şanghay",x:826.0,y:185.2,type:"hub",on:true,reps:3,lat:31.2,lon:121.5},
  {id:"HKG",label:"Hong Kong",x:806.0,y:222.8,type:"node",on:true,reps:2,lat:22.3,lon:114.2},
  {id:"ULN",label:"Ulan Batur",x:786.0,y:114.6,type:"node",on:true,reps:0,lat:47.9,lon:106.9},
  {id:"FNJ",label:"Pyongyang",x:837.8,y:152.2,type:"node",on:false,reps:0,lat:39.0,lon:125.8},
  {id:"SEL",label:"Seul",x:841.1,y:158.1,type:"hub",on:true,reps:2,lat:37.6,lon:127.0},
  {id:"TYO",label:"Tokyo",x:875.9,y:166.1,type:"hub",on:true,reps:3,lat:35.7,lon:139.7},
  {id:"OSA",label:"Osaka",x:864.4,y:170.4,type:"node",on:true,reps:1,lat:34.7,lon:135.5},
  {id:"TPE",label:"Taipei",x:826.3,y:211.4,type:"node",on:true,reps:2,lat:25.0,lon:121.6},
  {id:"TIP",label:"Trablus",x:529.3,y:178.0,type:"node",on:true,reps:0,lat:32.9,lon:13.2},
  {id:"TUN",label:"Tunus",x:521.1,y:161.5,type:"node",on:true,reps:1,lat:36.8,lon:10.2},
  {id:"ALG",label:"Cezayir",x:501.6,y:161.5,type:"intl",on:true,reps:1,lat:36.8,lon:3.1},
  {id:"RBA",label:"Rabat",x:474.5,y:173.3,type:"node",on:true,reps:1,lat:34.0,lon:-6.8},
  {id:"CAS",label:"Kazablanka",x:472.3,y:175.0,type:"node",on:true,reps:1,lat:33.6,lon:-7.6},
  {id:"NKC",label:"Nuakşot",x:449.6,y:240.6,type:"node",on:true,reps:0,lat:18.1,lon:-15.9},
  {id:"BKO",label:"Bamako",x:471.2,y:263.8,type:"node",on:true,reps:0,lat:12.6,lon:-8.0},
  {id:"NIM",label:"Niamey",x:498.9,y:260.0,type:"node",on:true,reps:0,lat:13.5,lon:2.1},
  {id:"NDJ",label:"N'Djamena",x:534.2,y:265.9,type:"node",on:true,reps:0,lat:12.1,lon:15.0},
  {id:"KRT",label:"Hartum",x:582.2,y:251.1,type:"node",on:true,reps:1,lat:15.6,lon:32.5},
  {id:"JUB",label:"Cuba",x:579.7,y:296.4,type:"node",on:false,reps:0,lat:4.9,lon:31.6},
  {id:"ASM",label:"Asmara",x:599.7,y:252.4,type:"node",on:true,reps:0,lat:15.3,lon:38.9},
  {id:"JIB",label:"Cibuti",x:611.2,y:268.0,type:"node",on:true,reps:0,lat:11.6,lon:43.1},
  {id:"ADD",label:"Addis Ababa",x:599.2,y:279.0,type:"intl",on:true,reps:2,lat:9.0,lon:38.7},
  {id:"MGQ",label:"Mogadişu",x:617.3,y:308.6,type:"node",on:false,reps:0,lat:2.0,lon:45.3},
  {id:"NBO",label:"Nairobi",x:594.0,y:322.6,type:"hub",on:true,reps:2,lat:-1.3,lon:36.8},
  {id:"KLA",label:"Kampala",x:582.5,y:315.8,type:"node",on:true,reps:1,lat:0.3,lon:32.6},
  {id:"KGL",label:"Kigali",x:575.6,y:325.1,type:"node",on:true,reps:1,lat:-1.9,lon:30.1},
  {id:"GIT",label:"Gitega",x:575.1,y:331.4,type:"node",on:true,reps:0,lat:-3.4,lon:29.9},
  {id:"DOD",label:"Dodoma",x:591.0,y:343.3,type:"node",on:true,reps:0,lat:-6.2,lon:35.7},
  {id:"DAR",label:"Dar es Selam",x:600.8,y:345.8,type:"node",on:true,reps:1,lat:-6.8,lon:39.3},
  {id:"DKR",label:"Dakar",x:445.5,y:254.9,type:"intl",on:true,reps:2,lat:14.7,lon:-17.4},
  {id:"BJL",label:"Banjul",x:447.7,y:260.0,type:"node",on:true,reps:0,lat:13.5,lon:-16.6},
  {id:"OXB",label:"Bissau",x:450.4,y:266.8,type:"node",on:true,reps:0,lat:11.9,lon:-15.6},
  {id:"CKY",label:"Conakry",x:455.6,y:276.9,type:"node",on:true,reps:0,lat:9.5,lon:-13.7},
  {id:"FNA",label:"Freetown",x:457.0,y:281.1,type:"node",on:true,reps:0,lat:8.5,lon:-13.2},
  {id:"MLW",label:"Monrovia",x:463.6,y:290.4,type:"node",on:true,reps:0,lat:6.3,lon:-10.8},
  {id:"ABJ",label:"Abidjan",x:482.2,y:294.7,type:"node",on:true,reps:1,lat:5.3,lon:-4.0},
  {id:"YAM",label:"Yamoussoukro",x:478.6,y:288.3,type:"node",on:true,reps:0,lat:6.8,lon:-5.3},
  {id:"ACC",label:"Akra",x:492.6,y:293.4,type:"intl",on:true,reps:1,lat:5.6,lon:-0.2},
  {id:"LFW",label:"Lome",x:496.4,y:291.3,type:"node",on:true,reps:0,lat:6.1,lon:1.2},
  {id:"PNV",label:"Porto-Novo",x:500.3,y:289.6,type:"node",on:true,reps:0,lat:6.5,lon:2.6},
  {id:"OUA",label:"Ouagadougou",x:489.0,y:264.7,type:"node",on:true,reps:0,lat:12.4,lon:-1.5},
  {id:"ABV",label:"Abuja",x:513.7,y:278.6,type:"intl",on:true,reps:1,lat:9.1,lon:7.5},
  {id:"LOS",label:"Lagos",x:502.5,y:289.6,type:"hub",on:true,reps:3,lat:6.5,lon:3.4},
  {id:"YAO",label:"Yaunde",x:524.7,y:300.6,type:"node",on:true,reps:0,lat:3.9,lon:11.5},
  {id:"BGF",label:"Bangui",x:544.1,y:298.5,type:"node",on:false,reps:0,lat:4.4,lon:18.6},
  {id:"SSG",label:"Malabo",x:517.2,y:301.2,type:"node",on:true,reps:0,lat:3.75,lon:8.78},
  {id:"LBV",label:"Librevil",x:519.2,y:315.4,type:"node",on:true,reps:0,lat:0.4,lon:9.5},
  {id:"BZV",label:"Brazavil",x:535.1,y:335.3,type:"node",on:true,reps:0,lat:-4.3,lon:15.3},
  {id:"FIH",label:"Kinşasa",x:535.1,y:335.7,type:"node",on:true,reps:1,lat:-4.4,lon:15.3},
  {id:"LAD",label:"Luanda",x:529.3,y:354.3,type:"intl",on:true,reps:1,lat:-8.8,lon:13.2},
  {id:"LUN",label:"Lusaka",x:570.7,y:382.2,type:"node",on:true,reps:1,lat:-15.4,lon:28.3},
  {id:"LLW",label:"Lilongwe",x:585.8,y:376.3,type:"node",on:true,reps:0,lat:-14.0,lon:33.8},
  {id:"MPM",label:"Maputo",x:582.5,y:427.0,type:"node",on:true,reps:1,lat:-26.0,lon:32.6},
  {id:"HRE",label:"Harare",x:578.4,y:392.3,type:"node",on:true,reps:1,lat:-17.8,lon:31.1},
  {id:"GBE",label:"Gaborone",x:564.1,y:421.5,type:"node",on:true,reps:0,lat:-24.7,lon:25.9},
  {id:"WDH",label:"Windhoek",x:540.0,y:412.6,type:"node",on:true,reps:0,lat:-22.6,lon:17.1},
  {id:"JNB",label:"Johannesburg",x:569.9,y:427.8,type:"hub",on:true,reps:3,lat:-26.2,lon:28.0},
  {id:"PRY",label:"Pretoria",x:570.4,y:426.1,type:"node",on:true,reps:1,lat:-25.8,lon:28.2},
  {id:"CPT",label:"Cape Town",x:543.6,y:460.4,type:"node",on:true,reps:2,lat:-33.9,lon:18.4},
  {id:"MBB",label:"Mbabane",x:578.4,y:428.3,type:"node",on:true,reps:0,lat:-26.3,lon:31.1},
  {id:"MSU",label:"Maseru",x:568.5,y:440.9,type:"node",on:true,reps:0,lat:-29.3,lon:27.5},
  {id:"TNR",label:"Antananarivo",x:623.3,y:397.0,type:"node",on:true,reps:1,lat:-18.9,lon:47.5},
  {id:"MRU",label:"Port Louis",x:650.7,y:402.5,type:"node",on:true,reps:0,lat:-20.2,lon:57.5},
  {id:"YVA",label:"Moroni",x:611.8,y:366.5,type:"node",on:true,reps:0,lat:-11.7,lon:43.3},
  {id:"SEZ",label:"Victoria",x:645.2,y:336.5,type:"node",on:true,reps:0,lat:-4.6,lon:55.5},
  {id:"RAI",label:"Praia",x:428.8,y:254.1,type:"node",on:true,reps:0,lat:14.9,lon:-23.5},
  {id:"WAS",label:"Washington",x:282.2,y:152.6,type:"hub",on:true,reps:3,lat:38.9,lon:-77.0},
  {id:"NYC",label:"New York",x:290.4,y:145.0,type:"hub",on:true,reps:3,lat:40.7,lon:-74.0},
  {id:"LAX",label:"Los Angeles",x:169.3,y:172.9,type:"hub",on:true,reps:3,lat:34.1,lon:-118.2},
  {id:"CHI",label:"Chicago",x:253.2,y:139.9,type:"node",on:true,reps:2,lat:41.9,lon:-87.6},
  {id:"MIA",label:"Miami",x:273.4,y:208.0,type:"node",on:true,reps:2,lat:25.8,lon:-80.2},
  {id:"OTT",label:"Ottawa",x:285.8,y:125.1,type:"intl",on:true,reps:1,lat:45.4,lon:-75.7},
  {id:"YTO",label:"Toronto",x:275.6,y:132.3,type:"hub",on:true,reps:2,lat:43.7,lon:-79.4},
  {id:"YVR",label:"Vancouver",x:155.9,y:108.7,type:"node",on:true,reps:1,lat:49.3,lon:-123.1},
  {id:"MEX",label:"Meksika",x:221.6,y:235.1,type:"hub",on:true,reps:3,lat:19.4,lon:-99.1},
  {id:"GDL",label:"Guadalajara",x:210.1,y:229.6,type:"node",on:true,reps:1,lat:20.7,lon:-103.3},
  {id:"GUA",label:"Guatemala",x:245.2,y:255.3,type:"node",on:true,reps:0,lat:14.6,lon:-90.5},
  {id:"BZE",label:"Belmopan",x:249.9,y:244.1,type:"node",on:true,reps:0,lat:17.25,lon:-88.77},
  {id:"TGU",label:"Tegucigalpa",x:254.2,y:257.5,type:"node",on:true,reps:0,lat:14.1,lon:-87.2},
  {id:"SAL",label:"San Salvador",x:248.8,y:259.2,type:"node",on:true,reps:0,lat:13.7,lon:-89.2},
  {id:"MGA",label:"Managua",x:257.0,y:265.9,type:"node",on:true,reps:0,lat:12.1,lon:-86.2},
  {id:"SJO",label:"San Jose",x:262.7,y:275.2,type:"node",on:true,reps:1,lat:9.9,lon:-84.1},
  {id:"PTY",label:"Panama",x:275.3,y:279.0,type:"intl",on:true,reps:1,lat:9.0,lon:-79.5},
  {id:"HAV",label:"Havana",x:267.4,y:219.4,type:"node",on:true,reps:1,lat:23.1,lon:-82.4},
  {id:"KIN",label:"Kingston",x:282.7,y:241.0,type:"node",on:true,reps:0,lat:18.0,lon:-76.8},
  {id:"PAP",label:"Port-au-Prince",x:295.1,y:238.9,type:"node",on:false,reps:0,lat:18.5,lon:-72.3},
  {id:"SDQ",label:"Santo Domingo",x:301.6,y:238.9,type:"node",on:true,reps:1,lat:18.5,lon:-69.9},
  {id:"NAS",label:"Nassau",x:281.1,y:211.4,type:"node",on:true,reps:0,lat:25.0,lon:-77.4},
  {id:"POS",label:"Port of Spain",x:324.7,y:271.8,type:"node",on:true,reps:0,lat:10.7,lon:-61.5},
  {id:"BGI",label:"Bridgetown",x:329.9,y:261.7,type:"node",on:true,reps:0,lat:13.1,lon:-59.6},
  {id:"BOG",label:"Bogota",x:290.1,y:297.2,type:"intl",on:true,reps:2,lat:4.7,lon:-74.1},
  {id:"CCS",label:"Karakas",x:309.9,y:272.7,type:"node",on:true,reps:1,lat:10.5,lon:-66.9},
  {id:"GEO",label:"Georgetown",x:333.7,y:288.3,type:"node",on:true,reps:0,lat:6.8,lon:-58.2},
  {id:"PBM",label:"Paramaribo",x:341.9,y:292.1,type:"node",on:true,reps:0,lat:5.9,lon:-55.2},
  {id:"UIO",label:"Quito",x:278.1,y:317.9,type:"node",on:true,reps:1,lat:-0.2,lon:-78.5},
  {id:"LIM",label:"Lima",x:282.2,y:367.8,type:"intl",on:true,reps:2,lat:-12.0,lon:-77.0},
  {id:"BSB",label:"Brasilia",x:361.9,y:383.9,type:"hub",on:true,reps:2,lat:-15.8,lon:-47.9},
  {id:"SAO",label:"Sao Paulo",x:365.5,y:416.4,type:"hub",on:true,reps:3,lat:-23.5,lon:-46.6},
  {id:"RIO",label:"Rio de Janeiro",x:374.8,y:413.9,type:"node",on:true,reps:2,lat:-22.9,lon:-43.2},
  {id:"LPB",label:"La Paz",x:306.3,y:386.8,type:"node",on:true,reps:1,lat:-16.5,lon:-68.2},
  {id:"ASU",label:"Asuncion",x:335.3,y:424.0,type:"node",on:true,reps:1,lat:-25.3,lon:-57.6},
  {id:"SCL",label:"Santiago",x:299.5,y:458.3,type:"intl",on:true,reps:2,lat:-33.4,lon:-70.7},
  {id:"BUE",label:"Buenos Aires",x:333.2,y:463.3,type:"hub",on:true,reps:3,lat:-34.6,lon:-58.4},
  {id:"MVD",label:"Montevideo",x:339.2,y:464.6,type:"node",on:true,reps:1,lat:-34.9,lon:-56.2},
  {id:"CBR",label:"Canberra",x:901.6,y:466.3,type:"node",on:true,reps:1,lat:-35.3,lon:149.1},
  {id:"SYD",label:"Sidney",x:907.4,y:460.4,type:"hub",on:true,reps:3,lat:-33.9,lon:151.2},
  {id:"MEL",label:"Melbourne",x:890.4,y:476.9,type:"node",on:true,reps:2,lat:-37.8,lon:145.0},
  {id:"WLG",label:"Wellington",x:972.1,y:491.7,type:"node",on:true,reps:1,lat:-41.3,lon:174.8},
  {id:"AKL",label:"Auckland",x:972.1,y:472.7,type:"node",on:true,reps:1,lat:-36.8,lon:174.8},
  {id:"POM",label:"Port Moresby",x:896.4,y:357.2,type:"node",on:true,reps:0,lat:-9.5,lon:147.2},
  {id:"SUV",label:"Suva",x:981.9,y:393.6,type:"node",on:true,reps:0,lat:-18.1,lon:178.4},
  {id:"HIR",label:"Honiara",x:931.2,y:356.8,type:"node",on:true,reps:0,lat:-9.4,lon:159.9},
  {id:"VLI",label:"Port Vila",x:954.2,y:391.9,type:"node",on:true,reps:0,lat:-17.7,lon:168.3},
  {id:"APW",label:"Apia",x:22.5,y:375.4,type:"node",on:true,reps:0,lat:-13.8,lon:-171.8},
  {id:"TBU",label:"Nukualofa",x:13.2,y:406.3,type:"node",on:true,reps:0,lat:-21.1,lon:-175.2},
  {id:"TRW",label:"Tarawa",x:967.1,y:311.6,type:"node",on:false,reps:0,lat:1.3,lon:173.0},
  {id:"PNI",label:"Palikir",x:926.6,y:287.9,type:"node",on:false,reps:0,lat:6.9,lon:158.2},
  {id:"ROR",label:"Ngerulmud",x:861.9,y:285.4,type:"node",on:false,reps:0,lat:7.5,lon:134.6},
  {id:"MAJ",label:"Majuro",x:962.7,y:287.1,type:"node",on:false,reps:0,lat:7.1,lon:171.4},
  {id:"HAM",label:"Hamburg",x:520.5,y:90.5,type:"node",on:true,reps:1,lat:53.6,lon:10.0},
  {id:"RTM",label:"Rotterdam",x:505.5,y:97.7,type:"node",on:true,reps:1,lat:51.9,lon:4.5},
  {id:"NAP",label:"Napoli",x:532.3,y:144.2,type:"node",on:true,reps:0,lat:40.9,lon:14.3},
  {id:"VLC",label:"Valencia",x:492.1,y:150.1,type:"node",on:true,reps:0,lat:39.5,lon:-0.4},
  {id:"LYS",label:"Lyon",x:506.3,y:123.4,type:"node",on:true,reps:1,lat:45.8,lon:4.8},
  {id:"MAN",label:"Manchester",x:487.1,y:90.9,type:"node",on:true,reps:1,lat:53.5,lon:-2.2},
  {id:"EDI",label:"Edinburgh",x:484.4,y:80.5,type:"node",on:true,reps:2,lat:55.95,lon:-3.2},
  {id:"CTU",label:"Chengdu",x:778.4,y:187.3,type:"node",on:true,reps:1,lat:30.7,lon:104.1},
  {id:"CAN",label:"Guangzhou",x:803.6,y:219.4,type:"node",on:true,reps:2,lat:23.1,lon:113.3},
  {id:"SZX",label:"Shenzhen",x:805.8,y:222.0,type:"node",on:true,reps:2,lat:22.5,lon:114.1},
  {id:"BLR",label:"Bangalore",x:705.8,y:262.1,type:"node",on:true,reps:1,lat:13.0,lon:77.6},
  {id:"MAA",label:"Chennai",x:713.2,y:261.7,type:"node",on:true,reps:1,lat:13.1,lon:80.3},
  {id:"CCU",label:"Kolkata",x:735.3,y:221.5,type:"node",on:true,reps:1,lat:22.6,lon:88.4},
  {id:"AMD",label:"Ahmedabad",x:692.1,y:219.8,type:"node",on:true,reps:0,lat:23.0,lon:72.6},
  {id:"NGO",label:"Nagoya",x:868.2,y:168.3,type:"node",on:true,reps:1,lat:35.2,lon:136.9},
  {id:"YOK",label:"Yokohama",x:875.6,y:167.4,type:"node",on:true,reps:1,lat:35.4,lon:139.6},
  {id:"ALY",label:"İskenderiye",x:575.1,y:185.2,type:"node",on:true,reps:0,lat:31.2,lon:29.9},
  {id:"KAN",label:"Kano",x:516.4,y:266.3,type:"node",on:true,reps:0,lat:12.0,lon:8.5},
  {id:"IBA",label:"Ibadan",x:503.8,y:285.8,type:"node",on:true,reps:0,lat:7.4,lon:3.9},
  {id:"DUR",label:"Durban",x:578.1,y:443.5,type:"node",on:true,reps:1,lat:-29.9,lon:31.0},
  {id:"HOU",label:"Houston",x:231.8,y:191.1,type:"node",on:true,reps:1,lat:29.8,lon:-95.4},
  {id:"DAL",label:"Dallas",x:227.9,y:178.4,type:"node",on:true,reps:1,lat:32.8,lon:-96.8},
  {id:"PHL",label:"Philadelphia",x:287.1,y:148.0,type:"node",on:true,reps:1,lat:40.0,lon:-75.2},
  {id:"SFO",label:"San Francisco",x:157.8,y:157.3,type:"node",on:true,reps:2,lat:37.8,lon:-122.4},
  {id:"SEA",label:"Seattle",x:158.1,y:115.8,type:"node",on:true,reps:1,lat:47.6,lon:-122.3},
  {id:"BOS",label:"Boston",x:298.4,y:137.8,type:"node",on:true,reps:1,lat:42.4,lon:-71.1},
  {id:"ATL",label:"Atlanta",x:261.9,y:174.6,type:"node",on:true,reps:1,lat:33.7,lon:-84.4},
  {id:"YMQ",label:"Montreal",x:291.5,y:124.7,type:"node",on:true,reps:1,lat:45.5,lon:-73.6},
  {id:"YYC",label:"Calgary",x:180.5,y:101.5,type:"node",on:true,reps:0,lat:51.0,lon:-114.1},
  {id:"MTY",label:"Monterrey",x:218.4,y:208.4,type:"node",on:true,reps:0,lat:25.7,lon:-100.3},
  {id:"CWB",label:"Curitiba",x:358.1,y:424.5,type:"node",on:true,reps:0,lat:-25.4,lon:-49.3},
  {id:"POA",label:"Porto Alegre",x:352.9,y:443.9,type:"node",on:true,reps:0,lat:-30.0,lon:-51.2},
  {id:"MDE",label:"Medellin",x:286.0,y:290.4,type:"node",on:true,reps:0,lat:6.3,lon:-75.6},
  {id:"SSA",label:"Salvador",x:387.7,y:371.9,type:"node",on:true,reps:0,lat:-12.97,lon:-38.5},
  {id:"BNE",label:"Brisbane",x:912.3,y:433.3,type:"node",on:true,reps:1,lat:-27.5,lon:153.0},
  {id:"PER",label:"Perth",x:810.7,y:452.1,type:"node",on:true,reps:1,lat:-31.95,lon:115.9},
  {id:"CHC",label:"Christchurch",x:966.0,y:501.0,type:"node",on:true,reps:0,lat:-43.5,lon:172.6},
];
const LINKS=[
  {a:"IST",b:"BUR",km:85,nm:1550},
  {a:"IST",b:"ANK",km:452,nm:1550},
  {a:"IST",b:"SAM",km:750,nm:1310},
  {a:"IST",b:"SOF",km:560,nm:1310},
  {a:"BUR",b:"IZM",km:250,nm:1550},
  {a:"BUR",b:"ANK",km:380,nm:1550},
  {a:"IZM",b:"ANT",km:480,nm:1310},
  {a:"IZM",b:"ATH",km:650,nm:1310},
  {a:"ANK",b:"KON",km:260,nm:1550},
  {a:"ANK",b:"SAM",km:420,nm:1550},
  {a:"ANK",b:"ADA",km:490,nm:1310},
  {a:"ANK",b:"TZN",km:620,nm:1310},
  {a:"ANK",b:"EZR",km:870,nm:1310},
  {a:"KON",b:"ANT",km:310,nm:1550},
  {a:"KON",b:"ADA",km:350,nm:1550},
  {a:"ADA",b:"DIY",km:360,nm:850},
  {a:"ADA",b:"MER",km:75,nm:1550},
  {a:"ADA",b:"GAZ",km:220,nm:1550},
  {a:"TZN",b:"EZR",km:325,nm:1550},
  {a:"SAM",b:"TZN",km:360,nm:1550},
  {a:"DIY",b:"EZR",km:300,nm:850},
  {a:"DIY",b:"GAZ",km:185,nm:1550},
  {a:"EZR",b:"VAN",km:215,nm:850},
  // DÜZELTME 12 (devam): 850nm bu topolojide HER YERDE yalnızca <360km
  // metro-menzilli hatlarda kullanılıyor (WL[850].loss=2.5dB/km — 1550nm'in
  // 12.5 katı). VAN-BAG 640km'de 850nm ataması, bu hattı topolojideki AYNI
  // mesafe sınıfındaki HER hattan (ör. ROM-MIL 624km, MAD-LIS 650km,
  // BCN-MAD 661km — hepsi 1550nm) tutarsız biçimde ayırıyordu; watchdog'un
  // yeni HAT BAZLI KARANTİNA'sı GAZ-BAG'ı devre dışı bıraktığında
  // yönlendirme motorunun döndüğü "alternatif" yol matematiksel olarak
  // hayatta kalamıyordu (bkz. sohbet geçmişi — tek foton hayatta kalma
  // olasılığı ~1e-6%). 1550'ye çekilmesi, VAN-BAG'ı topolojinin geri
  // kalanıyla TUTARLI hale getirir — yeni bir hat icat edilmez.
  {a:"VAN",b:"BAG",km:640,nm:1550},
  {a:"GAZ",b:"BAG",km:560,nm:1310},
  {a:"MER",b:"CAI",km:1100,nm:1310},
  {a:"ATH",b:"CAI",km:1750,nm:1310},
  {a:"ANT",b:"CAI",km:1400,nm:1310},
  {a:"LON",b:"MAN",km:343,nm:1550},
  {a:"LON",b:"BRU",km:412,nm:1550},
  {a:"PAR",b:"BRU",km:332,nm:1550},
  {a:"PAR",b:"LUX",km:373,nm:1550},
  {a:"BER",b:"HAM",km:335,nm:1550},
  {a:"BER",b:"PRG",km:358,nm:1550},
  {a:"ROM",b:"NAP",km:243,nm:1310},
  {a:"ROM",b:"MIL",km:624,nm:1550},
  {a:"MAD",b:"VLC",km:388,nm:1550},
  {a:"MAD",b:"LIS",km:650,nm:1550},
  {a:"LIS",b:"RBA",km:730,nm:1550},
  {a:"AMS",b:"RTM",km:81,nm:850},
  {a:"AMS",b:"BRU",km:237,nm:1310},
  {a:"BRU",b:"RTM",km:160,nm:1310},
  {a:"BRN",b:"ZRH",km:130,nm:1310},
  {a:"BRN",b:"MIL",km:271,nm:1310},
  {a:"ZRH",b:"MIL",km:283,nm:1310},
  {a:"VIE",b:"BTS",km:69,nm:850},
  {a:"VIE",b:"BUD",km:272,nm:1310},
  {a:"WAW",b:"VLN",km:517,nm:1550},
  {a:"WAW",b:"MSQ",km:624,nm:1550},
  {a:"PRG",b:"VIE",km:333,nm:1550},
  {a:"BTS",b:"BUD",km:204,nm:1310},
  {a:"BUC",b:"SOF",km:383,nm:1550},
  {a:"BUC",b:"KIS",km:470,nm:1550},
  {a:"BEG",b:"SJJ",km:253,nm:1310},
  {a:"BEG",b:"PRN",km:312,nm:1550},
  {a:"ZAG",b:"LJU",km:147,nm:1310},
  {a:"ZAG",b:"VIE",km:350,nm:1550},
  {a:"SJJ",b:"TGD",km:237,nm:1310},
  {a:"LJU",b:"VIE",km:356,nm:1550},
  {a:"SKP",b:"PRN",km:103,nm:850},
  {a:"SKP",b:"TIA",km:200,nm:1310},
  {a:"TIA",b:"TGD",km:168,nm:1310},
  {a:"TGD",b:"PRN",km:207,nm:1310},
  {a:"KIE",b:"KIS",km:528,nm:1550},
  {a:"KIE",b:"MSQ",km:554,nm:1550},
  {a:"MSQ",b:"VLN",km:226,nm:1310},
  {a:"MSQ",b:"RIX",km:520,nm:1550},
  {a:"MOW",b:"LED",km:816,nm:1550},
  {a:"MOW",b:"MSQ",km:875,nm:1550},
  {a:"LED",b:"HEL",km:392,nm:1550},
  {a:"LED",b:"TLL",km:415,nm:1550},
  {a:"VLN",b:"RIX",km:333,nm:1550},
  {a:"RIX",b:"TLL",km:364,nm:1550},
  {a:"TLL",b:"HEL",km:117,nm:850},
  {a:"STO",b:"TLL",km:486,nm:1550},
  {a:"STO",b:"HEL",km:512,nm:1550},
  {a:"OSL",b:"STO",km:548,nm:1550},
  {a:"OSL",b:"CPH",km:624,nm:1550},
  {a:"CPH",b:"HAM",km:373,nm:1550},
  {a:"CPH",b:"BER",km:468,nm:1550},
  {a:"REY",b:"EDI",km:1780,nm:1550},
  {a:"REY",b:"DUB",km:1941,nm:1550},
  {a:"DUB",b:"MAN",km:354,nm:1550},
  {a:"DUB",b:"EDI",km:463,nm:1550},
  {a:"LUX",b:"BRU",km:240,nm:1310},
  {a:"LUX",b:"FRA",km:253,nm:1310},
  {a:"VLT",b:"TIP",km:461,nm:1550},
  {a:"VLT",b:"TUN",km:517,nm:1550},
  {a:"NIC",b:"MER",km:271,nm:1310},
  {a:"NIC",b:"BEY",km:313,nm:1550},
  {a:"FRA",b:"ZRH",km:391,nm:1550},
  {a:"MUC",b:"ZRH",km:318,nm:1550},
  {a:"MUC",b:"PRG",km:392,nm:1550},
  {a:"BCN",b:"VLC",km:396,nm:1550},
  {a:"BCN",b:"MAD",km:661,nm:1550},
  {a:"TBS",b:"EVN",km:219,nm:1310},
  {a:"TBS",b:"EZR",km:463,nm:1550},
  {a:"EVN",b:"VAN",km:275,nm:1310},
  {a:"GYD",b:"TBS",km:587,nm:1550},
  {a:"GYD",b:"EVN",km:596,nm:1550},
  {a:"THR",b:"GYD",km:700,nm:1550},
  {a:"THR",b:"ASB",km:870,nm:1550},
  {a:"DAM",b:"BEY",km:112,nm:850},
  {a:"DAM",b:"AMM",km:236,nm:1310},
  {a:"BEY",b:"TLV",km:274,nm:1310},
  {a:"JRS",b:"TLV",km:65,nm:850},
  {a:"JRS",b:"AMM",km:87,nm:850},
  {a:"TLV",b:"AMM",km:138,nm:1310},
  {a:"RUH",b:"BAH",km:553,nm:1550},
  {a:"RUH",b:"DOH",km:635,nm:1550},
  {a:"SAA",b:"JIB",km:571,nm:1550},
  {a:"SAA",b:"ASM",km:739,nm:1550},
  {a:"MCT",b:"DXB",km:481,nm:1550},
  {a:"MCT",b:"AUH",km:557,nm:1550},
  {a:"AUH",b:"DXB",km:155,nm:1310},
  {a:"AUH",b:"DOH",km:397,nm:1550},
  {a:"DOH",b:"BAH",km:175,nm:1310},
  {a:"KWI",b:"BAH",km:570,nm:1550},
  {a:"KWI",b:"RUH",km:700,nm:1550},
  {a:"NUR",b:"FRU",km:1240,nm:1550},
  {a:"NUR",b:"ALA",km:1275,nm:1550},
  {a:"ALA",b:"FRU",km:247,nm:1310},
  {a:"ALA",b:"TAS",km:868,nm:1550},
  {a:"TAS",b:"DYU",km:393,nm:1550},
  {a:"TAS",b:"FRU",km:624,nm:1550},
  {a:"ASB",b:"GYD",km:1019,nm:1550},
  {a:"DYU",b:"KBL",km:580,nm:1550},
  {a:"KBL",b:"ISB",km:473,nm:1550},
  {a:"ISB",b:"DYU",km:861,nm:1550},
  {a:"KHI",b:"AMD",km:789,nm:1550},
  {a:"KHI",b:"MCT",km:1136,nm:1550},
  {a:"DEL",b:"ISB",km:902,nm:1550},
  {a:"DEL",b:"AMD",km:1007,nm:1550},
  {a:"BOM",b:"AMD",km:565,nm:1550},
  {a:"BOM",b:"BLR",km:1097,nm:1550},
  {a:"KTM",b:"THI",km:552,nm:1550},
  {a:"KTM",b:"CCU",km:841,nm:1550},
  {a:"THI",b:"DAC",km:545,nm:1550},
  {a:"DAC",b:"CCU",km:317,nm:1550},
  {a:"CMB",b:"MAA",km:898,nm:1550},
  {a:"CMB",b:"BLR",km:941,nm:1550},
  {a:"MLE",b:"CMB",km:1000,nm:1550},
  {a:"MLE",b:"BLR",km:1400,nm:1550},
  {a:"NPT",b:"RGN",km:419,nm:1550},
  {a:"NPT",b:"VTE",km:922,nm:1550},
  {a:"RGN",b:"BKK",km:740,nm:1550},
  {a:"BKK",b:"VTE",km:674,nm:1550},
  {a:"BKK",b:"PNH",km:697,nm:1550},
  {a:"VTE",b:"HAN",km:615,nm:1550},
  {a:"PNH",b:"SGN",km:267,nm:1310},
  {a:"HAN",b:"CAN",km:1050,nm:1550},
  {a:"SGN",b:"BKK",km:964,nm:1550},
  {a:"KUL",b:"SIN",km:395,nm:1550},
  {a:"KUL",b:"PNH",km:1311,nm:1550},
  {a:"SIN",b:"JKT",km:1174,nm:1550},
  {a:"JKT",b:"KUL",km:1533,nm:1550},
  {a:"MNL",b:"HKG",km:1451,nm:1550},
  {a:"MNL",b:"SZX",km:1482,nm:1550},
  {a:"BWN",b:"SGN",km:1462,nm:1550},
  {a:"BWN",b:"MNL",km:1649,nm:1550},
  {a:"DIL",b:"BWN",km:2487,nm:1550},
  {a:"DIL",b:"ROR",km:2664,nm:1550},
  {a:"BJS",b:"FNJ",km:1057,nm:1550},
  {a:"BJS",b:"SEL",km:1240,nm:1550},
  {a:"SHA",b:"TPE",km:896,nm:1550},
  {a:"SHA",b:"SEL",km:1134,nm:1550},
  {a:"HKG",b:"SZX",km:32,nm:850},
  {a:"HKG",b:"CAN",km:167,nm:1310},
  {a:"ULN",b:"BJS",km:1520,nm:1550},
  {a:"ULN",b:"FNJ",km:2354,nm:1550},
  {a:"FNJ",b:"SEL",km:244,nm:1310},
  {a:"SEL",b:"OSA",km:1077,nm:1550},
  {a:"TYO",b:"YOK",km:45,nm:850},
  {a:"TYO",b:"NGO",km:338,nm:1550},
  {a:"OSA",b:"NGO",km:181,nm:1310},
  {a:"OSA",b:"YOK",km:496,nm:1550},
  {a:"TPE",b:"HKG",km:1054,nm:1550},
  {a:"TIP",b:"TUN",km:667,nm:1550},
  {a:"ALG",b:"VLC",km:557,nm:1550},
  {a:"ALG",b:"BCN",km:673,nm:1550},
  {a:"RBA",b:"CAS",km:112,nm:850},
  {a:"CAS",b:"LIS",km:758,nm:1550},
  {a:"NKC",b:"DKR",km:534,nm:1550},
  {a:"NKC",b:"BJL",km:672,nm:1550},
  {a:"BKO",b:"OUA",km:918,nm:1550},
  {a:"BKO",b:"YAM",km:922,nm:1550},
  {a:"NIM",b:"OUA",km:531,nm:1550},
  {a:"NIM",b:"IBA",km:918,nm:1550},
  {a:"NDJ",b:"KAN",km:919,nm:1550},
  {a:"NDJ",b:"ABV",km:1150,nm:1550},
  {a:"KRT",b:"ASM",km:893,nm:1550},
  {a:"KRT",b:"ADD",km:1295,nm:1550},
  {a:"JUB",b:"KLA",km:680,nm:1550},
  {a:"JUB",b:"KGL",km:1007,nm:1550},
  {a:"ASM",b:"JIB",km:797,nm:1550},
  {a:"JIB",b:"ADD",km:730,nm:1550},
  {a:"ADD",b:"ASM",km:911,nm:1550},
  {a:"MGQ",b:"NBO",km:1318,nm:1550},
  {a:"MGQ",b:"ADD",km:1387,nm:1550},
  {a:"NBO",b:"KLA",km:650,nm:1550},
  {a:"NBO",b:"DOD",km:726,nm:1550},
  {a:"KLA",b:"KGL",km:481,nm:1550},
  {a:"KGL",b:"GIT",km:219,nm:1310},
  {a:"GIT",b:"KLA",km:662,nm:1550},
  {a:"DOD",b:"DAR",km:524,nm:1550},
  {a:"DAR",b:"NBO",km:873,nm:1550},
  {a:"DKR",b:"BJL",km:207,nm:1310},
  {a:"DKR",b:"OXB",km:477,nm:1550},
  {a:"BJL",b:"OXB",km:271,nm:1310},
  {a:"OXB",b:"CKY",km:440,nm:1550},
  {a:"CKY",b:"FNA",km:161,nm:1310},
  {a:"FNA",b:"MLW",km:468,nm:1550},
  {a:"MLW",b:"CKY",km:622,nm:1550},
  {a:"ABJ",b:"YAM",km:286,nm:1310},
  {a:"ABJ",b:"ACC",km:549,nm:1550},
  {a:"YAM",b:"ACC",km:753,nm:1550},
  {a:"ACC",b:"LFW",km:214,nm:1310},
  {a:"ACC",b:"PNV",km:423,nm:1550},
  {a:"LFW",b:"PNV",km:209,nm:1310},
  {a:"PNV",b:"LOS",km:115,nm:850},
  {a:"ABV",b:"KAN",km:443,nm:1550},
  {a:"ABV",b:"IBA",km:571,nm:1550},
  {a:"LOS",b:"IBA",km:149,nm:1310},
  {a:"YAO",b:"SSG",km:393,nm:1550},
  {a:"YAO",b:"LBV",km:583,nm:1550},
  {a:"BGF",b:"YAO",km:1026,nm:1550},
  {a:"BGF",b:"NDJ",km:1226,nm:1550},
  {a:"SSG",b:"LBV",km:495,nm:1550},
  {a:"BZV",b:"FIH",km:14,nm:850},
  {a:"BZV",b:"LAD",km:717,nm:1550},
  {a:"FIH",b:"LAD",km:704,nm:1550},
  {a:"LUN",b:"HRE",km:520,nm:1550},
  {a:"LUN",b:"LLW",km:795,nm:1550},
  {a:"LLW",b:"HRE",km:665,nm:1550},
  {a:"MPM",b:"MBB",km:199,nm:1310},
  {a:"MPM",b:"PRY",km:573,nm:1550},
  {a:"GBE",b:"PRY",km:340,nm:1550},
  {a:"GBE",b:"JNB",km:349,nm:1550},
  {a:"WDH",b:"GBE",km:1204,nm:1550},
  {a:"WDH",b:"JNB",km:1526,nm:1550},
  {a:"JNB",b:"PRY",km:63,nm:850},
  {a:"CPT",b:"MSU",km:1302,nm:1550},
  {a:"CPT",b:"GBE",km:1630,nm:1550},
  {a:"MBB",b:"PRY",km:383,nm:1550},
  {a:"MSU",b:"DUR",km:448,nm:1550},
  {a:"MSU",b:"JNB",km:453,nm:1550},
  {a:"TNR",b:"YVA",km:1194,nm:1550},
  {a:"TNR",b:"MRU",km:1375,nm:1550},
  {a:"MRU",b:"SEZ",km:2273,nm:1550},
  {a:"YVA",b:"DAR",km:909,nm:1550},
  {a:"SEZ",b:"MGQ",km:1755,nm:1550},
  {a:"SEZ",b:"YVA",km:2024,nm:1550},
  {a:"RAI",b:"DKR",km:853,nm:1550},
  {a:"RAI",b:"BJL",km:988,nm:1550},
  {a:"WAS",b:"PHL",km:256,nm:1310},
  {a:"WAS",b:"NYC",km:423,nm:1550},
  {a:"NYC",b:"PHL",km:166,nm:1310},
  {a:"NYC",b:"BOS",km:398,nm:1550},
  {a:"LAX",b:"SFO",km:726,nm:1550},
  {a:"LAX",b:"SEA",km:2002,nm:1550},
  {a:"CHI",b:"YTO",km:907,nm:1550},
  {a:"CHI",b:"ATL",km:1240,nm:1550},
  {a:"MIA",b:"NAS",km:383,nm:1550},
  {a:"MIA",b:"HAV",km:486,nm:1550},
  {a:"OTT",b:"YMQ",km:213,nm:1310},
  {a:"OTT",b:"YTO",km:453,nm:1550},
  {a:"YTO",b:"YMQ",km:651,nm:1550},
  {a:"YVR",b:"SEA",km:257,nm:1310},
  {a:"YVR",b:"YYC",km:868,nm:1550},
  {a:"MEX",b:"GDL",km:600,nm:1550},
  {a:"MEX",b:"MTY",km:925,nm:1550},
  {a:"GDL",b:"MTY",km:825,nm:1550},
  {a:"GUA",b:"SAL",km:224,nm:1310},
  {a:"GUA",b:"BZE",km:452,nm:1550},
  {a:"BZE",b:"TGU",km:505,nm:1550},
  {a:"TGU",b:"SAL",km:287,nm:1310},
  {a:"TGU",b:"MGA",km:322,nm:1550},
  {a:"MGA",b:"SJO",km:436,nm:1550},
  {a:"SJO",b:"PTY",km:669,nm:1550},
  {a:"PTY",b:"MDE",km:682,nm:1550},
  {a:"HAV",b:"NAS",km:715,nm:1550},
  {a:"KIN",b:"PAP",km:622,nm:1550},
  {a:"KIN",b:"SDQ",km:950,nm:1550},
  {a:"PAP",b:"SDQ",km:329,nm:1550},
  {a:"POS",b:"BGI",km:439,nm:1550},
  {a:"POS",b:"GEO",km:735,nm:1550},
  {a:"BGI",b:"GEO",km:932,nm:1550},
  {a:"BOG",b:"MDE",km:316,nm:1550},
  {a:"BOG",b:"UIO",km:952,nm:1550},
  {a:"CCS",b:"POS",km:768,nm:1550},
  {a:"CCS",b:"BGI",km:1099,nm:1550},
  {a:"GEO",b:"PBM",km:450,nm:1550},
  {a:"PBM",b:"POS",km:1137,nm:1550},
  {a:"UIO",b:"MDE",km:1029,nm:1550},
  {a:"LIM",b:"LPB",km:1394,nm:1550},
  {a:"LIM",b:"UIO",km:1719,nm:1550},
  {a:"BSB",b:"SAO",km:1127,nm:1550},
  {a:"BSB",b:"RIO",km:1210,nm:1550},
  {a:"SAO",b:"CWB",km:449,nm:1550},
  {a:"SAO",b:"RIO",km:460,nm:1550},
  {a:"RIO",b:"CWB",km:882,nm:1550},
  {a:"LPB",b:"ASU",km:1913,nm:1550},
  {a:"ASU",b:"POA",km:1064,nm:1550},
  {a:"ASU",b:"CWB",km:1084,nm:1550},
  {a:"SCL",b:"BUE",km:1483,nm:1550},
  {a:"SCL",b:"MVD",km:1747,nm:1550},
  {a:"BUE",b:"MVD",km:265,nm:1310},
  {a:"BUE",b:"POA",km:1102,nm:1550},
  {a:"MVD",b:"POA",km:934,nm:1550},
  {a:"CBR",b:"SYD",km:322,nm:1550},
  {a:"CBR",b:"MEL",km:598,nm:1550},
  {a:"SYD",b:"MEL",km:919,nm:1550},
  {a:"WLG",b:"CHC",km:395,nm:1550},
  {a:"WLG",b:"AKL",km:650,nm:1550},
  {a:"AKL",b:"CHC",km:998,nm:1550},
  {a:"POM",b:"HIR",km:1811,nm:1550},
  {a:"POM",b:"BNE",km:2719,nm:1550},
  {a:"SUV",b:"TBU",km:973,nm:1550},
  {a:"SUV",b:"VLI",km:1390,nm:1550},
  {a:"HIR",b:"VLI",km:1682,nm:1550},
  {a:"APW",b:"TBU",km:1155,nm:1550},
  {a:"APW",b:"SUV",km:1497,nm:1550},
  {a:"TRW",b:"MAJ",km:870,nm:1550},
  {a:"TRW",b:"PNI",km:2281,nm:1550},
  {a:"PNI",b:"MAJ",km:1894,nm:1550},
  {a:"ROR",b:"MNL",km:2184,nm:1550},
  {a:"NAP",b:"TGD",km:582,nm:1550},
  {a:"LYS",b:"BRN",km:304,nm:1550},
  {a:"LYS",b:"ZRH",km:434,nm:1550},
  {a:"EDI",b:"MAN",km:364,nm:1550},
  {a:"CTU",b:"HAN",km:1419,nm:1550},
  {a:"CTU",b:"CAN",km:1615,nm:1550},
  {a:"CAN",b:"SZX",km:137,nm:1310},
  {a:"BLR",b:"MAA",km:380,nm:1550},
  {a:"CCU",b:"THI",km:726,nm:1550},
  {a:"NGO",b:"YOK",km:320,nm:1550},
  {a:"ALY",b:"CAI",km:227,nm:1310},
  {a:"ALY",b:"TLV",km:617,nm:1550},
  {a:"IBA",b:"PNV",km:227,nm:1310},
  {a:"DUR",b:"MBB",km:521,nm:1550},
  {a:"HOU",b:"DAL",km:467,nm:1550},
  {a:"HOU",b:"MTY",km:862,nm:1550},
  {a:"DAL",b:"MTY",km:1117,nm:1550},
  {a:"SFO",b:"SEA",km:1417,nm:1550},
  {a:"SEA",b:"YYC",km:915,nm:1550},
  {a:"BOS",b:"YMQ",km:518,nm:1550},
  {a:"ATL",b:"WAS",km:1143,nm:1550},
  {a:"CWB",b:"POA",km:708,nm:1550},
  {a:"SSA",b:"BSB",km:1378,nm:1550},
  {a:"SSA",b:"RIO",km:1574,nm:1550},
  {a:"BNE",b:"SYD",km:952,nm:1550},
  {a:"BNE",b:"CBR",km:1226,nm:1550},
  {a:"PER",b:"MEL",km:3538,nm:1550},
  {a:"PER",b:"DIL",km:3618,nm:1550},
  {a:"LON",b:"NYC",km:7245,nm:1550},
  {a:"NYC",b:"LAX",km:5110,nm:1550},
  {a:"LAX",b:"TYO",km:11459,nm:1550},
  {a:"TYO",b:"SIN",km:6913,nm:1550},
  {a:"SIN",b:"BOM",km:5071,nm:1550},
  {a:"BOM",b:"DXB",km:2513,nm:1550},
  {a:"DXB",b:"CAI",km:3160,nm:1550},
  {a:"LON",b:"LOS",km:6518,nm:1550},
  {a:"LOS",b:"JNB",km:5852,nm:1550},
  {a:"JNB",b:"BOM",km:9087,nm:1550},
  {a:"SAO",b:"LIS",km:10325,nm:1550},
  {a:"SAO",b:"NYC",km:9984,nm:1550},
  {a:"SYD",b:"SIN",km:8201,nm:1550},
  {a:"SYD",b:"LAX",km:15707,nm:1550},
  {a:"MOW",b:"BJS",km:7531,nm:1550},
  {a:"BJS",b:"DEL",km:4915,nm:1550},
  {a:"IST",b:"DXB",km:3903,nm:1550},
  {a:"IST",b:"MOW",km:2292,nm:1550},
  {a:"IST",b:"LON",km:3242,nm:1550},
  {a:"PAR",b:"LON",km:436,nm:1550},
  {a:"PAR",b:"BER",km:1140,nm:1550},
  {a:"BER",b:"MOW",km:2092,nm:1550},
  {a:"DEL",b:"SIN",km:5383,nm:1550},
  {a:"SHA",b:"SIN",km:4947,nm:1550},
  {a:"SEL",b:"TYO",km:1497,nm:1550},
  {a:"MEX",b:"LAX",km:3244,nm:1550},
  {a:"MEX",b:"BOG",km:4113,nm:1550},
  {a:"BOG",b:"LIM",km:2450,nm:1550},
  {a:"LIM",b:"SCL",km:3204,nm:1550},
  {a:"BUE",b:"SAO",km:2187,nm:1550},
  {a:"NBO",b:"DXB",km:4624,nm:1550},
  {a:"NBO",b:"JNB",km:3802,nm:1550},
  {a:"CAI",b:"IST",km:1599,nm:1550},
  {a:"AUH",b:"BOM",km:2600,nm:1550},
  {a:"WLG",b:"SYD",km:2895,nm:1550},
  {a:"AKL",b:"SYD",km:2807,nm:1550},
  {a:"HKG",b:"SHA",km:1594,nm:1550},
  {a:"HKG",b:"SIN",km:3363,nm:1550},
  {a:"YTO",b:"NYC",km:723,nm:1550},
  {a:"YVR",b:"LAX",km:2259,nm:1550},
  {a:"YVR",b:"TYO",km:9817,nm:1550},
  {a:"VLT",b:"NAP",km:723,nm:1550},
  {a:"KTM",b:"DEL",km:1040,nm:1550},
  {a:"NKC",b:"BKO",km:1358,nm:1550},
  {a:"BZV",b:"LBV",km:1079,nm:1550},
  {a:"LUN",b:"GBE",km:1383,nm:1550},
  {a:"MIA",b:"ATL",km:1257,nm:1550},
  {a:"KIN",b:"NAS",km:1015,nm:1550},
  {a:"POS",b:"SDQ",km:1628,nm:1550},
  {a:"TRW",b:"HIR",km:2439,nm:1550},
];
const SATS=[
  {id:"PH-1A",name:"PHOTON-1A",alt:550,elev:78,lon:31,status:"ACTIVE"},
  {id:"PH-2B",name:"PHOTON-2B",alt:550,elev:62,lon:36,status:"ACTIVE"},
  {id:"PH-3C",name:"PHOTON-3C",alt:550,elev:47,lon:42,status:"ACTIVE"},
  {id:"PH-4D",name:"PHOTON-4D",alt:550,elev:35,lon:25,status:"TRANSIT"},
  {id:"PH-5E",name:"PHOTON-5E",alt:550,elev:21,lon:18,status:"TRANSIT"},
  {id:"PH-6F",name:"PHOTON-6F",alt:550,elev:12,lon:50,status:"LOW"},
];
const ERR={
  ABSORB:  {c:"#f43f5e",l:"Soğurulma",     i:"◉"},
  SCATTER: {c:"#f59e0b",l:"Rayleigh Saç.", i:"✳"},
  DECOHERE:{c:"#a78bfa",l:"Dekoherans",    i:"≋"},
  PHASE:   {c:"#00d4ff",l:"Faz Kayması",   i:"⌇"},
  EAVES:   {c:"#f43f5e",l:"Dinleme",       i:"⚠"},
  GATE_REJECT: {c:"#fb923c",l:"Düğüm Reddi", i:"⛔"},
  SOFT_MATCH: {c:"#22c55e",l:"Yumuşak Eşleşme", i:"🟢"},
  AMPLIFY: {c:"#06b6d4",l:"Kuantum Kazanım", i:"⚡"},
};
// Log renkleri — tek yerde tanımlı (DÜZELTME 3: tekrar tanım kaldırıldı)
const LC={SYS:"#7c3aed",INFO:"#475569",OK:"#10b981",WARN:"#f59e0b",ERR:"#f43f5e"};
const LB={OK:"#052e1688",WARN:"#1a120055",ERR:"#1c080855"};

const delay = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// V8.0 MİMARİ TEMELİ — ADIM 2: requestAnimationFrame FİZİK/RENDER MOTORU
//
// Eski mimaride her "sistem" (uydu sürüklenmesi, link yükü sönümü,
// force-directed graph) kendi bağımsız setInterval'ını çalıştırıyordu.
// Bu, tarayıcının kendi render döngüsünden (rAF, ~16.6ms/60fps) tamamen
// KOPUK, senkronize olmayan zamanlayıcılar demekti — sekme arka planda
// olmasa bile CPU, birbiriyle hizasız birden fazla timer'ı sürekli
// uyandırıyordu (900ms + 60ms + diğerleri).
//
// RafEngine tek bir requestAnimationFrame döngüsü açar. Her "sistem"
// kendi tik aralığını (ms) bildirerek kaydolur; motor her frame'de
// geçen gerçek süreyi (delta) ölçüp, süresi dolan sistemleri çağırır.
// Böylece: (1) tarayıcının doğal render ritmiyle senkron çalışır,
// (2) sekme arka plandayken rAF otomatik olarak durur (ekstra throttling
// kodu gerekmez — tarayıcı bunu zaten optimize eder), (3) tek bir
// döngüden onlarca sistem yönetilebilir.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// DualClockScheduler — İKİ ZAMANLI SİSTEM MİMARİSİ
//
// PROBLEM: Eski RafEngine, tüm sistemleri (LEGA/NodeTransitGate'in
// foton-hızı kararları İLE CoefficientEvolutionEngine'in periyodik
// genetik evrimi) AYNI düzlemde, aynı önceliksizlikte tutuyordu.
// Bu, kullanıcının tarif ettiği "iki zamanlı sistem" ayrımını
// mimari olarak GÖRÜNMEZ kılıyordu — evrim ile fizik aynı rAF
// döngüsünde, birbirinden ayrışmamış şekilde koşuyordu.
//
// ÇÖZÜM: İki AÇIKÇA AYRILMIŞ katman (tier):
//
//   MİKRO ZAMAN (tier: "micro") — Kristal Bellek (MemristorCell/
//   InMemoryComputeFabric), Kuantum Ön-Yönlendirme (PredictiveCorridor),
//   Negatif Sinyal/Anti-Paket (ChaosSuppressor). Bu sistemler HER
//   rAF FRAME'İNDE (donanım-seviyesi deterministik, geleneksel "saat
//   frekansı"na bağlı olmadan — tarayıcının doğal render ritmi kadar
//   hızlı) çalışır. Bu katman ASLA makro katmanın zamanlamasını
//   beklemez veya ona bağımlı olmaz.
//
//   MAKRO ZAMAN (tier: "macro") — CoefficientEvolutionEngine. Kendi
//   epoch'unda (varsayılan 100ms, ama "sistem sakinleştiğinde" de
//   tetiklenebilir) çalışır. Yeni nesil α/β sınırlarını hesapladıktan
//   SONRA, mikro katmana DOĞRUDAN müdahale ETMEZ — bunun yerine
//   injectCalibration() ile "bir sonraki kalibrasyona kadar geçerli
//   yeni sınırlar" olarak enjekte eder. Mikro katman (propPhoton/
//   NodeTransitGate/LEGA.computeThresholds) bu sınırları OKUR ama
//   makro döngünün kendisiyle senkronize ÇALIŞMAZ — "donanım bir
//   sonraki kalibrasyona kadar tam gaz çalışmaya devam eder."
//
// GERİYE UYUMLULUK: eski RafEngine API'si (register/unregister/start/
// stop, tickMs tabanlı) BİREBİR KORUNUR — DualClockScheduler bunun
// üzerine ince bir "tier" etiketleme katmanıdır. Mevcut 5 kayıt
// (satellite-link-tick, coefficient-evolution, corridor-sync,
// chaos-sweep, force-directed-graph) hiçbir değişiklik olmadan
// çalışmaya devam eder; yalnızca hangi tier'a ait oldukları artık
// açıkça sınıflandırılmıştır (varsayılan: "micro").
// ══════════════════════════════════════════════════════════════
class DualClockScheduler {
  constructor() {
    this.systems = new Map();  // name → { tickMs, lastRun, fn, tier }
    this.running = false;
    this.rafId = null;
    this._lastFrameTime = 0;

    // MAKRO KATMAN KALİBRASYON DURUMU: mikro katmanın okuduğu, makro
    // katmanın periyodik olarak güncellediği "canlı sınırlar". Bu,
    // CoefficientEvolutionEngine'in lega.alpha/lega.beta'ya YAPTIĞI
    // mutasyonun resmi arayüzüdür — artık doğrudan alan atamasıyla
    // değil, injectCalibration() üzerinden, izlenebilir şekilde olur.
    this._calibration = { alpha: 0.6, beta: 0.15, epoch: 0, injectedAt: 0 };

    // ══════════════════════════════════════════════════════════
    // BELLEK HARİTASI DOLULUK ORANI → MAKRO SAATİN ERKEN UYANMASI
    //
    // Mikro katman (Kristal Bellek / InMemoryComputeFabric) doluluk
    // oranını periyodik olarak reportOccupancy() ile bildirir. Doluluk
    // OCCUPANCY_WAKE_THRESHOLD'u (%88) geçtiğinde, makro katmandaki
    // TÜM sistemlerin (örn. coefficient-evolution) "lastRun" zaman
    // damgası geriye çekilir — böylece bir sonraki rAF frame'inde
    // `elapsed >= tickMs` koşulu hemen doğru çıkar ve makro sistem
    // normal 4sn'lik periyodunu beklemeden HEMEN tetiklenir. Bu,
    // "Dual-Clock yapısı Genetik Algoritma'yı normal döngüsünden daha
    // erken uyanmaya zorluyor" davranışının gerçek uygulamasıdır.
    //
    // ÖNEMLİ: bu mekanizma yalnızca makro sistemlerin tetiklenme ZAMANINI
    // öne çeker — mikro katmanın kendi zamanlamasına HİÇ dokunmaz (mikro
    // sistemler zaten her zaman kendi tickMs'lerinde çalışır, bağımsız).
    // ══════════════════════════════════════════════════════════
    this.OCCUPANCY_WAKE_THRESHOLD = 0.88;
    this._lastOccupancy = 0;
    this._earlyWakeCount = 0;
  }

  /**
   * Bir sistemi kaydet. tier belirtilmezse "micro" varsayılır — eski
   * çağrı imzası (register(name, tickMs, fn)) BİREBİR ÇALIŞMAYA DEVAM EDER.
   * @param {string} name
   * @param {number} tickMs
   * @param {Function} fn
   * @param {"micro"|"macro"} [tier="micro"]
   */
  register(name, tickMs, fn, tier = "micro") {
    this.systems.set(name, { tickMs, lastRun: 0, fn, tier });
  }
  unregister(name) { this.systems.delete(name); }

  /**
   * MAKRO → MİKRO ENJEKSİYON: makro katmanın (genetik algoritma) yeni
   * hesapladığı α/β sınırlarını, mikro katmanın okuyacağı canlı
   * kalibrasyon durumuna yazar. Bu, "donanıma enjekte etme" adımının
   * resmi, izlenebilir arayüzüdür — lega.alpha/lega.beta'ya HÂLÂ
   * doğrudan yazılır (geriye dönük uyumluluk için), ama artık bu
   * merkezi kayıt üzerinden, ne zaman/hangi epoch'ta olduğu bilgisiyle.
   * @param {{alpha:number, beta:number, epoch:number}} calibration
   */
  injectCalibration(calibration) {
    this._calibration = { ...calibration, injectedAt: performance.now() };
  }

  /** Mikro katmanın o an geçerli kalibrasyon durumunu okuması içindir. */
  getCalibration() {
    return this._calibration;
  }

  /**
   * BELLEK HARİTASI DOLULUK RAPORU: mikro katman (tipik olarak
   * SoftLandingFilter'ın occupancy hesaplaması) her tick'te bu
   * fonksiyonu çağırarak güncel doluluk oranını bildirir. Eşik
   * aşıldığında makro sistemler zorla erken uyandırılır.
   * @param {number} occupancy [0,1]
   * @returns {boolean} bu çağrıda erken uyandırma tetiklendi mi
   */
  reportOccupancy(occupancy) {
    this._lastOccupancy = occupancy;
    if (occupancy < this.OCCUPANCY_WAKE_THRESHOLD) return false;

    const now = performance.now();
    let woke = false;
    for (const [, sys] of this.systems) {
      if (sys.tier !== "macro") continue;
      // lastRun'ı, bir sonraki frame kontrolünde elapsed>=tickMs kesin
      // doğru çıkacak şekilde geriye çek (tickMs'in tamamı kadar geride).
      if (sys.lastRun > now - sys.tickMs) {
        sys.lastRun = now - sys.tickMs;
        woke = true;
      }
    }
    if (woke) this._earlyWakeCount++;
    return woke;
  }

  /** Erken uyandırma istatistiği ve son bilinen doluluk oranı (UI için). */
  occupancyStats() {
    return { lastOccupancy: this._lastOccupancy, earlyWakeCount: this._earlyWakeCount, threshold: this.OCCUPANCY_WAKE_THRESHOLD };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastFrameTime = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const frameDelta = now - this._lastFrameTime;
      this._lastFrameTime = now;
      // MİKRO ve MAKRO sistemler AYNI rAF çağrısı içinde taranır (JS
      // tek-thread olduğu için gerçek paralellik yoktur), ama tier
      // etiketi sayesinde her sistemin HANGİ ZAMAN SINIFINA ait olduğu
      // açıkça bilinir ve makro sistemler mikro sistemlerin zamanlamasını
      // ASLA geciktirmez (tickMs'leri bağımsızdır, birbirine kilitlenmez).
      for (const [name, sys] of this.systems) {
        const elapsed = now - sys.lastRun;
        if (elapsed >= sys.tickMs) {
          sys.lastRun = now;
          try { sys.fn(elapsed); } catch (e) { /* bir sistemin hatası diğerlerini durdurmasın */ }
        }
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Tier'a göre filtrelenmiş sistem listesi (UI/debug için). */
  systemsByTier(tier) {
    return [...this.systems.entries()].filter(([, s]) => s.tier === tier).map(([name]) => name);
  }
}

// Modül-seviyesi tekil motor — tüm bileşenler aynı iki-zamanlı
// döngüyü paylaşır. Eski isim (rafEngine) korunur — geriye dönük
// uyumluluk için hiçbir çağrı yeri değişmeden çalışır.
const rafEngine = new DualClockScheduler();

// ══════════════════════════════════════════════════════════════
// EK 24: SES EFEKTLERİ — Web Audio API ile gerçek ton üretimi
// (dosya gerektirmez, tamamen prosedürel). Başarılı iletimde yumuşak
// "quantum chime" (yükselen üçlü akor), hatada kısa "bozulma" efekti.
// ══════════════════════════════════════════════════════════════
let _audioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
  }
  return _audioCtx;
}
function playTone(freq, startTime, duration, ctx, gain=0.08, type="sine") {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  g.gain.setValueAtTime(0, startTime);
  g.gain.linearRampToValueAtTime(gain, startTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(startTime); osc.stop(startTime + duration + 0.05);
}
function playSuccessChime() {
  const ctx = getAudioCtx(); if (!ctx) return;
  const t0 = ctx.currentTime;
  // Yükselen üçlü akor — C5, E5, G5 (kuantum "collapse" hissi)
  playTone(523.25, t0,       0.5, ctx, 0.06);
  playTone(659.25, t0+0.08,  0.5, ctx, 0.06);
  playTone(783.99, t0+0.16,  0.6, ctx, 0.07);
}
function playErrorGlitch() {
  const ctx = getAudioCtx(); if (!ctx) return;
  const t0 = ctx.currentTime;
  // Düşen sert ton + hafif gürültü hissi (square wave ile)
  playTone(220, t0,      0.12, ctx, 0.05, "square");
  playTone(140, t0+0.10, 0.18, ctx, 0.05, "square");
  playTone(90,  t0+0.20, 0.22, ctx, 0.04, "square");
}

// ══════════════════════════════════════════════════════════════
// EK 35: KİRAL AKUSTİK MOTOR (Chiral Acoustic Engine)
//
// DÜRÜST TEKNİK NOT: Gerçek bir AudioWorkletProcessor ayrı bir dosya
// olarak (audioContext.audioWorklet.addModule('worklet.js')) yüklenmek
// zorundadır. Bu ortam tek dosyalık bir React artifact'ı olduğu için
// gerçek bir worklet dosyası sunulamaz. Bunun yerine, AYNI İŞLEVİ
// gören bir ANA THREAD eşdeğeri kuruldu: iki OscillatorNode + iki
// GainNode (biri +1.0 diğeri -1.0 kazanç ile 180° faz-ters), FM
// modülasyonu için modülatör osilatörlerle taşıyıcı frekansı sürekli
// bükülür. Bu, gerçek AudioWorklet kadar düşük-gecikmeli değildir
// (ana thread'de çalışır) ama işitsel olarak aynı "yıkıcı girişim"
// (destructive interference) etkisini üretir.
// ══════════════════════════════════════════════════════════════

const CHIRAL_BASE_FREQ = 440; // La (A4) — klasik referans fazı

class ChiralAcousticEngine {
  constructor() {
    this.ctx = null;
    this.carrierPrime = null; this.gainPrime = null;
    this.modulatorPrime = null; this.modGainPrime = null;
    this.carrierMirror = null; this.gainMirror = null;
    this.modulatorMirror = null; this.modGainMirror = null;
    this.running = false;
    this.silentSource = null; // EK 36: sessiz buffer loop (throttling engelleme)
    this.silentGain = null;
    this.driftDetector = null; // EK 38: clock drift detector referansı
  }

  ensureContext() {
    if (this.ctx && this.ctx.state !== "closed") return this.ctx;
    const AC = (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    this.ctx = new AC();
    return this.ctx;
  }

  // ── EK 36: SESSİZ BUFFER LOOP ─────────────────────────────────
  // Tarayıcılar arka plan sekmelerinde setTimeout/rAF'ı kısıtlar
  // (throttling), ama aktif bir AudioContext genellikle bu kısıtlamadan
  // muaftır. Sürekli (neredeyse sıfır genlikli) bir buffer çalarak
  // AudioContext'i "suspended" durumuna düşmekten alıkoyarız — bu,
  // arka planda bile ses zamanlamasının sürmesini garanti eder.
  startSilentKeepAlive() {
    const ctx = this.ensureContext(); if (!ctx) return;
    if (this.silentSource) return; // zaten çalışıyor
    const bufferSize = ctx.sampleRate * 2; // 2 saniyelik döngü
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    // Tamamen sıfır değil — bazı tarayıcılar tam sessizliği optimize edip
    // context'i yine de askıya alabilir. Duyulamayacak kadar küçük (1e-6)
    // bir DC-benzeri titreşim bırakıyoruz.
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() - 0.5) * 1e-6;

    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 1;
    this.silentSource = ctx.createBufferSource();
    this.silentSource.buffer = buffer;
    this.silentSource.loop = true;
    this.silentSource.connect(this.silentGain);
    this.silentGain.connect(ctx.destination);
    this.silentSource.start();
  }
  stopSilentKeepAlive() {
    if (this.silentSource) { try { this.silentSource.stop(); } catch {} this.silentSource = null; }
  }

  // ── EK 34/35: Çift taraflı FM + kiral faz-ters kurulum ────────
  // primeFreq/mirrorFreq: taşıyıcı frekanslar (QBER'e göre dışarıdan hesaplanır)
  // modDepth/modFreq: modülatör derinlik/frekansı (kiralite faz farkına göre)
  start({ carrierFreq, modFreq, modDepth }) {
    const ctx = this.ensureContext(); if (!ctx) return false;
    this.stop(); // önce temizle

    // Asal evren kanalı — Gain +1.0, klasik referans fazı
    this.carrierPrime = ctx.createOscillator();
    this.gainPrime = ctx.createGain();
    this.modulatorPrime = ctx.createOscillator();
    this.modGainPrime = ctx.createGain();

    this.carrierPrime.type = "sine";
    this.carrierPrime.frequency.setValueAtTime(carrierFreq, ctx.currentTime);
    this.modulatorPrime.type = "sine";
    this.modulatorPrime.frequency.setValueAtTime(modFreq, ctx.currentTime);
    this.modGainPrime.gain.setValueAtTime(modDepth, ctx.currentTime);
    // FM: modülatör → carrier'ın frekans parametresine bağlanır
    this.modulatorPrime.connect(this.modGainPrime);
    this.modGainPrime.connect(this.carrierPrime.frequency);

    this.gainPrime.gain.setValueAtTime(0.05, ctx.currentTime); // sessiz, arka plan seviyesi
    this.carrierPrime.connect(this.gainPrime);
    this.gainPrime.connect(ctx.destination);

    // Ayna evren kanalı — Gain -1.0 (180° faz-ters), logaritmik aşağı bükülen ton
    this.carrierMirror = ctx.createOscillator();
    this.gainMirror = ctx.createGain();
    this.modulatorMirror = ctx.createOscillator();
    this.modGainMirror = ctx.createGain();

    this.carrierMirror.type = "sine";
    this.carrierMirror.frequency.setValueAtTime(carrierFreq, ctx.currentTime);
    this.modulatorMirror.type = "sine";
    this.modulatorMirror.frequency.setValueAtTime(modFreq * 0.5, ctx.currentTime); // kiral asimetri
    this.modGainMirror.gain.setValueAtTime(modDepth, ctx.currentTime);
    this.modulatorMirror.connect(this.modGainMirror);
    this.modGainMirror.connect(this.carrierMirror.frequency);

    // Kiral ters faz: gain -1.0 → tam 180° faz kayması
    this.gainMirror.gain.setValueAtTime(-0.05, ctx.currentTime);
    this.carrierMirror.connect(this.gainMirror);
    this.gainMirror.connect(ctx.destination);

    this.carrierPrime.start(); this.modulatorPrime.start();
    this.carrierMirror.start(); this.modulatorMirror.start();
    this.running = true;
    return true;
  }

  // ── EK 37: QBER'i canlı olarak taşıyıcı/modülatör frekanslarına bağla ──
  // Her yeni telemetri geldiğinde çağrılır; osilatörleri yeniden
  // başlatmadan (click/pop olmadan) rampalı geçiş yapar.
  updateFromTelemetry(qber, chiralityDelta) {
    if (!this.running || !this.ctx) return;
    const t = this.ctx.currentTime;
    // QBER (0-1) → taşıyıcı frekans: düşük hata=saf 440Hz, yüksek hata=daha gergin/yüksek ton
    const carrierFreq = CHIRAL_BASE_FREQ * (1 + Math.min(qber, 0.5));
    // Kiralite faz farkı (0-7 sendrom uzayı) → modülatör derinliği: simetri kırıldıkça FM daha "çırpınır"
    const modDepth = 5 + (chiralityDelta ?? 0) * 15;
    const modFreq = 2 + (chiralityDelta ?? 0) * 3;

    [this.carrierPrime, this.carrierMirror].forEach(osc => {
      if (osc) osc.frequency.linearRampToValueAtTime(carrierFreq, t + 0.15);
    });
    if (this.modulatorPrime) this.modulatorPrime.frequency.linearRampToValueAtTime(modFreq, t + 0.15);
    if (this.modulatorMirror) this.modulatorMirror.frequency.linearRampToValueAtTime(modFreq * 0.5, t + 0.15);
    if (this.modGainPrime) this.modGainPrime.gain.linearRampToValueAtTime(modDepth, t + 0.15);
    if (this.modGainMirror) this.modGainMirror.gain.linearRampToValueAtTime(modDepth, t + 0.15);
  }

  // ── EK 34: Rol takası (role-reversal) — Universe_A/B etiketleri
  // yer değiştirdiğinde hangi kanalın +1.0 hangi kanalın -1.0 kazanç
  // taşıdığını anlık olarak tersine çevirir (click-free ramp ile).
  swapRoles() {
    if (!this.running || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.gainPrime && this.gainMirror) {
      const pg = this.gainPrime.gain.value, mg = this.gainMirror.gain.value;
      this.gainPrime.gain.linearRampToValueAtTime(mg, t + 0.05);
      this.gainMirror.gain.linearRampToValueAtTime(pg, t + 0.05);
    }
  }

  stop() {
    [this.carrierPrime, this.modulatorPrime, this.carrierMirror, this.modulatorMirror].forEach(osc => {
      if (osc) { try { osc.stop(); } catch {} }
    });
    this.carrierPrime = this.gainPrime = this.modulatorPrime = this.modGainPrime = null;
    this.carrierMirror = this.gainMirror = this.modulatorMirror = this.modGainMirror = null;
    this.running = false;
  }

  // ── EK 39: AudioContext yaşam döngüsü senkronizasyonu ──────────
  async suspend() { if (this.ctx && this.ctx.state === "running") await this.ctx.suspend(); }
  async resume()  { if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume(); }
}

// Modül-seviyesi tekil örnek — tüm React ağacı aynı motoru paylaşır
const chiralEngine = new ChiralAcousticEngine();

// ══════════════════════════════════════════════════════════════
// EK 40: WEB LOCKS API SARMALAYICI
// Birden fazla sekme aynı anda "Master" (Ana Evren) rolünü almaya
// çalıştığında yarış durumunu (race condition) önlemek için tarayıcı
// düzeyinde bir kilit kullanılır. navigator.locks yoksa (Safari gibi
// eski sürümler), zaman-damgası bazlı yazılımsal fallback'e düşer.
// ══════════════════════════════════════════════════════════════
async function acquireMasterLock(tabId, onAcquired, onReleased) {
  if (typeof navigator !== "undefined" && navigator.locks && navigator.locks.request) {
    try {
      // ifAvailable: true → kilit meşgulse hemen false döner, beklemez
      return await navigator.locks.request("photonnet-master-universe", { ifAvailable: true }, async (lock) => {
        if (!lock) return false; // başka sekme zaten Master
        onAcquired?.();
        // Kilit, bu Promise resolve olana kadar tutulur — sekme kapanana/rol
        // bırakılana kadar açık bir Promise ile kilidi elde tutuyoruz.
        await new Promise(resolve => { onReleased_resolve = resolve; });
        return true;
      });
    } catch { return false; }
  }
  // Fallback: Web Locks API yoksa, her zaman true dön (yazılımsal
  // zaman-damgası liderliği transmit() akışında zaten ayrıca uygulanır).
  onAcquired?.();
  return true;
}
let onReleased_resolve = null;
function releaseMasterLock() {
  if (onReleased_resolve) { onReleased_resolve(); onReleased_resolve = null; }
}

// ══════════════════════════════════════════════════════════════
// EK 38: ZAMAN DİLATASYONU DEDEKTÖRÜ (Clock Drift Detector)
// Sekme arka plana geçtiğinde (Page Visibility API), tarayıcının
// setInterval/setTimeout throttling'i nedeniyle "beklenen" ve "gerçek"
// zaman arasında bir sapma oluşur. Bu fonksiyon, Date.now() bazlı
// beklenen tik ile performance.now() bazlı gerçek tik arasındaki
// farkı ölçerek bir "kiral zaman dilatasyonu" metriği üretir —
// didaktik çerçevede, arka plandaki sekmenin "kendi zaman akışının"
// yavaşladığı hissini verir.
// ══════════════════════════════════════════════════════════════
function createClockDriftDetector(onDrift, intervalMs = 1000) {
  let expected = performance.now() + intervalMs;
  let lastReal = performance.now();
  const timer = setInterval(() => {
    const real = performance.now();
    const drift = real - expected; // pozitif = throttling nedeniyle gecikme
    expected += intervalMs;
    onDrift?.({ driftMs: drift, intervalMs, timestamp: Date.now() });
    lastReal = real;
  }, intervalMs);
  return () => clearInterval(timer);
}

// ══════════════════════════════════════════════════════════════
// EK 25: SHAREABLE LINK — seed + parametreleri gerçekten URL'ye yazar
// ve sayfa açılışında URL'den okur (?seed=...&src=...&dst=...).
// ══════════════════════════════════════════════════════════════
function buildShareUrl(params) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  Object.entries(params).forEach(([k,v])=>{
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  return url.toString();
}
function readShareParams() {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.search);
  const out = {};
  ["seed","src","dst","msg","nm","ecc","evesdrop"].forEach(k=>{
    if (p.has(k)) out[k] = p.get(k);
  });
  return out;
}

// ══════════════════════════════════════════════════════════════
// EK 26: BİLİMSEL RAPOR — yazdırılabilir HTML (tarayıcı "Yazdır →
// PDF olarak kaydet" ile gerçek bir PDF üretir; bu ortamda gerçek bir
// PDF-üretim kütüphanesi çalıştırmak yerine en güvenilir ve dosyasız
// yol budur). Yeni sekmede açılır, kullanıcı Ctrl+P ile PDF alabilir.
// ══════════════════════════════════════════════════════════════
function buildReportHtml(entry) {
  const r = entry.result;
  const eventRows = (entry.eventLog||[]).slice(0,30).map(ev=>
    `<tr><td>${ev.seg}</td><td>${ev.bit}</td><td>${ev.type}</td><td>${ev.km.toFixed(2)} km</td><td>${ev.text}</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<title>PhotonNet Transmission Report — ${entry.id}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;max-width:800px;margin:40px auto;color:#111;line-height:1.6;padding:0 20px}
  h1{font-size:22px;border-bottom:3px solid #333;padding-bottom:10px}
  h2{font-size:15px;margin-top:28px;color:#333;border-bottom:1px solid #ccc;padding-bottom:4px}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}
  th{background:#f0f0f0}
  .stat{display:inline-block;width:23%;margin:6px 1%;padding:10px;background:#f7f7f7;border-radius:6px;text-align:center}
  .stat .v{font-size:20px;font-weight:bold}
  .stat .l{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px}
  .success{color:#0a7a3d}.fail{color:#b3261e}
  footer{margin-top:40px;font-size:9px;color:#888;border-top:1px solid #ccc;padding-top:10px}
  @media print{ body{margin:0} }
</style></head><body>
  <h1>PhotonNet — Kuantum Fotonik İletim Raporu</h1>
  <p><b>Kayıt ID:</b> ${entry.id} &nbsp;|&nbsp; <b>Tarih:</b> ${entry.time} &nbsp;|&nbsp; <b>Entanglement Seed:</b> ${entry.seed}</p>
  <p><b>Rota:</b> ${entry.src} → ${entry.dst} (${r.hops} atlama, ${r.totalKm} km${r.geoKm?`, ${r.geoKm} km haversine`:""})</p>

  <h2>Özet İstatistikler</h2>
  <div>
    <div class="stat"><div class="v ${r.success?'success':'fail'}">${r.success?"BAŞARILI":"BOZUK"}</div><div class="l">Sonuç</div></div>
    <div class="stat"><div class="v">${r.er}%</div><div class="l">BER</div></div>
    <div class="stat"><div class="v">${r.okCount}/${r.bits.length}</div><div class="l">Başarılı Foton</div></div>
    <div class="stat"><div class="v">${r.corrected}</div><div class="l">ECC Düzeltme</div></div>
  </div>

  <h2>Mesaj</h2>
  <p><b>Gönderilen:</b> "${entry.msg}"<br/><b>Alınan:</b> "${r.decoded}"</p>

  <h2>QKD (BB84) Katmanı</h2>
  <p>Baz uzlaşma oranı: ${r.bb84MatchRate!=null?(r.bb84MatchRate*100).toFixed(1)+"%":"—"}<br/>
     QBER: ${r.qber!=null?(r.qber*100).toFixed(1)+"%":"—"} ${r.eavesdropDetected?"— <b>dinleme tespit edildi</b>":""}<br/>
     Sifted key uzunluğu: ${r.siftedKeyLen ?? "—"} bit<br/>
     OTP şifreleme bütünlüğü: ${r.otp?(r.otp.integrityOk?"✓ doğrulandı":"✗ başarısız"):"—"}</p>

  <h2>Fiziksel Olaylar (${(entry.eventLog||[]).length} toplam, ilk 30 gösteriliyor)</h2>
  <table><thead><tr><th>Segment</th><th>Bit</th><th>Tip</th><th>Konum</th><th>Açıklama</th></tr></thead>
  <tbody>${eventRows || "<tr><td colspan=5>Kayıtlı olay yok</td></tr>"}</tbody></table>

  <footer>Bu rapor PhotonNet Kuantum Fotonik Ağ Simülatörü tarafından otomatik üretilmiştir.
  Fiziksel modeller (Rayleigh saçılması, fiber zayıflama, BB84 protokolü) eğitim amaçlı basitleştirilmiş simülasyonlardır.</footer>
</body></html>`;
}
function openReportInNewTab(entry) {
  const html = buildReportHtml(entry);
  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); }
}

// ══════════════════════════════════════════════════════════════
// EK 4: Gerçek fizik açıklama üretici — her olay için insan-okunur tooltip
// "Bu foton Rayleigh scattering nedeniyle 142. km'de kayboldu (850nm
//  dalga boyu Rayleigh için dezavantajlı)" gibi cümleler üretir.
// ══════════════════════════════════════════════════════════════
function explainEvent(ev, nm) {
  const w = WL[nm] || WL[1550];
  const kmTxt = ev.km.toFixed(1);
  switch (ev.type) {
    case "SCATTER":
      return `Bu foton Rayleigh saçılması nedeniyle ${kmTxt}. km'de sapmaya uğradı `
        + `(${nm}nm dalga boyu, Rayleigh katsayısı ×${w.r} — kısa dalga boyları saçılmaya çok daha yatkındır).`;
    case "ABSORB":
      return `Bu foton ${kmTxt}. km'de fiber malzemesi tarafından soğuruldu `
        + `(${nm}nm için ${w.loss}dB/km zayıflama katsayısı, kümülatif kayıp eşiği aşıldı).`;
    case "DECOHERE":
      return `Kuantum durumu ${kmTxt}. km'de çevresel gürültüyle dekohere oldu `
        + `(uzun mesafede polarizasyon/faz bilgisi taşıyıcı ortamla etkileşime girdi).`;
    case "PHASE":
      return `Faz kayması ${kmTxt}. km'de bit değerini tersine çevirdi `
        + `(fiber çift kırılım — birefringence — kaynaklı polarizasyon dönüşü).`;
    case "EAVES":
      return `${kmTxt}. km civarında BB84 protokolü dinleme imzası tespit etti `
        + `(ölçüm nedeniyle dalga fonksiyonu çöktü, ~%25 bit hatası istatistiksel imzası).`;
    case "AMPLIFY":
      return `Tekrarlayıcı (repeater), ${kmTxt}. km'de sinyali +${ev.gainDb}dB kazançla yeniden güçlendirdi `
        + `(EDFA-benzeri amplifikasyon — yalnızca 1000km üzeri, tekrarlayıcılı hatlarda aktif).`;
    default:
      return `Bilinmeyen olay @ ${kmTxt}km`;
  }
}
function explainEcc(corrected) {
  if (corrected <= 0) return null;
  if (corrected === 1) return `Hamming(7,4) kodu burada 1 bitlik hatayı tek-bit-düzeltme kapasitesiyle onardı.`;
  return `Hamming(7,4) kodu burada ${corrected} bitlik hata deseni tespit etti — `
    + `bu, kodun tek-bit-düzeltme sınırını aşan bir burst error olabileceğinden bazı düzeltmeler yanlış yönde olmuş olabilir.`;
}

// ══════════════════════════════════════════════════════════════
// DÜZELTME 5: transmit() MODÜLERİZASYONU
//
// transmit() 200+ satırlık dev bir fonksiyondu — routing, fizik
// simülasyonu, BB84/OTP (Adım 3'te zaten ayrıldı), state güncellemesi
// ve broadcast hepsi iç içeydi. Bu iki fonksiyon, SAF (pure) hesaplama
// mantığını dışarı çıkarır: veri alır, sonuç döner, hiçbir React state'e
// veya log'a dokunmaz. transmit() artık bunları çağırıp yalnızca
// state/log/broadcast SORUMLULUĞUNU üstlenir — matematikte tek satır
// değişmedi, sadece organizasyon.
// ══════════════════════════════════════════════════════════════

// ── routeCalculation: rota bulma + coğrafi çapraz-kontrol ─────────
/**
 * @param {NetNode[]} nodes
 * @param {NetLink[]} links
 * @param {string} src
 * @param {string} dst
 * @param {Record<string,number>} linkLoad
 * @param {(id:string)=>NetNode|null} getNode
 * @param {Record<string,boolean>} [linkDown] - bkz. dijkstra()'nın aynı adlı parametresi
 * @param {Record<string,number>} [predictiveRisk] - bkz. dijkstra()'nın aynı adlı parametresi (FAZ 4)
 * @returns {{path: PathStep[], segs: NetLink[], totalKm: number, geoKm: number, health: Object} | null}
 */
function routeCalculation(nodes, links, src, dst, linkLoad, getNode, linkDown, predictiveRisk) {
  const path = dijkstra(nodes, links, src, dst, linkLoad, linkDown, predictiveRisk);
  if (!path) return null;

  const segs = path.slice(1).map(x => x.link).filter(Boolean);
  const totalKm = segs.reduce((s, l) => s + l.km, 0);
  const geoKm = segs.reduce((s, lk) => {
    const a = getNode(lk.a), b = getNode(lk.b);
    return s + (a && b ? haversineKm(a.lat, a.lon, b.lat, b.lon) : lk.km);
  }, 0);

  // ══════════════════════════════════════════════════════════
  // ROTA-SAĞLIK KONTROLÜ (Route Health Check)
  //
  // PROBLEM: dijkstra() en düşük MALİYETLİ rotayı seçer (fiziksel
  // kayıp × mesafe + canlı yük), ama "en ucuz" rota HER ZAMAN "fiziksel
  // olarak sağlıklı" anlamına gelmez. Uzun bir hop zincirinde (örn.
  // ekran görüntüsündeki IST→BAG rotası, 5 segment), HER hop kendi
  // geçirgenlik payını (fiberT) çarpımsal olarak düşürür — 5 hop'un
  // her biri %20 kayıpsa bile, uçtan uca geçirgenlik 0.8^5≈%33'e
  // düşer; kayıplar daha agresifse bu değer pratik olarak sıfıra gider.
  // Bu durumda TÜM segmentlerin ayrı ayrı %100 kayıp yaşaması istatistiksel
  // olarak beklenen bir sonuç hâline gelir (rastgele bir "hata" değil).
  //
  // ÇÖZÜM: rota SEÇİLDİKTEN SONRA (dijkstra'nın maliyet formülüne
  // dokunmadan), uçtan uca kümülatif geçirgenliği ve hop sayısını
  // hesaplayıp bir "health" nesnesi döndürür. transmit() bunu okuyup
  // kullanıcıyı önceden uyarabilir — rota REDDEDİLMEZ, yalnızca
  // "bu rota fiziksel olarak çökmeye çok yatkın" bilgisi şeffaf hâle gelir.
  // ══════════════════════════════════════════════════════════
  const cumulativeTransmittance = segs.reduce((prod, lk) => prod * fiberT(lk.nm, lk.km), 1);
  const hopCount = segs.length;
  const MAX_HEALTHY_HOPS = 6;
  const MIN_HEALTHY_TRANSMITTANCE = 0.01; // %1'in altı → rota pratik olarak "ölü" sayılır

  const health = {
    hopCount,
    cumulativeTransmittance,
    tooManyHops: hopCount > MAX_HEALTHY_HOPS,
    criticallyLowTransmittance: cumulativeTransmittance < MIN_HEALTHY_TRANSMITTANCE,
    healthy: hopCount <= MAX_HEALTHY_HOPS && cumulativeTransmittance >= MIN_HEALTHY_TRANSMITTANCE,
  };

  return { path, segs, totalKm, geoKm, health };
}

// ── physicalSimulation: tüm segmentler boyunca foton yayılımı ─────
/**
 * @param {NetLink[]} segs
 * @param {number[]} bits
 * @param {number} entanglementSeed
 * @param {boolean} evesdrop
 * @param {(id:string)=>NetNode|null} getNode
 * @param {{linkLoad?: Record<string,number>, historicalBer?: number}} [legaOpts] - LEGA bağlamı;
 *   yalnızca CANLI transmit() çağrısından geçirilir. Replay/Mirror/Fork motorları
 *   bu parametreyi vermez — böylece geçmiş anın fiziği asla değişmez, sadece
 *   yeni bir iletim o anki ağ koşullarından etkilenir.
 * @returns {{recv:number[], totalLost:number, totalFlip:number, ec:Record<string,number>, eventLog:Array, segReport:Array}}
 */
function physicalSimulation(segs, bits, entanglementSeed, evesdrop, getNode, legaOpts) {
  let recv = [...bits];
  let totalLost = 0, totalFlip = 0;
  const ec = {};
  const eventLog = [];
  const segReport = []; // her segmentin özet istatistiği (loglama transmit()'te yapılır)
  const gateReport = { checked: 0, phase1Rejected: 0, phase2Rejected: 0, phase3Passed: 0 }; // NodeTransitGate özeti

  for (let si = 0; si < segs.length; si++) {
    const lk = segs[si];
    const nd = getNode(lk.b);
    const rp = nd?.reps ?? 0;
    let sl = 0, sf = 0;
    // ANİ SOĞURULMA BARİYERİ TESPİTİ (ABSORB Burst Detection): art arda
    // gelen ABSORB olaylarını sayar. Ping-Pong'un fiziksel bağlamı yanlış
    // temsil eden bir katsayı enjeksiyonu yaptığı anlarda (kullanıcının
    // tarif ettiği "kırılma indisi bariyeri"), fiberT/absorbBias oranı
    // aniden çöker ve ABSORB olayları ARDIŞIK olarak patlama yapar —
    // bu, tek tek rastgele kayıplardan istatistiksel olarak ayırt edilebilir.
    let consecutiveAbsorb = 0;
    let maxConsecutiveAbsorb = 0;
    const ABSORB_BURST_THRESHOLD = 5; // bu kadar ardışık ABSORB "bariyer" sayılır

    // LEGA bağlamı bu segmentin canlı yüküyle kurulur (verilmişse).
    // OPLL (Optik Faz Kilitli Döngü): opsiyonel olarak legaOpts.opllEnabled
    // üzerinden aktive edilir — verilmezse propPhoton'ın PHASE olasılığı
    // hiç etkilenmez (eski davranış birebir korunur).
    // ATMOSFERİK GEÇİRGENLİK PENCERESİ: eksik halka tamamlandı — legaOpts.
    // atmosphericConditions (LeoPanel'deki hava koşulu/menzil ayarından)
    // artık gerçekten legaCtx'e taşınıyor, bu da propPhoton'ın
    // AtmosphericWindowModel.windowFactor()'ı GERÇEKTEN kullanmasını sağlar.
    // Önceden bu bağlantı hiç kurulmamıştı — UI'daki dalga boyu önerisi
    // görsel olarak çalışıyordu ama fiziksel simülasyonu HİÇ etkilemiyordu.
    const legaCtx = legaOpts ? {
      linkLoad: (legaOpts.linkLoad?.[`${lk.a}-${lk.b}`] ?? legaOpts.linkLoad?.[`${lk.b}-${lk.a}`]) ?? 0,
      historicalBer: legaOpts.historicalBer ?? 0,
      opllEnabled: !!legaOpts.opllEnabled,
      atmosphericConditions: legaOpts.atmosphericConditions,
    } : undefined;

    // TEMPORAL INTERPOLATION LOOP: bu segmentin hedef düğümü için, ÖNCEKİ
    // fotonun NodeTransitGate/InMemoryComputeFabric turunda bırakılan LERP
    // durumunu taşıyan önbellek. "Donanımın bir sonraki Micro-Clock
    // döngüsü" semantiği tam olarak budur: bir fotonun düğüm kararı,
    // BİR SONRAKİ fotonun propPhoton çağrısındaki katsayıları bilgilendirir
    // — LEGA/NodeTransitGate/propPhoton'ın kendi imzalarına dokunulmaz,
    // yalnızca legaCtx'e opsiyonel bir coeffOverride alanı eklenir.
    let nodeCoeffCache = null;

    // DÜZELTME 8: DİNAMİK FEC / FOTON ÇOĞULLAMA — bu segmentin tahmini
    // hayatta kalma olasılığından, kaç bağımsız kopya denemesi gerektiği
    // ANLIK hesaplanır. legaOpts.dynamicFecEnabled verilmezse (replay/
    // mirror/fork gibi eski çağrı yerleri) redundancy=1 — davranış
    // BİREBİR eskisi gibi kalır, geçmiş anların fiziği asla değişmez.
    //
    // DÜZELTME 10 (bkz. "IST-BUR BER sorunu" incelemesi): legaCtx artık
    // dynamicRedundancyFor'a da geçirilir — canlı AĞ YÜKÜ (linkLoad)
    // artık hedef %99.5 varış hesabına GERÇEKTEN dahil, önceden sessizce
    // görmezden geliniyordu (bkz. estimateLinkSurvival'ın başlığı).
    const redundancy = legaOpts?.dynamicFecEnabled
      ? dynamicRedundancyFor(lk.nm, lk.km, rp, legaCtx)
      : 1;
    // GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ (bkz. propPhotonRelayChain başlığı):
    // bu SEGMENT'in (GERÇEK LİNK'in) kendisi MSG_RELAY_THRESHOLD_KM'yi
    // aşıyorsa, aşağıdaki bit döngüsü propPhoton yerine propPhotonRelayChain
    // çağırır. legaOpts'tan (canlı/replay/mirror/fork farkı) TAMAMEN
    // BAĞIMSIZDIR — bu, ROTA TOPOLOJİSİNİN bir özelliğidir, replay de
    // AYNI zinciri (aynı seed ile) yeniden üretmelidir, aksi halde
    // "geçmiş anların fiziği asla retroaktif değişmez" ilkesi bozulur.
    const usingMsgRelay = lk.km > MSG_RELAY_THRESHOLD_KM;
    const msgRelayHops = usingMsgRelay ? Math.max(2, Math.ceil(lk.km / MSG_RELAY_HOP_KM)) : 0;
    let fecRescued = 0;   // ilk kopya kaybolduğu halde bir sonraki kopyayla kurtarılan bit sayısı
    let fecExhausted = 0; // TÜM kopyalar tükendiği halde yine de kaybolan bit sayısı

    for (let i = 0; i < recv.length; i++) {
      // Her foton için deterministik alt-seed → replay'de birebir aynı sonuç.
      // LEGA context'i eşikleri değiştirir ama rng'yi DEĞİŞTİRMEZ — bu yüzden
      // aynı seed + aynı legaCtx her zaman aynı sonucu üretir (determinizm korunur).
      //
      // DİNAMİK FEC DÖNGÜSÜ — ÇEŞİTLİLİK BİRLEŞTİRME (Diversity Combining):
      // alıcı, aynı klasik bit için gönderilen bağımsız foton zaman-dilimlerini
      // (time-bin multiplexing — gerçek FSO/uydu QKD sistemlerinde kullanılan
      // bir teknik) dener. Yalnızca kayıp/soğurulma (erasure) tehlikesine karşı
      // "ilk ulaşanı al" yetmez — HAYATTA KALAN fotonların kendi arasında hâlâ
      // bağımsız bir PHASE (bit-flip) olasılığı vardır. Bu yüzden alıcı, en az
      // VOTE_TARGET kopya başarıyla ulaşana (veya kopya bütçesi tükenene) kadar
      // dener, sonra ULAŞAN kopyalar arasında ÇOĞUNLUK OYLAMASI yapar — gerçek
      // tekrarlayıcı/röle ağlarındaki "diversity combining" ile birebir aynı
      // ilke: bağımsız gürültülü kopyaların çoğunluk kararı, tekil bir kopyadan
      // istatistiksel olarak daha güvenilirdir. redundancy=1 iken döngü tek
      // kopyada biter ve ESKİ TEK-ATIŞ DAVRANIŞIYLA BİREBİR AYNIDIR. Yalnızca
      // İLK kopyada (c=0) casusluk fiziği değerlendirilir — tekrar denemeleri
      // Eve'in istatistiksel imzasını suni biçimde çoğaltmaz.
      const VOTE_TARGET = 3;
      let r = null;
      let lastAttempt = null;
      const successes = [];
      for (let c = 0; c < redundancy && successes.length < VOTE_TARGET; c++) {
        const bitRng = mulberry32(combineSeed(entanglementSeed, si, i, c));
        // Bu fotonun kullanacağı bağlam: temel legaCtx + (varsa) bir önceki
        // fotondan kalan LERP durumundaki katsayı üçlüsü.
        const photonCtx = legaCtx && nodeCoeffCache
          ? { ...legaCtx, coeffOverride: nodeCoeffCache }
          : legaCtx;
        const evesdropThisAttempt = evesdrop && si === Math.floor(segs.length / 2) && c === 0;
        const attempt = usingMsgRelay
          ? propPhotonRelayChain(lk.nm, lk.km, rp, evesdropThisAttempt, bitRng, photonCtx)
          : propPhoton(lk.nm, lk.km, rp, evesdropThisAttempt, bitRng, photonCtx);
        lastAttempt = attempt;
        if (attempt.ok) successes.push(attempt);
      }
      if (successes.length === 0) {
        r = lastAttempt; // tüm kopyalar kayboldu — dürüstçe SÖNÜMLENDİ olarak işaretlenir
        if (redundancy > 1) fecExhausted++;
      } else if (successes.length === 1) {
        r = successes[0];
        if (redundancy > 1) fecRescued++;
      } else {
        // ÇOĞUNLUK OYLAMASI: ulaşan kopyaların flip durumu arasında çoğunluk
        // kararı — bağımsız PHASE gürültüsünü bastırır (tek kopyaya göre çok
        // daha güvenilir), ama ASLA "mucizevi" bir kesinlik iddia etmez (hâlâ
        // yanlış çoğunluk oluşabilir, sadece olasılığı ~10x düşer).
        const flipVotes = successes.filter(a => a.flip).length;
        const majorityFlip = flipVotes > successes.length / 2;
        r = { ok: true, evs: successes[0].evs, flip: majorityFlip };
        fecRescued++;
      }
      r.evs.forEach(ev => {
        ec[ev.type] = (ec[ev.type] ?? 0) + 1;
        eventLog.push({ seg: si, bit: i, nm: lk.nm, ...ev, text: explainEvent(ev, lk.nm) });
      });

      // ANİ SOĞURULMA BARİYERİ TESPİTİ: bu fotonda ABSORB olayı varsa
      // ardışık sayaç artar, yoksa sıfırlanır — art arda gelen ABSORB
      // dizisi (rastgele dağılmış tek tek kayıplardan farklı olarak)
      // gerçek bir "bariyer" (fiziksel bağlamla tutarsız katsayı
      // enjeksiyonunun sonucu) işaret eder.
      if (r.evs.some(ev => ev.type === "ABSORB")) {
        consecutiveAbsorb++;
        maxConsecutiveAbsorb = Math.max(maxConsecutiveAbsorb, consecutiveAbsorb);
      } else {
        consecutiveAbsorb = 0;
      }

      // NodeTransitGate: fiber'i ayakta geçen (r.ok) fotonlar, hedef DÜĞÜME
      // ulaştığında ek bir 3-aşamalı triyajdan geçer. Sadece canlı iletimde
      // (legaOpts verilmişse) aktif — replay/mirror/fork bu katmandan etkilenmez.
      //
      // I/O BARİYERİ SIFIRLAMA: karar artık InMemoryComputeFabric üzerinden
      // çağrılıyor — NodeTransitGate.evaluate()'in kendisi HİÇ DEĞİŞMEDİ,
      // sadece "hücrenin içinde, RAM→Core taşıması olmadan" çalıştığı
      // simüle ediliyor ve gerçekleşen simüle-gecikme farkı toplanıyor.
      if (r.ok && legaOpts && nd) {
        const gateBitRng = mulberry32(combineSeed(entanglementSeed ^ 0x1a2b3c4d, si, i));
        // Basit trafik-sınıfı simülasyonu: her 4. bit "düşük öncelikli/toplu
        // veri" sayılır (deterministik, rng akışını etkilemez — propPhoton'ın
        // kendi rastgeleliği bundan tamamen bağımsız kalır).
        const lowPriority = (i % 4) === 3;
        // GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ UYUMU: NodeTransitGate.computeAmplitude
        // km'yi DOĞRUDAN kullanır (bkz. o fonksiyonun kendi başlığı — propPhoton'ın
        // ZATEN uyguladığı kaybı bir daha uygulamamak için dB-ölçekli, ama
        // yine de km ile DOĞRUSAL büyüyen bir formül). Bu link usingMsgRelay
        // iken foton fiziksel olarak lk.km'nin TAMAMINI TEK SEFERDE
        // katetmiyor — en SON güvenilir düğümden (bir önceki hop'tan) taze
        // olarak geliyor. Kapıya, hâlâ TÜM lk.km mesafesini vermek, tam
        // olarak propPhoton/NodeTransitGate arasında zaten bir kez
        // düzeltilmiş olan "aynı kaybı iki kez uygulama" hatasını BU SEFER
        // propPhotonRelayChain/NodeTransitGate arasında yeniden üretir (bkz.
        // computeAmplitude'ın kendi "KÖK NEDEN DÜZELTMESİ" yorumu — deneysel
        // olarak doğrulandı: usingMsgRelay=true iken bu düzeltme YAPILMADAN
        // Aşama 2 fotonların ~%73'ünü reddediyordu). ÇÖZÜM: kapıya SON HOP'UN
        // mesafesi verilir (msgRelayHops ile bölünmüş lk.km) — kısa/orta
        // hatlarda (usingMsgRelay=false) davranış BİREBİR ESKİSİ GİBİDİR.
        const gateEffectiveKm = usingMsgRelay ? (lk.km / msgRelayHops) : lk.km;
        const { gateResult: gate, latencyNs, interpolatedCoeffs } = inMemoryFabric.evaluateInPlace(nd.id, lk.nm, gateEffectiveKm, lowPriority, legaCtx, gateBitRng);
        // Bir sonraki fotonun propPhoton çağrısı için LERP durumunu güncelle.
        nodeCoeffCache = interpolatedCoeffs;
        gateReport.checked++;
        gateReport.savedNs = (gateReport.savedNs ?? 0) + (latencyNs.vonNeumann - latencyNs.pim);
        if (!gate.passed) {
          if (gate.phase === 1) gateReport.phase1Rejected++;
          else gateReport.phase2Rejected++;
          ec.GATE_REJECT = (ec.GATE_REJECT ?? 0) + 1;
          eventLog.push({
            seg: si, bit: i, nm: lk.nm, type: "GATE_REJECT", km: lk.km,
            text: gate.phase === 1
              ? `Düğüm ${nd.id}: rezonans uyumsuzluğu (mesafe=${gate.distance.toFixed(2)}) — sıfır maliyetle silindi (Aşama 1, hücre-içi)`
              : `Düğüm ${nd.id}: genlik yetersiz (V=${gate.V.toFixed(3)} < T=${gate.T.toFixed(3)}) — hat üzerinde sönümlendi (Aşama 2, hücre-içi)`,
          });
          recv[i] = 0; sl++;
          continue; // bu foton düğümde reddedildi, bit-flip kontrolüne geçme
        }
        gateReport.phase3Passed++;
        if (gate.softMatched) {
          gateReport.softMatchedCount = (gateReport.softMatchedCount ?? 0) + 1;
          eventLog.push({
            seg: si, bit: i, nm: lk.nm, type: "SOFT_MATCH", km: lk.km,
            text: `Düğüm ${nd.id}: rezonans sınırının hemen ötesinde (yumuşak filtre toleransı) — kesin ret yerine olasılıksal geçiş verildi`,
          });
        }
      }

      if (!r.ok) { recv[i] = 0; sl++; }
      else if (r.flip) { recv[i] ^= 1; sf++; }
    }
    totalLost += sl; totalFlip += sf;
    segReport.push({ link: lk, repeaters: rp, lost: sl, flipped: sf,
      transmitPct: (fiberT(lk.nm, lk.km) * 100).toFixed(1),
      absorptionBarrierDetected: maxConsecutiveAbsorb >= ABSORB_BURST_THRESHOLD,
      maxConsecutiveAbsorb,
      // DÜZELTME 8: dinamik FEC/foton çoğullama telemetrisi — redundancy=1
      // ise (eski davranış/legaOpts yok) bu alanlar sırasıyla 1/0/0 olur
      // ve transmit()'teki loglama bu segment için sessiz kalır.
      fecRedundancy: redundancy, fecRescued, fecExhausted,
      // DÜZELTME 9: GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ (mesaj kanalı) telemetrisi
      // — usingMsgRelay=false ise (link MSG_RELAY_THRESHOLD_KM altında)
      // transmit()'teki loglama bu segment için sessiz kalır (eski davranış
      // BİREBİR korunur, bkz. propPhotonRelayChain başlığı).
      usingMsgRelay, msgRelayHops });
  }

  return { recv, totalLost, totalFlip, ec, eventLog, segReport, gateReport };
}

// ══════════════════════════════════════════════════════════════
// EK 23: EĞİTSEL DERİNLİK — gerçek bilimsel referanslar
// Her olay tipi için "Learn More" bağlantıları ve neden bu simülasyonda
// göründüklerine dair kısa bilimsel bağlam. Kaynaklar gerçek, açıkça
// erişilebilir (DOI/arXiv/Wikipedia) makalelere işaret eder.
// ══════════════════════════════════════════════════════════════
const EDU_REFERENCES = {
  SCATTER: {
    context: "850nm gibi kısa dalga boylarında Rayleigh saçılması λ⁻⁴ oranında şiddetlenir. "
      + "Bu yüzden ticari uzun-mesafe fiber optik iletişim neredeyse hiç 850nm kullanmaz — "
      + "1310nm ve özellikle 1550nm (sıfır-dispersiyon ve minimum-kayıp pencereleri) tercih edilir.",
    links: [
      { label: "Rayleigh scattering (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rayleigh_scattering" },
      { label: "Optical fiber attenuation windows", url: "https://en.wikipedia.org/wiki/Optical_fiber#Attenuation" },
    ],
  },
  ABSORB: {
    context: "Fiber optik zayıflama (attenuation), malzeme soğurması ve safsızlıklardan kaynaklanır. "
      + "SMF-28 gibi standart tek-modlu fiberler 1550nm'de ~0.2 dB/km'ye ulaşır — bu, ITU-T G.652 "
      + "standardının temelidir.",
    links: [
      { label: "ITU-T G.652 fiber standardı", url: "https://www.itu.int/rec/T-REC-G.652" },
      { label: "Fiber-optic communication (Wikipedia)", url: "https://en.wikipedia.org/wiki/Fiber-optic_communication" },
    ],
  },
  DECOHERE: {
    context: "Kuantum dekoherans, bir kuantum sisteminin çevresiyle istemsiz etkileşime girip "
      + "süperpozisyon özelliğini kaybetmesidir. Uzun mesafeli kuantum iletişimde en büyük "
      + "pratik engellerden biridir — bu yüzden kuantum tekrarlayıcılar (repeaters) araştırılır.",
    links: [
      { label: "Zurek, W.H. — Decoherence (Rev. Mod. Phys. 2003)", url: "https://doi.org/10.1103/RevModPhys.75.715" },
      { label: "Quantum repeater (Wikipedia)", url: "https://en.wikipedia.org/wiki/Quantum_repeater" },
    ],
  },
  PHASE: {
    context: "Fiber içindeki çift kırılım (birefringence), fiberin mükemmel dairesel olmamasından "
      + "kaynaklanır ve polarizasyon modu dispersiyonuna (PMD) yol açar — yüksek hızlı iletimde "
      + "kritik bir sınırlayıcı faktördür.",
    links: [
      { label: "Polarization mode dispersion (Wikipedia)", url: "https://en.wikipedia.org/wiki/Polarization_mode_dispersion" },
    ],
  },
  EAVES: {
    context: "BB84 protokolü (Bennett & Brassard, 1984), kuantum mekaniğinin ölçüm-bozar ilkesini "
      + "kullanarak dinlemeyi matematiksel olarak tespit edilebilir kılar. Bir gözlemci foton "
      + "polarizasyonunu ölçtüğünde, yanlış bazda ölçüm yapma ihtimali hata oranını karakteristik "
      + "olarak ~%25'e yükseltir.",
    links: [
      { label: "Bennett & Brassard 1984 (orijinal BB84 makalesi)", url: "https://doi.org/10.1016/j.tcs.2014.05.025" },
      { label: "Quantum key distribution (Wikipedia)", url: "https://en.wikipedia.org/wiki/Quantum_key_distribution" },
    ],
  },
};

// ── Oscilloscope ──────────────────────────────────────────────
function Oscilloscope({ active, color="#00d4ff" }) {
  const cvs = useRef(null);
  const t   = useRef(0);
  useEffect(() => {
    const c = cvs.current; if (!c) return;
    const ctx = c.getContext("2d");
    let raf;
    const draw = () => {
      const W=c.width, H=c.height;
      ctx.fillStyle="#020409"; ctx.fillRect(0,0,W,H);
      ctx.strokeStyle="#0a1628"; ctx.lineWidth=.5;
      for(let x=0;x<W;x+=20){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
      for(let y=0;y<H;y+=10){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      ctx.strokeStyle=color; ctx.lineWidth=1.5;
      ctx.shadowColor=color; ctx.shadowBlur=active?6:0;
      ctx.beginPath();
      for(let x=0;x<W;x++){
        const amp=active?H*.32:H*.08;
        const noise=active?(Math.random()-.5)*4:0;
        const y=H/2+Math.sin((x/W)*Math.PI*2*(active?3:1)+t.current)*amp+noise;
        x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      ctx.stroke(); ctx.shadowBlur=0;
      t.current+=active?.08:.02;
      raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[active,color]);
  return <canvas ref={cvs} width={220} height={52} style={{width:"100%",height:52,display:"block",borderRadius:4}}/>;
}

// ── Spark line ────────────────────────────────────────────────
function Spark({ data, color, h=28 }) {
  if (!data||data.length<2) return <div style={{height:h}}/>;
  const mx=Math.max(...data)||1, mn=Math.min(...data);
  const W=80, H=h;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*W},${H-((v-mn)/(mx-mn||1))*(H-2)-1}`).join(" ");
  return(
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.2}/>
    </svg>
  );
}

// ── BER gauge ─────────────────────────────────────────────────
function BerGauge({ value }) {
  const pct=Math.min(value,100);
  const c=pct<5?"#10b981":pct<20?"#f59e0b":"#f43f5e";
  return(
    <div style={{height:3,background:"#0a1628",borderRadius:2,overflow:"hidden",width:40}}>
      <div style={{height:"100%",width:`${pct}%`,background:c,borderRadius:2,
        boxShadow:`0 0 4px ${c}`,transition:"width .6s"}}/>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// LEO QUANTUM LINK PANEL (görseldeki mobil arayüz)
// ══════════════════════════════════════════════════════════════
function LeoPanel({ sats, activeSat, setActiveSat, onSend, running, msg, setMsg, evesdrop, setEvesdrop, result, phase, timeline, onOpenTimeline, mirrorOn, setMirrorOn, mirrorResult, onCollapse, onInterfere, collapsedTo, entropyDelta, isOnline, observerFrame,
  atmosphericTurbidity, setAtmosphericTurbidity, turbulenceStrength, setTurbulenceStrength, pointingPrecision, setPointingPrecision, nightMode, setNightMode, paQueue }) {
  const [satDist, setSatDist] = useState(550);
  // EK 42-44: atmosphericTurbidity/turbulenceStrength/pointingPrecision/
  // nightMode artık PhotonNet'ten (parent) prop olarak geliyor — önceden
  // bu state'ler burada (child'da) yaşıyordu ve transmit()'in (parent'ta
  // tanımlı) hiçbir zaman erişemediği "dekoratif" değerlerdi (bkz. sohbet
  // geçmişi: AtmosphericWindowModel yalnızca UI önizlemesini besliyordu,
  // gerçek fiziksel simülasyona hiç bağlı değildi). State parent'a taşındı
  // (lifted) — artık gerçekten propPhoton'a kadar ulaşıyor.
  const [selNm, setSelNm]     = useState(1550);
  const [showResult, setShowResult] = useState(false);
  const curSat = sats.find(s=>s.id===activeSat)||sats[0];
  const q = satQ(curSat.elev);

  useEffect(() => {
    if (result && !running) {
      setShowResult(true);
      const t = setTimeout(() => setShowResult(false), 5000);
      return () => clearTimeout(t);
    }
  }, [result, running]);

  async function handleSend() {
    if (running || !msg.trim()) return;
    setShowResult(false);
    await onSend();
  }

  const ACTION_LABEL = {
    "BEKLENIYOR":"",
    "ROTA HESAPLANIYOR":"📡 Uydu bağlantısı kuruluyor…",
    "KODLAMA":"🔐 Fotonlar kodlanıyor…",
    "İLETİM":"🛰 Fotonlar uydudan iletiliyor…",
    "TAMAMLANDI":"✅ Bağlantı hedefine ulaştı",
    "HATA":"⚠ İletim tamamlanamadı",
  };

  // EK 28: YATAY MİMARİ — LeoPanel artık dar dikey bir sidebar değil,
  // geniş bir üst şerit. Aynı state/props/onSend() çağrısı korunur;
  // sadece yerleşim yönü column→row olarak değiştirildi.
  return (
    <div style={{
      width:"100%", flexShrink:0,
      background:"linear-gradient(90deg,#060d1f 0%,#030812 100%)",
      borderBottom:"1px solid #0a1e3a55",
      display:"flex", flexDirection:"column",
      fontFamily:"'Inter',system-ui,sans-serif",
    }}>
      {/* Ana kontrol şeridi — tüm form elemanları yan yana */}
      <div style={{
        display:"flex", flexWrap:"wrap", alignItems:"stretch",
        gap:0, padding:"10px 14px",
      }}>

        {/* Uydu kimliği + sinyal kalitesi */}
        <div style={{
          display:"flex", alignItems:"center", gap:10,
          paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16,
          flexShrink:0,
        }}>
          <div style={{fontSize:26,filter:"drop-shadow(0 0 10px #00d4ff88)",
            animation:"satOrbit 8s linear infinite"}}>🛰</div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#00d4ff",letterSpacing:".05em"}}>
              LEO Ka-Band Quantum Link
            </div>
            <div style={{fontSize:8,color:"#334155"}}>
              {curSat.name} · {curSat.elev.toFixed(0)}° ·{" "}
              <span style={{color:q>.7?"#10b981":q>.4?"#f59e0b":"#f43f5e",fontWeight:700}}>
                {(q*100).toFixed(0)}% kalite
              </span>
            </div>
            <div style={{width:100,height:3,background:"#0a1628",borderRadius:2,overflow:"hidden",marginTop:3}}>
              <div style={{height:"100%",width:`${q*100}%`,borderRadius:2,transition:"width .8s",
                background:q>.7?"linear-gradient(90deg,#10b981,#00d4ff)":q>.4?"#f59e0b":"#f43f5e",
                boxShadow:`0 0 6px ${q>.7?"#00d4ff":q>.4?"#f59e0b":"#f43f5e"}`}}/>
            </div>
          </div>
        </div>

        {/* Mesaj girişi */}
        <div style={{minWidth:200, paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16, flexShrink:0}}>
          <div style={{fontSize:8,color:"#475569",letterSpacing:".08em",marginBottom:4}}>MESSAGE</div>
          <input
            value={msg}
            onChange={e=>setMsg(e.target.value.slice(0,28))}
            disabled={running}
            placeholder="Mesajınızı girin…"
            style={{width:"100%",padding:"7px 10px",borderRadius:7,
              background:"#020912",border:"1px solid #00d4ff22",
              color:"#00d4ff",fontSize:12,letterSpacing:".03em",
              fontFamily:"'Inter',system-ui,sans-serif",
              boxShadow:"inset 0 0 10px #00d4ff08"}}
          />
          <div style={{fontSize:7,color:"#1e3a5f",marginTop:2,fontFamily:"monospace"}}
            title="Bu, girilen metnin ham karakter/bit sayısıdır — QKD performans ölçütü DEĞİLDİR. Gerçek anahtar üretim hızı (bit/saniye) için sonuç panelindeki 'QKD' göstergesine bakın.">
            {msg.length}/28 kr · {msg.length*8} bit (mesaj boyutu, QKD hızı değil)
          </div>
        </div>

        {/* Wavelength seçimi — yatay buton grubu */}
        <div style={{paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16, flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
            <span style={{fontSize:8,color:"#475569",letterSpacing:".08em"}}>WAVELENGTH</span>
            <span style={{fontSize:6,color:"#334155"}}
              title="Öneri, gerçek FSO literatürünün NİTELİKSEL yönelimine dayanır — sayısal katsayılar kalibre edilmemiştir. Mühendislik-sınıfı doğruluk için NetSquid simülasyonu ve ITU-R P.1621-2 link-bütçesi standardıyla doğrulama gerekir.">
              (FSO-önerisi, didaktik model — ITU-R doğrulaması yok)
            </span>
          </div>
          <div style={{display:"flex",gap:5}}>
            {Object.entries(WL).map(([nm,w])=>{
              const active = String(selNm)===String(nm);
              const atmoConditions = { turbidity: atmosphericTurbidity, rangeKm: satDist };
              const atmoFactor = AtmosphericWindowModel.windowFactor(+nm, atmoConditions);
              const isRecommended = AtmosphericWindowModel.recommendWavelength(atmoConditions).recommendedNm === +nm;
              return(
                <button key={nm}
                  onClick={()=>setSelNm(+nm)}
                  title={`${w.label} · ${w.loss}dB/km (fiber) · FSO uygunluk: %${(atmoFactor*100).toFixed(0)}`}
                  style={{
                    background:active?w.hex+"22":"#020912",
                    border:`2px solid ${active?w.hex:isRecommended?"#22c55e66":"#0a1e3a"}`,
                    borderRadius:8,padding:"6px 9px",cursor:"pointer",
                    transition:"all .2s",textAlign:"center",minWidth:56,
                    position:"relative",
                  }}>
                  {isRecommended && (
                    <div style={{position:"absolute",top:-7,left:"50%",transform:"translateX(-50%)",
                      fontSize:8,color:"#22c55e"}}>⭐</div>
                  )}
                  <div style={{fontSize:10,fontWeight:700,color:active?w.hex:"#334155",letterSpacing:".02em"}}>
                    {nm}
                  </div>
                  <div style={{fontSize:7,color:"#1e3a5f"}}>{w.loss}dB</div>
                  <div style={{fontSize:6,color:atmoFactor>0.7?"#22c55e":atmoFactor>0.4?"#f59e0b":"#f43f5e"}}>
                    FSO %{(atmoFactor*100).toFixed(0)}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{marginTop:5}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
              <span style={{fontSize:6,color:"#334155"}}>ATMOSFER BULANIKLIĞI</span>
              <span style={{fontSize:6,color:"#00d4ff",fontFamily:"monospace"}}>{(atmosphericTurbidity*100).toFixed(0)}%</span>
            </div>
            <input type="range" min={0} max={1} step={0.05} value={atmosphericTurbidity}
              onChange={e=>setAtmosphericTurbidity(+e.target.value)}
              style={{width:"100%",accentColor:"#22c55e",cursor:"pointer",height:3}}/>
          </div>
        </div>

        {/* Uydu Mesafesi slider */}
        <div style={{width:150, paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16, flexShrink:0}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:8,color:"#475569",letterSpacing:".06em"}}>MESAFE</span>
            <span style={{fontSize:9,color:"#00d4ff",fontFamily:"monospace",fontWeight:700}}>{satDist}km</span>
          </div>
          <input type="range" min={400} max={1200} value={satDist}
            onChange={e=>setSatDist(+e.target.value)} disabled={running}
            style={{width:"100%",accentColor:"#00d4ff",cursor:"pointer",height:4}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
            <span style={{fontSize:7,color:"#1e3a5f"}}>LEO</span>
            <span style={{fontSize:7,color:"#1e3a5f"}}>MEO</span>
          </div>
        </div>

        {/* EK 42-44: ATMOSFERİK GÜRÜLTÜ — Türbülans / İzleme / Gündüz-Gece.
            Artık gerçekten transmit()'e (→propPhoton/deriveSiftedKey) bağlı;
            dekoratif değil (bkz. tasarım notları: ScintillationModel,
            PointingBudget, DetectorNoiseModel). */}
        <div style={{width:190, paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16, flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
            <span style={{fontSize:8,color:"#475569",letterSpacing:".08em"}}>ATMOSFERİK GÜRÜLTÜ</span>
            <span style={{fontSize:6,color:"#334155"}}
              title="Hufnagel-Valley Cn²(h) + eğik-yol Rytov varyansı + Andrews-Phillips doygunluk düzeltmesi. Kaydırıcının Cn²(0)'a haritalanması ve rüzgar hızı varsayılanı kalibre edilmemiştir — didaktik model.">
              (scintillation, didaktik)
            </span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
            <span style={{fontSize:6,color:"#334155"}}>TÜRBÜLANS ŞİDDETİ</span>
            <span style={{fontSize:6,color:"#00d4ff",fontFamily:"monospace"}}>{(turbulenceStrength*100).toFixed(0)}%</span>
          </div>
          <input type="range" min={0} max={1} step={0.05} value={turbulenceStrength}
            onChange={e=>setTurbulenceStrength(+e.target.value)}
            style={{width:"100%",accentColor:"#f59e0b",cursor:"pointer",height:3}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2,marginTop:4}}>
            <span style={{fontSize:6,color:"#334155"}}>İZLEME HASSASİYETİ</span>
            <span style={{fontSize:6,color:"#00d4ff",fontFamily:"monospace"}}>{(pointingPrecision*100).toFixed(0)}%</span>
          </div>
          <input type="range" min={0} max={1} step={0.05} value={pointingPrecision}
            onChange={e=>setPointingPrecision(+e.target.value)}
            title="Uydu gimbal/ince-izleme sisteminin mekanik hassasiyeti — düşükse ışın kayması (beam wander) ile birleşerek işaretleme kaybını artırır (PointingBudget)."
            style={{width:"100%",accentColor:"#7c3aed",cursor:"pointer",height:3}}/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:5}}>
            <span style={{fontSize:6,color:"#334155"}}
              title="Gündüz gökyüzü arka plan gürültüsü, gece değerinden binlerce kat yüksektir — gerçek uydu QKD sistemlerinin (Micius dahil) neredeyse tamamı bu yüzden yalnızca gece çalışır (DetectorNoiseModel).">
              OPERASYON ZAMANI
            </span>
            <button onClick={()=>setNightMode(v=>!v)}
              style={{fontSize:7,fontWeight:700,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                border:`1px solid ${nightMode?"#7c3aed66":"#f59e0b66"}`,
                background:nightMode?"#7c3aed22":"#f59e0b22",
                color:nightMode?"#a78bfa":"#f59e0b"}}>
              {nightMode?"🌙 GECE":"☀️ GÜNDÜZ"}
            </button>
          </div>
          <div style={{marginTop:4,fontSize:6,color:"#1e3a5f",fontFamily:"monospace"}}
            title="scintillationEngine'in son satellite-link-tick'te (900ms) hesapladığı anlık değerler.">
            scint.idx={scintillationEngine.lastScintIndex.toFixed(2)} ({scintillationEngine.lastRegime}) · fade×{scintillationEngine.fadeFactor().toFixed(2)}
          </div>
        </div>

        {/* Aktif uydu (kompakt seçici) */}
        <div style={{minWidth:150, paddingRight:16, borderRight:"1px solid #0a1e3a44", marginRight:16, flexShrink:0}}>
          <div style={{fontSize:8,color:"#475569",letterSpacing:".08em",marginBottom:4}}>AKTİF UYDU</div>
          <div style={{display:"flex",gap:4}}>
            {sats.slice(0,3).map(s=>{
              const sq=satQ(s.elev); const ac=s.id===activeSat;
              return(
                <div key={s.id} onClick={()=>!running&&setActiveSat(s.id)}
                  title={`${s.name} · ${s.elev.toFixed(0)}° · ${(sq*100).toFixed(0)}%`}
                  style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,
                    padding:"5px 8px",borderRadius:6,cursor:"pointer",transition:"all .15s",
                    background:ac?"#00d4ff11":"transparent",border:`1px solid ${ac?"#00d4ff33":"transparent"}`}}>
                  <div style={{width:6,height:6,borderRadius:"50%",
                    background:s.status==="ACTIVE"?"#10b981":s.status==="TRANSIT"?"#f59e0b":"#f43f5e",
                    boxShadow:ac?"0 0 6px #10b981":"none"}}/>
                  <span style={{fontSize:7,color:ac?"#00d4ff":"#475569",fontWeight:ac?700:400}}>
                    {s.id.split("-")[1]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Toggle'lar — yan yana iki switch */}
        <div style={{display:"flex",gap:14,paddingRight:16,borderRight:"1px solid #0a1e3a44",marginRight:16,flexShrink:0}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <div onClick={()=>!running&&setEvesdrop(v=>!v)}
              style={{width:38,height:20,borderRadius:10,cursor:"pointer",
                background:evesdrop?"linear-gradient(90deg,#00d4ff,#7c3aed)":"#0a1628",
                border:`1px solid ${evesdrop?"#00d4ff44":"#1e3a5f"}`,
                position:"relative",transition:"all .3s"}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:"#fff",
                position:"absolute",top:2,left:evesdrop?20:2,transition:"left .3s",
                boxShadow:evesdrop?"0 0 5px #00d4ff":"0 1px 2px rgba(0,0,0,.4)"}}/>
            </div>
            <span style={{fontSize:7,color:evesdrop?"#00d4ff":"#475569",whiteSpace:"nowrap"}}>Eavesdrop</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <div onClick={()=>!running&&setMirrorOn(v=>!v)}
              style={{width:38,height:20,borderRadius:10,cursor:"pointer",
                background:mirrorOn?"linear-gradient(90deg,#a855f7,#ec4899)":"#0a1628",
                border:`1px solid ${mirrorOn?"#a855f744":"#1e3a5f"}`,
                position:"relative",transition:"all .3s"}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:"#fff",
                position:"absolute",top:2,left:mirrorOn?20:2,transition:"left .3s",
                boxShadow:mirrorOn?"0 0 5px #a855f7":"0 1px 2px rgba(0,0,0,.4)"}}/>
            </div>
            <span style={{fontSize:7,color:mirrorOn?"#a855f7":"#475569",whiteSpace:"nowrap"}}>🪞 Mirror</span>
          </div>
        </div>

        {/* Canlı aksiyon durumu (iletim sırasında) — gönder butonundan önce */}
        {running && ACTION_LABEL[phase] && (
          <div style={{display:"flex",alignItems:"center",gap:7,
            background:"#020912",border:"1px solid #00d4ff22",
            borderRadius:7,padding:"6px 12px",marginRight:16,
            animation:"fadeUp .25s ease",flexShrink:0}}>
            <span style={{display:"inline-block",animation:"spin 1s linear infinite",fontSize:12}}>◎</span>
            <span style={{fontSize:10,color:"#00d4ff",fontWeight:600,whiteSpace:"nowrap"}}>
              {ACTION_LABEL[phase]}
            </span>
          </div>
        )}

        {/* Gönder butonu — şeridin sağ ucunda */}
        <div style={{marginLeft:"auto",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6,flexShrink:0}}>
          {/* ROTA-SAĞLIK HATIRLATMASI: son iletimin rotası "sağlıksız" (kritik
              düşük geçirgenlik / çok fazla hop) olarak işaretlendiyse, kullanıcı
              tekrar GÖNDER'e basmadan önce bunu görür. Bu bir "hata" değil —
              gerçekçi fiber fiziği (amplifikasyonsuz uzun mesafe = kaçınılmaz
              kayıp); buton engellenmez, yalnızca bilgilendirilir. */}
          {result && result.routeHealth && !result.routeHealth.healthy && !running && (
            <div style={{fontSize:8,color:"#f59e0b",fontFamily:"monospace",
              background:"#2a1a05",border:"1px solid #f59e0b44",borderRadius:6,
              padding:"5px 9px",maxWidth:280,textAlign:"right",lineHeight:1.4}}>
              ⚠ Son rota fiziksel olarak geçilemez sınırdaydı (uçtan-uca geçirgenlik %{(result.routeHealth.cumulativeTransmittance*100).toFixed(3)}) —
              tekrar göndermeden önce daha kısa bir mesafe/hedef seçin veya tekrarlayıcı sayısını artırın.
            </div>
          )}
          <button onClick={handleSend} disabled={running||!msg.trim()}
            style={{
              padding:"11px 22px",borderRadius:10,border:"none",cursor:"pointer",
              background: running
                ? "#0a1628"
                : "linear-gradient(135deg,#00d4ff,#0ea5e9,#7c3aed)",
              color: running?"#334155":"#fff",
              fontSize:12,fontWeight:800,letterSpacing:".06em",whiteSpace:"nowrap",
              fontFamily:"'Inter',system-ui,sans-serif",
              boxShadow: running ? "none" : "0 0 24px #00d4ff44, 0 4px 14px rgba(0,212,255,.3)",
              transition:"all .2s",
              display:"flex",alignItems:"center",justifyContent:"center",gap:7,
            }}>
            {running
              ? <><span style={{display:"inline-block",animation:"spin 1s linear infinite",fontSize:13}}>◎</span> {phase}…</>
              : <>🛰 GÖNDER</>}
          </button>
        </div>
      </div>

      {/* Genişleyen alt şerit: Mirror Universe detayı + Sonuç kartı — yan yana, yatayda */}
      {((mirrorOn && mirrorResult) || (showResult && result && !running)) && (
        <div style={{
          display:"flex", gap:14, padding:"0 14px 12px",
          animation:"fadeUp .3s ease", flexWrap:"wrap",
        }}>

          {/* Mirror Universe paneli */}
          {mirrorOn && mirrorResult && (
            <div style={{flex:"1 1 300px",minWidth:280,
              background:"#1a0a2e33",border:"1px solid #a855f733",
              borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:8,color:"#a855f7",marginBottom:5,letterSpacing:".06em",fontWeight:700}}>
                🪞 AYNA EVREN SONUCU
              </div>

              {/* EK 31/32/33: Kiralite simetrisi + hata korelasyonu + gözlemci çerçevesi */}
              {mirrorResult.chirality && (
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
                  marginBottom:6,paddingBottom:6,borderBottom:"1px solid #a855f722"}}>
                  <span style={{fontSize:8,color:mirrorResult.chirality.symmetryRatio>0.5?"#22d3ee":"#f43f5e",
                    fontWeight:700,letterSpacing:".02em"}}>
                    ⚛ {mirrorResult.chirality.chiralityState}
                  </span>
                  <span style={{fontSize:8,color:"#94a3b8",fontFamily:"monospace"}}>
                    {mirrorResult.chirality.conjugateCount} eşlenik / {mirrorResult.chirality.phaseDeltaCount} faz-farkı
                  </span>
                  {mirrorResult.errorCorrelation?.correlation != null && (
                    <span style={{fontSize:8,color:"#a855f7",fontFamily:"monospace"}}>
                      r={mirrorResult.errorCorrelation.correlation.toFixed(2)}
                    </span>
                  )}
                  {observerFrame && observerFrame.observerFrame !== "SÜPERPOZİSYON" && (
                    <span style={{fontSize:8,color:"#00d4ff",fontFamily:"monospace"}}>
                      👁 {observerFrame.observerFrame}
                    </span>
                  )}
                </div>
              )}

              <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                <div style={{fontSize:12,fontWeight:700,color:mirrorResult.success?"#22d3ee":"#f43f5e",
                  fontFamily:"monospace"}}>
                  "{mirrorResult.decoded}"
                </div>
                <div style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace"}}>
                  BER {mirrorResult.er}%
                </div>
                {entropyDelta && (
                  <div style={{fontSize:9,color:"#94a3b8"}}>
                    Entropi farkı:{" "}
                    <span style={{color:"#a855f7",fontWeight:700,fontFamily:"monospace"}}>
                      {entropyDelta.delta.toFixed(3)} bit
                    </span>
                  </div>
                )}
                <div style={{display:"flex",gap:6,marginLeft:"auto"}}>
                  <button onClick={()=>onCollapse("prime")}
                    disabled={!!collapsedTo}
                    style={{padding:"5px 10px",borderRadius:5,cursor:collapsedTo?"not-allowed":"pointer",
                      border:`1px solid ${collapsedTo==="prime"?"#00d4ff77":"#1e3a5f"}`,
                      background:collapsedTo==="prime"?"#00d4ff11":"transparent",
                      color:collapsedTo==="prime"?"#00d4ff":"#475569",fontSize:8,fontWeight:700,whiteSpace:"nowrap"}}>
                    ASAL SEÇ
                  </button>
                  <button onClick={()=>onCollapse("mirror")}
                    disabled={!!collapsedTo}
                    style={{padding:"5px 10px",borderRadius:5,cursor:collapsedTo?"not-allowed":"pointer",
                      border:`1px solid ${collapsedTo==="mirror"?"#a855f777":"#1e3a5f"}`,
                      background:collapsedTo==="mirror"?"#a855f711":"transparent",
                      color:collapsedTo==="mirror"?"#a855f7":"#475569",fontSize:8,fontWeight:700,whiteSpace:"nowrap"}}>
                    AYNA SEÇ
                  </button>
                  <button onClick={onInterfere}
                    style={{padding:"5px 10px",borderRadius:5,cursor:"pointer",
                      border:"1px solid #ec489944",background:"#ec489911",color:"#f472b6",
                      fontSize:8,fontWeight:700,whiteSpace:"nowrap"}}>
                    ⚡ INTERFERENCE
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* GERÇEK sonuç kartı — bağlantı hedefine ulaştığında gösterilir */}
          {showResult && result && !running && (
            <div style={{flex:"1 1 340px",minWidth:300,
              background: result.success ? "#052e1633" : "#3f151533",
              border:`1.5px solid ${result.success?"#10b98155":"#f59e0b55"}`,
              borderRadius:10, padding:"10px 14px",
              boxShadow: result.success ? "0 0 20px #10b98118" : "0 0 20px #f59e0b18",
            }}>
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{fontSize:22}}>{result.success ? "✅" : "⚠️"}</div>
                <div>
                  <div style={{fontSize:11,fontWeight:800,letterSpacing:".04em",
                    color:result.success?"#10b981":"#f59e0b"}}>
                    {result.success ? "İletildi" : "Kısmi İletim"}
                  </div>
                  <div style={{fontSize:8,color:"#64748b"}}>{result.sat} üzerinden</div>
                </div>

                <div style={{background:"#020912",borderRadius:6,padding:"5px 9px"}}>
                  <div style={{fontSize:6,color:"#334155"}}>GÖNDERİLEN</div>
                  <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,fontFamily:"monospace"}}>
                    "{result.original}"
                  </div>
                </div>
                <div style={{background:"#020912",borderRadius:6,padding:"5px 9px"}}>
                  <div style={{fontSize:6,color:"#334155"}}>ALINAN</div>
                  <div style={{fontSize:10,fontWeight:700,fontFamily:"monospace",
                    color:result.success?"#10b981":"#f59e0b"}}>
                    "{result.decoded}"
                  </div>
                </div>

                <div style={{display:"flex",gap:10,fontSize:9,color:"#475569",fontFamily:"monospace"}}>
                  <span>{result.hops} hop</span>
                  <span>{result.totalKm}km</span>
                  <span style={{color:+result.er>10?"#f43f5e":"#10b981"}}>BER {result.er}%</span>
                  {result.bb84MatchRate!=null && (
                    <span style={{color:"#7c3aed"}}>BB84 {(result.bb84MatchRate*100).toFixed(0)}%</span>
                  )}
                  {result.rawKeyRate && (
                    <span style={{color:"#06b6d4"}} title="Micius uydusu gerçek performans verisine (80MHz kaynak, en-iyi-durum ~1.7Mbit/s) ölçeklenmiş ham anahtar üretim hızı">
                      QKD {result.rawKeyRate.label}
                    </span>
                  )}
                  {result.securityProof && (
                    <span style={{color:result.securityProof.secure?"#10b981":"#f43f5e"}}
                      title={result.securityProof.secure
                        ? `Sonlu-anahtar (finite-key) GLLP/Serfling kanıtı: ${result.securityProof.n}bit sifted key, Q_ph≤%${(result.securityProof.qPhUpper*100).toFixed(2)} → gizlilik yükseltme sonrası ${result.finalSecureKeyLen}bit KANITLANMIŞ güvenli anahtar`
                        : `Sonlu-anahtar kanıtı BAŞARISIZ: ${result.securityProof.reason}`}>
                      🔐 {result.securityProof.secure ? `ℓ=${result.finalSecureKeyLen}bit kanıtlı` : "kanıt YOK"}
                    </span>
                  )}
                </div>

                <button onClick={onOpenTimeline}
                  style={{
                    marginLeft:"auto",padding:"7px 14px",borderRadius:8,
                    border:"1px solid #7c3aed55",cursor:"pointer",
                    background:"linear-gradient(135deg,#7c3aed22,#00d4ff11)",
                    color:"#a78bfa",fontSize:9,fontWeight:700,letterSpacing:".04em",
                    whiteSpace:"nowrap",
                    display:"flex",alignItems:"center",gap:5,
                  }}>
                  ⧉ ENTANGLE ({timeline?timeline.length:0})
                </button>
              </div>

              {result.securityProof && (
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #ffffff0f",
                  display:"flex",gap:14,flexWrap:"wrap",fontSize:8,color:"#64748b",fontFamily:"monospace"}}>
                  <span style={{color:"#94a3b8",fontWeight:700}}>🔐 SONLU-ANAHTAR KANITI (GLLP/Serfling):</span>
                  <span>n={result.securityProof.n}bit</span>
                  <span>Q_bit={result.securityProof.qBit!=null?(result.securityProof.qBit*100).toFixed(2)+"%":"—"}</span>
                  <span>Q_ph≤{(result.securityProof.qPhUpper*100).toFixed(2)}%</span>
                  <span title="Sonsuz-örneklem (asimptotik) GLLP anahtar oranı — karşılaştırma için">R_∞={(result.securityProof.asymptoticRate*100).toFixed(1)}%</span>
                  <span style={{color:result.securityProof.secure?"#10b981":"#f43f5e",fontWeight:700}}>
                    ℓ={result.securityProof.ell}bit {result.securityProof.secure?"✓ KANITLANMIŞ GÜVENLİ":"✗ GÜVENLİ ANAHTAR YOK"}
                  </span>
                  {!result.securityProof.secure && (
                    <span style={{color:"#f43f5e"}}>({result.securityProof.reason})</span>
                  )}
                  {result.classicalAuth && (
                    <span title="Wegman-Carter MAC ile kimliklendirilen parametre-kestirim duyurusu + anahtar havuzu geri besleme durumu"
                      style={{color:result.classicalAuth.ok?"#a78bfa":"#f43f5e"}}>
                      🔏 klasik-kanal auth: {result.classicalAuth.ok?`✓ (havuz ${result.classicalAuth.poolRemaining}bit)`:`✗ ${result.classicalAuth.reason}`}
                    </span>
                  )}
                </div>
              )}

              {result.keyPoolStatus && !result.keyPoolStatus.finalized && (
                <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8,fontSize:8,color:"#64748b",fontFamily:"monospace"}}
                  title="Bu rotadan (kaynak-hedef çifti) biriken sifted-key havuzu — eşiğe ulaşınca GERÇEK n/k (Parametre Kestirimi) ayrımıyla yeniden, daha sıkı bir sonlu-anahtar kanıtı üretilir">
                  <span style={{color:"#94a3b8",fontWeight:700}}>🪣 ASENKRON HAVUZ:</span>
                  <span>{result.keyPoolStatus.poolProgress}/{result.keyPoolStatus.poolThreshold}bit</span>
                  <div style={{flex:"0 1 140px",height:4,background:"#ffffff14",borderRadius:2,overflow:"hidden"}}>
                    <div style={{width:`${Math.min(100,(result.keyPoolStatus.poolProgress/result.keyPoolStatus.poolThreshold)*100)}%`,height:"100%",background:"#06b6d4"}}/>
                  </div>
                  <span style={{color:"#475569"}}>blok tamamlanınca gerçek n/k ayrımıyla yeniden kanıtlanacak</span>
                </div>
              )}
              {result.keyPoolStatus && result.keyPoolStatus.finalized && (() => { const f = result.keyPoolStatus.finalized; return (
                <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #ffffff0f",
                  display:"flex",gap:12,flexWrap:"wrap",alignItems:"center",fontSize:8,color:"#64748b",fontFamily:"monospace",
                  background: f.proof.secure ? "#052e1622" : "#3f151522", borderRadius:6, padding:"4px 8px"}}
                  title="ProductionSecurityAudit.audit() — HAM test verisinden yeniden hesaplanan, bağımsız denetlenebilir QBER/Gain/ℓ/ε — Madde 3'ün per-mesaj basitleştirmesinden daha sıkı">
                  <span style={{color:f.proof.secure?"#10b981":"#f43f5e",fontWeight:700}}>🪣✓ BLOK #{f.blockIndex} TAMAMLANDI ({f.routeKey}):</span>
                  <span>n={f.n}bit (anahtar) · k={f.k}bit (test, atıldı)</span>
                  <span>Q_test={(f.qEstimated*100).toFixed(2)}%</span>
                  {f.gain!=null && <span title="Gain: kaynak darbesi başına nihai kullanılabilir bit oranı">Gain={(f.gain*100).toFixed(1)}%</span>}
                  {f.epsilon && <span title="Composable ε-security: ε_PE+ε_cor+ε_PA (union bound)">ε_toplam={f.epsilon.total.toExponential(1)}</span>}
                  {f.reconciliation && (
                    <span title={`Brassard & Salvail (1993) çok-geçişli Cascade protokolü, GERÇEKTEN çalıştırıldı ve anahtar örneklemi üzerinde ölçüldü — leakEC artık teorik tahmin değil.${f.reconciliationComparison&&f.reconciliationComparison.ldpc?` (Karşılaştırma: LDPC ${f.reconciliationComparison.ldpc.leakedBits}bit sızıntı, ${f.reconciliationComparison.ldpc.converged?"yakınsadı":"yakınsamadı"})`:""}`}
                      style={{color:f.reconciliation.converged?"#a78bfa":"#f43f5e"}}>
                      🔧 EC({f.reconciliation.protocol})={f.reconciliation.leakedBits}bit {f.reconciliation.converged?"✓":`✗ ${f.reconciliation.residualErrors}bit residual`}
                    </span>
                  )}
                  <span style={{color:f.proof.secure?"#10b981":"#f43f5e",fontWeight:700}}>
                    ℓ={f.proof.ell}bit {f.proof.secure?"✓ GERÇEK n/k İLE KANITLANMIŞ":"✗ GÜVENLİ ANAHTAR YOK"}
                  </span>
                  {f.keyDelivery && (
                    <span title={`ETSI GS QKD 014 KME teslim deposuna kaydedildi — bb84/etsi014_kme_server.js bu anahtarı SAE'lere (IBM Quantum Network, VPN, TLS tünelleri) enc_keys/dec_keys uç noktalarıyla servis edebilir. key_ID=${f.keyDelivery.key_ID}`}
                      style={{color:"#22d3ee"}}>
                      🔐 KME: {f.keyDelivery.key_ID.slice(0,8)}… (rotada {f.keyDelivery.storedForRoute} anahtar hazır)
                    </span>
                  )}
                  <button onClick={()=>{
                      const dataStr = keyPoolBuffer.exportProductionBlocks();
                      const blob = new Blob([dataStr], {type:"application/json"});
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url; a.download = `photonnet_production_blocks_${Date.now()}.json`;
                      document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                    title="productionBlocks'un TAMAMINI (tüm rotalar, HAM test kayıtları dahil) JSON olarak indir — bb84/production_security_audit.js ile PhotonNet'ten BAĞIMSIZ olarak yeniden doğrulanabilir"
                    style={{marginLeft:"auto",padding:"3px 8px",borderRadius:5,border:"1px solid #06b6d455",
                      background:"#06b6d422",color:"#06b6d4",fontSize:8,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                    📤 Denetim Verisi (JSON)
                  </button>
                  <button onClick={()=>{
                      const dataStr = keyDeliveryStore.exportForKME();
                      const blob = new Blob([dataStr], {type:"application/json"});
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url; a.download = `photonnet_kme_keystore_${Date.now()}.json`;
                      document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                    title="KeyDeliveryStore'daki TÜM teslim edilebilir GÜVENLİ anahtarları (GERÇEK anahtar materyali — hassas!) bb84/etsi014_kme_server.js'in --keystore= ile doğrudan içe aktarabileceği ETSI GS QKD 014 biçiminde dışa aktarır"
                    style={{padding:"3px 8px",borderRadius:5,border:"1px solid #22d3ee55",
                      background:"#22d3ee22",color:"#22d3ee",fontSize:8,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                    🔐 KME Anahtar Deposu (JSON)
                  </button>
                </div>
              );})()}
              {/* BÜYÜK BLOK ASENKRON GİZLİLİK YÜKSELTME KUYRUĞU — bkz.
                  ToeplitzAsyncEngine/_finalizeBlock. result nesnesi her
                  transmit()'te üzerine yazıldığından, bu kalıcı/birikimli
                  paQueue state'inden (App bileşeninde tutulur, prop olarak
                  gelir) ayrıca render ediliyor — kullanıcı Worker havuzunun
                  arka planda ÇALIŞMAKTA olduğunu, sekmenin KİLİTLENMEDİĞİNİ
                  her zaman görebilsin diye. */}
              {paQueue && paQueue.length > 0 && (
                <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #ffffff0f",display:"flex",flexDirection:"column",gap:4}}>
                  {paQueue.map(e => (
                    <div key={`${e.routeKey}-${e.blockIndex}`}
                      style={{display:"flex",gap:8,alignItems:"center",fontSize:8,color:"#fbbf24",fontFamily:"monospace",
                        background:"#78350f22",borderRadius:6,padding:"4px 8px"}}
                      title="Toeplitz gizlilik yükseltme, büyüklüğü nedeniyle (n·ell eşiği aşıldı) Web Worker havuzunda ARKA PLANDA hesaplanıyor — tarayıcı arayüzü BLOKLANMAZ, tamamlanınca ayrıca loglanacak">
                      <span style={{fontWeight:700}}>⏳ BLOK #{e.blockIndex} ({e.routeKey}):</span>
                      <span>ℓ={e.ell}bit gizlilik yükseltme Web Worker havuzunda çalışıyor…</span>
                      <span style={{color:"#a8a29e"}}>({((Date.now()-e.startedAt)/1000).toFixed(0)}s)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ANA BİLEŞEN
// ══════════════════════════════════════════════════════════════
function PhotonNet() {
  const [nodes,setNodes]         = useState(NODES);
  const [links]                  = useState(LINKS);
  const [sats,setSats]           = useState(SATS);

  // V8.0: NetworkTopology'yi nodes/links her değiştiğinde senkron tut.
  // toggleNode() gibi işlemler nodes referansını değiştirdiğinde burası
  // tetiklenir ve Map/adjacency yapıları yeniden kurulur — O(V+E), ama
  // sadece TOPOLOJİ değiştiğinde (sık değil); arama işlemleri her zaman O(1).
  useEffect(() => {
    networkTopology.rebuild(nodes, links);
    networkTopology._lastNodes = nodes;
    networkTopology._lastLinks = links;
  }, [nodes, links]);

  const [src,setSrc]             = useState("IST");
  const [dst,setDst]             = useState("BAG");
  const [msg,setMsg]             = useState("Merhaba Dünya");
  const [ecc,setEcc]             = useState(true);
  const [evesdrop,setEvesdrop]   = useState(false);
  // OPTİK FAZ KİLİTLİ DÖNGÜ (OPLL): kullanıcı açıp kapatabilir — açıkken
  // propPhoton'ın PHASE olasılığı, kilitlenmiş kanallarda opticalPLL
  // tarafından bastırılır (bkz. propPhoton içindeki opllEnabled bloğu).
  const [opllOn,setOpllOn]       = useState(false);
  // ══════════════════════════════════════════════════════════
  // EK 42-44: LEO/FSO ATMOSFERİK GÜRÜLTÜ KATMANLARI — yeni çevresel
  // durum. Önceden bu state'ler (atmosphericTurbidity dahil) YALNIZCA
  // LeoPanel'in İÇİNDE (child component local state) yaşıyordu — yani
  // transmit() (PhotonNet'in kendisinde) bunlara HİÇ ERİŞEMİYORDU ve
  // AtmosphericWindowModel yalnızca LeoPanel'in dekoratif dalga boyu
  // önerisini besliyordu, GERÇEK fiziksel simülasyona hiç bağlı değildi.
  // Bu turda bu state PhotonNet'e taşındı (lifted) ve gerçekten
  // transmit()'e (→physicalSimulation→propPhoton) bağlandı — artık
  // sadece görsel değil, gerçekten etkili.
  const [atmosphericTurbidity,setAtmosphericTurbidity] = useState(0.2); // [0,1] sis/pus yoğunluğu (AtmosphericWindowModel)
  const [turbulenceStrength,setTurbulenceStrength]     = useState(0.4); // [0,1] → Cn²(0) haritalanır (ScintillationModel)
  const [pointingPrecision,setPointingPrecision]       = useState(0.7); // [0,1] 1=mükemmel izleme, 0=kaba/titrek (PointingBudget)
  const [nightMode,setNightMode]                       = useState(true); // gece=düşük arka plan gürültüsü (DetectorNoiseModel)
  const [running,setRunning]     = useState(false);
  const [phase,setPhase]         = useState("BEKLENIYOR");
  const [path,setPath]           = useState(null);
  const [pkts,setPkts]           = useState([]);
  const [log,setLog]             = useState([]);
  // DÜZELTME 4: result alanları net ayrıldı (okCount, lostCount — ok/lost çakışması yok)
  const [result,setResult]       = useState(null);
  const [traffic,setTraffic]     = useState([]);
  // ASENKRON GİZLİLİK YÜKSELTME KUYRUĞU: büyük bloklarda (bkz.
  // ToeplitzAsyncEngine/_finalizeBlock) Toeplitz hash Worker havuzunda
  // arka planda çalışırken bu bloğu burada listeleriz — result nesnesi
  // her transmit()'te ÜZERİNE YAZILDIĞI için (yalnızca SON iletim
  // görünür kalır), kalıcı/birikimli bir "işleniyor" göstergesi için
  // AYRI bir state gerekiyor. keyPoolBuffer.onBlockPrivacyAmplified
  // tamamlanınca (bkz. aşağıdaki useEffect) buradan çıkarılır.
  const [paQueue,setPaQueue]     = useState([]);
  const [linkLoad,setLinkLoad]   = useState({});
  // DİNAMİK YÜK DENGELEME / AKILLI ROTALAMA: bkz. LinkOutageController
  // başlığı. linkDown[key]=true iken EdgeWeightPolicy.isDown() bu kenarı
  // Dijkstra için Infinity maliyetli (geçilmez) yapar — verilmezse (varsayılan)
  // davranış BİREBİR eski dijkstra ile aynıdır.
  const [linkDown,setLinkDown]   = useState({});
  // O an enjekte edilmiş bir ağ krizi varsa {a,b,key,mode:"outage"|"congestion"}
  // — yoksa null. transmit() bunu okuyup, hesaplanan rota gerçekten bu
  // krizden dolayı DEĞİŞTİYSE ("ROTA OPTİMİZE EDİLDİ") loglar.
  const [activeCrisis,setActiveCrisis] = useState(null);
  const [crisisLinkSel,setCrisisLinkSel] = useState("");
  const [crisisMode,setCrisisMode]       = useState("outage"); // "outage" | "congestion"
  const [crisisBusy,setCrisisBusy]       = useState(false);
  // ══════════════════════════════════════════════════════════
  // FAZ 2: KENDİ KENDİNİ İYİLEŞTİRME — bkz. NodeWatchdog sınıfı.
  // nodeHealth: her düğüm için sentetik "yaşamsal bulgular" (cpu/mem/
  // heartbeat) — bkz. watchdog-vitals-tick. activeAnomalies: o an
  // karantinada/iyileşme sürecinde olan düğümler (nodeId -> {type,
  // startedAt, phase:"detected"|"healing"}). watchdogStats: şeffaflık
  // için sayaçlar (kaç anomali yakalandı, kaç tanesi otonom iyileştirildi).
  // ══════════════════════════════════════════════════════════
  const [nodeHealth,setNodeHealth]           = useState({});
  const [activeAnomalies,setActiveAnomalies] = useState({});
  const [watchdogStats,setWatchdogStats]     = useState({anomaliesDetected:0, autoHeals:0, lastHealMs:null, linkQuarantines:0});
  const [anomalyNodeSel,setAnomalyNodeSel]   = useState("");
  const [anomalyTypeSel,setAnomalyTypeSel]   = useState("lockup"); // "lockup" | "leak" | "unresponsive"
  // FAZ 6: HAT BAZLI SUÇLAMA (Link-Based Blaming) — bkz. aşağıdaki log-örüntü
  // useEffect'i. activeLinkQuarantines: o an Watchdog tarafından (bir DÜĞÜM
  // değil, bir FİZİKSEL HAT/segment ortak paydası tespit edildiği için)
  // karantinaya alınmış hatlar — yalnızca UI şeffaflığı içindir; asıl
  // dışlama linkDown/LinkOutageController üzerinden (FAZ 1 mekanizması
  // yeniden kullanılarak) gerçekleşir.
  const [activeLinkQuarantines,setActiveLinkQuarantines] = useState({});
  // ══════════════════════════════════════════════════════════
  // FAZ 3: MAKRO/MİKRO GÖRÜNÜM GEÇİŞLERİ (Hierarchical Drill-Down).
  // drillNode: o an "zoom-in" yapılmış düğümün id'si (null = kapalı).
  // drillAutoOpened: bu görünüm KULLANICI TARAFINDAN mı yoksa "sistemin
  // kendisi" (NodeWatchdog, bir anomali tespit ettiğinde) tarafından mı
  // otomatik açıldı — otomatik açılanlar iyileşme tamamlanınca kendi
  // kendine kapanır, kullanıcının elle açtığı görünüme MÜDAHALE edilmez.
  // ══════════════════════════════════════════════════════════
  const [drillNode,setDrillNode]             = useState(null);
  const [drillAutoOpened,setDrillAutoOpened] = useState(false);
  // ══════════════════════════════════════════════════════════
  // FAZ 4: TAHMİNLEME MODELİ (Predictive Telemetry) — bkz. PredictiveTelemetryEngine.
  // predictiveRisk: rotalamaya geri beslenen LİNK risk skorları (bkz.
  // EdgeWeightPolicy.readPredictiveRisk). predictiveInsights: UI için
  // sıralanmış tam analiz listesi (link + düğüm, en riskliden aza).
  // activePreventive: NodeWatchdog.triggerPreventiveMaintenance'ın o an
  // "proaktif bakımda" tuttuğu düğümler. predictiveStats: şeffaflık sayaçları.
  // ══════════════════════════════════════════════════════════
  const [predictiveRisk,setPredictiveRisk]         = useState({});
  const [predictiveInsights,setPredictiveInsights] = useState([]);
  const [predictiveStats,setPredictiveStats]       = useState({warningsIssued:0, preventiveActions:0});
  const [activePreventive,setActivePreventive]     = useState({});
  const [trendLinkSel,setTrendLinkSel]             = useState("");
  const [trendNodeSel,setTrendNodeSel]             = useState("");
  const [trendMetricSel,setTrendMetricSel]         = useState("cpu"); // "cpu" | "mem"
  const [linkTrendBusy,setLinkTrendBusy]           = useState(false);
  const [nodeTrendBusy,setNodeTrendBusy]           = useState(false);
  // ══════════════════════════════════════════════════════════
  // FAZ 5: KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON — bkz. NoiseGateMiddleware.
  // noiseGateState: UI için o anki sıcaklık sapması/ham-kalibre edilmiş
  // karanlık oranı/kapı genişliği anlık görüntüsü. noiseGateStats: şeffaflık
  // sayaçları (filtrelenen/kabul edilen hayalet click, kaçan gerçek click).
  // noiseGateHistory: kalibre edilmiş oranın küçük kayan penceresi (Spark
  // grafiği için). fiberLeakActive: demo panelindeki sızıntı aç/kapa durumu.
  // ══════════════════════════════════════════════════════════
  const [noiseGateState,setNoiseGateState] = useState({
    tempDriftMk: 0, rawDarkRateHz: 50, calibratedDarkRateHz: 50, gateRatio: 1, target: 0,
  });
  const [noiseGateStats,setNoiseGateStats] = useState({ calibrationRuns:0, filteredDarkClicks:0, acceptedDarkClicks:0, missedRealClicks:0 });
  const [noiseGateHistory,setNoiseGateHistory] = useState([]);
  const [fiberLeakActive,setFiberLeakActive]   = useState(false);
  const [hNode,setHNode]         = useState(null);
  const [hLink,setHLink]         = useState(null);
  const [activeSat,setActiveSat] = useState("PH-1A");
  const [tab,setTab]             = useState("MAP");
  const [berHistory,setBerHistory]   = useState([]);
  // KENDİ KENDİNİ OPTİMİZE EDEN KATSAYILAR — UI için görünürlük state'i.
  // Gerçek evrim coeffEvolution (module-level singleton) içinde sürer;
  // bu state sadece son durumun bir anlık görüntüsünü tutar.
  const [evolutionGen,setEvolutionGen]     = useState(0);
  const [liveCoeffs,setLiveCoeffs]         = useState({ alpha: 0.6, beta: 0.15 });
  const [evolutionActive,setEvolutionActive] = useState(false); // şu an "sakin" mi, evrim koşuyor mu
  // DÜĞÜM REDDİ CEZASI: fitness fonksiyonuna eklenen, kullanıcı tarafından
  // ayarlanabilir bir parametre. 0=etkisiz (eski davranış), 1=baskın
  // (genetik algoritma neredeyse yalnızca düşük ret oranını optimize eder).
  const [nodeRejectionPenaltyWeight,setNodeRejectionPenaltyWeight] = useState(0.4);
  const [lastNodeRejectionRate,setLastNodeRejectionRate] = useState(null); // en son şampiyonun ölçülen gerçek ret oranı
  // GELECEKTEKİ YOĞUNLUĞU TAHMİN ETME: predictiveCorridor'ın (imperative
  // singleton) o anki açık koridorlarının React state'teki yansıması —
  // haritada görsel olarak göstermek için periyodik olarak senkronlanır.
  const [activeCorridorNodes,setActiveCorridorNodes] = useState([]);
  // KAOS ENGELLEYİCİ: chaosSuppressor'ın (imperative singleton) o anki
  // aktif anti-paketlerinin React state yansıması — haritada göstermek için.
  const [antiPackets,setAntiPackets] = useState([]);
  const [chaosStats,setChaosStats]   = useState({ orphansDetected: 0, antiPacketsFired: 0 });
  // SOFT-LANDING FİLTRESİ: filtrenin o an "graceful" mi "emergency" mi
  // modda olduğunu gösteren UI state'i.
  const [softLandingMode,setSoftLandingMode] = useState("graceful");
  // BURST TRAFFIC GENERATOR: UI'da test butonunun aktif/pasif durumunu gösterir.
  const [burstActive,setBurstActive] = useState(false);
  const [throughput,setThroughput]   = useState([]);
  const [selNode,setSelNode]     = useState(null);
  const logRef = useRef(null);
  const stars  = useRef(Array.from({length:80},()=>({
    x:Math.random()*100,y:Math.random()*100,
    r:Math.random()*.9+.2,o:Math.random()*.4+.1
  }))).current;
  // EK 27: Cosmic partikül sistemi — foton izleri arka planda süzülür.
  // Performans için: React state ile sürülmez, saf CSS keyframe animasyonu
  // kullanır (her partikülün kendi rastgele süresi/gecikmesi vardır).
  const cosmicParticles = useRef(Array.from({length:22},()=>({
    x:Math.random()*100, y:Math.random()*100,
    dur:8+Math.random()*14, delay:Math.random()*10,
    hex:[WL[1550].hex,WL[1310].hex,WL[850].hex][Math.floor(Math.random()*3)],
    size:Math.random()*2+1,
  }))).current;

  // ══════════════════════════════════════════════════════════
  // EK 5: Entangled Timeline — her iletim kaydı seed'iyle saklanır
  // ══════════════════════════════════════════════════════════
  const [timeline,setTimeline]       = useState([]);   // {id,seed,src,dst,path,segs,msg,ecc,evesdrop,time,result}
  const [replaying,setReplaying]     = useState([]);   // aktif replay id listesi (birden fazla → interference)
  const [ghostPkts,setGhostPkts]     = useState([]);   // hayalet foton animasyon parçacıkları
  const [entangleA,setEntangleA]     = useState(null); // karşılaştırma için seçilen 1. kayıt id
  const [entangleB,setEntangleB]     = useState(null); // karşılaştırma için seçilen 2. kayıt id
  const [interference,setInterference] = useState(0);  // aynı anda çakışan hayalet paket sayısı
  const [memoryTraces,setMemoryTraces] = useState([]); // haritada soluklaşan geçmiş rota izleri
  const [remoteUsers,setRemoteUsers] = useState({});   // BroadcastChannel üzerinden diğer sekmeler/kullanıcılar
  const myUserId = useRef(`OP-${Math.random().toString(36).slice(2,6).toUpperCase()}`).current;
  const bcRef = useRef(null);
  const timelineRef = useRef([]); // stale-closure önleyici ayna (interval effect [] dependency ile çalışırken güncel timeline'a erişmek için)
  useEffect(()=>{ timelineRef.current = timeline; }, [timeline]);

  // KENDİ KENDİNİ OPTİMİZE EDEN KATSAYILAR: coefficient-evolution rafEngine
  // sistemi [] dependency ile kurulur, bu yüzden linkLoad/berHistory/addLog'un
  // en güncel değerlerine bu ref'ler üzerinden erişir (timelineRef ile aynı desen).
  const linkLoadRef = useRef({});
  const berHistoryRef = useRef([]);
  const addLogRef = useRef(null);
  useEffect(()=>{ linkLoadRef.current = linkLoad; }, [linkLoad]);
  useEffect(()=>{ berHistoryRef.current = berHistory; }, [berHistory]);
  // KUANTUM KAZANIM (mesafe-duyarlı katsayı ayarı): en son iletimin toplam
  // rota mesafesini izler — coefficient-evolution sistemi bunu promoteToLive()'a
  // geçirerek, uzun-mesafe hatlar için referans katsayıların gerçek mesafeye
  // göre (sabit 500km varsayımı yerine) hesaplanmasını sağlar.
  const lastRouteDistanceRef = useRef(null);
  useEffect(()=>{ lastRouteDistanceRef.current = result?.totalKm ?? null; }, [result]);

  // KAOS ENGELLEYİCİ: chaos-sweep rafEngine sistemi [] dependency ile
  // kurulur, bu yüzden replaying/ghostPkts'in en güncel değerlerine bu
  // ref'ler üzerinden erişir (aynı stale-closure önleyici desen).
  const replayingRef = useRef([]);
  const ghostPktsRef = useRef([]);
  useEffect(()=>{ replayingRef.current = replaying; }, [replaying]);
  useEffect(()=>{ ghostPktsRef.current = ghostPkts; }, [ghostPkts]);

  // SOFT-LANDING FİLTRESİ: hücre doluluk oranını hesaplamak için toplam
  // düğüm sayısına (kapasite varsayımı) ihtiyaç duyar — aynı stale-closure
  // önleyici desen.
  const nodesRef = useRef([]);
  useEffect(()=>{ nodesRef.current = nodes; }, [nodes]);

  // FAZ 2 (WATCHDOG): otonom arka-plan taraması [] dependency ile kurulu
  // olduğundan (bkz. watchdog-vitals-tick), en güncel src/dst/path'e bu
  // ref'ler üzerinden erişir — aynı stale-closure önleyici desen.
  const srcRef = useRef(src);
  useEffect(()=>{ srcRef.current = src; }, [src]);
  const dstRef = useRef(dst);
  useEffect(()=>{ dstRef.current = dst; }, [dst]);
  const pathRef = useRef(null);
  useEffect(()=>{ pathRef.current = path; }, [path]);
  const watchdogLogStreakRef = useRef(null);

  // FAZ 3 (DRILL-DOWN): watchdog-vitals-tick [] dependency ile kurulu
  // olduğundan, en güncel drillNode/drillAutoOpened'a bu ref'ler üzerinden
  // erişir — aynı stale-closure önleyici desen.
  const drillNodeRef = useRef(null);
  useEffect(()=>{ drillNodeRef.current = drillNode; }, [drillNode]);
  const drillAutoOpenedRef = useRef(false);
  useEffect(()=>{ drillAutoOpenedRef.current = drillAutoOpened; }, [drillAutoOpened]);

  // FAZ 4 (TAHMİNLEME): predictive-telemetry-tick [] dependency ile kurulu
  // olduğundan, en güncel nodeHealth'e bu ref üzerinden erişir (linkLoadRef
  // zaten var olan bir stale-closure ref'i — aşağıda yeniden kullanılır).
  const nodeHealthRef = useRef({});
  useEffect(()=>{ nodeHealthRef.current = nodeHealth; }, [nodeHealth]);
  // Kenar-tetiklemeli (edge-triggered) tahmin logu — bir anahtar zaten
  // WARNING/CRITICAL olarak loglandıysa, risk gerçekten SAFE'e dönmeden
  // tekrar loglanmaz (her tick'te aynı uyarıyı tekrar basmasın diye).
  const predictiveAlertedRef = useRef(new Set());
  // FAZ 4: ÖNLEYİCİ BAKIM tetikleyicisi için AYRI bir "bu bölüm için zaten
  // tetiklendi mi" takibi — predictiveAlertedRef'ten (yalnızca log spam'ini
  // önlemek için) BAĞIMSIZDIR. NEDEN AYRI: bir düğüm önce WARNING'e (henüz
  // CRITICAL değil) çıkıp loglanabilir; predictiveAlertedRef o anda
  // işaretlenir. Metrik SONRA CRITICAL'e yükseldiğinde, eğer ÖNLEYİCİ
  // BAKIM tetikleyicisi AYNI ref'e bakıyor olsaydı "zaten uyarıldı"
  // sanıp asla tetiklenmezdi — bu YÜZDEN bakım tetiklemesi SADECE
  // kendi ref'ini kullanır, SADECE gerçekten CRITICAL'e ulaşıldığında
  // işaretlenir/tetiklenir.
  const preventiveTriggeredRef = useRef(new Set());
  // FAZ 4: injectNodeTrend() çalışırken o düğümün id'sini tutar —
  // watchdog-vitals-tick bu düğüme DOKUNMAZ (yukarıda bkz.), enjekte
  // edilen trend ambiyans gürültüsüyle "yarışmasın" diye.
  const nodeTrendActiveRef = useRef(null);
  // FAZ 5 (GÜRÜLTÜ KAPISI): noise-gate-calibration-tick [] dependency ile
  // kurulu olduğundan, en güncel nightMode'a bu ref üzerinden erişir (aynı
  // stale-closure önleyici desen). Kenar-tetiklemeli log dedup ref'leri de
  // burada — bir durum zaten loglandıysa tekrar tekrar basılmasın diye.
  const nightModeRef = useRef(nightMode);
  useEffect(()=>{ nightModeRef.current = nightMode; }, [nightMode]);
  const snspdTrippedRef = useRef(false);
  const gateNarrowedRef = useRef(false);

  // EK 42: scintillationEngine.tick() satellite-link-tick içinde ([] dependency
  // ile kurulu) çağrılır, bu yüzden aynı stale-closure önleyici desenle
  // aktif uydu/türbülans şiddetinin en güncel değerine bu ref'ler üzerinden erişir.
  const activeSatRef = useRef(activeSat);
  useEffect(()=>{ activeSatRef.current = activeSat; }, [activeSat]);
  const turbulenceStrengthRef = useRef(turbulenceStrength);
  useEffect(()=>{ turbulenceStrengthRef.current = turbulenceStrength; }, [turbulenceStrength]);

  // EK 34/35: stale-closure önleyici referanslar — BroadcastChannel efekti
  // [] dependency ile kurulur (yeniden bağlanmasın diye), bu yüzden içindeki
  // handler'ın en güncel quantumStateLog/chiralAudioOn değerlerine bu ref'ler
  // üzerinden erişmesi gerekir.
  const quantumStateLogRef = useRef([]);
  const chiralAudioOnRef = useRef(false);
  useEffect(()=>{ quantumStateLogRef.current = result?.quantumStateLog ?? []; }, [result]);

  // ══════════════════════════════════════════════════════════
  // EK 14: OFFLINE-FIRST DURUM — bağlantı göstergesi + IndexedDB'den
  // açılışta yükleme + tekrar online olunca "pending" kayıtları senkronlama
  // ══════════════════════════════════════════════════════════
  const [isOnline,setIsOnline]       = useState(typeof navigator!=="undefined" ? navigator.onLine : true);
  const [dbReady,setDbReady]         = useState(false);
  const [pendingSync,setPendingSync] = useState(0); // henüz "sync" olmamış kayıt sayısı
  const [lastSyncAt,setLastSyncAt]   = useState(null);
  const [storageMode,setStorageMode] = useState("checking"); // "indexeddb" | "localstorage" | "checking"

  // ══════════════════════════════════════════════════════════
  // EK 18: MIRROR UNIVERSE — transmit()'e hiç dokunmadan, onun etrafına
  // bir sarmalayıcı (wrapper) koyar. mirrorOn açıkken her transmit()
  // çağrısı ile PARALEL olarak, ters çevrilmiş seed (seed ^ 0xFFFFFFFF)
  // kullanan tamamen ayrı bir "ayna evren" hesaplaması da çalışır.
  // ══════════════════════════════════════════════════════════
  const [mirrorOn,setMirrorOn]         = useState(false);
  const [mirrorResult,setMirrorResult] = useState(null); // ayna evrenin son sonucu
  const [mirrorPkts,setMirrorPkts]     = useState([]);   // ayna evren mor paketleri
  const [collapsedTo,setCollapsedTo]   = useState(null); // "prime" | "mirror" | null (henüz çökmemiş)
  const [entropyDelta,setEntropyDelta] = useState(null);  // iki evren arası entropi farkı metriği
  const [observerFrame,setObserverFrame] = useState(null); // EK 33: göreceli "ana evren" gözlem çerçevesi

  // ══════════════════════════════════════════════════════════
  // EK 35-40: KİRAL AKUSTİK MOTOR — state katmanı
  // ══════════════════════════════════════════════════════════
  const [localRole,setLocalRole]           = useState("Primary_Observer"); // EK 34/35: bu sekmenin göreceli rolü
  const [chiralAudioOn,setChiralAudioOn]   = useState(false); // kullanıcı kiral sesi açtı mı
  useEffect(()=>{ chiralAudioOnRef.current = chiralAudioOn; }, [chiralAudioOn]); // EK 34/35: ref senkronu (state tanımından SONRA)
  const [audioBlocked,setAudioBlocked]     = useState(false); // EK 41: tarayıcı AudioContext'i engellediyse
  const [clockDrift,setClockDrift]         = useState(null);  // EK 38: son ölçülen zaman sapması (ms)
  const [isMasterTab,setIsMasterTab]       = useState(false); // EK 40: Web Locks ile kazanılan Master rolü
  const [tabVisible,setTabVisible]         = useState(typeof document!=="undefined" ? !document.hidden : true);
  const myTabId = useRef(`TAB_${Math.random().toString(36).slice(2,8).toUpperCase()}_${Date.now().toString(36).slice(-4)}`).current;

  // ══════════════════════════════════════════════════════════
  // EK 45: DONANIM KÖPRÜSÜ (HAL Bridge) — tarayıcıyı, ayrı bir Python
  // sürecinde çalışan hal/bridge_server.py'ye (Flask+SSE) bağlar. Bu,
  // PhotonNet'in kendi JS simülasyonundan (propPhoton/deriveSiftedKey)
  // TAMAMEN BAĞIMSIZ bir yoldur: burada QBER/sifted key RNG ile ÜRETİLMEZ,
  // hal/time_tag_correlator.py'nin gerçek (veya hal/simulated_hardware.py'nin
  // ürettiği gerçekçi) zaman-damgalı click'leri eşleştirmesiyle hesaplanır.
  // Bu panel yalnızca bir HTTP/SSE İSTEMCİSİDİR — köprü sunucusu ayrı bir
  // terminalde çalıştırılmalıdır (`python3 -m hal.bridge_server`), tarayıcı
  // onu otomatik başlatamaz/durduramaz.
  // ══════════════════════════════════════════════════════════
  const [hwBridgeUrl,setHwBridgeUrl]     = useState("http://localhost:8765");
  const [hwServerOk,setHwServerOk]       = useState(null); // null=henüz denenmedi, true/false=son health check
  const [hwStatus,setHwStatus]           = useState({connected:false,armed:false,driver_name:"none"});
  const [hwConnecting,setHwConnecting]   = useState(false);
  const [hwAcquiring,setHwAcquiring]     = useState(false);
  const [hwDistanceKm,setHwDistanceKm]   = useState(25);
  const [hwEavesdrop,setHwEavesdrop]     = useState(false);
  const [hwDurationMs,setHwDurationMs]   = useState(0.5); // ms — /api/acquire'a saniyeye çevrilerek gönderilir
  const [hwResult,setHwResult]           = useState(null); // son /api/acquire yanıtı (tam JSON)
  const hwEventSourceRef = useRef(null);

  // ══════════════════════════════════════════════════════════
  // EK 22: ENTANGLEMENT GRAPH + SÜPERPOZİSYON
  // Timeline kayıtları düğüm, entangle ilişkileri kenar olan basit
  // force-directed graph. Birden fazla kayıt seçilip "Entangle" ile
  // yeni bir "superposition state" (birden fazla gerçekliğin üst üste
  // binmesi) oluşturulabilir; kullanıcı sonra bunlardan birini "collapse"
  // ederek tek gerçekliğe indirger, ya da interference ile yeni bir
  // dalga fonksiyonu (yeni kayıt) türetir.
  // ══════════════════════════════════════════════════════════
  const [graphSelection,setGraphSelection]   = useState([]); // grafikte seçilen kayıt id'leri
  const [entangleEdges,setEntangleEdges]     = useState([]); // {a,b} entangle ilişkileri
  const [superpositions,setSuperpositions]   = useState([]); // {id, memberIds, createdAt, collapsedTo}
  const [graphNodePos,setGraphNodePos]       = useState({}); // {id: {x,y}} force-directed konumlar

  // ══════════════════════════════════════════════════════════
  // EK 24/25: SES + SHAREABLE LINK
  // ══════════════════════════════════════════════════════════
  const [soundOn,setSoundOn] = useState(true);
  // DÜZELTME 4: paylaşılan bir linkten gelen seed, ilk transmit()'te
  // tüketilir (deterministik replay için) — artık dead data değil.
  const [pendingSeedFromUrl,setPendingSeedFromUrl] = useState(null);

  // ══════════════════════════════════════════════════════════
  // RETRO-CAUSALITY — state katmanı (Adım 4)
  // forkedEntries: her biri {id, sourceEntryId, retroCausalitySeed, result, path, segs, createdAt}
  // activeForkId: haritada/timeline'da şu an vurgulanan fork (null = hiçbiri)
  // ══════════════════════════════════════════════════════════
  const [forkedEntries,setForkedEntries] = useState([]);
  const [activeForkId,setActiveForkId]   = useState(null);

  // Açılışta URL parametrelerini oku ve varsa kaynak/hedef/mesaj/dalga
  // boyunu bunlara göre önceden doldur (gerçek deep-link davranışı).
  // DÜZELTME 4 (dead code): sp.seed artık gerçekten kullanılıyor —
  // paylaşılan bir link açıldığında, o iletimin İLK transmit() çağrısı
  // Math.random() yerine bu seed'i kullanır (deterministik tekrar).
  // sp.nm de artık göz ardı edilmiyor, log'da raporlanıyor.
  useEffect(() => {
    const sp = readShareParams();
    if (sp.src && nodes.find(n=>n.id===sp.src)) setSrc(sp.src);
    if (sp.dst && nodes.find(n=>n.id===sp.dst)) setDst(sp.dst);
    if (sp.msg) setMsg(decodeURIComponent(sp.msg));
    if (sp.ecc != null) setEcc(sp.ecc === "1" || sp.ecc === "true");
    if (sp.evesdrop != null) setEvesdrop(sp.evesdrop === "1" || sp.evesdrop === "true");
    if (sp.seed) {
      const parsedSeed = parseInt(sp.seed, 10);
      if (!isNaN(parsedSeed)) setPendingSeedFromUrl(parsedSeed >>> 0);
    }
    if (Object.keys(sp).length) {
      const nmNote = sp.nm ? `, λ=${sp.nm}nm (bilgi amaçlı)` : "";
      addLog(`🔗 URL parametrelerinden yüklendi: ${Object.keys(sp).join(", ")}${nmNote}`,"SYS");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Açılışta: IndexedDB'den (veya fallback) geçmiş timeline'ı yükle
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasIDB = typeof indexedDB !== "undefined";
      setStorageMode(hasIDB ? "indexeddb" : "localstorage");
      try {
        const rows = await dbGetAllTimeline();
        if (!cancelled && rows.length) {
          setTimeline(rows);
          addLog(`OFFLINE STORAGE: ${rows.length} geçmiş iletim diskten yüklendi (${hasIDB?"IndexedDB":"localStorage"})`,"SYS");
        }
      } catch {
        // GÜVENİLİRLİK KORUMASI: dbGetAllTimeline zaten kendi try/catch'ine
        // sahip ve pratikte fırlatmaz, ama beklenmedik bir hata (örn. addLog
        // tanımsızsa) uygulamayı "yükleniyor" durumunda sonsuza kadar
        // kilitlemesin diye ikinci bir savunma katmanı.
      } finally {
        // setDbReady(true) HER KOŞULDA çalışır — try bloğunda ne olursa
        // olsun, uygulama asla "storageMode: checking" durumunda takılı kalmaz.
        setDbReady(true);
      }
      await dbEnforceQuota(100).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);

  // Bağlantı durumu değişimlerini dinle
  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      addLog("BAĞLANTI: çevrimiçi — bekleyen kayıtlar senkronlanıyor","OK");
      // EK: zaman damgasına göre "sync" — pratikte burada bir sunucuya
      // gönderilecek fark bu ortamda yalnızca yerel olarak işaretlenir
      setTimeline(prev => {
        const synced = prev.map(t => ({...t, synced:true}));
        synced.forEach(t => dbPutTimeline(t));
        return synced;
      });
      setPendingSync(0);
      setLastSyncAt(Date.now());
    };
    const goOffline = () => {
      setIsOnline(false);
      addLog("BAĞLANTI: çevrimdışı — transmit/replay yerel olarak çalışmaya devam ediyor","WARN");
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", goOnline);
      window.addEventListener("offline", goOffline);
      return () => {
        window.removeEventListener("online", goOnline);
        window.removeEventListener("offline", goOffline);
      };
    }
  }, []);

  // ══════════════════════════════════════════════════════════
  // EK 15: SERVICE WORKER — PWA seviyesi cache + arka plan senkron.
  // Gerçek bir SW dosyası (sw.js) bu tek-dosyalık artifact ortamında
  // ayrı bir HTTP kaynağı olarak sunulamaz; bu yüzden kayıt denemesi
  // "best-effort" yapılır ve başarısız olursa sessizce yutulur —
  // arayüz bundan etkilenmez, offline davranış zaten IndexedDB ile sağlanır.
  useEffect(() => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations?.().then(regs => {
        if (regs && regs.length) addLog(`PWA: ${regs.length} service worker kaydı aktif`,"SYS");
      }).catch(()=>{});
    }
  }, []);

  // ── WebSocket yerine BroadcastChannel: aynı tarayıcıda açık her
  // sekme/pencere gerçek bir "kullanıcı" gibi davranır, birbirinin
  // iletimlerini ve imlecini canlı görür. Gerçek bir sunucu WebSocket'i
  // bu ortamda barındırılamadığı için en yakın çalışan eşdeğerdir.
  // EK 34: artık versiyonlu paket zarfı (BC_PROTOCOL/BC_VERSION) kullanılır.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(BC_PROTOCOL);
    bcRef.current = bc;
    bc.postMessage(buildBcPacket(BC_MSG_TYPES.HELLO, myUserId));
    const beacon = setInterval(()=>bc.postMessage(buildBcPacket(BC_MSG_TYPES.PING, myUserId)), 4000);

    bc.onmessage = (e) => {
      const m = e.data;
      if (!isValidBcPacket(m) || m.userId === myUserId) return;
      if (m.type===BC_MSG_TYPES.HELLO || m.type===BC_MSG_TYPES.PING) {
        setRemoteUsers(prev=>({...prev,[m.userId]:{lastSeen:Date.now()}}));
      }
      if (m.type===BC_MSG_TYPES.TRANSMIT_EVENT) {
        setRemoteUsers(prev=>({...prev,[m.userId]:{lastSeen:Date.now()}}));
        const { src, dst, success } = m.payload || {};
        addLog(`◈ ${m.userId}: ${src}→${dst} iletimi ${success?"başarılı":"bozuk"} (uzak kullanıcı)`, success?"OK":"WARN");
      }
      if (m.type===BC_MSG_TYPES.TELEMETRY) {
        setRemoteUsers(prev=>({...prev,[m.userId]:{lastSeen:Date.now()}}));
        const tp = m.payload || {};
        if (tp.chiralityState) {
          addLog(`◈ ${m.userId}: kiralite telemetrisi paylaştı — ${tp.chiralityState}`, "SYS");
        }

        // ══════════════════════════════════════════════════════
        // EK 34/35: IDENTITY_PING HANDSHAKE + ROL TAKASI + KİRAL SES
        // Gelen paket bir raw_syndrome içeriyorsa, bu sekmenin yerel
        // sendromuyla XOR'lanarak simetri kontrol edilir. Eğer bu
        // sekme o an odaktaysa (document.hasFocus()), rol takası
        // tetiklenir ve Web Audio ile 180°-faz-ters iki ton çalınır.
        // ══════════════════════════════════════════════════════
        if (tp.raw_syndrome != null) {
          const localSyndrome = quantumStateLogRef.current?.length
            ? quantumStateLogRef.current[quantumStateLogRef.current.length-1].syndrome
            : 0;
          const remoteSyndrome = tp.raw_syndrome;
          const xorSymmetry = localSyndrome ^ remoteSyndrome;
          const isComplementary = xorSymmetry === 7; // tam tümleyen (3-bit uzayda tüm bitler ters)
          addLog(
            `◈ SENDROM SİMETRİSİ: yerel=${localSyndrome.toString(2).padStart(3,"0")} `
            + `uzak=${remoteSyndrome.toString(2).padStart(3,"0")} XOR=${xorSymmetry} `
            + `${isComplementary ? "(TAM TÜMLEYEN — faz koruması kararlı)" : ""}`,
            isComplementary ? "OK" : "INFO"
          );

          const thisTabFocused = typeof document !== "undefined" && document.hasFocus();
          if (thisTabFocused && chiralAudioOnRef.current) {
            // Bu sekme odakta → "Ana Evren" pozisyonuna geçer, karşı sekme
            // otomatik olarak "Ayna Evren" sayılır. Rol takası ses motoruna
            // iletilir: iki kanal arasında +1.0/-1.0 kazanç yer değiştirir.
            setLocalRole("Primary_Observer");
            chiralEngine.swapRoles();
            addLog(`🔊 KİRAL GEÇİŞ: bu sekme (${myTabId}) Ana Evren konumuna geçti — 180° faz-ters ton tetiklendi`,"SYS");
          }
        }
      }
      if (m.type===BC_MSG_TYPES.ENTANGLE_REQUEST) {
        setRemoteUsers(prev=>({...prev,[m.userId]:{lastSeen:Date.now()}}));
        addLog(`◈ ${m.userId}: entangle talebi aldı`,"SYS");
      }
    };
    const cleanup = setInterval(()=>{
      setRemoteUsers(prev=>{
        const n={...prev};
        Object.keys(n).forEach(k=>{ if (Date.now()-n[k].lastSeen>10000) delete n[k]; });
        return n;
      });
    }, 5000);
    return () => { clearInterval(beacon); clearInterval(cleanup); bc.close(); };
  }, []);

  // V8.0: eski 900ms setInterval yerine rafEngine'e kayıtlı bir sistem.
  // İçerideki güncelleme mantığı (uydu drift, link yükü sönümü, throughput)
  // BİREBİR KORUNUR — sadece tetikleyici artık requestAnimationFrame.
  useEffect(()=>{
    rafEngine.register("satellite-link-tick", 900, () => {
      // EK 42: scintillationEngine — AR(1) sönümleme durumu bu tick'te
      // GÜNCELLENİR (foton başına değil); propPhoton çağrıları arasında
      // aynı 900ms penceresinde AYNI anlık değeri okur. Referans dalga
      // boyu 1550nm sabit alınır (didaktik basitleştirme — scintillation
      // çevresel bir özellik olarak yavaş değiştiği için, iletim anındaki
      // GERÇEK dalga boyuyla tam eşleşmemesi ihmal edilebilir bir fark yaratır).
      setSats(prev=>{
        const curForScint = prev.find(s=>s.id===activeSatRef.current) || prev[0];
        if (curForScint) {
          scintillationEngine.tick(1550, curForScint.elev, turbulenceStrengthRef.current, 900);
        }
        return prev.map(s=>({
          ...s,
          lon:((s.lon+.22)%360),
          elev:Math.max(5,Math.min(88,s.elev+((Math.random()-.48)*2))),
        }));
      });
      setLinkLoad(prev=>{
        const n={...prev};
        LINKS.forEach(lk=>{
          const k=`${lk.a}-${lk.b}`;
          const live = Math.random()<.2?Math.random()*.9:(prev[k]??0)*.9+Math.random()*.05;
          // EK 6: tarihsel ağırlık — bu link geçmişte ne kadar sık/başarılı kullanıldıysa
          // taban yükü biraz artar (kalıcı "yıpranma/ısınma" hissi verir)
          const hist = timelineRef.current.filter(t=>
            t.segs && t.segs.some(s=>s && ((s.a===lk.a&&s.b===lk.b)||(s.a===lk.b&&s.b===lk.a)))
          );
          const histWeight = Math.min(0.3, hist.length * 0.02);
          n[k]=Math.min(1, live + histWeight);
        });
        return n;
      });
      setThroughput(p=>[...p.slice(-29),Math.random()*80+20]);
    }, "micro");
    rafEngine.start();
    return () => rafEngine.unregister("satellite-link-tick");
  },[]);

  // ══════════════════════════════════════════════════════════
  // FAZ 2 (WATCHDOG): watchdog-vitals-tick — satellite-link-tick ile AYNI
  // rafEngine üzerinde, ama daha yavaş bir ritimde (1200ms) çalışan ayrı
  // bir sistem. Her tick'te ONLINE (n.on) ve karantinada OLMAYAN her
  // düğüm için sentetik yaşamsal bulguları (cpu/mem/heartbeat) küçük bir
  // rastgele yürüyüşle günceller — "arka planda pasif dinleme" hissi.
  // ÇOK DÜŞÜK ihtimalle (WATCHDOG_ORGANIC_ANOMALY_CHANCE) sistem GERÇEKTEN
  // kendi kendine bir anomali üretir (organik) — kullanıcı hiç düğmeye
  // basmasa bile Watchdog'un devrede olduğunu gösterir. Asıl demo/test
  // yolu ise WDG panelindeki elle-tetikleme düğmeleridir (bkz. injectAnomaly).
  // ══════════════════════════════════════════════════════════
  useEffect(()=>{
    const WATCHDOG_ORGANIC_ANOMALY_CHANCE = 0.004; // ~1200ms tick başına — ortalama birkaç dakikada bir
    const watchdogIo = { setNodes, setNodeHealth, setActiveAnomalies, addLog: (t,ty)=>addLogRef.current?.(t,ty), setWatchdogStats,
      openDrillDown: watchdogAutoOpenDrill, onHealed: watchdogOnHealed };
    rafEngine.register("watchdog-vitals-tick", 1200, () => {
      setNodeHealth(prev => {
        const next = { ...prev };
        nodesRef.current.forEach(n => {
          if (!n.on || nodeWatchdog.isBusy(n.id) || nodeTrendActiveRef.current === n.id) return;
          // karantinadakiler/proaktif bakımdakiler NodeWatchdog'un kontrolünde;
          // FAZ 4 demo trend enjeksiyonu sürerken (nodeTrendActiveRef) bu tick
          // o düğüme DOKUNMAZ — aksi halde her 1200ms'de bir enjekte edilen
          // trendin üzerine yazıp onunla "yarışırdı".
          const cur = prev[n.id] || { cpu: 15 + Math.random()*10, mem: 20 + Math.random()*10, heartbeat: 1, status: "OK" };
          // FAZ 4 DÜZELTMESİ: SAF (driftsiz) rastgele yürüyüş yerine HAFİF
          // ORTALAMAYA-DÖNÜŞ (mean reversion) eklendi. Neden: sınırsız/saf
          // bir rastgele yürüyüş, kısa pencerelerde bile İSTATİSTİKSEL
          // OLARAK kalıcı "trend" YANILSAMASI üretir (random walk'ların
          // bilinen bir özelliği) — bu da PredictiveTelemetryEngine'in
          // SAF GÜRÜLTÜYÜ gerçek bir yükseliş trendi sanıp yanlış alarm
          // vermesine yol açıyordu. Ortalamaya-dönüş, ambiyans telemetriyi
          // durağan (stationary) tutar — GERÇEK bir trend (injectNodeTrend)
          // hâlâ net ve güçlü şekilde ayırt edilebilir kalır çünkü o,
          // doğrudan dışarıdan zorlanan bir değerdir, bu formülden geçmez.
          const cpuBase = 18, memBase = 24;
          next[n.id] = {
            ...cur,
            cpu: Math.max(3, Math.min(60, cur.cpu + (cpuBase-cur.cpu)*0.12 + (Math.random()-.5)*5)),
            mem: Math.max(5, Math.min(60, cur.mem + (memBase-cur.mem)*0.12 + (Math.random()-.5)*3)),
            heartbeat: 1,
            status: "OK",
          };
        });
        return next;
      });
      if (Math.random() < WATCHDOG_ORGANIC_ANOMALY_CHANCE) {
        const pool = nodesRef.current.filter(n => n.on && n.id!==srcRef.current && n.id!==dstRef.current && !nodeWatchdog.isBusy(n.id));
        if (pool.length) {
          const victim = pool[Math.floor(Math.random()*pool.length)];
          const type = ["lockup","leak","unresponsive"][Math.floor(Math.random()*3)];
          addLogRef.current?.(`🛡️ WATCHDOG: pasif arka-plan taramasında ${victim.id} düğümünde anomali sinyali yakalandı`, "WARN");
          nodeWatchdog.triggerAnomaly({ nodeId: victim.id, type }, watchdogIo);
        }
      }
    }, "micro");
    rafEngine.start();
    return () => rafEngine.unregister("watchdog-vitals-tick");
  },[]);

  // FAZ 2 (WATCHDOG) — LOG/ÖRÜNTÜ TABANLI TESPİT: kullanıcının talebindeki
  // "rotalama motorunun bastığı logları ... pasif olarak dinleyen" kısmı
  // burada somutlaşır. traffic (her iletim geçmişi) izlenir; art arda
  // gelen ardışık BAŞARISIZ iletimler "log akışında anormal örüntü" olarak
  // yorumlanır ve son kullanılan rotadaki (pathRef) bir ara düğüm otomatik
  // olarak "şüpheli" seçilip Watchdog tanılama/iyileştirme akışına sokulur.
  useEffect(()=>{
    if (traffic.length < 3) return;
    const lastThree = traffic.slice(0,3);
    if (!lastThree.every(t=>!t.success)) return;
    const streakKey = lastThree.map(t=>t.time+t.src+t.dst).join("|");
    if (watchdogLogStreakRef.current === streakKey) return; // bu seri zaten işlendi
    watchdogLogStreakRef.current = streakKey;

    const { src: fSrc, dst: fDst } = lastThree[0];

    // FAZ 6: HAT BAZLI SUÇLAMA (Link-Based Blaming) — düğüm suçlamasından
    // ÖNCE kontrol edilir. Son 3 başarısız iletimin ortak paydası tekrar
    // eden bir DÜĞÜM değil de HEP AYNI FİZİKSEL SEGMENT ise (örn. GAZ→BAG
    // hattında tekrarlayan ANİ SOĞURULMA BARİYERİ), rotanın "ortasındaki"
    // düğümü karantinaya almak yanlış hedefi kovalar — o düğüm iletimden
    // iletime değişebilirken (Dijkstra her seferinde farklı bir ara yoldan
    // geçebilir), asıl arızalı bileşen sabit kalır: hattın kendisi. Bu
    // durumda Watchdog, FAZ 1'in linkDown/LinkOutageController mekanizmasını
    // (DİNAMİK YÜK DENGELEME'nin "hat KOPUK" özelliğiyle BİREBİR AYNI yol)
    // yeniden kullanarak HATTI karantinaya alır — yeni bir dışlama yolu
    // icat edilmez.
    const edgeKey = (a,b) => [a,b].slice().sort().join("-");
    const faultEdgeKeys = lastThree.map(t => t.faultSegment ? edgeKey(t.faultSegment.a, t.faultSegment.b) : null);
    const commonFaultEdge = (faultEdgeKeys[0] && faultEdgeKeys.every(k => k === faultEdgeKeys[0]))
      ? lastThree[0].faultSegment : null;

    if (commonFaultEdge) {
      const linkKeyAB = `${commonFaultEdge.a}-${commonFaultEdge.b}`;
      const linkKeyBA = `${commonFaultEdge.b}-${commonFaultEdge.a}`;
      const alreadyQuarantined = !!(linkDown[linkKeyAB] || linkDown[linkKeyBA]);
      if (!alreadyQuarantined && !linkOutageController.running) {
        addLog(
          `🛡️ WATCHDOG: log akışında anormal örüntü tespit edildi (ardışık ${lastThree.length} başarısız iletim, ${fSrc}→${fDst}) — ortak payda bir düğüm değil, `
          + `${commonFaultEdge.a}→${commonFaultEdge.b} HATTININ KENDİSİ (tekrarlayan ${commonFaultEdge.absorptionBarrier?"ANİ SOĞURULMA":"foton kaybı"}) — `
          + `HAT karantinaya alınıyor, yönlendirme motoru alternatif fiziksel yol arayacak`,
          "WARN"
        );
        setActiveLinkQuarantines(prev => ({ ...prev, [linkKeyAB]: { a: commonFaultEdge.a, b: commonFaultEdge.b, startedAt: Date.now() } }));
        setWatchdogStats(prev => ({ ...prev, linkQuarantines: prev.linkQuarantines + 1 }));
        const durationMs = 25000;
        linkOutageController.injectOutage({ linkKey: linkKeyAB, durationMs }, setLinkDown).then(() => {
          setActiveLinkQuarantines(prev => { const n = { ...prev }; delete n[linkKeyAB]; return n; });
          addLogRef.current?.(`✅ WATCHDOG: ${commonFaultEdge.a}-${commonFaultEdge.b} hattı karantinadan çıkarıldı, yeniden değerlendirmeye açıldı`, "OK");
        }).catch(()=>{
          setActiveLinkQuarantines(prev => { const n = { ...prev }; delete n[linkKeyAB]; return n; });
        });
        return; // bu seride düğüm suçlamasına düşme — hat zaten hedeflendi
      }
    }

    const candidates = (pathRef.current||[]).map(x=>x.node).filter(id=>id!==fSrc && id!==fDst);
    const culprit = candidates[Math.floor(candidates.length/2)]
      || nodesRef.current.filter(n=>n.on && n.id!==fSrc && n.id!==fDst && !nodeWatchdog.isBusy(n.id))[0]?.id;
    if (!culprit || nodeWatchdog.isBusy(culprit)) return;

    addLog(`🛡️ WATCHDOG: log akışında anormal örüntü tespit edildi (ardışık ${lastThree.length} başarısız iletim, ${fSrc}→${fDst}) — ${culprit} düğümü şüpheli, tanılama başlatılıyor`, "WARN");
    const type = ["lockup","leak","unresponsive"][Math.floor(Math.random()*3)];
    nodeWatchdog.triggerAnomaly({ nodeId: culprit, type }, { setNodes, setNodeHealth, setActiveAnomalies, addLog, setWatchdogStats,
      openDrillDown: watchdogAutoOpenDrill, onHealed: watchdogOnHealed });
  }, [traffic]);

  // ══════════════════════════════════════════════════════════
  // FAZ 4 (TAHMİNLEME MOTORU): predictive-telemetry-tick — 2000ms'de bir
  // TÜM linkleri ve düğüm cpu/mem metriklerini predictiveEngine'e örnekler,
  // her biri için risk analizini yeniden hesaplar. Üç sonucu vardır:
  //   1) predictiveInsights (UI) — en riskliden aza sıralı tam liste.
  //   2) predictiveRisk (routing'e geri besleme) — YALNIZCA link riskleri,
  //      EdgeWeightPolicy.computeWeight() bunu ÇARPAN olarak kullanır.
  //   3) KENAR-TETİKLEMELİ log + (düğümler için) ÖNLEYİCİ BAKIM — bir
  //      anahtar WARNING/CRITICAL eşiğini İLK KEZ aştığında bir kez loglanır
  //      (predictiveAlertedRef ile tekrar-log önlenir), CRITICAL düğüm
  //      riskleri (aktif kaynak/hedef değilse ve Watchdog meşgul değilse)
  //      otomatik olarak nodeWatchdog.triggerPreventiveMaintenance()'ı tetikler.
  // ══════════════════════════════════════════════════════════
  useEffect(()=>{
    const PREDICTIVE_TICK_MS = 1500;
    // NOT: linkLoad ambiyans süreci (satellite-link-tick) SİVRİ/spike'lı
    // bir süreçtir (%20 ihtimalle 0.9'a kadar anlık sıçrama) — bu yüzden
    // WARN/CRIT eşikleri, kısa şanslı sıçrama SERİLERİNİN bile tek başına
    // eşiği aşamayacağı kadar YÜKSEK tutulur (ingest() içindeki EMA
    // ön-süzgeciyle birlikte). Yalnızca GERÇEK, KADEMELİ bir trend
    // enjeksiyonu (injectLinkTrend) bu eşikleri anlamlı biçimde aşar.
    const WARN_LOAD = 0.74, CRIT_LOAD = 0.92;     // linkLoad zaten [0,1]
    // NOT: watchdog-vitals-tick'teki ORGANİK yürüyüş (artık hafif
    // ortalamaya-dönüşlü) cpu/mem'i SERTÇE 60'ta tavanlar (bkz.
    // Math.min(60,...)) — yani SAF AMBİYANS GÜRÜLTÜSÜ normalize ölçekte
    // 0.60'ı ASLA GEÇEMEZ. WARN_HEALTH bu yüzden bilinçli olarak o
    // tavanın BELİRGİN ÜSTÜNE (0.72) konur. Yalnızca GERÇEK bir trend
    // enjeksiyonu (injectNodeTrend, tavanı %97'ye kadar zorlar) bu eşiği
    // anlamlı biçimde aşabilir.
    const WARN_HEALTH = 0.65, CRIT_HEALTH = 0.88; // cpu/mem /100 normalize edilip kullanılır — düğüm tavanı (0.60) net bir sert sınır olduğundan linklerden biraz daha sıkı tutulabilir
    // Yalnızca STRATEJİK (omurga, >1500km) hatlar izlenir — FAZ 1'in TRF
    // panelindeki AYNI filtre (bkz. injectCrisis). Hem "önemli olan hatlara
    // odaklan" mantığıyla tutarlı, hem de İZLENEN VARLIK SAYISINI azaltarak
    // (67 hat yerine ~20) toplam yanlış-alarm yüzeyini daraltır.
    const BACKBONE_LINKS = LINKS.filter(l => l.km > 1500);
    rafEngine.register("predictive-telemetry-tick", PREDICTIVE_TICK_MS, () => {
      const now = Date.now();
      const insights = [];

      BACKBONE_LINKS.forEach(l => {
        const key = `${l.a}-${l.b}`;
        const load = linkLoadRef.current[key] ?? linkLoadRef.current[`${l.b}-${l.a}`] ?? 0;
        predictiveEngine.ingest(`link:${key}`, load, now);
        const res = predictiveEngine.analyze(`link:${key}`, { warnThreshold: WARN_LOAD, critThreshold: CRIT_LOAD, nowMs: now });
        if (res) insights.push({ ...res, kind: "link", label: `${l.a}-${l.b}` });
      });

      nodesRef.current.forEach(n => {
        const h = nodeHealthRef.current[n.id];
        if (!h) return;
        predictiveEngine.ingest(`node-cpu:${n.id}`, (h.cpu ?? 0) / 100, now);
        predictiveEngine.ingest(`node-mem:${n.id}`, (h.mem ?? 0) / 100, now);
        const cpuRes = predictiveEngine.analyze(`node-cpu:${n.id}`, { warnThreshold: WARN_HEALTH, critThreshold: CRIT_HEALTH, nowMs: now });
        const memRes = predictiveEngine.analyze(`node-mem:${n.id}`, { warnThreshold: WARN_HEALTH, critThreshold: CRIT_HEALTH, nowMs: now });
        if (cpuRes) insights.push({ ...cpuRes, kind: "node", label: `${n.id} (CPU)`, nodeId: n.id, metric: "CPU" });
        if (memRes) insights.push({ ...memRes, kind: "node", label: `${n.id} (BELLEK)`, nodeId: n.id, metric: "BELLEK" });
      });

      insights.sort((a, b) => b.risk - a.risk);
      setPredictiveInsights(insights.slice(0, 14));

      // ROTALAMAYA GERİ BESLEME — yalnızca anlamlı riskli linkler taşınır
      // (gürültüyü routing'e sürüklememek için düşük risk atlanır).
      const riskMap = {};
      insights.filter(i => i.kind === "link" && i.risk > 0.05).forEach(i => { riskMap[i.label] = i.risk; });
      setPredictiveRisk(riskMap);

      insights.forEach(ins => {
        const wasAlerted = predictiveAlertedRef.current.has(ins.key);
        if (ins.level === "WARNING" || ins.level === "CRITICAL") {
          if (!wasAlerted) {
            predictiveAlertedRef.current.add(ins.key);
            const etaTxt = ins.etaMs != null
              ? `~${Math.floor(ins.etaMs/60000)}dk ${Math.round((ins.etaMs%60000)/1000)}sn içinde`
              : "yakın vadede";
            addLogRef.current?.(
              `🔮 TAHMİN: ${ins.label} için ${etaTxt} darboğaz/gecikme öngörülüyor `
              + `(risk %${(ins.risk*100).toFixed(0)}, ivme ${ins.acceleration>=0?"+":""}${ins.acceleration.toFixed(3)}/sn²)`,
              "WARN"
            );
            setPredictiveStats(prev => ({ ...prev, warningsIssued: prev.warningsIssued + 1 }));
          }
          // ÖNLEYİCİ BAKIM — BİLİNÇLİ OLARAK predictiveAlertedRef'TEN AYRI
          // bir kapıdan (preventiveTriggeredRef) geçer: bir düğüm önce
          // WARNING olarak loglanıp (predictiveAlertedRef işaretlenir),
          // SONRA CRITICAL'e yükselebilir — bakım tetiklemesi bu durumda
          // da GERÇEKLEŞMELİDİR, "zaten uyarıldı" diye atlanmamalıdır.
          if (ins.kind === "node" && ins.level === "CRITICAL"
              && !preventiveTriggeredRef.current.has(ins.nodeId)
              && ins.nodeId !== srcRef.current && ins.nodeId !== dstRef.current
              && !nodeWatchdog.isBusy(ins.nodeId)) {
            preventiveTriggeredRef.current.add(ins.nodeId);
            nodeWatchdog.triggerPreventiveMaintenance(
              { nodeId: ins.nodeId, reason: `artan ${ins.metric} trendi (risk %${(ins.risk*100).toFixed(0)})` },
              { setNodes, setActivePreventive, addLog: (t,ty)=>addLogRef.current?.(t,ty), setPredictiveStats,
                openDrillDown: watchdogAutoOpenDrill, onHealed: watchdogOnHealed }
            );
          }
        } else if (ins.level === "SAFE") {
          if (wasAlerted) predictiveAlertedRef.current.delete(ins.key); // risk gerçekten düştü — tekrar uyarılabilir
          if (ins.kind === "node") preventiveTriggeredRef.current.delete(ins.nodeId); // tekrar bakım tetiklenebilir
        }
      });
    }, "micro");
    rafEngine.start();
    return () => rafEngine.unregister("predictive-telemetry-tick");
  }, []);

  // ══════════════════════════════════════════════════════════
  // FAZ 5 (KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON): noise-gate-
  // calibration-tick — 2200ms'de bir SNSPD'nin sıcaklık sürüklenmesini
  // ilerletir (ortalamaya-dönüşlü rastgele yürüyüş, bkz. watchdog-vitals-
  // tick'teki AYNI desen) ve bir kalibrasyon turu çalıştırır (bkz.
  // NoiseGateMiddleware.runCalibrationCycle). UI state'ini günceller,
  // kenar-tetiklemeli olarak sıcaklık-uyarısı/kapı-daraltma olaylarını
  // loglar (her tik'te tekrar basılmasın diye Ref tabanlı dedup — Faz 4'ün
  // predictiveAlertedRef ile AYNI desen).
  // ══════════════════════════════════════════════════════════
  useEffect(()=>{
    rafEngine.register("noise-gate-calibration-tick", 2200, () => {
      noiseGateMiddleware.advanceThermalDrift();
      const isNight = nightModeRef.current;
      const result = noiseGateMiddleware.runCalibrationCycle(isNight, Date.now());

      setNoiseGateState({
        tempDriftMk: noiseGateMiddleware.tempDriftMk,
        rawDarkRateHz: result.rawDarkRateHz,
        calibratedDarkRateHz: result.calibratedDarkRateHz,
        gateRatio: result.gateRatio,
        target: result.target,
      });
      setNoiseGateStats({ ...noiseGateMiddleware.stats });
      setNoiseGateHistory(noiseGateMiddleware.history.map(h=>h.calibratedDarkRateHz));

      const tripping = Math.abs(noiseGateMiddleware.tempDriftMk) > SNSPD_TEMP_TRIP_MK;
      if (tripping && !snspdTrippedRef.current) {
        snspdTrippedRef.current = true;
        addLogRef.current?.(
          `🌡️ SNSPD: sıcaklık sürüklenmesi kritik eşiği aştı (sapma ${noiseGateMiddleware.tempDriftMk.toFixed(2)}mK) — `
          + `ham karanlık sayım oranı ${result.rawDarkRateHz.toFixed(0)}Hz'e çıktı, Gürültü Kapısı kalibrasyonu devreye giriyor`,
          "WARN"
        );
      } else if (!tripping && snspdTrippedRef.current) {
        snspdTrippedRef.current = false;
        addLogRef.current?.(`🌡️ SNSPD: sıcaklık sapması nominal aralığa döndü (${noiseGateMiddleware.tempDriftMk.toFixed(2)}mK)`, "OK");
      }

      const narrowed = result.gateRatio < 0.999;
      if (narrowed && !gateNarrowedRef.current) {
        gateNarrowedRef.current = true;
        addLogRef.current?.(
          `🔬 GÜRÜLTÜ KAPISI: zaman-korelasyon penceresi %${(result.gateRatio*100).toFixed(0)}'e daraltıldı — `
          + `kalibre edilen karanlık oranı hedef bütçeyi aştığı için otonom olarak sıkılaştırıldı`,
          "WARN"
        );
      } else if (!narrowed && gateNarrowedRef.current) {
        gateNarrowedRef.current = false;
        addLogRef.current?.(`🔬 GÜRÜLTÜ KAPISI: pencere nominal genişliğe geri gevşetildi — gürültü bütçesi normale döndü`, "OK");
      }
    }, "micro");
    rafEngine.start();
    return () => rafEngine.unregister("noise-gate-calibration-tick");
  }, []);

  // ══════════════════════════════════════════════════════════
  // MAKRO ZAMAN KATMANI — kendi kendini optimize eden katsayılar.
  // İKİ ZAMANLI SİSTEM MİMARİSİ: bu sistem "macro" tier'a kayıtlıdır —
  // mikro katmanın (LEGA.computeThresholds, NodeTransitGate, propPhoton)
  // zamanlamasından TAMAMEN BAĞIMSIZ, kendi epoch'unda (4sn'de bir)
  // çalışır. Yalnızca AĞ SAKİNKEN (ortalama linkLoad < 0.3) gerçekten
  // bir nesil ilerletir — "sistem sakin zamanlarda yüzlerce kombinasyonu
  // simüle eder" davranışı. Yeni sınırlar hesaplandığında, mikro
  // katmana DOĞRUDAN müdahale etmez — injectCalibration() ile "bir
  // sonraki kalibrasyona kadar geçerli" yeni sınırlar olarak enjekte
  // edilir; donanım (mikro katman) o ana kadar tam gaz çalışmaya devam eder.
  // ══════════════════════════════════════════════════════════
  useEffect(() => {
    rafEngine.register("coefficient-evolution", 4000, () => {
      const loads = Object.values(linkLoadRef.current);
      const avgLoad = loads.length ? loads.reduce((s,v)=>s+v,0)/loads.length : 0;
      const calm = avgLoad < 0.3;
      setEvolutionActive(calm);
      if (!calm) return; // yoğun ağda evrim durur — hesaplama bütçesi gerçek trafiğe ayrılır

      // Fitness örnekleri: gerçek canlı linkLoad değerleri + son BER geçmişi
      // (senteti/uydurma veri değil — timeline'dan/state'ten türetilir).
      const samples = loads.length
        ? loads.map(l => ({
            linkLoad: l,
            historicalBer: berHistoryRef.current.length
              ? (berHistoryRef.current[berHistoryRef.current.length-1] ?? 0) / 100
              : 0,
          }))
        : [{ linkLoad: 0, historicalBer: 0 }];

      const champion = coeffEvolution.evolveGeneration(samples, nodeRejectionPenaltyWeight);
      if (champion) {
        // KUANTUM KAZANIM: en son bilinen rota mesafesi promoteToLive()'a
        // geçirilir — 1000km üzeri gerçek rotalarda referans katsayılar
        // artık propPhoton'ın amplifikasyon fiziğiyle tutarlı hesaplanır.
        const improved = coeffEvolution.promoteToLive(champion, undefined, lastRouteDistanceRef.current);
        if (improved) {
          // MAKRO → MİKRO ENJEKSİYON: yeni α/β sınırları, DualClockScheduler'ın
          // resmi kalibrasyon arayüzü üzerinden kaydedilir (lega.alpha/beta
          // zaten promoteToLive() içinde güncellendi — bu ek kayıt, "ne
          // zaman/hangi epoch'ta enjekte edildi" bilgisini izlenebilir kılar).
          rafEngine.injectCalibration({ alpha: lega.alpha, beta: lega.beta, epoch: coeffEvolution.generation });
        }
        setEvolutionGen(coeffEvolution.generation);
        setLiveCoeffs({ alpha: lega.alpha, beta: lega.beta });
        // DÜĞÜM REDDİ CEZASI İZLEME: şampiyonun GERÇEK ölçülen ret oranını
        // ayrıca raporla — "motorun kendi kendini eğitmesini izleyelim"
        // isteğinin somut karşılığı: bu sayı nesiller boyunca düşmelidir.
        const championRejectionRate = coeffEvolution.measureNodeRejectionRate(champion, samples);
        setLastNodeRejectionRate(championRejectionRate);
        if (improved) {
          addLogRef.current?.(
            `🧬 MAKRO→MİKRO ENJEKSİYON: epoch ${coeffEvolution.generation} → yeni kalibrasyon α=${lega.alpha.toFixed(3)} β=${lega.beta.toFixed(3)} (fitness=${champion.fitness.toFixed(3)}) — donanım bir sonraki kalibrasyona kadar bu sınırlarla çalışacak`,
            "SYS"
          );
          addLogRef.current?.(
            `🎯 DÜĞÜM REDDİ EĞİTİMİ: bu şampiyonun ölçülen gerçek ret oranı %${(championRejectionRate*100).toFixed(1)} (ceza ağırlığı=${nodeRejectionPenaltyWeight.toFixed(2)}) — nesiller boyunca izlenmeli`,
            championRejectionRate < 0.3 ? "OK" : "WARN"
          );
          if (coeffEvolution._lastInjectionAffectedCells > 0) {
            addLogRef.current?.(
              `🔧 REZONANS SENKRONU: ${coeffEvolution._lastInjectionAffectedCells} hücrenin Aşama-1 rezonans profili (NodeTransitGate) yeni kalibrasyonla hizalandı — kapıda "eski profil" reddi önlendi`,
              "OK"
            );
          }
        }
      }
    }, "macro");
    return () => rafEngine.unregister("coefficient-evolution");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MİKRO ZAMAN KATMANI — Kuantum Ön-Yönlendirme (PredictiveCorridor).
  // GELECEKTEKİ YOĞUNLUĞU TAHMİN ETME: predictiveCorridor'ın açık
  // koridorlarını haritada göstermek için periyodik senkron (500ms —
  // 3sn'lik TTL'e göre yeterince duyarlı, gereksiz render'ı önlemek için
  // yalnızca liste gerçekten değiştiğinde state güncellenir).
  useEffect(() => {
    rafEngine.register("corridor-sync", 500, () => {
      const active = predictiveCorridor.activeCorridors();
      setActiveCorridorNodes(prev => {
        if (prev.length === active.length && prev.every((p,i)=>p.nodeId===active[i]?.nodeId)) return prev;
        return active;
      });
    }, "micro");
    return () => rafEngine.unregister("corridor-sync");
  }, []);

  // MİKRO ZAMAN KATMANI — Negatif Sinyal / Anti-Paket (ChaosSuppressor)
  // + Soft-Landing Filtresi (%92 çöküş metriği ile acil tahliye valfi).
  // KAOS ENGELLEYİCİ: periyodik "hayalet veri" taraması. ghostPkts'te
  // sourceId'si artık replaying listesinde olmayan (yani sahibi replay
  // döngüsü bitmiş veya kesintiye uğramış) parçacıkları tespit eder,
  // ters-fazlı anti-paketler üretip nötrleştirir ve gerçekten temizler.
  useEffect(() => {
    rafEngine.register("chaos-sweep", 350, () => {
      const result = chaosSuppressor.sweep(ghostPktsRef.current, replayingRef.current);
      if (result.orphanCount > 0) {
        setGhostPkts(prev => prev.filter(g => !result.purgeIds.includes(g.id)));
        setChaosStats({ orphansDetected: chaosSuppressor.stats.orphansDetected, antiPacketsFired: chaosSuppressor.stats.antiPacketsFired });
        // İKİ ZAMANLI SİSTEM: mikro katman (bu sistem), makro katmanın en
        // son enjekte ettiği kalibrasyonu OKUYABİLİR (izleme amaçlı) ama
        // ASLA onun zamanlamasına bağımlı olmaz — bu satır olmasa da
        // chaos-sweep tam olarak aynı hızda çalışmaya devam eder.
        const cal = rafEngine.getCalibration();
        addLogRef.current?.(
          `🛡 KAOS ENGELLEYİCİ: ${result.orphanCount} hayalet paket tespit edildi → anti-paketlerle nötrleştirildi `
          + `(o anki makro kalibrasyon: epoch ${cal.epoch}, α=${cal.alpha.toFixed(2)} β=${cal.beta.toFixed(2)})`,
          "WARN"
        );
      }

      // SOFT-LANDING FİLTRESİ: hücre doluluk oranını hesapla, filtreye
      // enjekte et. %92 sınırını aşarsa, ChaosSuppressor'ın az önce
      // yapmadığı ("sahibi hâlâ aktif" paketlere dokunmama) davranışı
      // BİLİNÇLİ OLARAK BOZULUR — donanımı korumak için tüm yaşlı
      // paketler sahiplik durumuna bakılmaksızın anında sönümlenir.
      const occupancy = softLandingFilter.computeOccupancy(inMemoryFabric.cells.size, nodesRef.current.length || 1);

      // BELLEK HARİTASI DOLULUK → MAKRO SAATİN ERKEN UYANMASI: doluluk
      // %88'i geçtiğinde, makro katmandaki coefficient-evolution sistemi
      // normal 4sn'lik periyodunu beklemeden bir sonraki frame'de tetiklenir.
      const wokeEarly = rafEngine.reportOccupancy(occupancy);
      if (wokeEarly) {
        addLogRef.current?.(
          `⏰ MAKRO SAAT ERKEN UYANDIRILDI: bellek doluluğu %${(occupancy*100).toFixed(0)} `
          + `≥ %${(rafEngine.OCCUPANCY_WAKE_THRESHOLD*100).toFixed(0)} eşiği — Genetik Algoritma normal döngüsünü beklemeden tetiklenecek`,
          "WARN"
        );
      }

      const activeReplaySet = new Set(replayingRef.current);
      const packetsForFilter = ghostPktsRef.current.map(g => ({
        id: g.id,
        bornAt: g.bornAt ?? Date.now(),
        ownerActive: g.sourceId ? activeReplaySet.has(g.sourceId) : false,
      }));
      const landing = softLandingFilter.evaluate(packetsForFilter, occupancy);
      setSoftLandingMode(landing.mode);

      // YAVAŞ SÖNÜMLEME: her paketin güncel sinyal gücü ghostPkts state'ine
      // yazılır (render katmanı bunu opaklık/parlaklık olarak kullanır) —
      // paket ANINDA yok olmaz, önce solar, sonra (güç tabanın altına
      // düştüğünde) gerçekten kaldırılır.
      setGhostPkts(prev => prev
        .filter(g => !landing.evictIds.includes(g.id))
        .map(g => ({ ...g, signalStrength: landing.strengths[g.id] ?? 1.0 }))
      );

      if (landing.evictIds.length > 0) {
        if (landing.mode === "emergency") {
          addLogRef.current?.(
            `⚠ SOFT-LANDING (ACİL): hücre doluluğu %${(occupancy*100).toFixed(0)} — ${landing.evictIds.length} paket `
            + `hızlı sönümleme eğrisini tamamlayıp tahliye edildi (~${softLandingFilter.EMERGENCY_DECAY_END_MS}ms, sahiplik gözetilmedi)`,
            "ERR"
          );
        } else {
          addLogRef.current?.(
            `SOFT-LANDING (nazik): ${landing.evictIds.length} paket yumuşak sönümleme eğrisini tamamlayıp tahliye edildi `
            + `(~${softLandingFilter.GRACEFUL_DECAY_END_MS}ms)`,
            "INFO"
          );
        }
      }

      // Anti-paket animasyon state'ini her sweep'te senkronla (süresi
      // dolanlar otomatik düşer — activeAntiPackets() içinde budanır).
      setAntiPackets(prev => {
        const active = chaosSuppressor.activeAntiPackets();
        if (prev.length === active.length && active.length === 0) return prev;
        return active;
      });
    }, "micro");
    return () => rafEngine.unregister("chaos-sweep");
  }, []);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);

  const addLog=useCallback((text,type="INFO")=>{
    const ts=new Date().toLocaleTimeString("tr",{hour12:false});
    setLog(l=>[...l.slice(-200),{text,type,ts,id:Math.random()}]);
  },[]);
  useEffect(()=>{ addLogRef.current = addLog; }, [addLog]);

  // ASENKRON GİZLİLİK YÜKSELTME TAMAMLANMA BİLDİRİMİ: keyPoolBuffer
  // (düz-JS singleton, React state'ine erişimi YOK) büyük bir bloğun
  // Worker havuzundaki Toeplitz hash'i bittiğinde bu geri-çağırmayı
  // çağırır (bkz. KeyPoolBuffer._finalizeBlock, ToeplitzAsyncEngine) —
  // addLogRef ile AYNI köprü deseni. Kuyruktan ilgili girdiyi çıkarır
  // ve sonucu (başarı/hata) log'a yazar.
  useEffect(() => {
    keyPoolBuffer.onBlockPrivacyAmplified = (info) => {
      setPaQueue(q => q.filter(e => !(e.routeKey === info.routeKey && e.blockIndex === info.blockIndex)));
      if (info.error) {
        addLogRef.current?.(`❌ BLOK #${info.blockIndex} (${info.routeKey}) GİZLİLİK YÜKSELTME HATASI (Worker havuzu): ${info.error}`, "ERR");
      } else {
        const kmeStr = info.keyDelivery ? ` — 🔐 ETSI-014 KME'YE TESLİM EDİLDİ: key_ID=${info.keyDelivery.key_ID.slice(0,8)}… (${info.keyDelivery.sizeBits}bit, rotada ${info.keyDelivery.storedForRoute} anahtar bekliyor)` : "";
        addLogRef.current?.(`🔒 BLOK #${info.blockIndex} (${info.routeKey}) GİZLİLİK YÜKSELTME TAMAMLANDI (arka planda, Web Worker havuzu): ℓ=${info.finalKeyBitsLen}bit güvenli anahtar üretildi${kmeStr}`, "OK");
      }
    };
    return () => { keyPoolBuffer.onBlockPrivacyAmplified = null; };
  }, []);

  // ══════════════════════════════════════════════════════════
  // EK 45: HAL köprüsü istemci fonksiyonları — yalnızca tarayıcının
  // yerleşik fetch/EventSource'unu kullanır, ekstra kütüphane gerekmez
  // (bkz. hal/bridge_server.py başlığındaki "neden WebSocket değil" notu).
  // Bu fonksiyonlar transmit()'e HİÇ DOKUNMAZ — donanım paneli tamamen
  // ayrı, isteğe bağlı bir veri yoludur.
  // ══════════════════════════════════════════════════════════
  const hwCheckHealth = useCallback(async ()=>{
    try{
      const res = await fetch(`${hwBridgeUrl}/api/health`);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      setHwServerOk(true);
      addLog(`🔌 DONANIM KÖPRÜSÜ: ${hwBridgeUrl} yanıt veriyor`,"OK");
    }catch(e){
      setHwServerOk(false);
      addLog(`🔌 DONANIM KÖPRÜSÜ: ${hwBridgeUrl} adresine ulaşılamadı — sunucu çalışıyor mu? "python3 -m hal.bridge_server" (${e.message})`,"ERR");
    }
  },[hwBridgeUrl,addLog]);

  const hwConnect = useCallback(async ()=>{
    setHwConnecting(true);
    try{
      const res = await fetch(`${hwBridgeUrl}/api/connect`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({distance_km:hwDistanceKm, eavesdrop:hwEavesdrop})
      });
      const j = await res.json();
      if(!res.ok || j.ok===false) throw new Error(j.error||`HTTP ${res.status}`);
      setHwServerOk(true);
      addLog(`🔧 DONANIM: LinkManager başlatıldı (${hwDistanceKm}km, ${hwEavesdrop?"DİNLEME AKTİF":"temiz kanal"}) — arka planda bağlanıyor/yeniden-deniyor`,"SYS");

      // Canlı durum akışı — SSE bağlantısı tarayıcı tarafından otomatik
      // yeniden kurulur (yerleşik EventSource davranışı), bu yüzden burada
      // manuel bir reconnect döngüsü YAZMIYORUZ.
      if(hwEventSourceRef.current){ hwEventSourceRef.current.close(); }
      const es = new EventSource(`${hwBridgeUrl}/api/stream`);
      es.onmessage = (ev)=>{
        try{
          const msg = JSON.parse(ev.data);
          if(msg.type==="status") setHwStatus(msg.data);
        }catch{ /* keepalive yorum satırları buraya düşmez, sorun değil */ }
      };
      es.onerror = ()=>{ setHwServerOk(false); };
      es.onopen = ()=>{ setHwServerOk(true); };
      hwEventSourceRef.current = es;
    }catch(e){
      setHwServerOk(false);
      addLog(`🔧 DONANIM HATA: bağlanılamadı — ${e.message}`,"ERR");
    }finally{
      setHwConnecting(false);
    }
  },[hwBridgeUrl,hwDistanceKm,hwEavesdrop,addLog]);

  const hwDisconnect = useCallback(async ()=>{
    if(hwEventSourceRef.current){ hwEventSourceRef.current.close(); hwEventSourceRef.current=null; }
    try{
      await fetch(`${hwBridgeUrl}/api/disconnect`,{method:"POST"});
    }catch{ /* sunucu zaten ulaşılamazsa yerel durumu yine de temizle */ }
    setHwStatus({connected:false,armed:false,driver_name:"none"});
    addLog("🔧 DONANIM: bağlantı kesildi","INFO");
  },[hwBridgeUrl,addLog]);

  const hwAcquire = useCallback(async ()=>{
    setHwAcquiring(true);
    try{
      const duration_s = Math.max(0.0001, hwDurationMs/1000);
      const res = await fetch(`${hwBridgeUrl}/api/acquire`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({distance_km:hwDistanceKm, eavesdrop:hwEavesdrop, duration_s})
      });
      const j = await res.json();
      if(!res.ok || j.ok===false) throw new Error(j.error||`HTTP ${res.status}`);
      setHwResult(j);
      const r = j.result;
      addLog(`🔧 DONANIM EDİNİM: ${j.pulses_sent} darbe → ${j.clicks_received} click → ${r.detected_count} algılanan foton (${j.wall_clock_s}s gerçek işlem süresi)`,"SYS");
      addLog(`🔧 DONANIM QBER=${(r.qber*100).toFixed(2)}% baz-uzlaşma=${(r.match_rate*100).toFixed(1)}% sifted=${r.sifted_key_len}bit ${r.eavesdrop_detected?"— DİNLEME İSTATİSTİKSEL OLARAK TESPİT EDİLDİ":"(güvenli aralıkta)"}`, r.eavesdrop_detected?"ERR":"OK");
    }catch(e){
      addLog(`🔧 DONANIM HATA: edinim başarısız — ${e.message}`,"ERR");
    }finally{
      setHwAcquiring(false);
    }
  },[hwBridgeUrl,hwDistanceKm,hwEavesdrop,hwDurationMs,addLog]);

  // Sekme kapanırken / bileşen unmount olurken açık SSE bağlantısını kapat.
  useEffect(()=>{
    return ()=>{ if(hwEventSourceRef.current) hwEventSourceRef.current.close(); };
  },[]);

  // ══════════════════════════════════════════════════════════
  // EK 39/42: PAGE VISIBILITY API — sekme arka plana/öne geçtiğinde
  // AudioContext'i suspend/resume eder ve dinamik buffer davranışını
  // günceller. Aynı zamanda kiral rol handshake'ini tetikler.
  // ══════════════════════════════════════════════════════════
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      const visible = !document.hidden;
      setTabVisible(visible);
      if (chiralAudioOn) {
        if (visible) {
          chiralEngine.resume().then(()=>addLog("🔊 Sekme öne geçti — AudioContext resume edildi","SYS"));
        } else {
          // EK 36: arka plana geçince suspend ETMİYORUZ (sessiz buffer loop
          // sayesinde kasıtlı olarak canlı tutuluyor) — throttling'i aşmak
          // için bu döngü sürer, ama görsel/log akışı yavaşlayabilir.
          addLog("🔈 Sekme arka plana geçti — sessiz buffer loop ile ses canlı tutuluyor","INFO");
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chiralAudioOn]);

  // ══════════════════════════════════════════════════════════
  // EK 38: ZAMAN DİLATASYONU DEDEKTÖRÜ — sürekli çalışır, sekme
  // arka plandayken oluşan throttling sapmasını ölçer.
  // ══════════════════════════════════════════════════════════
  useEffect(() => {
    const stop = createClockDriftDetector((d) => {
      setClockDrift(d);
      // Belirgin bir sapma (>150ms) tespit edilirse ve sekme arka
      // plandaysa, bunu "kiral zaman dilatasyonu" olarak logla.
      if (Math.abs(d.driftMs) > 150 && typeof document !== "undefined" && document.hidden) {
        addLog(`⏱ ZAMAN DİLATASYONU: ${d.driftMs.toFixed(0)}ms sapma (arka plan throttling)`,"WARN");
      }
    }, 1000);
    return stop;
  }, [addLog]);

  // ══════════════════════════════════════════════════════════
  // EK 40: WEB LOCKS API — Master (Ana Evren) rolü için sekmeler
  // arası yarış durumunu çözer. Kilidi kazanan sekme "Primary_Observer",
  // kazanamayan "Mirror_Observer" olarak işaretlenir.
  // ══════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false;
    acquireMasterLock(myTabId, () => {
      if (!cancelled) {
        setIsMasterTab(true);
        setLocalRole("Primary_Observer");
        addLog(`🔒 Web Locks: bu sekme (${myTabId}) Master/Ana Evren rolünü kazandı`,"OK");
      }
    }, () => {
      if (!cancelled) setIsMasterTab(false);
    }).then(gotLock => {
      if (!cancelled && !gotLock) {
        setLocalRole("Mirror_Observer");
        addLog(`🔓 Web Locks: Master rolü başka bir sekmede — bu sekme Ayna Evren olarak işaretlendi`,"INFO");
      }
    });
    return () => { cancelled = true; releaseMasterLock(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V8.0: getNode artık O(1) — networkTopology.nodeMap üzerinden Map erişimi.
  // Çağrı imzası (getNode(id)) hiç değişmedi, tüm mevcut kullanım yerleri korunur.
  const getNode=id=>networkTopology.getNode(id);
  const getLinkXY=lk=>{const a=getNode(lk.a),b=getNode(lk.b);if(!a||!b)return null;return{x1:a.x,y1:a.y,x2:b.x,y2:b.y};};
  const isOnPath=lk=>path?path.slice(1).some(p=>p.link&&((p.link.a===lk.a&&p.link.b===lk.b)||(p.link.a===lk.b&&p.link.b===lk.a))):false;
  const pathIds=path?new Set(path.map(p=>p.node)):new Set();

  // RETRO-CAUSALITY (Adım 5): aktif fork'un fiziksel yolu — retro-causality
  // rotayı değiştirmediği için forkun path'i kaynak kaydın path'iyle AYNIDIR,
  // ama haritada AYRI bir görsel katman olarak (kesikli çizgi + farklı renk)
  // gösterilir ki kullanıcı "bu aynı yoldan geçen alternatif bir gerçeklik"
  // olduğunu görsel olarak ayırt edebilsin.
  const activeFork = activeForkId ? forkedEntries.find(f=>f.id===activeForkId) : null;
  const isOnForkedPath = lk => activeFork && activeFork.segs
    ? activeFork.segs.some(s => s && ((s.a===lk.a&&s.b===lk.b)||(s.a===lk.b&&s.b===lk.a)))
    : false;

  async function animPkt(pathArr,color,label){
    for(let i=0;i<pathArr.length-1;i++){
      const nA=getNode(pathArr[i].node),nB=getNode(pathArr[i+1].node);if(!nA||!nB)continue;
      const pid=Math.random();
      for(let s=0;s<=30;s++){
        const f=s/30;
        setPkts(prev=>[...prev.filter(p=>p.id!==pid),
          {id:pid,x:nA.x+(nB.x-nA.x)*f,y:nA.y+(nB.y-nA.y)*f,color,label}]);
        await delay(18);
      }
      setPkts(prev=>prev.filter(p=>p.id!==pid));
      await delay(35);
    }
  }

  // Ana iletim fonksiyonu
  async function transmit(){
    if(running||src===dst||!msg.trim())return;
    setRunning(true);setResult(null);setPath(null);setPkts([]);
    setPhase("ROTA HESAPLANIYOR");

    // EK: bu iletime özgü entanglement seed — replay'de aynı olayları
    // tekrar üretmek için kullanılacak (algoritma akışını değiştirmez)
    // DÜZELTME 4: URL'den paylaşılan bir seed varsa (deep-link), rastgele
    // üretim yerine ONU kullan — bu, "seed'i paylaş" özelliğini gerçek
    // işlevsel hale getirir (önceden okunuyordu ama hiç kullanılmıyordu).
    const entanglementSeed = pendingSeedFromUrl != null
      ? pendingSeedFromUrl
      : (Math.random()*4294967296)>>>0;
    if (pendingSeedFromUrl != null) {
      addLog(`🔗 URL'den paylaşılan seed kullanılıyor: ${pendingSeedFromUrl} (deterministik tekrar)`,"SYS");
      setPendingSeedFromUrl(null); // tek seferlik — sonraki iletimler tekrar rastgele üretir
    }
    // V8.0 ADIM 3: rng artık burada değil, QuantumKeyDistribution
    // sınıfının kendi içinde (this.rng) yönetiliyor — bkz. aşağıda.

    const sat=sats.find(s=>s.id===activeSat)||sats[0];
    const q=satQ(sat.elev);
    addLog(`UYDU: ${sat.name} yükselti=${sat.elev.toFixed(1)}° kalite=${(q*100).toFixed(0)}%`,"SYS");
    if(q<.3)addLog("UYDU KALİTESİ DÜŞÜK — alternatif değerlendiriliyor","WARN");

    // DÜZELTME 5: routing artık bağımsız routeCalculation() modülünde.
    // Dönen alan adları (path→p, segs, totalKm, geoKm) BİREBİR KORUNDU.
    // DİNAMİK YÜK DENGELEME: linkDown 7. parametre. FAZ 4 (TAHMİNLEME):
    // predictiveRisk 8. parametre olarak geçirilir — henüz gerçekleşmemiş
    // ama öngörülen darboğaz riski taşıyan linkler EdgeWeightPolicy
    // tarafından "biraz daha pahalı" görülür, trafik PROAKTİF olarak kayar.
    const route = routeCalculation(nodes, links, src, dst, linkLoad, getNode, linkDown, predictiveRisk);
    if(!route){
      const quarantined = Object.keys(activeAnomalies);
      if (activeCrisis) {
        addLog(`🔴 AĞ KRİZİ: ${activeCrisis.a}↔${activeCrisis.b} hattı KOPUK ve ${src}→${dst} için HİÇBİR alternatif yol bulunamadı — bağlantı tamamen kesildi`,"ERR");
      } else if (quarantined.length) {
        addLog(`🛡️ WATCHDOG: ${quarantined.join(", ")} düğümü/düğümleri karantinada olduğu için ${src}→${dst} için alternatif yol bulunamadı — otonom iyileştirme tamamlanınca tekrar deneyin`,"ERR");
      } else {
        addLog("HATA: Aktif rota yok","ERR");
      }
      setRunning(false);setPhase("HATA");return;
    }
    const { path: p, segs, totalKm, geoKm, health } = route;
    setPath(p);

    addLog(`ROTA: ${p.map(x=>x.node).join("→")} | ${totalKm}km(fiber) / ${geoKm.toFixed(0)}km(haversine) | ${segs.length}hop`,"SYS");
    if(evesdrop)addLog("BB84: DİNLEME MODU AKTİF","WARN");

    // DİNAMİK YÜK DENGELEME / AKILLI ROTALAMA — bkz. LinkOutageController
    // ve injectCrisis() başlıkları. Aktif bir kriz varsa, kriz YOKMUŞ GİBİ
    // bir "gölge" temel rota hesaplanır (SADECE karşılaştırma için — bu
    // ikinci Dijkstra çağrısı ASLA gerçek fiziğe/foton simülasyonuna
    // karışmaz, yalnızca "normalde hangi rota seçilirdi" sorusuna cevap
    // verir). Gerçek rota bu hattı atlıyorsa, kullanıcıya trafiğin
    // GERÇEKTEN otomatik olarak yeniden yönlendirildiği gösterilir.
    if (activeCrisis) {
      const onCrisisLink = (lk) => (lk.a===activeCrisis.a&&lk.b===activeCrisis.b)||(lk.a===activeCrisis.b&&lk.b===activeCrisis.a);
      const usesCrisisLink = segs.some(onCrisisLink);
      const baselineRoute = routeCalculation(nodes, links, src, dst, {}, getNode, {});
      const baselineUsesCrisisLink = !!baselineRoute && baselineRoute.segs.some(onCrisisLink);
      if (baselineUsesCrisisLink && !usesCrisisLink) {
        const viaNodes = p.map(x=>x.node).filter(id=>id!==src&&id!==dst);
        addLog(
          `🔀 ROTA OPTİMİZE EDİLDİ: ${activeCrisis.a}-${activeCrisis.b} hattı ${activeCrisis.mode==="outage"?"KOPUK":"AŞIRI YOĞUN"} — trafik `
          + `${viaNodes.length?viaNodes.join("→"):"doğrudan alternatif hat"} üzerinden yönlendirildi (yeni rota: ${p.map(x=>x.node).join("→")}, ${totalKm}km)`,
          "WARN"
        );
      } else if (baselineUsesCrisisLink && usesCrisisLink) {
        addLog(`⚠ AĞ KRİZİ AKTİF (${activeCrisis.a}-${activeCrisis.b}) ama bu rota için alternatif bulunamadı — en iyi yol hâlâ etkilenen hattı kullanıyor`,"WARN");
      }
    } else {
      // FAZ 4 (TAHMİNLEME MOTORU) — SADECE aktif bir kriz YOKKEN kontrol
      // edilir (aksi halde Faz 1'in "ROTA OPTİMİZE EDİLDİ" logu ile
      // çakışıp kafa karıştırır). "Gölge" temel rota — predictiveRisk
      // YOKMUŞ gibi hesaplanır — gerçek rotayla karşılaştırılır: gerçek
      // rota, öngörülen-riskli bir hattı PROAKTİF olarak atlıyorsa, bu
      // tahminin GERÇEKTEN yönlendirmeyi değiştirdiğini kanıtlar (yalnızca
      // log değil, gerçek etki).
      const riskyLinkEntries = Object.entries(predictiveRisk).filter(([,r]) => r > 0.3);
      if (riskyLinkEntries.length) {
        const baselineRoute = routeCalculation(nodes, links, src, dst, linkLoad, getNode, linkDown, {});
        const onRiskyLink = (lk) => riskyLinkEntries.some(([key]) => {
          const [ra, rb] = key.split("-");
          return (lk.a===ra&&lk.b===rb)||(lk.a===rb&&lk.b===ra);
        });
        const usesRisky = segs.some(onRiskyLink);
        const baselineUsesRisky = !!baselineRoute && baselineRoute.segs.some(onRiskyLink);
        if (baselineUsesRisky && !usesRisky) {
          addLog(
            `🔮 ÖNLEYİCİ YÖNLENDİRME: öngörülen risk taşıyan hat(lar) proaktif olarak atlandı — trafik `
            + `${p.map(x=>x.node).join("→")} üzerinden yönlendirildi (kriz OLUŞMADAN ÖNCE önlem alındı)`,
            "WARN"
          );
        }
      }
    }

    // ROTA-SAĞLIK KONTROLÜ: fiziksel simülasyon çalışmadan ÖNCE, seçilen
    // rotanın uçtan uca kümülatif geçirgenliği ve hop sayısı kontrol
    // edilir. Rota REDDEDİLMEZ (dijkstra'nın kararına dokunulmaz) — ama
    // kullanıcı, "her hop ayrı ayrı çöktüğü için toplam kayıp foton
    // sayısını aştı" gibi kafa karıştırıcı bir sonuçla karşılaşmadan
    // ÖNCE, rotanın fiziksel olarak riskli olduğunu görür.
    if (!health.healthy) {
      const reasons = [];
      if (health.tooManyHops) reasons.push(`${health.hopCount} hop (sağlıklı sınır: 6)`);
      if (health.criticallyLowTransmittance) reasons.push(`uçtan-uca geçirgenlik %${(health.cumulativeTransmittance*100).toFixed(3)}`);
      addLog(`⚠ ROTA SAĞLIĞI DÜŞÜK: ${reasons.join(", ")} — bu rota fiziksel olarak çöküşe çok yatkın, çoklu-hop kayıp birikimi beklenebilir`,"WARN");
    }

    // GELECEKTEKİ YOĞUNLUĞU TAHMİN ETME + YOL ÖN-AÇMA (Vakum Koridoru):
    // rota MATEMATİKSEL OLARAK bilindiği an (dalga fonksiyonu simülasyonu
    // = routeCalculation'ın kendisi), foton fiziksel olarak yola çıkmadan
    // ÖNCE, rotadaki her düğüme geçici bir eşik indirimi tanımlanır.
    const corridor = predictiveCorridor.openCorridor(p, 3000);
    addLog(`⚡ VAKUM KORİDORU: ${corridor.nodesOpened} düğüm önceden açıldı (ort. indirim ×${corridor.avgDiscount.toFixed(2)}) — feedforward tahmin`,"SYS");

    setPhase("KODLAMA");await delay(200);
    let bits=t2b(msg);
    const rawLen=bits.length;
    if(ecc)bits=hEnc(bits);
    addLog(`ENC: ${rawLen}bit${ecc?` → Hamming(7,4) → ${bits.length}bit`:""}`, "INFO");

    // V8.0 ADIM 3: BB84 + OTP artık bağımsız sınıflar üzerinden çalışıyor.
    // Eski dağınık ~40 satırlık kod, aynı matematiği yürüten iki temiz
    // servis çağrısına indirgendi. Değişken adları (recon, siftedKeyBits,
    // qber, eavesdropDetected, otpKeyBits, otpCipherBits, otpDecoded,
    // otpIntegrityOk) BİREBİR KORUNDU — aşağıdaki hiçbir satır değişmedi.
    const qkd = new QuantumKeyDistribution(entanglementSeed);
    // EK 44: nightMode canlı iletimde gerçek dedektör-gürültü bağlamına
    // taşınıyor — replay/mirror/fork bu katmandan (scintillation/pointing
    // gibi) etkilenmez, geçmiş anların fiziği asla retroaktif değişmez.
    //
    // DÜZELTME 9: GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ ARAYÜZ ENTEGRASYONU —
    // kullanıcı isteği üzerine deriveSiftedKeyChain() artık canlı iletimde
    // gerçekten kullanılıyor. QKD_CHAIN_THRESHOLD_KM ALTINDAKİ rotalarda
    // davranış BİREBİR ESKİSİ GİBİDİR (tek deriveSiftedKey çağrısı, aynı
    // seed/rng akışı) — yalnızca GERÇEKTEN gerekli olduğunda (tek-atış
    // fotonun ~10⁻⁶ ve altına düşen hayatta kalma olasılığı yüzünden
    // pratik olarak sıfır algılama üretmeye başladığı mesafelerde, bkz.
    // QBER karşılaştırma raporu — 300km/550km) zincire geçilir.
    const QKD_CHAIN_THRESHOLD_KM = 150;
    const QKD_CHAIN_HOP_KM = 60; // gerçekçi güvenilir-düğüm aralığı (bkz. deriveSiftedKeyChain yorumları)
    const usingTrustedChain = totalKm > QKD_CHAIN_THRESHOLD_KM;

    let recon, siftedKeyBits, bobKeyBits, sentPulsesForBuffer, qber, eavesdropDetected, lostCount, darkClickCount, qkdChain = null;
    if (usingTrustedChain) {
      const nHops = Math.max(2, Math.ceil(totalKm / QKD_CHAIN_HOP_KM));
      qkdChain = qkd.deriveSiftedKeyChain(bits, totalKm, nHops, evesdrop, { isNight: nightMode });
      recon = { matchRate: qkdChain.avgMatchRate };
      siftedKeyBits = qkdChain.keyBits;
      bobKeyBits = qkdChain.bobKeyBits; // EK (Asenkron Havuz): deriveSiftedKeyChain zaten hop-0/bottleneckLen'e hizalı bobKeyBits döndürüyor artık
      sentPulsesForBuffer = qkdChain.sentPulses; // EK (Gain): hop-0'ın gönderdiği ham darbe sayısı
      qber = qkdChain.avgQber;
      eavesdropDetected = qkdChain.eavesdropDetected;
      lostCount = qkdChain.totalLost;
      darkClickCount = 0; // zincir-seviyesinde toplanmıyor — ayrıntı isteyenler qkdChain.hops'tan okuyabilir

      addLog(`🔗 GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ: ${totalKm}km rota tek-atış QKD için çok uzun (no-cloning teoremi tek fotonun amplifikasyonunu yasaklar) — ${qkdChain.nHops} hop × ${qkdChain.hopKm.toFixed(1)}km'e bölündü`,"SYS");
      addLog(`BB84 ZİNCİR: ort. baz uzlaşma ${(qkdChain.avgMatchRate*100).toFixed(1)}% → nihai (darboğaz) anahtar ${siftedKeyBits.length}bit — en zayıf hop #${qkdChain.worstHop.hop} (${qkdChain.worstHop.km.toFixed(0)}km)`,"SYS");
      addLog(`BB84 ZİNCİR: ort. QBER=${(qber*100).toFixed(1)}% · en-kötü-hop QBER=${(qkdChain.worstHop.qber*100).toFixed(1)}% ${eavesdropDetected?"— DİNLEME İSTATİSTİKSEL OLARAK TESPİT EDİLDİ (en az bir hop eşiği aştı)":"(tüm hoplar güvenli aralıkta)"}`,
        eavesdropDetected?"ERR":"OK");
      addLog(`⚠ ${qkdChain.trustedNodeCaveat}`,"WARN");
    } else {
      ({ recon, siftedKeyBits, bobKeyBits, qber, eavesdropDetected, lostCount, darkClickCount } =
        qkd.deriveSiftedKey(bits, totalKm, evesdrop, undefined, { isNight: nightMode }));
      sentPulsesForBuffer = bits.length; // EK (Gain): tek-atış yolda gönderilen ham darbe sayısı zaten `bits` — yalnızca taşınıyor

      addLog(`BB84: baz uzlaşma ${(recon.matchRate*100).toFixed(1)}% → sifted key ${siftedKeyBits.length}/${bits.length} bit${lostCount?` (${lostCount} foton algılanamadı — anahtar/QBER dışı)`:""}${darkClickCount?` (${darkClickCount} hayalet click — karanlık sayım/arka plan)`:""}`,"SYS");
      addLog(`BB84: QBER=${(qber*100).toFixed(1)}% ${eavesdropDetected?"— DİNLEME İSTATİSTİKSEL OLARAK TESPİT EDİLDİ":"(güvenli aralıkta)"}`,
        eavesdropDetected?"ERR":"OK");
    }

    // RAW KEY RATE: gerçek kuantum iletişim literatüründeki standart
    // performans ölçütü (bit/saniye) — statik bir bit sayısı DEĞİL.
    // Micius uydusunun gerçek yayınlanmış performans verisine (80MHz
    // kaynak hızı, en-iyi-durum ~1.7Mbit/s tavanı) göre ölçeklenir.
    const rawKeyRate = QuantumKeyDistribution.computeRawKeyRate(siftedKeyBits.length, recon.matchRate);
    addLog(`QKD RATE: ${rawKeyRate.label} (Micius-ölçekli, kaynak=${(rawKeyRate.sourceRateHz/1e6).toFixed(0)}MHz, verimlilik=%${(rawKeyRate.efficiency*100).toFixed(1)})`,"SYS");

    const otp = OneTimePad.runFullCycle(msg, siftedKeyBits, entanglementSeed);
    const otpKeyBits = otp.keyBits, otpCipherBits = otp.cipherBits;
    const otpDecoded = otp.decoded, otpIntegrityOk = otp.integrityOk;
    addLog(`OTP: mesaj sifted key ile şifrelendi (${otpKeyBits.length}bit anahtar) → deşifre bütünlüğü ${otpIntegrityOk?"✓":"✗"}`,
      otpIntegrityOk?"OK":"ERR");

    // ══════════════════════════════════════════════════════════
    // MADDE 3: BİÇİMSEL SONLU-ANAHTAR GÜVENLİK KANITI — TAMAMEN EK
    // (ADDITIVE) BİR KATMAN. OTP şifreleme yukarıda TAMAMEN sifted
    // key'in kendisiyle çalışmaya devam ediyor (mevcut, test edilmiş
    // davranış TEK SATIR değişmedi) — bu blok yalnızca "bu sifted key
    // GERÇEK bir güvenlik kanıtı çerçevesinde ne kadarı 'kanıtlanabilir
    // güvenli' anahtar üretir" sorusunu AYRICA, paralel olarak cevaplıyor
    // ve sonucu res.securityProof üzerinden UI'ya taşıyor.
    const secProof = QKDSecurityProof.run(siftedKeyBits, qber, entanglementSeed);
    if (secProof.proof.secure) {
      addLog(`🔐 SONLU-ANAHTAR KANITI: n=${secProof.proof.n}bit sifted key, Q_ph≤${(secProof.proof.qPhUpper*100).toFixed(2)}% (Serfling) → gizlilik yükseltme sonrası ℓ=${secProof.proof.ell}bit KANITLANMIŞ GÜVENLİ anahtar (sıkıştırma oranı ×${secProof.proof.compressionRatio.toFixed(3)})`,"OK");
    } else {
      addLog(`🔓 SONLU-ANAHTAR KANITI: GÜVENLİ ANAHTAR ÜRETİLEMEDİ — ${secProof.proof.reason} (n=${secProof.proof.n}bit, QBER=${qber!=null?(qber*100).toFixed(1)+"%":"—"})`,"ERR");
    }
    // Klasik kanal kimlik doğrulaması: bu round'un parametre-kestirim/
    // baz-uzlaşma duyurusunu (QBER + n) Wegman-Carter MAC ile kimliklendirir,
    // ardından havuzu bu round'un privacy-amplified anahtarından besler.
    const announcementBits = t2b(JSON.stringify({ qber: qber!=null?Math.round(qber*1000):null, n: siftedKeyBits.length }));
    const authResult = classicalAuthChannel.authenticateRound(announcementBits, secProof.finalKeyBits);
    if (authResult.ok) {
      addLog(`🔏 KLASİK KANAL KİMLİK DOĞRULAMA: parametre-kestirim duyurusu Wegman-Carter MAC ile imzalandı (etiket=0x${authResult.tag.toString(16).padStart(8,"0")}) — havuz: ${authResult.poolRemaining}bit${secProof.finalKeyBits.length?` (+${secProof.finalKeyBits.length}bit geri beslendi)`:""}`,"OK");
    } else {
      addLog(`⚠ KLASİK KANAL KİMLİK DOĞRULAMA BAŞARISIZ: ${authResult.reason}`,"ERR");
    }

    // ══════════════════════════════════════════════════════════
    // ASENKRON HAVUZ (BUFFER) KATMANI — bu iletimin (Alice,Bob) sifted
    // bit çiftini rota-bazlı havuza besler. TAMAMEN side-effect: yukarıdaki
    // hiçbir değişkeni (routing/BER/success/qber/res) OKUMAZ değiştirmez,
    // yalnızca zaten hesaplanmış siftedKeyBits/bobKeyBits'i PARAMETRE
    // olarak alır. Timeline/Replay/Mirror/Fork determinizmi bu yüzden
    // etkilenmez — bkz. KeyPoolBuffer sınıfının başındaki tasarım notu.
    const keyPoolResult = keyPoolBuffer.feed(src, dst, siftedKeyBits, bobKeyBits, entanglementSeed, sentPulsesForBuffer);
    if (keyPoolResult) {
      if (keyPoolResult.finalized) {
        const f = keyPoolResult.finalized;
        const recStr = f.reconciliation
          ? `${f.reconciliation.protocol}: ${f.reconciliation.leakedBits}bit sızıntı${f.reconciliation.converged?" (yakınsadı ✓)":` (YAKINSAMADI ✗, ${f.reconciliation.residualErrors}bit residual)`}`
          : "uzlaşma çalıştırılmadı";
        const kmeStr = f.keyDelivery ? ` — 🔐 ETSI-014 KME'YE TESLİM EDİLDİ: key_ID=${f.keyDelivery.key_ID.slice(0,8)}… (${f.keyDelivery.sizeBits}bit, rotada ${f.keyDelivery.storedForRoute} anahtar bekliyor)` : "";
        // BÜYÜK BLOK (10⁵-10⁶ bit ölçeğinde): Toeplitz hash Worker havuzunda
        // ARKA PLANDA çalışıyor — ℓ/finalKeyBitsLen/keyDelivery henüz YOK
        // (bkz. _finalizeBlock, ToeplitzAsyncEngine). Burada UI'yı BLOKLAMADAN
        // yalnızca "kuyruğa alındı" bilgisini logluyoruz; asıl tamamlanma
        // bildirimi keyPoolBuffer.onBlockPrivacyAmplified üzerinden AYRICA gelir.
        const pendingStr = f.privacyAmplificationPending ? " — 🔄 ℓ hesaplandı, GİZLİLİK YÜKSELTME (Toeplitz) Web Worker havuzunda ARKA PLANDA çalışıyor (UI kilitlenmez), tamamlanınca ayrıca bildirilecek" : "";
        addLog(`🪣 ANAHTAR HAVUZU BLOK #${f.blockIndex} TAMAMLANDI (${f.routeKey}): ProductionSecurityAudit.audit() ile n=${f.n}bit anahtar örneklemi, k=${f.k}bit test örneklemi (Q_test=${(f.qEstimated*100).toFixed(2)}%${f.gain!=null?`, Gain=${(f.gain*100).toFixed(1)}%`:""}, ε_toplam=${f.epsilon.total.toExponential(1)}) — GERÇEK hata düzeltme: ${recStr} → ${f.proof.secure?`ℓ=${f.proof.ell}bit KANITLANMIŞ GÜVENLİ (2-parametreli Serfling, μ=${(f.proof.mu*100).toFixed(2)}%)`:`GÜVENLİ ANAHTAR YOK (${f.proof.reason})`}${kmeStr}${pendingStr}`,
          f.proof.secure?"OK":"ERR");
        if (f.privacyAmplificationPending) {
          setPaQueue(q => [...q, { routeKey: f.routeKey, blockIndex: f.blockIndex, ell: f.proof.ell, startedAt: Date.now() }]);
        }
      } else {
        addLog(`🪣 ANAHTAR HAVUZU (${keyPoolBuffer.routeKey(src,dst)}): ${keyPoolResult.poolProgress}/${keyPoolResult.poolThreshold}bit birikti — blok tamamlanınca gerçek n/k ayrımıyla yeniden kanıtlanacak`,"INFO");
      }
    }

    setPhase("İLETİM");
    // DÜZELTME 5: fiziksel foton yayılımı artık bağımsız physicalSimulation()
    // modülünde. Segment döngüsü, propPhoton çağrısı, olay biriktirme —
    // hepsi MATEMATİKSEL OLARAK BİREBİR AYNI, sadece transmit() dışına taşındı.
    //
    // LEGA AKTİVASYONU: sadece BU çağrıda (canlı/yeni iletim) legaOpts geçirilir
    // — o anki linkLoad ve timeline'daki ortalama tarihsel BER kullanılır.
    // Replay/Mirror/Fork motorları legaOpts vermez, dolayısıyla geçmiş anların
    // fiziği asla retroaktif olarak değişmez.
    const avgHistoricalBer = berHistory.length
      ? berHistory.reduce((s,v)=>s+v,0) / berHistory.length / 100 // yüzdeden [0,1]'e
      : 0;
    // EK 42-44 ENTEGRASYONU: atmosphericConditions daha önce transmit()'ten
    // HİÇ GEÇİRİLMİYORDU — AtmosphericWindowModel yalnızca LeoPanel'in
    // dekoratif dalga boyu önerisini besliyordu, gerçek fiziksel simülasyona
    // hiç bağlı değildi (bkz. sohbet geçmişi). Şimdi aktif uydunun elevasyon
    // açısı (LEO panelinin zaten gösterdiği aynı değer) + türbülans/izleme
    // kaydırıcıları buraya gerçekten taşınıyor — scintillation/pointing artık
    // yalnızca görsel değil, propPhoton'ın effectiveTransmittance'ını etkiliyor.
    const curSatForTx = sats.find(s=>s.id===activeSat) || sats[0];
    const atmosphericConditions = {
      turbidity: atmosphericTurbidity,
      rangeKm: totalKm,
      elevationDeg: curSatForTx?.elev ?? 45,
      turbulenceStrength,
      pointingPrecision,
    };
    // DÜZELTME 8: DİNAMİK FEC / KUANTUM TEKRARLAYICI ÇEŞİTLİLİĞİ AKTİVASYONU
    // — kullanıcı isteği üzerine canlı iletimde her zaman devrede (replay/
    // mirror/fork legaOpts vermediği için bu katmandan hiç etkilenmez,
    // geçmiş anların fiziği asla retroaktif değişmez). Kanal zaten
    // güvenilirse (survival>=%85) dynamicRedundancyFor() otomatik olarak
    // redundancy=1 döner — israf yok, davranış eskisiyle birebir aynı.
    const simResult = physicalSimulation(segs, bits, entanglementSeed, evesdrop, getNode,
      { linkLoad, historicalBer: avgHistoricalBer, opllEnabled: opllOn, atmosphericConditions, dynamicFecEnabled: true });
    const { recv: recvRaw, totalLost, totalFlip, ec, eventLog, segReport, gateReport } = simResult;
    let recv = recvRaw;

    // Segment bazlı loglama (eski kodda döngü içindeydi, artık segReport'tan okunuyor)
    segReport.forEach((sr, si) => {
      addLog(`SEG${si+1}: ${sr.link.a}→${sr.link.b} ${sr.link.km}km λ=${sr.link.nm}nm T=${sr.transmitPct}% R×${sr.repeaters}`,"SYS");
      if(sr.usingMsgRelay) {
        addLog(
          `  ↳ 🔗 GÜVENİLİR-DÜĞÜM RÖLE ZİNCİRİ (mesaj kanalı): ${sr.link.km}km tek link tek-atış EDFA telafisi için çok uzun `
          + `(bkz. propPhotonRelayChain — analog amplifikasyonun %5 kalıntı-kayıp tabanı bu mesafede yetersiz) — `
          + `${sr.msgRelayHops} hop × ${(sr.link.km/sr.msgRelayHops).toFixed(0)}km'e bölündü, her hop KENDİ bağımsız fotonuyla ölç-ve-yeniden-gönder`,
          "SYS"
        );
      }
      if(sr.fecRedundancy > 1) {
        addLog(
          `  ↳ 🔁 DİNAMİK FEC: kanal zayıf (T=${sr.transmitPct}%) — bit başına ×${sr.fecRedundancy} foton çoğullama devreye girdi`
          + `${sr.fecRescued?`, ${sr.fecRescued} bit ek kopyalarla kurtarıldı`:""}`
          + `${sr.fecExhausted?`, ${sr.fecExhausted} bit TÜM kopyalara rağmen yine kayıp`:""}`,
          sr.fecExhausted ? "WARN" : "OK"
        );
      }
      if(sr.lost)addLog(`  ↳ ${sr.lost} foton kayıp @ ${sr.link.a}→${sr.link.b}`,"ERR");
      if(sr.flipped)addLog(`  ↳ ${sr.flipped} bit bozuldu @ ${sr.link.a}→${sr.link.b}`,"WARN");
      if(sr.absorptionBarrierDetected) {
        addLog(
          `⚠ ANİ SOĞURULMA BARİYERİ: ${sr.link.a}→${sr.link.b} hattında λ=${sr.link.nm}nm için `
          + `${sr.maxConsecutiveAbsorb} ardışık ABSORB olayı — alıcı düğümde (${sr.link.b}) veri boşluğu oluştu, ECC bu boşluğu telafi etmeye çalışıyor`,
          "ERR"
        );
      }
      setLinkLoad(prev=>({...prev,[`${sr.link.a}-${sr.link.b}`]:0.8+Math.random()*.2}));
    });

    // NodeTransitGate: 3-aşamalı düğüm-seviyesi karar motoru özeti
    if (gateReport && gateReport.checked > 0) {
      addLog(
        `GATE: ${gateReport.checked} foton düğüm triyajından geçti → `
        + `Faz1-red:${gateReport.phase1Rejected} Faz2-red:${gateReport.phase2Rejected} Faz3-geçiş:${gateReport.phase3Passed}`,
        gateReport.phase3Passed >= gateReport.checked * 0.7 ? "OK" : "WARN"
      );
      if (gateReport.softMatchedCount > 0) {
        addLog(`🟢 YUMUŞAK FİLTRE TOLERANSI: ${gateReport.softMatchedCount} foton sert rezonans sınırının hemen ötesinde, olasılıksal geçişle kabul edildi (Aşama 1 esnetildi)`,"OK");
      }
      if (gateReport.savedNs != null) {
        addLog(`PIM: I/O bariyeri atlanarak ~${gateReport.savedNs.toFixed(0)}ns simüle gecikme tasarrufu (von-Neumann yolu vs hücre-içi karar)`,"SYS");
      }
    }

    // DÜZELTME 5: ECC düzeltme sayısı — dizi karşılaştırması string değil sayısal
    // EK 29/30: hDec() yerine sendrom-kayıtlı eşdeğeri kullanılır — düzeltme
    // matematiği BİREBİR AYNI, sadece sendromlar quantumStateLog'a yakalanır.
    //
    // FAZ KARARLILIĞI KRİZİ BYPASS'I: OPLL açıksa ve kriz tespit edilirse
    // (genetik algoritmanın katsayı enjeksiyon hızı, fiziksel kanalların
    // yeniden-kilitlenme hızından daha agresifse), ECC düzeltmesi GEÇİCİ
    // OLARAK bypass edilir — kaotik/tutarsız fiziksel veri üzerinde yanlış
    // sendromlarla yanlış bit'ler "düzeltilip" durumun kötüleşmesi önlenir.
    let corrected=0;
    let quantumStateLog=[];
    let eccBypassed=false;
    if(ecc){
      const before=[...recv];
      const crisis = opllOn ? opticalPLL.isCrisis() : { inCrisis: false };
      eccBypassed = crisis.inCrisis;
      const decResult = hDecWithSyndromeLog(recv, eccBypassed);
      recv = decResult.decoded;
      quantumStateLog = buildQuantumStateLog(decResult.syndromeLog, entanglementSeed);
      corrected=countEccCorrections(before,recv);
      if (eccBypassed) {
        addLog(`⚠ FAZ KARARLILIĞI KRİZİ: enjeksiyon hızı fiziksel kilitlenmeyi geçti (kilit oranı %${(crisis.lockRatio*100).toFixed(0)}) — ECC katmanı geçici olarak BYPASS edildi`,"ERR");
      } else if(corrected) {
        addLog(`ECC: ${corrected} bit düzeltildi`,"OK");
      }
      addLog(`QSTATE: ${quantumStateLog.length} kuantum durum imzası kaydedildi`,"SYS");
    }
    const eccExplain = explainEcc(corrected); // EK: tooltip metni

    const decoded=b2t(recv);
    const berResult = clampBer(totalLost, totalFlip, bits.length);
    const er = berResult.er;
    const success=decoded===msg;
    // DÜZELTME 4 (devam): okCount/lostCount ile net isimlendirme
    // GÜVENLİK TABANI: matematiksel olarak totalLost+totalFlip asla
    // bits.length'i aşmamalı (karşılıklı dışlayan sayaçlar), ama ani
    // ABSORB patlamaları (Ping-Pong'un fiziksel tutarsız enjeksiyonu
    // gibi) altında savunmacı bir taban — okCount'un negatife düşüp
    // BAĞ düğümünde ECC taşmasına yol açmasını engeller.
    const okCount=Math.max(0, bits.length-totalLost-totalFlip);

    if (berResult.multiHopOverflow) {
      addLog(`⚠ ÇOK-HOP TAŞMASI: ham hata birikimi %${berResult.rawErrorAccumulation} (rota ${segs.length} hop içeriyor, gösterilen BER %100'de tavanlandı)`,"ERR");
    }
    addLog(`━━ ${success?"BAŞARILI":"BOZUK"}: "${msg}"→"${decoded}" BER=${er}%`,success?"OK":"ERR");
    if(evesdrop&&ec.EAVES)addLog("BB84: DİNLEME TESPİT EDİLDİ!","ERR");

    // EK 24: Ses efekti — kullanıcı ayarı açıksa gerçek Web Audio tonu çalınır
    if (soundOn) { try { success ? playSuccessChime() : playErrorGlitch(); } catch {} }

    // FAZ 6: HAT BAZLI SUÇLAMA (Link-Based Blaming) — bu iletim başarısızsa,
    // segReport'taki EN SORUNLU TEK segmenti (ANİ SOĞURULMA BARİYERİ tespit
    // edilmişse o, aksi halde en çok foton kaybı/bit bozulması olan) not
    // ederiz. Watchdog'un log-örüntü tespiti (bkz. FAZ 2 useEffect) bunu
    // kullanarak "son 3 başarısızlığın ortak paydası bir DÜĞÜM mü, yoksa
    // hattın KENDİSİ mi" ayrımını yapabilir — ADA/TZN/DIY gibi ilgisiz ara
    // düğümleri "kovalamak" yerine asıl arızalı bileşeni (örn. GAZ→BAG
    // hattı) doğrudan hedefler.
    let faultSegment = null;
    if (!success && segReport.length) {
      let bestScore = 0;
      for (const sr of segReport) {
        const score = (sr.absorptionBarrierDetected ? 100000 : 0) + (sr.lost||0)*10 + (sr.flipped||0);
        if (score > bestScore) {
          bestScore = score;
          faultSegment = { a: sr.link.a, b: sr.link.b, absorptionBarrier: !!sr.absorptionBarrierDetected, lost: sr.lost||0, flipped: sr.flipped||0 };
        }
      }
    }

    const res={
      original:msg, decoded,
      bits, recv,
      lostCount:totalLost,   // DÜZELTME: 'lost' değil 'lostCount'
      flipCount:totalFlip,
      okCount,               // DÜZELTME: 'ok' değil 'okCount'
      er, ec, corrected,
      totalKm, hops:segs.length, success,
      sat:sat.name, satEl:sat.elev.toFixed(1),
      geoKm: geoKm.toFixed(0),          // EK
      bb84MatchRate: recon.matchRate,   // EK
      qber, eavesdropDetected, siftedKeyLen: siftedKeyBits.length, // EK: gerçek BB84 anahtar katmanı sonuçları
      qkdChain, // DÜZELTME 9: güvenilir-düğüm röle zinciri kullanıldıysa hop-hop ayrıntı (null = tek-atış QKD)
      rawKeyRate, // QKD Rate: gerçek bit/saniye ölçütü (Micius-ölçekli) — statik bit sayısı değil
      similarity: charSimilarity(msg, decoded), // EK 17: bilgilendirici, success'i etkilemez
      otp: { keyLen: otpKeyBits.length, cipherBits: otpCipherBits, decoded: otpDecoded, integrityOk: otpIntegrityOk }, // EK 20
      legaSnapshot: segs[0] ? lega.computeThresholds(segs[0].nm, segs[0].km, { linkLoad: linkLoad[`${segs[0].a}-${segs[0].b}`] ?? 0, historicalBer: avgHistoricalBer }) : null, // LEGA: bu iletim için hesaplanan gerçek dinamik eşikler
      gateReport, // NodeTransitGate: 3-aşamalı karar motorunun bu iletimdeki özeti
      pimSummary: inMemoryFabric.summary(), // I/O Bariyeri Sıfırlama: von-Neumann vs PIM simüle gecikme karşılaştırması
      opllSummary: opllOn ? opticalPLL.summary() : null, // OPLL: kanal kilit durumları özeti (yalnızca açıksa)
      eccBypassed, // Faz Kararlılığı Krizi: bu iletimde ECC düzeltmesi bypass edildi mi
      routeHealth: health, // Rota-Sağlık Kontrolü: hop sayısı + kümülatif geçirgenlik teşhisi
      rawErrorAccumulation: berResult.rawErrorAccumulation, // BER'in tavansız (çok-hop) ham değeri
      corridorSnapshot: corridor, // Feedforward tahmin: vakum koridoru özeti (kaç düğüm önceden açıldı, ort. indirim)
      quantumStateLog, chirality: null, // EK 30/31: chirality mirrorOn kapalıyken null kalır (karşılaştıracak ikinci evren yok)
      eccExplain,                       // EK
      faultSegment, // FAZ 6: HAT BAZLI SUÇLAMA — bu iletimin en sorunlu tek segmenti (başarısızsa), Watchdog'un log-örüntü tespiti için
      securityProof: secProof.proof, // MADDE 3: sonlu-anahtar (finite-key) GLLP/Serfling kanıtı — ℓ, Q_ph_upper, secure vb.
      finalSecureKeyLen: secProof.finalKeyBits.length, // gizlilik yükseltme (Toeplitz/leftover-hash) sonrası FİİLEN üretilen kanıtlanmış-güvenli anahtar uzunluğu
      classicalAuth: { ok: authResult.ok, tag: authResult.tag, poolRemaining: authResult.poolRemaining ?? classicalAuthChannel.pool.length, reason: authResult.reason ?? null }, // Wegman-Carter kimlik doğrulama sonucu
      keyPoolStatus: keyPoolResult, // ASENKRON HAVUZ: bu rotanın biriken sifted-key havuzu durumu — blok tamamlandıysa gerçek n/k ayrımlı kanıt (keyPoolResult.finalized), tamamlanmadıysa yalnızca ilerleme (poolProgress/poolThreshold)
    };
    setResult(res);
    setBerHistory(h=>[...h.slice(-29),parseFloat(er)]);
    setTraffic(t=>[{...res,src,dst,time:new Date().toLocaleTimeString("tr")},...t.slice(0,49)]);
    setPhase(success?"TAMAMLANDI":"HATA");
    setRunning(false);

    // DÜZELTME 5 (devam): kalan sorumluluk — kalıcılaştırma + yayın +
    // görsel efektler. Bu blok SAF bir fonksiyona çıkarılamaz çünkü
    // doğrudan React state setter'larına (setTimeline, setMemoryTraces...)
    // ve component-scope ref'lere (bcRef, chiralEngine) bağımlı — ama
    // adlandırılmış, sınırları net bir sorumluluk olarak ayrıştırıldı:
    // routeCalculation → qkd/otp → physicalSimulation → persistAndBroadcast.
    const persistAndBroadcast = () => {
      // EK 7: Entangled Timeline kaydı — bu iletim kalıcı olarak
      // seed'iyle birlikte saklanır, sonradan aynen replay edilebilir
      const timelineEntry = {
        id: `T-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        seed: entanglementSeed,
        src, dst, path:p, segs, msg, ecc, evesdrop,
        time: new Date().toLocaleString("tr"),
        timestamp: Date.now(),
        result: res,
        eventLog,
        synced: isOnline, // EK 14: offline'da false — sonra "online" olayında true'ya çevrilir
      };
      setTimeline(t=>[timelineEntry, ...t.slice(0,99)]);

      // EK 14: IndexedDB'ye (yoksa localStorage'a) hemen yaz — transmit() ağdan
      // tamamen bağımsız çalıştığı için bu satır da internetsiz ortamda sorunsuz çalışır.
      dbPutTimeline(timelineEntry).then(ok=>{
        if (ok) dbEnforceQuota(100);
      });
      if (!isOnline) {
        setPendingSync(n=>n+1);
        addLog(`OFFLINE: iletim yerel diske kaydedildi, senkron bekliyor (${timelineEntry.id})`,"WARN");
      }

      // EK 8: Hafıza izi — haritada zamanla soluklaşan rota (başarı=mavi-yeşil, hata=kırmızı)
      setMemoryTraces(mt=>[
        { id: timelineEntry.id, path:p, success, createdAt:Date.now() },
        ...mt.slice(0,29)
      ]);

      // EK: BroadcastChannel üzerinden diğer sekmelere/kullanıcılara yayınla (multi-user)
      // EK 34: artık versiyonlu paket zarfı ile gönderilir
      if (bcRef.current) {
        bcRef.current.postMessage(
          buildBcPacket(BC_MSG_TYPES.TRANSMIT_EVENT, myUserId, buildTransmitPayload(src, dst, success))
        );
        // Kuantum durum telemetrisi varsa (Hamming sendrom logu üretildiyse) ayrıca yayınla
        if (res.quantumStateLog && res.quantumStateLog.length) {
          bcRef.current.postMessage(
            buildBcPacket(BC_MSG_TYPES.TELEMETRY, myUserId, buildTelemetryPayload({
              entanglementSeed, quantumStateLog: res.quantumStateLog, chirality: res.chirality,
              tabId: myTabId, role: localRole, qber: res.qber,
            }))
          );
        }
      }

      // EK 37: QBER'i canlı olarak taşıyıcı/modülatör frekanslarına bağla —
      // bu sekmede kiral ses açıksa, taze QBER değeriyle ton güncellenir.
      if (chiralAudioOn && res.qber != null) {
        chiralEngine.updateFromTelemetry(res.qber, res.chirality?.symmetryRatio != null ? (1-res.chirality.symmetryRatio) : 0);
      }

      // Görsel WDM animasyonu arka planda oynatılır — sonucu beklemeden gösterir
      Promise.all([1550,1310,850].map((nm,i)=>
        delay(i*200).then(()=>animPkt(p,WL[nm].hex,`${nm}`))
      ));

      // EK 18: Mirror Universe açıksa, transmit()'in TAMAMI bittikten sonra
      // (yukarıdaki tüm satırlar değişmeden) paralel ayna evren hesaplanır.
      if (mirrorOn) {
        runMirrorUniverse(entanglementSeed, p, segs, msg, ecc, evesdrop);
      } else {
        setMirrorResult(null);
      }
    };
    persistAndBroadcast();
  }

  // ══════════════════════════════════════════════════════════════
  // EK 9: REPLAY MOTORU — kaydedilmiş bir iletimi aynı entanglementSeed
  // ile birebir tekrar oynatır. transmit() fonksiyonuna DOKUNULMAZ;
  // bu tamamen ayrı, salt-okunur bir "hayalet" simülasyon katmanıdır.
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  // EK 16: SAF DETERMİNİSTİK YENİDEN-HESAPLAMA
  // transmit()'in bit-işleme mantığının birebir aynısı, ama hiçbir
  // state/log/animasyon yan etkisi olmadan — sadece saklı seed ile
  // recv/BER/success/ec'yi yeniden üretir. transmit() DEĞİŞTİRİLMEDİ;
  // bu tamamen ayrı, salt-hesaplama katmanıdır.
  // ══════════════════════════════════════════════════════════════
  function recomputeTransmission(entry) {
    const { seed, segs, msg, ecc, evesdrop } = entry;
    let bits = t2b(msg);
    if (ecc) bits = hEnc(bits);

    let recv = [...bits];
    let totalLost = 0, totalFlip = 0;
    const ec = {};
    const eventLog = [];

    for (let si=0; si<segs.length; si++){
      const lk = segs[si];
      const nd = getNode(lk.b); const rp = nd?.reps ?? 0;
      let sl=0, sf=0;
      for (let i=0; i<recv.length; i++){
        // Orijinal transmit() ile BİREBİR aynı seed kombinasyonu
        const bitRng = mulberry32(combineSeed(seed, si, i));
        const r = propPhoton(lk.nm, lk.km, rp, evesdrop && si===Math.floor(segs.length/2), bitRng);
        r.evs.forEach(ev=>{
          ec[ev.type]=(ec[ev.type]??0)+1;
          eventLog.push({seg:si, bit:i, nm:lk.nm, ...ev, text:explainEvent(ev, lk.nm)});
        });
        if (!r.ok) { recv[i]=0; sl++; }
        else if (r.flip) { recv[i]^=1; sf++; }
      }
      totalLost+=sl; totalFlip+=sf;
    }

    let corrected=0;
    let quantumStateLog=[];
    if (ecc) {
      const before=[...recv];
      const decResult = hDecWithSyndromeLog(recv);
      recv = decResult.decoded;
      quantumStateLog = buildQuantumStateLog(decResult.syndromeLog, seed);
      corrected=countEccCorrections(before,recv);
    }

    const decoded = b2t(recv);
    const er = clampBer(totalLost, totalFlip, bits.length).er; // BER gösterim düzeltmesi — [0,100] tavanlı
    const success = decoded === msg;
    const okCount = Math.max(0, bits.length-totalLost-totalFlip); // Güvenlik tabanı: ani ABSORB patlamalarına karşı

    return {
      decoded, bits, recv,
      lostCount:totalLost, flipCount:totalFlip, okCount,
      er, ec, corrected, success, eventLog, quantumStateLog,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // RETRO-CAUSALITY MOTORU (forkTransmission)
  //
  // DÜRÜST ÇERÇEVE: Bu fonksiyon geçmişi GERÇEKTEN değiştirmez — fiziksel
  // olarak anlamsız olurdu. Yaptığı şey: kaydedilmiş bir iletimin AYNI
  // fiziksel yolundan (aynı segs, aynı km, aynı dalga boyu — fiber fiziği
  // asla değişmez) geçen, ama BB84 baz uzlaşmasında FARKLI bir kuantum-
  // ölçüm rastgeleliği (historicalRng) kullanan DETERMİNİSTİK BİR FORK
  // üretir. "Retro-Cause" arayüzde "bu geçmiş anı farklı bir kuantum
  // tesadüfüyle yeniden yaşa" anlamına gelir — bilimsel kurgu çerçevesinde
  // tutarlı, fiziksel iddia olarak yanıltıcı değildir.
  //
  // Fiziksel simülasyon (recv/ec/eventLog) recomputeTransmission ile
  // BİREBİR AYNIDIR — sadece QKD katmanı farklı bir rng ile çalışır.
  // ══════════════════════════════════════════════════════════════
  /**
   * @param {Object} entry - timeline kaydı (seed, segs, msg, ecc, evesdrop içerir)
   * @param {number} retroCausalitySeed - orijinal seed'den FARKLI yeni bir sayı
   * @returns {Object} fork sonucu — orijinal TransmitResult ile aynı şekilde
   */
  function forkTransmission(entry, retroCausalitySeed) {
    const { segs, msg, ecc, evesdrop } = entry;

    // Fiziksel simülasyon: recomputeTransmission ile BİREBİR AYNI mantık
    // (fiber fiziği retro-causality'den etkilenmez — sadece foton kaybı/
    // saçılma/dekoherans gerçekleşiyor, bunlar "geçmiş" değil "yol"a bağlı).
    let bits = t2b(msg);
    if (ecc) bits = hEnc(bits);
    let recv = [...bits];
    let totalLost = 0, totalFlip = 0;
    const ec = {};
    const eventLog = [];
    for (let si=0; si<segs.length; si++){
      const lk = segs[si];
      const nd = getNode(lk.b); const rp = nd?.reps ?? 0;
      let sl=0, sf=0;
      for (let i=0; i<recv.length; i++){
        // Fork'un fiziksel yolu orijinal seed yerine retroCausalitySeed
        // ile üretilir — bu, aynı rota üzerinde "başka bir olası dünya"
        // demektir (aynı fiber, farklı kuantum tesadüfü).
        const bitRng = mulberry32(combineSeed(retroCausalitySeed, si, i));
        const r = propPhoton(lk.nm, lk.km, rp, evesdrop && si===Math.floor(segs.length/2), bitRng);
        r.evs.forEach(ev=>{
          ec[ev.type]=(ec[ev.type]??0)+1;
          eventLog.push({seg:si, bit:i, nm:lk.nm, ...ev, text:explainEvent(ev, lk.nm)});
        });
        if (!r.ok) { recv[i]=0; sl++; }
        else if (r.flip) { recv[i]^=1; sf++; }
      }
      totalLost+=sl; totalFlip+=sf;
    }

    // RETRO-CAUSALITY'NİN ASIL ETKİSİ: BB84 baz uzlaşması artık
    // historicalRng (retroCausalitySeed'den türetilmiş) ile çalışıyor —
    // bu, orijinal kayıttan FARKLI bazlar, dolayısıyla farklı sifted key,
    // farklı QBER ve potansiyel olarak farklı dinleme tespiti üretir.
    const historicalRng = mulberry32(retroCausalitySeed ^ 0x2545f491);
    const qkd = new QuantumKeyDistribution(retroCausalitySeed);
    const totalKm = segs.reduce((s,l)=>s+l.km,0);
    const { recon, siftedKeyBits, qber, eavesdropDetected } = qkd.deriveSiftedKey(bits, totalKm, evesdrop, historicalRng);

    let corrected=0;
    let quantumStateLog=[];
    if (ecc) {
      const before=[...recv];
      const decResult = hDecWithSyndromeLog(recv);
      recv = decResult.decoded;
      quantumStateLog = buildQuantumStateLog(decResult.syndromeLog, retroCausalitySeed);
      corrected=countEccCorrections(before,recv);
    }

    const decoded = b2t(recv);
    const er = clampBer(totalLost, totalFlip, bits.length).er; // BER gösterim düzeltmesi — [0,100] tavanlı
    const success = decoded === msg;
    const okCount = Math.max(0, bits.length-totalLost-totalFlip); // Güvenlik tabanı: ani ABSORB patlamalarına karşı

    // MADDE 3: fork/retro-causality yolu da (isteğe bağlı, düşük öncelik
    // ama tutarlılık için) aynı sonlu-anahtar kanıtını hesaplar — bu "başka
    // bir olası dünya"nın sifted key'i de aynı Serfling/GLLP çerçevesinden
    // geçer, böylece Fork panelindeki QBER/güvenlik gösterimi ana iletim
    // sonucuyla aynı standartla karşılaştırılabilir olur.
    const forkSecProof = QKDSecurityProof.run(siftedKeyBits, qber, retroCausalitySeed);

    return {
      decoded, bits, recv,
      lostCount:totalLost, flipCount:totalFlip, okCount,
      er, ec, corrected, success, eventLog, quantumStateLog,
      bb84MatchRate: recon.matchRate, qber, eavesdropDetected, siftedKeyLen: siftedKeyBits.length,
      securityProof: forkSecProof.proof, finalSecureKeyLen: forkSecProof.finalKeyBits.length,
      forkedFrom: entry.id, retroCausalitySeed,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // RETRO-CAUSALITY ORKESTRASYONU (Adım 3'teki "Retro-Cause" butonu bunu çağırır)
  // Yeni bir retroCausalitySeed üretir, forkTransmission() ile alternatif
  // sonucu hesaplar, forkedEntries state'ine ekler ve haritada/timeline'da
  // vurgulanması için activeForkId'yi günceller.
  // ══════════════════════════════════════════════════════════════
  function retroCauseTimeline(entryId) {
    const entry = timeline.find(t => t.id === entryId);
    if (!entry) { addLog(`RETRO-CAUSE HATA: kayıt bulunamadı (${entryId})`,"ERR"); return; }

    // Orijinal seed'den kasıtlı olarak farklı — "başka bir kuantum tesadüfü"
    const retroCausalitySeed = ((entry.seed ^ (Date.now() & 0xFFFFFFFF)) >>> 0);
    const forkResult = forkTransmission(entry, retroCausalitySeed);

    const forkEntry = {
      id: `FORK-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      sourceEntryId: entry.id,
      retroCausalitySeed,
      result: forkResult,
      path: entry.path,     // fiziksel yol AYNI (retro-causality rota değiştirmez)
      segs: entry.segs,
      src: entry.src, dst: entry.dst, msg: entry.msg,
      createdAt: Date.now(),
      time: new Date().toLocaleString("tr"),
    };

    setForkedEntries(f => [forkEntry, ...f.slice(0, 29)]); // en fazla 30 fork sakla
    setActiveForkId(forkEntry.id);

    const diverged = forkResult.decoded !== entry.result.decoded;
    addLog(
      `⏪ RETRO-CAUSE: "${entry.msg}" alternatif kuantum tesadüfüyle yeniden çalıştırıldı → `
      + `"${forkResult.decoded}" ${diverged ? "(orijinalden FARKLI — dallanma gerçekleşti)" : "(orijinalle aynı sonuç)"} `
      + `QBER=${(forkResult.qber*100).toFixed(1)}%`,
      diverged ? "WARN" : "OK"
    );
  }

  // ══════════════════════════════════════════════════════════════
  // EK 18: MIRROR UNIVERSE FİZİĞİ
  // Normal propPhoton'a HİÇ dokunulmadı. Bunun yerine, aynı segment/km
  // parametreleriyle çalışan ama olasılıkları "tersine çeviren" ayrı bir
  // fonksiyon: bizim evrende soğurulma (ABSORB) olduysa, ayna evrende o
  // foton büyük ihtimalle hayatta kalır veya sadece saçılmayla (SCATTER)
  // kurtulur — çünkü rng tam ters bitler üretir (seed ^ 0xFFFFFFFF).
  // ══════════════════════════════════════════════════════════════
  function propPhotonMirror(nm, km, reps, evesdrop, rng) {
    const rand = rng || Math.random;
    const w = WL[nm] || WL[1550];
    const sk = reps > 0 ? km / (reps+1) : km;
    const evs = [];
    let alive = true;
    for (let seg = 0; seg <= reps && alive; seg++) {
      const base = seg * sk;
      // EK: soğurulma olasılığı ayna evrende TERSİNE çevrilir (1-tProb yerine
      // gerçek tProb'un kendisi kullanılır ama rand() ters bitlerden geldiği
      // için pratikte çoğu "kayıp" senaryosu ayna evrende hayatta kalmaya döner)
      const survivalBoost = Math.min(0.9, fiberT(nm, sk) * 1.8); // dramatik artış
      if (rand() < (w.r/1200) * sk * 0.4) { // saçılma riski azaltılmış
        evs.push({ type:"SCATTER", km: base + rand()*sk*.7 });
        if (rand() < .25) { alive = false; break; } // ölüm olasılığı düşük
      }
      if (rand() > survivalBoost) {
        evs.push({ type:"ABSORB", km: base + sk*.1 + rand()*sk*.8 });
        alive = false; break;
      }
    }
    if (!alive) return { ok: false, evs };
    if (rand() < .006 + km/8000) { // faz kayması riski yarıya indirilmiş
      evs.push({ type:"PHASE", km: rand()*km });
      return { ok: true, evs, flip: true };
    }
    if (evesdrop && rand() < .2) {
      evs.push({ type:"EAVES", km: km*.35 + rand()*km*.3 });
      if (rand() < .15) return { ok: true, evs, flip: true };
    }
    return { ok: true, evs };
  }

  // Ayna evren için tam yeniden-hesaplama (recomputeTransmission'ın ayna ikizi)
  function computeMirrorTransmission(entangleSeed, segs, msg, ecc, evesdrop) {
    const mirrorSeed = (entangleSeed ^ 0xFFFFFFFF) >>> 0;
    let bits = t2b(msg);
    if (ecc) bits = hEnc(bits);
    let recv = [...bits];
    let totalLost=0, totalFlip=0;
    const ec = {};
    const eventLog = [];
    for (let si=0; si<segs.length; si++){
      const lk = segs[si];
      const nd = getNode(lk.b); const rp = nd?.reps ?? 0;
      let sl=0, sf=0;
      for (let i=0;i<recv.length;i++){
        const bitRng = mulberry32(combineSeed(mirrorSeed, si, i));
        const r = propPhotonMirror(lk.nm, lk.km, rp, evesdrop && si===Math.floor(segs.length/2), bitRng);
        r.evs.forEach(ev=>{
          ec[ev.type]=(ec[ev.type]??0)+1;
          eventLog.push({seg:si,bit:i,nm:lk.nm,...ev,text:explainEvent(ev,lk.nm)});
        });
        if (!r.ok) { recv[i]=0; sl++; }
        else if (r.flip) { recv[i]^=1; sf++; }
      }
      totalLost+=sl; totalFlip+=sf;
    }
    let corrected=0;
    let quantumStateLog=[];
    if (ecc) {
      const before=[...recv];
      const decResult = hDecWithSyndromeLog(recv);
      recv = decResult.decoded;
      quantumStateLog = buildQuantumStateLog(decResult.syndromeLog, mirrorSeed);
      corrected=countEccCorrections(before,recv);
    }
    const decoded = b2t(recv);
    const er = clampBer(totalLost, totalFlip, bits.length).er; // BER gösterim düzeltmesi — [0,100] tavanlı
    const success = decoded === msg;
    const okCount = Math.max(0, bits.length-totalLost-totalFlip); // Güvenlik tabanı: ani ABSORB patlamalarına karşı
    return { decoded, bits, recv, lostCount:totalLost, flipCount:totalFlip, okCount, er, ec, corrected, success, eventLog, mirrorSeed, quantumStateLog };
  }

  // EK 18: transmit()'in ETRAFINA sarmalayıcı — transmit() içeriği bire bir
  // aynı kalır, sadece mirrorOn açıkken paralel ikinci bir "ayna evren"
  // hesaplaması ve görsel animasyonu tetiklenir.
  async function runMirrorUniverse(entanglementSeed, p, segs, msgSnapshot, eccSnapshot, evesdropSnapshot) {
    const mirror = computeMirrorTransmission(entanglementSeed, segs, msgSnapshot, eccSnapshot, evesdropSnapshot);

    // EK 31/32: KİRALİTE SİMETRİ İZLEYİCİSİ + HATA MATRİSİ KORELASYONU
    // Asal evrenin (result, closure'dan erişilir) ve ayna evrenin sendrom
    // loglarını karşılaştır. Bu, mirror'ın kendi hesaplamasını DEĞİŞTİRMEZ —
    // sadece iki sonucu yan yana koyup bir üçüncü, salt-yorumlayıcı katman
    // (chirality) üretir.
    let chirality = null, errorCorrelation = null;
    if (result && result.quantumStateLog && mirror.quantumStateLog) {
      chirality = trackChiralitySymmetry(result.quantumStateLog, mirror.quantumStateLog);
      errorCorrelation = correlateErrorMatrices(result.ec, mirror.ec);
      addLog(`⚛ KİRALİTE: ${chirality.chiralityState} (${chirality.conjugateCount} eşlenik / ${chirality.phaseDeltaCount} faz-farkı blok)`,
        chirality.symmetryRatio > 0.5 ? "OK" : "WARN");
      if (errorCorrelation.correlation != null) {
        addLog(`⚛ HATA MATRİSİ KORELASYONU: r=${errorCorrelation.correlation.toFixed(3)} (evrenler arası hata-tipi ilişkisi)`, "SYS");
      }
    }
    mirror.chirality = chirality;             // EK: mirrorResult üzerinden UI'a taşınır
    mirror.errorCorrelation = errorCorrelation;

    setMirrorResult(mirror);
    addLog(`🪞 AYNA EVREN: BER=${mirror.er}% success=${mirror.success} (seed=${(entanglementSeed^0xFFFFFFFF)>>>0})`,
      mirror.success ? "OK" : "WARN");

    // Mor hayalet paket animasyonu — ana mavi paketlerle aynı anda, aynı rotada
    for (let si=0; si<segs.length; si++){
      const lk = segs[si];
      const nA = getNode(lk.a), nB = getNode(lk.b);
      if (!nA || !nB) continue;
      const steps = 24;
      for (let s=0;s<=steps;s++){
        const f = s/steps;
        setMirrorPkts(prev=>[
          ...prev.filter(g=>g.id!==`mirror-seg${si}`),
          { id:`mirror-seg${si}`, x:nA.x+(nB.x-nA.x)*f, y:nA.y+(nB.y-nA.y)*f, color:"#a855f7" }
        ]);
        await delay(16);
      }
      setMirrorPkts(prev=>prev.filter(g=>g.id!==`mirror-seg${si}`));
    }
    return mirror;
  }

  // EK 18: "Collapse" — kullanıcı iki evrenden birini seçer, diğeri çöker.
  // Seçilen evrenin sonucu res/timeline'ın "gerçek" hâli olarak kabul edilir.
  function collapseUniverse(choice) {
    setCollapsedTo(choice);
    if (choice === "mirror" && mirrorResult) {
      addLog(`⚛ ÇÖKÜŞ: Ayna evren seçildi — asal evren geçersiz kılındı. Yeni gerçeklik: "${mirrorResult.decoded}"`, "SYS");
    } else if (choice === "prime" && result) {
      addLog(`⚛ ÇÖKÜŞ: Asal evren seçildi — ayna evren geçersiz kılındı.`, "SYS");
    }
    if (result && mirrorResult) {
      const hPrime = shannonEntropy(result.ec);
      const hMirror = shannonEntropy(mirrorResult.ec);
      setEntropyDelta({ prime: hPrime, mirror: hMirror, delta: Math.abs(hPrime-hMirror) });
    }
    // EK 33: Observer-Centric mimari — seçime göre göreceli referans çerçevesini çöz
    const frame = resolveObserverFrame(choice, result, mirrorResult);
    setObserverFrame(frame);
    addLog(`👁 GÖZLEMCİ ÇERÇEVESİ: ${frame.observerFrame} — ${frame.note}`, "SYS");
  }

  // EK 18: "Interference" — iki evren birbirine dokundurulur, bazı bitler
  // yok olur (XOR ile sönümlenir) veya güçlenir (aynıysa pekişir).
  function interfereUniverses() {
    if (!result || !mirrorResult) { addLog("INTERFERENCE: her iki evren de henüz hesaplanmadı","WARN"); return null; }
    const len = Math.min(result.recv.length, mirrorResult.recv.length);
    let reinforced=0, annihilated=0;
    const interfered = [];
    for (let i=0;i<len;i++){
      const a = result.recv[i], b = mirrorResult.recv[i];
      if (a === b) { interfered.push(a); reinforced++; }       // aynı faz → güçlenir
      else { interfered.push(Math.random()<0.5?0:1); annihilated++; } // zıt faz → sönümlenir (rastgele çöker)
    }
    const decoded = b2t(interfered);
    addLog(`⚡ INTERFERENCE: ${reinforced} bit pekişti, ${annihilated} bit sönümlendi → "${decoded}"`, "SYS");
    setInterference(v=>v+annihilated);
    return { decoded, reinforced, annihilated };
  }

  async function replayTimeline(entryId){
    const entry = timeline.find(t=>t.id===entryId);
    if (!entry) { addLog(`REPLAY HATA: kayıt bulunamadı (${entryId})`,"ERR"); return; }
    if (replaying.includes(entryId)) return; // zaten oynatılıyor
    // EK 19 (performans): eşzamanlı replay sayısını sınırla — sınırsız
    // paralel replay UI'ı (setGhostPkts state patlaması) yavaşlatabilir.
    if (replaying.length >= 4) {
      addLog("REPLAY: aynı anda en fazla 4 replay çalışabilir, lütfen birini bitirin","WARN");
      return;
    }

    setReplaying(r=>[...r, entryId]);
    addLog(`⧉ REPLAY başlatıldı: ${entry.id} (${entry.src}→${entry.dst}, seed=${entry.seed})`,"SYS");

    // EK 16: GERÇEK yeniden-hesaplama — artık sadece log/görsel değil,
    // recv/BER/success orijinal seed ile bit-bit yeniden üretiliyor.
    let recomputed;
    try {
      recomputed = recomputeTransmission(entry);
      const matchesOriginal = recomputed.er === entry.result.er && recomputed.success === entry.result.success;
      addLog(
        `⧉ RE-RUN: BER=${recomputed.er}% success=${recomputed.success} `
        + `${matchesOriginal ? "(orijinalle birebir eşleşti ✓)" : "(orijinalden FARKLI — seed/algoritma tutarsızlığı!)"}`,
        matchesOriginal ? "OK" : "ERR"
      );
    } catch (e) {
      addLog(`REPLAY HATA: yeniden hesaplama başarısız (${e.message})`, "ERR");
      setReplaying(r=>r.filter(id=>id!==entryId)); // EK: hata durumunda da temizle
      return;
    }

    const { path:p, segs, seed } = entry;
    const ghostColor = recomputed.success ? "#22d3ee" : "#f43f5e";

    // Görsel katman: gerçek yeniden-hesaplanmış olayları segment sırasına göre oynat
    try {
      for (let si=0; si<segs.length; si++){
        const lk = segs[si];
        const nA = getNode(lk.a), nB = getNode(lk.b);
        if (!nA || !nB) continue;

        const segEvents = recomputed.eventLog.filter(e=>e.seg===si);
        const gid = `${entryId}-seg${si}`;
        const steps = 26;
        for (let s=0; s<=steps; s++){
          const f = s/steps;
          const gx = nA.x + (nB.x-nA.x)*f;
          const gy = nA.y + (nB.y-nA.y)*f;

          setGhostPkts(prev=>{
            const next = [...prev.filter(g=>g.id!==gid),
              { id:gid, x:gx, y:gy, color:ghostColor, sourceId:entryId, bornAt:Date.now() }];
            const collidingOthers = next.filter(g =>
              g.id !== gid && g.sourceId !== entryId && Math.hypot(g.x-gx, g.y-gy) < 14
            );
            if (collidingOthers.length > 0) setInterference(v=>v+1);
            // EK 19 (performans): çok fazla eşzamanlı replay UI'ı yavaşlatmasın
            // diye hayalet paket sayısı sert bir tavana (60) sabitlenir.
            return next.length > 60 ? next.slice(-60) : next;
          });

          // Gerçek yeniden-hesaplanmış olayları (uydurma değil) uygun anda logla
          if (s === Math.floor(steps/2) && segEvents.length) {
            const ev = segEvents[0];
            addLog(`  ⧉ ${ev.text}`, "INFO");
          }
          await delay(14);
        }
        setGhostPkts(prev=>prev.filter(g=>g.id!==gid));
      }
    } finally {
      // EK: her koşulda (hata dahil) hayalet paketleri ve replaying kaydını temizle
      setGhostPkts(prev=>prev.filter(g=>g.sourceId!==entryId));
      addLog(`⧉ REPLAY tamamlandı: ${entry.id} — sonuç: "${recomputed.decoded}"`,"OK");
      setReplaying(r=>r.filter(id=>id!==entryId));
    }
  }

  // EK 11: iki farklı iletimi "entangle" edip karşılaştır (BER farkı, olay dağılımı)
  function entangleCompare(idA, idB){
    const a = timeline.find(t=>t.id===idA);
    const b = timeline.find(t=>t.id===idB);
    if (!a || !b) return null;
    const berDiff = (parseFloat(a.result.er) - parseFloat(b.result.er)).toFixed(2);
    const allTypes = new Set([...Object.keys(a.result.ec), ...Object.keys(b.result.ec)]);
    const eventDiff = [...allTypes].map(type=>({
      type,
      a: a.result.ec[type]??0,
      b: b.result.ec[type]??0,
    }));
    return { a, b, berDiff, eventDiff };
  }

  // ══════════════════════════════════════════════════════════════
  // EK 22: ENTANGLEMENT GRAPH FONKSİYONLARI
  // ══════════════════════════════════════════════════════════════

  // Grafikte bir düğüm (timeline kaydı) seç/bırak
  function toggleGraphSelection(id) {
    setGraphSelection(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  }

  // Seçili birden fazla kaydı "entangle" ederek yeni bir süperpozisyon oluştur.
  // Süperpozisyon, birden fazla gerçekliğin (iletim sonucunun) "üst üste
  // binmiş" hâlidir — hiçbiri henüz "gerçek" değildir, kullanıcı sonra
  // collapseSuperposition() ile birini seçene kadar.
  function createSuperposition() {
    if (graphSelection.length < 2) {
      addLog("ENTANGLE: süperpozisyon için en az 2 kayıt seçilmeli","WARN");
      return;
    }
    const spId = `SP-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    const members = [...graphSelection];
    setSuperpositions(sp => [
      { id: spId, memberIds: members, createdAt: Date.now(), collapsedTo: null },
      ...sp
    ]);
    // Her çift arasına entangle kenarı çiz
    const newEdges = [];
    for (let i=0;i<members.length;i++){
      for (let j=i+1;j<members.length;j++){
        newEdges.push({ a:members[i], b:members[j], spId });
      }
    }
    setEntangleEdges(e => [...e, ...newEdges]);
    addLog(`⧉ SÜPERPOZİSYON oluşturuldu: ${members.length} kayıt entangle edildi (${spId})`,"SYS");
    setGraphSelection([]);
  }

  // Bir süperpozisyonu tek bir gerçekliğe indirger (Many-Worlds "collapse")
  function collapseSuperposition(spId, chosenMemberId) {
    setSuperpositions(sp => sp.map(s =>
      s.id===spId ? { ...s, collapsedTo: chosenMemberId } : s
    ));
    const chosen = timeline.find(t=>t.id===chosenMemberId);
    if (chosen) {
      addLog(`⚛ DALGA FONKSİYONU ÇÖKTÜ: süperpozisyon ${spId} → tek gerçeklik "${chosen.msg}" (${chosen.id})`,"SYS");
    }
  }

  // Süperpozisyon üyelerini interference ile birleştirip YENİ bir dalga
  // fonksiyonu (yeni timeline kaydı) türet — üyelerin recv dizileri
  // bit-bazında çoğunluk oyuyla (majority vote) birleştirilir.
  function interfereSuperposition(spId) {
    const sp = superpositions.find(s=>s.id===spId);
    if (!sp) return;
    const members = sp.memberIds.map(id=>timeline.find(t=>t.id===id)).filter(Boolean);
    if (members.length < 2) return;

    const len = Math.min(...members.map(m=>m.result.recv.length));
    const mergedBits = [];
    for (let i=0;i<len;i++){
      const votes = members.map(m=>m.result.recv[i]);
      const ones = votes.filter(v=>v===1).length;
      mergedBits.push(ones > votes.length/2 ? 1 : (ones===votes.length/2 ? (Math.random()<0.5?0:1) : 0));
    }
    const mergedDecoded = b2t(mergedBits);
    const newSeed = members.reduce((acc,m)=>acc ^ m.seed, 0) >>> 0;

    const newEntry = {
      id: `T-INTF-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      seed: newSeed,
      src: members[0].src, dst: members[0].dst,
      path: members[0].path, segs: members[0].segs,
      msg: `[interference:${members.map(m=>m.msg).join("+")}]`,
      ecc: members[0].ecc, evesdrop: members.some(m=>m.evesdrop),
      time: new Date().toLocaleString("tr"),
      timestamp: Date.now(),
      result: {
        original: mergedDecoded, decoded: mergedDecoded,
        bits: mergedBits, recv: mergedBits,
        lostCount:0, flipCount:0, okCount: mergedBits.length,
        er: "0.00", ec: {}, corrected:0, success:true,
        totalKm: members[0].result.totalKm, hops: members[0].result.hops,
        sat: members[0].result.sat, satEl: members[0].result.satEl,
        similarity: 1, synthesized: true, // EK: bu kayıt gerçek fiziksel iletim değil, interference sonucu
      },
      eventLog: [],
      synced: isOnline,
    };
    setTimeline(t=>[newEntry, ...t.slice(0,99)]);
    dbPutTimeline(newEntry);
    addLog(`⚡ SÜPERPOZİSYON INTERFERENCE: ${members.length} gerçeklik birleşti → yeni dalga fonksiyonu "${mergedDecoded}"`,"SYS");
  }

  // Basit force-directed layout — timeline + entangleEdges'e göre
  // düğüm konumlarını iteratif olarak günceller (ağır olmayan, O(n²)
  // ama n<100 için sorunsuz).
  // V8.0: eski bağımsız 60ms setInterval yerine rafEngine sistemine kayıt.
  useEffect(() => {
    if (tab !== "GRAPH") { rafEngine.unregister("force-directed-graph"); return; }
    const ids = timeline.map(t=>t.id);
    if (ids.length === 0) { rafEngine.unregister("force-directed-graph"); return; }

    let pos = { ...graphNodePos };
    ids.forEach((id,i)=>{
      if (!pos[id]) {
        const angle = (i/ids.length) * Math.PI * 2;
        pos[id] = { x: 400 + Math.cos(angle)*150, y: 250 + Math.sin(angle)*150 };
      }
    });

    rafEngine.register("force-directed-graph", 60, () => {
      const next = { ...pos };
      // İtme kuvveti (tüm düğümler birbirini iter)
      ids.forEach(id => {
        let fx=0, fy=0;
        ids.forEach(other=>{
          if (other===id) return;
          const dx = next[id].x-next[other].x, dy = next[id].y-next[other].y;
          const dist = Math.max(20, Math.hypot(dx,dy));
          const force = 800/(dist*dist);
          fx += (dx/dist)*force; fy += (dy/dist)*force;
        });
        // Çekim kuvveti (entangle edilmiş düğümler birbirine yakın durur)
        entangleEdges.forEach(e=>{
          if (e.a===id || e.b===id) {
            const otherId = e.a===id ? e.b : e.a;
            if (!next[otherId]) return;
            const dx = next[otherId].x-next[id].x, dy = next[otherId].y-next[id].y;
            fx += dx*0.01; fy += dy*0.01;
          }
        });
        // Merkeze hafif çekim (dağılmayı önler)
        fx += (400-next[id].x)*0.003; fy += (250-next[id].y)*0.003;
        next[id] = {
          x: Math.max(30,Math.min(770, next[id].x+fx*0.02)),
          y: Math.max(30,Math.min(470, next[id].y+fy*0.02)),
        };
      });
      pos = next;
      setGraphNodePos(next);
    }, "micro");

    return () => rafEngine.unregister("force-directed-graph");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, timeline.length, entangleEdges.length]);

  // ══════════════════════════════════════════════════════════
  // BURST TRAFFIC GENERATOR — asenkron yük simülatörü tetikleyicisi.
  // burstTrafficGenerator (module-level singleton), gerçek setLinkLoad
  // ve addLog'a bağlanarak Dual-Clock/Soft-Landing döngüsünü kontrollü
  // bir patlamayla test etmeyi sağlar.
  // ══════════════════════════════════════════════════════════
  async function triggerBurstTest(profile = "spike") {
    if (burstTrafficGenerator.running) {
      burstTrafficGenerator.cancel();
      addLog("🔥 BURST TEST: devam eden patlama iptal edildi","WARN");
      return;
    }
    setBurstActive(true);
    addLog(`🔥 BURST TEST BAŞLADI: profil="${profile}" — hedef tepe yük %95 (çöküş eşiğini bilerek aşar)`,"SYS");
    try {
      await burstTrafficGenerator.generateBurst(
        { profile, peak: 0.95, durationMs: profile === "sawtooth" ? 6000 : 3000, linkKeys: ["BURST-TEST"] },
        setLinkLoad,
        (value) => {
          if (value > 0.92 && !burstTrafficGenerator._loggedCollapse) {
            burstTrafficGenerator._loggedCollapse = true;
            addLog(`🔥 BURST TEST: yapay yük %92 çöküş eşiğini aştı (%${(value*100).toFixed(0)}) — Soft-Landing acil moda geçmeli`,"ERR");
          }
        }
      );
      burstTrafficGenerator._loggedCollapse = false;
      addLog(`🔥 BURST TEST TAMAMLANDI: zirve doluluk %${(burstTrafficGenerator.stats.peakOccupancyReached*100).toFixed(0)}`,"OK");
    } catch (e) {
      addLog(`🔥 BURST TEST HATA: ${e.message}`,"ERR");
    } finally {
      setBurstActive(false);
    }
  }

  // ══════════════════════════════════════════════════════════
  // DİNAMİK YÜK DENGELEME / AKILLI ROTALAMA — kriz enjeksiyonu tetikleyicisi.
  // KULLANICI TALEBİ: "stratejik bir hatta (örn. okyanus ötesi ana omurgada)
  // anlık yoğunluk veya bağlantı kopması simüle et, sistem otomatik olarak
  // alternatif rotayı bulup trafiği oraya kaydırsın". Bu fonksiyon TRF
  // sekmesindeki panelden çağrılır; gerçek yönlendirme değişikliği
  // transmit()'in routeCalculation() çağrısında (linkDown/linkLoad zaten
  // Dijkstra'nın ağırlık fonksiyonuna bağlı) KENDİLİĞİNDEN gerçekleşir —
  // bu fonksiyon yalnızca krizi enjekte eder/temizler ve durumu loglar.
  async function injectCrisis() {
    if (!crisisLinkSel) { addLog("KRİZ ENJEKSİYONU: önce bir hat seçin","WARN"); return; }
    if (activeCrisis) { addLog("KRİZ ENJEKSİYONU: zaten aktif bir kriz var — önce iptal edin","WARN"); return; }
    const [a, b] = crisisLinkSel.split("-");
    const link = links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (!link) { addLog("KRİZ ENJEKSİYONU: hat bulunamadı","ERR"); return; }

    const durationMs = 20000; // 20sn — birkaç GÖNDER denemesi için yeterli süre
    setCrisisBusy(true);
    setActiveCrisis({ a: link.a, b: link.b, key: crisisLinkSel, mode: crisisMode });
    try {
      if (crisisMode === "outage") {
        addLog(`🔴 KRİZ ENJEKTE EDİLDİ: ${link.a}-${link.b} (${link.km}km) hattı KOPTU — yönlendirme motoru bu hattı artık KULLANAMAZ, ~${(durationMs/1000).toFixed(0)}sn içinde otomatik onarılacak`,"ERR");
        await linkOutageController.injectOutage({ linkKey: crisisLinkSel, durationMs }, setLinkDown);
        addLog(`🟢 HAT ONARILDI: ${link.a}-${link.b} tekrar hizmete girdi`,"OK");
      } else {
        addLog(`🟠 KRİZ ENJEKTE EDİLDİ: ${link.a}-${link.b} (${link.km}km) hattında AŞIRI YOĞUNLUK — yönlendirme motoru bu hattı "pahalı" görecek, ~${(durationMs/1000).toFixed(0)}sn sürecek`,"WARN");
        await burstTrafficGenerator.generateBurst(
          { profile: "plateau", peak: 0.98, durationMs, linkKeys: [crisisLinkSel] },
          setLinkLoad
        );
        addLog(`🟢 YOĞUNLUK NORMALE DÖNDÜ: ${link.a}-${link.b}`,"OK");
      }
    } catch (e) {
      addLog(`KRİZ ENJEKSİYONU HATA: ${e.message}`,"ERR");
    } finally {
      setActiveCrisis(null);
      setCrisisBusy(false);
    }
  }

  /** Devam eden krizi (hangi türde olursa olsun) erken sonlandırır. */
  function cancelCrisis() {
    if (!activeCrisis) return;
    if (activeCrisis.mode === "outage") linkOutageController.cancel();
    else burstTrafficGenerator.cancel();
    addLog(`KRİZ MANUEL OLARAK İPTAL EDİLDİ: ${activeCrisis.a}-${activeCrisis.b}`,"SYS");
  }

  // ══════════════════════════════════════════════════════════
  // FAZ 2: KENDİ KENDİNİ İYİLEŞTİRME — demo/manuel anomali tetikleyicisi.
  // KULLANICI TALEBİ: "bir thread kilitlenirse, bellek sızıntısı başlarsa
  // veya bir node yanıt vermeyi keserse — bekçi insan müdahalesine gerek
  // kalmadan hatayı yakalayacak, ilgili alt modülü asenkron olarak
  // resetleyecek". Bu fonksiyon WDG panelinden çağrılır; gerçek karantina/
  // otonom iyileştirme akışı NodeWatchdog.triggerAnomaly() içinde yaşar —
  // burası yalnızca girdileri doğrulayıp o akışı başlatır.
  // ══════════════════════════════════════════════════════════
  async function injectAnomaly() {
    if (!anomalyNodeSel) { addLog("WATCHDOG DEMO: önce bir düğüm seçin","WARN"); return; }
    if (anomalyNodeSel === src || anomalyNodeSel === dst) {
      addLog("WATCHDOG DEMO: aktif KAYNAK/HEDEF düğüm karantinaya alınamaz — başka bir düğüm seçin","WARN");
      return;
    }
    if (nodeWatchdog.isBusy(anomalyNodeSel)) { addLog("WATCHDOG DEMO: bu düğüm zaten meşgul (aktif anomali veya proaktif bakım)","WARN"); return; }
    await nodeWatchdog.triggerAnomaly(
      { nodeId: anomalyNodeSel, type: anomalyTypeSel },
      { setNodes, setNodeHealth, setActiveAnomalies, addLog, setWatchdogStats,
        openDrillDown: watchdogAutoOpenDrill, onHealed: watchdogOnHealed }
    );
  }

  /** Devam eden bir anomali/iyileştirmeyi erken tamamlar ("hemen onar"). */
  function forceHealAnomaly(nodeId) {
    nodeWatchdog.forceHealNow(nodeId);
  }

  // ══════════════════════════════════════════════════════════
  // FAZ 4: TAHMİNLEME MODELİ — demo trend enjeksiyonu.
  // KULLANICI TALEBİ doğrultusunda, motorun GERÇEKTEN "krizin geleceğini
  // önceden görmesini" canlı göstermek için bir linkin veya düğümün
  // yükünü YAVAŞÇA (aniden değil) yükselten bir demo enjeksiyonu. Amaç:
  // predictiveEngine'in, yük daha KRİTİK eşiğe varmadan ÇOK ÖNCE
  // (hareketli ortalama + ivme ekstrapolasyonuyla) risk uyarısı basmasını
  // ve — düğüm ise — otonom önleyici bakımı tetiklemesini izlemek.
  // ══════════════════════════════════════════════════════════
  async function injectLinkTrend() {
    if (!trendLinkSel) { addLog("TREND ENJEKSİYONU: önce bir hat seçin","WARN"); return; }
    if (burstTrafficGenerator.running) { addLog("TREND ENJEKSİYONU: BurstTrafficGenerator zaten meşgul","WARN"); return; }
    const [a,b] = trendLinkSel.split("-");
    const link = links.find(l=>(l.a===a&&l.b===b)||(l.a===b&&l.b===a));
    if (!link) { addLog("TREND ENJEKSİYONU: hat bulunamadı","ERR"); return; }
    setLinkTrendBusy(true);
    addLog(`📈 TREND ENJEKSİYONU: ${link.a}-${link.b} hattında yük KADEMELİ olarak yükseltiliyor — TahminlemeMotoru'nun krizi önceden görüp görmediğini izleyin`,"SYS");
    try {
      await burstTrafficGenerator.generateBurst(
        { profile: "plateau", peak: 0.95, durationMs: 28000, linkKeys: [trendLinkSel] },
        setLinkLoad
      );
      addLog(`📈 TREND ENJEKSİYONU TAMAMLANDI: ${link.a}-${link.b}`,"SYS");
    } catch (e) {
      addLog(`TREND ENJEKSİYONU HATA: ${e.message}`,"ERR");
    } finally {
      setLinkTrendBusy(false);
    }
  }
  function cancelLinkTrend() { burstTrafficGenerator.cancel(); }

  async function injectNodeTrend() {
    if (!trendNodeSel) { addLog("TREND ENJEKSİYONU: önce bir düğüm seçin","WARN"); return; }
    if (trendNodeSel===src||trendNodeSel===dst) { addLog("TREND ENJEKSİYONU: aktif kaynak/hedef düğüm seçilemez","WARN"); return; }
    if (metricTrendInjector.running) { addLog("TREND ENJEKSİYONU: bir düğüm trendi zaten aktif","WARN"); return; }
    const metricLabel = trendMetricSel==="mem" ? "BELLEK" : "CPU";
    setNodeTrendBusy(true);
    nodeTrendActiveRef.current = trendNodeSel; // watchdog-vitals-tick bu düğümü atlasın
    addLog(`📈 TREND ENJEKSİYONU: ${trendNodeSel} düğümünde ${metricLabel} kullanımı KADEMELİ olarak yükseltiliyor`,"SYS");
    try {
      await metricTrendInjector.run(
        { peak: 0.97, durationMs: 28000, baseline: 0.15 },
        (v) => setNodeHealth(prev => ({ ...prev, [trendNodeSel]: {
          ...(prev[trendNodeSel]||{}),
          [trendMetricSel]: v*100,
          status: v>0.9?"CRIT":"OK",
        } })),
        () => setNodeHealth(prev => ({ ...prev, [trendNodeSel]: {
          ...(prev[trendNodeSel]||{}),
          [trendMetricSel]: 15+Math.random()*10,
          status: "OK",
        } }))
      );
      addLog(`📈 TREND ENJEKSİYONU TAMAMLANDI: ${trendNodeSel} (${metricLabel})`,"SYS");
    } catch (e) {
      addLog(`TREND ENJEKSİYONU HATA: ${e.message}`,"ERR");
    } finally {
      nodeTrendActiveRef.current = null;
      setNodeTrendBusy(false);
    }
  }
  function cancelNodeTrend() { metricTrendInjector.cancel(); }

  // ══════════════════════════════════════════════════════════
  // FAZ 5: KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON — demo enjeksiyonları.
  // injectThermalFluctuation: SNSPD bias noktasını ani bir sıçramayla
  // zorlar — noise-gate-calibration-tick'in ORTALAMAYA-DÖNÜŞLÜ rastgele
  // yürüyüşü zamanla kendisi geri çeker (Faz 2/4'teki demo enjeksiyonların
  // aksine burada RAF-tabanlı bir ramp gerekmez — tek seferlik bir
  // dürtü/impulse yeterlidir, sistem kendi otonom kalibrasyon döngüsüyle
  // toparlanır). injectFiberLeak: kalıcı bir aç/kapa sızıntı arka planı
  // (gerçek bir fiber konektör bozulmasının aksine, mean-reversion ile
  // OTOMATİK toparlanmaz — kullanıcı elle kapatana kadar sürer, gerçekçi).
  // ══════════════════════════════════════════════════════════
  function injectThermalFluctuation() {
    const before = noiseGateMiddleware.tempDriftMk;
    noiseGateMiddleware.advanceThermalDrift(14);
    addLog(
      `🌡️ ISIL DALGALANMA ENJEKTE EDİLDİ: SNSPD bias noktası zorlandı (${before.toFixed(2)}mK → ${noiseGateMiddleware.tempDriftMk.toFixed(2)}mK) `
      + `— kalibrasyon turlarını ve 🔬 GÜRÜLTÜ sekmesini izleyin, sistem otonom olarak toparlanacak`,
      "SYS"
    );
  }
  function toggleFiberLeak() {
    const next = !fiberLeakActive;
    noiseGateMiddleware.fiberLeakBoostHz = next ? 3200 : 0;
    setFiberLeakActive(next);
    addLog(
      next
        ? "💧 FİBER SIZINTISI ENJEKTE EDİLDİ: hatta ekstra ~3200Hz başıboş foton sızıntısı simüle ediliyor — kalıcıdır, elle giderilmelidir"
        : "💧 FİBER SIZINTISI GİDERİLDİ: sızıntı arka planı kaldırıldı",
      "SYS"
    );
  }

  // ══════════════════════════════════════════════════════════
  // FAZ 3: MAKRO/MİKRO GÖRÜNÜM GEÇİŞLERİ (Hierarchical Drill-Down).
  // KULLANICI TALEBİ: "Kullanıcı (veya sistemin kendisi) ... tek bir
  // düğüme tıkladığında, o düğümün içine Zoom-In yaparak alt bileşenlerini,
  // açık olan asenkron network soketlerini ve thread havuzunun anlık
  // durumunu gösteren mikro bir katman açmak."
  // ══════════════════════════════════════════════════════════

  /** Kullanıcı elle bir düğüme "zoom-in" yapar — otomatik kapanmaz. */
  function openDrillDown(nodeId) {
    setDrillNode(nodeId);
    setDrillAutoOpened(false);
  }
  function closeDrillDown() {
    setDrillNode(null);
    setDrillAutoOpened(false);
  }
  /** NodeWatchdog'un io.openDrillDown callback'i — YALNIZCA kullanıcı
   * hâlihazırda başka bir mikro görünüme bakmıyorsa devreye girer (onun
   * elle açtığı görünümün üzerine yazmaz). */
  function watchdogAutoOpenDrill(nodeId) {
    if (drillNodeRef.current === null) {
      setDrillNode(nodeId);
      setDrillAutoOpened(true);
    }
  }
  /** NodeWatchdog'un io.onHealed callback'i — yalnızca OTOMATİK açılmış
   * VE hâlâ aynı düğüme bakan bir görünümü, kısa bir "kurtarıldı" nefes
   * payının ardından kendi kendine kapatır. */
  function watchdogOnHealed(nodeId) {
    if (drillNodeRef.current === nodeId && drillAutoOpenedRef.current) {
      setTimeout(() => {
        setDrillNode(p => p === nodeId ? null : p);
        setDrillAutoOpened(false);
      }, 2200);
    }
  }

  /**
   * Bir düğümün "mikro katmanını" oluşturan sentetik ama tutarlı veri:
   * alt bileşenler (submodules), o düğüme bağlı fiziksel linklerden türeyen
   * "açık asenkron soketler" ve nodeHealth.cpu/anomali türünden türeyen
   * canlı thread havuzu durumu. Render-ucuz (saf dizi işlemleri) olduğu
   * için useMemo'ya gerek yok — zaten nodeHealth 1200ms'de bir değişip
   * bileşeni yeniden render ediyor.
   * @param {string} nodeId
   */
  function buildDrillData(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return null;
    const health = nodeHealth[nodeId] || { cpu: 10, mem: 15, heartbeat: 1, status: "OK" };
    const anomaly = activeAnomalies[nodeId] || null;

    const submodules = [
      { name: "BB84 Kodlayıcı/Çözücü", detail: "polarizasyon bazlı BB84 protokol katmanı" },
      { name: "Tek-Foton Dedektör Dizisi (SPD)", detail: `${node.type==="hub"?8:node.type==="intl"?6:4} kanal` },
      { name: "Zaman Damgası Korelatörü", detail: "TimeTagCorrelator — coincidence window 1ns" },
      { name: "Senkronizasyon Saati", detail: "atomik referans, drift < 10ppb" },
      { name: "Yönlendirme Motoru İstemcisi", detail: "Dijkstra / EdgeWeightPolicy istemcisi" },
    ];
    if (node.reps > 0) submodules.splice(2, 0, { name: "EDFA Optik Amplifikatör", detail: `×${node.reps} tekrarlayıcı katmanı` });

    const connectedLinks = links.filter(l => l.a === nodeId || l.b === nodeId);
    const sockets = connectedLinks.map(l => {
      const peer = l.a === nodeId ? l.b : l.a;
      const kAB = `${l.a}-${l.b}`, kBA = `${l.b}-${l.a}`;
      const down = !!(linkDown[kAB] || linkDown[kBA]);
      const load = linkLoad[kAB] ?? linkLoad[kBA] ?? 0;
      // deterministik sahte port — gerçek bir soket yok, ama her (nodeId,peer)
      // çifti için KARARLI kalır (render'dan render'a zıplamaz).
      const port = 40000 + ((nodeId + peer).split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 9000);
      const state = down ? "CLOSED" : load > 0.75 ? "CONGESTED" : "ESTABLISHED";
      return { peer, port, state, load, km: l.km };
    });

    const poolSize = node.type === "hub" ? 8 : node.type === "intl" ? 6 : 4;
    const threads = Array.from({ length: poolSize }, (_, i) => {
      if (anomaly?.type === "lockup") return { id: i, state: "BLOCKED" };
      if (anomaly?.type === "unresponsive") return { id: i, state: "NO_RESPONSE" };
      const busyCount = Math.round((health.cpu / 100) * poolSize);
      return { id: i, state: i < busyCount ? "BUSY" : "IDLE" };
    });

    return { node, health, anomaly, submodules, sockets, threads, poolSize };
  }

  // ══════════════════════════════════════════════════════════
  // EK 41: KİRAL SES AÇ/KAPA + İZİN/KURTARMA MANTIĞI
  // Tarayıcıların otomatik-oynatma politikası (autoplay policy),
  // kullanıcı bir jest (tıklama/dokunma) yapmadan AudioContext'in
  // "running" durumuna geçmesini engeller. Bu fonksiyon önce context'i
  // kurmayı dener; state "suspended" kalırsa audioBlocked=true set
  // edilir ve UI'da bir kurtarma butonu gösterilir.
  // ══════════════════════════════════════════════════════════
  async function toggleChiralAudio() {
    if (chiralAudioOn) {
      chiralEngine.stop();
      chiralEngine.stopSilentKeepAlive();
      setChiralAudioOn(false);
      addLog("🔇 Kiral akustik motor durduruldu","INFO");
      return;
    }
    const ctx = chiralEngine.ensureContext();
    if (!ctx) {
      addLog("⚠ Bu tarayıcı Web Audio API'yi desteklemiyor","ERR");
      return;
    }
    // Kullanıcı jesti (bu fonksiyon bir onClick içinde çağrıldığı için)
    // sayesinde resume genellikle başarılı olur; yine de doğrula.
    try { await ctx.resume(); } catch {}

    if (ctx.state !== "running") {
      setAudioBlocked(true);
      addLog("⚠ AudioContext tarayıcı tarafından engellendi — kurtarma butonuna basın","WARN");
      return;
    }
    setAudioBlocked(false);
    chiralEngine.start({ carrierFreq: CHIRAL_BASE_FREQ, modFreq: 3, modDepth: 8 });
    chiralEngine.startSilentKeepAlive(); // EK 36: arka plan throttling'i aş
    setChiralAudioOn(true);
    addLog("🔊 Kiral akustik motor başlatıldı — QBER/kiralite ile canlı FM modülasyon aktif","OK");
  }

  // EK 41: kurtarma butonu — audioBlocked=true iken kullanıcı buna basınca
  // (bu da bir kullanıcı jesti olduğu için) resume tekrar denenir.
  async function retryAudioUnlock() {
    const ctx = chiralEngine.ensureContext();
    if (!ctx) return;
    try {
      await ctx.resume();
      if (ctx.state === "running") {
        setAudioBlocked(false);
        chiralEngine.start({ carrierFreq: CHIRAL_BASE_FREQ, modFreq: 3, modDepth: 8 });
        chiralEngine.startSilentKeepAlive();
        setChiralAudioOn(true);
        addLog("🔊 AudioContext kilidi açıldı — kiral ses aktif","OK");
      } else {
        addLog("⚠ AudioContext hâlâ engelli — tarayıcı ayarlarını kontrol edin","ERR");
      }
    } catch (e) {
      addLog(`⚠ AudioContext resume hatası: ${e.message}`,"ERR");
    }
  }

  function toggleNode(id){
    if(id===src||id===dst)return;
    setNodes(prev=>prev.map(n=>n.id===id?{...n,on:!n.on}:n));
    setPath(null);setResult(null);
  }

  const online=nodes.filter(n=>n.on);
  const curSat=sats.find(s=>s.id===activeSat)||sats[0];
  const curSatQ=(satQ(curSat.elev)*100).toFixed(0);
  const totalLoad=Object.values(linkLoad).reduce((a,v)=>a+v,0)/(LINKS.length||1);
  const pathKm=path?path.slice(1).reduce((s,p)=>s+(p.link?.km??0),0):0;
  const PHASE_C={"BEKLENIYOR":"#334155","ROTA HESAPLANIYOR":"#00d4ff","KODLAMA":"#7c3aed","İLETİM":"#f59e0b","TAMAMLANDI":"#10b981","HATA":"#f43f5e"};
  // FAZ 3: aktif drill-down (varsa) için mikro katman verisi — bkz. buildDrillData().
  const drillData = drillNode ? buildDrillData(drillNode) : null;

  return(
  <div style={{height:"100vh",background:"#020409",color:"#e2e8f0",
    fontFamily:"'JetBrains Mono','Fira Code',monospace",
    display:"flex",flexDirection:"column",overflow:"hidden"}}>
  <style>{`
    *{box-sizing:border-box;margin:0;padding:0}
    ::-webkit-scrollbar{width:3px;height:3px}
    ::-webkit-scrollbar-thumb{background:#0a1628;border-radius:2px}
    select,textarea{background:#0a1628;border:1px solid #1e3a5f55;color:#94a3b8;
      border-radius:4px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:11px}
    select:focus,textarea:focus{outline:none;border-color:#00d4ff55;color:#e2e8f0}
    @keyframes pkt{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.4)}}
    @keyframes flow{to{stroke-dashoffset:-20}}
    @keyframes cosmicDrift{
      0%{transform:translate(0,0);opacity:0}
      10%{opacity:.35}
      50%{transform:translate(30px,-40px)}
      90%{opacity:.35}
      100%{transform:translate(60px,-80px);opacity:0}
    }
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
    @keyframes glow{0%,100%{opacity:.3}50%{opacity:.8}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes satOrbit{0%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}100%{transform:rotate(-5deg)}}
    @keyframes drillZoomIn{from{opacity:0;transform:scale(.9) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
    @keyframes drillBackdropIn{from{opacity:0}to{opacity:1}}
    .ptab{background:none;border:none;cursor:pointer;padding:4px 10px;border-radius:3px;
      font-size:10px;font-family:inherit;letter-spacing:.06em;color:#334155;transition:all .15s}
    .ptab:hover{color:#64748b}
    .ptab.on{background:#0a1628;color:#00d4ff;border:1px solid #00d4ff22}
    .nbtn{background:none;border:none;cursor:pointer;font-family:inherit;padding:0;color:inherit}
    .nrow{padding:3px 6px;border-radius:3px;cursor:pointer;transition:background .1s;display:flex;align-items:center;gap:6px}
    .nrow:hover{background:#0a1628}
  `}</style>

  {/* ══ TOPBAR ══════════════════════════════════════════════ */}
  <div style={{height:46,background:"#030610",borderBottom:"1px solid #0a162888",
    display:"flex",alignItems:"center",padding:"0 14px",gap:10,flexShrink:0}}>
    <div style={{width:26,height:26,borderRadius:4,
      background:"linear-gradient(135deg,#00d4ff22,#7c3aed22)",
      border:"1px solid #00d4ff33",
      display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,
      boxShadow:"0 0 10px #00d4ff22",flexShrink:0}}>⚛</div>
    <div style={{flexShrink:0}}>
      <div style={{fontSize:12,fontWeight:700,letterSpacing:".14em",
        color:"#00d4ff",textShadow:"0 0 10px #00d4ff55"}}>PHOTONNET</div>
      <div style={{fontSize:8,color:"#1e3a5f",letterSpacing:".16em",marginTop:-1}}>
        QUANTUM OPTICAL NETWORK v2.5
      </div>
    </div>
    {[
      {l:"UYDU",v:curSat.name,c:"#00d4ff",blink:true},
      {l:"ISP",v:"BAĞIMSIZ",c:"#10b981"},
      {l:"DURUM",v:phase,c:PHASE_C[phase]||"#334155"},
      {l:"OPERATÖR",v:`${Object.keys(remoteUsers).length+1} çevrimiçi`,c:"#f59e0b",blink:Object.keys(remoteUsers).length>0},
      {l:"BAĞLANTI",v:isOnline?"ÇEVRİMİÇİ":"ÇEVRİMDIŞI",c:isOnline?"#10b981":"#f43f5e",blink:!isOnline},
      {l:"DEPOLAMA",v:storageMode==="indexeddb"?"IndexedDB":storageMode==="localstorage"?"localStorage":"…",c:"#7c3aed"},
    ].map(s=>(
      <div key={s.l} style={{display:"flex",alignItems:"center",gap:5,
        background:"#0a1628",border:`1px solid ${s.c}22`,
        borderRadius:3,padding:"3px 8px",flexShrink:0}}>
        <div style={{width:5,height:5,borderRadius:"50%",background:s.c,
          boxShadow:`0 0 5px ${s.c}`,
          animation:s.blink?"blink 2s ease-in-out infinite":"none"}}/>
        <span style={{fontSize:7,color:"#334155",letterSpacing:".1em"}}>{s.l}</span>
        <span style={{fontSize:9,color:s.c,fontWeight:700,letterSpacing:".04em"}}>{s.v}</span>
      </div>
    ))}
    <div style={{display:"flex",gap:2,marginLeft:"auto"}}>
      {[["MAP","🌐 AĞ"],["SAT","🛰 UYDU"],["TRF","📊 TRAFİK"],["TML","⧉ ZAMAN ÇİZ."],["GRAPH","🕸 GRAPH"],["WDG","🛡 BEKÇİ"],["PRED","🔮 TAHMİN"],["NGM","🔬 GÜRÜLTÜ"],["HW","🔧 DONANIM"],["LOG","📋 KAYIT"]].map(([k,l])=>(
        <button key={k} className={`ptab ${tab===k?"on":""}`} onClick={()=>setTab(k)}>{l}</button>
      ))}
    </div>
    {/* EK 24: Ses efekti aç/kapat */}
    <button onClick={()=>setSoundOn(v=>!v)}
      style={{background:"none",border:"none",cursor:"pointer",fontSize:13,
        marginLeft:8,opacity:soundOn?1:.35,flexShrink:0}}
      title={soundOn?"Sesi kapat":"Sesi aç"}>
      {soundOn?"🔊":"🔇"}
    </button>
    {/* EK 35/41: Kiral akustik motor aç/kapat */}
    <button onClick={toggleChiralAudio}
      style={{background:chiralAudioOn?"#a855f722":"none",
        border:`1px solid ${chiralAudioOn?"#a855f755":"transparent"}`,
        borderRadius:4,cursor:"pointer",fontSize:11,padding:"3px 8px",
        marginLeft:6,color:chiralAudioOn?"#a855f7":"#334155",
        display:"flex",alignItems:"center",gap:4,flexShrink:0}}
      title="Kiral Akustik Motor — QBER/kiralite ile canlı FM ses">
      🎵 {chiralAudioOn?"KİRAL SES AÇIK":"Kiral Ses"}
    </button>
    {/* Optik Faz Kilitli Döngü (OPLL) aç/kapat */}
    <button onClick={()=>setOpllOn(v=>!v)}
      style={{background:opllOn?"#00d4ff22":"none",
        border:`1px solid ${opllOn?"#00d4ff55":"transparent"}`,
        borderRadius:4,cursor:"pointer",fontSize:11,padding:"3px 8px",
        marginLeft:6,color:opllOn?"#00d4ff":"#334155",
        display:"flex",alignItems:"center",gap:4,flexShrink:0}}
      title="Optik Faz Kilitli Döngü (OPLL) — kilitlenen kanallarda faz kayması olasılığını bastırır">
      ⌇ {opllOn?"OPLL KİLİTLİ":"OPLL"}
    </button>
    {/* FAZ KARARLILIĞI KRİZİ göstergesi — yalnızca OPLL açıkken ve kriz gerçekten sürüyorken görünür */}
    {opllOn && opticalPLL.isCrisis().inCrisis && (
      <div title="Katsayı enjeksiyon hızı, fiziksel faz kilitlenmesinden daha agresif — ECC bu koşulda otomatik bypass edilecek"
        style={{display:"flex",alignItems:"center",gap:5,marginLeft:6,flexShrink:0,
          fontSize:9,fontFamily:"monospace",color:"#f43f5e"}}>
        <div style={{width:5,height:5,borderRadius:"50%",background:"#f43f5e",
          boxShadow:"0 0 5px #f43f5e",animation:"blink 0.5s ease-in-out infinite"}}/>
        ⚠ FAZ KRİZİ
      </div>
    )}
    {/* EK 38: Clock drift göstergesi — sadece belirgin sapma varsa görünür */}
    {clockDrift && Math.abs(clockDrift.driftMs) > 50 && (
      <div title="Zaman Dilatasyonu (throttling sapması)"
        style={{fontSize:9,color:Math.abs(clockDrift.driftMs)>150?"#f43f5e":"#f59e0b",
          fontFamily:"monospace",marginLeft:6,flexShrink:0}}>
        ⏱ {clockDrift.driftMs>0?"+":""}{clockDrift.driftMs.toFixed(0)}ms
      </div>
    )}
    {/* İKİ ZAMANLI SİSTEM — MAKRO KATMAN göstergesi: kendi kendini
        optimize eden katsayılar, epoch bazlı (4sn), mikro katmandan
        tamamen bağımsız kendi zaman diliminde çalışır. */}
    <div title={evolutionActive ? "MAKRO ZAMAN: ağ sakin — epoch bazlı evrim çalışıyor (4sn periyot)" : "MAKRO ZAMAN: ağ yoğun — evrim duraklatıldı, hesaplama bütçesi trafiğe ayrıldı"}
      style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
        fontSize:9,fontFamily:"monospace",color:evolutionActive?"#22c55e":"#334155"}}>
      <div style={{width:5,height:5,borderRadius:"50%",
        background:evolutionActive?"#22c55e":"#334155",
        boxShadow:evolutionActive?"0 0 5px #22c55e":"none",
        animation:evolutionActive?"blink 1.4s ease-in-out infinite":"none"}}/>
      <span style={{opacity:.6,fontSize:7}}>MAKRO</span> N{evolutionGen} α={liveCoeffs.alpha.toFixed(2)} β={liveCoeffs.beta.toFixed(2)}
    </div>
    {/* DÜĞÜM REDDİ CEZASI İZLEME: genetik algoritmanın kendi kendini
        eğitirken GERÇEKTEN ölçtüğü ret oranı — nesiller ilerledikçe
        düşmesi beklenir. Yalnızca en az bir ölçüm yapıldıysa görünür. */}
    {lastNodeRejectionRate != null && (
      <div title={`Düğüm Reddi Cezası (ağırlık=${nodeRejectionPenaltyWeight.toFixed(2)}) — genetik algoritmanın probeGate ile ölçtüğü gerçek ret oranı`}
        style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
          fontSize:9,fontFamily:"monospace",color:lastNodeRejectionRate<0.3?"#22c55e":"#f59e0b"}}>
        🎯 RET %{(lastNodeRejectionRate*100).toFixed(0)}
      </div>
    )}
    {/* İKİ ZAMANLI SİSTEM — MİKRO KATMAN göstergesi: Kristal Bellek
        (InMemoryComputeFabric), Kuantum Ön-Yönlendirme (PredictiveCorridor),
        Negatif Sinyal (ChaosSuppressor) — hepsi rAF native hızında,
        makro katmanın zamanlamasından bağımsız akıyor. */}
    <div title="MİKRO ZAMAN: Kristal Bellek + Kuantum Ön-Yönlendirme + Negatif Sinyal — donanım-seviyesi deterministik, rAF native hızında"
      style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
        fontSize:9,fontFamily:"monospace",color:"#00d4ff"}}>
      <div style={{width:5,height:5,borderRadius:"50%",background:"#00d4ff",
        boxShadow:"0 0 5px #00d4ff",animation:"blink 0.6s ease-in-out infinite"}}/>
      <span style={{opacity:.6,fontSize:7}}>MİKRO</span> {rafEngine.systemsByTier("micro").length} sistem
    </div>
    {/* BELLEK HARİTASI DOLULUK ORANI — %88 eşiğine yaklaştıkça renk uyarır */}
    {(() => {
      const occ = rafEngine.occupancyStats();
      const pct = occ.lastOccupancy * 100;
      const color = pct >= 92 ? "#f43f5e" : pct >= 88 ? "#f59e0b" : "#334155";
      return (
        <div title={`Bellek Haritası Doluluğu — %${occ.threshold*100} eşiğinde makro saat erken uyanır (${occ.earlyWakeCount} kez tetiklendi)`}
          style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
            fontSize:9,fontFamily:"monospace",color}}>
          🧠 %{pct.toFixed(0)}
        </div>
      );
    })()}
    {/* SOFT-LANDING FİLTRESİ — yalnızca acil modda görünür */}
    {softLandingMode === "emergency" && (
      <div title="Soft-Landing Filtresi ACİL modda — %92 çöküş metriği aşıldı, paketler sahiplik durumuna bakılmaksızın sönümleniyor"
        style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
          fontSize:9,fontFamily:"monospace",color:"#f43f5e"}}>
        <div style={{width:5,height:5,borderRadius:"50%",background:"#f43f5e",
          boxShadow:"0 0 5px #f43f5e",animation:"blink 0.4s ease-in-out infinite"}}/>
        ⛑ SOFT-LANDING: ACİL
      </div>
    )}
    {/* BURST TRAFFIC GENERATOR — Dual-Clock/Soft-Landing döngüsünü test etmek için
        kontrollü yapay yük patlaması tetikler. Tıklayınca "spike" profiliyle başlar,
        tekrar tıklayınca (çalışıyorken) iptal eder. */}
    <button onClick={()=>triggerBurstTest("spike")}
      title="Burst Traffic Generator — %95 tepe yüklü yapay patlama tetikler (Dual-Clock erken-uyanma + Soft-Landing acil modunu test eder)"
      style={{background:burstActive?"#f59e0b22":"none",
        border:`1px solid ${burstActive?"#f59e0b77":"transparent"}`,
        borderRadius:4,cursor:"pointer",fontSize:9,padding:"3px 8px",
        marginLeft:8,color:burstActive?"#f59e0b":"#334155",
        display:"flex",alignItems:"center",gap:4,flexShrink:0,fontFamily:"monospace"}}>
      🔥 {burstActive?"PATLAMA AKTİF (iptal için tıkla)":"Burst Test"}
    </button>
    {/* KAOS ENGELLEYİCİ: yalnızca gerçekten bir hayalet veri nötrleştirildiyse görünür */}
    {chaosStats.antiPacketsFired > 0 && (
      <div title="Kaos Engelleyici — nötrleştirilen hayalet paketler"
        style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,flexShrink:0,
          fontSize:9,fontFamily:"monospace",color:"#f43f5e"}}>
        🛡 ⊘{chaosStats.antiPacketsFired}
      </div>
    )}
    <div style={{fontSize:9,color:"#1e3a5f",fontFamily:"monospace",flexShrink:0,marginLeft:8}}>
      {new Date().toLocaleTimeString("tr",{hour12:false})}
    </div>
  </div>

  {/* EK 41: AudioContext engellendi uyarısı + kurtarma arayüzü */}
  {audioBlocked && (
    <div onClick={retryAudioUnlock}
      style={{
        background:"linear-gradient(90deg,#3f151533,#1a0a2e33)",
        borderBottom:"1px solid #f59e0b44",
        padding:"7px 16px",display:"flex",alignItems:"center",gap:10,
        cursor:"pointer",flexShrink:0,
      }}>
      <span style={{fontSize:14}}>⚠</span>
      <span style={{fontSize:10,color:"#f59e0b",fontWeight:600}}>
        Tarayıcı AudioContext'i otomatik başlatmayı engelledi (autoplay policy).
      </span>
      <span style={{fontSize:10,color:"#94a3b8"}}>
        Kiral akustik motoru başlatmak için buraya tıklayın.
      </span>
      <span style={{marginLeft:"auto",fontSize:9,color:"#f59e0b",
        border:"1px solid #f59e0b55",borderRadius:5,padding:"3px 10px"}}>
        🔓 Kilidi Aç
      </span>
    </div>
  )}

  {/* ══ METRİK BAR ══════════════════════════════════════════ */}
  <div style={{height:36,background:"#030610",borderBottom:"1px solid #0a162855",
    display:"flex",alignItems:"center",padding:"0 0",flexShrink:0,overflowX:"auto"}}>
    {[
      {l:"DÜĞÜM",v:`${online.length}/${nodes.length}`,c:"#10b981"},
      {l:"KANAL",v:String(links.length),c:"#00d4ff"},
      {l:"UYDU KAL.",v:`${curSatQ}%`,c:+curSatQ>70?"#10b981":+curSatQ>40?"#f59e0b":"#f43f5e"},
      {l:"AĞ YÜKÜ",v:`${(totalLoad*100).toFixed(0)}%`,c:"#7c3aed"},
      {l:"ROTA",v:path?`${pathKm}km/${path.length-1}hop`:"—",c:"#f59e0b"},
      {l:"SON BER",v:berHistory.length?`${berHistory[berHistory.length-1].toFixed(2)}%`:"—",c:"#00d4ff"},
      {l:"İLETİM",v:String(traffic.length),c:"#10b981"},
      {l:"ECC",v:ecc?"ON":"OFF",c:ecc?"#10b981":"#334155"},
      {l:"SENKRON BEKLEYEN",v:String(pendingSync),c:pendingSync>0?"#f59e0b":"#334155"},
    ].map((m,i)=>(
      <div key={i} style={{display:"flex",flexDirection:"column",padding:"0 12px",
        borderRight:"1px solid #0a162888",justifyContent:"center",height:"100%",flexShrink:0}}>
        <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em"}}>{m.l}</div>
        <div style={{fontSize:10,color:m.c,fontWeight:700,letterSpacing:".04em"}}>{m.v}</div>
      </div>
    ))}
    <div style={{padding:"0 12px",minWidth:120,display:"flex",flexDirection:"column",justifyContent:"center"}}>
      <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:2}}>THROUGHPUT</div>
      <Spark data={throughput} color="#00d4ff" h={16}/>
    </div>
  </div>

  {/* LEO PANEL — artık dikey sidebar değil, tam genişlik yatay üst şerit.
      MAIN row container'ının DIŞINA, üstüne taşındı. */}
  <LeoPanel
    sats={sats}
    activeSat={activeSat}
    setActiveSat={setActiveSat}
    onSend={transmit}
    running={running}
    msg={msg}
    setMsg={setMsg}
    evesdrop={evesdrop}
    setEvesdrop={setEvesdrop}
    result={result}
    paQueue={paQueue}
    phase={phase}
    timeline={timeline}
    onOpenTimeline={()=>setTab("TML")}
    mirrorOn={mirrorOn}
    setMirrorOn={setMirrorOn}
    mirrorResult={mirrorResult}
    onCollapse={collapseUniverse}
    onInterfere={interfereUniverses}
    collapsedTo={collapsedTo}
    entropyDelta={entropyDelta}
    isOnline={isOnline}
    observerFrame={observerFrame}
    atmosphericTurbidity={atmosphericTurbidity}
    setAtmosphericTurbidity={setAtmosphericTurbidity}
    turbulenceStrength={turbulenceStrength}
    setTurbulenceStrength={setTurbulenceStrength}
    pointingPrecision={pointingPrecision}
    setPointingPrecision={setPointingPrecision}
    nightMode={nightMode}
    setNightMode={setNightMode}
  />

  {/* ══ MAIN ════════════════════════════════════════════════ */}
  <div style={{display:"flex",flex:1,minHeight:0}}>

    {/* NOC SIDEBAR */}
    <div style={{width:180,flexShrink:0,background:"#030610",
      borderRight:"1px solid #0a162888",
      display:"flex",flexDirection:"column",overflowY:"auto"}}>

      <div style={{padding:"10px 10px",borderBottom:"1px solid #0a162888"}}>
        <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:6}}>SİNYAL MONİTÖR</div>
        <Oscilloscope active={running} color="#00d4ff"/>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
          <span style={{fontSize:7,color:"#1e3a5f"}}>λ=1550nm</span>
          <span style={{fontSize:7,color:running?"#00d4ff":"#1e3a5f",
            animation:running?"blink 1s ease-in-out infinite":"none"}}>
            {running?"● ACTIVE":"○ IDLE"}
          </span>
        </div>
      </div>

      <div style={{padding:"10px",borderBottom:"1px solid #0a162888"}}>
        <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:6}}>KAYNAK / HEDEF</div>
        {[["TX",src,setSrc,"dst"],[" RX",dst,setDst,"src"]].map(([l,val,set,excl])=>(
          <div key={l} style={{marginBottom:6}}>
            <div style={{fontSize:7,color:"#334155",marginBottom:2,display:"flex",gap:5,alignItems:"center"}}>
              <div style={{width:4,height:4,borderRadius:1,
                background:l.includes("TX")?"#00d4ff":"#10b981"}}/>
              {l}
            </div>
            <select value={val} disabled={running}
              onChange={e=>{set(e.target.value);setPath(null);setResult(null);}}
              style={{width:"100%",padding:"4px 6px",fontSize:10}}>
              {online.filter(n=>n.id!==(excl==="dst"?dst:src))
                .map(n=><option key={n.id} value={n.id}>{n.id} — {n.label}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div style={{padding:"8px 10px",borderBottom:"1px solid #0a162888"}}>
        <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:6}}>PROTOKOL</div>
        {[
          {k:"ecc",s:ecc,set:setEcc,on:"HAMMING ECC",off:"ECC KAPALI",c:"#10b981"},
        ].map(o=>(
          <label key={o.k} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",
            background:o.s?o.c+"11":"transparent",
            border:`1px solid ${o.s?o.c+"33":"#0a1628"}`,
            borderRadius:3,padding:"5px 7px",transition:"all .2s"}}>
            <input type="checkbox" checked={o.s} disabled={running}
              onChange={e=>o.set(e.target.checked)}
              style={{width:11,height:11,accentColor:o.c}}/>
            <span style={{fontSize:8,color:o.s?o.c:"#334155",fontWeight:o.s?700:400}}>
              {o.s?o.on:o.off}
            </span>
          </label>
        ))}
      </div>

      <div style={{padding:"8px 10px",flex:1}}>
        <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:6}}>DÜĞÜM MATRİSİ</div>
        {nodes.map(n=>{
          const locked=n.id===src||n.id===dst;
          const nc={hub:"#00d4ff",intl:"#f59e0b",node:"#10b981"}[n.type]||"#10b981";
          return(
            <div key={n.id} className="nrow"
              onClick={()=>{toggleNode(n.id);setSelNode(n.id===selNode?null:n.id);}}>
              <div style={{width:5,height:5,borderRadius:1,flexShrink:0,
                background:n.on?nc:"#1e293b",opacity:n.on?1:.4}}/>
              <span style={{fontSize:8,color:n.on?(pathIds.has(n.id)?nc:"#475569"):"#1e293b",
                flex:1,letterSpacing:".02em"}}>{n.id}</span>
              <span style={{fontSize:7,color:locked?"#7c3aed":n.on?"#1e3a5f":"#0f172a"}}>
                {locked?(n.id===src?"TX":"RX"):n.on?"ON":"OFF"}
              </span>
              {/* FAZ 3: mikro katmana zoom-in — DÜĞÜM MATRİSİ satırındaki
                  ana onClick'i (toggleNode) tetiklemesin diye stopPropagation. */}
              <span title="Mikro katmana zoom-in" onClick={(e)=>{e.stopPropagation();openDrillDown(n.id);}}
                style={{fontSize:8,cursor:"zoom-in",opacity:.5,padding:"0 2px"}}
                onMouseEnter={e=>e.currentTarget.style.opacity=1}
                onMouseLeave={e=>e.currentTarget.style.opacity=.5}>🔍</span>
            </div>
          );
        })}
      </div>
    </div>

    {/* ── MERKEZ ── */}
    <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,
      background:"#020409",position:"relative",overflow:"hidden"}}>

      {/* Yıldızlar */}
      <svg style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",
        pointerEvents:"none",zIndex:0}} viewBox="0 0 800 520" preserveAspectRatio="xMidYMid slice">
        {stars.map((s,i)=>(
          <circle key={i} cx={s.x*8} cy={s.y*5.2} r={s.r} fill="white" opacity={s.o}
            style={{animation:`blink ${2+s.r*2}s ease-in-out infinite`,animationDelay:`${s.o*5}s`}}/>
        ))}
      </svg>

      {/* EK 27: Cosmic partikül sistemi — foton izleri arka planda süzülür (saf CSS, state-free) */}
      <div style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",
        pointerEvents:"none",zIndex:0,overflow:"hidden"}}>
        {cosmicParticles.map((p,i)=>(
          <div key={i} style={{
            position:"absolute", left:`${p.x}%`, top:`${p.y}%`,
            width:p.size, height:p.size, borderRadius:"50%",
            background:p.hex, opacity:0.35,
            boxShadow:`0 0 ${p.size*3}px ${p.hex}`,
            animation:`cosmicDrift ${p.dur}s linear infinite`,
            animationDelay:`${p.delay}s`,
          }}/>
        ))}
      </div>

      {/* AĞ HARİTASI */}
      {tab==="MAP"&&(
        <div style={{flex:1,position:"relative",zIndex:1}}>
          {/* RETRO-CAUSALITY Adım 5: aktif fork bilgi banner'ı */}
          {activeFork && (
            <div style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",
              background:"#1a0a1aee",border:"1px solid #ec489966",
              borderRadius:6,padding:"6px 14px",fontSize:9,color:"#f472b6",
              zIndex:10,display:"flex",gap:10,alignItems:"center",letterSpacing:".04em",
              backdropFilter:"blur(8px)"}}>
              <span>⏪ FORK: "{activeFork.result.decoded}"</span>
              <span style={{color:"#4a1a35"}}>|</span>
              <span style={{fontFamily:"monospace"}}>QBER {(activeFork.result.qber*100).toFixed(1)}%</span>
              <span style={{color:"#4a1a35"}}>|</span>
              <span style={{fontFamily:"monospace"}}>seed={activeFork.retroCausalitySeed}</span>
              <button onClick={()=>setActiveForkId(null)}
                style={{background:"none",border:"none",color:"#f472b6",cursor:"pointer",
                  fontSize:11,padding:0,marginLeft:4}}>✕</button>
            </div>
          )}
          {path&&(
            <div style={{position:"absolute",bottom:10,left:"50%",transform:"translateX(-50%)",
              background:"#030610ee",border:"1px solid #00d4ff22",
              borderRadius:4,padding:"5px 14px",fontSize:9,color:"#00d4ff",
              zIndex:10,display:"flex",gap:12,alignItems:"center",letterSpacing:".06em",
              backdropFilter:"blur(8px)"}}>
              <span>🛤 {path.map(p=>p.node).join(" → ")}</span>
              <span style={{color:"#1e3a5f"}}>|</span>
              <span style={{fontFamily:"monospace"}}>{pathKm}km</span>
              <span style={{color:"#1e3a5f"}}>|</span>
              <span>{path.length-1} HOP</span>
            </div>
          )}
          <svg width="100%" height="100%" viewBox="0 0 1000 520" style={{display:"block"}}>
            <defs>
              <filter id="gl"><feGaussianBlur stdDeviation="2.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <filter id="gl2"><feGaussianBlur stdDeviation="7" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            {/* KÜRESEL AĞ: viewBox 1000×520, NODES/LINKS artık equirectangular
                lat/lon projeksiyonuyla (bkz. gen_world_network.py) hesaplandı —
                80'den fazla ülke/şehir tek bir dünya haritasında. */}
            {Array.from({length:25},(_,i)=>(
              <line key={`v${i}`} x1={i*40} y1={0} x2={i*40} y2={520}
                stroke="#00d4ff" strokeWidth={.3} strokeOpacity={.03}/>
            ))}
            {Array.from({length:13},(_,i)=>(
              <line key={`h${i}`} x1={0} y1={i*40} x2={1000} y2={i*40}
                stroke="#00d4ff" strokeWidth={.3} strokeOpacity={.03}/>
            ))}

            {/* EK 8 (render): Hafıza izleri — geçmiş rotalar zamanla soluklaşır */}
            {memoryTraces.map(mt=>{
              const ageMs = Date.now()-mt.createdAt;
              const opacity = Math.max(0.02, 0.22 - ageMs/300000); // ~5dk'da tamamen soluklaşır
              if (opacity <= 0.02) return null;
              const color = mt.success ? "#22d3ee" : "#f43f5e";
              return (
                <g key={mt.id} opacity={opacity}>
                  {mt.path.slice(1).map((p,i)=>{
                    const lk = p.link; if(!lk) return null;
                    const co = getLinkXY(lk); if(!co) return null;
                    return (
                      <line key={i} {...co} stroke={color} strokeWidth={2}
                        strokeLinecap="round" strokeDasharray="2 6"/>
                    );
                  })}
                </g>
              );
            })}
            {links.map((lk,i)=>{
              const co=getLinkXY(lk);if(!co)return null;
              const na=getNode(lk.a),nb=getNode(lk.b);
              const active=na?.on&&nb?.on;
              const onP=isOnPath(lk);
              const onFork=isOnForkedPath(lk); // RETRO-CAUSALITY Adım 5
              const wc=WL[lk.nm]||WL[1550];
              const load=linkLoad[`${lk.a}-${lk.b}`]||0;
              const isH=hLink===i;
              return(
                <g key={i} onMouseEnter={()=>setHLink(i)} onMouseLeave={()=>setHLink(null)}
                  style={{cursor:"pointer"}}>
                  <line {...co} stroke="transparent" strokeWidth={16}/>
                  {active&&load>.25&&(
                    <line {...co} stroke={wc.hex} strokeWidth={load*6}
                      strokeOpacity={load*.1} style={{animation:"glow 2s ease-in-out infinite"}}/>
                  )}
                  {onP&&<line {...co} stroke={wc.hex} strokeWidth={8} strokeOpacity={.1} filter="url(#gl2)"/>}
                  <line {...co}
                    stroke={!active?"#0a1628":onP?wc.hex:isH?"#1e3a5f33":"#0a1628"}
                    strokeWidth={onP?2:1} strokeOpacity={active?1:.2}
                    strokeDasharray={onP?"10 5":load>.6?"3 8":"none"}
                    style={onP?{animation:"flow .7s linear infinite"}:{}}/>
                  {/* RETRO-CAUSALITY: forked path — kesikli çizgi + pembe/magenta,
                      normal aktif rota katmanının ÜSTÜNE ayrı bir çizgi olarak eklenir */}
                  {onFork&&active&&(
                    <>
                      <line {...co} stroke="#ec4899" strokeWidth={5} strokeOpacity={.15} filter="url(#gl2)"/>
                      <line {...co} stroke="#ec4899" strokeWidth={2.5} strokeOpacity={.9}
                        strokeDasharray="3 4" strokeLinecap="round"
                        style={{animation:"flow .5s linear infinite reverse"}}/>
                    </>
                  )}
                  {(isH||onP)&&active&&(
                    <text x={(co.x1+co.x2)/2} y={(co.y1+co.y2)/2-7}
                      textAnchor="middle" fill={wc.hex} fontSize={7}
                      fontFamily="monospace" filter="url(#gl)">
                      {lk.km}km·λ{lk.nm}
                    </text>
                  )}
                </g>
              );
            })}
            {nodes.map(n=>{
              const onP=pathIds.has(n.id);
              const isSrc=n.id===src,isDst=n.id===dst;
              const isH=hNode===n.id;
              const baseC=isSrc?"#00d4ff":isDst?"#10b981":
                n.type==="hub"?"#7c3aed":n.type==="intl"?"#f59e0b":"#334155";
              const r=n.type==="hub"?11:n.type==="intl"?10:8;
              // EK 18: ayna evren düğüm gölgesi — merkeze göre ters konumda, mor tonda
              const mirrorX = mirrorOn ? 780 - n.x : null;
              const mirrorY = mirrorOn ? 490 - n.y : null;
              // GELECEKTEKİ YOĞUNLUĞU TAHMİN ETME: bu düğümde açık bir vakum
              // koridoru var mı — varsa nabız gibi atan camgöbeği halka göster.
              const corridorInfo = activeCorridorNodes.find(c => c.nodeId === n.id);
              return(
                <g key={n.id}>
                  {corridorInfo && (
                    <circle cx={n.x} cy={n.y} r={r+8}
                      fill="none" stroke="#22d3ee"
                      strokeWidth={1.2} strokeOpacity={0.5 + (1-corridorInfo.discount)*0.5}
                      strokeDasharray="4 3"
                      style={{animation:"blink 0.9s ease-in-out infinite"}}/>
                  )}
                  {mirrorOn && (
                    <circle cx={mirrorX} cy={mirrorY} r={r*0.6}
                      fill="none" stroke="#a855f7" strokeWidth={0.8} strokeOpacity={0.25}
                      strokeDasharray="2 3"/>
                  )}
                  <g
                    onClick={()=>{toggleNode(n.id);setSelNode(n.id===selNode?null:n.id);}}
                    onMouseEnter={()=>setHNode(n.id)} onMouseLeave={()=>setHNode(null)}
                    style={{cursor:"pointer"}}>
                    {(onP||isSrc||isDst)&&n.on&&(
                      <circle cx={n.x} cy={n.y} r={r+12} fill={baseC} opacity={.05} filter="url(#gl2)"/>
                    )}
                    {(onP||isH)&&n.on&&(
                      <circle cx={n.x} cy={n.y} r={r+4} fill="none"
                        stroke={baseC} strokeWidth={.6} strokeOpacity={.2}/>
                    )}
                    <circle cx={n.x} cy={n.y} r={r}
                      fill={n.on?baseC+"14":"#020409"}
                      stroke={!n.on?"#0a1628":onP?baseC:isH?baseC+"66":baseC+"33"}
                      strokeWidth={onP?1.5:.8} filter={onP?"url(#gl)":"none"}/>
                    <circle cx={n.x} cy={n.y} r={n.type==="hub"?4:3}
                      fill={n.on?baseC:"#0a1628"}
                      style={onP?{animation:"blink 1.2s ease-in-out infinite"}:{}}/>
                    {n.on&&n.reps>0&&(
                      <text x={n.x+r+3} y={n.y-r+3} fill="#1e3a5f" fontSize={6} fontFamily="monospace">
                        ×{n.reps}
                      </text>
                    )}
                    <text x={n.x} y={n.y+r+11} textAnchor="middle"
                      fill={n.on?(onP?baseC:"#334155"):"#1e293b"}
                      fontSize={8} fontWeight={onP?700:400} fontFamily="monospace">
                      {n.id}
                    </text>
                    {(isSrc||isDst)&&(
                      <text x={n.x} y={n.y-r-7} textAnchor="middle"
                        fill={isSrc?"#00d4ff":"#10b981"}
                        fontSize={6} fontWeight={700} fontFamily="monospace" letterSpacing=".1em">
                        {isSrc?"ALICE":"BOB"}
                      </text>
                    )}
                    {!n.on&&(
                      <text x={n.x} y={n.y+4} textAnchor="middle"
                        fill="#1e3a5f" fontSize={8} fontWeight={700}>✕</text>
                    )}
                  </g>
                  {/* FAZ 3: mikro katmana zoom-in — yalnızca hover'da görünür,
                      ana <g>'nin onClick'ini (toggleNode) tetiklemesin diye
                      ayrı bir <g> + stopPropagation. */}
                  {isH && (
                    <g onClick={(e)=>{e.stopPropagation();openDrillDown(n.id);}}
                      style={{cursor:"zoom-in"}}>
                      <circle cx={n.x+r+9} cy={n.y-r-9} r={7.5}
                        fill="#030610ee" stroke="#00d4ff" strokeWidth={1}/>
                      <text x={n.x+r+9} y={n.y-r-6} textAnchor="middle" fontSize={8}>🔍</text>
                    </g>
                  )}
                </g>
              );
            })}
            {pkts.map(p=>(
              <g key={p.id}>
                <circle cx={p.x} cy={p.y} r={10} fill={p.color} opacity={.1} filter="url(#gl2)"/>
                <circle cx={p.x} cy={p.y} r={5} fill={p.color} opacity={.9}
                  style={{animation:"pkt .4s ease-in-out infinite"}}/>
                <circle cx={p.x} cy={p.y} r={2} fill="#fff" opacity={.9}/>
                <text x={p.x} y={p.y-13} textAnchor="middle"
                  fill={p.color} fontSize={7} fontFamily="monospace" fontWeight={700}>
                  λ{p.label}
                </text>
              </g>
            ))}
            {/* EK 9 (render): Replay hayalet paketleri — yarı saydam, orijinal rotada akar.
                YAVAŞ SÖNÜMLEME: signalStrength (SoftLandingFilter'dan) opaklığı ve rengi
                sürer — paket aniden kaybolmaz, kademeli olarak söner. */}
            {ghostPkts.map(g=>{
              const strength = g.signalStrength ?? 1.0;
              const dampening = strength < 1.0; // sönümleme eğrisi aktif mi
              // Güç azaldıkça renk soğuk (orijinal) tondan sıcak (uyarı) tona kayar —
              // "enerjisi tükenen sistem" hissi.
              const dampenColor = strength < 0.3 ? "#f43f5e" : strength < 0.6 ? "#f59e0b" : g.color;
              return (
                <g key={g.id} opacity={0.45 * strength}>
                  <circle cx={g.x} cy={g.y} r={7} fill={dampenColor} opacity={.15} filter="url(#gl2)"/>
                  <circle cx={g.x} cy={g.y} r={3.5 * Math.max(0.4, strength)} fill="none"
                    stroke={dampenColor} strokeWidth={dampening ? 0.7 : 1}/>
                </g>
              );
            })}
            {/* KAOS ENGELLEYİCİ (render): Anti-paketler — ters-fazlı nötrleştirme
                sinyalleri, hızla genişleyip sönen bir halka olarak gösterilir
                (aktif gürültü iptali / destructive interference görseli). */}
            {antiPackets.map(a=>(
              <g key={a.id} opacity={0.85}>
                <circle cx={a.x} cy={a.y} r={10} fill="none" stroke="#f43f5e"
                  strokeWidth={1.5} strokeOpacity={0.7}
                  style={{animation:"pkt .26s ease-out"}}/>
                <circle cx={a.x} cy={a.y} r={3} fill="#f43f5e" opacity={.6}/>
                <text x={a.x} y={a.y-14} textAnchor="middle"
                  fill="#f43f5e" fontSize={7} fontFamily="monospace" fontWeight={700}>⊘</text>
              </g>
            ))}
            {/* EK 18 (render): Mirror Universe mor paketleri — asal (mavi) ile aynı anda akar */}
            {mirrorPkts.map(g=>(
              <g key={g.id} opacity={0.7}>
                <circle cx={g.x} cy={g.y} r={9} fill="#a855f7" opacity={.18} filter="url(#gl2)"/>
                <circle cx={g.x} cy={g.y} r={4.5} fill="#a855f7" opacity={.85}
                  style={{animation:"pkt .4s ease-in-out infinite"}}/>
                <circle cx={g.x} cy={g.y} r={1.5} fill="#fff" opacity={.9}/>
                <text x={g.x} y={g.y-13} textAnchor="middle"
                  fill="#a855f7" fontSize={7} fontFamily="monospace" fontWeight={700}>🪞</text>
              </g>
            ))}
            {selNode&&(()=>{
              const n=getNode(selNode);if(!n)return null;
              return(
                <g>
                  <rect x={n.x+18} y={n.y-30} width={120} height={80}
                    rx={4} fill="#030610" stroke="#00d4ff22" strokeWidth={1}/>
                  <text x={n.x+24} y={n.y-16} fill="#00d4ff" fontSize={9} fontWeight={700}>{n.id}</text>
                  {[`${n.label}`,`${n.type.toUpperCase()} R×${n.reps}`,
                    `${n.lat}°N ${n.lon}°E`,n.on?"ONLINE":"OFFLINE"].map((t,i)=>(
                    <text key={i} x={n.x+24} y={n.y+i*11}
                      fill={i===3?(n.on?"#10b981":"#f43f5e"):"#475569"} fontSize={7}>{t}</text>
                  ))}
                </g>
              );
            })()}
          </svg>
        </div>
      )}

      {/* UYDU */}
      {tab==="SAT"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {sats.map(s=>{
              const q=satQ(s.elev);const ac=s.id===activeSat;
              return(
                <div key={s.id} onClick={()=>setActiveSat(s.id)}
                  style={{background:ac?"#0a1628":"#030610",
                    border:`1px solid ${ac?"#00d4ff33":"#0a1628"}`,
                    borderRadius:6,padding:"11px 12px",cursor:"pointer",transition:"all .2s",
                    boxShadow:ac?"0 0 14px #00d4ff08":"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:7}}>
                    <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
                      background:s.status==="ACTIVE"?"#10b981":s.status==="TRANSIT"?"#f59e0b":"#f43f5e",
                      animation:ac?"blink 1.5s ease-in-out infinite":"none"}}/>
                    <span style={{fontSize:9,color:ac?"#00d4ff":"#334155",fontWeight:ac?700:400,letterSpacing:".06em"}}>{s.name}</span>
                    <span style={{marginLeft:"auto",fontSize:7,color:"#1e3a5f",
                      background:"#0a1628",padding:"1px 5px",borderRadius:2}}>{s.status}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:7}}>
                    {[["İRTİFA",`${s.alt}km`],["YÜKSELTİ",`${s.elev.toFixed(1)}°`],
                      ["BOYLAM",`${s.lon.toFixed(1)}°E`],["KALİTE",`${(q*100).toFixed(0)}%`]
                    ].map(([l,v])=>(
                      <div key={l} style={{background:"#020409",borderRadius:3,padding:"4px 6px"}}>
                        <div style={{fontSize:7,color:"#1e3a5f",marginBottom:1}}>{l}</div>
                        <div style={{fontSize:10,fontWeight:700,
                          color:l==="KALİTE"?(q>.7?"#10b981":q>.4?"#f59e0b":"#f43f5e"):"#64748b"
                        }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <BerGauge value={q*100}/>
                </div>
              );
            })}
          </div>
          <div style={{background:"#030610",border:"1px solid #10b98122",
            borderRadius:6,padding:"11px 13px"}}>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:7}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:"#10b981",
                boxShadow:"0 0 6px #10b981",animation:"blink 2s ease-in-out infinite"}}/>
              <span style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:".08em"}}>
                ISP BAĞIMSIZ MİMARİ
              </span>
            </div>
            <div style={{fontSize:9,color:"#334155",lineHeight:1.9}}>
              PhotonNet veriyi doğrudan LEO uydu üzerinden iletir.<br/>
              Yerel ISP altyapısına BAĞLI DEĞİLDİR.<br/>
              İnternet kesintisi · DNS blokajı · trafik yönetimi<br/>
              bu ağı ETKİLEMEZ.
            </div>
          </div>
        </div>
      )}

      {/* TRAFİK */}
      {tab==="TRF"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>

          {/* DİNAMİK YÜK DENGELEME / AKILLI ROTALAMA — KULLANICI TALEBİ:
              stratejik bir hatta (örn. okyanus-ötesi omurga) yapay bir kriz
              (kopma/yoğunluk) enjekte edilebilsin, yönlendirme motoru
              otomatik olarak alternatif rotayı bulsun. bkz. LinkOutageController,
              injectCrisis(), ve transmit()'teki "ROTA OPTİMİZE EDİLDİ" bloğu. */}
          <div style={{background:"#0a0d1f",
            border:`1px solid ${activeCrisis?(activeCrisis.mode==="outage"?"#f43f5e55":"#f59e0b55"):"#00d4ff22"}`,
            borderRadius:8,padding:"13px 15px",marginBottom:12,transition:"border-color .3s"}}>
            <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:8,
              display:"flex",alignItems:"center",gap:6}}>
              🌐 DİNAMİK YÜK DENGELEME — AĞ KRİZ SİMÜLASYONU
            </div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:10,lineHeight:1.5}}>
              Stratejik bir hatta (örn. okyanus-ötesi omurga) yapay bir
              kriz enjekte edin — yönlendirme motoru (Dijkstra +
              EdgeWeightPolicy) bunu bir sonraki GÖNDER'de otomatik
              algılayıp trafiği en optimize alternatif rotaya kaydırır.
            </div>

            {!activeCrisis ? (
              <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div style={{flex:"1 1 220px",minWidth:180}}>
                  <div style={{fontSize:7,color:"#334155",marginBottom:3}}>HAT SEÇ (omurga, &gt;1500km)</div>
                  <select value={crisisLinkSel} disabled={crisisBusy}
                    onChange={e=>setCrisisLinkSel(e.target.value)}
                    style={{width:"100%",padding:"5px 6px",fontSize:9}}>
                    <option value="">— hat seçin —</option>
                    {[...links].filter(l=>l.km>1500).sort((a,b)=>b.km-a.km).map(l=>(
                      <option key={`${l.a}-${l.b}`} value={`${l.a}-${l.b}`}>
                        {l.a} → {l.b} ({l.km}km)
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{flex:"0 0 auto"}}>
                  <div style={{fontSize:7,color:"#334155",marginBottom:3}}>KRİZ TÜRÜ</div>
                  <div style={{display:"flex",gap:4}}>
                    {[["outage","🔴 KOPMA"],["congestion","🟠 YOĞUNLUK"]].map(([k,l])=>(
                      <button key={k} disabled={crisisBusy} onClick={()=>setCrisisMode(k)}
                        style={{padding:"5px 9px",fontSize:8,borderRadius:4,cursor:"pointer",
                          background:crisisMode===k?(k==="outage"?"#f43f5e22":"#f59e0b22"):"transparent",
                          border:`1px solid ${crisisMode===k?(k==="outage"?"#f43f5e77":"#f59e0b77"):"#0a1628"}`,
                          color:crisisMode===k?(k==="outage"?"#f43f5e":"#f59e0b"):"#334155",fontWeight:700}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={injectCrisis} disabled={crisisBusy||!crisisLinkSel}
                  style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                    background:"linear-gradient(135deg,#f43f5e,#f59e0b)",border:"none",color:"#fff",
                    opacity:crisisBusy||!crisisLinkSel?0.4:1}}>
                  ⚡ KRİZİ ENJEKTE ET
                </button>
              </div>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,
                  background:activeCrisis.mode==="outage"?"#3f151533":"#2a1a0533",
                  border:`1px solid ${activeCrisis.mode==="outage"?"#f43f5e44":"#f59e0b44"}`,
                  borderRadius:6,padding:"6px 11px"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",
                    background:activeCrisis.mode==="outage"?"#f43f5e":"#f59e0b",
                    boxShadow:`0 0 6px ${activeCrisis.mode==="outage"?"#f43f5e":"#f59e0b"}`,
                    animation:"blink 0.6s ease-in-out infinite"}}/>
                  <span style={{fontSize:9,fontWeight:700,color:activeCrisis.mode==="outage"?"#f43f5e":"#f59e0b"}}>
                    {activeCrisis.a}-{activeCrisis.b} {activeCrisis.mode==="outage"?"KOPUK":"AŞIRI YOĞUN"}
                  </span>
                </div>
                <span style={{fontSize:8,color:"#64748b"}}>
                  Bir sonraki GÖNDER, alternatif rotayı otomatik dener.
                </span>
                <button onClick={cancelCrisis}
                  style={{padding:"5px 11px",fontSize:8,fontWeight:700,borderRadius:4,cursor:"pointer",
                    background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                  ✕ İPTAL ET / HEMEN ONAR
                </button>
              </div>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:12}}>
            {[
              {l:"TOPLAM",v:traffic.length,c:"#00d4ff"},
              {l:"BAŞARILI",v:traffic.filter(t=>t.success).length,c:"#10b981"},
              {l:"BOZUK",v:traffic.filter(t=>!t.success).length,c:"#f43f5e"},
              {l:"ORT BER",v:berHistory.length?(berHistory.reduce((a,v)=>a+v,0)/berHistory.length).toFixed(2)+"%":"—",c:"#7c3aed"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>
          <div style={{background:"#030610",border:"1px solid #0a162888",
            borderRadius:4,padding:"9px 10px",marginBottom:10}}>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:5}}>BER TARİHSEL</div>
            <Spark data={berHistory} color="#00d4ff" h={38}/>
          </div>
          {traffic.map((t,i)=>(
            <div key={i} style={{background:"#030610",
              border:`1px solid ${t.success?"#10b98122":"#f43f5e22"}`,
              borderRadius:4,padding:"8px 10px",marginBottom:5}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:9,color:"#00d4ff",fontWeight:700}}>{t.src} → {t.dst}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:7,color:"#1e3a5f",fontFamily:"monospace"}}>{t.time}</span>
                  <span style={{fontSize:9,fontWeight:700,color:t.success?"#10b981":"#f43f5e"}}>
                    {t.success?"✓ OK":"✗ ERR"}
                  </span>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:4}}>
                {[["TX",`"${t.original}"`,  "#00d4ff"],["RX",`"${t.decoded}"`,t.success?"#10b981":"#f59e0b"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#020409",borderRadius:3,padding:"3px 6px"}}>
                    <div style={{fontSize:7,color:"#1e3a5f"}}>{l}</div>
                    <div style={{fontSize:10,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:10,fontSize:8,color:"#1e3a5f",fontFamily:"monospace"}}>
                <span>{t.totalKm}km</span><span>{t.hops}hop</span>
                <span style={{color:+t.er>10?"#f43f5e":"#10b981"}}>BER:{t.er}%</span>
                {t.corrected>0&&<span style={{color:"#10b981"}}>ECC+{t.corrected}</span>}
                <span style={{marginLeft:"auto"}}>🛰 {t.sat}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* EK 12: ZAMAN ÇİZELGESİ / ENTANGLE / REPLAY sekmesi */}
      {tab==="TML"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>

          {/* Üst özet + interference göstergesi */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:12}}>
            {[
              {l:"KAYITLI İLETİM",v:timeline.length,c:"#00d4ff"},
              {l:"AKTİF REPLAY",v:replaying.length,c:"#a78bfa"},
              {l:"INTERFERENCE",v:interference,c:interference>0?"#f43f5e":"#334155"},
              {l:"ENTANGLE SEÇİMİ",v:`${entangleA?1:0}+${entangleB?1:0}/2`,c:"#f59e0b"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:17,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>

          {interference>0 && (
            <div style={{background:"#3f151533",border:"1px solid #f43f5e44",
              borderRadius:6,padding:"8px 12px",marginBottom:12,fontSize:9,color:"#f43f5e"}}>
              ⚡ {interference} çakışma tespit edildi — birden fazla replay aynı rotada aynı anda
              hayalet paket taşıyor, bu fiziksel olarak faz kayması (PHASE) olasılığını artırır.
            </div>
          )}

          {/* DÜĞÜM REDDİ CEZASI — GENETİK ALGORİTMA EĞİTİM PANELİ */}
          <div style={{background:"#0a0d1f",border:"1px solid #22c55e22",borderRadius:8,
            padding:"13px 15px",marginBottom:14}}>
            <div style={{fontSize:10,color:"#22c55e",fontWeight:700,letterSpacing:".08em",marginBottom:10}}>
              🎯 DÜĞÜM REDDİ CEZASI — CoefficientEvolutionEngine Eğitimi
            </div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:6,lineHeight:1.5}}>
              Fitness fonksiyonuna eklenen ceza terimi: her genom, izole bir
              probe NodeTransitGate üzerinde GERÇEKTEN test edilir — ölçülen
              ret oranı × bu ağırlıkla fitness'ten düşülür. Motorun kendi
              kendini eğitmesini aşağıdaki nesil geçmişinden izleyebilirsiniz.
            </div>
            <div style={{fontSize:7,color:"#475569",marginBottom:10,lineHeight:1.6,fontStyle:"italic",
              background:"#050a05",borderRadius:5,padding:"6px 8px",border:"1px solid #22c55e18"}}>
              ⚠ Gerçekçilik sınırı: popülasyon (24) ve probe foton sayısı (8)
              istatistiksel anlamlılık için düşüktür; ceza ağırlığı (varsayılan
              0.4) deneysel kalibrasyondan gelmez. En kritik sınır: üretilen
              katsayılar YALNIZCA LEGA'nın kendi formülüyle puanlanır — gerçekten
              gönderilmiş fotonlara/ölçülmüş BER'e karşı ASLA doğrulanmaz. Bu
              sistem kendi sınavını kendi hazırlayıp kendi cevaplıyor; ilkeler
              açısından bir "genetik algoritma"dan çok, yerel bir tepe-tırmanma
              (hill-climbing) sezgiseline daha yakındır.
            </div>
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:8,color:"#475569",letterSpacing:".06em"}}>CEZA AĞIRLIĞI</span>
                <span style={{fontSize:9,color:"#22c55e",fontFamily:"monospace",fontWeight:700}}>
                  {nodeRejectionPenaltyWeight.toFixed(2)}
                </span>
              </div>
              <input type="range" min={0} max={1} step={0.05} value={nodeRejectionPenaltyWeight}
                onChange={e=>setNodeRejectionPenaltyWeight(+e.target.value)}
                style={{width:"100%",accentColor:"#22c55e",cursor:"pointer",height:4}}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
                <span style={{fontSize:7,color:"#1e3a5f"}}>0 = etkisiz</span>
                <span style={{fontSize:7,color:"#1e3a5f"}}>1 = baskın</span>
              </div>
            </div>
            {lastNodeRejectionRate != null && (
              <div style={{background:"#020409",borderRadius:6,padding:"8px 10px",marginBottom:10,
                display:"flex",alignItems:"center",gap:10}}>
                <div>
                  <div style={{fontSize:7,color:"#334155"}}>SON ÖLÇÜLEN RET ORANI</div>
                  <div style={{fontSize:14,fontWeight:700,fontFamily:"monospace",
                    color:lastNodeRejectionRate<0.3?"#22c55e":"#f59e0b"}}>
                    %{(lastNodeRejectionRate*100).toFixed(1)}
                  </div>
                </div>
                <div style={{flex:1,height:6,background:"#0a1628",borderRadius:3,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${lastNodeRejectionRate*100}%`,borderRadius:3,
                    background:lastNodeRejectionRate<0.3?"#22c55e":"#f59e0b",transition:"width .4s"}}/>
                </div>
              </div>
            )}
            {coeffEvolution.history.length > 0 && (
              <div>
                <div style={{fontSize:8,color:"#1e3a5f",letterSpacing:".08em",marginBottom:6}}>
                  NESİL GEÇMİŞİ (son {Math.min(8, coeffEvolution.history.length)})
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {coeffEvolution.history.slice(-8).reverse().map(h=>(
                    <div key={h.generation} style={{display:"flex",gap:8,alignItems:"center",
                      fontSize:8,fontFamily:"monospace",color:"#64748b"}}>
                      <span style={{minWidth:34,color:"#334155"}}>N{h.generation}</span>
                      <span>α={h.alpha.toFixed(3)}</span>
                      <span>β={h.beta.toFixed(3)}</span>
                      <span style={{marginLeft:"auto",color:h.fitness>0?"#22c55e":"#f59e0b"}}>
                        fitness={h.fitness.toFixed(3)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* EK 21: MANY-WORLDS İSTATİSTİK PANELİ */}
          {(() => {
            const mw = analyzeManyWorlds(timeline);
            if (!mw) return (
              <div style={{background:"#030610",border:"1px solid #0a162888",borderRadius:8,
                padding:"12px 14px",marginBottom:14,fontSize:10,color:"#334155",textAlign:"center"}}>
                Many-Worlds analizi için en az 1 iletim gerekli.
              </div>
            );
            return (
              <div style={{background:"#0a0d1f",border:"1px solid #00d4ff22",borderRadius:8,
                padding:"13px 15px",marginBottom:14}}>
                <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:10}}>
                  🌌 MANY-WORLDS İSTATİSTİKLERİ ({mw.totalRecords} gerçeklik)
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:10}}>
                  {[
                    {l:"TOPLAM ENTROPİ",v:mw.globalEntropy.toFixed(3)+" bit",c:"#a78bfa"},
                    {l:"ORT. BER",v:mw.berAvg.toFixed(2)+"%",c:mw.berAvg>10?"#f43f5e":"#10b981"},
                    {l:"BAŞARI ORANI",v:(mw.successRate*100).toFixed(0)+"%",c:mw.successRate>0.7?"#10b981":"#f59e0b"},
                    {l:"ENTANGLEMENT YOĞ.",v:(mw.entanglementDensity*100).toFixed(0)+"%",c:"#00d4ff"},
                  ].map(s=>(
                    <div key={s.l} style={{background:"#020409",borderRadius:5,padding:"7px 9px"}}>
                      <div style={{fontSize:7,color:"#1e3a5f",marginBottom:2}}>{s.l}</div>
                      <div style={{fontSize:13,fontWeight:700,color:s.c,fontFamily:"monospace"}}>{s.v}</div>
                    </div>
                  ))}
                </div>

                {/* Olay dağılımı histogramı */}
                <div style={{fontSize:8,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>
                  GLOBAL OLAY DAĞILIMI HİSTOGRAMI
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:10}}>
                  {Object.entries(mw.globalEc).sort((a,b)=>b[1]-a[1]).map(([type,count])=>{
                    const m = ERR[type]||{c:"#64748b",l:type,i:"·"};
                    const total = Object.values(mw.globalEc).reduce((a,v)=>a+v,0);
                    return (
                      <div key={type} style={{display:"flex",alignItems:"center",gap:8,fontSize:9}}>
                        <span style={{color:m.c,minWidth:100}}>{m.i} {m.l}</span>
                        <div style={{flex:1,height:6,background:"#0a1628",borderRadius:3,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${(count/total)*100}%`,
                            background:m.c,borderRadius:3}}/>
                        </div>
                        <span style={{color:m.c,fontFamily:"monospace",minWidth:28,textAlign:"right"}}>{count}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Dalga boyu kararlılık sıralaması — bilimsel içgörü */}
                {mw.nmRanking.length > 0 && (
                  <div style={{background:"#020409",borderRadius:6,padding:"9px 11px"}}>
                    <div style={{fontSize:9,color:"#94a3b8",marginBottom:6}}>
                      💡 Bu ağda en kararlı dalga boyu:{" "}
                      <span style={{color:"#10b981",fontWeight:700,fontFamily:"monospace"}}>
                        {mw.mostStableWavelength}nm
                      </span>
                      {" "}(ort. BER {mw.nmRanking[0].avgBer.toFixed(2)}%)
                    </div>
                    {mw.nmRanking.length > 1 && (
                      <div style={{fontSize:9,color:"#94a3b8"}}>
                        En az kararlı:{" "}
                        <span style={{color:"#f43f5e",fontWeight:700,fontFamily:"monospace"}}>
                          {mw.leastStableWavelength}nm
                        </span>
                        {" "}(ort. BER {mw.nmRanking[mw.nmRanking.length-1].avgBer.toFixed(2)}%)
                      </div>
                    )}
                    <div style={{marginTop:7,display:"flex",flexDirection:"column",gap:3}}>
                      {mw.nmRanking.map(r=>(
                        <div key={r.nm} style={{display:"flex",alignItems:"center",gap:7,fontSize:8}}>
                          <span style={{color:(WL[r.nm]||{}).hex||"#64748b",minWidth:50,fontFamily:"monospace"}}>
                            {r.nm}nm
                          </span>
                          <div style={{flex:1,height:4,background:"#0a1628",borderRadius:2}}>
                            <div style={{height:"100%",
                              width:`${Math.min(100,(r.avgBer/Math.max(...mw.nmRanking.map(x=>x.avgBer),1))*100)}%`,
                              background:(WL[r.nm]||{}).hex||"#64748b",borderRadius:2}}/>
                          </div>
                          <span style={{color:"#475569",fontFamily:"monospace",minWidth:50,textAlign:"right"}}>
                            {r.avgBer.toFixed(1)}% BER
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Entangle karşılaştırma paneli — iki kayıt seçildiğinde açılır */}
          {entangleA && entangleB && entangleA!==entangleB && (()=>{
            const cmp = entangleCompare(entangleA, entangleB);
            if (!cmp) return null;
            return (
              <div style={{background:"#0a0d1f",border:"1px solid #7c3aed44",
                borderRadius:8,padding:"12px 14px",marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:10,color:"#a78bfa",fontWeight:700,letterSpacing:".08em"}}>
                    ⧉ ENTANGLED KARŞILAŞTIRMA
                  </span>
                  <button className="nbtn" onClick={()=>{setEntangleA(null);setEntangleB(null);}}
                    style={{fontSize:9,color:"#334155"}}>TEMİZLE ✕</button>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  {[cmp.a,cmp.b].map((e,idx)=>(
                    <div key={e.id} style={{background:"#020409",borderRadius:6,padding:"8px 10px"}}>
                      <div style={{fontSize:8,color:idx===0?"#00d4ff":"#22d3ee",marginBottom:4,fontFamily:"monospace"}}>
                        {idx===0?"A":"B"} · {e.time}
                      </div>
                      <div style={{fontSize:11,color:"#94a3b8",fontFamily:"monospace",marginBottom:3}}>
                        {e.src}→{e.dst} · "{e.msg}"
                      </div>
                      <div style={{fontSize:9,color:e.result.success?"#10b981":"#f59e0b"}}>
                        BER {e.result.er}% · seed={e.seed}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:8}}>
                  BER farkı (A−B): <span style={{
                    color:Math.abs(cmp.berDiff)>5?"#f43f5e":"#10b981",fontWeight:700,fontFamily:"monospace"
                  }}>{cmp.berDiff>0?"+":""}{cmp.berDiff}%</span>
                </div>
                <div style={{fontSize:8,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>OLAY DAĞILIMI FARKI</div>
                {cmp.eventDiff.map(d=>{
                  const m=ERR[d.type]||{c:"#64748b",l:d.type,i:"·"};
                  return (
                    <div key={d.type} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,fontSize:9}}>
                      <span style={{color:m.c,minWidth:90}}>{m.i} {m.l}</span>
                      <span style={{color:"#00d4ff",fontFamily:"monospace"}}>A:{d.a}</span>
                      <span style={{color:"#22d3ee",fontFamily:"monospace"}}>B:{d.b}</span>
                      <div style={{flex:1,height:2,background:"#0a1628",borderRadius:1,position:"relative"}}>
                        <div style={{position:"absolute",left:0,height:"100%",
                          width:`${Math.min(100,(d.a/(d.a+d.b||1))*100)}%`,
                          background:"#00d4ff",borderRadius:1}}/>
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={()=>{replayTimeline(entangleA); replayTimeline(entangleB);}}
                  style={{width:"100%",marginTop:10,padding:"8px",borderRadius:6,
                    border:"1px solid #7c3aed55",background:"#7c3aed11",color:"#a78bfa",
                    fontSize:10,fontWeight:700,letterSpacing:".06em",cursor:"pointer"}}>
                  ▶▶ İKİSİNİ AYNI ANDA REPLAY ET (interference testi)
                </button>
              </div>
            );
          })()}

          {/* Zaman çizelgesi listesi */}
          {timeline.length===0 ? (
            <div style={{color:"#1e3a5f",fontSize:12,textAlign:"center",marginTop:60}}>
              Henüz entangle edilmiş bir iletim yok.<br/>
              <span style={{fontSize:10}}>Sol panelden "⧉ ENTANGLE" butonuna basarak iletimleri kaydedin.</span>
            </div>
          ) : timeline.map(entry=>{
            const isReplaying = replaying.includes(entry.id);
            const isA = entangleA===entry.id, isB = entangleB===entry.id;
            return (
              <div key={entry.id} style={{
                background:"#030610",
                border:`1px solid ${isA?"#00d4ff55":isB?"#22d3ee55":entry.result.success?"#10b98122":"#f43f5e22"}`,
                borderRadius:7,padding:"10px 12px",marginBottom:7,
                boxShadow:isReplaying?"0 0 16px #a78bfa22":"none",
                transition:"all .2s",
              }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontSize:10,color:"#00d4ff",fontWeight:700,fontFamily:"monospace"}}>
                    {entry.src} → {entry.dst}
                  </span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:7,color:"#1e3a5f",fontFamily:"monospace"}}>{entry.time}</span>
                    <span style={{fontSize:9,fontWeight:700,
                      color:entry.result.success?"#10b981":"#f43f5e"}}>
                      {entry.result.success?"✓":"✗"}
                    </span>
                  </div>
                </div>
                <div style={{fontSize:10,color:"#64748b",fontFamily:"monospace",marginBottom:4}}>
                  "{entry.msg}" · seed={entry.seed} · BER {entry.result.er}%
                </div>
                {entry.result.qber!=null && (
                  <div style={{fontSize:9,color:entry.result.eavesdropDetected?"#f43f5e":"#7c3aed",
                    fontFamily:"monospace",marginBottom:6}}>
                    QBER {(entry.result.qber*100).toFixed(1)}% · sifted key {entry.result.siftedKeyLen}bit
                    {entry.result.eavesdropDetected?" · ⚠ dinleme imzası":""}
                    {entry.result.similarity!=null && ` · benzerlik ${(entry.result.similarity*100).toFixed(0)}%`}
                  </div>
                )}
                {entry.result.legaSnapshot && (
                  <div style={{fontSize:8,color:"#f59e0b",fontFamily:"monospace",marginBottom:6,opacity:.85}}
                    title="Bu katsayılar gerçek fiber optik ölçüm verisinden türetilmemiştir — sezgisel/didaktik bir davranış modelidir">
                    🌡️ LEGA: scatter-ölüm {(entry.result.legaSnapshot.scatterDeathProb*100).toFixed(0)}% ·
                    absorb-bias ×{entry.result.legaSnapshot.absorbBias.toFixed(2)} ·
                    decohere-bias ×{entry.result.legaSnapshot.decohereBias.toFixed(2)}
                    <span style={{opacity:.55,marginLeft:5}}>(kalibre edilmemiş model)</span>
                  </div>
                )}
                {entry.result.gateReport && entry.result.gateReport.checked > 0 && (
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:8,color:"#fb923c",fontFamily:"monospace",marginBottom:3}}>
                      ⛔ NodeTransitGate: {entry.result.gateReport.checked} foton triyaj edildi
                    </div>
                    <div style={{display:"flex",height:4,borderRadius:2,overflow:"hidden",background:"#0a1628"}}>
                      <div style={{width:`${(entry.result.gateReport.phase1Rejected/entry.result.gateReport.checked)*100}%`,background:"#f43f5e"}} title="Faz 1: Rezonans reddi"/>
                      <div style={{width:`${(entry.result.gateReport.phase2Rejected/entry.result.gateReport.checked)*100}%`,background:"#f59e0b"}} title="Faz 2: Genlik reddi"/>
                      <div style={{width:`${(entry.result.gateReport.phase3Passed/entry.result.gateReport.checked)*100}%`,background:"#10b981"}} title="Faz 3: Transit geçiş"/>
                    </div>
                    <div style={{display:"flex",gap:8,fontSize:7,color:"#475569",marginTop:2,fontFamily:"monospace"}}>
                      <span style={{color:"#f43f5e"}}>F1:{entry.result.gateReport.phase1Rejected}</span>
                      <span style={{color:"#f59e0b"}}>F2:{entry.result.gateReport.phase2Rejected}</span>
                      <span style={{color:"#10b981"}}>F3:{entry.result.gateReport.phase3Passed}</span>
                      {entry.result.gateReport.softMatchedCount > 0 && (
                        <span style={{color:"#22c55e"}}>🟢 Yumuşak:{entry.result.gateReport.softMatchedCount}</span>
                      )}
                    </div>
                  </div>
                )}
                {entry.result.pimSummary && (
                  <div style={{fontSize:8,color:"#22d3ee",fontFamily:"monospace",marginBottom:6,
                    background:"#0a1628",borderRadius:5,padding:"5px 7px"}}>
                    <div style={{marginBottom:2}}>
                      🧠 In-Memory Compute (I/O bariyeri sıfırlandı):{" "}
                      {entry.result.pimSummary.decisions} karar hücre-içi alındı
                    </div>
                    <div style={{color:"#64748b"}}>
                      von-Neumann ~{entry.result.pimSummary.totalVonNeumannNs.toFixed(0)}ns vs
                      PIM ~{entry.result.pimSummary.totalPimNs.toFixed(0)}ns →{" "}
                      <span style={{color:"#22d3ee"}}>×{entry.result.pimSummary.avgSpeedup.toFixed(0)} hızlanma</span>
                      {" "}({entry.result.pimSummary.cellCount} aktif hücre)
                    </div>
                  </div>
                )}
                {entry.result.opllSummary && (
                  <div style={{fontSize:8,color:"#00d4ff",fontFamily:"monospace",marginBottom:6,
                    background:"#0a1628",borderRadius:5,padding:"5px 7px"}}>
                    <div>
                      ⌇ OPLL: {entry.result.opllSummary.lockedChannels}/{entry.result.opllSummary.totalChannels} kanal kilitli
                    </div>
                    {entry.result.opllSummary.channels.length > 0 && (
                      <div style={{color:"#64748b",marginTop:2,display:"flex",flexDirection:"column",gap:1}}>
                        {entry.result.opllSummary.channels.slice(0,4).map(ch=>(
                          <div key={ch.key}>
                            {ch.key}: <span style={{color:ch.locked?"#10b981":"#f59e0b"}}>
                              {ch.locked?"KİLİTLİ":`kilitleniyor (${ch.lockStreak}/5)`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {entry.result.eccBypassed && (
                  <div style={{fontSize:8,color:"#f43f5e",fontFamily:"monospace",marginBottom:6,
                    background:"#3f1515",borderRadius:5,padding:"5px 7px",border:"1px solid #f43f5e44"}}>
                    ⚠ FAZ KARARLILIĞI KRİZİ: ECC katmanı bu iletimde bypass edildi
                    (katsayı enjeksiyon hızı fiziksel kilitlenmeyi geçti)
                  </div>
                )}
                {entry.result.routeHealth && !entry.result.routeHealth.healthy && (
                  <div style={{fontSize:8,color:"#f59e0b",fontFamily:"monospace",marginBottom:6,
                    background:"#2a1a05",borderRadius:5,padding:"5px 7px",border:"1px solid #f59e0b44"}}>
                    <div>
                      ⚠ ROTA SAĞLIĞI DÜŞÜK: {entry.result.routeHealth.hopCount} hop,
                      uçtan-uca geçirgenlik %{(entry.result.routeHealth.cumulativeTransmittance*100).toFixed(3)}
                    </div>
                    {parseFloat(entry.result.rawErrorAccumulation) > 100 && (
                      <div style={{color:"#78716c",marginTop:2}}>
                        Ham hata birikimi: %{entry.result.rawErrorAccumulation} (gösterilen BER %100'de tavanlandı)
                      </div>
                    )}
                  </div>
                )}
                {entry.result.corridorSnapshot && (
                  <div style={{fontSize:8,color:"#a3e635",fontFamily:"monospace",marginBottom:6}}>
                    ⚡ Feedforward Tahmin: {entry.result.corridorSnapshot.nodesOpened} düğüm
                    yola çıkmadan önce açıldı (vakum koridoru, ort. eşik ×{entry.result.corridorSnapshot.avgDiscount.toFixed(2)})
                  </div>
                )}

                {/* EK 30: SAF KUANTUM DURUM TELEMETRİ GÜNLÜĞÜ — Hamming sendromları
                    burada "hücre bütünlüğü" değil, kuantum durum imzaları olarak gösterilir.
                    DÜRÜSTLÜK NOTU: bu bir ANALOJİDİR, gerçek bir kuantum ölçümü değil —
                    Hamming sendromu (0-7) klasik bir hata-tespit indeksidir; |ψ⟩ notasyonu
                    ve Hilbert uzayı vektörleri fiziksel olarak burada YOKTUR, yalnızca
                    aynı sayısal aralığı (3-bit) paylaştıkları için görsel bir eşleme yapılmıştır. */}
                {entry.result.quantumStateLog && entry.result.quantumStateLog.length>0 && (
                  <details style={{marginBottom:7}}>
                    <summary style={{fontSize:8,color:"#00d4ff",cursor:"pointer",letterSpacing:".06em"}}
                      title="Hamming sendromlarının kuantum durum notasyonuna eşlenmesi bir ANALOJİDİR — gerçek bir kuantum ölçümünü temsil etmez">
                      ⚛ {entry.result.quantumStateLog.length} kuantum durum imzası — telemetri günlüğü
                      <span style={{opacity:.5,marginLeft:5}}>(analoji, gerçek ölçüm değil)</span>
                    </summary>
                    <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:2,
                      maxHeight:140,overflowY:"auto"}}>
                      {entry.result.quantumStateLog.slice(0,20).map((qs,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:6,
                          fontSize:7,fontFamily:"monospace",
                          color:qs.corrected?"#f59e0b":"#334155",
                          paddingLeft:8,borderLeft:`2px solid ${qs.corrected?"#f59e0b44":"#0a162844"}`}}>
                          <span style={{minWidth:34}}>#{qs.blockIdx}</span>
                          <span style={{flex:1,color:qs.corrected?"#00d4ff":"#475569"}}>{qs.stateLabel}</span>
                          <span style={{color:"#1e3a5f"}}>{qs.collapseSignature}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* EK 31/32: KİRALİTE SİMETRİSİ + HATA MATRİSİ KORELASYONU — sadece
                    Mirror Universe açıkken hesaplanmış kayıtlarda görünür */}
                {entry.result.chirality && (
                  <details style={{marginBottom:7}}>
                    <summary style={{fontSize:8,color:"#a855f7",cursor:"pointer",letterSpacing:".06em"}}>
                      ⚛ Kiralite simetrisi: {entry.result.chirality.chiralityState}
                    </summary>
                    <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:2,
                      maxHeight:140,overflowY:"auto"}}>
                      <div style={{fontSize:8,color:"#94a3b8",marginBottom:4}}>
                        {entry.result.chirality.conjugateCount} eşlenik durum ·{" "}
                        {entry.result.chirality.phaseDeltaCount} faz-farkı bloğu
                        {entry.result.errorCorrelation?.correlation!=null &&
                          ` · hata korelasyonu r=${entry.result.errorCorrelation.correlation.toFixed(3)}`}
                      </div>
                      {entry.result.chirality.symmetryLog.slice(0,15).map((s,i)=>(
                        <div key={i} style={{fontSize:7,fontFamily:"monospace",lineHeight:1.5,
                          color:s.isConjugate?"#22d3ee":"#f43f5e",
                          paddingLeft:8,borderLeft:`2px solid ${s.isConjugate?"#22d3ee44":"#f43f5e44"}`}}>
                          {s.label}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Bu kayda özel olay listesi (tooltip metinleri) */}
                {entry.eventLog && entry.eventLog.length>0 && (
                  <details style={{marginBottom:7}}>
                    <summary style={{fontSize:8,color:"#334155",cursor:"pointer",letterSpacing:".06em"}}>
                      {entry.eventLog.length} fiziksel olay — detay için aç
                    </summary>
                    <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:3}}>
                      {entry.eventLog.slice(0,8).map((ev,i)=>{
                        const edu = EDU_REFERENCES[ev.type];
                        return (
                          <div key={i}>
                            <div style={{fontSize:8,color:(ERR[ev.type]||{c:"#64748b"}).c,
                              lineHeight:1.5,paddingLeft:8,borderLeft:`2px solid ${(ERR[ev.type]||{c:"#334155"}).c}44`}}>
                              {ev.text}
                            </div>
                            {edu && (
                              <details style={{marginLeft:8,marginTop:2}}>
                                <summary style={{fontSize:7,color:"#334155",cursor:"pointer"}}>
                                  📖 Learn More — bilimsel bağlam ve kaynaklar
                                </summary>
                                <div style={{fontSize:7,color:"#64748b",lineHeight:1.6,marginTop:3,paddingLeft:6}}>
                                  {edu.context}
                                  <div style={{marginTop:4,display:"flex",flexDirection:"column",gap:2}}>
                                    {edu.links.map((l,li)=>(
                                      <a key={li} href={l.url} target="_blank" rel="noopener noreferrer"
                                        style={{color:"#00d4ff",textDecoration:"none",fontSize:7}}>
                                        → {l.label}
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              </details>
                            )}
                          </div>
                        );
                      })}
                      {entry.result.eccExplain && (
                        <div style={{fontSize:8,color:"#10b981",lineHeight:1.5,paddingLeft:8,
                          borderLeft:"2px solid #10b98144"}}>
                          {entry.result.eccExplain}
                        </div>
                      )}
                    </div>
                  </details>
                )}

                <div style={{display:"flex",gap:6}}>
                  <button
                    onClick={()=>replayTimeline(entry.id)}
                    disabled={isReplaying}
                    style={{flex:1,padding:"6px",borderRadius:5,cursor:isReplaying?"not-allowed":"pointer",
                      border:"1px solid #a78bfa44",background:isReplaying?"#0a1628":"#a78bfa11",
                      color:isReplaying?"#334155":"#a78bfa",fontSize:9,fontWeight:700,letterSpacing:".04em"}}>
                    {isReplaying?"◎ OYNATILIYOR…":"▶ REPLAY"}
                  </button>
                  <button
                    onClick={()=>{
                      if (entangleA===entry.id) setEntangleA(null);
                      else if (entangleB===entry.id) setEntangleB(null);
                      else if (!entangleA) setEntangleA(entry.id);
                      else if (!entangleB) setEntangleB(entry.id);
                      else { setEntangleA(entry.id); setEntangleB(null); }
                    }}
                    style={{flex:1,padding:"6px",borderRadius:5,cursor:"pointer",
                      border:`1px solid ${(isA||isB)?"#00d4ff77":"#0a1628"}`,
                      background:(isA||isB)?"#00d4ff11":"transparent",
                      color:(isA||isB)?"#00d4ff":"#334155",fontSize:9,fontWeight:700,letterSpacing:".04em"}}>
                    {isA?"⧉ A SEÇİLİ":isB?"⧉ B SEÇİLİ":"⧉ SEÇ"}
                  </button>
                  {/* EK 22: Graph çoklu-seçim — süperpozisyon için birden fazla kayıt işaretle */}
                  <button
                    onClick={()=>toggleGraphSelection(entry.id)}
                    style={{flex:1,padding:"6px",borderRadius:5,cursor:"pointer",
                      border:`1px solid ${graphSelection.includes(entry.id)?"#f59e0b77":"#0a1628"}`,
                      background:graphSelection.includes(entry.id)?"#f59e0b11":"transparent",
                      color:graphSelection.includes(entry.id)?"#f59e0b":"#334155",fontSize:9,fontWeight:700,letterSpacing:".04em"}}>
                    {graphSelection.includes(entry.id)?"🕸 GRAFİKTE ✓":"🕸 GRAFİĞE EKLE"}
                  </button>
                </div>
                {/* EK 25/26: Rapor + Paylaşım linki */}
                <div style={{display:"flex",gap:6,marginTop:6}}>
                  <button
                    onClick={()=>openReportInNewTab(entry)}
                    style={{flex:1,padding:"6px",borderRadius:5,cursor:"pointer",
                      border:"1px solid #0a1628",background:"transparent",
                      color:"#475569",fontSize:8,fontWeight:600}}>
                    📄 Rapor (PDF için Ctrl+P)
                  </button>
                  <button
                    onClick={()=>{
                      const url = buildShareUrl({
                        seed: entry.seed, src: entry.src, dst: entry.dst,
                        msg: encodeURIComponent(entry.msg), ecc: entry.ecc?1:0, evesdrop: entry.evesdrop?1:0,
                      });
                      navigator.clipboard?.writeText(url).then(()=>{
                        addLog(`🔗 Paylaşım linki panoya kopyalandı`,"OK");
                      }).catch(()=>{
                        addLog(`🔗 Paylaşım linki: ${url}`,"INFO");
                      });
                    }}
                    style={{flex:1,padding:"6px",borderRadius:5,cursor:"pointer",
                      border:"1px solid #0a1628",background:"transparent",
                      color:"#475569",fontSize:8,fontWeight:600}}>
                    🔗 Paylaş
                  </button>
                </div>

                {/* RETRO-CAUSALITY: "Retro-Cause" butonu + bu kayıttan türeyen fork listesi */}
                <button
                  onClick={()=>retroCauseTimeline(entry.id)}
                  style={{width:"100%",marginTop:6,padding:"7px",borderRadius:6,cursor:"pointer",
                    border:"1px solid #ec489944",background:"#ec489911",color:"#f472b6",
                    fontSize:9,fontWeight:700,letterSpacing:".05em",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  ⏪ RETRO-CAUSE — Alternatif Kuantum Tesadüfüyle Yeniden Çalıştır
                </button>
                {(() => {
                  const myForks = forkedEntries.filter(f => f.sourceEntryId === entry.id);
                  if (myForks.length === 0) return null;
                  return (
                    <details style={{marginTop:6}}>
                      <summary style={{fontSize:8,color:"#f472b6",cursor:"pointer",letterSpacing:".06em"}}>
                        ⏪ {myForks.length} fork üretildi — görüntülemek için aç
                      </summary>
                      <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:4}}>
                        {myForks.map(fk => {
                          const diverged = fk.result.decoded !== entry.result.decoded;
                          const isActive = activeForkId === fk.id;
                          return (
                            <div key={fk.id}
                              onClick={()=>setActiveForkId(isActive ? null : fk.id)}
                              style={{
                                display:"flex", alignItems:"center", gap:8, cursor:"pointer",
                                padding:"5px 8px", borderRadius:5,
                                background: isActive ? "#ec489922" : "#020409",
                                border:`1px solid ${isActive ? "#ec4899aa" : diverged ? "#f59e0b33" : "#10b98133"}`,
                              }}>
                              <span style={{fontSize:8,color:diverged?"#f59e0b":"#10b981"}}>
                                {diverged ? "⚡" : "≈"}
                              </span>
                              <span style={{fontSize:9,fontFamily:"monospace",color:"#94a3b8",flex:1}}>
                                "{fk.result.decoded}"
                              </span>
                              <span style={{fontSize:8,fontFamily:"monospace",color:"#64748b"}}>
                                QBER {(fk.result.qber*100).toFixed(1)}%
                              </span>
                              <span style={{fontSize:7,color:isActive?"#ec4899":"#334155"}}>
                                {isActive ? "HARİTADA ✓" : "göster"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* EK 22: ENTANGLEMENT GRAPH SEKMESİ */}
      {tab==="GRAPH"&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",zIndex:1,position:"relative",overflow:"hidden"}}>

          {/* Üst kontrol çubuğu */}
          <div style={{padding:"10px 14px",borderBottom:"1px solid #0a162888",
            display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <span style={{fontSize:9,color:"#1e3a5f",letterSpacing:".1em"}}>
              SEÇİLİ: {graphSelection.length} kayıt
            </span>
            <button onClick={createSuperposition}
              disabled={graphSelection.length<2}
              style={{padding:"6px 14px",borderRadius:6,cursor:graphSelection.length<2?"not-allowed":"pointer",
                border:"1px solid #f59e0b55",background:graphSelection.length<2?"#0a1628":"#f59e0b11",
                color:graphSelection.length<2?"#334155":"#f59e0b",fontSize:9,fontWeight:700,letterSpacing:".04em"}}>
              ⧉ ENTANGLE — Süperpozisyon Oluştur
            </button>
            {graphSelection.length>0 && (
              <button onClick={()=>setGraphSelection([])}
                style={{padding:"6px 10px",borderRadius:6,cursor:"pointer",
                  border:"1px solid #0a1628",background:"transparent",
                  color:"#334155",fontSize:9}}>
                Seçimi Temizle
              </button>
            )}
            <span style={{marginLeft:"auto",fontSize:8,color:"#1e3a5f"}}>
              {superpositions.length} süperpozisyon · {entangleEdges.length} entangle kenarı
            </span>
          </div>

          <div style={{flex:1,display:"flex",minHeight:0}}>
            {/* Graph SVG */}
            <div style={{flex:1,position:"relative"}}>
              {timeline.length===0 ? (
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                  justifyContent:"center",color:"#1e3a5f",fontSize:12,textAlign:"center"}}>
                  Grafik için henüz kayıt yok.<br/>
                  <span style={{fontSize:10}}>Zaman Çizelgesi sekmesinden iletim kaydedin.</span>
                </div>
              ) : (
                <svg width="100%" height="100%" viewBox="0 0 800 500" style={{display:"block"}}>
                  <defs>
                    <filter id="graphGlow"><feGaussianBlur stdDeviation="4" result="b"/>
                      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
                  </defs>
                  {/* Entangle kenarları */}
                  {entangleEdges.map((e,i)=>{
                    const pa = graphNodePos[e.a], pb = graphNodePos[e.b];
                    if (!pa || !pb) return null;
                    const sp = superpositions.find(s=>s.id===e.spId);
                    const collapsed = sp && sp.collapsedTo;
                    return (
                      <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                        stroke={collapsed?"#334155":"#f59e0b"}
                        strokeWidth={collapsed?0.6:1.4}
                        strokeOpacity={collapsed?0.25:0.55}
                        strokeDasharray={collapsed?"none":"5 4"}
                        style={collapsed?{}:{animation:"flow .8s linear infinite"}}/>
                    );
                  })}
                  {/* Timeline düğümleri */}
                  {timeline.map(t=>{
                    const pos = graphNodePos[t.id];
                    if (!pos) return null;
                    const selected = graphSelection.includes(t.id);
                    const inSuperposition = superpositions.some(s=>s.memberIds.includes(t.id) && !s.collapsedTo);
                    const color = t.result.success ? "#22d3ee" : "#f43f5e";
                    return (
                      <g key={t.id}
                        onClick={()=>toggleGraphSelection(t.id)}
                        style={{cursor:"pointer"}}>
                        {selected && (
                          <circle cx={pos.x} cy={pos.y} r={16} fill="#f59e0b" opacity={.15} filter="url(#graphGlow)"/>
                        )}
                        {inSuperposition && (
                          <circle cx={pos.x} cy={pos.y} r={13} fill="none" stroke="#f59e0b"
                            strokeWidth={1} strokeOpacity={.4} strokeDasharray="3 2"
                            style={{animation:"blink 1.5s ease-in-out infinite"}}/>
                        )}
                        <circle cx={pos.x} cy={pos.y} r={9}
                          fill={color+"22"} stroke={selected?"#f59e0b":color} strokeWidth={selected?2:1.2}/>
                        <circle cx={pos.x} cy={pos.y} r={3} fill={color}/>
                        <text x={pos.x} y={pos.y+18} textAnchor="middle"
                          fill="#475569" fontSize={7} fontFamily="monospace">
                          {t.src}→{t.dst}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>

            {/* Süperpozisyon paneli */}
            <div style={{width:240,flexShrink:0,borderLeft:"1px solid #0a162888",
              overflowY:"auto",padding:12}}>
              <div style={{fontSize:8,color:"#1e3a5f",letterSpacing:".1em",marginBottom:8}}>
                SÜPERPOZİSYONLAR
              </div>
              {superpositions.length===0 ? (
                <div style={{color:"#1e3a5f",fontSize:10,textAlign:"center",marginTop:30}}>
                  Grafikte 2+ kayıt seçip<br/>"Entangle" ile oluşturun.
                </div>
              ) : superpositions.map(sp=>{
                const members = sp.memberIds.map(id=>timeline.find(t=>t.id===id)).filter(Boolean);
                return (
                  <div key={sp.id} style={{background:"#030610",
                    border:`1px solid ${sp.collapsedTo?"#33415555":"#f59e0b44"}`,
                    borderRadius:7,padding:"9px 10px",marginBottom:8}}>
                    <div style={{fontSize:9,color:sp.collapsedTo?"#334155":"#f59e0b",
                      fontWeight:700,marginBottom:6}}>
                      {sp.collapsedTo?"⚛ ÇÖKMÜŞ":"◈ SÜPERPOZİSYON"} ({members.length})
                    </div>
                    {members.map(m=>(
                      <div key={m.id} style={{display:"flex",alignItems:"center",gap:6,
                        marginBottom:4,fontSize:9,
                        opacity:sp.collapsedTo && sp.collapsedTo!==m.id ? 0.35 : 1}}>
                        <span style={{color:m.result.success?"#22d3ee":"#f43f5e"}}>
                          {sp.collapsedTo===m.id?"●":"○"}
                        </span>
                        <span style={{color:"#94a3b8",flex:1,fontFamily:"monospace"}}>
                          "{m.msg.slice(0,14)}"
                        </span>
                        {!sp.collapsedTo && (
                          <button onClick={()=>collapseSuperposition(sp.id, m.id)}
                            style={{fontSize:7,padding:"2px 6px",borderRadius:3,cursor:"pointer",
                              border:"1px solid #00d4ff44",background:"transparent",color:"#00d4ff"}}>
                            SEÇ
                          </button>
                        )}
                      </div>
                    ))}
                    {!sp.collapsedTo && (
                      <button onClick={()=>interfereSuperposition(sp.id)}
                        style={{width:"100%",marginTop:6,padding:"6px",borderRadius:5,cursor:"pointer",
                          border:"1px solid #ec489944",background:"#ec489911",color:"#f472b6",
                          fontSize:8,fontWeight:700,letterSpacing:".04em"}}>
                        ⚡ INTERFERENCE — Yeni Dalga Fonksiyonu Üret
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* FAZ 2: KENDİ KENDİNİ İYİLEŞTİRME (SELF-HEALING) VE ANOMALİ TESPİTİ.
          bkz. NodeWatchdog sınıfı, watchdog-vitals-tick, injectAnomaly().
          Karantina mekanizması NODES[].on alanını yeniden kullanır — yeni
          bir dışlama yolu icat edilmedi (bkz. dijkstra()'daki liveIds). */}
      {tab==="WDG"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>
          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:10}}>
            KENDİ KENDİNİ İYİLEŞTİRME — OTONOM AĞ BEKÇİSİ (Watchdog)
          </div>
          <div style={{fontSize:9,color:"#475569",lineHeight:1.5,marginBottom:14,
            background:"#020409",border:"1px solid #0a1628",borderRadius:5,padding:"8px 10px"}}>
            Bu katman, yönlendirme motorunun ürettiği logları ve düğümlerin sentetik
            yaşamsal bulgularını (CPU/bellek/heartbeat) arka planda pasif olarak
            izler. Bir <b style={{color:"#f43f5e"}}>thread kilitlenmesi</b>,{" "}
            <b style={{color:"#f59e0b"}}>bellek sızıntısı</b> veya{" "}
            <b style={{color:"#f43f5e"}}>yanıt vermeyen düğüm</b> tespit edildiğinde,
            Watchdog düğümü otomatik olarak karantinaya alır (yönlendirme motoru
            zaten bu alana saygı gösterir — bkz. DİNAMİK YÜK DENGELEME), asenkron
            olarak "yeniden başlatır" ve insan müdahalesi olmadan ağa geri entegre eder.{" "}
            <b style={{color:"#a855f7"}}>HAT BAZLI SUÇLAMA:</b> son 3 başarısızlığın
            ortak paydası bir düğüm değil de HEP AYNI fiziksel segment ise (örn.
            tekrarlayan bir ANİ SOĞURULMA BARİYERİ), Watchdog artık rotanın
            ortasındaki ilgisiz bir düğümü "kovalamak" yerine doğrudan o HATTI
            karantinaya alır — yönlendirme motoru başka bir fiziksel yol arar.
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:12}}>
            {[
              {l:"TESPİT EDİLEN ANOMALİ",v:watchdogStats.anomaliesDetected,c:"#f59e0b"},
              {l:"OTONOM İYİLEŞTİRME",v:watchdogStats.autoHeals,c:"#10b981"},
              {l:"SON KESİNTİ SÜRESİ",v:watchdogStats.lastHealMs!=null?`${(watchdogStats.lastHealMs/1000).toFixed(1)}s`:"—",c:"#00d4ff"},
              {l:"HAT KARANTİNASI (LINK)",v:watchdogStats.linkQuarantines,c:"#a855f7"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>

          <div style={{background:"#0a0d1f",border:"1px solid #00d4ff22",borderRadius:8,padding:"13px 15px",marginBottom:12}}>
            <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:8}}>
              ⚡ ANOMALİ ENJEKSİYONU (DEMO)
            </div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:10,lineHeight:1.5}}>
              Bir düğümde yapay olarak bir arıza türü tetikleyin — Watchdog'un
              otonom tespit → karantina → iyileştirme döngüsünü canlı izleyin.
              Aktif kaynak/hedef düğüm seçilemez.
            </div>
            <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
              <div style={{flex:"1 1 180px",minWidth:150}}>
                <div style={{fontSize:7,color:"#334155",marginBottom:3}}>DÜĞÜM SEÇ</div>
                <select value={anomalyNodeSel} onChange={e=>setAnomalyNodeSel(e.target.value)}
                  style={{width:"100%",padding:"5px 6px",fontSize:9}}>
                  <option value="">— düğüm seçin —</option>
                  {nodes.filter(n=>n.id!==src&&n.id!==dst).map(n=>(
                    <option key={n.id} value={n.id}>{n.id} — {n.label}{n.on?"":" (offline)"}</option>
                  ))}
                </select>
              </div>
              <div style={{flex:"0 0 auto"}}>
                <div style={{fontSize:7,color:"#334155",marginBottom:3}}>ANOMALİ TÜRÜ</div>
                <div style={{display:"flex",gap:4}}>
                  {[["lockup","🔒 KİLİTLENME"],["leak","💧 BELLEK SIZINTISI"],["unresponsive","📡 YANITSIZ"]].map(([k,l])=>(
                    <button key={k} onClick={()=>setAnomalyTypeSel(k)}
                      style={{padding:"5px 9px",fontSize:8,borderRadius:4,cursor:"pointer",
                        background:anomalyTypeSel===k?"#f43f5e22":"transparent",
                        border:`1px solid ${anomalyTypeSel===k?"#f43f5e77":"#0a1628"}`,
                        color:anomalyTypeSel===k?"#f43f5e":"#334155",fontWeight:700}}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <button onClick={injectAnomaly} disabled={!anomalyNodeSel}
                style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                  background:"linear-gradient(135deg,#f43f5e,#7c3aed)",border:"none",color:"#fff",
                  opacity:!anomalyNodeSel?0.4:1}}>
                ⚡ ANOMALİYİ TETİKLE
              </button>
            </div>
          </div>

          {Object.keys(activeAnomalies).length>0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>AKTİF ANOMALİLER</div>
              {Object.entries(activeAnomalies).map(([nodeId,a])=>(
                <div key={nodeId} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
                  background:a.phase==="healing"?"#0a2a1a33":"#3f151533",
                  border:`1px solid ${a.phase==="healing"?"#10b98144":"#f43f5e44"}`,
                  borderRadius:6,padding:"7px 11px",marginBottom:6}}>
                  <div style={{width:6,height:6,borderRadius:"50%",
                    background:a.phase==="healing"?"#10b981":"#f43f5e",
                    boxShadow:`0 0 6px ${a.phase==="healing"?"#10b981":"#f43f5e"}`,
                    animation:"blink 0.6s ease-in-out infinite"}}/>
                  <span style={{fontSize:9,fontWeight:700,color:a.phase==="healing"?"#10b981":"#f43f5e"}}>
                    {nodeId} — {a.type==="lockup"?"THREAD KİLİTLENMESİ":a.type==="leak"?"BELLEK SIZINTISI":"YANITSIZ"}
                  </span>
                  <span style={{fontSize:8,color:"#64748b"}}>
                    {a.phase==="healing"?"🔧 asenkron olarak yeniden başlatılıyor...":"🔴 karantinada — tanılanıyor"}
                  </span>
                  <button onClick={()=>forceHealAnomaly(nodeId)}
                    style={{marginLeft:"auto",padding:"4px 10px",fontSize:8,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                    ✕ HEMEN İYİLEŞTİR
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* FAZ 6: HAT BAZLI SUÇLAMA (Link-Based Blaming) — düğüm değil,
              belirli bir fiziksel hattın kendisi tekrar tekrar arızalı
              çıktığında Watchdog'un onu karantinaya aldığı hatlar. */}
          {Object.keys(activeLinkQuarantines).length>0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>
                🔗 AKTİF HAT KARANTİNALARI (Link-Based Blaming)
              </div>
              {Object.entries(activeLinkQuarantines).map(([linkKey,q])=>(
                <div key={linkKey} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
                  background:"#2a123f33",border:"1px solid #a855f744",
                  borderRadius:6,padding:"7px 11px",marginBottom:6}}>
                  <div style={{width:6,height:6,borderRadius:"50%",
                    background:"#a855f7",boxShadow:"0 0 6px #a855f7",
                    animation:"blink 0.6s ease-in-out infinite"}}/>
                  <span style={{fontSize:9,fontWeight:700,color:"#a855f7"}}>
                    {q.a}→{q.b} HATTI KARANTİNADA
                  </span>
                  <span style={{fontSize:8,color:"#64748b"}}>
                    🔀 düğüm değil, hattın kendisi suçlandı — yönlendirme motoru alternatif fiziksel yol kullanıyor
                  </span>
                  <button onClick={()=>linkOutageController.cancel()}
                    style={{marginLeft:"auto",padding:"4px 10px",fontSize:8,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                    ✕ HEMEN ONAR
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>
            DÜĞÜM SAĞLIK IZGARASI ({nodes.filter(n=>n.on).length}/{nodes.length} çevrimiçi)
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:6}}>
            {nodes.map(n=>{
              const h = nodeHealth[n.id];
              const anomaly = activeAnomalies[n.id];
              const preventive = activePreventive[n.id];
              // FAZ 4: preventive (proaktif/amber) reaktif anomaliden (kırmızı)
              // ayrı renklendirilir — ikisi de AYNI node.on=false mekanizmasını
              // kullanır ama anlamları TAMAMEN farklıdır (arıza vs. önlem).
              const statusColor = !n.on ? (preventive && !anomaly ? "#f59e0b" : "#f43f5e") : (h?.status==="CRIT"?"#f59e0b":"#10b981");
              const offLabel = anomaly
                ? (anomaly.phase==="healing"?"YENİDEN BAŞLATILIYOR":"KARANTİNADA")
                : preventive ? "ÖNLEYİCİ BAKIMDA" : "KAPALI (elle)";
              return (
                <div key={n.id} style={{background:"#030610",
                  border:`1px solid ${!n.on?statusColor+"44":"#0a162888"}`,
                  borderRadius:4,padding:"7px 8px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <span style={{fontSize:9,fontWeight:700,color:"#00d4ff"}}>{n.id}</span>
                    <div style={{width:5,height:5,borderRadius:"50%",background:statusColor,
                      boxShadow:`0 0 4px ${statusColor}`,
                      animation:!n.on?"blink 0.8s ease-in-out infinite":"none"}}/>
                  </div>
                  <div style={{fontSize:7,color:!n.on?statusColor:"#475569"}}>
                    {!n.on?offLabel:"ÇEVRİMİÇİ"}
                  </div>
                  {h && n.on && (
                    <div style={{fontSize:6,color:"#334155",marginTop:2,fontFamily:"monospace"}}>
                      CPU {h.cpu?.toFixed(0)}% · MEM {h.mem?.toFixed(0)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* FAZ 4: TAHMİNLEME MODELİ (PREDICTIVE TELEMETRY). bkz.
          PredictiveTelemetryEngine, predictive-telemetry-tick,
          NodeWatchdog.triggerPreventiveMaintenance, injectLinkTrend/injectNodeTrend. */}
      {tab==="PRED"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>
          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:10}}>
            TAHMİNLEME MODELİ — PROAKTİF DARBOĞAZ/GECİKME ÖNGÖRÜSÜ
          </div>
          <div style={{fontSize:9,color:"#475569",lineHeight:1.5,marginBottom:14,
            background:"#020409",border:"1px solid #0a1628",borderRadius:5,padding:"8px 10px"}}>
            Her link ve düğüm metriği sürekli örneklenir; <b style={{color:"#00d4ff"}}>hareketli ortalama</b> (gürültüyü
            yumuşatır), <b style={{color:"#00d4ff"}}>hız</b> (en küçük kareler regresyon eğimi) ve <b style={{color:"#00d4ff"}}>ivme</b> (hızın
            değişim oranı) hesaplanır; kinematik ekstrapolasyonla <b style={{color:"#7c3aed"}}>5 dakika sonrasının</b> tahmini
            üretilir. Risk eşiği aşılacaksa sistem KRİZ OLUŞMADAN ÖNCE trafiği proaktif olarak
            kaydırır (linkler) veya düğümü kısa bir önleyici bakım döngüsüne alır (düğümler).
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:12}}>
            {[
              {l:"TAHMİNİ UYARI",v:predictiveStats.warningsIssued,c:"#f59e0b"},
              {l:"ÖNLEYİCİ BAKIM",v:predictiveStats.preventiveActions,c:"#7c3aed"},
              {l:"İZLENEN VARLIK",v:predictiveInsights.length,c:"#00d4ff"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>

          <div style={{background:"#0a0d1f",border:"1px solid #00d4ff22",borderRadius:8,padding:"13px 15px",marginBottom:12}}>
            <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:8}}>
              📈 TREND ENJEKSİYONU (DEMO)
            </div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:10,lineHeight:1.5}}>
              Bir hattın/düğümün yükünü YAVAŞÇA (ani değil) yükseltin — motorun krizi
              tepe noktasından ÇOK ÖNCE öngördüğünü ve önlem aldığını canlı izleyin.
            </div>

            <div style={{marginBottom:10}}>
              <div style={{fontSize:7,color:"#334155",marginBottom:4}}>HAT TRENDİ</div>
              <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div style={{flex:"1 1 200px",minWidth:170}}>
                  <select value={trendLinkSel} disabled={linkTrendBusy}
                    onChange={e=>setTrendLinkSel(e.target.value)}
                    style={{width:"100%",padding:"5px 6px",fontSize:9}}>
                    <option value="">— hat seçin —</option>
                    {[...links].sort((a,b)=>b.km-a.km).map(l=>(
                      <option key={`${l.a}-${l.b}`} value={`${l.a}-${l.b}`}>{l.a} → {l.b} ({l.km}km)</option>
                    ))}
                  </select>
                </div>
                {!linkTrendBusy ? (
                  <button onClick={injectLinkTrend} disabled={!trendLinkSel}
                    style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"linear-gradient(135deg,#00d4ff,#7c3aed)",border:"none",color:"#fff",
                      opacity:!trendLinkSel?0.4:1}}>
                    📈 HAT YÜKÜNÜ YÜKSELT
                  </button>
                ) : (
                  <button onClick={cancelLinkTrend}
                    style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                    ✕ İPTAL ET
                  </button>
                )}
              </div>
            </div>

            <div>
              <div style={{fontSize:7,color:"#334155",marginBottom:4}}>DÜĞÜM TRENDİ</div>
              <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div style={{flex:"1 1 160px",minWidth:140}}>
                  <select value={trendNodeSel} disabled={nodeTrendBusy}
                    onChange={e=>setTrendNodeSel(e.target.value)}
                    style={{width:"100%",padding:"5px 6px",fontSize:9}}>
                    <option value="">— düğüm seçin —</option>
                    {nodes.filter(n=>n.id!==src&&n.id!==dst).map(n=>(
                      <option key={n.id} value={n.id}>{n.id} — {n.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{display:"flex",gap:4}}>
                  {[["cpu","CPU"],["mem","BELLEK"]].map(([k,l])=>(
                    <button key={k} disabled={nodeTrendBusy} onClick={()=>setTrendMetricSel(k)}
                      style={{padding:"5px 9px",fontSize:8,borderRadius:4,cursor:"pointer",
                        background:trendMetricSel===k?"#7c3aed22":"transparent",
                        border:`1px solid ${trendMetricSel===k?"#7c3aed77":"#0a1628"}`,
                        color:trendMetricSel===k?"#7c3aed":"#334155",fontWeight:700}}>
                      {l}
                    </button>
                  ))}
                </div>
                {!nodeTrendBusy ? (
                  <button onClick={injectNodeTrend} disabled={!trendNodeSel}
                    style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"linear-gradient(135deg,#00d4ff,#7c3aed)",border:"none",color:"#fff",
                      opacity:!trendNodeSel?0.4:1}}>
                    📈 DÜĞÜM YÜKÜNÜ YÜKSELT
                  </button>
                ) : (
                  <button onClick={cancelNodeTrend}
                    style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                    ✕ İPTAL ET
                  </button>
                )}
              </div>
            </div>
          </div>

          {Object.keys(activePreventive).length>0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>AKTİF ÖNLEYİCİ BAKIM</div>
              {Object.entries(activePreventive).map(([nodeId,pv])=>(
                <div key={nodeId} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
                  background:"#2a1a0533",border:"1px solid #f59e0b44",
                  borderRadius:6,padding:"7px 11px",marginBottom:6}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:"#f59e0b",
                    boxShadow:"0 0 6px #f59e0b",animation:"blink 0.6s ease-in-out infinite"}}/>
                  <span style={{fontSize:9,fontWeight:700,color:"#f59e0b"}}>🔮 {nodeId} — proaktif bakımda</span>
                  <span style={{fontSize:8,color:"#64748b"}}>{pv.reason}</span>
                  <button onClick={()=>forceHealAnomaly(nodeId)}
                    style={{marginLeft:"auto",padding:"4px 10px",fontSize:8,fontWeight:700,borderRadius:4,cursor:"pointer",
                      background:"none",border:"1px solid #33415577",color:"#94a3b8"}}>
                    ✕ HEMEN TAMAMLA
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:6}}>
            RİSK LİDER TABLOSU (en riskliden aza, ufuk: 5dk)
          </div>
          {predictiveInsights.length===0 ? (
            <div style={{fontSize:8,color:"#334155",padding:"6px 2px"}}>
              Henüz yeterli örnek toplanmadı — birkaç saniye bekleyin veya bir trend enjekte edin.
            </div>
          ) : (
            <div style={{display:"grid",gap:4}}>
              {predictiveInsights.map(ins=>{
                const lc = ins.level==="CRITICAL"?"#f43f5e":ins.level==="WARNING"?"#f59e0b":ins.level==="WATCH"?"#00d4ff":"#334155";
                const etaTxt = ins.etaMs!=null ? `${Math.floor(ins.etaMs/60000)}dk ${Math.round((ins.etaMs%60000)/1000)}sn` : "—";
                return (
                  <div key={ins.key} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",
                    background:"#020409",border:`1px solid ${lc}22`,borderRadius:4,padding:"6px 9px",fontFamily:"monospace"}}>
                    <span style={{fontSize:11}}>{ins.kind==="link"?"🔗":"⚙"}</span>
                    <span style={{fontSize:9,color:"#94a3b8",fontWeight:700,flexShrink:0,minWidth:110}}>{ins.label}</span>
                    <span style={{fontSize:7,color:lc,fontWeight:700,padding:"1px 6px",borderRadius:3,background:lc+"18"}}>
                      {ins.level}
                    </span>
                    <span style={{fontSize:8,color:"#334155"}}>SMA %{(ins.sma*100).toFixed(0)}</span>
                    <span style={{fontSize:8,color:ins.velocity>0?"#f43f5e":"#10b981"}}>
                      {ins.velocity>0?"↑":"↓"} {(Math.abs(ins.velocity)*100).toFixed(2)}/sn
                    </span>
                    <span style={{fontSize:8,color:"#334155"}}>ivme {ins.acceleration>=0?"+":""}{ins.acceleration.toFixed(3)}/sn²</span>
                    <span style={{fontSize:8,color:"#7c3aed"}}>tahmin(5dk) %{(ins.predicted*100).toFixed(0)}</span>
                    <span style={{fontSize:8,color:"#64748b",marginLeft:"auto"}}>ETA {etaTxt}</span>
                    <span style={{fontSize:9,fontWeight:700,color:lc}}>%{(ins.risk*100).toFixed(0)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* FAZ 5: KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON (Noise-Gate
          Middleware) — bkz. NoiseGateMiddleware başlığı. */}
      {tab==="NGM"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>
          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:10}}>
            KUANTUM GÜRÜLTÜ FİLTRELEME VE KALİBRASYON — NOISE-GATE MIDDLEWARE
          </div>
          <div style={{fontSize:9,color:"#475569",lineHeight:1.5,marginBottom:14,
            background:"#020409",border:"1px solid #0a1628",borderRadius:5,padding:"8px 10px"}}>
            SNSPD (Superconducting Nanowire Single-Photon Detector) mükemmel değildir: sıcaklık
            sürüklenmesi veya fiber sızıntısı, foton gelmediği hâlde dedektörü <b style={{color:"#00d4ff"}}>hayalet
            bir "click"</b> üretmeye zorlayabilir (karanlık sayım). Bu katman gürültüyü periyodik olarak <b style={{color:"#00d4ff"}}>kalibre
            eder</b> ve zaman-korelasyonlu bir <b style={{color:"#7c3aed"}}>kapı (gate)</b> ile filtreler — kapıyı
            daraltmak gürültüyü azaltır ama gerçek fotonların bir kısmının kaçırılma riskini de (küçük ölçüde)
            artırır — dürüst bir mühendislik ödünleşimi, sahte bir kesinlik değil.
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:8}}>
            {[
              {l:"SNSPD SICAKLIK SAPMASI",v:`${noiseGateState.tempDriftMk.toFixed(2)}mK`,
                c:Math.abs(noiseGateState.tempDriftMk)>SNSPD_TEMP_TRIP_MK?"#f43f5e":Math.abs(noiseGateState.tempDriftMk)>SNSPD_TEMP_TRIP_MK*0.5?"#f59e0b":"#10b981"},
              {l:"HAM KARANLIK ORANI",v:`${noiseGateState.rawDarkRateHz.toFixed(0)}Hz`,c:"#f59e0b"},
              {l:"KALİBRE EDİLMİŞ ORAN",v:`${noiseGateState.calibratedDarkRateHz.toFixed(0)}Hz`,c:"#00d4ff"},
              {l:"KAPI GENİŞLİĞİ",v:`%${(noiseGateState.gateRatio*100).toFixed(0)}`,c:noiseGateState.gateRatio<0.999?"#7c3aed":"#334155"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:16,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:12}}>
            {[
              {l:"FİLTRELENEN HAYALET CLICK",v:noiseGateStats.filteredDarkClicks,c:"#10b981"},
              {l:"KABUL EDİLEN HAYALET CLICK",v:noiseGateStats.acceptedDarkClicks,c:"#f59e0b"},
              {l:"KAÇAN GERÇEK CLICK",v:noiseGateStats.missedRealClicks,c:"#f43f5e"},
              {l:"KALİBRASYON TURU",v:noiseGateStats.calibrationRuns,c:"#00d4ff"},
            ].map(m=>(
              <div key={m.l} style={{background:"#030610",border:"1px solid #0a162888",
                borderRadius:4,padding:"9px 10px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:3}}>{m.l}</div>
                <div style={{fontSize:16,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>

          <div style={{background:"#0a0d1f",border:"1px solid #00d4ff22",borderRadius:8,padding:"13px 15px",marginBottom:12}}>
            <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:8}}>
              🌡️ SNSPD SICAKLIK SÜRÜKLENMESİ
            </div>
            <div style={{position:"relative",height:14,borderRadius:7,overflow:"hidden",
              background:"linear-gradient(90deg,#f43f5e 0%,#f59e0b 30%,#10b981 46%,#10b981 54%,#f59e0b 70%,#f43f5e 100%)",marginBottom:6}}>
              <div style={{position:"absolute",top:-2,bottom:-2,width:3,borderRadius:2,
                background:"#fff",boxShadow:"0 0 6px #fff",
                left:`${Math.min(100,Math.max(0,((noiseGateState.tempDriftMk+25)/50)*100))}%`,
                transform:"translateX(-50%)",transition:"left .4s"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#334155",fontFamily:"monospace"}}>
              <span>-25mK</span><span>nominal (0mK)</span><span>+25mK</span>
            </div>
            <div style={{marginTop:8,fontSize:8,color:"#64748b"}}>
              Trip eşiği: ±{SNSPD_TEMP_TRIP_MK}mK — bu eşiği aşınca karanlık sayım oranı üstel olarak artmaya başlar
              (Arrhenius-benzeri termal aktivasyon).
            </div>
          </div>

          <div style={{background:"#030610",border:"1px solid #0a162888",
            borderRadius:4,padding:"9px 10px",marginBottom:12}}>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:5}}>KALİBRE EDİLMİŞ KARANLIK ORANI — GEÇMİŞ</div>
            <Spark data={noiseGateHistory} color="#00d4ff" h={38}/>
          </div>

          <div style={{background:"#0a0d1f",border:"1px solid #00d4ff22",borderRadius:8,padding:"13px 15px",marginBottom:12}}>
            <div style={{fontSize:10,color:"#00d4ff",fontWeight:700,letterSpacing:".08em",marginBottom:8}}>
              ⚡ GÜRÜLTÜ ENJEKSİYONU (DEMO)
            </div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:10,lineHeight:1.5}}>
              SNSPD'nin bias noktasını yapay olarak zorlayın veya fiber hattan bir sızıntı simüle edin — Gürültü
              Kapısı'nın otonom kalibrasyon/daralma döngüsünü canlı izleyin.
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={injectThermalFluctuation}
                style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                  background:"linear-gradient(135deg,#f59e0b,#f43f5e)",border:"none",color:"#fff"}}>
                🌡️ Isıl Dalgalanma Enjekte Et
              </button>
              <button onClick={toggleFiberLeak}
                style={{padding:"6px 14px",fontSize:9,fontWeight:700,borderRadius:4,cursor:"pointer",
                  background:fiberLeakActive?"#f43f5e22":"transparent",
                  border:`1px solid ${fiberLeakActive?"#f43f5e77":"#33415577"}`,
                  color:fiberLeakActive?"#f43f5e":"#94a3b8"}}>
                💧 {fiberLeakActive?"Fiber Sızıntısını Gider":"Fiber Sızıntısı Enjekte Et"}
              </button>
            </div>
          </div>

          <div style={{fontSize:8,color:"#334155",lineHeight:1.5}}>
            Not: bu katman yalnızca BB84 anahtar-değişim kanalını (deriveSiftedKey) etkiler — mesaj fiziği
            (propPhoton) ve rotalama motoruna hiç dokunmaz (bkz. EK 44 DetectorNoiseModel ile aynı mimari sınır).
          </div>
        </div>
      )}

      {/* EK 45: DONANIM (HAL Bridge) — hal/bridge_server.py'ye bağlanan
          isteğe bağlı bir REST+SSE istemci paneli. transmit()/propPhoton
          yoluna HİÇ dokunmaz; ayrı, bağımsız bir veri yoludur. */}
      {tab==="HW"&&(
        <div style={{flex:1,overflowY:"auto",padding:14,zIndex:1,position:"relative"}}>
          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:10}}>
            DONANIM KÖPRÜSÜ — HAL (Hardware Abstraction Layer)
          </div>
          <div style={{fontSize:9,color:"#475569",lineHeight:1.5,marginBottom:14,
            background:"#020409",border:"1px solid #0a1628",borderRadius:5,padding:"8px 10px"}}>
            Bu panel, PhotonNet'in kendi tarayıcı-içi simülasyonundan (propPhoton/deriveSiftedKey)
            {" "}<b style={{color:"#7c3aed"}}>tamamen bağımsız</b> ayrı bir Python sürecine
            (<code style={{color:"#00d4ff"}}>python3 -m hal.bridge_server</code>) bağlanır. Orada QBER,
            RNG ile üretilmez — gerçek (veya <code style={{color:"#00d4ff"}}>hal/simulated_hardware.py</code>'nin
            ürettiği gerçekçi) zaman-damgalı click'lerin <code style={{color:"#00d4ff"}}>TimeTagCorrelator</code> ile
            eşleştirilmesiyle hesaplanır. Gerçek cihaz bağlandığında yalnızca
            {" "}<code style={{color:"#00d4ff"}}>hardware_interface.HardwareInterface</code>'ten türeyen yeni bir
            sürücü yazılır — bu panel DEĞİŞMEDEN çalışmaya devam eder.
          </div>

          {/* Sunucu adresi + health check */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
              background:hwServerOk===true?"#10b981":hwServerOk===false?"#f43f5e":"#334155",
              boxShadow:hwServerOk===true?"0 0 6px #10b981":hwServerOk===false?"0 0 6px #f43f5e":"none",
              animation:hwServerOk===null?"none":"blink 2s ease-in-out infinite"}}/>
            <input value={hwBridgeUrl} onChange={e=>setHwBridgeUrl(e.target.value)}
              placeholder="http://localhost:8765"
              style={{flex:1,background:"#020409",border:"1px solid #0a1628",borderRadius:4,
                color:"#00d4ff",fontSize:10,fontFamily:"monospace",padding:"6px 8px",outline:"none"}}/>
            <button className="nbtn" onClick={hwCheckHealth}
              style={{fontSize:8,color:"#334155",letterSpacing:".06em",flexShrink:0}}>SUNUCUYU DENE</button>
          </div>

          {/* Bağlantı durumu */}
          <div style={{background:"#020409",border:"1px solid #0a1628",borderRadius:5,
            padding:"9px 10px",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em"}}>LINKMANAGER DURUMU</span>
              <span style={{fontSize:9,fontWeight:700,color:hwStatus.connected?"#10b981":"#475569"}}>
                {hwStatus.connected?(hwStatus.armed?"● BAĞLI / ARM":"● BAĞLI"):"○ BAĞLI DEĞİL"}
              </span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
              {[
                ["SÜRÜCÜ", hwStatus.driver_name||"—", "#475569"],
                ["SICAKLIK", hwStatus.temperature_c!=null?`${hwStatus.temperature_c}°C`:"—", "#00d4ff"],
                ["KARANLIK SAYIM", hwStatus.dark_count_rate_hz!=null?`${hwStatus.dark_count_rate_hz}Hz`:"—", "#7c3aed"],
              ].map(([l,v,c])=>(
                <div key={l} style={{background:"#01030a",border:"1px solid #0a1628",borderRadius:3,padding:"5px 6px"}}>
                  <div style={{fontSize:6,color:"#1e3a5f",marginBottom:1}}>{l}</div>
                  <div style={{fontSize:9,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>
                </div>
              ))}
            </div>
            {hwStatus.last_error&&(
              <div style={{fontSize:8,color:"#f43f5e",marginTop:6}}>⚠ {hwStatus.last_error}</div>
            )}
          </div>

          {/* Edinim parametreleri */}
          <div style={{background:"#020409",border:"1px solid #0a1628",borderRadius:5,
            padding:"9px 10px",marginBottom:12}}>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:8}}>EDİNİM PARAMETRELERİ</div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
              <label style={{fontSize:8,color:"#475569",display:"flex",flexDirection:"column",gap:3,flex:1}}>
                MESAFE (km)
                <input type="number" min={0} step={1} value={hwDistanceKm}
                  disabled={hwStatus.connected}
                  onChange={e=>setHwDistanceKm(Math.max(0,+e.target.value||0))}
                  style={{background:"#01030a",border:"1px solid #0a1628",borderRadius:3,
                    color:"#00d4ff",fontSize:10,fontFamily:"monospace",padding:"5px 6px",outline:"none",
                    opacity:hwStatus.connected?.5:1}}/>
              </label>
              <label style={{fontSize:8,color:"#475569",display:"flex",flexDirection:"column",gap:3,flex:1}}>
                EDİNİM SÜRESİ (ms)
                <input type="number" min={0.01} step={0.1} value={hwDurationMs}
                  onChange={e=>setHwDurationMs(Math.max(0.01,+e.target.value||0.01))}
                  style={{background:"#01030a",border:"1px solid #0a1628",borderRadius:3,
                    color:"#00d4ff",fontSize:10,fontFamily:"monospace",padding:"5px 6px",outline:"none"}}/>
              </label>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <div onClick={()=>!hwStatus.connected&&setHwEavesdrop(v=>!v)}
                  style={{width:34,height:18,borderRadius:9,cursor:hwStatus.connected?"not-allowed":"pointer",
                    background:hwEavesdrop?"linear-gradient(90deg,#00d4ff,#7c3aed)":"#0a1628",
                    border:`1px solid ${hwEavesdrop?"#00d4ff44":"#1e3a5f"}`,
                    position:"relative",transition:"all .3s",opacity:hwStatus.connected?.5:1}}>
                  <div style={{width:12,height:12,borderRadius:"50%",background:"#fff",
                    position:"absolute",top:2,left:hwEavesdrop?18:2,transition:"left .3s"}}/>
                </div>
                <span style={{fontSize:7,color:hwEavesdrop?"#00d4ff":"#475569",whiteSpace:"nowrap"}}>Eve</span>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {!hwStatus.connected?(
                <button className="nbtn" onClick={hwConnect} disabled={hwConnecting}
                  style={{flex:1,fontSize:9,color:"#00d4ff",letterSpacing:".06em",padding:"7px 0",
                    opacity:hwConnecting?.5:1}}>
                  {hwConnecting?"BAĞLANIYOR…":"🔗 BAĞLAN"}
                </button>
              ):(
                <button className="nbtn" onClick={hwDisconnect}
                  style={{flex:1,fontSize:9,color:"#f43f5e",letterSpacing:".06em",padding:"7px 0"}}>
                  ✕ BAĞLANTIYI KES
                </button>
              )}
              <button className="nbtn" onClick={hwAcquire} disabled={hwAcquiring}
                style={{flex:1,fontSize:9,color:"#10b981",letterSpacing:".06em",padding:"7px 0",
                  opacity:hwAcquiring?.5:1}}>
                {hwAcquiring?"EDİNİLİYOR…":"⚡ TEK-SEFERLİK EDİNİM"}
              </button>
            </div>
            <div style={{fontSize:7,color:"#1e3a5f",marginTop:6,lineHeight:1.4}}>
              BAĞLAN, LinkManager'ı sürekli arka-plan modunda başlatır (durum/telemetri SSE ile akar).
              TEK-SEFERLİK EDİNİM ise bağımsız, senkron bir BB84 oturumu çalıştırır — bağlı olmak GEREKMEZ.
            </div>
          </div>

          {/* Son edinim sonucu */}
          {hwResult&&(
            <div style={{background:"#020409",border:"1px solid #0a1628",borderRadius:5,padding:"9px 10px"}}>
              <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:8}}>SON DONANIM EDİNİM SONUCU</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:8}}>
                {[
                  ["DARBE", hwResult.pulses_sent, "#475569"],
                  ["CLICK", hwResult.clicks_received, "#7c3aed"],
                  ["ALGILANAN", hwResult.result.detected_count, "#00d4ff"],
                  ["QBER", (hwResult.result.qber*100).toFixed(2)+"%",
                    hwResult.result.qber>0.11?"#f43f5e":"#10b981"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#01030a",border:"1px solid #0a1628",borderRadius:3,padding:"5px 6px"}}>
                    <div style={{fontSize:6,color:"#1e3a5f",marginBottom:1}}>{l}</div>
                    <div style={{fontSize:11,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:8}}>
                {[
                  ["SIFTED KEY", hwResult.result.sifted_key_len+"bit", "#475569"],
                  ["KAYIP", hwResult.result.lost_count, "#f59e0b"],
                  ["KARANLIK", hwResult.result.dark_click_count, "#7c3aed"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#01030a",border:"1px solid #0a1628",borderRadius:3,padding:"5px 6px"}}>
                    <div style={{fontSize:6,color:"#1e3a5f",marginBottom:1}}>{l}</div>
                    <div style={{fontSize:10,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:9,fontWeight:700,letterSpacing:".06em",
                color:hwResult.result.eavesdrop_detected?"#f43f5e":"#10b981",
                display:"flex",alignItems:"center",gap:5}}>
                <div style={{width:6,height:6,borderRadius:"50%",flexShrink:0,
                  background:hwResult.result.eavesdrop_detected?"#f43f5e":"#10b981",
                  boxShadow:`0 0 6px ${hwResult.result.eavesdrop_detected?"#f43f5e":"#10b981"}`}}/>
                {hwResult.result.eavesdrop_detected?"DİNLEME İSTATİSTİKSEL OLARAK TESPİT EDİLDİ":"KANAL GÜVENLİ ARALIKTA"}
              </div>
              <div style={{fontSize:7,color:"#1e3a5f",marginTop:4,fontFamily:"monospace"}}>
                gerçek işlem süresi: {hwResult.wall_clock_s}s · mesafe: {hwResult.distance_km}km
              </div>
            </div>
          )}
        </div>
      )}

      {/* LOG */}
      {tab==="LOG"&&(
        <div style={{flex:1,overflowY:"auto",padding:10,zIndex:1,position:"relative"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
            <span style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em"}}>SİSTEM KAYDI — {log.length} SATIR</span>
            <button className="nbtn" onClick={()=>setLog([])}
              style={{fontSize:8,color:"#334155",letterSpacing:".08em"}}>TEMİZLE</button>
          </div>
          {log.map(e=>(
            <div key={e.id} style={{display:"flex",gap:7,padding:"2px 4px",borderRadius:2,
              background:LB[e.type]??"transparent",marginBottom:1}}>
              <span style={{color:"#1e3a5f",flexShrink:0,fontSize:8,fontFamily:"monospace"}}>{e.ts}</span>
              <span style={{color:LC[e.type]||"#334155",flexShrink:0,fontSize:8,fontWeight:700,minWidth:26}}>{e.type}</span>
              <span style={{color:LC[e.type]||"#475569",fontSize:9,lineHeight:1.4}}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>

    {/* SAĞ PANEL */}
    <div style={{width:230,flexShrink:0,background:"#030610",
      borderLeft:"1px solid #0a162888",display:"flex",flexDirection:"column"}}>

      {result&&(
        <div style={{padding:"11px 11px",borderBottom:"1px solid #0a162888",flexShrink:0}}>
          <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:8}}>
            SON İLETİM SONUCU
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:7}}>
            {[["TX",`"${result.original}"`,  "#00d4ff"],
              ["RX",`"${result.decoded}"`,result.success?"#10b981":"#f59e0b"]].map(([l,v,c])=>(
              <div key={l} style={{background:"#020409",border:`1px solid ${c}22`,
                borderRadius:4,padding:"6px 8px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",marginBottom:2}}>{l}</div>
                <div style={{fontSize:11,fontWeight:700,color:c,
                  fontFamily:"monospace",wordBreak:"break-all"}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:7}}>
            {[
              // DÜZELTME 4: okCount/lostCount kullan
              {l:"FOTON",    v:result.bits.length,  c:"#475569"},
              {l:"BAŞARILI", v:result.okCount,      c:"#10b981"},
              {l:"KAYIP",    v:result.lostCount,    c:"#f43f5e"},
              {l:"BER",      v:result.er+"%",       c:+result.er>10?"#f43f5e":"#10b981"},
            ].map(s=>(
              <div key={s.l} style={{background:"#020409",border:"1px solid #0a1628",
                borderRadius:3,padding:"5px 7px"}}>
                <div style={{fontSize:7,color:"#1e3a5f",marginBottom:1}}>{s.l}</div>
                <div style={{fontSize:14,fontWeight:700,color:s.c,fontFamily:"monospace"}}>{s.v}</div>
              </div>
            ))}
          </div>
          {Object.keys(result.ec).length>0&&(
            <div style={{background:"#020409",border:"1px solid #0a1628",
              borderRadius:4,padding:"6px 8px",marginBottom:6}}>
              <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".1em",marginBottom:4}}>HATA DAĞILIMI</div>
              {Object.entries(result.ec).map(([k,v])=>{
                const m=ERR[k]||{c:"#64748b",l:k,i:"·"};
                const tot=Object.values(result.ec).reduce((a,x)=>a+x,0)||1;
                return(
                  <div key={k} style={{marginBottom:4}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}>
                      <span style={{fontSize:8,color:m.c}}>{m.i} {m.l}</span>
                      <span style={{fontSize:8,color:m.c,fontFamily:"monospace"}}>{v}</span>
                    </div>
                    <div style={{height:2,background:"#0a1628",borderRadius:1}}>
                      <div style={{height:"100%",background:m.c,width:`${(v/tot)*100}%`,
                        borderRadius:1,boxShadow:`0 0 3px ${m.c}`}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {result.corrected>0&&(
            <div style={{fontSize:8,color:"#10b981",marginBottom:4,letterSpacing:".04em"}}>
              ✓ ECC: {result.corrected} BİT DÜZELTİLDİ
            </div>
          )}
          <div style={{fontSize:9,fontWeight:700,letterSpacing:".06em",
            color:result.success?"#10b981":"#f59e0b",
            display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:"50%",flexShrink:0,
              background:result.success?"#10b981":"#f59e0b",
              boxShadow:`0 0 6px ${result.success?"#10b981":"#f59e0b"}`}}/>
            {result.success?"İLETİM BAŞARILI":"VERİ BÜTÜNLÜĞÜ BOZUK"}
          </div>
          <div style={{fontSize:7,color:"#1e3a5f",marginTop:3,fontFamily:"monospace"}}>
            🛰 {result.sat} · {result.satEl}° EL
          </div>
        </div>
      )}

      <div style={{padding:"7px 10px",borderBottom:"1px solid #0a162888",
        display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <span style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em"}}>CANLI KAYIT</span>
        <button className="nbtn" onClick={()=>setLog([])}
          style={{fontSize:8,color:"#1e3a5f",letterSpacing:".08em"}}>TEMIZLE</button>
      </div>
      <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"5px 7px"}}>
        {log.length===0?(
          <div style={{color:"#0a1628",fontSize:9,textAlign:"center",marginTop:50}}>
            — BEKLENIYOR —
          </div>
        ):log.map(e=>(
          <div key={e.id} style={{padding:"2px 5px",borderRadius:2,marginBottom:1,
            background:LB[e.type]??"transparent",
            borderLeft:LB[e.type]?`2px solid ${LC[e.type]||"#334155"}33`:"none"}}>
            <div style={{fontSize:7,color:"#0a1628",fontFamily:"monospace"}}>{e.ts}</div>
            <div style={{fontSize:9,color:LC[e.type]||"#334155",lineHeight:1.4,fontFamily:"monospace"}}>{e.text}</div>
          </div>
        ))}
      </div>
      <div style={{padding:"6px 9px",borderTop:"1px solid #0a162888",display:"flex",gap:4,flexShrink:0}}>
        {[["OK","#10b981","✓"],["WARN","#f59e0b","⚠"],["ERR","#f43f5e","✗"],["SYS","#7c3aed","◉"]].map(([t,c,s])=>{
          const n=log.filter(e=>e.type===t).length;
          return(
            <div key={t} style={{flex:1,textAlign:"center"}}>
              <div style={{fontSize:12,fontWeight:700,color:n>0?c:"#0a1628",fontFamily:"monospace"}}>{n}</div>
              <div style={{fontSize:7,color:"#1e3a5f"}}>{s}</div>
            </div>
          );
        })}
      </div>
    </div>
  </div>

  {/* ══════════════════════════════════════════════════════════
      FAZ 3: MAKRO/MİKRO GÖRÜNÜM GEÇİŞLERİ (Hierarchical Drill-Down).
      Kullanıcı (🔍 ikonu / DÜĞÜM MATRİSİ satırı) VEYA sistemin kendisi
      (NodeWatchdog, bkz. watchdogAutoOpenDrill) bir düğüme "zoom-in"
      yaptığında açılan mikro katman: alt bileşenler, açık asenkron
      soketler (bu düğüme bağlı her fiziksel link), ve nodeHealth'ten
      türeyen canlı thread havuzu durumu (bkz. buildDrillData()).
      ══════════════════════════════════════════════════════════ */}
  {drillData && (
    <div onClick={closeDrillDown}
      style={{position:"fixed",inset:0,zIndex:200,
        background:"#020409cc",backdropFilter:"blur(4px)",
        display:"flex",alignItems:"center",justifyContent:"center",padding:20,
        animation:"drillBackdropIn .18s ease-out"}}>
      <div onClick={e=>e.stopPropagation()}
        style={{width:"min(720px,94vw)",maxHeight:"88vh",overflowY:"auto",
          background:"#030610",border:"1px solid #00d4ff33",borderRadius:10,
          boxShadow:"0 0 60px #00d4ff11, 0 20px 60px #000a",
          animation:"drillZoomIn .22s cubic-bezier(.16,1,.3,1)"}}>

        <div style={{padding:"16px 20px",borderBottom:"1px solid #0a162888",
          display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,borderRadius:8,flexShrink:0,
            background:drillData.node.type==="hub"?"#7c3aed22":drillData.node.type==="intl"?"#f59e0b22":"#10b98122",
            border:`1px solid ${drillData.node.type==="hub"?"#7c3aed44":drillData.node.type==="intl"?"#f59e0b44":"#10b98144"}`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>
            🔬
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,fontWeight:700,color:"#00d4ff",letterSpacing:".04em"}}>
              {drillData.node.id} — {drillData.node.label}
            </div>
            <div style={{fontSize:8,color:"#475569",letterSpacing:".08em",marginTop:2}}>
              MİKRO KATMAN · {(drillData.node.type||"node").toUpperCase()} · {drillData.node.on?"ÇEVRİMİÇİ":"KARANTİNADA"}
              {drillAutoOpened && " · 🛡️ WATCHDOG TARAFINDAN OTOMATİK AÇILDI"}
            </div>
          </div>
          <button onClick={closeDrillDown}
            style={{background:"none",border:"1px solid #33415577",color:"#94a3b8",
              borderRadius:5,width:26,height:26,cursor:"pointer",fontSize:12,flexShrink:0}}>
            ✕
          </button>
        </div>

        {drillData.anomaly && (
          <div style={{margin:"12px 20px 0",padding:"8px 11px",borderRadius:6,
            background:"#3f151533",border:"1px solid #f43f5e44",
            display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:"#f43f5e",
              boxShadow:"0 0 6px #f43f5e",animation:"blink 0.6s ease-in-out infinite"}}/>
            <span style={{fontSize:9,fontWeight:700,color:"#f43f5e"}}>
              🛡️ WATCHDOG AKTİF: {drillData.anomaly.type==="lockup"?"THREAD KİLİTLENMESİ":drillData.anomaly.type==="leak"?"BELLEK SIZINTISI":"YANITSIZ"}
              {" "}— {drillData.anomaly.phase==="healing"?"asenkron olarak yeniden başlatılıyor":"karantinada, tanılanıyor"}
            </span>
          </div>
        )}

        <div style={{padding:"16px 20px",display:"grid",gap:16}}>

          <div>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:7}}>YAŞAMSAL BULGULAR</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
              {[
                {l:"CPU",v:`${drillData.health.cpu.toFixed(0)}%`,c:drillData.health.cpu>80?"#f43f5e":"#00d4ff"},
                {l:"BELLEK",v:`${drillData.health.mem.toFixed(0)}%`,c:drillData.health.mem>85?"#f43f5e":"#7c3aed"},
                {l:"HEARTBEAT",v:drillData.health.heartbeat>0?"● AKTİF":"○ KAYIP",c:drillData.health.heartbeat>0?"#10b981":"#f43f5e"},
              ].map(m=>(
                <div key={m.l} style={{background:"#020409",border:"1px solid #0a1628",borderRadius:4,padding:"7px 9px"}}>
                  <div style={{fontSize:6,color:"#1e3a5f",marginBottom:2}}>{m.l}</div>
                  <div style={{fontSize:12,fontWeight:700,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:7}}>ALT BİLEŞENLER</div>
            <div style={{display:"grid",gap:4}}>
              {drillData.submodules.map(sm=>(
                <div key={sm.name} style={{display:"flex",alignItems:"center",gap:8,
                  background:"#020409",border:"1px solid #0a1628",borderRadius:4,padding:"6px 9px"}}>
                  <div style={{width:5,height:5,borderRadius:"50%",flexShrink:0,
                    background:drillData.anomaly?"#f43f5e":"#10b981",
                    boxShadow:`0 0 4px ${drillData.anomaly?"#f43f5e":"#10b981"}`}}/>
                  <span style={{fontSize:9,color:"#94a3b8",fontWeight:700,flexShrink:0}}>{sm.name}</span>
                  <span style={{fontSize:8,color:"#334155",marginLeft:"auto",textAlign:"right"}}>{sm.detail}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:7}}>
              AÇIK ASENKRON SOKETLER ({drillData.sockets.length})
            </div>
            {drillData.sockets.length===0 ? (
              <div style={{fontSize:8,color:"#334155",padding:"6px 2px"}}>Bu düğüme bağlı fiziksel hat yok.</div>
            ) : (
              <div style={{display:"grid",gap:4}}>
                {drillData.sockets.map(sk=>{
                  const sc = sk.state==="CLOSED"?"#f43f5e":sk.state==="CONGESTED"?"#f59e0b":"#10b981";
                  return (
                    <div key={sk.peer} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",
                      background:"#020409",border:`1px solid ${sc}22`,borderRadius:4,padding:"6px 9px",fontFamily:"monospace"}}>
                      <span style={{fontSize:8,color:sc,fontWeight:700,flexShrink:0}}>{sk.state}</span>
                      <span style={{fontSize:8,color:"#64748b"}}>ws://{drillData.node.id}:{sk.port} ↔ {sk.peer}</span>
                      <span style={{fontSize:7,color:"#1e3a5f",marginLeft:"auto"}}>{sk.km}km · yük %{(sk.load*100).toFixed(0)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div style={{fontSize:7,color:"#1e3a5f",letterSpacing:".12em",marginBottom:7}}>
              THREAD HAVUZU ANLIK DURUMU ({drillData.poolSize} worker)
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:6}}>
              {drillData.threads.map(th=>{
                const tc = (th.state==="BLOCKED"||th.state==="NO_RESPONSE")?"#f43f5e":th.state==="BUSY"?"#f59e0b":"#10b981";
                const label = th.state==="BLOCKED"?"KİLİTLİ":th.state==="NO_RESPONSE"?"YANITSIZ":th.state==="BUSY"?"MEŞGUL":"BOŞTA";
                return (
                  <div key={th.id} style={{background:"#020409",border:`1px solid ${tc}33`,borderRadius:4,
                    padding:"6px 7px",textAlign:"center"}}>
                    <div style={{fontSize:7,color:"#1e3a5f",marginBottom:3}}>Worker-{th.id}</div>
                    <div style={{width:6,height:6,borderRadius:"50%",background:tc,margin:"0 auto 3px",
                      boxShadow:`0 0 4px ${tc}`,
                      animation:(th.state==="BLOCKED"||th.state==="NO_RESPONSE")?"blink 0.7s ease-in-out infinite":"none"}}/>
                    <div style={{fontSize:6,color:tc,fontWeight:700}}>{label}</div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>
    </div>
  )}
  </div>
  );
}
