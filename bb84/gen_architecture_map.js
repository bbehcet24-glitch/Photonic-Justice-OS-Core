#!/usr/bin/env node
"use strict";
/**
 * gen_architecture_map.js — PhotonNet katman haritası.
 *
 * Modül envanteri, dosyaların GERÇEK require kenarlarından çıkarıldı
 * (hafızadan değil). Satır sayıları ve öz-test sayıları koşum anında
 * dosyalardan/raporlardan OKUNUR — elle yazılmaz, böylece harita
 * bayatladığında sayılar da bayatlamaz, düzeltilir.
 *
 * FORM: katman yığını (bağımlılık yönü tek yönlü olduğu için ok
 * kalabalığı yerine sıralı kutular) + katman başına satır çubuğu.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const RAMP_L = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_D = ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#184f95"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

const DIR = __dirname;
const lines = (f) => { try { return fs.readFileSync(path.join(DIR, f), "utf-8").split("\n").length; } catch { return 0; } };
const checks = (r) => { try { const d = JSON.parse(fs.readFileSync(path.join(DIR, "reports", r), "utf-8")); return { n: d.checks?.length ?? 0, ok: !!d.allChecksPassed }; } catch { return null; } };

// ── KATMANLAR (require grafiğinden doğrulandı) ──
const LAYERS = [
  {
    id: "L0", name: "Çekirdek", tag: "değiştirilmedi",
    what: "Kriptografik ve ağ ilkelleri. Bu seansta TEK SATIRI değişmedi — üstteki her katman onu çağırdı, hiçbiri yeniden yazmadı.",
    gives: ["CascadeReconciliation", "QKDSecurityProof (Serfling + GLLP)", "Toeplitz gizlilik yükseltme", "OTP", "KeyPoolBuffer", "KeyDeliveryStore (ETSI 014)", "ClassicalAuthChannel (Wegman–Carter)", "NetworkTopology + routeCalculation", "LinkRiskReputationEngine", "mulberry32"],
    mods: [{ f: "photonnet_core.js", r: "tüm ilkeller" }],
  },
  {
    id: "L1", name: "Dolanıklık fiziği", tag: "bu seansta v2",
    what: "Bell-diyagonal durum cebiri, DEJMPS arıtma, akıllı kuantum bellek zamanlaması ve gerçek fiber fiziği. Verim %0,25 → %10,85.",
    gives: ["bellSwap (Pauli konvolüsyonu)", "dejmpsPurify / dejmpsPurifyAsym", "QuantumMemoryScheduler", "fiberTransmittance / fiberDelayMs", "phaseErrorForKm", "requiredLinkFidelity"],
    mods: [{ f: "entanglement_swap_scheduler.js", r: "v2 motor" }, { f: "entanglement_hom_fidelity_sim.js", r: "HOM görünürlüğü" }],
    tests: [{ f: "entanglement_swap_scheduler_test.js" }, { f: "entanglement_swap_concurrency_test.js" }, { f: "memory_technology_threshold_test.js" }, { f: "attenuation_sweep_test.js" }, { f: "entanglement_hom_fidelity_test.js" }],
  },
  {
    id: "L2", name: "Çok-atlamalı zincir", tag: "",
    what: "N segmentli zincir, takas politikaları ve segment başına gereken sadakatin türetilmesi. Takas SIRASI fark yaratmaz (Pauli konvolüsyonu değişmeli) — ölçülmüş negatif sonuç.",
    gives: ["simulateChain", "requiredSegmentFidelity", "zaman damgalı çift çıktısı (pair.t)"],
    mods: [{ f: "entanglement_multihop_router.js", r: "zincir + politika" }],
    tests: [{ f: "multihop_qkd_flow_test.js" }],
  },
  {
    id: "L3", name: "Ağ matrisi + paralel yönlendirme", tag: "",
    what: "Topoloji matrislere dökülür (bitişiklik, mesafe, kapasite, bağ sadakati); yollar sıralanır ve akış problemi olarak tahsis edilir. Tek yola göre ×2,48 çift kazancı.",
    gives: ["buildMatrices (A, D, C, Fe)", "enumeratePaths / describePath", "greedyAllocate + bruteForceAllocate", "edgeDisjointSets", "verifyWithMatrixPowers"],
    mods: [{ f: "quantum_network_matrix.js", r: "matris + tahsis" }],
    tests: [{ f: "network_matrix_routing_test.js" }, { f: "multipath_routing_test.js" }],
  },
  {
    id: "L4", name: "QKD protokol katmanı", tag: "baz-çözünürlü",
    what: "Dolanık çiftlerden anahtar. BBM92 ve E91/CHSH; anahtar Z bazından, faz kestirimi X bazından (karışık QBER kullanılmaz). Hibrit görev döngüsü baz eşleşme verimini yükseltir.",
    gives: ["measureBBM92 / runQkdFlow", "correlationMatrix / chshStandard / runE91Flow", "chshRoundsForSignificance", "bbm92BasisResolved / e91BasisResolved", "dutyCycleMeasure / optimalBias", "privacyAmplify (Toeplitz)"],
    mods: [
      { f: "qkd_over_entanglement.js", r: "BBM92 + E91/CHSH" },
      { f: "parallel_routing_qkd_rate_test.js", r: "baz-çözünürlü muhasebe (kütüphane)" },
      { f: "bb84_e91_duty_cycle.js", r: "yanlı baz + Bell döngüsü" },
    ],
    tests: [{ f: "qkd_at_limit_test.js" }, { f: "duty_cycle_test.js", rep: "duty_cycle.json" }],
    reps: ["parallel_routing_qkd_rate.json"],
  },
  {
    id: "L5", name: "Oturum kontrolcüsü", tag: "türetilmiş kurallar",
    what: "Bloğu ne zaman kapatmalı, hangi yolu havuza almalı, Bell sertifikası nasıl sürdürülmeli. Hiçbir sabit sayı yok: kapanış ℓ′(T)=ℓ(T)/T tepe koşulundan, kabul e*=ē+(1−h₂(ē))/log₂((1−ē)/ē) teğetinden türetilir.",
    gives: ["SessionController (marjinal kural + SLA)", "admissionThreshold / admissionDelta", "predictEll (Cascade'siz öngörücü)", "chshProbe + runHybridSession", "runContinuous (ardışık bloklar)"],
    mods: [{ f: "qkd_session_controller.js", r: "kapanış + kabul + monitör" }, { f: "continuous_stream_test.js", r: "durağan akış üreteci (kütüphane)" }],
    tests: [{ f: "qkd_session_controller_test.js", rep: "qkd_session_controller.json" }, { f: "sla_ceiling_test.js", rep: "sla_ceiling.json" }],
    reps: ["continuous_stream.json"],
  },
  {
    id: "L5.5", name: "Tahminsel jitter hizalama", tag: "yeni · öngörücü",
    what: "Hatlar arası zamanlama fluluğunu (skew/drift/termal) çevrimiçi Kalman saat kestiricisiyle önceden öğrenip ön-beslemeli düzeltir — PTP/GPS disiplininin yerleşik tekniği. async_sync'in bulduğu canlı-kilit uçurumunu kaldırır: bir zaman-penceresi alıcısı bile drift altında %0 drop. Dürüst sınır: yalnız öngörülebilir yapıyı siler, saf jitter'da yapı uydurmaz.",
    gives: ["JitterPredictor (constant-velocity Kalman)", "makeSkewSource", "runAligned (ön-besleme + artık ölçümü)", "measureRecovery + calibrateQForSteps (ölçülü q ayarı, sabit sayı yok)"],
    mods: [{ f: "predictive_jitter_alignment.js", r: "Kalman kestirici + hizalama" }],
    tests: [{ f: "predictive_jitter_test.js", rep: "predictive_jitter.json" }],
  },
  {
    id: "L5.6", name: "Kuantum geciktirme hattı (ODLS)", tag: "yeni · optik tampon",
    what: "Predictor'ın 9-adımlık geçiş evresinde pencereyi aşan paketleri düşürmek yerine recirculating fiber döngüde (2×2 anahtar) geçici DONDURUP toparlanınca bırakır. Ama bedava değil: fiberde ışığı tutmanın kaçınılmaz bedeli α·v=40,8 dB/ms — 3 dB bütçe ⇒ en çok ~73 μs. İki bütçe farklı ölçekte bağlar: μs fiber döngüde KAYIP, ms gerçek kuantum bellekte FAZ. Ayar: döngüyü pencereye eşle (n=1) → anahtar ek yükü en az. Sonuç: %100 zaman-aşımı kaybı → bütçesi ayarlı ~%42 insertion-loss; sadakat Bell üstünde. L5.5'in μs hızı ODLS'nin ön koşulu.",
    gives: ["OpticalDelayLine (hold / lossBudget / phaseBudget / budget)", "bridgeTransient (geçiş köprüleme)", "tuneLoopForWindow (kayıp ayrışması: fiber tabanı + anahtar)", "MEDIA + mediumFloor (α·v taban karşılaştırması)", "provisionOdls (adım + ortam → tam tanı, fizibilite bayrağı)"],
    mods: [{ f: "optical_delay_line.js", r: "optik tampon + bütçe ayarı" }],
    tests: [{ f: "optical_delay_line_test.js", rep: "optical_delay_line.json" }, { f: "odls_provision_test.js", rep: "odls_provision.json" }],
  },
  {
    id: "L6", name: "Anahtar tedariki ve geri-basınç", tag: "geçmiş budama",
    what: "Üretim gecikmesini teslim gecikmesinden ayıran depo, ve depo doluluğunu üretime geri besleyen geri-basınç. Tüketici gecikmesi 0 ms; israf %34,9 → %0. Histerezis bandı φ_high boyunca ölçüldü (monoton değil, φ≈0,60–0,70'te tepe). Durum şişirmesi tatbikatı geçmiş sızıntısını buldu: tahsis artık tüketilen kaydı budar (byRoute sınırlı, denetim sayacı monoton korunur).",
    gives: ["runElastic (elastik pencere)", "KeyAllocator (budamalı — core KeyDeliveryStore üstünde)", "runTieredSupply", "requiredStoreBits (D·T_b + 3σ)", "ProductionThrottle + bant kuralı", "recommendPhiHigh (φ = 0,80)", "recommendHysteresis (ölçülü harita + ara değer)", "provisionForRate (tahliye tavanı = M·P/E)"],
    mods: [{ f: "qkd_key_supply.js", r: "depo + tahsis (budamalı)" }, { f: "qkd_backpressure.js", r: "throttle + histerezis" }],
    tests: [{ f: "key_supply_test.js", rep: "key_supply.json" }, { f: "backpressure_test.js", rep: "backpressure.json" }, { f: "phi_high_tuning_test.js", rep: "phi_high_tuning.json" }, { f: "hysteresis_band_test.js", rep: "hysteresis_band.json" }],
    docs: ["docs/PHI_HIGH.md"],
  },
  {
    id: "L7", name: "Dış entegrasyon", tag: "O(1) + idempotent resync",
    what: "Üretilen anahtarın sistem dışına taşınması: ETSI GS QKD 014 KME sunucusu, IBM mTLS istemcisi, QKDNetSim trafik köprüsü. KME deposu artık key_ID→Map indeksi (dec O(n)→O(1), ×455) ve içe aktarım birleştirmeli (resync uçuştaki teslimi ezmiyor, çift teslim yok).",
    gives: ["ETSI 014 enc_keys / dec_keys (Map indeksi)", "loadFromExport (idempotent/merge)", "mTLS + sertifika rotasyonu/iptali", "QKDNetSim profil köprüsü"],
    mods: [{ f: "etsi014_kme_server.js", r: "KME sunucusu (Map + merge)" }, { f: "mock_ibm_client.js", r: "IBM mTLS istemcisi" }, { f: "qkdnetsim_traffic_bridge.js", r: "QKDNetSim köprüsü" }, { f: "build_production_server.js", r: "üretim derlemesi" }],
    tests: [{ f: "buffer_starvation_test.js" }, { f: "ibm_math_audit.js" }, { f: "etsi014_faz0_client.js", rep: "etsi014_faz0.json" }],
  },
];

// ── KIRMIZI TAKIM TATBİKATLARI (katmanlara dik, canlı sistem üzerinde) ──
// Kurul senaryolarının uçtan uca koşumu. Her biri bir tehdit modeli
// ölçüp ya mimarinin bağışıklığını kanıtlar ya da bir açık bulup katmanda
// (çekirdeğe dokunmadan) kapatır. Öz-test sayımına dahil edilir.
const DRILLS = [
  { f: "fidelity_collapse_drill.js", rep: "fidelity_collapse_drill.json",
    what: "Sadakat çöküşü: F %98,2→%84,5 pik yükte. Tanı ölçümle — kapasite olayı, güvenlik değil (S=2,39 ayakta); bant sanık değil; tek etkili kol yük atma. Üç 'bariz' düzeltme çürütüldü." },
  { f: "state_poisoning_drill.js", rep: "state_poisoning.json",
    what: "Durum şişirmesi: geçerli mikro-isteklerle geçmiş sızıntısı (+1 kayıt/işlem, heap sınırsız) ve KME O(n) taraması. İkisi de katmanda kapatıldı; kritik eşik ölçüldü (düzeltmesiz kararlı çizgiye oturmuyor)." },
  { f: "async_sync_drill.js", rep: "async_sync.json",
    what: "Asimetrik senkronizasyon: skew/jitter/drift. Zaman-penceresi tasarımı 0,40 ms/paket driftinde canlı-kilide giriyor; durum-tabanlı mimari bağışık. Resync idempotensi açığı bulundu ve kapatıldı (merge)." },
  { f: "resonance_drill.js", rep: "resonance.json",
    what: "Kararlılık sınırı rezonansı: dengeleme döngüsü doğal frekansında (f_r≈0,06 Hz) sürüldü. Bang-bang röle döngüsü kenetli — genlik büyümüyor, anahtarlama blok ritmine doyuyor (keskin Q-tepesi yok). Histerezis bandı geçiş yükünü sınırlıyor; 'ζ<1 ⇒ felaket' varsayımı ölçümle çürütüldü." },
  { f: "layer_stress_campaign.js", rep: "layer_stress.json",
    what: "Yedi katmanın hepsi uçtan uca kırılma noktasına kadar zorlandı: L1 fiber duvarı (~40 km), L2 atlama duvarı (30), L3 doygunlukta kenar aşımı yok, L4 QBER/sonlu-anahtar (ℓ asla negatif), L5 kabul eşiği bıçak sırtı, L6 ×10 talep, L7 churn. Hepsi zarifçe bozuluyor; çekirdek SHA-256 değişmedi. KME enc'te O(n)→O(1) açığı bulunup kapatıldı." },
  { f: "landauer_choke_drill.js", rep: "landauer_choke.json",
    what: "Radyatif bilgi tıkanması (THz FSO uydu hattı): naif düğüm gelen her biti soğuk belleğe yazıp silince ısınıp saf→karışık çöküyor. Landauer tabanı bağlayıcı değil (gerçek dağılımın ×5·10¹¹ altında). PhotonNet entropiyi ısıya değil IŞIĞA veriyor: reddi soğuğa yazmadan ele (sifting %50 sıcakta), tutulanı sinyal olarak dışa aktar (%50), girişi tahliye hızına kıs (geri-basınç) → saflık taban sabit. Gerçek k_B + motorun ölçülü oranları." },
  { f: "safety_margin_drill.js", rep: "safety_margin.json",
    what: "İki eleştiri ölçüldü: (1) 'güvenlik payı %0' YANLIŞ — döngü e_ph ×6 ve üretim −%40 sapmayı platoyla yutuyor (ret %11,8→%12,3); kırılganlığı yaratan tek şey histerezis bandını KALDIRMAK. (2) '50 Gbit/s kelepçe, %99,5 israf' — 50 Gbit/s tek-pipeline tavanı, çoğullamayla (M) doğrusal ölçekleniyor (10 THz için M=200); girişin %50'si kaçınılmaz protokol elemesi. Düzeltme: provisionForRate() (qkd_key_supply)." },
  { f: "timetag_acquisition_test.js", rep: "timetag_acquisition.json",
    what: "Yol haritası Faz 1 — ACQUISITION KÖPRÜSÜ prototipi: bir time-tagger'ın ps zaman-etiketli ham dedektör tıklama akışını (gerçek kusurlarla — verim, karanlık sayım, jitter, ölü zaman) koinsidans pencereleme + sifting ile elenmiş anahtara çevirir. Ölçülen: QBER SABİT DEĞİL, dedektör fiziğinden türer (karanlık sayım %1e-4→%8e-3 ile QBER %1,0→%5,1); koinsidans penceresi verim↔QBER frontier'ı (dar temiz/az, geniş bol/gürültülü); intercept-resend casusu → QBER ~%26 → %11 eşiğini aşar → anahtar İPTAL (ölçünce-boz güvenliği gerçekçi veride korunuyor). QRNG seam: Alice anahtar seçimi crypto entropiden (mulberry32 DEĞİL; QBER RNG'den bağımsız), üretimde donanım QRNG buraya takılır. Elenmiş bitler Faz 0 KME export biçimine paketlenir. Dürüst sınır: emülatör gürültü modeli; Faz 3 gerçek dedektör verisiyle kalibre eder." },
  { f: "timing_coincidence_test.js", rep: "timing_coincidence.json",
    what: "Yol haritası Faz 2 — ZAMANLAMA & KOİNSİDANS MOTORU: L5.5 (Kalman saat kurtarma) + L5.6 (ODLS) acquisition hattına bağlanıp Alice/Bob SAAT KAYMASI problemine karşı sınandı ('model gerçekle yüzleşti'). Ölçülen: düzeltilmemiş drift yuvaları kaydırıp QBER'i %1→%22,6'ya fırlatıyor (bir CASUS SANILABİLİR ama senkronizasyon sorunu) + verim çöküyor; L5.5 Kalman saat disiplini ön-beslemeli düzeltmeyle QBER'i fizik tabanına (%1,0) indiriyor ve verimi geri getiriyor (drift'i saldırıdan AYIRIR); ama GERÇEK casus kurtarma açıkken bile %26,6'da kalıyor → MASKELEMİYOR (güvenlik korunur); ani saat sıçraması (resync) transient'i (400 slot/0,4 μs ≪ 73 μs) ODLS bütçesinde köprüleniyor → geçiş kaybı 0. Çekirdek değişmedi." },
  { f: "odls_optimization_drill.js", rep: "odls_optimization.json",
    what: "ODLS taban kaybını (α·v·tutma) düşürmenin iki yolu ölçüldü. İZ 1 (PJA'yı agresifleştir): 9→5 adım tutmayı 54→30 μs, tabanı 2,21→1,23 dB'ye indirir (doğrusal), uçurum payını ×2,2 açar — dar-pencere bedeli yalnız %1,3, nerdeyse bedava; ama sweet-spot ~5 adım (ötesinde bedel süper-doğrusal, model tabanı 2 adım). İZ 2 (ortam) önermesi TERS: depolamada dB/METRE değil dB/ZAMAN=α·v önemli; SMF zaten 0,0002 dB/m (en düşük), Si₃N₄ çip 0,1 dB/m → taban ×386 KÖTÜ (çip ayak izinde kazanır). Tabanı gerçekten düşüren: hollow-core NANF ×1,7. Kriyo silika α'sını açmaz (Rayleigh donmuş); payı kuantum bellek T2'sinde — o da tabanı büsbütün aşar ama faz/T2 duvarına çarpar. Sentez: 5-adım PJA × hollow-core → sağkalım %58→%82." },
];

const CROSS = [
  {
    name: "Güvenlik denetimi ve saldırı benzetimi", col: "var(--k2)",
    what: "Katmanlara dik kesen doğrulama: bağımsız yeniden hesaplanabilir üretim denetimi, QBER tırmanma saldırıları, gürültü kalibrasyonu sertleştirme.",
    mods: ["production_security_audit.js", "attack_simulation_qber_escalation.js", "god_mode_ragnarok_attack_omega_v4.js", "god_mode_ragnarok_attack_omega_v3.js", "god_mode_ragnarok_attack_omega.js", "god_mode_ragnarok_attack_real.js", "god_mode_ragnarok_attack.js", "noise_calibration_hardening_test.js", "noise_calibration_wiring_test.js", "noise_matrix_validate.js", "link_reputation_engine_test.js"],
  },
  {
    name: "Raporlama ve görselleştirme", col: "var(--k3)",
    what: "Her katmanın çıktısı için tek dosyalık, açık/karanlık modlu, palet doğrulamalı görseller ve istemci raporları.",
    mods: ["client_network_report.js", "gen_client_report_html.js", "gen_entanglement_charts.js", "gen_memory_threshold_chart.js", "gen_qkd_flow_chart.js", "gen_attenuation_chart.js", "gen_qkd_limit_chart.js", "gen_network_routing_chart.js", "gen_qkd_rate_chart.js", "gen_controller_chart.js", "gen_continuous_chart.js", "gen_ceiling_chart.js", "gen_key_supply_chart.js", "gen_duty_cycle_chart.js", "gen_backpressure_chart.js", "gen_hysteresis_band_chart.js", "gen_collapse_drill_chart.js", "gen_state_poisoning_chart.js", "gen_async_sync_chart.js", "gen_resonance_chart.js", "gen_layer_stress_chart.js", "gen_landauer_chart.js", "gen_safety_margin_chart.js", "gen_predictive_jitter_chart.js", "gen_optical_delay_line_chart.js", "gen_odls_optimization_chart.js", "gen_timetag_acquisition_chart.js", "gen_timing_coincidence_chart.js", "gen_qkdnetsim_bridge_report_html.js", "gen_architecture_map.js"],
  },
];

function build() {
  // ── canlı sayılar ──
  for (const L of LAYERS) {
    L.modLines = L.mods.reduce((s, m) => s + (m.lines = lines(m.f)), 0);
    L.testLines = (L.tests ?? []).reduce((s, t) => s + (t.lines = lines(t.f)), 0);
    for (const t of L.tests ?? []) if (t.rep) t.checks = checks(t.rep);
    // `reps`: o katmana ait ama testi başka katmanda duran raporlar.
    // İlk kurguda bunlar toplama GİRMİYORDU ve başlık 73/73 diyordu —
    // oysa rapor üreten testlerdeki toplam kontrol 103'tü.
    L.extraChecks = (L.reps ?? []).map(checks).filter(Boolean);
    L.checkCount = (L.tests ?? []).reduce((s, t) => s + (t.checks?.n ?? 0), 0) +
      L.extraChecks.reduce((s, c) => s + c.n, 0);
    L.checkOk = [...(L.tests ?? []).map(t => t.checks), ...L.extraChecks].filter(Boolean).every(c => c.ok);
  }
  for (const C of CROSS) C.modLines = C.mods.reduce((s, m) => s + lines(m), 0);
  // Tatbikatlar: satır + rapor kontrolleri.
  for (const D of DRILLS) { D.lines = lines(D.f); D.checks = checks(D.rep); }
  const drillLines = DRILLS.reduce((s, D) => s + D.lines, 0);

  const coreLines = LAYERS[0].modLines;
  const stackLines = LAYERS.slice(1).reduce((s, L) => s + L.modLines + L.testLines, 0);
  const crossLines = CROSS.reduce((s, c) => s + c.modLines, 0);
  const layerChecks = LAYERS.flatMap(L => [...(L.tests ?? []).map(t => t.checks), ...(L.extraChecks ?? [])].filter(Boolean));
  const drillChecks = DRILLS.map(D => D.checks).filter(Boolean);
  const allChecks = [...layerChecks, ...drillChecks];
  const totalChecks = allChecks.reduce((s, c) => s + c.n, 0);
  const allPass = allChecks.every(c => c.ok);
  const reportCount = allChecks.length;

  // ── katman başına satır çubuğu (çekirdek hariç: ölçeği ezerdi) ──
  const stack = LAYERS.slice(1);
  const BW = 300, maxL = Math.max(...stack.map(L => L.modLines + L.testLines));

  const layerCards = LAYERS.map((L, i) => {
    const isCore = i === 0;
    const bar = isCore ? "" : `<div class="bar"><span style="width:${(100 * (L.modLines + L.testLines) / maxL).toFixed(1)}%;background:var(--s${Math.min(5, i)})"></span></div>`;
    const mods = L.mods.map(m => `<span class="chip"><b>${esc(m.f)}</b> <i>${esc(m.r)}</i> <u>${tr(m.lines)}</u></span>`).join("");
    const tests = (L.tests ?? []).map(t =>
      `<span class="chip t">${esc(t.f)}${t.checks ? ` <u>${t.checks.n} test ${t.checks.ok ? "✓" : "✗"}</u>` : ""}</span>`).join("");
    const docs = (L.docs ?? []).map(d => `<span class="chip d">${esc(d)}</span>`).join("");
    const reps = (L.reps ?? []).map((r, i) => `<span class="chip t">${esc(r)} <u>${L.extraChecks[i]?.n ?? 0} test ${L.extraChecks[i]?.ok ? "✓" : "✗"}</u></span>`).join("");
    return `<div class="layer${isCore ? " core" : ""}">
      <div class="lhead"><span class="lid">${L.id}</span><span class="lname">${esc(L.name)}</span>
        ${L.tag ? `<span class="ltag">${esc(L.tag)}</span>` : ""}
        <span class="lloc">${tr(L.modLines + L.testLines)} satır</span></div>
      ${bar}
      <p class="lwhat">${esc(L.what)}</p>
      <div class="gives">${L.gives.map(g => `<code>${esc(g)}</code>`).join("")}</div>
      <div class="chips">${mods}${tests}${reps}${docs}</div>
    </div>`;
  }).reverse().join('<div class="arrow">▲ çağırır</div>');

  const crossCards = CROSS.map(c => `<div class="cross" style="border-left-color:${c.col}">
    <div class="chead">${esc(c.name)} <span class="lloc">${tr(c.modLines)} satır · ${c.mods.length} dosya</span></div>
    <p class="lwhat">${esc(c.what)}</p>
    <div class="chips">${c.mods.map(m => `<span class="chip s">${esc(m)} <u>${tr(lines(m))}</u></span>`).join("")}</div>
  </div>`).join("");

  const drillCards = DRILLS.map(D => `<div class="cross" style="border-left-color:var(--k2)">
    <div class="chead">${esc(D.f)} <span class="lloc">${tr(D.lines)} satır${D.checks ? ` · ${D.checks.n} test ${D.checks.ok ? "✓" : "✗"}` : ""}</span></div>
    <p class="lwhat">${esc(D.what)}</p>
  </div>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PhotonNet — katman haritası</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e6e5e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;--muted-mark:#c9c8c2;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};
    --s1:${RAMP_L[0]};--s2:${RAMP_L[1]};--s3:${RAMP_L[2]};--s4:${RAMP_L[3]};--s5:${RAMP_L[4]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 40px;max-width:920px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:34px 0 8px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:96px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  .layer{background:var(--surface-2);border-radius:11px;padding:13px 16px 14px;margin:0;}
  .layer.core{background:var(--surface-3);}
  .lhead{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}
  .lid{font-size:11px;font-weight:720;color:var(--k1);letter-spacing:0.04em;}
  .lname{font-size:14.5px;font-weight:660;}
  .ltag{font-size:10px;background:var(--k1);color:#fff;border-radius:4px;padding:2px 6px;font-weight:600;}
  .lloc{margin-left:auto;font-size:11px;color:var(--text-muted);}
  .bar{height:5px;background:var(--grid);border-radius:3px;margin:9px 0 2px;overflow:hidden;}
  .bar span{display:block;height:100%;border-radius:3px;}
  .lwhat{font-size:12.5px;color:var(--text-secondary);line-height:1.55;margin:7px 0 8px;}
  .gives{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px;}
  .gives code{font-size:10.5px;background:var(--surface-1);border:1px solid var(--grid);border-radius:5px;padding:2px 7px;color:var(--text-primary);}
  .chips{display:flex;flex-wrap:wrap;gap:5px;}
  .chip{font-size:10.5px;background:var(--surface-1);border-radius:5px;padding:3px 8px;color:var(--text-secondary);border-left:3px solid var(--k1);}
  .chip.t{border-left-color:var(--k3);} .chip.d{border-left-color:var(--k2);} .chip.s{border-left-color:var(--muted-mark);}
  .chip b{font-weight:620;color:var(--text-primary);}
  .chip i{font-style:normal;color:var(--text-muted);}
  .chip u{text-decoration:none;color:var(--text-muted);font-variant-numeric:tabular-nums;}
  .arrow{text-align:center;font-size:10.5px;color:var(--text-muted);padding:5px 0;letter-spacing:0.06em;}
  .cross{background:var(--surface-2);border-left:3px solid var(--k2);border-radius:0 9px 9px 0;padding:11px 15px;margin-bottom:9px;}
  .chead{display:flex;align-items:baseline;font-size:13.5px;font-weight:640;}
  .callout{border-left:3px solid var(--k2);background:var(--surface-2);padding:11px 15px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:14px 0 0;}
  .callout.ok{border-left-color:var(--k1);}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
  details{margin-top:16px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">

<h1>PhotonNet — katman haritası</h1>
<p class="sub">Envanter hafızadan değil, dosyaların <b>gerçek require kenarlarından</b> çıkarıldı; satır ve öz-test sayıları koşum anında dosyalardan ve raporlardan okunuyor. Bağımlılık yönü tek yönlü: her katman yalnızca altındakileri çağırıyor.</p>

<div class="tiles">
  <div class="tile"><div class="l">katman</div><div class="v">${LAYERS.length}</div></div>
  <div class="tile"><div class="l">çekirdek (dokunulmadı)</div><div class="v">${tr(coreLines)}</div></div>
  <div class="tile"><div class="l">üstteki yığın</div><div class="v">${tr(stackLines)}</div></div>
  <div class="tile"><div class="l">dik kesen + tatbikat</div><div class="v">${tr(crossLines + drillLines)}</div></div>
  <div class="tile"><div class="l">öz-test (${reportCount} rapor)</div><div class="v">${allPass ? `<span style="color:var(--k1)">${totalChecks}/${totalChecks}</span>` : totalChecks}</div></div>
</div>

<h2>Yığın — aşağıdan yukarı</h2>
${layerCards}

<h2>Katmanlara dik kesenler</h2>
${crossCards}

<h2>Kırmızı takım tatbikatları <span class="lloc" style="font-weight:400">${tr(drillLines)} satır · canlı sistem üzerinde</span></h2>
<p class="sub">Kurul senaryolarının uçtan uca koşumu. Her tatbikat bir tehdit modelini ölçer; ya mimarinin bağışıklığını kanıtlar ya da bir açık bulup katmanda — çekirdeğe dokunmadan — kapatır. Öz-test sayısına dahildir.</p>
${drillCards}

<div class="callout ok"><b>Bu seansta değişmeyen şey:</b> <code>photonnet_core.js</code>'in tek satırı. Cascade, Serfling/GLLP sonlu-anahtar kanıtı, Toeplitz, OTP, ETSI-014 <code>KeyDeliveryStore</code>, Wegman–Carter kimlik doğrulaması, topoloji ve rota hesabı — hepsi <b>çağrıldı, yeniden yazılmadı</b>. Yeni davranışlar hep üstüne kondu. Örneğin depo tahsis politikası çekirdeğin <code>KeyDeliveryStore</code>'unun üstüne yazıldı, o sınıf değiştirilmedi.</div>

<div class="callout"><b>Dürüst yapısal not — iki dosya adı yalan söylüyor.</b> <code>parallel_routing_qkd_rate_test.js</code> ve <code>continuous_stream_test.js</code> adlarında "test" geçiyor ama artık <b>kütüphane</b> olarak kullanılıyorlar: birincisini 5, ikincisini 4 modül <code>require</code> ediyor (baz-çözünürlü muhasebe ve durağan akış üreteci oradan geliyor). Bu, testten kütüphaneye kaymış kod — çalışıyor ama adlandırma yanıltıcı. Temizlenecekse iki fonksiyon ayrı modüllere taşınmalı; <b>şimdi taşımadım</b>, çünkü 8 dosyanın import'unu değiştirmek bu haritanın kapsamı dışında ve tek başına bir commit hak ediyor.</div>

<h2>Katman özeti</h2>
<table><thead><tr><th>Katman</th><th>Modül</th><th>Test</th><th>Satır</th><th>Öz-test</th><th>Ne ekledi</th></tr></thead><tbody>
${LAYERS.map(L => `<tr><td><b>${L.id}</b> ${esc(L.name)}</td><td>${L.mods.length}</td><td>${(L.tests ?? []).length}</td><td>${tr(L.modLines + L.testLines)}</td><td>${L.checkCount || "—"}</td><td>${esc(L.gives.slice(0, 2).join(", "))}…</td></tr>`).join("")}
</tbody></table>

<details>
<summary>Bu seansın commit'leri (yeniden eskiye)</summary>
<table><thead><tr><th>Commit</th><th>Ne</th></tr></thead><tbody>
${[
    ["2bd948d", "güvenlik payı + bant genişliği illüzyonu — iki eleştiri çürütüldü, provisionForRate"],
    ["cdc0193", "radyatif bilgi tıkanması — entropi ısıya değil ışığa; saflık sabit"],
    ["aeaeae5", "katman stres kampanyası — 7 katman kırılma noktasına; KME enc O(n)→O(1)"],
    ["e794e03", "kararlılık sınırı rezonansı tatbikatı — röle döngüsü kenetli, felaket yok"],
    ["146b878", "katman haritası güncellendi — oturumun düzeltmeleri ve tatbikatları"],
    ["cb1a0c2", "asimetrik senkronizasyon tatbikatı — resync idempotensi açığı kapatıldı (merge)"],
    ["7bf8b9a", "durum şişirmesi tatbikatı — geçmiş sızıntısı budandı + KME O(1) indeks"],
    ["a024fc4", "sadakat çöküşü tatbikatı — kapasite olayı tanısı, üç düzeltme çürütüldü"],
    ["682bfca", "histerezis bandı 0,60/0,70 tarandı — bant monoton değil, harita düzeltildi"],
    ["3fa0f4b", "histerezis bandı φ=0,85 için tarandı (h=0,04)"],
    ["3064bc7", "histerezis bandı üç profilde ölçüldü — profile bağlı"],
    ["55b3b2e", "histerezis bandı gerekçelendirildi — iki eşik açık"],
    ["6d7d59a", "sistem katman haritası üreteci"],
    ["8d303df", "φ_high üretim ayarı sabitlendi ve dokümante edildi (0,80)"],
    ["02c1a5e", "depo doluluğuna göre üretim geri-basıncı (backpressure/throttling)"],
    ["9a299b3", "BB84/E91 hibrit görev döngüsü — yanlı baz + Bell sertifikası"],
    ["237e3db", "ultra-düşük gecikme — elastik pencere ve anahtar deposu"],
    ["5cd40d6", "SLA 10 s'ye uzatıldı — tavana yaklaşma ölçüldü ve modellendi"],
    ["57edf74", "kontrolcünün sürekli akışta uçtan uca koşumu"],
    ["8ede938", "QKD oturum kontrolcüsü — kapanış kuralı, kabul eşiği, Bell monitörü"],
    ["6b5b57f", "paralel yönlendirme kazancının R_key'e etkisi (BBM92 + E91)"],
    ["b27f782", "ağ matrisi + paralel yönlendirme görseli"],
    ["255e6b2", "ağ yapısını matrise dök + paralel yönlendirme (×2,48)"],
    ["63e3340", "52 km sınırında QKD grafiği"],
    ["4dc8ca9", "E91 + CHSH Bell testi; 52 km'de BBM92 ve E91 anahtar üretimi"],
    ["8b3bec8", "kanal zayıflama (α) taraması + DEJMPS tur maliyeti"],
    ["6f1fd7e", "23.994 çiftlik QKD akışının grafiği"],
    ["7dccea7", "üçüncü düğüm + dinamik kuantum yönlendirme + üst katmanda QKD"],
    ["4425a6c", "bellek teknolojisi ↔ kritik mesafe eşiği; zamanlayıcıda 3 hata"],
    ["ad4eb3d", "dolanıklık-takası motoru v2 (verim %0,25 → %10,85)"],
    ["bf5df45", "QKDNetSim trafik profili + derleme talimatları"],
    ["cad5912", "sertifika rotasyon/iptal + IBM mTLS koşum raporları"],
    ["60c121d", "istemci ağ raporu aracı yeniden yazıldı"],
    ["65b460a", "dolanıklık-swap eşzamanlılık + arıtma stres testi"],
    ["8f36452", "konteyner sıfırlanması sonrası kurtarma"],
  ].map(([h, m]) => `<tr><td><code>${h}</code></td><td>${esc(m)}</td></tr>`).join("")}
</tbody></table>
</details>

<p class="note"><b>Okuma sırası:</b> L0 ilkelleri verir; L1 dolanık çift üretir; L2 çifti zincir boyunca taşır; L3 hangi yollardan kaç çift geleceğine karar verir; L4 çifti anahtara çevirir; L5 bloğun ne zaman kapanacağına ve hangi yolun havuza gireceğine karar verir; L6 anahtarı depolayıp tüketiciye sıfır gecikmeyle servis eder ve doluluğu üretime geri besler; L7 anahtarı sistem dışına taşır. Dik kesen iki katman (güvenlik denetimi, raporlama) her seviyeye bağlanır.</p>

</div></body></html>`;
}

if (require.main === module) {
  const outPath = process.argv[2] || "/tmp/photonnet_architecture.html";
  fs.writeFileSync(outPath, build());
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
