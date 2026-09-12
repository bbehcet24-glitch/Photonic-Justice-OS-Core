# PhotonNet — BB84 Kuantum Anahtar Dağıtımı (QKD) Simülatörü ve Üretim Katmanları

Bu depo, BB84 (ve destekleyici E91/BBM92) protokolünü uçtan uca simüle eden bir
React tabanlı çekirdek fizik/kriptografi motoru (`PhotonNet2.jsx` →
`bb84/photonnet_core.js`) ile bu çekirdeğin etrafına **çekirdeğe hiç
dokunmadan** inşa edilmiş onlarca "köprü/katman" (bridge/layer) modülünden
oluşur: gerçekçi donanım gürültü modelleri, ağ yönlendirme/dolanıklık
mantığı, ETSI GS QKD 014 uyumlu bir KME sunucusu, mTLS/PKI altyapısı,
saldırı/stres tatbikatları ve bir Python donanım-soyutlama katmanı (HAL).

Projenin en belirgin özelliği **titiz teknik dürüstlük** kültürüdür: hemen
hemen her dosya, ne yaptığını olduğu gibi, ne YAPMADIĞINI da açıkça (çoğu
zaman "DÜRÜSTLÜK NOTU" / "KAPSAM NOTU" başlığıyla) belirtir. Bu README de
aynı disiplinle yazılmıştır — hiçbir modül "her şeyi çözüyor" gibi
sunulmamıştır.

---

## İçindekiler

1. [Bu proje gerçekte nedir — ve NE DEĞİLDİR](#1-bu-proje-gerçekte-nedir--ve-ne-değildir)
2. [Mimari: çekirdek + dokunulmaz katman deseni](#2-mimari-çekirdek--dokunulmaz-katman-deseni)
3. [Çekirdek motor (`photonnet_core.js`) içeriği](#3-çekirdek-motor-photonnet_corejs-içeriği)
4. [Modül envanteri — kategori bazlı, TÜM dosyalar](#4-modül-envanteri--kategori-bazlı-tüm-dosyalar)
   - 4.1 [Fiziksel katman / zamanlama / donanım gerçekçiliği](#41-fiziksel-katman--zamanlama--donanım-gerçekçiliği)
   - 4.2 [Ağ / yönlendirme / dolanıklık (entanglement) katmanı](#42-ağ--yönlendirme--dolanıklık-entanglement-katmanı)
   - 4.3 [Güvenlik / protokol / ETSI-014 / PKI katmanı](#43-güvenlik--protokol--etsi-014--pki-katmanı)
   - 4.4 [Saldırı / stres / adversarial test katmanı](#44-saldırı--stres--adversarial-test-katmanı)
   - 4.5 [Araçlar, build, CI/CD](#45-araçlar-build-cicd)
   - 4.6 [HAL — Python donanım soyutlama katmanı](#46-hal--python-donanım-soyutlama-katmanı)
   - 4.7 [Grafik üreticileri (`gen_*.js`)](#47-grafik-üreticileri-gen_js)
   - 4.8 [Kök seviyesi uygulama dosyaları](#48-kök-seviyesi-uygulama-dosyaları)
5. [Mühendislik/test kültürü — tekrar eden desenler](#5-mühendisliktest-kültürü--tekrar-eden-desenler)
6. [IBM ETSI-014 sertifikasyon denetimi — özet yargı](#6-ibm-etsi-014-sertifikasyon-denetimi--özet-yargı)
7. [Üretime hazırlık durumu (PKI/mTLS/HSM)](#7-üretime-hazırlık-durumu-pkimtlshsm)
8. [Nasıl çalıştırılır](#8-nasıl-çalıştırılır)
9. [Dizin haritası](#9-dizin-haritası)

---

## 1. Bu proje gerçekte nedir — ve NE DEĞİLDİR

**Ne yapar:** PhotonNet, gerçek fiziksel sabitlerle (fiber kayıp katsayıları,
dedektör karanlık-sayım oranları, zamanlama jitter'ı, EM kalkanlama teorisi
vb.) kalibre edilmiş, tek-fotonlu BB84/E91/BBM92 protokollerinin
**klasik-bilgisayar simülasyonunu** yapar. Gerçek fiber uzunluğu/kayıp
sweep'leri, gerçekçi Cascade/LDPC hata düzeltmesi, Toeplitz evrensel-hash
gizlilik yükseltme, Serfling/GLLP tabanlı sonlu-anahtar (finite-key)
güvenlik ispatı, ve **gerçek** bir ETSI GS QKD 014 REST sunucusu (mTLS ile)
içerir — bu sunucu üzerinden üretilen anahtarlar başka sistemlere
(örn. bir VPN/TLS tüneline) gerçekten teslim edilebilir.

**Ne DEĞİLDİR — kritik dürüstlük notu:** `bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md`
belgesinde ayrıntılı olarak kanıtlandığı gibi, sistemin "kuantum" bit üretimi
aslında **tek bir 32-bit `mulberry32` PRNG tohumundan** (`entanglementSeed`)
türeyen tamamen deterministik/tekrarlanabilir bir akıştır — gerçek fotonik
donanım veya kuantum rastgele sayı üreteci (QRNG) YOKTUR. Bu, kod
kalitesiyle ilgili bir eksiklik değil, **mimari bir gerçektir**: 2³²'lik
tohum uzayı modern donanımla saatler mertebesinde kaba-kuvvetle taranabilir,
bu da GLLP/Serfling güvenlik ispatının dayandığı "Eve'in ölçüm sonuçları
hakkında ön-bilgisi yok" aksiyomunu ihlal eder. Yani: **mühendislik
kalitesi** (Serfling/GLLP formülleri, Cascade/LDPC, Toeplitz evrensel-hash,
n/k ayrımı) literatürle tutarlı ve doğru uygulanmıştır, ama bunun üzerine
kurulu "bilgi-teorik güvenlik" iddiası, girdi kaynağı gerçek kuantum
rastgeleliği olmadığı sürece **temelinden geçersizdir**. Ayrıntılar için
bkz. [§6](#6-ibm-etsi-014-sertifikasyon-denetimi--özet-yargı).

---

## 2. Mimari: çekirdek + dokunulmaz katman deseni

```
PhotonNet2.jsx  (849KB, ~14.700 satır — React uygulamasının TAM kaynağı,
                 UI + algoritma iç içe)
       │
       │  bb84/tools/extract_core.js  (TypeScript transpileModule ile
       │  JSX'i React.createElement'e çevirir, React'i sahte/shim bir
       │  nesneyle değiştirir — UI ağacı hiç render edilmez, sadece
       │  algoritma sınıfları/fonksiyonları require()-edilebilir hale gelir)
       ▼
bb84/photonnet_core.js  (13.570+ satır, 85 export edilen sembol —
                          "ÇEKİRDEK", asla elle değiştirilmez)
       │
       │  bu depodaki HER "bridge/layer" dosyası çekirdeği YALNIZCA
       │  import edip salt-okunur çağırır — asla üzerine yazmaz/patch'lemez
       ▼
onlarca köprü modülü (bkz. §4) — fiziksel gerçekçilik, ağ/yönlendirme,
güvenlik/protokol, saldırı tatbikatı, araçlar
```

Bu deseni denetleyen somut mekanizmalar:

- **SHA-256 bütünlük kontrolü**: hemen hemen her `_test.js`/drill dosyası,
  çalıştırmadan önce ve sonra `photonnet_core.js`'in (ve ilgiliyse
  `timetag_acquisition_bridge.js` gibi diğer "dokunulmaz" bridge
  dosyalarının) SHA-256 özetini karşılaştırıp raporlar — "çekirdeğe
  dokunulmadı" iddiası her çalıştırmada YENİDEN kanıtlanır, sadece bir
  kere varsayılmaz.
- **`extract_core.js --check`**: CI kapısı — `photonnet_core.js`'in
  `PhotonNet2.jsx` ile senkron olup olmadığını (kaynak değişmiş ama
  çıkarım yeniden üretilip commit edilmemişse) otomatik doğrular, exit
  code 1 ile başarısız olur.
- **`EXPORT_MANIFEST`**: `extract_core.js` içinde tanımlı, çekirdekten dışa
  aktarılması beklenen 85 sembolün kesin listesi — kaynakta yeni bir
  üst-düzey sembol bulunursa (henüz manifestoda yoksa) script bunu
  BİLGİLENDİRME olarak raporlar ama sessizce dahil etmez.

---

## 3. Çekirdek motor (`photonnet_core.js`) içeriği

Çekirdek, aşağıdaki gerçek sınıfları içerir (tam liste, `grep` ile
doğrulandı):

**Fizik / kanal simülasyonu:** `AtmosphericWindowModel`, `ScintillationEngine`,
`ScintillationModel`, `PointingBudget`, `DetectorNoiseModel`,
`OpticalPhaseLockedLoop`, `ChiralAcousticEngine`, `MemristorCell`

**BB84 protokolü / güvenlik ispatı:** `QuantumKeyDistribution`,
`QKDSecurityProof`, `ParameterEstimationFilter`, `CascadeReconciliation`,
`LDPCReconciliation`, `ToeplitzAsyncEngine`, `OneTimePad`,
`ClassicalAuthChannel`, `ProductionSecurityAudit`

**Ağ / yönlendirme / topoloji:** `NetworkTopology`, `NodeRegisterMatrix`,
`EdgeWeightPolicy`, `NodeTransitGate`, `LinkOutageController`,
`LinkGradedEavesdropThresholdAlgorithm`, `LinkRiskReputationEngine`,
`LEGADecisionCore`, `MinHeap` (Dijkstra için)

**Operasyon / kapasite yönetimi:** `KeyPoolBuffer`, `KeyDeliveryStore`,
`CalibrationRateLimiter`, `NodeWatchdog`, `NoiseGateMiddleware`,
`NoiseMatrixCalibration`, `DualClockScheduler`, `SoftLandingFilter`,
`ChaosSuppressor`, `PredictiveCorridorEngine`, `PredictiveTelemetryEngine`,
`MetricTrendInjector`, `CoefficientEvolutionEngine`, `BurstTrafficGenerator`,
`InMemoryComputeFabric`

**UI bileşenleri (React, katmanlar tarafından kullanılmaz):** `PhotonNet`
(ana bileşen), `Oscilloscope`, `BerGauge`, `Spark`, `LeoPanel`

**Anahtar yardımcı fonksiyonlar:** `mulberry32` (deterministik PRNG —
bkz. §1'deki dürüstlük notu), `combineSeed`, `dijkstra`, `routeCalculation` /
`routeCalculationResilient`, `bb84Reconcile`, `propPhoton` /
`propPhotonRelayChain`, `physicalSimulation`, `haversineKm`, `gaussianRandom`,
`poissonSample`, `shannonEntropy`, `toeplitzPackBits` / `toeplitzParity32`,
`otpEncryptBits` / `otpDecryptBits`, `deriveOtpKeyBits`, `t2b`/`b2t`
(bit↔metin — 8-bit, Türkçe karakterlerde kesme yapabilir, bazı katman
dosyaları kendi UTF-8-güvenli versiyonlarını yazmıştır).

633nm gibi özel dalga boylarının fiber kayıp katsayıları OZ Optics/Corning
SMF-28/FOA-EIA-TIA-568 gibi gerçek endüstri kaynaklarıyla çapraz
doğrulanmıştır (dosya-üstü "DÜZELTME 15" yorumu).

---

## 4. Modül envanteri — kategori bazlı, TÜM dosyalar

> Not: Her modülün altında varsa **dürüstlük/kapsam notu** ayrıca
> belirtilmiştir — bunlar bu projenin en değerli belgeleme biçimidir ve
> kasıtlı olarak atlanmamıştır.

### 4.1 Fiziksel katman / zamanlama / donanım gerçekçiliği

| Dosya | Ne yapar |
|---|---|
| `timetag_acquisition_bridge.js` | **Faz 1** — ham pikosaniye zaman-damgalı dedektör tıklama akışını (gerçek bir zaman-etiketleyici donanımının üreteceği format) klasik eleme (sifting) katmanının beklediği formata çevirir. `TimeTagEmulator` Bob'un 4 dedektör kanalını (H/V/D/A) dedektör verimliliği, karanlık-sayım olasılığı, Gauss zamanlama jitter'ı (Box-Muller), ölü zaman, optik hizasızlık ile modeller. QBER_ABORT=0.11. Baz/bit seçimi `crypto.randomBytes` üzerinden enjekte edilebilir bir `qrng` arayüzünden gelir — `mulberry32` SADECE fiziksel gürültü için kullanılır, anahtar materyali için DEĞİL. |
| `timetag_acquisition_test.js` | 7/7 öz-test: temiz hat QBER'i optik-hizasızlık tabanında kalıyor; karanlık-sayım artışıyla QBER öngörülebilir şekilde yükseliyor; eşleşme penceresi genişledikçe verim↑/QBER↑ ödünleşimi; gözcü (Eve) yakalanıyor (QBER~%25→abort); 3 farklı rastgelelik kaynağı QBER'de <%0.6 fark yaratıyor (QBER fizikten geliyor, RNG seçiminden değil); eleme sonrası bitler ETSI-014 formatına doğru paketleniyor. |
| `timing_coincidence_engine.js` | **Faz 2** — Alice/Bob arasındaki saat kaymasını (asimetrik senkronizasyon sorunu) modeller. `siftFixed()` (naif, sabit-pencere) sürüklenme altında bozulur; `siftRecovered()` bir Kalman filtresi (`JitterPredictor`) ile ileri-besleme düzeltmesi yapar; `bridgeClockJump()` ani saat sıçramalarında ODLS (optik gecikme hattı) ile geçiş penceresini köprüler. **Dürüstlük notu:** düzeltilmemiş saat kayması bir gözcü gibi görünür (QBER sıçrar) ama bu bir SENKRONİZASYON sorunudur — Kalman kurtarma gerçek bir gözcüyü ASLA maskelemez (Eve'in rastgele-baz hatasının öngörülebilir yapısı yoktur). |
| `timing_coincidence_test.js` | 6/6 öz-test: mükemmel saat → taban QBER/verim; düzeltilmemiş sürüklenme → QBER sıçraması ("tanısal tuzak"); Kalman kurtarma → QBER/verim fizik tabanına döner; ODLS geçiş köprüsü → zaman-aşımı düşüşü sıfır; kurtarma AÇIKKEN gerçek bir gözcü hâlâ yakalanıyor (QBER >%20). |
| `detector_recalibration.js` | **Faz 3 (B4)** — gerçek tek-foton dedektör kusurlarını (afterpulsing, dedektör-verimlilik uyumsuzluğu) ekler ve sonlu-anahtar güvenlik ispatını buna göre yeniden kalibre eder. `qberByImperfection()` QBER'i bileşenlerine ayırır. Verimlilik uyumsuzluğu QBER'e ~sıfır katkı yapar ama eleme sonrası anahtarı yanlılaştırır ve standart sonlu-anahtar sınırının GÖREMEDİĞİ bir yan-kanal açar. `qberCliff()` ikili aramayla ℓ→0 güvenlik uçurumunu bulur. **Dürüstlük notu:** idealize kalibrasyon iyimserdi. |
| `detector_recalibration_test.js` | 6/6 öz-test: gerçek kusurlar QBER'i idealize tahminin ×1.6+ üzerine çıkarıyor; afterpulsing dominant bileşen; gerçek QBER'in sonlu-anahtar ispatına beslenmesi ℓ/n'i n=1e6'da >5 puan düşürüyor (yine de güvenli); verimlilik uyumsuzluğu ölçülebilir bir yan-kanal yaratıyor (ayrı izlenmeli); güvenlik marjı gerçek QBER altında idealize olana göre daha dar. |
| `shielded_detector_physics.js` | Faraday-kafes kalkanlamasının temiz ortamını dedektör-gürültü modeline yansıtır — karanlık-sayımı TERMAL + EM bileşenlerine ayırır, QBER tabanını yeniden hesaplar, temizlenmiş kanalda Gizli Anahtar Oranı (SKR) kazancını doğrular. **Kritik dürüstlük notu:** çekirdeğin `DetectorNoiseModel`'i UYDU (Micius) senaryosu için kalibredir (80MHz kapı); bu projenin kendi yer-tabanlı fiber BB84'ü (1GHz kapı) AYRI, farklı kalibre edilmiş bir senaryodur — ikisi birbirinin yerine KULLANILAMAZ (~2000× fark), modül ikisini de raporlar ama operasyonel taban olarak her zaman kendi yer-termal referansını kullanır. |
| `shielded_detector_physics_test.js` | 5/5 öz-test: yer-tabanlı vs uydu-kalibreli termal referanslar ~2000× farklı (değiştirilemez olarak raporlanıyor); kirli→temiz kafes geçişinde QBER tabana tam olarak dönüyor; temiz kanalda SKR ölçülebilir şekilde artıyor; her pencere çarpanında temiz kanal kirliden daha düşük QBER veriyor. |
| `optical_delay_line.js` | **ODLS — L5.6** — Kalman filtresi yakınsarken (~9 adımlık geçiş penceresi) fotonları düşürmek yerine devridaim eden bir fiber döngü + 2×2 anahtarda tutar. İki BAĞIMSIZ, YARIŞAN bütçe: (1) ekleme kaybı (µs zaman ölçeğinde bağlayıcı) ve (2) faz eşevresizliği/T2 (ms zaman ölçeğinde, gerçek kuantum bellek için bağlayıcı). `MEDIA` tablosu ortamları dB/**zaman** (α·v) ile karşılaştırır — çip dalga kılavuzları dB/m'de düşük görünse de GRUP HIZLARI çok daha düşük olduğundan depolama için DAHA KÖTÜdür. **Dürüstlük notu:** "ODLS bedava bir dondurucu DEĞİLDİR" — yalnızca her iki bütçe içinde kalındığı sürece işe yarar; Kalman'ın HIZLI (µs) kurtarması, tutma sürelerini 3dB fiber-kayıp bütçesi içinde tutan fiziksel ÖN-KOŞULDUR. |
| `optical_delay_line_test.js` | 6/6 öz-test: ODLS'siz 9-adımlık pencere paketlerin %100'ünü düşürüyor; ODLS ile sıfır zaman-aşımı düşüşü; µs fiber döngü kayıp-bağlı iken ms gerçek kuantum bellek faz-bağlı (iki farklı fiziksel rejim); hızlı (µs) kurtarma bütçeye sığarken yavaş (ms) reaktif yeniden-senkron imkansız bir dB bütçesi gerektirirdi; pencereye göre ayarlanmış döngü (n=1 geçiş) anahtar yükünü en aza indiriyor. |
| `odls_optimization_drill.js` | ODLS fiber tabanını azaltmanın iki yolu: Track 1 (PJA'yı agresifleştirmek, 9→5-6 adıma indirmek neredeyse bedava — kaybı yarıya indirir); Track 2 (ortam değiştirmek). **Önemli bulgu:** kullanıcı sezgisinin ("çip dalga kılavuzları <0.1dB/m daha iyidir") TERSİ doğru — SMF fiber (0.0002 dB/m) zaten bilinen en düşük kayıplı ortam; "iyi" bir Si₃N₄ çip (0.1dB/m=100dB/km) depolama için >100× DAHA KÖTÜ. Kriyojenik soğutma silikanın fiber kaybını AZALTMAZ (α'nın ~%96'sı donmuş Rayleigh saçılmasıdır, sıcaklıktan bağımsız) — kriyonun gerçek değeri T2'yi uzatmaktır. |
| `odls_provision_test.js` | 6/6 öz-test — optimizasyon tatbikatının bulgularından türetilen operatör-yüzü yardımcıları (`provisionOdls`, `calibrateQForSteps`) için regresyon kilidi: SMF/9-adım senaryosu tam eşleşiyor; 5-adım×içi-boş-çekirdek-fiber her iki kaldıracı birleştiriyor; Si₃N₄ çip 5 adımda açıkça UYGULANAMAZ olarak işaretleniyor; `calibrateQForSteps` model tabanının altını doğru tespit edip uyarıyor. |
| `predictive_jitter_alignment.js` | **L5.5** — sürekli asimetrik saat kayması altında "canlı-kilitlenme" (resync fırtınaları) hata modunu önler. `JitterPredictor`, sabit-hız Kalman filtresidir (PTP/GPS alıcılarının onlarca yıldır kullandığı teknikle aynı). **Dürüstlük notu ("YAPAY ZEKA NE DEMEK BURADA"):** kara-kutu bir sinir ağı DEĞİL, yorumlanabilir/uyarlanabilir bir kestirici. Açık sınır: kestirici yalnızca ÖNGÖRÜLEBİLİR yapıyı (ofset, sürüklenme, yavaş trend) kaldırabilir; saf beyaz gürültü jitter'ın öngörülebilir bileşeni yoktur — modül kendi sınırını kanıtlar. |
| `predictive_jitter_test.js` | 7/7 öz-test: saf sürüklenmede ileri-besleme kalıntısı jitter tabanına yakınsıyor; canlı-kilitlenme uçurumu kaldırılıyor (düşüş oranı <%5 vs naif %40+); yavaş termal+sürüklenme izlenebiliyor; **dürüst sınır**: saf beyaz jitter'da hizalanmış kalıntı ≈ naif kalıntı (kestirici olmayan yapıyı halüsinasyon GÖRMÜYOR); ani ofset sıçramasından <60 adımda kurtarma; "son değeri tekrarla" referansını MAE'de geçiyor. |
| `hardware_aging_model.js` | "Sahaya İniş / Yaşlanma Faktörü" — Faraday kafesinin kalkanlama etkinliğinin sahada SABİT OLMADIĞINI modeller (contalar gevşer, lehim oksitlenir, termal döngü mikro-boşluklar açar). Model **güç/sızıntı alanında** çalışır (dB'de değil) — her "saha döngüsü" sızıntı oranını rastgele %1-5 artırır (bileşik), leak=1'de (SE=0dB, fiziksel taban) sınırlanır. `applyFieldAging(enabled=false)` saf bypass. |
| `hardware_aging_model_test.js` | 8/8 öz-test (A-E + H,I): bypass sıfır etki; tek-döngü bozulma istatistiksel olarak [%1,%5] içinde; çok-döngü kümülatif bozulma monoton (asla iyileşmiyor); marjinal etki cebirsel özdeşlik olarak türetildi; **kafes tamamen çökse bile (SE→0dB) QBER yalnızca ~%1.2'den ~%5'e çıkıyor** — %11 acil-durdurma eşiğinin çok altında — SE-tabanlı fail-closed kapı (döngü 335'te tetikleniyor) QBER-tabanlı gözcü-durdurma mekanizmasından ÇOK DAHA muhafazakâr/erken (beklenen, doğrulanmış savunma-derinliği); yaşam-sonu fail-closed doğrulaması. **(H) ve (I) kullanıcı geri bildirimine yanıt olarak eklendi:** (H) kullanıcının "döngü 250-300 arası kör nokta" iddiasını her döngüyü (1-450) tek tek ölçerek çürüttü — kör nokta bulunamadı; (I) buna rağmen savunma-derinliği için `EMERGENCY_SE_FLOOR_DB=30` mutlak tabanı eklendi (network_shielding_bridge.js'e). |
| `noise_calibration_hardening_test.js` | 15/15 öz-test — `attack_simulation_qber_escalation.js`'in bulgularına (mağdur bulaşması, kaynak-kimlik-doğrulaması yok) karşı 3 sertleştirme: HMAC-SHA256 kaynak kimlik doğrulama (fail-closed), bağlantı-özgü risk (bulaşma yok), makul-değer/mantık sınırları (imkansız değerler — negatif mesafe, QBER>1 — reddediliyor). |
| `noise_calibration_wiring_test.js` | 10/10 öz-test — "Çekirdeğe Dönüş" doğrulaması: `NoiseMatrixCalibration.riskForDistance()`'ın gerçekten `EdgeWeightPolicy.computeWeight()`'ın yönlendirme maliyetini değiştirdiğini ve TUTARLI şekilde (daha uzak/kayıplı=daha yüksek maliyet) değiştirdiğini doğrular. |
| `noise_matrix_validate.js` | Çekirdeğin analitik/sezgisel modellerinin (statik WL zayıflama tablosu, LEGA risk skoru) `hal/noise_matrix.json`'daki (HAL köprüsü üzerinden gerçek HTTP çağrılarıyla toplanan) ölçüm matrisiyle ne kadar örtüştüğünü ölçer. **Kritik dürüstlük notu:** `hal/noise_matrix.json` şu an `SimulatedHardware`'den geliyor (GERÇEK fiber DEĞİL — aynı kapalı-form formülünün Python'a RNG-örneklenmiş bir portu), bu yüzden zayıflama karşılaştırması "neredeyse totolojik"; LEGA karşılaştırması daha anlamlı ama LEGA'nın `histBer` girdisi doğrudan aynı ölçülen QBER'den besleniyor, yani yüksek R²'nin bir kısmı bu doğrudan bağlantıdan geliyor. |
| `noise_calibration.json` | İmzalı kalibrasyon veri zarfı (payload+HMAC). `sourceIsRealHardware: false` — açıkça `hal/noise_matrix.json`'dan (yani `SimulatedHardware`'den) üretildiğini belirtir; "gerçek donanım bağlandığında yeniden üretilmeli" notuyla. |
| `rf_noise_bridge.js` | Faraday-kafes EM-sızıntı bulgularını, kalkanlama marjını (dB) gerçek eleme/QBER simülasyonuna beslenen bir RF-kaynaklı "karanlık-sayım benzeri" tıklama olasılığına çevirerek köprüler. `rfInducedDarkProb(marginDb)`: margin=0dB'de referans karanlık-sayım oranına eşit, her +10dB margin ×10 azaltır. **En kritik dürüstlük notu:** marginDb→karanlık-olasılık kalibrasyonu AÇIKÇA BİR VARSAYIMDIR — bu ilişki gerçek analog ön-uç elektroniğinin TIA/karşılaştırıcı tasarımına bağlıdır ve yalnızca gerçek donanımla ölçülebilir; "üretim kararları için donanım doğrulaması olmadan kullanılmamalı" denir. |
| `rf_noise_bridge_test.js` | 6/6 öz-test: kalibrasyon sağlaması; eski kafes (5mm çıplak açıklık) 0.3m'de RF sızıntısı QBER'i ~×2.3 artırıyor ama %11 eşiğinin altında kalıyor ("sessiz" performans kaybı); yeni kafes (3mm+9mm petek) 0.3m'de RF katkısı ihmal edilebilir; eski kafes 0.1m'de (yakın-alan) QBER %11'i AŞIYOR — kanal İPTAL EDİLİYOR (kullanılabilirlik/DoS riski, sadece gizlilik değil); sonlu-anahtar etkisi ölçülüyor. |
| `faraday_cage_shielding.js` | Standart EMC/Schelkunoff teorisiyle Faraday-kafes kalkanlama etkinliğini (SE = Soğurma+Yansıma+Çoklu-yansıma düzeltmesi) modeller — çünkü EM yan-kanal saldırısı QBER'de İZ BIRAKMAZ (detector_recalibration.js'in yakaladığı gözlemlenebilir yan-kanallardan farklı olarak). Açıklık sızıntısı kesim-altı dalga kılavuzu olarak modellenir (SE≈20log10(λ/2L), L=en büyük doğrusal boyut). Bağımsız sızıntı yolları GÜÇ alanında birleştirilir (en zayıf yol baskındır). **Dürüstlük notu:** malzeme sabitleri (σr, μr) ders kitabı/el kitabı değerleridir, GERÇEK datasheet ölçümü DEĞİL. |
| `faraday_cage_shielding_test.js` | 10/10 öz-test (A-I): katı duvar baskın; açıklık baskın (EMC kuralı: en zayıf halka açıklıktır, alan değil); frekans taraması en kötü durumu doğru seçiyor; bağımsız yol güç birleşimi; çoklu-yansıma düzeltmesi dejenere durumda sonlu değer veriyor; bilinmeyen malzeme açıkça reddediliyor; **(H) gerçekçi saat harmonikleri**: projenin kendi 1GHz darbe-tekrarı tek frekansta değerlendirmenin GERÇEK tehdidi hafife aldığını gösteriyor — 19. harmonikte aynı tasarım daha da kötüleşiyor; **(I) düzeltilmiş tasarım**: 3mm açıklık + 9mm petek derinliği (gerçek EMC petek panellerine tipik 3:1 oran) 1-19GHz'in tamamında 60dB hedefini rahatça karşılıyor. |
| `resonance_drill.js` | Üretim-geri-basınç kontrol döngüsünün doğal rezonans frekansını bulup talebi tam o frekansta periyodik süren bir saldırganın sistemi dengesizleştirip dengesizleştiremeyeceğini test eder. Bang-bang/histerezis-bantlı denetleyici sonlu bir depo tarafından KELEPÇELENDİĞİ için (doğrusal 2. dereceden rezonatör değil) genlik sınırsız BÜYÜYEMEZ — ama mod-değiştirme oranını MAKSİMİZE eder; histerezis bandı tam olarak bunu sınırlayan mekanizmadır. "Bu dosya tartışmaz, ölçer." |
| `landauer_choke_drill.js` | Derin-uzay uydu QKD senaryosunda THz-hızlı foton varışının soğuk kuantum bellekte Landauer-limitli ısı dağıtımını bunaltıp bunaltamayacağını ("kuantum bilgi boğulması") araştırır. **İki dürüst bulgu:** (A) Landauer limitinin KENDİSİ bağlayıcı kısıt DEĞİL — gerçek işlem başına dağıtım Landauer'den ~10 kat büyüklük mertebesinde fazla; asıl duvar soğutucu kaldırma kapasitesidir. (B) mimarinin cevabı 2. yasayı yenmek değil, entropiyi soğuk bellekten UZAKLAŞTIRMAKtır: baz-uyuşmazlığı bitleri SICAK dedektör aşamasında atılır (soğuk belleğe hiç yazılmaz), tutulan anahtar bitleri ışık olarak bağlantı üzerinden ihraç edilir (entropi ısı olarak değil ışık olarak ayrılır). |
| `memory_technology_threshold_test.js` | 5/5 öz-test — farklı kuantum-bellek eşevrelik sürelerinde (T2=1ms...10s) dolanıklık-takas veriminin sıfıra çökmediği kritik mesafe eşiğini belirler. T2 arttıkça eşik monoton artıyor; T2=10ms 40km'de gerçekten başarısız, T2=1s gerçekten başarılı. Yüksek T2'de platonun bellek-sınırlı mı yoksa foton-deneme-bütçesi-sınırlı mı olduğu test ediliyor — bütçeyi 10× artırmak eşiği daha da yükseltiyor (gözlemlenen doygunluk bütçe-sınırlı, temelde bellek-sınırlı değil). **Dürüstlük notu:** T2 katman değerleri platform sınıfları için BÜYÜKLÜK-MERTEBESİ temsili değerlerdir, herhangi bir spesifik cihazın ÖLÇÜLMÜŞ spesifikasyonu DEĞİL. |
| `phi_high_tuning_test.js` | 7/7 öz-test — önerilen `φ_high=0.80` üretim-geri-basınç eşiğini TEK bir çalışma noktası yerine 9 noktalık bir IZGARA ile doğrular (bu oturumda tekrar eden "tek-nokta sabiti çöküyor" deseninin bir örneği). İLK aday ölçüt ("her noktada reddi tabanın 1 puan içinde tutan en tasarruflu φ") REDDEDİLDİ ve kanıt olarak raporda tutuldu — diz noktası 0.60-0.95 arasında dolaştı. KABUL EDİLEN ölçüt: ızgara-ortalaması marjinal değişim-oranı çöküşü (φ_high=0.80'de tasarruf/ret ödünleşimi hâlâ anlamlı, 0.85'te 0.011'e çöküyor). |
| `exact_slot_time.js` | `timetag_acquisition_bridge.js`'in `run()`'undaki `i×periodPs` çarpım satırının BigInt/keyfi-hassasiyetli yeniden tasarımı (bu oturumda eklendi). `precisionRiskForConfig()` döngü hiç çalıştırılmadan Number hassasiyet tavanının aşılıp aşılmayacağını önceden söyler. **Dürüstlük notu:** `timetag_acquisition_bridge.js`'in `run()`'unu DEĞİŞTİRMEZ; BigInt sonucu Number'a geri çevrilirse (mevcut aşağı-akış borusunun ihtiyacı budur) aynı hassasiyet kaybı miras alınır — bu modül şu an bağımsız denetim + önceden-risk-tespiti sağlar, tam boru hattı geçişi değil. |
| `exact_slot_time_test.js` | 6/6 öz-test. **Önemli metodolojik bulgu:** "tavanın ötesi ne kadar bozuk" sorusuna sabit bir çarpan varsayarak cevap arayan İLK yaklaşım YANLIŞ çıktı — periodPs=1000'in 2'nin kuvvetlerini içermesi bazı i değerlerinin tavanın çok ötesinde bile SADECE ikili-hizalanma şansıyla kesin kalmasına yol açıyor; bu, ikili aramayla GERÇEK bir kesin/kesin-değil geçişi bulunarak düzeltildi (floating_point_accumulation_test.js'teki benzer bir öz-düzeltmeyle aynı desen). |
| `epoch_reset_controller.js` | "Dönemsel Sıfırlama" — sayaçların floating_point_accumulation_test.js'in bulduğu devasa sınırlara (10 yıllık tahmin MAX_SAFE_INTEGER'ı 5.3× aşıyor) asla yaklaşmamasını sağlayan işletim disiplini (bu oturumda eklendi). İki tamamlayıcı mekanizma: (1) 30 günde bir sıfırlanan epoch-yerel Number sayacı + `onEpochRollover` kancası (gerçek mTLS oturum-tazeleme mantığı BURAYA bağlanır — bu dosya gerçek bir TLS soketini yeniden müzakere ETMEZ), (2) asla sıfırlanmayan BigInt ömür-boyu arşiv. |
| `epoch_reset_controller_test.js` | 7/7 öz-test: temel sıfırlama; kanca sıralı çağrılıyor; **10 yıllık maraton, sıfır bit kaybı** — lifetimeCount bağımsız hesaplanan toplamla BİREBİR eşleşiyor (Number-only 5.3× taşma bulgusunun tam tersi); 30 günlük sıfırlamayla ~23× güvenlik payı vs sıfırlamasız <1× (taşma); 100 epoch'luk tek zaman sıçraması hiçbirini atlamadan zincirleniyor. |
| `floating_point_accumulation_test.js` | IEEE-754 çift-hassasiyetli yuvarlama hatasının günler/yıllar boyunca birikip birikmediğini test eder. (A) **tamsayı-temsil tavanı**: 2^53 üzerinde ardışık tamsayılar ayırt edilemiyor — 10 yıllık kümülatif eleme-sonrası bit tahmini tavanı ~5.3× AŞIYOR (bu, epoch_reset_controller.js'i doğrudan motive etti); (B) naif toplama hatası N ile büyüyor, Kahan-telafili toplama sabit kalıyor; (C) naif birikimin TAM duraklama eşiği ikili aramayla bulundu: tam olarak 2^24 saniye (~194 gün); (D) gerçek mimari (çarpım, biriktirici değil) bu duraklama sınıfı hataya YAPISAL OLARAK bağışık; (E) çekirdeğin gerçek EMA'sı 200M döngü (~3.17 yıl) boyunca sürüklenme göstermiyor; (G) nihai Toeplitz anahtar BİTLERİ tamsayı XOR/AND işlemleriyle üretiliyor — kayan-nokta yuvarlama kanalı anahtar DEĞERLERİNE hiç dokunmuyor. |
| `hysteresis_band_test.js` | 18/18 öz-test — üretim-geri-basınç histerezis bant genişliğinin (h=0.08 varsayılan) gerekçesini kurar (bu oturumda 3. kez tekrar eden "tek-nokta sabiti" desenidir). h=0 mod-değiştirmenin "patladığını" doğruluyor. REDDEDİLEN ilk ölçüt ("mod-değiştirmeyi tabana indiren en dar bant" — dejenere, monoton azalan bir metrik her zaman en geniş bandı seçiyor) kanıt olarak tutuldu. Bandın gerçek bedeli depo-salınımı DEĞİL (ilk hipotez, veriyle çürütüldü) TASARRUFTUR: h ≥ 1−φ_high olursa kısma HİÇ tetiklenmiyor. |
| `mtls_failsafe_debounce.js` | Çekirdeğin durumsuz `mtlsHandshakePrecondition()`'ını isteğe bağlı, durumlu bir zaman-histerezisi katmanına sarar — "Erken Ölüm" yanlış-pozitifini düzeltmek için (tek bir gürültülü SE okuması anlık mTLS kilidini tetiklememeli). İki katmanlı, kasıtlı asimetrik Schmitt-tetikleyici tasarımı: debounce (kötü→BLOCKED onayı için sürdürülmüş kötü okuma gerekir) + kurtarma histerezisi (BLOCKED'dan çıkmak daha zor — kesintisiz iyi okuma gerekir, "neredeyse kurtuldu" kredisi yok). **Soğuk-başlangıç istisnası:** debounce SADECE zaten-doğrulanmış OK durumunu korur — İLK okuma kötüyse anında BLOCKED (zaten arızalı bir sistemde bedava mTLS penceresi yok). Varsayılan parametreler artık GERÇEK EMC standartlarından türetiliyor: `DEFAULT_DEBOUNCE_MS=630ms` (IEC 61000-4-4 EFT/Burst), `DEFAULT_RECOVERY_MARGIN_DB=5dB` (IEEE Std 299). `RECOVERY_ASYMMETRY_FACTOR=10` açıkça POLİTİKA olarak işaretli (standart-türevi değil). |
| `mtls_failsafe_debounce_test.js` | 10/10 öz-test (A-I): geçici bağışıklık; sürdürülmüş gerçek arıza gecikmeli ama yakalanıyor; tek iyi okuma kilidi AÇMIYOR; kesintili kurtarma sayacı sıfırlanıyor; soğuk-başlangıç istisnası; gerçek ölçülmüş yaşlanma yörüngesi (aynı AGING_SEED=7, firstFailCycle=335) + enjekte edilmiş sentetik geçici darbelerin tamamen filtrelendiği, gerçek bozulmanın hâlâ yakalandığı; EMC-standart-türevi varsayılanların formülleriyle birebir eşleştiği doğrulanıyor. |

### 4.2 Ağ / yönlendirme / dolanıklık (entanglement) katmanı

> Mimari not: PhotonNet2.jsx'in GERÇEK motoru BB84 hazırla-ölç + güvenilir-düğüm
> aktarımıdır, GERÇEK dolanıklık-takası DEĞİL. Bu kategorideki dolanıklık
> modülleri, çekirdeğin gerçek fiber-kayıp/karanlık-sayım sabitlerini
> yeniden kullanan ama çekirdek motoruna hiç dokunmayan, dürüstçe
> etiketlenmiş AYRI bir ek katmandır.

| Dosya | Ne yapar |
|---|---|
| `entanglement_hom_fidelity_sim.js` | HOM (Hong-Ou-Mandel) girişimi + Bell-durumu sadakati üzerinden dolanıklık DAĞITIMINI simüle eder. g²(0)=0.045 çok-foton kirliliği, ayırt edilemezlik %92.5, SNSPD verimliliği %82, karanlık sayım 50Hz (çekirdekle tutarlı). Werner-durumu Bell sadakati F=(1+3p)/4, takas sadakati p_swap≈p1×p2. |
| `entanglement_hom_fidelity_test.js` | Mesafe taramasıyla F>0.5 dolanıklık geçiş noktası; eşleşme-penceresi taramasıyla sadakat/başarı-oranı ödünleşimi (pencere seçimi niteliksel olarak entangled/değil'i çevirebilir); 3-düğümlü takas zinciri — tepe sadakat çarpımsal olarak düşerken (p1×p2) erişim mesafesi kabaca ikiye katlanıyor. |
| `entanglement_multihop_router.js` | N elemanter bağlantı üzerinden takas zamanlamasını genelleştirir. Saf faz gürültüsü için takas SIRASININ nihai sadakate cebirsel olarak İLGİSİZ olduğunu kanıtlar (Pauli-hata evrişimi birleşmeli+değişmeli) — yönlendirme politikasından gelen kazanç yalnızca BEKLEME SÜRESİ azalmasıdır, fizik değil. **Açıkça uyarır:** "sıralamanın sadakati artırdığı" yanlış izlenimine karşı. |
| `entanglement_swap_scheduler.js` | v2 motor — v1'in üç ölçülmüş darboğazını düzeltir: naif bellek reddi (yerine geri-basınç/erteleme), BBPSSW'nin bilgi-atan saflaştırması (yerine DEJMPS — Bell-köşegen durumu tam korur), soyut round/kapasite modeli (yerine gerçek fiber fiziği, η=10^(−αL/10), α=0.2dB/km SMF-28). **Dürüstlük notu:** v1 dosyası KASITLI OLARAK silinmedi/değiştirilmedi — "iyileştirme" iddialarının doğrulanabilir bir tabanı olarak tutuldu. α=0 idealizasyon/üst-sınır referansıdır, GERÇEK bir uydu bağlantısı DEĞİLDİR. |
| `entanglement_swap_scheduler_test.js` | v2'nin üç iyileştirmesini v1 tabanına karşı ayrı ayrı ölçer (bellek zamanlama, BBPSSW vs DEJMPS verimi, gerçek fiber-fiziği mesafe/T2 taramaları, v1'e karşı toplu iyileştirme faktörü). |
| `entanglement_swap_concurrency_test.js` | (v1 taban) 1000 istek, %35 kanal kaybı, %12 dephazing, sınırlı kuantum bellek (300 yuva/düğüm), BBPSSW saflaştırma, eşevrelik zaman-aşımları — kullanıcının orijinal test spesifikasyonu. **Dürüstlük notu:** kasıtlı olarak (daha doğru DEJMPS yerine) BBPSSW kullanır, metodolojik tutarlılık için; "Werner durumu" etiketi bir yaklaşıklıktır (gerçekte Φ+/Φ− karışımı). |
| `multihop_qkd_flow_test.js` | (A) A-R1-R2-B üzerinde dinamik yönlendirme, (B) elde edilen yüksek-sadakatli çiftleri tüketerek gerçek BBM92 QKD veri akışı (şifrele/çöz). **Dürüst bulgu** (başlıkta açıkça yazılı): "yönlendirme politikası ÖLÇÜLEBİLİR FARK YARATMIYOR" (bekleme/T2 oranı ~0.01 bu rejimde). QBER doğrudan Bell durumundan türetilir (uydurulmamış): QBER_Z=X+Y, QBER_X=Z+Y. |
| `multipath_routing_test.js` | Gerçek çekirdek fonksiyonlarına (routeCalculationResilient/NetworkTopology.disjointPaths) karşı dayanıklı çoklu-yol yönlendirmeyi doğrular: risk verisi yoksa en ucuz yol; doğrulanmış yüksek risk gerçek ayrık bir yedek koridora yönlendiriyor; ayrık yedek YOKSA sistem dürüstçe birincil yolda kalıyor (sahte yol uydurmuyor). |
| `network_matrix_routing_test.js` | Kasıtlı paylaşılan bağlantılı (R1-R3) küçük sentetik topoloji üzerinde ağ-matrisi inşası + çoklu-yol paralel yönlendirme. Bitişiklik simetrisi, derece-toplamı el sıkışma lemması, matris-kuvveti yol sayımı DFS ile çapraz kontrol edildi. **Dürüstlük notu:** verim FORMÜLLE TAHMİN EDİLMİYOR, GERÇEK simülatör çalıştırılarak ölçülüyor. |
| `quantum_network_matrix.js` | Ağ için bitişiklik/mesafe/kapasite/elemanter-sadakat matrislerini kurar, paralel yönlendirmeyi bir akış-tahsis (LP) problemi olarak formüle eder — açgözlü su-doldurma + kaba-kuvvet ızgara araması ile optimallik açığı ÖLÇÜLÜR (açgözlünün optimal olduğu VARSAYILMAZ). |
| `link_reputation_engine_test.js` | `LinkRiskReputationEngine`+`CalibrationRateLimiter`'ın (3./4. sertleştirme turu) karantina, EMA, kalıcı-olmayan askıya alma davranışlarını doğrular. **Dürüstlük notu:** test tasarımı sırasında gerçek bir hata bulunup düzeltildi — gerçek duvar-saati zamanı kullanmak hız-sınırlayıcıyı yanlışlıkla tetikliyordu, sentetik saatle düzeltildi. |
| `parallel_routing_qkd_rate_test.js` | Paralel yönlendirmenin ×2.48'lik çift-sayısı kazancının GERÇEK QKD anahtar ÜRETİM ORANINA nasıl çevrildiğini inceler — üç ayrı etki: sonlu-anahtar amortismanı, QBER seyrelmesi (yolların eşit olmayan sadakati, havuzlama h2'nin dış-bükeyliği yüzünden zarar verir), makespan uyumsuzluğu (yollar farklı zamanlarda bitiyor). |
| `qkd_network_scale.js` | **"A6"** — QKDNetSim tarzı trafik köprüsünü tam ağ ölçeğine (çok-atlamalı yönlendirme + güvenilir-düğüm anahtar aktarımı, EuroQCI tarzı, ara düğümlerde XOR aktarım) ölçekler. Dijkstra + ilerlemeli-doldurma max-min adil tahsis; NS-3 QKDNetSim-v2 uyumlu senaryo dosyası ihraç eder. |
| `qkd_network_scale_test.js` | 8 düğüm/11 bağlantılı Türkiye-benzeri topolojide 6 karma talep üzerinde doğrulanır: bağlantı hızı mesafeyle düşüyor (>3× fark 70km-120km arası); çok-atlamalı aktarım darboğaz bağlantıyla sınırlı; kapasite hiç aşılmıyor; adil paylaşım (%5 içinde). |
| `qkd_at_limit_test.js` | BBM92 ve E91'i deneysel olarak bulunan "52 km limiti"nde test eder — kayıpsız kanalda bile (α=0) faz gürültüsü+bellek eşevresizliği kritik verim eşiğine çarpar. Ölçülen S değeri analitik CHSH beklentisiyle istatistiksel 3σ içinde karşılaştırılır. **Dürüst bulgu:** 52km'de hiçbir yapılandırma güvenli anahtar vermiyor; E91 BBM92'den "daha iyi" DEĞİL — bir ödünleşim (cihaz-bağımsızlık vs daha düşük anahtar verimi). |
| `qkd_over_entanglement.js` | Dolanıklık motorundan yüksek-sadakatli Bell çiftlerini tüketerek gerçek güvenli-anahtar üretimi ve OTP veri akışı çalıştıran üst-katman QKD (BBM92). QBER doğrudan Bell durumu Pauli-hata bileşenlerinden türetilir. Kendi UTF-8-güvenli bit dönüşümünü yazar çünkü çekirdeğin t2b/b2t'si 8-bit'tir ve Türkçe karakterleri BOZAR (bulunan gerçek bir hata olarak belgelenmiş). |
| `qkd_backpressure.js` | Depo doluluk seviyesine dayalı üretim geri-basıncı/kısma — sabit-blok üretimin (talep üretimin yarısıyken ~%49 israf) yerini alır. Üç bölgeli denetleyici (φ_high altı: maksimize et; φ_high üstü: tamamen durdur). **Dürüstlük sınırı:** geri-basınç israfı ORTADAN KALDIRIR ama KAPASİTE YARATMAZ — talep maksimum üretimi aşarsa hiçbir politika kurtaramaz. |
| `backpressure_test.js` | Sabit-blok tabanı >%20 anahtar israf ediyor; geri-basınç israfı 1/4'ünün altına indiriyor; sıfır-taşma; **dürüstçe belirtilen ödünleşim**: ani talep sıçramasında φ_high'ta kısma daha AZ "yastık" bırakıyor, bu yüzden bazen sabit-blok tabanından DAHA FAZLA reddediyor ("φ_high'ın bedeli", hata değil). |
| `continuous_stream_test.js` | QKD denetleyicisini durağan, SÜREKLİ bir çift akışı üzerinde uçtan uca çalıştırır. "SLA uçurumu" bulur — belirli bir gecikmenin altında ÜRETİLEN TÜM çiftler sıfır anahtar veriyor (kademeli değil, ani). Sürekli Bell/CHSH izleme %97+ oturum boyunca 3σ-anlamlı ihlali sürdürüyor. **"Tek bir 'en iyi T' YOKTUR."** |
| `buffer_starvation_test.js` | Gerçek bir ETSI-014 KME sunucusuna karşı canlı mTLS entegrasyon testi — talep arzı aştığında güvenli başarısızlık: çift key_ID yok, temiz HTTP 503, sunucu çökmüyor, /status doğru sıfır raporluyor. **Mimari itiraf:** gerçek keystore SUNUCU BAŞLANGICINDA tek seferlik yüklenir (sıcak-yeniden-yükleme YAPMAZ) — havuz tükenmesi mimari olarak KAÇINILMAZ, asıl soru güvenli başarısızlık mı. |
| `duty_cycle_test.js` | İddia edilen "×4.5 baz-eşleşme verimliliği" artışının ölçüme-bağımlı olduğunu gösterir — E91'in anahtar-oranına karşı BB84'ün TOPLAM eleme oranını karşılaştırmak elma-armut kıyaslamasıdır; AYNI metrikle oran gerçekte 2.25'tir. Yanlı baz-seçimi p taraması key-round oranının p² ile ölçeklendiğini doğrular (Lo-Chau-Ardehali 2005). |
| `bb84_e91_duty_cycle.js` | Ölçülen hibrit BB84/E91 duty-cycle şemasını uygular — yanlı baz seçimi + adanmış Bell-test turları. Optimal p, sonlu-anahtar ℓ formülünü maksimize eden ince-taneli sayısal aramayla türetilir (varsayılmaz). |
| `attenuation_sweep_test.js` | (A) gerçekçi fiber sınıfları arası α taraması — α=0 (kayıpsız) bile mesafe limitini KALDIRMIYOR (bağlayıcı kısıt faz gürültüsü+eşevresizlik, fiber kaybı değil). (B) DEJMPS saflaştırma tur-sayısı patlaması F=0.5 tabanına yaklaşırken. **Dürüstlük notu:** α=0 GERÇEK bir uydu bağlantısını TEMSİL ETMEZ, salt bir üst-sınır referansıdır. |
| `async_sync_drill.js` | Senkronizasyon PENCERELERİNİ (ham yük değil) hedefleyen saldırı tatbikatı — asimetrik saat kayması/jitter/sürüklenme enjeksiyonuyla replay korumasını kırmaya ve ETSI-014 KME el sıkışmasında kilitlenmeye çalışır. Naif zaman-penceresi tabanlı replay koruması sürekli sürüklenme altında canlı-kilitlenmeye düşerken (verim <%20), durum-tabanlı (key_ID içerik-adresli) koruma bağışıktır. **Gerçek bir hata bulundu ve düzeltildi:** naif (birleştirmeyen) yeniden-senkron uçan-durumdaki el sıkışmaları eziyordu — birleştirme semantiğiyle düzeltildi. |
| `sla_ceiling_test.js` | SLA (blok gecikmesi) taramasını 10 saniyeye kadar genişletir, sürdürülen anahtar oranının asimptotik tavana (R∞) ne kadar yaklaştığını görmek için analitik bir model kurar ve doğrular (her SLA'da <%6 hata). Karesel-yasa ölçeklendirme doğrulanır: tavana olan açık ∼1/√T. |

### 4.3 Güvenlik / protokol / ETSI-014 / PKI katmanı

| Dosya | Ne yapar |
|---|---|
| `authenticated_channel.js` | Çekirdeğin bozuk klasik-kanal MAC'ini gerçek bir Wegman-Carter kimlik doğrulamalı kanalla değiştiren katman-düzeyi düzeltme. `tag_i = H_r(m_i) ⊕ s_i`, GF(2⁶¹−1) üzerinde polinom-değerlendirme evrensel hash. **Dürüstlük notu:** çekirdeğin `ClassicalAuthChannel._computeTag` MAC'i ölçülen ~%41 kurcalama-kaçırma oranıyla BOZUK — bu dosya katman-düzeyi düzeltmedir, çekirdek düzeltmesi değil. |
| `authenticated_channel_test.js` | 7 öz-test: kurcalama-kaçırma WC ~%0 vs çekirdek ~%41 (20.000 deneme); sahtecilik 0/10.000; replay reddediliyor; 500 mesajlık akışta 1 MITM bit-çevirme → tam olarak 1 yakalanıyor; maske havuzu tükenince fail-closed. |
| `network_shielding_bridge.js` | Faraday-kafes EM-kalkanlama sonuçlarını ETSI GS QKD 014 mTLS el sıkışması için fail-closed bir ön-koşul kapısına köprüler. `mtlsHandshakePrecondition()` iki bağımsız kontrol uygular: çağıranın kendi `targetSeDb` sonucu VE bağımsız `EMERGENCY_SE_FLOOR_DB=30` mutlak taban (kullanıcı geri bildirimine yanıt olarak eklendi). **Kapsam notu:** `etsi014_kme_server.js`'in GERÇEK TLS mantığını yeniden yazmaz — dağıtımcının sunucuyu başlatmadan ÖNCE çağırabileceği bir ön-uçuş katmanıdır. |
| `network_shielding_bridge_test.js` | 6 öz-test: iyi kafes → izin veriliyor; kötü kafes → fail-closed reddediliyor; kafes değerlendirmesi yoksa varsayılan olarak reddediliyor (asla sessizce izin verilmiyor); `production_gate.js`'e otomatik entegrasyon (9. kapı kriteri). |
| `production_gate.js` | Tüm önceki fazların güvenlik değişmezlerini tek bir git/gitme kararında birleştiren Faz-4 üretim kapısı — yazılımın kapatabileceği ile DONANIM gerektiren şeyi açıkça ayırır. 9 kapı kriteri: klasik MAC gücü, yan-kanal izleyici, QRNG donanım entropisi, gerçek QBER'de pozitif sonlu-anahtar güvenliği, gözcü-durdurma davranışı, ETSI-014 uyumu, dedektör kalibrasyonu (her zaman "donanım"), EM sızıntısı/Faraday kafesi, mTLS el sıkışma ön-koşulu. Kalan "donanım" kriterleri asla yeşil boyanmaz. |
| `production_gate_test.js` | 7 öz-test: çekirdek MAC ~%41 kaçırma vs güçlü MAC <%0.01; yan-kanal izleyici dedektör-asimetrisini ve gözcülüğü ayrı ayrı yakalıyor; `mulberry32` reddediliyor (tekrarlanabilir), `crypto.randomBytes` kabul ediliyor (ama üretim için sertifikalı donanım QRNG hâlâ gerekli olarak işaretli). |
| `production_security_audit.js` | Bağımsız (dependency-free) bir QBER/Gain/sonlu-anahtar (ε-güvenlik) denetim fonksiyonu — üçüncü bir tarafın (örn. IBM) PhotonNet'in kendi ara hesaplamalarına GÜVENMEDEN, ham veriden iddia edilen güvenlik sayılarını bağımsızca yeniden türetmesini sağlar. Serfling (1974), Scarani ve ark. (2009), Tomamichel & Leverrier (2017), Portmann & Renner (2022) kaynak gösterilir. **Dürüstlük notu (Gain hakkında):** simülatör yalnızca baz-eşleşen darbeleri fiziksel olarak simüle eder — bu yüzden raporlanan Gain, baz-uzlaşma kaybı+kanal/dedektör kaybının BİRLEŞİK bir rakamıdır, gerçek donanım raporlarının genelde ayırdığı ham tıklama oranından farklıdır. |
| `qkd_secure_channel.js` | **("A2")** ETSI-014 ile teslim edilen gerçek bir QKD anahtarını, klasik ECDHE ile hibritleyerek bir GERÇEK TLS oturumunun PSK kökü olarak kullanır. Node'un `tls` (OpenSSL) PSK desteği, ECDHE-PSK-CHACHA20-POLY1305 gibi şifre paketleri. Hibrit güvenlik: klasik ECDHE VEYA QKD PSK'sinden HERHANGİ BİRİ güvenli kalırsa güvenli. |
| `qkd_secure_channel_test.js` | 6 öz-test: ETSI-014 teslimi (master/slave aynı anahtarı alıyor); o anahtar gerçek bir TLS PSK'sine dönüşüyor; yanlış anahtarlı istemci reddediliyor; hibrit ECDHE-PSK ileri-gizlilik doğrulanıyor; el sıkışmanın pasif dinlemesi ham QKD anahtarının hatta HİÇ görünmediğini gösteriyor. |
| `qkd_session_controller.js` | Ölçümle (sabit sabitler yerine) ne zaman bir QKD bloğunun kapanması gerektiğini (oran-maksimize eden marjinal kural) ve yeni bir ağ yolunun ortak anahtar havuzuna kabul edilip edilemeyeceğini türetir. **Gösterilen bulgu:** gözlemlenen R_key(T) tepesi T≈850ms sonlu deneme bütçesinin (20.000/segment) bir ARTİFAKTIDIR, gerçek bir doygunluk noktası DEĞİL — bütçeyi 5× artırmak tepeyi 839ms→3673ms kaydırıyor. Doğru durdurma kuralı d(ℓ/T)/dT=0'dan türetiliyor. |
| `qkd_session_controller_test.js` | 18 öz-test — 850ms tepesinin bütçe artifaktı olduğunu, marjinal kuralın bütçeden bağımsız gerçek tepeyi bulduğunu, sürekli beslemede hiç tetiklenmediğini (SLA devralıyor), kabul eşiğinin kaba-kuvvet taramasıyla eşleştiğini doğrular. |
| `qkd_key_supply.js` | Sıkı bir SLA (<350ms) altında blokların sonlu-anahtar güvenlik sınırını temizleyemediği (100/200ms'de üretilen çiftlerin %100'ü israf) ultra-düşük-gecikme sorununu iki stratejiyle çözer: (1) esnek kapanma penceresi ("DÜRÜSTLÜK: bu GERÇEK ultra-düşük gecikme SAĞLAMAZ — sonlu-anahtar sınırı sert bir fiziksel tabandır, 'gecikme garantisini' 'anahtar garantisine' çevirir, ikisi birden asla"); (2) anahtar-envanteri/tahsisatçı katmanı (üretim gecikmesini teslim gecikmesinden ayırır). Çekirdekte bulunan bir bellek-sızıntısı-benzeri sorunu (`KeyDeliveryStore.byRoute` asla budanmıyor) çekirdeğe dokunmadan tahsisatçı katmanında düzeltir. |
| `key_supply_test.js` | 13 öz-test — sert 200ms SLA'nın kilitlendiğini, S_min≈D·T_b boyutlandırma kuralını, daha büyük rezervuarın güvenlik bedelini (ortalama/maksimum anahtar yaşı) ölçer. "Üçler kuralı" istatistiksel dikkatini uygular: 0/n gözlemlenen ret oranı gerçek oranı yalnızca ≤3/n (%95 güven) ile sınırlar. |
| `etsi014_client_lib.js` | Herhangi bir ETSI-014 uç noktasını (yerel KME veya gerçek QuKayDee bulutu) hedefleyebilen, satıcı-bağımsız, yeniden kullanılabilir ETSI GS QKD 014 istemci kütüphanesi. mTLS `httpsCall()` (`rejectUnauthorized: true`), ETSI GS QKD 014 V1.1.1 §6 şema doğrulayıcıları. Gerçek dağıtımlarda master/slave SAE'lerin AYRI KME'lere bağlanabileceğini not eder (QuKayDee: kme-1↔sae-1, kme-2↔sae-2). |
| `etsi014_client_lib_test.js` | 2 öz-test — gerçek QuKayDee'ye yönlendirmeden önce yerel KME'ye karşı loopback doğrulaması. |
| `etsi014_faz0_client.js` | **("Faz 0")** Sıfır kuantum donanımıyla PhotonNet'in KME'sinin gerçek ETSI GS QKD 014 V1.1.1 konuştuğunun uçtan uca kanıtı. GET status → POST enc_keys (master) → POST dec_keys (slave), mTLS üzerinden. |
| `etsi014_interop_test.js` | **("A5")** İstemcinin gerçekten satıcı-bağımsız olduğunu kanıtlayan çift yönlü birlikte-çalışabilirlik matrisi: kendi KME'miz ↔ kendi istemcimiz; BAĞIMSIZ, temiz-oda bir referans KME (farklı key_size, farklı rota-anahtarı formatı) ↔ aynı istemci; kenar/hata problamaları her ikisine karşı; tam 2×2 matris. |
| `etsi014_kme_server.js` | Sıfır-bağımlılıklı, bağımsız çalışan ETSI GS QKD 014 V1.1.1 uyumlu bir KME (Anahtar Yönetim Varlığı) REST sunucusu — PhotonNet'in simülatör-üretimli, Cascade-uzlaştırılmış+Toeplitz-gizlilik-yükseltilmiş anahtarlarını standart REST API üzerinden dışarı sunar. Gerçekten AYRI bir OS sürecidir (tarayıcılar TCP soketi açamaz). Gerçek mTLS: `--cert/--key/--ca` verildiğinde Node'un TLS katmanı (`requestCert:true`+`rejectUnauthorized:true`) TLS el sıkışmasının kendisinde istemci-sertifika kimlik doğrulamasını uygular — SAE kimliği doğrulanmış sertifikanın Subject CN'inden okunur, ASLA bir HTTP header'ından değil. `--crl=` (sıcak-yeniden-yüklemeli) ve `--ocsp-responder=` (canlı sorgu) ile iki bağımsız iptal mekanizması. |
| `etsi014_qukaydee_client.js` | **("A1")** Genelleştirilmiş ETSI-014 istemcisini yerel KME yerine gerçek QuKayDee bulut uç noktasına yönlendirir. **Dürüstlük notu:** "sandbox'ın gerçek QuKayDee'ye ağ/kimlik erişimi yok, canlı koşum kullanıcı tarafında yapılmalı" — istemci mantığı yerel KME'ye karşı doğrulanmıştır, geçiş sadece config değişimidir. |
| `etsi014_reference_kme.js` | İstemci kütüphanesinin gerçekten satıcı-bağımsız olduğunu kanıtlamak için kullanılan bağımsız, temiz-oda, minimal bir "başka satıcı" KME'si. Kasıtlı olarak PhotonNet'in kendi KME'sinden farklı seçimler yapar (128-bit anahtar, farklı rota-anahtarı ayırıcı, harici keystore dosyası yok). |
| `qukaydee_emulator.js` | Sandbox gerçek QuKayDee bulutuna erişemediği için, gerçek QuKayDee'nin çoklu-KME topolojisinin sadık bir yerel emülasyonu — iki gerçekten ayrı KME sunucusu (kme-1/sae-1 master, kme-2/sae-2 slave) paylaşılan bir KME-arası anahtar-akışı Map'i ile (gerçek QuKayDee'nin KME-arası senkronunu yansıtır), enjekte edilmiş gerçekçi ağ gecikmesi. |
| `qukaydee_realistic_test.js` | 7 öz-test — QuKayDee-sadık emülatörün gerçekçi çoklu-KME, mTLS, gecikme-enjekte edilmiş koşullarında A2 sistemini test eder: kme-1'de üretilen anahtarın kme-2'den bit-birebir alınabildiğini (çapraz-KME senkron), o anahtarın gerçek bir ECDHE-PSK TLS oturumunu köklendirdiğini, mTLS'in zorlandığını, gecikmenin gerçekten ölçüldüğünü doğrular. |
| `mock_ibm_client.js` | IBM Quantum Network'ün (veya herhangi bir harici ETSI-014 SAE'sinin) yerini tutan, sertifikaları (openssl ile) VE tam protokol-düzeyi mTLS/ETSI-014 davranışını bağımsızca doğrulayan sıfır-bağımlılıklı bir entegrasyon-test istemcisi. **Dürüstlük notu:** bu script GERÇEK IBM Quantum Network SDK'sını emüle ETMEZ (erişimi yok) — sadece HERHANGİ bir istemcinin (IBM dahil) izlemesi gereken ETSI GS QKD 014 REST sözleşmesini ve mTLS kimlik doğrulamasını test eder. |
| `build_production_server.js` | `etsi014_kme_server.js`'in tüm demo/geri-düşüş kimlik doğrulama kodunun (Bearer token, X-SAE-ID header modu, mTLS'siz sunucu modları) BUILD ZAMANINDA FİZİKSEL OLARAK SÖKÜLDÜĞÜ bir "üretim derlemesi" üretir. `// PROD-STRIP-BEGIN/END: <id>` işaretçileriyle sarılan bloklar tamamen silinir. 4 build-zamanı güvence: manifesto/kaynak tutarlılığı, çıktıda yasaklı örüntülerin (Bearer/X-SAE-ID/demo-token) HİÇBİRİNİN kalmadığının pozitif grep taraması, çıktının hâlâ geçerli JS olduğu. |
| `generate_demo_pki.sh` | Yerel mTLS'i hızlıca denemek için tek-komutluk demo PKI üretici (kök CA + KME sunucu sertifikası + SAE başına istemci sertifikaları). **Dürüstlük notu:** SADECE hızlı tek-komutluk demo içindir — gerçek bir openssl CA veritabanı (index.txt/serial/crlnumber) İÇERMEZ, bu yüzden iptal (CRL/OCSP) veya HSM/hava-boşluğu ayrımını DESTEKLEYEMEZ; bunlar için `pki_tools/` kullanılmalı. CA özel anahtarı diskte düz metin olarak durur. |
| `pki_tools/ca_init.sh` | Hava-boşluklu/HSM-destekli çalışacak şekilde tasarlanmış tek-seferlik kök CA önyüklemesi (anahtar+sertifika+tam openssl CA veritabanı). PKI yaşam döngüsünü 3 fiziksel olarak ayrı adıma böler. `--pkcs11-uri` ile gerçek/yazılımsal HSM desteği — bununla `ca-key.pem` YEREL DOSYA OLARAK HİÇ ÜRETİLMEZ, anahtar çifti doğrudan PKCS#11 token içinde üretilir. **Dürüstlük notu:** `--pkcs11-uri` yolu bu sandbox'ta test EDİLEMEDİ (ağ kısıtı SoftHSM2/OpenSC kurulumunu engelledi) — ilk gerçek doğrulama GitHub Actions'ta olacak. |
| `pki_tools/cert_rotation_revocation_scenarios.js` | PKI/mTLS çalışmasının nihai doğrulama adımı — GERÇEK bir canlı KME sunucusu + GERÇEK OCSP yanıtlayıcısı + gerçek mTLS bağlantılarına karşı 6 zaman-bağımlı rotasyon/iptal senaryosunun (planlı rotasyon, acil iptal, OCSP çökmesi altında fail-closed, kalıcı bağlantı ortasında iptal, süre-dolumu vb.) NASIL DAVRANDIĞINI (varsayılmadan) ÖLÇER. Her sayının o çalıştırmada canlı ölçüldüğünü, elle yazılmadığını açıkça belirtir. |
| `pki_tools/hsm_init.sh` | SoftHSM2 tabanlı yazılımsal HSM'i (PKCS#11 token) kurar/başlatır. **Dürüstlük notu:** bu sandbox'ta hiç ÇALIŞTIRILAMADI (ağ kısıtı SoftHSM2/OpenSC kurulumunu engelledi) — ilk gerçek doğrulama "software-hsm-pkcs11" GitHub Actions işinde olacak. |
| `pki_tools/issue_cert.sh` | SAE/sunucu tarafında çalışır: özel anahtar+CSR üretir; özel anahtar o makineden asla AYRILMAZ. |
| `pki_tools/pkcs11_bridge.js` | Node.js'in bir PKCS#11 modülüyle (SoftHSM2 veya gerçek donanım HSM) doğrudan konuşmasını sağlar. **Dürüstlük notu (iki kez vurgulanmış):** (1) `pkcs11js` npm bağımlılığı bu sandbox'ta KURULAMADI (npm registry 403 döndü), hiç çalıştırılıp test edilemedi; (2) **KAPSAM DIŞI** — KME sunucusunun canlı TLS dinleme soketini HSM'e BAĞLAMAZ (Node'un tls/https modülünün OpenSSL CLI'nin `-engine` mekanizmasına eşdeğer bir "harici imzalayıcı" kancası yok) — bu ayrı, daha büyük bir mühendislik işi. |
| `pki_tools/revoke_cert.sh` | CA tarafında anlık sertifika iptali ve CRL yeniden üretimi. KME sunucusunun (`--crl=` ile) bu dosyayı `fs.watchFile` ile sıcak-yeniden-yüklediğini, iptalin saniyeler içinde yeniden başlatma olmadan etkili olduğunu belirtir. |
| `pki_tools/rotate_cert.sh` | `issue_cert.sh`+`sign_csr.sh`'i zincirleyen kolaylık sarmalayıcısı. **Kapsam notu:** SADECE CA ve SAE/sunucunun AYNI YERDE olduğu durum için bir kolaylık sarmalayıcısıdır — gerçek hava-boşluklu bir dağıtımda bu script CSR-taşıma sürecini SİMÜLE ETMEZ. |
| `pki_tools/run_ocsp_responder.sh` | CA'nın `index.txt` veritabanından gerçek bir OCSP yanıtlayıcısı çalıştırır. **İki gerçek hata bulunup düzeltildi:** openssl'in `ocsp` komutu `-index`'i sadece başlangıçta okur ve asla yeniden okumaz; sadece istek-başına yeniden başlatmak (`-nrequest 1`) yetersizdir çünkü yeniden başlatılan süreç bir sonraki isteğe kadar bayat veriyle boşta kalır (iptalden 31+ saniye sonra bile "good" yanıtı ölçüldü) — arka plan izleyicisi `index.txt` mtime'ını saniyede bir kontrol edip boştaki openssl sürecini öldürerek düzeltildi (bayatlık ~1-2 saniyeye indi). **Ek dürüstlük notu:** yanıtlayıcı OCSP yanıtlarını doğrudan CA'nın kendi anahtarıyla imzalıyor — gerçek üretim ayrı, kısa-ömürlü delege bir "OCSP imzalama" sertifikası kullanmalı. |
| `pki_tools/sign_csr.sh` | CA tarafında CSR imzalama (openssl CA veritabanına kaydedilir), kısa-ömürlü sertifikaları zorlar (varsayılan 7 gün geçerlilik). `--engine pkcs11` ile HSM-yerleşik CA anahtarıyla imzalama desteği. |

### 4.4 Saldırı / stres / adversarial test katmanı

| Dosya | Ne yapar |
|---|---|
| `attack_simulation_qber_escalation.js` | Bir saldırganın `NoiseMatrixCalibration.loadFromJSON()` üzerinden bir bağlantının kalibrasyon telemetrisini kademeli olarak zehirlediği yönlendirme-katmanı saldırısını simüle eder (bu, GERÇEK güven sınırıdır — köprü hiçbir `/api/inject_fault` uç noktası açığa çıkarmaz). QBER'i 3 aşamada (%1→%2→%18) enjekte eder, Dijkstra yönlendirmesinin risk modeli kripto eşiğini yeterince hızlı geçmediği için zehirli bağlantıyı seçmeye devam ettiğini gösterir. **Dürüstlük notu:** bulunan gerçek zafiyet bir kullanılabilirlik/DoS açığıdır (gizlilik ihlali değil) — `QKDSecurityProof` o anahtar materyalini yine de doğru şekilde güvensiz işaretliyor. |
| `god_mode_ragnarok_attack.js` | Kullanıcı tarafından sağlanan orijinal "saldırı script'i" — yer tutucu bir HMAC anahtarıyla sahte bir kalibrasyon yükü imzalar. **Sonradan `_real.js` tarafından çürütüldü/aşıldı:** bu script gerçek sisteme HİÇ dokunmuyor (yanlış anahtar, yanlış kanonikleştirme, yanlış dosya/şema). |
| `god_mode_ragnarok_attack_omega.js` | **"OMEGA v2"** — sertleştirme sonrası (`_absoluteRisk()`, `_resolveTies()` düzeltmeleri) dört saldırı cephesini (Ω1-Ω4) yeniden çalıştırır. Ω2b (masum bir bağlantıyı çerçeveleme) kasıtlı olarak kabul edilmiş, belgelenmiş bir kalıntı zayıflık/ödünleşim olarak belgelenir — gerçek tehlikeyi asla gizlemez ama yönlendirmeyi aşırı muhafazakâr yapabilir. |
| `god_mode_ragnarok_attack_omega_v3.js` | **"OMEGA v3"** — Ω1-Ω4'ü artık gerçek yönlendirme çağrı yolunda `NoiseMatrixCalibration.riskForLink`'in yerini alan daha yeni `LinkRiskReputationEngine`'e (zamansal versiyonlama, durumlu EMA, karantina) karşı yeniden çalıştırır. **Açık tasarım sınırı:** bir imza sadece "bunu anahtar sahibi gönderdi"yi kanıtlar, "ölçüm doğru"yu DEĞİL — N_min sahte-ama-geçerli-imzalı örnekle çerçeveleme, bilinçli, belgelenmiş bir açık konu olarak kalır. |
| `god_mode_ragnarok_attack_omega_v4.js` | **"OMEGA v4"** — Ω5 (hız-sınırlayıcının Ω2b maliyeti) ve Ω6 (bozuk bir bağlantıya karşı ayrık çoklu-yol dayanıklılığı). **Dürüstlük notu:** hız-sınırlayıcı varsayılan sabitlerle Ω2b çerçeveleme saldırısının TEK-SEFERLİK/tek-pencere versiyonunu YAKALAMIYOR — bu bir tasarım sınırlaması olarak açıkça belirtiliyor. |
| `god_mode_ragnarok_attack_real.js` | Gerçek demo imzalama anahtarını ve gerçek kanonikleştirme/şemayı kullanan, saldırının GERÇEKTEN `verifyAndLoad()`'a ulaştığı düzeltilmiş bir versiyon. **Gerçek, önceden bilinmeyen bir normalleştirme kör noktası bulundu:** tek-örneklik bağlantı verisi risk=0'a normalleşiyor (yönlendirmede görünmez) — GERÇEK QBER ne olursa olsun; 2+ tarihsel örnekle yükselme yakalanıyor. **Dürüstlük notu:** bu "kör nokta savunması" şans/yan-etkidir, kasıtlı tasarım DEĞİLDİR — açık bir madde olarak işaretlenmiştir; gizlilik hiçbir senaryoda ihlal edilmedi, sadece yönlendirme/kullanılabilirlik sinyali risk altındaydı. |
| `state_poisoning_drill.js` | Bireysel olarak geçerli mikro-isteklerin, sağlık göstergeleri düz kalırken bile sınırsız iç durum büyümesine yol açıp açamayacağını test eden bir "durum şişirme/bellek sızıntısı" tatbikatı. **İki gerçek biriktirici hatası bulundu ve düzeltildi:** `KeyAllocator`/`KeyDeliveryStore.byRoute` tüketilen geçmiş kayıtlarını asla budamıyordu (envanter düz görünürken sınırsız büyüme) — tüketimde en eski kaydı budayarak düzeltildi; KME `dec_keys` düz bir dizide O(n) findIndex+splice kullanıyordu — Map ile O(1)'e düzeltildi. |
| `fidelity_collapse_drill.js` | Raporlanan bir sadakat-çöküşü telemetri olayını (φ_high=0.60, histerezis bandı 0.16→0.04, %38 ret oranı, sadakat 30sn'de %98.2'den %84.5'e düşüyor) yeniden üretip bunun mimari bir hata mı yoksa gerçek bir fotonik bant çöküşü mü olduğunu belirleyen bir "canlı olay tatbikatı". Hiçbir önceden verilen sayıya güvenilmez — telemetrinin kendi iç tutarlılığı bile (φ=0.60 ile h=0.04 birlikte var olabilir mi?) VARSAYILMADAN test edilir. |
| `layer_stress_campaign.js` | Yedi farklı mimari katmanı (fiber zayıflaması, atlama-sayısı, yönlendirme doygunluğu, QBER/sonlu-anahtar, denetleyici kabul eşiği, ×10 talep patlaması, ölçekte KME churn'ü) kırılma noktalarına iterek her birinin çökme yerine ZARİF şekilde bozulduğunu doğrular. |
| `safety_margin_drill.js` | "%0 güvenlik payı, en ufak donanım sapması döngüyü kırar" ve "10 THz kapasite ama termal olarak 50 Gbit/s'e boğuluyor (%99.5 donanım israfı)" iddialarını TARTIŞMAK yerine ÖLÇER. Histerezis-bant kontrol döngüsünün faz-hatası sapmalarını taban değerinin ×6'sına kadar ihmal edilebilir ret-oranı değişimiyle emdiğini gösterir (marj büyük, sıfır değil) — bandı devre dışı bırakmak (h=0) döngüyü GERÇEKTEN kırılgan yapar. |
| `ibm_math_audit.js` | Yalnızca `photonnet_core.js`'in gerçek export'larını kullanarak "bu algoritma resmi sertifikasyon NEREDE alamaz" sorusuna cevap veren matematiksel/kriptografik denetim (14 test). Bkz. [§6](#6-ibm-etsi-014-sertifikasyon-denetimi--özet-yargı) için tam özet. |
| `bb84_statevector.py` | NumPy tabanlı, tam/karmaşık kuantum-durum-vektörü BB84 referans simülasyonu (gerçek Hadamard + Born-kuralı genlikleri) — PhotonNet'in klasik QBER matematiğini bağımsızca doğrular. N=200.000 kübitte Eve'siz QBER~%0, Eve (intercept-resend) ile ~%24.89 (teorik: %25). |
| `ibm_qiskit_chain.py` | Qiskit-eşdeğeri tek-atlamalı BB84 modelini bir güvenilir-düğüm aktarım zincirine genişletir (PhotonNet2.jsx'in `deriveSiftedKeyChain()` mimarisiyle eşleşir) — hedef mesafeyi ~60km'lik atlamalara böler. |
| `ibm_qiskit_equivalent.py` | Gerçek Qiskit/Aer BB84 devre simülasyonunun matematiksel olarak eşdeğer bir yerine geçeni — çünkü bu sandbox HİÇBİR yeni pip paketi kuramıyor (Qiskit dahil, PyPI ağ erişimi engelli, tekrar tekrar doğrulandı). Hem yavaş tam-durum-vektörü referansı hem hızlı vektörleştirilmiş kapalı-form eşdeğeri içerir, istatistiksel olarak birbirine karşı çapraz doğrulanmış. |
| `qkdnetsim_traffic_bridge.js` | Gerçek, akademik olarak doğrulanmış bir QKDNetSim (Saraybosna Üniv. + VSB Ostrava) ns-3.46 trafik profilini (500sn, 28.140 olay, patlamalı şekil) PhotonNet'in gerçek mTLS/ETSI-014 KME sunucusuna karşı GERÇEK TLS el sıkışmaları ve enc_keys/dec_keys çağrılarıyla yeniden oynatır. **Dürüstlük notu:** 28.140 gerçek mTLS el sıkışması gerçekçi olarak birkaç dakikada tek bir sandbox sürecinde tamamlanamaz — bu yüzden olay SAYISI ölçeklenir ama patlama ŞEKLİ korunur, bu ölçekleme raporda açıkça belirtilir. |
| `run_qkdnetsim_traffic_bridge.sh` / `run_buffer_starvation_test.sh` | Geçici PKI + yerel KME sunucusu + ölçeklenmiş sentetik keystore kurup yukarıdaki köprüyü/tükenme testini çalıştıran, sonra tamamen temizleyen orkestrasyon script'leri. |
| `client_network_report.js` | Açıklanan iş modelini uygular — müşteriler ham fiber-bağlantı/dedektör verisi gönderir, bu araç GERÇEK fizik/yönlendirme/itibar motorundan geçirerek bir siber-dayanıklılık/QBER/Ragnarok-saldırı-dayanıklılığı raporu üretir (çekirdeğe hiç dokunmadan). Fotonu GERÇEKTEN foton-foton simüle eder (kapalı-form tahmin değil). QBER hesaplanamıyorsa yanıltıcı bir "mükemmel" 0 yerine `null` döner. |
| `compare_js4.js` | 1-100km mesafe aralığında `QuantumKeyDistribution.deriveSiftedKey()`'i Eve'li/Eve'siz karşılaştıran kısa bir kıyaslama script'i. |

### 4.5 Araçlar, build, CI/CD

| Dosya | Ne yapar |
|---|---|
| `bb84/tools/extract_core.js` | `PhotonNet2.jsx`'ten `bb84/photonnet_core.js`'i otomatik/tekrarlanabilir şekilde üretir (§2'de ayrıntılı). `--check` modu CI kapısıdır. |
| `bb84/tools/build_photonnet_html.js` | `PhotonNet.html` içindeki gömülü `<script>` uygulama bloğunu güncel `PhotonNet2.jsx`'ten otomatik olarak yeniden derler (aynı TS transpileModule mantığı). Marker yorumu tam olarak bir kez görünmüyorsa dosyayı değiştirmeden İPTAL EDER. |
| `bb84/tools/extract_qkdnetsim_profile.js` | `qkdnetsim_traffic_profile.json`'ı gerçek bir QKDNetSim ns-3.46 çalıştırmasının çıktı dosyalarından yeniden üretir. Şekil (zaman-yoğunluk deseni) ile olay-sayısı (gerçek log satırları) BİLEREK ve AÇIKÇA farklı iki metrikten birleştirilir — `methodologyNote` alanında belirtilir. |
| `bb84/tools/verify_photonnet_html.js` | Yeniden derlenen `PhotonNet.html`'i gerçek Chromium'da (Playwright) açıp konsol/sayfa hatası olmadan monte olduğunu doğrulayan bir E2E kontrolü. |
| `bb84/tools/QKDNETSIM_BUILD.md` | QKDNetSim'in (üçüncü-taraf, akademik yayınlanmış bir ns-3 modülü) bu sandbox'ta apt-get/PyPI/gitlab.com engelliyken kaynaktan nasıl derlendiğini belgeler — 3 spesifik isim-uyuşmazlığı çözümü ve iki bağımsız build oturumunda elde edilen kesin deterministik çıktı değerlerini (28.140 teslim edilen anahtar) kaydeder. |
| `bb84/ci/run_integration_tests.sh` | GitHub Actions VE GitLab CI YAML'larının her ikisinin de çağırdığı merkezi CI entegrasyon-test orkestrasyonu. `KME_MODE` ile iki mod: "ephemeral" (varsayılan — geçici CA/sertifika, tam temizlik) ve "external" (gerçek staging KME uç noktasına karşı, CI-secret sertifikalarıyla). |
| `.github/workflows/production-pipeline.yml`, `.gitlab-ci.yml` | CI/CD boru hatları — extract-core-check, production-build-strip, software-hsm-pkcs11, external-real-certs işlerini içerir. |
| `package.json` | `npm run extract-core` / `extract-core:check` script kısayolları; `typescript` devDependency. |

### 4.6 HAL — Python donanım soyutlama katmanı

`hal/` dizini, PhotonNet'in tarayıcı-tarafı BB84 simülasyonunu (`propPhoton()`/
`deriveSiftedKey()`) gerçek QKD donanımına bağlamak için tasarlanmış saf
Python bir soyutlama katmanıdır — bugün gerçek donanım YOKTUR, ama paket
gerçek bir cihazın mevcut koda SIFIR değişiklikle, sadece TEK yeni bir
sınıf yazılarak eklenebileceği şekilde inşa edilmiştir.

**Mimari kavrayış:** `propPhoton()` bir OLASILIK modelidir ("bu foton
hayatta kaldı mı" sorusuna cevap verir), gerçek donanım ise bu soruyu
ZATEN CEVAPLAMIŞTIR (bir dedektör ya tıklar ya tıklamaz) — bu yüzden gerçek
donanımın işi bit ÜRETMEK değil, Bob'un gerçek dedektör tıklamalarını
Alice'in iletim zaman damgalarıyla ZAMAN-ETİKETİ KORELASYONU yaparak QBER
türetmektir. Bu yüzden HAL, `propPhoton` ile hiçbir ilişkisi olmayan
tamamen bağımsız bir katman olarak yazılmıştır.

**Katmanlı mimari (aşağıdan yukarı):**

```
types.py (paylaşılan veri sınıfları, donanıma özgü kod yok)
   ↓
hardware_interface.py (soyut sözleşme: connect/disconnect/arm/read_clicks/status)
   ↓
simulated_hardware.py / serial_hardware.py / tcp_hardware.py (değiştirilebilir uygulamalar)
   ↓
binary_click_hardware.py (Serial/TCP paylaşımlı referans tel-protokolü)
   ↓
transport.py (ham bayt-düzeyi Serial/TCP taşıma)
   ↓
link_manager.py (yeniden bağlanma/backoff, arka plan yoklama, sınırlı kuyruk)
   ↓
time_tag_correlator.py (RNG'siz korelasyon/QBER türetimi)
   ↓
bridge_server.py (Flask REST+SSE köprüsü — PhotonNet.html'in Donanım paneline)
```

| Dosya | Ne yapar |
|---|---|
| `hal/README.md` | Tam mimari dokümantasyonu (yukarıda özetlendi) + bilinen sınırlamalar. |
| `hal/hardware_interface.py` | Soyut `HardwareInterface` sözleşmesi — kasıtlı olarak minimal, tek bir satıcının API'sine göre tasarlanmamış (belirtilen en büyük gerçek-donanım-entegrasyonu hatası budur). |
| `hal/simulated_hardware.py` | `SimulatedHardware` — gerçek donanım gelmeden önce tüm boru hattının (LinkManager→TimeTagCorrelator→bridge_server→UI) uçtan uca test edilmesini sağlayan sahte uygulama. Kayıp/gürültü modeli PhotonNet2.jsx'in `propPhoton()`'undan bit-birebir portlanmıştır ama mimarisi yalnızca tıklama ZAMAN DAMGALARI üretir — bit yorumu daha sonra, gerçek donanımda olacağı gibi `TimeTagCorrelator`'da yapılır. |
| `hal/serial_hardware.py` | `SerialHardware` — gerçek bir USB-UART seri SPAD/TDC cihazı için somut sürücü. **Dürüst durum:** `pyserial` bu sandbox'ta kurulamıyor, bu yüzden GERÇEK bir seri portla hiç canlı test edilmedi — sadece paylaşılan protokol mantığı (TCP mock yolu üzerinden) doğrulandı. |
| `hal/tcp_hardware.py` | `TCPHardware` — ağ-erişilebilir bir SPAD/TDC cihazı için somut sürücü. Sadece stdlib `socket` kullanır, bu yüzden sandbox'ta değişmeden çalışır; sahte bir TCP cihaz sunucusuna karşı uçtan uca doğrulandı. |
| `hal/binary_click_hardware.py` | `SerialHardware` ve `TCPHardware`'in paylaştığı referans tel-çerçeveleme uygulaması (13 bayt ikili tıklama kaydı). **Dürüst durum:** bu protokol GERÇEK bir satıcı spesifikasyonu DEĞİLDİR, gerçek donanım/satıcı belgeleri gelene kadar makul bir yer tutucu varsayımdır. |
| `hal/bridge_server.py` | Tarayıcı UI'sını (`PhotonNet.html`) yerel HAL Python servisine bağlayan Flask tabanlı REST+SSE köprüsü. **Dürüst durum:** bu sandbox'ta gerçek bir WebSocket kütüphanesi kurulamadığı için stdlib/Flask tabanlı REST+SSE kullanıldı. |
| `hal/link_manager.py` | `LinkManager` — yeniden-bağlan-ile-geri-çekilme, sürekli arka plan yoklaması, sınırlı tıklama kuyruğu (maxsize=200.000, en-eski-düşür). |
| `hal/time_tag_correlator.py` | `TimeTagCorrelator` — "gerçek donanım entegrasyonunun kalbi": Alice'in iletim zaman damgalarını Bob'un dedektör tıklama zaman damgalarıyla bir eşleşme penceresi içinde eşleştirir, sadece baz-eşleşen çiftlerden eleme/QBER türetir. Hiç RNG kullanmaz. |
| `hal/noise_matrix_sweep.py` | Çalışan `bridge_server.py`'ı (gerçek HTTP çağrılarıyla) bir mesafe taramasında sürer ve dönen `SiftingResult`'lardan bir "gürültü matrisi" türetir. |
| `hal/transport.py` | `Transport` soyutlaması (`TCPTransport`, `SerialTransport`) — ham bayt gönder/al. |
| `hal/types.py` | Paylaşılan veri sınıfları/enum'lar (`Basis`, `DetectorChannel`, `TransmitEvent`, vb.) — donanıma özgü kod içermez. |

### 4.7 Grafik üreticileri (`gen_*.js`)

Depoda **45 tane** `gen_*.js` dosyası vardır. Bunların neredeyse tamamı aynı
mekanik kalıbı izler: karşılık gelen `*_test.js`/drill dosyasının ürettiği
`reports/*.json` dosyasını okur ve tek-dosyalık, kendi kendine yeten bir
HTML grafiği (ışık/karanlık tema, ekran görüntüsüyle doğrulanmış, projenin
ortak SVG/CSS "ev stili" ile) üretir. Örnek eşleşmeler:

| Grafik üretici | Kaynak test/drill |
|---|---|
| `gen_precision_hygiene_chart.js` | `exact_slot_time_test.js` + `epoch_reset_controller_test.js` (bu oturumda eklendi) |
| `gen_mtls_failsafe_debounce_chart.js` | `mtls_failsafe_debounce_test.js` |
| `gen_hardware_aging_chart.js` | `hardware_aging_model_test.js` |
| `gen_faraday_cage_shielding_chart.js` | `faraday_cage_shielding_test.js` |
| `gen_rf_noise_bridge_chart.js` | `rf_noise_bridge_test.js` |
| `gen_floating_point_accumulation_chart.js` | `floating_point_accumulation_test.js` |
| `gen_hysteresis_band_chart.js` | `hysteresis_band_test.js` |
| `gen_shielded_channel_chart.js` | `shielded_detector_physics_test.js` |
| `gen_timetag_acquisition_chart.js` / `gen_timing_coincidence_chart.js` | `timetag_acquisition_test.js` / `timing_coincidence_test.js` |
| `gen_detector_recalibration_chart.js` | `detector_recalibration_test.js` |
| `gen_optical_delay_line_chart.js` / `gen_odls_optimization_chart.js` | `optical_delay_line_test.js` / `odls_optimization_drill.js` |
| `gen_predictive_jitter_chart.js` | `predictive_jitter_test.js` |
| `gen_memory_threshold_chart.js` | `memory_technology_threshold_test.js` |
| `gen_entanglement_charts.js` | `entanglement_*` test dosyaları |
| `gen_network_routing_chart.js` | `network_matrix_routing_test.js` / `multipath_routing_test.js` |
| `gen_qkd_network_scale_chart.js` / `gen_qkd_rate_chart.js` / `gen_qkd_limit_chart.js` / `gen_qkd_flow_chart.js` / `gen_qkd_secure_channel_chart.js` | ilgili `qkd_*` test dosyaları |
| `gen_backpressure_chart.js` / `gen_continuous_chart.js` / `gen_duty_cycle_chart.js` / `gen_ceiling_chart.js` | `backpressure_test.js` / `continuous_stream_test.js` / `duty_cycle_test.js` / `sla_ceiling_test.js` |
| `gen_authenticated_channel_chart.js` / `gen_production_gate_chart.js` | `authenticated_channel_test.js` / `production_gate_test.js` |
| `gen_key_supply_chart.js` / `gen_controller_chart.js` | `key_supply_test.js` / `qkd_session_controller_test.js` |
| `gen_etsi014_interop_chart.js` / `gen_qukaydee_realistic_chart.js` | `etsi014_interop_test.js` / `qukaydee_realistic_test.js` |
| `gen_landauer_chart.js` / `gen_resonance_chart.js` / `gen_safety_margin_chart.js` / `gen_collapse_drill_chart.js` / `gen_state_poisoning_chart.js` / `gen_layer_stress_chart.js` / `gen_async_sync_chart.js` | ilgili drill dosyaları |
| `gen_client_report_html.js` / `gen_qkdnetsim_bridge_report_html.js` | `client_network_report.js` / `qkdnetsim_traffic_bridge.js` |
| `gen_architecture_map.js` | (bağımsız) mimari haritası/diyagramı üretir |

### 4.8 Kök seviyesi uygulama dosyaları

| Dosya | Ne yapar |
|---|---|
| `PhotonNet2.jsx` | Uygulamanın TAM kaynağı (849KB, ~14.700 satır) — UI + algoritma iç içe. `extract_core.js`'in girdisi. |
| `PhotonNet.html` / `PhotonNet_offline.html` | Derlenmiş, tarayıcıda doğrudan açılabilen tek-dosyalık uygulama sürümleri (React bundle gömülü). |
| `bundler/build_bundle.js`, `react_bundle.js`, `captured_modules.json`, `trace_bundle.js` | React'i CDN'siz, tek dosyaya gömmek için özel bundling araçları. |
| `check_syntax.js` | `PhotonNet2.jsx`'i TS transpileModule ile derleyip sözdizimi hatalarını satır numarasıyla raporlayan hafif geliştirme-döngüsü aracı. |
| `gen_world_network.py` / `world_network.js` | Neredeyse her ülkenin başkentini (+büyük ülkeler için ikinci bir metropolü) içeren küresel bir QKD ağ topolojisi üretir — koordinatlar AÇIKÇA yaklaşık/stilize (navigasyon için değil), en yakın 2 komşuya + kıtalar-arası "omurga" bağlantılarına göre bağlanır. |
| `hal/` | §4.6'da ayrıntılı — Python donanım soyutlama katmanı. |
| `delivery/photonnet_pki_hardening.zip` | PKI sertleştirme çalışmasının paketlenmiş teslimat arşivi. |
| `*.png` (ekran görüntüleri) | Çeşitli UI panellerinin (dünya haritası, TRF/WDG/NGM sekmeleri, kriz kurtarma, üretim denetimi vb.) doğrulama ekran görüntüleri. |

---

## 5. Mühendislik/test kültürü — tekrar eden desenler

Bu depoyu okurken fark edilmesi gereken, dosyalar arası TEKRARLAYAN
disiplinler:

1. **Çekirdek dokunulmazlığı programatik olarak kanıtlanır.** Neredeyse
   her test/drill dosyası, çalıştırmadan önce ve sonra `photonnet_core.js`
   SHA-256'sını karşılaştırıp raporlar — "dokunulmadı" iddiası bir kere
   varsayılmaz, HER çalıştırmada yeniden doğrulanır.
2. **Tek-nokta sabitleri güvenilmez, ızgara/binary-search ile doğrulanır.**
   Bu oturumda en az üç kez (φ_high, histerezis bant genişliği h, exact
   BigInt tavanı) TEK bir ölçülmüş nokta veya varsayımdan türetilen bir
   sabit, daha yoğun bir ızgara/aramayla ÇÖKTÜĞÜ görülüp yeniden
   türetilmiştir — ve REDDEDİLEN ölçüt/varsayım, neden reddedildiğinin
   kanıtı olarak raporda BIRAKILIR, silinmez.
3. **Simüle/sezgisel değerler gerçek-donanım değerlerinden açıkça
   ayrılır.** `sourceIsRealHardware: false` alanları, uydu-vs-yer
   dedektör kalibrasyonu uyuşmazlığı uyarıları, RF-marjı→karanlık-olasılık
   kalibrasyonunun doğrulanmamış bir varsayım olduğu notları, yaşlanma
   modeli katman değerlerinin büyüklük-mertebesi yer tutucular olduğu
   notları — proje sürekli olarak henüz gerçek donanımla doğrulanmamış
   olanı, ölçülmüş gerçek gibi SUNMAMAYA özen gösterir.
4. **Sandbox ağ/paket kısıtları açıkça belgelenir, gizlenmez.** SoftHSM2/
   OpenSC/pkcs11js/pyserial/gerçek Qiskit hiçbiri bu ortamda
   kurulamamıştır (ağ/PyPI/npm erişimi engelli) — ilgili dosyalar bunu
   "test edilemedi, CI'da ilk gerçek doğrulama olacak" şeklinde açıkça
   belirtir, sanki test edilmiş gibi davranmaz.
5. **Ters/rahatsız edici bulgular saklanmaz.** Yönlendirme sırasının
   sadakati artırmadığı, geri-basıncın ani talep sıçramalarında daha
   FAZLA ret verebileceği, E91'in BBM92'den "daha iyi" olmadığı, gerçek
   bir resync/bellek-sızıntısı hatasının bulunup düzeltildiği gibi
   bulgular doğrudan raporlanır, yumuşatılmaz.
6. **"Kanca" (hook) deseni:** gerçek dünya entegrasyon noktaları (mTLS
   oturum tazeleme, HSM imzalama) genellikle bir callback/kanca olarak
   sunulur; ilgili katman dosyası bu kancayı ÇAĞIRIR ama gerçek ağ/TLS
   davranışını KENDİSİ UYGULAMAZ — bu, "gerçek KME sürecini değiştirmeme"
   ilkesini korur.

---

## 6. IBM ETSI-014 sertifikasyon denetimi — özet yargı

`bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md` (14 testlik `ibm_math_audit.js` +
fiziksel çapraz-doğrulama `bb84_statevector.py`/`compare_js4.js` temelinde,
72 export'un tamamı okunarak hazırlanmıştır):

**ETSI GS QKD 014 arayüz/protokol uyumluluğu:** muhtemelen GEÇER (API
şekli, mTLS, SAE kimlikleri doğru).

**Resmi kuantum-güvenlik sertifikasyonu:** **ALINAMAZ**, çünkü:

- **(A — mimari, simülasyonda düzeltilemez)** "Kuantum" bit üretimi
  aslında tek bir 32-bit `mulberry32` PRNG tohumundan (`entanglementSeed`)
  türeyen tamamen deterministik bir akıştır. Aynı tohum → bit-bit aynı
  akış (Test 1). Tohum uzayı (2³²≈4.3×10⁹) modern GPU/ASIC ile saatler-
  günler mertebesinde taranabilir — AES-128'in anahtar uzayından ~10²⁹ kat
  daha küçük (Test 2/8: 2×10⁶ denemede <1ms'de bir çıktı bulundu). Nihai
  gizlilik-yükseltme (Toeplitz) tohumu da AYNI 32-bit kaynaktan türer
  (Test 6) — yani "gizli" anahtarın kendisi de tahmin edilebilir. Bu,
  GLLP/Serfling ispatının dayandığı "Eve'in ölçüm sonuçları hakkında
  ön-bilgisi yok" aksiyomunu doğrudan ihlal eder. **Gerçek donanım QRNG
  (veya en azından NIST SP 800-90B onaylı donanım CSPRNG) olmadan bu
  sorun çözülemez.**
- **(B — düzeltilebilir, uygulama/süreç eksikleri)** Oturum-seviyesi
  epsilon bütçesi TAKİP EDİLMİYOR (composable güvenlik açığı — günde
  10.000 blok × 1 yıl ≈ toplam ε≈7×10⁻⁴, artık "ihmal edilebilir"
  değil); `converged=true` API'si yanıltıcı olabilir (Test 4: %35 QBER'de
  bile Cascade `converged=true` dönebiliyor, ama `ProductionSecurityAudit`
  doğru şekilde reddediyor — API netliği sorunu, güvenlik açığı değil);
  LDPC üretimde gereksiz çalışıyor (performans, güvenlik değil); QBER
  eşiğine yakın davranış DOĞRU ama belgelenmemiş (kullanılabilir QBER
  bandı gerçekte ~%9 ve altı, nominal %11 değil).

**Nihai yargı:** mühendislik kalitesi (Serfling/GLLP formülü, Cascade/
LDPC, Toeplitz evrensel-hash, n/k ayrımı) literatürle tutarlı ve doğru
uygulanmıştır — ama bunların hepsi yalnızca "girdi gerçekten kuantum
rastgeleliği taşıyorsa" güvenlidir. Bu sistemde girdi kuantum değil,
klasik ve tekrarlanabilir bir PRNG akışıdır. B kategorisi ne kadar
düzeltilirse düzeltilsin, A kategorisi (donanım QRNG) çözülmeden resmi
bir "bilgi-teorik güvenli" onayı verilemez.

---

## 7. Üretime hazırlık durumu (PKI/mTLS/HSM)

`bb84/PRODUCTION_READINESS_ROADMAP.md`'den özet (mTLS/PKI/HSM katmanının
IBM ile teknik entegrasyonu için — yukarıdaki §6'daki temel kuantum-
rastgelelik sorunundan AYRI bir konudur):

| # | Madde | Öncelik | Durum |
|---|---|---|---|
| 1 | Referans OCSP yanıtlayıcısını üretim-sınıfı bir çözümle değiştir | P0 | Açık — kalıcı bağlantıda azami kilitlenme ~60sn ölçüldü |
| 2 | HSM/PKCS#11 gerçek donanımla doğrulama | P0 | Yazılımsal katman (SoftHSM2) YAZILDI, sandbox ağ kısıtı yüzünden hiç çalıştırılamadı — ilk doğrulama CI'da |
| 3 | Bağımsız güvenlik denetimi/sızma testi | P0 | Açık — şimdiye kadarki her şey İÇ test |
| 4 | Demo kimlik doğrulama kodunun build-zamanı sökülmesi | P0 | **✅ ÇÖZÜLDÜ** — 19/19 test sökülmüş derlemeye karşı da geçti |
| 5-9 | OCSP HA, PKI yönetişim dokümantasyonu (CP/CPS), olay müdahale runbook'u, rotasyon otomasyonu, CI/CD'nin gerçek IBM ortamına karşı koşulması | P1 | Açık |
| 10-12 | OCSP negatif önbellek TTL'i, bağlantı yeniden-kullanım rehberi, Toeplitz yük testi | P2 | Açık, üretimi engellemez |

**Şimdiye kadar CANLI test edilip doğrulanmış olanlar:** kısa-ömürlü
sertifikalar + sıfır-kesintili/iptalli rotasyon senaryoları; çift-katmanlı
iptal (CRL+OCSP); fail-closed davranış (OCSP erişilemezse geçerli
sertifikalar bile reddediliyor); mTLS+ETSI-014 uyumu (19/19 test);
demo/bypass kodunun fiziksel sökülmesi; CI/CD entegrasyonu (GitHub
Actions+GitLab CI); hava-boşluğu mimarisi tasarımı.

**Önerilen aşamalandırma:** (1) şimdi — teknik inceleme/pilot, üretim
trafiği taşımamalı; (2) P0 sonrası — sınırlı/staging entegrasyon; (3) P1
sonrası — genel kullanılabilirlik (GA).

---

## 8. Nasıl çalıştırılır

```bash
# Çekirdeği kaynaktan (PhotonNet2.jsx) yeniden üret / doğrula
node bb84/tools/extract_core.js --check      # yalnızca doğrular, yazmaz
node bb84/tools/extract_core.js              # üretir ve üzerine yazar

# Herhangi bir öz-test/drill dosyasını çalıştır (çoğu bağımsızdır)
node bb84/floating_point_accumulation_test.js
node bb84/epoch_reset_controller_test.js
node bb84/hardware_aging_model_test.js
# ... (bb84/*_test.js dosyalarının tamamı aynı şekilde çalıştırılır)

# Bir test/drill'in JSON raporuna karşılık gelen HTML grafiğini üret
node bb84/gen_precision_hygiene_chart.js     # → /tmp/precision_hygiene_chart.html

# Yerel bir demo PKI kurup gerçek mTLS ile KME sunucusunu başlat
bash bb84/generate_demo_pki.sh
node bb84/etsi014_kme_server.js --cert=... --key=... --ca=...

# Üretim-sertleştirilmiş (demo kod sökülmüş) KME derlemesini üret
node bb84/build_production_server.js

# CI entegrasyon testlerini yerel olarak çalıştır (geçici PKI ile)
bash bb84/ci/run_integration_tests.sh

# HAL (Python donanım soyutlama) köprü sunucusunu başlat
python3 hal/bridge_server.py
```

**Bilinen ortam bağımlılıkları:** bazı testler (`etsi014_client_lib_test.js`,
`etsi014_interop_test.js`, `qkd_secure_channel_test.js`,
`qukaydee_realistic_test.js`, `buffer_starvation_test.js`) çalışmadan önce
`bb84/generate_demo_pki.sh` ile üretilen sertifikaların `/tmp/pki/`
altında bulunmasını veya `--kme-url` gibi ek argümanları bekler — bu bir
regresyon değil, çalıştırma-öncesi kurulum adımıdır.

---

## 9. Dizin haritası

```
photonnet/
├── PhotonNet2.jsx                    # Uygulamanın TAM kaynağı (React+algoritma)
├── PhotonNet.html / _offline.html    # Derlenmiş tek-dosya uygulama
├── package.json                      # extract-core script kısayolları
├── bundler/                          # React'i tek dosyaya gömen özel bundler
├── hal/                              # Python donanım soyutlama katmanı (§4.6)
├── delivery/                         # Paketlenmiş teslimat arşivleri
├── gen_world_network.py, world_network.js   # Küresel ağ topolojisi üretici/verisi
└── bb84/                             # Ana simülasyon + katman kod tabanı
    ├── photonnet_core.js             # ÇEKİRDEK — asla elle değiştirilmez (§3)
    ├── tools/                        # extract_core.js, build/verify araçları (§4.5)
    ├── pki_tools/                    # CA/HSM/OCSP/rotasyon script'leri (§4.3)
    ├── ci/                           # run_integration_tests.sh (§4.5)
    ├── docs/                         # PHI_HIGH.md, QUKAYDEE.md (kalibrasyon notları)
    ├── reports/                      # Her test/drill'in ürettiği JSON kanıt dosyaları
    ├── *_test.js, *_drill.js         # Öz-test/tatbikat dosyaları (§4.1-4.4)
    ├── gen_*.js                      # Grafik üreticileri (§4.7)
    ├── IBM_ONAY_MATEMATIKSEL_DENETIM.md      # §6'nın kaynağı
    └── PRODUCTION_READINESS_ROADMAP.md        # §7'nin kaynağı
```

---

*Bu README, projenin tüm `bb84/` (166 dosya), `hal/` (13 Python dosyası)
ve kök seviyesi dosyaları taranarak, her dosyanın kendi baş yorumundaki
amaç/mekanizma/dürüstlük notları temel alınarak derlenmiştir. Hiçbir sayı
veya iddia bu tarama dışında uydurulmamıştır.*
