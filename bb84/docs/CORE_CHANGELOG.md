# photonnet_core.js — Çekirdek Sürüm Günlüğü

`bb84/photonnet_core.js`, `PhotonNet2.jsx`'ten `bb84/tools/extract_core.js` ile otomatik çıkarılır
(CI kapısı 2: `extract_core.js --check`). Çekirdek SHA-256'sı birçok testte sabitlenmiştir; bu dosya
her sürüm değişikliğinin tek kaydıdır. Bu tarihten önce yazılmış rapor ve belgeler (ör. `bb84/reports/*`,
EIC test raporu) **v1** hash'ine atıf yapar — bu beklenen bir durumdur, o belgeler v1 dönemini anlatır.

| Sürüm | SHA-256 | Kısa |
|---|---|---|
| v1 | `8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05` | `8f879fde…dc7b05` |
| v2 | `157d81da543cabfafca4a58b69aac574ce7180ac760563cecd918c666581cf3b` | `157d81da…81cf3b` |
| v3 | `421513f72bad1fb32b24c78453f9f6fdcbdbab83bd10f044d58ffc71b42bb3d4` | `421513f7…2bb3d4` |
| v4 | `af1f56a1adbe6e7d7566d361aedc60c4149ecf49557f4e8f2c535937f01a12c3` | `af1f56a1…1a12c3` |
| v4.1 | `5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313` | `5c12cde3…676313` |
| v4.2 | `b7b6b2437ecdd037cff301b2441ac522244018294a4755b8b3d36876c3a4a560` | `b7b6b243…a4a560` |
| v4.3 | `5b7521ab4157de7491fcbc98dd134a84b26b881814d3aa3dc5726c3aa4f342c2` | `5b7521ab…f342c2` |
| v4.4 | `e8de863c426936e0398c9848b9cdea5441ec846ec5dad9854f8976201343815c` | `e8de863c…43815c` |
| v5 | `528321cb930b3266c602f42a0ab304128e839ba663b1dbb4bdaad02de1130cc1` | `528321cb…130cc1` |

## v5 (2026-11) — hibrit uydu + fiber anahtar oturumu, QBER erken uyarı bandı, olay akışı (TS-HYBRID-QKD-04)

**Algoritma eklendi.** `hopChannels` verilmeyen oturumlar v4.4 ile birebir aynı sonucu verir (bb84/hybrid_qkd_test.js Y8:
aynı tohumlarla aynı darbe sayısı, QBER ve OTP anahtarı).

- **LeoPassGeometry:** dairesel LEO yörüngesinde tek geçiş (Kepler, küresel Dünya; Dünya dönüşü ve kırılma ihmal).
  Görünürlük = sin(yükselti), anahtar için ≥ 0,1. 550 km / tepe 75°: periyot 95,5 dk, pencere ±285 s, Doppler kenarda
  ±23 ppm (1550 nm'de ±36 pm), TCA'da işaret değiştirir.
- **SatelliteDownlinkChannel:** η = Gauss ışın geometrisi (15 µrad, 1 m alıcı) × hava kütlesi (T_zenit 0,8) × izleme
  (PointingBudget) × optik 0,5 × log-normal sönüm (ScintillationModel, tur başına AR(1)). Ölçülen: tepe 25,9 dB, 645 km
  27,2 dB, 1200 km 34,2 dB — Micius'un bildirdiği ~22–35 dB aralığıyla kaba uyum. Parametreler varsayımdır.
- **SecureMessageSession:** `hopChannels` (atlama başına fiber / serbest uzay), `evesdrop` atlama dizisi (ör. `[0]` =
  yalnız uydu atlaması), `onEvent` (HOP_CHECK, QBER_WARNING, SESSION_ABORTED, KEY_DELIVERED). Yeni iptal kodu
  **SAT_NOT_VISIBLE**: uydu atlaması sırasında görünürlük < 0,1 → anahtar yok. Serbest-uzay atlamasında gökyüzü arka
  planı (gündüz 5 MHz) QBER'i ~%48'e çıkarır → HOP_QBER (gerçek uydu QKD'sinin gece çalışmasıyla tutarlı).
- **computeDynamicAlpha:** DCR'ye bağlı QBER erken uyarı bandı. Beklenen QBER = e_d(1−f) + f/2 (f: ölçülen algılama
  olasılığı ve fiziksel karanlık-click olasılığından hayalet click payı); uyarı eşiği Binom(k, beklenen)'in tam üst α
  kuantili (α = 10⁻³, sabit yanlış-alarm olasılığı). İlk sürüm normal yaklaşım kullanıyordu; %1,6 ve k = 850'de yanlış
  uyarı 2,7·α ölçüldü, tam kuantille 0,5·α. **İptal eşiği %11 bu banttan etkilenmez** — gürültü ile dinleme kanıt
  açısından ayırt edilemez; eşik gürültüye göre gevşetilirse dinleyici kendi hatasını o gürültüde saklayabilir.
- **deriveSiftedKey:** `detectorCtx.channelEta` verilirse fiber yayılımı yerine bu geçirgenlik ve aynı e_d kullanılır.
- **Arayüz:** 🛰 HİBRİT ANAHTAR anahtarı ve geçiş anı kaydırıcısı (yükselti, görünürlük, kayıp, Doppler canlı);
  hibrit kipte dinleme yalnız uydu atlamasına; güvenlik panelinde "Erken uyarı bandı" ve "Uydu görünürlüğü" satırları;
  atlama matrisinde 🛰 ve ▲ işaretleri; olaylar KAYIT'a "📡 OLAY" olarak düşer. Hibrit kipte darbe bütçesi 2²⁴
  (100 MHz kaynakta geçişin 0,17 s'si) — gerçek bir geçiş ~570 s anahtar toplar; düşük yükseltide KEY_BUDGET bu
  simülasyon bütçesinin sonucudur, fiziksel sınır değildir.
- **HAL:** `hal/hybrid_sync.py` (LeoPass, HybridSyncSimulator: Doppler'i zaman etiketlerine uygular),
  `hal/innovation_observer.py` (KalmanInnovationObserver: NIS χ² testi, sabit α), `correlate_tracked(observer=…)`.
  `hal/test_hybrid_sync.py`: senkron kipi geçişin 5 anında referans QBER'de, gözlemci yanlış alarm vermiyor, veri kipi
  uydu sayım hızında kilitlenmiyor (fail-closed), senkron kanalına 300 ps kaydırma alarm, 1500 ps sıçrama; yalnız
  dedektör tarafındaki kaydırma gözlemcide görünmez (anahtar kaybı olarak ortaya çıkar — belgelendi).
- `PHOTONNET_CORE_VERSION` "v5".

## v4.4 (2026-11) — gürültü kapısı fiziği düzeltildi; gürültü etkisi ve birleşik QBER arayüzde

**Algoritma değişti** (yalnız `NoiseGateMiddleware.effectivePhantomProbability`); nominal koşulda (sapma 0, sızıntı 0)
sonuç v4.3 ile aynı olasılığı verir.

- **Kusur:** Anahtar oturumu (`deriveSiftedKey`) dedektörde oluşan hayalet click olasılığını kalibrasyon TAHMİNİNDEN
  (`calibratedDarkRateHz`) hesaplıyordu. Bir tahmin gerçek karanlık sayımları yok edemez. Ölçüldü (5× ısıl dalgalanma
  + 3200 Hz fiber sızıntısı): enjeksiyon anında fiziksel gürültünün %0,2'si anahtara ulaşıyordu; 2,2 s'lik kalibrasyon
  turlarıyla gündüz kipinde ~26 s sonra bile yalnız %8–18'i. Arayüz tatbikatında gürültü enjeksiyonunun QBER'i
  değiştirmemesinin bir nedeni buydu (kullanıcı eleştirisiyle bulundu; önceki açıklama "kapı filtreledi" yanlıştı).
- **Düzeltme:** fiziksel olasılık = ham oran (sıcaklık sapması + sızıntı) × daraltılmış kapı. Kalibrasyon tahmini
  yalnız kapı denetleyicisini besler; yeni `estimatedPhantomProbability` tahmini gösterim için verir. Düzeltmeden
  sonra kullanılan/fiziksel oran her zaman %100. 60 km tek atlama: QBER_test %1,17 → gürültüyle %2,17.
- **Ölçek (değişmedi, artık görünür):** 150 km üstü rotalar ≤60 km atlamalara bölünür. 60 km'de enjekte edilen
  gürültünün QBER katkısı ~%0,25–1; %11'e varmak için çok daha uzun atlama gerekir, orada da anahtar bütçesi önce biter
  (120 km tek atlama + gürültü: QBER_test %5,4 iken KEY_BUDGET iptali).
- **🔬 GÜRÜLTÜ sekmesi:** yeni "ANAHTAR OTURUMUNA ETKİSİ" paneli (`NgmKeyImpact`): fiziksel ve tahmini karanlık-click
  olasılığı, son iletimde ölçülen katkı (hayalet click / elenmiş bit), şu anki gürültüyle aynı atlamada beklenen katkı ve
  %11 eşiği için gereken gürültü katı. `res.session` artık `lostCount`, `darkClicks`, `hopKm` taşıyor.
- **📈 SONUÇLAR:** çok atlamalı rotada QBER kutucuğu "en kötü atlama" olarak etiketlenir ve birleşik değeri gösterir
  (1842 km/31 atlama: en kötü %2,46, birleşik %1,57; k ≈ 860 test bitiyle atlama başına sapma ±0,4 puan).
- **Atmosferik sürgüler:** "yalnız uydu mesaj kanalı · fiber anahtar oturumunu etkilemez" notu (oturum freeSpace:false).
- `PHOTONNET_CORE_VERSION` "v4.4".

## v4.3 (2026-11) — canlı güvenlik kriterleri paneli, iptal kartı (yalnız arayüz)

Algoritma değişmedi; oturum, kanıt ve anahtar bitleri v4.2 ile aynı. Hash değiştiği için yeni satır açıldı.

- **Yeni panel:** 📈 SONUÇLAR'da "GÜVENLİK KRİTERLERİ — SERFLING / GLLP (CANLI)" (`ResSecurityCriteria`). Son iletim için
  `SecureMessageSession`'ın uyguladığı koşulları satır satır gösterir: her atlamada QBER_test < %11, test örneklemi
  k ≥ 64, sonlu-anahtar ℓ ≥ mesaj biti (Serfling μ + GLLP), Cascade yakınsaması, klasik kanal kimlik doğrulaması ve
  fail-closed sonucu. Oturum iptal edildiyse panel kırmızı çerçeve ve "ALARM — OTURUM İPTAL EDİLDİ (kod)" başlığı alır.
  Değerler `res.session.hopChecks`'ten okunur; panel kendi başına karar vermez.
- **İptal kartı:** iptal edilen iletimde başlık "Kısmi İletim" yerine "İletim İptal Edildi"; R_∞ ve Q_ph sonlu
  değilse "NaN" yerine "—".
- **Tatbikat:** `bb84/tools/ui_abort_drill.js` arayüzü Playwright ile sürer (taban → gürültü enjeksiyonu → dinleme →
  toparlanma) ve `bb84/reports/ui_abort_drill.json`'a yazar. npm test'e dahil değil (Chromium gerekir).
- `PHOTONNET_CORE_VERSION` "v4.3".

## v4.2 (2026-11) — 📈 SONUÇLAR sekmesi (yalnız arayüz)

Algoritma değişmedi; oturum, kanıt ve anahtar bitleri v4.1 ile aynı. Hash değiştiği için yeni satır açıldı.

- **Yeni sekme:** `ResultsDashboard` bileşeni. Yalnız ölçülen veriyi gösterir: bu oturumdaki iletimlerin QBER_test ve ℓ
  geçmişi, son iletimin atlama başına kanıt matrisi (`hopChecks`: n, k, QBER_test, Cascade sızıntısı, ℓ), derleme
  anında gömülen test raporu özeti ve README §6–§7'deki açık konular. Ölçülmeyen değer "—" olarak kalır.
- **Sonuç nesnesi:** `res.session` artık `hopChecks`, `leakEC`, `worstHopQber`, `endToEndKeyBits`, `relayPublicBits`,
  `ecDiscardedBlocks`, `totalKm` alanlarını taşıyor (iptal edilen oturumlarda da son kontrol).
- **Üst çubuk:** kendi içinde yatay kayıyor. Önceden dar ekranda kök kapsayıcı (overflow:hidden) kayıyor, sol panel
  kesiliyor ve 1366 px'te son sekmelere ulaşılamıyordu.
- **Rapor özeti:** `bb84/tools/build_reports_snapshot.js` `bb84/reports/*.json` ve son `npm test` özetini
  `bb84/reports/reports_snapshot.js` dosyasına yazar (`npm test` sonunda otomatik); HTML onu sabit bir `<script src>`
  etiketiyle yükler. İçerik HTML'e gömülmez: gömülü kopya her test koşusunda eskiyip `--check`'i bozuyordu (denendi).
- `PHOTONNET_CORE_VERSION` "v4.2".

## v4.1 (2026-10) — sonuç kartında ℓ etiketi (yalnız arayüz)

Algoritma değişmedi; oturum, kanıt ve anahtar bitleri v4 ile aynı. Hash değiştiği için yeni satır açıldı.

- **Kusur:** Sonuç kartındaki "ℓ=…bit kanıtlı" rozeti `finalSecureKeyLen` alanını gösteriyordu. Bu alan v2'den beri
  OTP'nin mesajı şifreledikten SONRA artan anahtarın uzunluğuydu (ℓ − mesaj biti). Aynı ekranda sağ paneldeki
  "KANITLI ANAHTAR ℓ" ile sonlu-anahtar satırı gerçek ℓ'yi gösterdiği için iki farklı sayı görünüyordu
  (ölçüldü: varsayılan iletimde 140 ve 244; 244 − 104 mesaj biti = 140). Vitrin ekran görüntüsü çekilirken bulundu.
- **Düzeltme:** `finalSecureKeyLen` artık gizlilik yükseltmesinden çıkan ℓ (zincirde en zayıf atlama); artan anahtar
  ayrı bir `spareKeyLen` alanında ve rozette "· N bit artan" olarak gösteriliyor.
- `PHOTONNET_CORE_VERSION` "v4.1" oldu (başlıkta görünür).

## v4 (2026-10) — mesaj oturumunda bağımsız kanal turları ve atlama başına sonlu-anahtar kanıtı

Gerekçe: katman puanlaması sırasında bulunan iki kusur. İkisi de v2'de eklenen `SecureMessageSession`'daydı.
Kabul testi: `bb84/core_v4_session_test.js`.

**K1. Turlar aynı kanal gerçekleşmesini tekrar ediyordu.**

- **Neden:** Oturum her turda aynı `QuantumKeyDistribution` örneğini kanal RNG'si vermeden çağırıyordu.
  `deriveSiftedKey` bu durumda kayıp ve hata olaylarını elenmiş bitin sırasına bağlı sabit bir tohumdan üretir.
- **Etki:** Hata konumları her turda birebir aynı çıkıyordu (ölçüldü: 3 turda aynı 8 konum). Zincir modunda
  elenmiş uzunluk da her turda aynıydı. Parametre kestiriminin varsaydığı bağımsız örnekleme bozuluyordu.
- **Düzeltme:** Her atlamanın kendi kanal RNG akışı var. Akış, entropi kaynağından tohumlanıyor ve turlar boyunca
  ilerliyor (`deriveSiftedKey`'e `historicalRng` olarak veriliyor).

**K2. Zincirde "kanıtlı ℓ" yalnız 0. atlamaya dayanıyordu.**

- **Neden:** 31 atlamalı demo rotasında uçtan uca anahtar 0. atlamanın anahtarıydı ve sonlu-anahtar hesabı yalnız
  ona yapılıyordu. Diğer atlamalar yalnızca tüm bitlerin karşılaştırılmasıyla (kâhin) bulunan QBER < %11 kontrolünden
  geçiyordu.
- **Düzeltme:** Her atlama kendi elenmiş havuzunu tutuyor ve kendi parametre kestirimini (test alt kümesi), Cascade
  uzlaşmasını, ℓ hesabını ve Toeplitz gizlilik yükseltmesini yapıyor.
- **Teslim koşulu:** Mesaj ancak her atlamada ℓ ≥ mesaj biti olunca gönderiliyor.
- **Röle:** Uçtan uca anahtar, düğümlerin açık kanaldan yayınladığı R_i = K_{i−1} ⊕ K_i değerleriyle gerçekten
  taşınıyor. Bob'un ulaştığı anahtarın Alice'inkiyle aynı olduğu denetleniyor.
- **Arayüz ve iptal mesajları:** Arayüzdeki ℓ artık en zayıf atlamanın ℓ'si ("EN ZAYIF ATLAMA"). HOP_QBER iptali
  kâhin QBER yerine o atlamanın test QBER'iyle ve doğru atlama numarasıyla raporlanıyor.

**Ek değişiklik — Cascade doğrulaması başarısız olursa:** Blok atılıp yeniden toplanıyor; bu bir güvenlik olayı
değil. Üç ardışık başarısızlıkta oturum EC_FAIL ile iptal ediliyor. Önceden ilk başarısızlıkta iptal ediliyordu ve
31 atlamada bu ~%10 oturum kaybına yol açıyordu.

**Ölçülen etki (varsayılan demo, 1842 km / 31 atlama):**

| Profil | v3 | v4 |
|---|---|---|
| SNSPD | teslim | 40/40 teslim |
| InGaAs | 12 denemede 5 KEY_BUDGET | 12/12 teslim |

Darbe ihtiyacı arttı: SNSPD'de ~0,2–0,4 M/link, InGaAs'ta ~1,5–3,1 M/link (bütçe 4,19 M). Bu, 30 atlamanın da
kanıtlanmasının dürüst bedeli.

**Diğer:** Uçtan uca artan kanıtlı anahtar (`spareKeyBits`) zincirde de röle ile taşınıyor.
`PHOTONNET_VERSION` / `PHOTONNET_CORE_VERSION` tek kaynak oldu; sayfa başlığı derleme sırasında eşitleniyor.

## v3 (2026-10) — dedektör profili tek `config.json`'dan, dinamik seçim

Gerekçe: v2 sonrası kalan tutarsızlık — çekirdek SNSPD (50 Hz, verim örtük 1), katmanlar InGaAs (Y0 = 10⁻⁵,
verim %10) varsayıyordu ve bu sayılar koda dağılmıştı. Tasarım: `bb84/docs/DETECTOR_PROFILE_DESIGN.md`.
Kabul testi: `bb84/detector_profile_config_test.js`.

**Çekirdek hash'i artık yapılandırmadan bağımsızdır:** `config.json` değişince `photonnet_core.js` değişmez;
profil değerleri çalışma anında okunur (Node: `config.json`, tarayıcı: derlemede gömülen
`window.__PHOTONNET_CONFIG__`).

Değişenler (çekirdek):

- **Kaldırıldı:** `DETECTOR_DARK_RATE_HZ`, `SOURCE_GATE_WIDTH_S` sabitleri. Değerleri `config.json` →
  `detector.profiles.snspd`'ye taşındı (50 Hz, 12,5 ns — v2 ile aynı).
- **Yeni:** `validateDetectorConfig`, `configureDetectorProfiles`, `listDetectorProfiles`, `activeDetectorProfile`,
  `setActiveDetectorProfile`, `onDetectorProfileChange`, `detectorProfileSource`, `DETECTOR_TECHNOLOGIES`.
  Bozuk/eksik yapılandırma, bilinmeyen anahtar ya da bilinmeyen profil kimliği → TypeError/RangeError
  (sessiz varsayılan yok). Türetme `expm1`/`log1p` ile (küçük değerlerde hassas).
- **`DetectorNoiseModel.phantomClickProbability(isNight, profileId?)`**: etkin profilin karanlık sayımı ve penceresi.
- **`NoiseGateMiddleware(profile?)`**: karanlık sayım ve pencere profilden; yeni `resetForProfile(p)` (profil
  değişince kalibrasyon/kapı sıfırlanır) ve `_p()` (yapılandırma hatalıysa her hesap aynı hatayı fırlatır;
  yapıcı çökmez ki arayüz hatayı gösterebilsin).
- **`QuantumKeyDistribution.deriveSiftedKey`**: `detectorCtx` verildiğinde profilin **verimi** uygulanır
  (v2'de örtük olarak 1'di) ve `detectorCtx.detectorProfile` ile çağrı başına profil seçilebilir.
  `detectorCtx` yoksa ideal dedektör — v2 ile aynı.

**Davranış değişikliği (bilinçli):** varsayılan profil SNSPD, verim %80. Dedektör modellenen yollarda
(SecureMessageSession, arayüz) v2'ye göre ~%20 daha az algılama olur.

Çekirdek dışı:

- `config.json` (yeni), `bb84/detector_profile.js` (Node köprüsü), `hal/detector_profile.py`
  (aynı kurallar, Python).
- `linkEta`, `AdaptiveShieldingMitigation`, `mesh_isolation`, `shield_sensor_hal`,
  `multinode_shielding_testbed`: verim/Y0 varsayılanları etkin profilden okunur.
- `hal/types.py` `AcquisitionConfig.dark_count_rate_hz` ve `SimulatedHardware` (verim) profilden.
- `build_photonnet_html.js`: `config.json`'u çekirdeğin doğrulayıcısıyla denetleyip HTML'e gömer;
  `--check` config değişikliğini de yakalar.
- Arayüz: metrik çubuğunda DEDEKTÖR seçicisi; `?detector=<kimlik>`; geçersiz yapılandırmada iletim reddedilir.

## v2 (2026-10) — "Çekirdeği aç" kararıyla yapılan kritik/yüksek hata düzeltmeleri

Değiştirme gerekçesi: EIC Pathfinder hazırlık testinde bulunan Hata 1–5. Bu hataların ikisi (QBER modeli,
%11 üstünde anahtar kullanımı) çekirdeğin içindeydi; çekirdeğe dokunmadan yalnızca belgelenebiliyordu.
Proje sahibi çekirdeğin yeni sürüme geçmesini onayladı. Tüm sabitlenmiş testler v2 hash'ine güncellendi
ve yeniden koşturuldu (`bb84/core_v2_fixes_test.js` bu sürümün kabul testidir).

### Hata 1 (Kritik) — varsayılan demo iletimi başarısızdı (BER %85–100)

Kök nedenler:

1. Mesaj bitleri foton kanalından gönderiliyordu; kayıp/saçılma mesajın kendisini bozuyordu.
2. Anahtar mesaj bitlerinden türetiliyordu (Alice'in ham bitleri gerçek rastgele değildi).
3. OTP anahtarı kısa kaldığında `mulberry32` ile "uzatılıyordu" (`deriveOtpKeyBits`) — OTP değil.
4. Gündüz gökyüzü arka planı (5·10⁶ Hz) fiber hatlarına da uygulanıyordu: 50 km'de QBER ≈ %20, 85 km'de ≈ %39.

Değişenler:

- **Yeni `class SecureMessageSession`** — mesajı kanıtlanmış anahtarla gönderen oturum:
  QRNG entropisinden Alice ham bitleri → 16 384 darbelik turlar (link başına darbe bütçesi 4 194 304) →
  rastgele %20 test alt kümesiyle parametre tahmini (en az 64 bit, test bitleri atılır) →
  `QBER_test ≥ %11` ise iptal → Cascade uzlaştırma → gerçek sızıntıyla sonlu-anahtar uzunluğu ℓ
  (iki parametreli Serfling, ε_PE = ε_PA = 10⁻¹⁰, ε_cor = 10⁻¹⁵, f_EC = 1,16) →
  ℓ ≥ mesaj biti olana kadar toplama → Toeplitz gizlilik yükseltme → OTP → Bob çözer.
  İptal kodları: `QBER_LIMIT`, `HOP_QBER` (güvenilir düğüm zincirinde en kötü atlama), `EC_FAIL`, `KEY_BUDGET`.
  `entropyBits` verilmezse `TypeError` (sahte rastgelelikle sessizce devam etmez).
  Mesaj klasik kanaldan gider; foton kanalı yalnız görselleştirmedir.
- **`PhotonNet()` → `transmit()`** (UI, çekirdeğe dahil değil): QKD+OTP bloğu `SecureMessageSession`
  döngüsüyle değiştirildi; 150 km üstü rotalar güvenilir düğüm zinciri (atlama = ⌈km/60⌉); entropi
  `crypto.getRandomValues`; anahtar havuzu yalnız teslim başarılıysa ayrı, bağımsız bir turla beslenir.
  Sonuç kartında "QBER (test)", "KANITLI ANAHTAR ℓ", "DARBE / LİNK", "FOTON KANALI KAYIP".
- **`NoiseGateMiddleware.rawPhantomProbability(isNight, freeSpace = true)`** ve
  **`effectivePhantomProbability(isNight, freeSpace = true)`**: `freeSpace === false` iken gökyüzü arka
  planı 0 (fiber karanlıktır). Varsayılan `true` — eski serbest uzay çağrıları aynı kalır.

### Hata 2 (Kritik) — fizik dışı doğrusal QBER ve %11 üstünde anahtar kullanımı

- **`propPhoton(…, channelOpts)`**: yeni isteğe bağlı 8. parametre. `channelOpts.fixedPhaseProb` sonlu
  ise faz hatası olasılığı odur; yoksa eski `0,012 + km/4000` (foton görselleştirmesi değişmez).
- **`const QKD_MISALIGNMENT_E_D = 0.015`**: anahtar kanalında sabit hizalama hatası (aktif polarizasyon
  takipli sistem varsayımı — ölçülmedi).
- **`QuantumKeyDistribution.deriveSiftedKey`**: `propPhoton`'u `{ fixedPhaseProb: QKD_MISALIGNMENT_E_D }`
  ile çağırır ve `detectorCtx.freeSpace`'i gürültü kapısına iletir. Sonuç: QBER mesafeyle düz kalır;
  artışı yalnız karanlık sayım getirir.

  Ölçüm (gündüz, fiber, 10 tohum × 40 000 darbe): 10 km %1,49 (125 524 elenmiş bit) · 50 km %1,50 (18 862) ·
  85 km %1,36 (3 606) · 110 km %2,06 (1 067) · 130 km %2,09 (383). Bu örneklemde hiç karanlık click çıkmadı;
  110–130 km'deki artış küçük örneklem içinde (±%0,4–0,7). 50 Hz SNSPD karanlık sayımı ve 12,5 ns kapıyla
  QBER'in %11'i geçtiği nokta tek hatta ~270 km'dir (analitik tahmin, ölçülmedi). Pratikte sınırı ondan çok
  önce darbe bütçesi ve tespit oranı koyar: 400 km tek hat `KEY_BUDGET` ile iptal olur.

  Bilinen fark: adaptif katmanın decoy modeli (`adaptive_shielding_mitigation.js`, InGaAs sınıfı Y0 = 10⁻⁵,
  %10 verim) anahtarı ~112 km'de sıfırlar; çekirdek SNSPD sınıfı (50 Hz) dedektör varsayar. İkisi farklı
  dedektör varsayımlarıdır, çelişki değildir; ama aynı ağ için tek bir dedektör profili seçilmesi gerekir.
- %11 kuralı artık `SecureMessageSession` içinde zorunlu: aşılırsa mesaj gönderilmez, anahtar kullanılmaz.

### Hata 3 (Yüksek) — geçersiz girdide sessiz NaN/Infinity

Yeni yardımcılar `MAX_LINK_KM = 1e6`, `MAX_REPEATERS = 100000`, `MAX_RECONCILE_BITS = 2²⁴`,
`_requireFiniteNumber(fn, name, v, min, max)`, `_requireBits(fn, bits)`. Geçersiz girdi artık
`TypeError`/`RangeError` fırlatır (kontrollü hata):

| Fonksiyon | Kural |
|---|---|
| `fiberT` | km sonlu, ≥ 0 |
| `satQ` | el sonlu; [5°, 90°] aralığına kırpılır |
| `poissonSample` | λ sonlu |
| `bb84Reconcile` | bitCount negatif olmayan tam sayı, ≤ 2²⁴ |
| `computeRepeaterGain`, `estimateLinkSurvival` | km ∈ [0, 10⁶], reps ∈ [0, 10⁵] |
| `propPhoton` | km ∈ [0, 10⁶], reps ∈ [0, 10⁵] (1e308 tekrarlayıcı döngüyü kilitliyordu) |
| `hEnc`, `hDec` | her eleman 0 ya da 1 |
| `eavesdropProbability` | `fiberT` üzerinden doğrulanır |

`chaos_fuzz_test.js`: v1'de 44 bulgu → v2'de 0 (zaman aşımı dahil).

### Hata 4 (Yüksek) — anahtar havuzu blok kapanışı ana iş parçacığını kilitliyordu

- **`KeyPoolBuffer`**: `static LDPC_SYNC_MAX_BITS = 8192`, `static ldpcOffload = null`.
  `_finalizeBlock` LDPC karşılaştırmasını yalnız `pe.n ≤ 8192` ise eşzamanlı çalıştırır. Daha büyük
  bloklarda kayıt `{status: "pending"}` (offload kancası tanımlıysa, söz tamamlanınca doldurulur) ya da
  `{status: "skipped", reason}` olur; eşzamanlı çalışma `{status: "done", …}` kaydeder.
  Kayıt yeri: `reconciliationComparison.ldpc`. UI ipucu `status === "done"` kontrol eder.
  Kanca, `bb84/ldpc_async_offload.js` içindeki `runLdpcOnWorker` ile doğrudan takılabilir
  (`KeyPoolBuffer.ldpcOffload = runLdpcOnWorker`); worker sonucunun `bpIterations` alanı da okunur.
  Ölçüm (n = 150 000, `ldpc_async_offload_test.js`): v1-eşdeğeri senkron dönüş ~9,7 s → kancasız ~0,23 s
  (`skipped`) ve kancalı ~0,21 s (`pending` → `done`, sonuç senkron referansla alan alan aynı).

### Hata 5 (Yüksek) — çevrimdışı sürüm güncel değildi

- **`bb84/tools/build_photonnet_html.js`** (çekirdek dışı): `PhotonNet.html` ve `PhotonNet_offline.html`
  aynı içerikle birlikte yazılır; `--check` iki dosyadan biri eskiyse çıkış kodu 1 verir.

### Çekirdek dışı ama ilgili

- `bb84/tools/extract_core.js` `EXPORT_MANIFEST`: `SecureMessageSession`, `QKD_MISALIGNMENT_E_D`,
  `MAX_LINK_KM`, `MAX_REPEATERS`, `MAX_RECONCILE_BITS` eklendi.
- `bb84/skr_distance_sweep_test.js`: `knownInconsistency` → `resolvedInconsistency` (v1 değerleri tarihsel).
