# Çok-Düğümlü Test Ağı — 4 Seviyeli Kalkan Karar Matrisinin Ağ Entegrasyonu

Kod: `bb84/multinode_shielding_network.js` (ağ katmanı) · `bb84/multinode_shielding_testbed.js` (test ağı, 21/21 öz-test) · KME: `bb84/etsi014_kme_server.js --shield-gate --keystore-inbox` · Rapor: `bb84/reports/multinode_shielding_testbed.json`

Çalıştırma: `node bb84/multinode_shielding_testbed.js` (iki aşama, ~90 s). Yalnız simülasyon için `--stage=sim`, yalnız gerçek süreçler için `--stage=live` verilir. `--minutes=N` ile süre değiştirilebilir.

## §0 — Ne "gerçek", ne simüle (dürüstlük notu)

"Gerçek dünya koşulları" ifadesinin bu depoda karşılığı iki parçalıdır ve ikisi karıştırılmamalıdır.

**Gerçek olanlar (aşama 2):**

- İşletim sistemi süreçleri olarak 6 ayrı KME sunucusu.
- `pki_tools` ile üretilmiş gerçek bir openssl CA'sı ve kısa ömürlü sertifikalar.
- Gerçek mTLS el sıkışmaları ve oturum kesmeleri.
- Gerçek ETSI GS QKD 014 API çağrıları (`enc_keys` → `dec_keys`).
- Çalışırken dosya sistemi üzerinden yapılan anahtar enjeksiyonu.
- Kapı dosyalarının bayatlaması.

**Simüle olanlar:**

- Fiber, dedektör ve Faraday kafesinin kendisi.
- RF ortamı.
- SE ölçüm cihazı.

Bunlar için bu projede donanım yoktur. Saha olaylarının oranları (EFT, kapı açılması, sızıntı, yaşlanma) saha verisinden değil, makul varsayımlardan seçilmiştir. Tohumla tekrarlanabilirler. İçeri-giriş dB→verim eşlemesi `rf_noise_bridge.js`'in açıkça kalibre edilmemiş varsayımıdır. Bu yüzden sonuçlar mekanizmanın doğru çalıştığını ve politikalar arasındaki göreli farkları gösterir. Belirli bir sahada beklenecek mutlak sayıları göstermez.

`photonnet_core.js` değiştirilmedi. SHA-256 değeri `8f879fde…dc7b05` her koşuda öncesi ve sonrası doğrulanır.

## §1 — Mimari: karar matrisi ağın neresine oturuyor

Karar matrisi tek bir bağlantı yerine iki düzeyde uygulanır, çünkü çok-düğümlü bir güvenilir-düğüm ağında kalkan iki ayrı şeyi korur.

**Düğüm düzeyi.** Her düğümün kendi kafesi ve SE izleyicisi vardır. `ShieldLevelTracker`, aynı taban debounce'u ve dışa-sızıntı mandalını kullanarak düğüm durumunu çıkarır: OK, HOLD_FLOOR, HOLD_EGRESS veya BLOCK. Üç karar bu durumdan türetilir:

- **mTLS:** düğüm BLOCK değilse açıktır.
- **Güvenilir relay uygunluğu:** düğüm OK ise uygundur. OK değilse, BLOCK olmamak ve teslimat yolunun izole olması şartıyla yine uygundur.
- **SAE teslim uygunluğu:** relay ile aynı kural.

İzolasyon önemlidir. Trusted-node relay'de uçtan-uca anahtar ara düğümün KME belleğinden geçer. Bu yüzden sızan ve KME'si aynı kabinde olan bir düğüm (testte KDK sokak dolabı) relay olarak kullanılamaz.

**Link düzeyi.** Her QKD linki için bir `AdaptiveShieldingMitigation` çalışır. SE girdisi iki ucun ölçülen SE'sinin küçüğüdür, çünkü uçlardan birindeki sızıntı bile o linkin anahtarını tehlikeye atar. Y0 ise alıcıdaki vakum-decoy sayımlarından Poisson gürültüsüyle ve 1 s kayan pencereyle ölçülür. Modelden alınmaz. Link seviyesi şunları belirler: anahtar karantinası, parametre uyarlaması ve havuzdan verilebilecek bit (`grantable`).

**Yönlendirme ve tahsis.** `qkd_network_scale.js` değiştirilmeden kullanılır (Dijkstra + max-min adil tahsis). Link kapasitesi, o adımdaki havuz bütçesidir. HOLD linkleri +1000 km ceza ağırlığı alır, yani ancak temiz yol yoksa kullanılır. BLOCK linkleri ve uygun olmayan düğümlere değen linkler ağdan çıkarılır. Test ağı, tek-yollu tahsisin bir tuzağını buldu: HOLD'da üstel olarak daralan, neredeyse boş ama sıfır olmayan bir link en kısa yolda kalınca talep aç kalıyordu. Oysa paralel bir HOLD linkinde 63 Mbit duruyordu. Bu yüzden karşılanmayan talep kalanı, kullanılan kapasite düşülmüş artık ağda en fazla 3 tur yeniden yönlendirilir (çok-yollu aktarım).

**KME kapısı.** Her düğümün izleyicisi 50 ms'de bir kapı dosyası yazar: `{issuedAtMs, maxAgeMs, self:{mtlsAllowed, level}, peers:{düğüm:{deliveryAllowed}}}`. KME bu dosyayı her bağlantıda ve istekte yeniden okur ve fail-closed çalışır:

- Dosya yoksa, bozuksa veya bayatsa mTLS oturumu el sıkışmadan hemen sonra kesilir. Bayatlık sınırı min(maxAgeMs, sunucu tavanı 2000 ms) değeridir.
- `self.mtlsAllowed=false` olduğunda da oturum kesilir. Keep-alive ile açık kalan oturumlar da 200 ms içinde kesilir.
- Çağıran SAE'nin düğümüne teslim izinli değilse istek 503 alır. `enc_keys` isteğinde karşı tarafın düğümüne teslim izinli değilse yine 503 döner, böylece yarı-açık anahtar bırakılmaz.

Uçtan-uca anahtarlar KME'ye `--keystore-inbox` dizini üzerinden verilir: dosya atomik yazılır, merge ile yüklenir, sonra silinir. Bayraklar verilmezse KME'nin davranışı eskisiyle birebir aynıdır. Üretim derlemesi (`build_production_server.js`) temiz geçer ve kapı orada da çalışır: dosya yoksa oturum kesilir, taze dosyada 200 döner, 2,3 s bayat dosyada oturum yine kesilir.

**Mimari sınır.** Bu referans KME, ETSI 014'ün iki-KME senkronizasyonunu uygulamaz; tek KME bir rotanın iki ucuna da hizmet eder. Test ağında her talebin anahtarları master tarafı KME'ye enjekte edilir. Slave SAE de o KME'den `dec_keys` çeker. Karşı düğümün kalkan durumu, kapıdaki `peers` alanıyla uygulanır.

## §2 — Test ağı

| Düğüm | Rol | Ortam alanı | Teslim yolu | Olay (aşama 1) |
|---|---|---|---|---|
| AVR | Avrupa veri merkezi | 75 dBµV/m | izole | — |
| MSL | Maslak (çatı antenleri) | 92 → 112 (30.–38. dk) | izole | yakın verici (içeri giriş) |
| BKR | Bakırköy POP | 85 | izole | 6/sa gerçek kısa sızıntı (100–400 ms, 25 dB) |
| ASY | Asya veri merkezi | 78 | izole | conta yaşlanması 65 → 34,7 dB |
| KDK | Kadıköy sokak dolabı | 88 | **izole değil** | 2/sa bakım kapısı (log-normal ~60 s, 15 dB) |
| ATS | Ataşehir POP | 86 | izole | — |

**Linkler.** 8 fiber link (km): AVR–MSL 18, AVR–BKR 22, MSL–ASY 30, BKR–KDK 41, ASY–ATS 14, KDK–ATS 12, MSL–KDK 35, ASY–KDK 16.

**Kanal parametreleri.** η = 0,1 · 10^(−(0,2·km + 3)/10). Blok 10⁹ darbe ≈ 1 s. İlk havuz link başına 5 Mbit.

**Talepler.** AVR↔ASY 120 kbps, MSL↔KDK 60 kbps, BKR↔ATS 60 kbps, AVR↔KDK 40 kbps.

**Tehdit modeli.** 100 dBµV/m kaynak, 0,3 m gözlemci, 40 dBµV/m gürültü tabanı, 1 GHz. Buradan SE_gerekli = 38,0 dB çıkar. Ölçüm bandı ±1 dB eklenince eşik 39,0 dB olur.

**Her düğümde ayrıca:**

- ±1 dB sınırlı ölçüm gürültüsü.
- 12/sa EFT ölçüm artefaktı. Gerçek SE değişmez, yalnız okuma 5–25 dB'e düşer.
- 2·10⁻⁴ olasılıkla sensör kopması (okuma yok).

**Yer-gerçeği denetimi.** Test ağı gerçek SE'yi bilir, ağ katmanı bilmez. Her link için bir FIFO köken defteri tutulur. Serbest bırakılan her blok, kendi zaman aralığında iki uçtan birinin gerçek SE'si SE_gerekli'nin altına indiyse "sızıntılı" işaretlenir. Teslim edilen her bitin bu kökeni izlenir. Defter ile denetleyici havuzları arasındaki fark tüm koşularda 0,01 bitin altındadır (S6).

## §3 — Aşama 1 sonuçları (60 dk simüle, aynı izler)

| Ölçüt | uyarlamalı | legacy-strict | legacy-debounce |
|---|---|---|---|
| uçtan-uca teslim / talep | **%99,19** | %64,05 | %64,80 |
| AVR↔ASY erişilebilirliği | **%100** | %18,2 | %20,1 |
| mTLS kesintisi (olay / toplam süre) | **1 / 60,7 s** | 1054 / 3006 s | 2 / 2936 s |
| sızıntılı blok serbest bırakıldı | **0** | 1291 | 1291 |
| sızıntılı kökenli bit teslim edildi | **0** | 405 063 | 405 063 |
| izole olmayan sızan düğümden teslim | **0** (bu izde; sınır: habersiz olay başına ≤ 1 aralık) | 8 000 bit | 112 000 bit |
| karantina | 2687 blok (3,25 Gbit) | — | — |

**Bulgu 1: eski politikalar kanalı kapatıyor, kökeni izlemiyor (S3).** Durumsuz önkoşul ve debounce yalnız SAE↔KME bağlantısını yönetir. Sızıntı sırasında da QKD katmanı anahtar üretmeye devam eder ve bu anahtar havuza girer. Kanal yeniden açıldığında teslim edilir. Örnekte KDK kapısı açıkken KDK→ATS linki ATS'deki alıcıda gürültü görmez ve anahtar üretmeyi sürdürür. Kapı kapanınca bu anahtarlar dağıtılır. Uyarlamalı sistemde o pencereye değen her blok karantinadadır (S2).

**Bulgu 2: süreklilik (S4, S5, S7).** Hedef 60 dB'e bağlı eski önkoşul, yaşlanan ASY'yi yaklaşık 11. dakikadan itibaren keser. Ayrıca her EFT artefaktında ve sensör kopmasında bağlantı kopar (1054 kesinti). Uyarlamalı sistem mTLS'i yalnız gerçek, sürdürülmüş taban ihlalinde, yani bakım kapısında keser. KDK kapalıyken BKR↔ATS talebi BKR→AVR→MSL→ASY→ATS yoluyla %100 karşılanır.

**Bulgu 3: dinamik optimizasyonun görünür etkisi (S8).** MSL'deki yakın verici penceresinde (8 dk) içeri giriş Y0'ı büyütür. Sabit parametreli eski sistem AVR→MSL linkinde kodu çözemez ve 0 bit üretir. Uyarlamalı sistem aynı pencerede 576,8 Mbit serbest bırakır. 60 dakikada 8 linkte toplam 20 parametre geçişi oldu.

**Bulgu 4: ölçüm belirsizliği bandı gerekli (S9).** Bu 60 dakikalık izde bant 0 iken de ihlal görülmedi. Yavaş kaymada gürültünün kendisi mandalı erken tetikler. Asıl risk ani ve sığ düşüştür, ör. gevşeyen bir panel SE'yi SE_gerekli'nin 0–1 dB altına indirir. 1000 olayla yapılan Monte Carlo deneyinin sonucu: bant 0 iken 20 olayda (%2) sızıntılı blok serbest kaldı (11,1 Mbit), ±1 dB bantla hiçbir olayda kalmadı. Ölçüm gürültüsü sınırlı olduğu sürece bu sıfır bir garantidir, şans eseri değildir. Bandın bedeli: karantina 2,81'den 3,25 Gbit'e çıkar ve ASY'nin HOLD'u ~2 dakika erken başlar.

**Bulgu 5: daraltma kalıcı bozulmayı köprüleyemez (S11).** Sınırsız tamponla AVR↔ASY %100'dür. Bunun nedeni, 60 dakikada link havuzlarında 1,2–6,7 Gbit temiz anahtar birikmesidir. Tampon link başına 16 Mbit ile sınırlanınca ASY'nin 601 s'lik kalıcı dışa-sızıntı HOLD'unda erişilebilirlik %90,9'a düşer ve en uzun kesinti 327 s olur. Kaba hesap şöyledir: 2×16 Mbit / 120 kbps ≈ 267 s, bu da HOLD süresinden kısadır. Daraltma kısa parazitleri köprüler; kalıcı bozulma bakım gerektirir. Güvenlik iki durumda da değişmez.

**Not (EC).** Uyarlamalı koşuda 1 blokta seçilen kod oranı, gerçek en kötü Y0'da çözülemezdi. Bu, MSL vericisinin ani açılışında Y0 ölçümünün 1 s penceresinin gecikmesinden kaynaklanır. Gerçek sistemde EC doğrulama özeti bunu yakalar ve blok atılır; bu bir verim kaybıdır, güvenlik sorunu değildir. Simülasyon bu bitleri serbest saydığı için bir üst sınır olarak raporlanır.

## §4 — Aşama 2 sonuçları (gerçek süreçler, ~23 s)

**Kurulum.** 6 KME süreci (portlar 19600–19605) ayağa kalktı; her biri kendi kapı dosyası ve gelen kutusuyla çalıştı. Karar döngüsü gerçek saatle 50 ms'de bir koştu. ~2650 kapı dosyası yazıldı ve ~20 900 uçtan-uca anahtar enjekte edildi. SAE istemcileri, `etsi014_client_lib.httpsCall` ile 600 ms'de bir gerçek `enc_keys` → `dec_keys` akışı yaptı. Her düğüm ayrıca 250 ms'de bir kendi KME'sini yokladı.

Senaryo ve gözlenenler:

- **L2.** Olaylardan önce 4 talebin hepsinde akışlar başarılı ve master/slave anahtarları birebir aynı.
- **L3 — MSL'de 200 ms EFT artefaktı.** Karar matrisi HOLD_FLOOR → HOLD_EGRESS → OK yolunu izledi. MSL'nin teslim yolu izole olduğu için KME hiçbir yoklamada bağlantıyı kesmedi (91/91 başarılı).
- **L4, L5 — KDK'da bakım kapısı (6,0–10,0 s, SE 15 dB):**
  - İlk ~630 ms'de KDK HOLD'da ve izole değil, bu yüzden teslim kapandı (503).
  - Ardından KME mTLS oturumlarını gerçekten kesti: TLS kesintisi ~6,8 s ile ~16,2 s arasında sürdü. 16,2 s, 10,0 s + 6,3 s kurtarma süresidir.
  - KDK uçlu talepler bu süre boyunca master KME'nin kapısında 503 aldı. Sonra geri geldi (8/8).
- **L6 — BKR↔ATS.** KDK BLOCK'tayken ağ BKR→AVR→MSL→ASY→ATS yoluna geçti. BKR'nin kendi 250 ms'lik gerçek sızıntısında (12,0 s) bile 36/36 akış başarılı oldu.
- **L7 — AVR'nin SE izleyicisinin çökmesi (19 s, kapı dosyası tazelenmiyor).** KME ~1 s sonra fail-closed duruma geçti: tüm yoklamalarda TLS kesildi ve AVR-master akışlarının hepsi reddedildi.
- **L8 — Köken.** SAE'lerin gerçek API üzerinden aldığı 404 anahtarın tamamı, enjekte edilen anahtarla bayt-bayt aynı. Hiçbiri sızıntılı kökenli değil, hiçbiri iki kez verilmedi.
- **L9.** Canlı koşunun yer-gerçeği denetimi: sızıntılı serbest blok 0, sızıntılı köken 0. Teslimat-yolu maruziyeti ~8 kbit / 1 aralık (8160 bit; gerçek zamanlı aralık ~51 ms). Bu, habersiz kapının açıldığı 50 ms'lik aralığın, bir önceki okumayla yönlendirilmiş trafiğidir (bkz. §5-7). İlk sürüm burada "0" raporluyordu, çünkü ağ teslimi nedensel değildi.

## §5 — Test ağının karar katmanında bulduğu ve düzelttiği kusurlar

Bu kusurlar tek bağlantılı birim testlerde görünmüyordu; ancak gerçekçi çok-düğümlü trafikte ortaya çıktılar. Her biri bir öz-testle sabitlendi.

**1) Artefakt başına 6,3 s HOLD.** Tek-örneklik bir EFT artefaktı ya da sensör kopması, dışa-sızıntı mandalını 6300 ms kurtarmaya kilitliyordu. 10 dakikada 4,4·10⁸ bit karantinaya gidiyordu. Çözüm: geçici epizot (≤ 630 ms) için 630 ms kurtarma yeterli (test P).

**2) Tepe-tutma penceresinin kirlenmesi.** HOLD sırasındaki Y0 pencereye giriyor ve düşüşten sonra 6,3 s boyunca "anahtar hızı 0" HOLD'una yol açıyordu. Çözüm: pencere yalnız kalkan OK iken beslenir (test F).

**3) Kova sınırında salınım.** Ölçülen Y0'ın Poisson gürültüsü iki parametre seti arasında ~30 s'de bir geçişe yol açıyordu. Çözüm: asimetrik geçiş kuralı. Düşürme yalnız zorunluysa yapılır; yükseltmenin adayı 1 dB daha gürültülü kanalda da kod çözebilmelidir (test I).

**4) Marj tuzağı.** Tüm epizotlarda 5 dB kurtarma marjı istendiğinde, gerçek SE eşik ile eşik + 5 arasındayken tek bir artefakt düğümü kalıcı olarak HOLD'a kilitliyordu. ASY bu yüzden gerçek sızıntıdan 8 dakika önce kilitlendi. Çözüm: geçici epizotta marj 0 (test P).

**5) Tek-yollu tahsis tuzağı.** Neredeyse boş bir HOLD linki en kısa yolda kalınca talep aç kalıyordu. Çözüm: artık-kapasite turları (§1).

**6) Keep-alive açığı.** Yalnız yeni bağlantıları reddetmek yetmezdi; açık oturumlar BLOCK boyunca kullanılabilirdi. Çözüm: açık oturumlar izlenir ve kapı kapandığında 200 ms içinde kesilir.

**7) Nedensel olmayan teslim (sonradan, bakım-trafik kaydırma çalışmasında bulundu).**

- **Kusur:** Ağ katmanı (t₋₁, t] aralığını, aralığın SONUNDAKİ okumayla verilen kararla teslim ediyordu. Bu da habersiz bir kafes açılışının ilk aralığını "zaten bilerek" yönlendirmek anlamına geliyordu.
- **Çözüm:** Aralık, bir önceki adımda yapılan planla teslim edilir; ardından okumalar alınır ve yeni plan yapılır.
- **Sonuç:** Habersiz olayda izole olmayan düğümden bir aralık kadar maruziyet kaçınılmazdır (canlı koşuda ~8 kbit). Simüle sahada bu iz özelinde 0 çıktı, çünkü KDK kapı açılırken artefakt yüzünden zaten HOLD'daydı. Bu yüzden S2 ve L9 artık "habersiz olay başına en fazla bir aralık" sınırını doğruluyor.
- **Planlı bakım:** Bu maruziyet planlı bakımda 0'dır. Bkz. `docs/MAINTENANCE_TRAFFIC_SHIFT_DESIGN.md`.

## §6 — Kapsam dışı

Aşağıdakiler bu çalışmada yapılmadı:

- `production_gate.js` kriter 9 değiştirilmedi.
- CI'a eklenmedi. Test ağı ~90 s sürer, openssl ister ve 19600–19605 portlarını kullanır; CI'a eklenmesi ayrı bir karardır.
- İki-KME senkronizasyonu yok.
- KME'nin depolama sınırı yalnız simülasyonda modellendi (`poolCapacityBits`).
- Kapı dosyası güveni dosya sistemi izinlerine dayanır. Kapıyı yazabilen biri izin verebilir; bu, `--keystore` dosyasıyla aynı güven sınırıdır ve imzalı bir kapı ileriki bir iştir.
- Olay oranları sahadan ölçülmedi.
