# Uyarlamalı Kalkan Mitigasyonu ("Anında Kesinti Yerine Akıllı Daraltma") — Tasarım Belgesi

Uygulama: `bb84/adaptive_shielding_mitigation.js` · Öz-testler: `bb84/adaptive_shielding_mitigation_test.js` (17/17) · Rapor: `bb84/reports/adaptive_shielding_mitigation.json`

## §0 — İstek ve dürüstlük notu

İstek: kalkan kalitesi eşiğin altına düştüğünde bağlantıyı doğrudan koparmak yerine QKD parametrelerini (decoy oranları, hata düzeltme yoğunluğu) anlık optimize eden bir ara katman; kısa RF dalgalanmalarında tam mTLS kopmasından önce veri akışını güvenli seviyede sınırlayarak sürekliliği korumak.

Bu isteğin içinde iki farklı fiziksel etki birbirine karışmış durumda ve tasarım bu ikisini ayırmadan doğru yapılamıyor:

**İçeri giriş (ingress):** Dış RF alanı kafesten sızıp dedektör elektroniğinde sahte tıklama üretir. Bu etki karanlık verim Y0'da ve QBER'de **görünür**. Decoy yoğunluklarını, sinyal/decoy/vakum oranlarını ve LDPC kod oranını yeniden seçmek bunu gerçekten telafi edebilir. "Dinamik optimizasyon" yalnızca bu etkiye karşı işe yarar.

**Dışa sızıntı (egress):** Cihazın kendi bit-korelasyonlu EM emisyonu kafesten dışarı sızar. Faraday kafesinin asıl var olma nedeni budur ve bu etki QBER'de **hiç görünmez**: Eve emisyonu pasif olarak dinler, kuantum kanalına dokunmaz. Hiçbir decoy oranı ya da hata düzeltme yoğunluğu bu sızıntıyı azaltmaz. Tek geçerli önlem, sızıntı penceresinde üretilen anahtarı **kullanmamaktır**.

Buna göre tasarım şu üç ilkeye dayanır:

1. Parametre optimizasyonu yalnız görünür (ingress) etkiyi telafi eder ve yalnız dışa sızıntının tehdit modeline göre tespit edilemez olduğu bantta (ADAPT) çalışır.
2. Daraltma güvenlik değil süreklilik sağlar. Teslim edilen her bit, kalkan sağlamken üretilmiş temiz havuzdan gelir. Daraltma bu sonlu havuzun kısa bir parazit boyunca tükenmemesi içindir.
3. 30 dB acil-durum tabanının sürdürülmüş ihlalinde sert fail-closed kesinti **değişmeden** kalır.

`photonnet_core.js` (SHA-256 `8f879fde…dc7b05`) ve yeniden kullanılan yedi modül değiştirilmedi; test bunu sekiz dosyanın SHA-256'sı ile doğrular.

## §1 — Katmandaki yeri

```
SE ölçümü (sürekli izleme — VARSAYIM, §7)
   │
   ▼
adaptive_shielding_mitigation.js  ◄── YENİ
   ├─ SeFailsafeDebounce (mtls_failsafe_debounce.js, aynen)   → yalnız 30 dB tabanı
   ├─ seRequiredForThreatDb  (faraday_cage_shielding FSPL'inin tersi)
   ├─ ingressEffectiveY0     (rf_noise_bridge.rfInducedDarkProb + shielded_detector_physics.combinedDarkProb)
   └─ finiteKeyRate / optimizeDecoyParameters (decoy_state_protocol + decoy_state_finite_key)
   │
   ▼
karar: { level, mtlsAllowed, newKeyDisposition, deliveryCapBps, activeParams, pendingParams }
```

Katman `production_gate.js` kriter 9'a **bağlanmadı**; bağlanması, mevcut `mtlsHandshakePrecondition` politikasının değişmesi anlamına geldiği için (§3) ayrı bir karar gerektirir. KME sunucusuna bağlantı yalnız çok-düğümlü test ağı üzerinden ve isteğe bağlı bayraklarla (`--shield-gate`, `--keystore-inbox`) yapılır; bkz. `docs/MULTINODE_SHIELDING_TESTBED.md`. Bayraklar verilmezse KME'nin davranışı değişmez.

## §2 — Dört seviye

| Seviye | Koşul | mTLS | Yeni anahtar | Teslimat |
|---|---|---|---|---|
| NORMAL | SE ≥ max(hedef, SE_gerekli), R > 0 | açık | serbest | talep kadar |
| ADAPT | SE_gerekli ≤ SE < hedef, R > 0 | açık | serbest | talep kadar |
| HOLD | SE < SE_gerekli **veya** taban altı düşüş debounce içinde **veya** optimum R ≤ 0 | açık | **karantina** | temiz havuzdan, havuz/τ ile sınırlı |
| BLOCK | 30 dB tabanı sürdürülmüş ihlal (debounce BLOCKED/RECOVERING) | **kapalı** | karantina | 0 |

**SE_gerekli** tehdit modelinden türetilir. `emissionDetectabilityCheck`'in kullandığı bağıntı, alınan = kaynak − SE − FSPL ve tespit ⟺ alınan > gürültü tabanı şeklindedir. Bunun tersi SE_gerekli = kaynak − FSPL − gürültü tabanı verir, FSPL = 20·log10(4π·d·f/c). Test (A), 3 kafes × 4 tehdit senaryosunun 12'sinde de "tespit ⟺ SE < SE_gerekli" eşdeğerliğini doğrular (FSPL artığı ≤ 0,048 dB, yalnız yuvarlama).

**Taban.** Mevcut `SeFailsafeDebounce` sınıfı değiştirilmeden kullanılır. Ona hedefi tabana eşit kurulmuş bir değerlendirme verilir (`ok = SE ≥ 30`), böylece yalnız tabanı yönetir. 630 ms debounce, 6300 ms kurtarma histerezisi, 5 dB kurtarma marjı ve soğuk başlangıçta gecikmesiz BLOCK aynen geçerlidir.

**Dışa-sızıntı mandalı (`ShieldLevelTracker`).** Eşik = SE_gerekli + u'dur; u, SE ölçüm belirsizliğidir (varsayılan ±1 dB, belgelenmiş cihaz doğruluğu). Ölçülen SE eşiğin altına indiği anda HOLD başlar (gecikme yok, çünkü sızıntı anahtarı anında tehlikeye atar). Bant olmadan, gerçek SE SE_gerekli'nin hemen altındayken ölçüm hâlâ üstte görünebilir. Çok-düğümlü test ağının Monte Carlo deneyi bunu ölçtü: 1000 ani-sığ düşüşte bant 0 iken olayların %2'sinde sızıntılı blok serbest kaldı, ±1 dB bantla hiçbirinde kalmadı. Çıkış kuralı epizodun süresine bağlıdır. Geçici epizotta (ilk ve son kötü okuma arası ≤ 630 ms; ör. tek EFT artefaktı veya sensör kopması) eşiğin üstünde 630 ms kesintisiz okuma yeter. Uzun epizotta eşik + 5 dB'nin 6300 ms boyunca kesintisiz sağlanması gerekir; bunlar debounce ile aynı Schmitt + zaman histerezisi sabitleridir (testler G, P). Güvenlik bu sürelere dayanmaz, köşeli-parantez lekelemesine dayanır (§5). Bu ayrım test ağında bulunan bir kusuru düzeltir: tüm epizotlarda 5 dB marj istendiğinde, gerçek SE eşik ile eşik + 5 arasındayken tek bir artefakt düğümü kalıcı olarak HOLD'a kilitliyordu. Aynı sınıf düğüm düzeyinde de (mTLS, relay uygunluğu) kullanılır.

## §3 — Politika değişikliği (açıkça)

`network_shielding_bridge.mtlsHandshakePrecondition`, SE < hedef (ör. 60 dB) olduğunda bağlantıyı reddeder. Bu katman, o tasarım hedefinin yerine tehdit modelinden türetilmiş SE_gerekli değerini koyar. Test (E) bunu gösterir: SE = 45 dB'de eski önkoşul `allowed=false` döner, bu katman ADAPT ile mTLS'i açık tutar ve R = 5,1·10⁻⁴/darbe üretir.

Bu gevşetme yalnızca tehdit modeli girdileri (kaynak seviyesi, gözlemci mesafesi, gürültü tabanı, frekans) güvenilirse geçerlidir. Bu yüzden bu girdilerin hiçbiri için varsayılan değer yoktur. Eksik bir girdi kurucuda hataya yol açar (test B). Aynı kural içeri-giriş varsayımı, `deliveryPathIsolated` ve η için de geçerlidir.

## §4 — Dinamik optimizasyon (ADAPT)

**Etkin Y0.** İçeri giriş, dışa sızıntıdan ayrı modellenir: marj = ortam alanı − SE − dedektör duyarlılık eşiği (dB). Bu marj, `rf_noise_bridge.rfInducedDarkProb` (ref·10^(marj/10)) ile ek karanlık verime çevrilir ve `combinedDarkProb` ile temel Y0'a eklenir. Bu, `rf_noise_bridge.js`'in kısayolunu düzeltir: o modül RF gürültüsünü dışa-sızıntı marjından türetiyordu, bu da iki fiziksel olarak ayrı etkiyi birbirine bağlıyordu. dB→verim eşlemesi ise **aynı ve hâlâ kalibre edilmemiş** bir varsayımdır. Gerçek sistemde Y0, vakum-decoy sayımlarından doğrudan ölçülür. `measuredY0` verildiğinde model yerine o kullanılır (test K).

**Optimizasyon.** Sonlu-anahtar hızı, beklenen sayımlarla `decoy_state_finite_key.estimateDecoyFiniteKey` üzerinden hesaplanır (Chernoff sınırları, ε_PE = 10⁻¹⁰). Kod oranı, LDPC merdiveninden [9/10 … 1/4] çözülebilir en yüksek oran olarak seçilir. Çözülebilirlik koşulu (1−r) ≥ 1,16·H(E)'dir ve fEC = (1−r)/H(E) olarak `secureKeyRateLowerBound`'a verilir. Izgara μ ∈ [0,1; 0,9], ν ∈ [0,02; 0,4], ps ∈ [0,5; 0,95] aralıklarını ve kalan payın decoy/vakum bölüşümü {0,3; 0,5; 0,7; 0,85} değerlerini tarar.

Ölçülen kazanç (N = 10¹⁰, η = 0,01; sabit / yalnız-kod-oranı / tam uyarlama):

| Y0 | sabit (devreye alma) | yalnız kod oranı | tam uyarlama | tam uyarlama parametreleri |
|---|---|---|---|---|
| 1·10⁻⁵ | 6,63·10⁻⁴ | 6,63·10⁻⁴ | 6,63·10⁻⁴ | μ .55 ν .06 s/d/v .95/.035/.015 r .80 |
| 1·10⁻⁴ | 0 (kod çözülemez) | 4,46·10⁻⁴ | 4,74·10⁻⁴ | μ .45 ν .10 r .75 |
| 2·10⁻⁴ | 0 | 1,54·10⁻⁴ | 3,26·10⁻⁴ | μ .70 ν .08 .90/.07/.03 r .75 |
| 3·10⁻⁴ | 0 | 9,45·10⁻⁵ | 2,06·10⁻⁴ | μ .45 ν .08 .85/.075/.075 r .667 |
| 4·10⁻⁴ | 0 | 0 | 8,10·10⁻⁵ | μ .60 ν .08 .75/.125/.125 r .667 |
| ≥5·10⁻⁴ | 0 | 0 | 0 → HOLD | — |

Tablonun gösterdiği ilk şey, devreye alma parametreleriyle sabit çalışan bir sistemin kod oranını uyarlamadığı sürece Y0 = 10⁻⁴'te bile kod çözemediğidir. İkincisi, kazancın büyük kısmını kod oranı uyarlamasının tek başına sağladığı, decoy oranlarının ise yüksek gürültüde ek olarak ~%110'luk bir kazanç getirdiğidir. Blok boyutu da sonucu etkiler: N = 10⁸'de decoy+vakum payı %50'ye çıkar (s/d/v .5/.35/.15). Bu bir ızgara sınır artefaktı değildir; ps ızgarası 0,2'ye genişletildiğinde optimum değişmez (test D).

**Kararlılık.** Optimizasyon iki önlemle salınımdan korunur. Birincisi tepe-tutmadır ("hızlı saldırı, yavaş bırakma"): optimizasyon, son 6300 ms'deki en kötü Y0 için yapılır, böylece seçilen kod oranı yakın geçmişteki her gürültü seviyesinde çözülebilir kalır. İkincisi oran histerezisidir: yeni optimuma ancak mevcut setten en az %5 iyiyse (ya da mevcut set R = 0 veriyorsa) geçilir. Ayrıca Y0, 0,5 dB'lik kovalara nicemlenir ve kovanın üst kenarında optimize edilir. Üçüncü önlem, test ağında ölçülen Y0 gürültüsünün ortaya çıkardığı bir salınımı giderir: kova sınırında gezinen ölçüm, iki parametre seti arasında ~30 s'de bir gidip gelmeye yol açıyordu. Bu yüzden geçişler asimetriktir. Düşürme yalnız zorunlu olduğunda yapılır (mevcut set R = 0 veriyorsa). Yükseltmenin adayı ise 1 dB daha gürültülü bir kanalda da kod çözebilmelidir. 8 linkte geçiş sayısı bu kuraldan önce yalnız ilk 10 dakikada 162 iken, kuraldan sonra 60 dakikanın tamamında 20'dir. Tepe-tutma penceresi yalnız kalkan OK iken beslenir. Aksi halde 200 ms'lik bir düşüşün o anki Y0'ı 6,3 s boyunca "anahtar hızı 0" HOLD'una yol açıyordu. Karar hızları kova başına önbelleklenir, bu sayede 60 dakikalık 8 linkli ağ simülasyonu ~13 s sürer. Test (I), SE 41↔42 dB arasında her 100 ms'de bir gidip gelirken korumalı denetleyicinin 1 geçiş yaptığını, korumasız kontrol deneyinin ise 201 okumada 201 geçiş yaptığını gösterir. Korumasız durumda her kova kendi optimumunu dayatıyor ve o optimumun kod oranı komşu kovada çözülemiyor.

**Blok sınırı.** Decoy sonlu-anahtar tahmini, bir blok içinde sabit μ ve ν varsayar. Bu yüzden yeni parametreler `pendingParams` olarak bekler ve yalnız bir sonraki blok sınırında `activeParams` olur. Bir okumadan çıkan öneri, o okumadan önce başlamış bir bloğa geriye dönük uygulanmaz.

## §5 — Geçici parazit toleransı (HOLD)

**Blok karantinası (köşeli-parantez kuralı).** Ardışık iki SE okumasının arasındaki aralıkta, iki uçtan biri bile serbest bırakılabilir değilse (NORMAL veya ADAPT değilse), o aralığa değen her blok lekelenir. Lekeli bloğun bitleri `quarantinedBits` sayacına yazılır ve havuza **asla** dönmez. Kapanan bloğun hızı, blok içinde görülen en kötü Y0 ile hesaplanır (muhafazakâr). İhlalin iki okuma arasında başlamış olabileceği varsayılır, bu yüzden ihlalden önceki aralık da lekelenir.

**Üstel daraltma.** HOLD'da teslimat hızı min(talep, havuz/τ) ile sınırlanır. Bu da havuz(t) = havuz₀·e^(−t/τ) verir, yani havuz hiçbir zaman sıfıra inmez. τ varsayılan olarak 630 + 6300 = 6930 ms'dir: taban altına inen ve debounce'un tolere ettiği en uzun geçici düşüş artı dışa-sızıntı kurtarma histerezisi. Bu süre sonunda havuzun e⁻¹ ≈ %37'si kalır. Test (H)'de havuz/P₀ = 0,3679 çıkar ve hiç aç kalınmaz. Naif teslimat (talep hızında) ise havuzu 1000 ms'de bitirir ve kalan 5930 ms boyunca aç kalır.

**Teslimat yolu.** KME'nin bellek ve veri yolu sızan kafesin içindeyse, HOLD sırasında temiz havuzdan yapılan teslimat da sızabilir. Bu nedenle `deliveryPathIsolated` açıkça verilmek zorundadır. `false` değeri HOLD'da teslimatı 0'a indirir (test H).

**Örnek senaryo (test F).** SE 62 dB'de çalışan sistemde 5000. ms'de 200 ms boyunca SE 25 dB'e düşüyor. Sonuç: hiç BLOCK oluşmuyor ve mTLS hiç kopmuyor. HOLD 5000→5800 ms sürüyor; bu geçici bir epizot olduğu için 630 ms kurtarma yetiyor. HOLD'a değen iki blok ([4000,5000) ve [5000,6000)) lekeleniyor. Karantinadaki bit 0, çünkü o blokların en kötü Y0'ı düşüş anındaki içeri-giriş gürültüsü ve kod zaten çözülemezdi. Aç kalınan süre de 0. Korunum testi P₀ + serbest − teslim = havuz eşitliğini sağlıyor. Aynı senaryo iki kez koşulduğunda sonuç birebir aynı (test M).

**Mevcut debounce ile karşılaştırma (bulgu).** Mevcut `SeFailsafeDebounce` aynı 200 ms'lik düşüşte mTLS'i doğru şekilde açık tutar. Ancak yalnız el sıkışmayı yönetir ve anahtar serbest bırakma kararı içermez. Yani bugünkü sistemde 30 dB tabanının 630 ms'ye kadar süren ihlalleri sırasında üretilen anahtar ayrıca karantinaya alınmıyordu. Bu katman bu boşluğu kapatıyor.

## §6 — Test özeti

Çok-düğümlü test ağı sonrası eklenenler: (N) çekme API'si (`grantable`/`grant`), (O) ölçüm-belirsizliği bandı, (P) geçici/uzun epizot kurtarması. İsteğe bağlı `poolCapacityBits` KME depolama sınırını modeller (taşan bitler `overflowBits`).

(A) SE_gerekli ↔ emissionDetectabilityCheck 12/12 · (B) sessiz varsayılan yok · (C) tam ≥ kod ≥ sabit, 4 noktada sabit=0 iken R>0, ν iç nokta · (D) blok boyutu etkisi ve sınır artefaktı kontrolü · (E) politika farkı · (F) 200 ms düşüş · (G) marjlı dışa-sızıntı kurtarması · (H) daraltma, naif karşılaştırma ve izole olmayan yol · (I) salınım yok, kontrol deneyiyle · (J) R=0 → HOLD, BLOCK değil · (K) ölçülmüş Y0 önceliği · (L) sürdürülmüş ihlal → BLOCK, 6300 ms kurtarma, soğuk başlangıç · (M) belirlenimcilik · bütünlük (8 dosya SHA-256). Komşu testler (`mtls_failsafe_debounce`, `faraday_cage_shielding`, `rf_noise_bridge`, `network_shielding_bridge`, `shielded_detector_physics`, `chaos_decoy_state_finite_key`) yeniden koşuldu ve geçti.

## §7 — Bu katmanın YAPMADIKLARI

Katman dışa sızıntıyı parametrelerle azaltmaz; bu fiziksel olarak mümkün değildir (§0). İçeri-giriş modeli kalibre edilmemiştir: ortam alanı, duyarlılık eşiği ve dB→verim eşlemesi varsayımdır ve gerçek bir analog ön uçla ölçülmeden üretim kararında kullanılmamalıdır. Testlerdeki değerler (ortam 90 dBµV/m, duyarlılık 40 dBµV/m, ref = 10⁻⁵) yalnız senaryo içindir. Sürekli SE izlemesi (ör. kafes içi referans işaretçi + dış prob) varsayılır, ancak projede böyle bir donanım yoktur. Optimizasyon beklenen sayımlarla yapılır ve yalnız parametre seçer; teslim edilen anahtarın güvenliği her bloğun gerçek sayımlarla yapılan sonlu-anahtar analizinden gelmelidir. Izgara kabadır ve bir optimizasyon ~1 s sürer; önbellek (kova başına) bunu bir kez öder. Gerçek zamanlı bir sistemde bu hesap önceden tablolanmalıdır. Katman KME sunucusuna, `production_gate.js`'e ve CI'a bağlı değildir. Tepe-tutma, gürültü gerçekten azaldığında daha iyi parametrelere geçişi 6300 ms geciktirir; bu bilinçli bir bedeldir.
