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
