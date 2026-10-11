# Kestirimci Donanım Yaşlanması ve Erken Bakım Sinyali — Tasarım Belgesi

Kod:

- `bb84/environmental_aging_model.js` (çevresel yaşlanma modeli)
- `bb84/predictive_maintenance.js` (kestirimci monitör ve otonom bakım planlayıcı)
- `bb84/predictive_maintenance_test.js` (13/13 öz-test, ~19 s)

Rapor: `bb84/reports/predictive_maintenance.json`

## §0 — İstek ve dürüstlük notu

İstek iki parçadan oluşuyordu:

1. `hardware_aging_model.js` yalnız zamana bağlı çalışıyor. Sıcaklık, nem ve mekanik gerilme sensörleriyle beslenip yaşlanma eğrisi gerçeğe yaklaştırılsın.
2. Kalkan etkinliği kritik sınıra dayanmadan çok önce otonom sistem yöneticisine erken uyarı üretilsin.

Uygulamada iki şeyi birbirinden ayırmak gerekiyor.

**Biçimler yerleşik, katsayılar varsayım.** Kullanılan model biçimleri güvenilirlik mühendisliğinin standart bağıntılarıdır: Peck (sıcaklık + nem), Arrhenius, Coffin–Manson (termal döngü), Basquin (titreşim) ve Miner toplamı (kapı olayları). Katsayılar ise EMI contaları için kalibre edilmemiştir. Peck'in n ≈ 2,7 ve Ea ≈ 0,79 eV değerleri, epoksi kaplı entegre devrelerde nem kaynaklı arızadan türetilmiştir. Kaynağın kendisi de bunun genel bir model olmadığını, yalnız bir başlangıç noktası olduğunu ve katsayıların her sistem için ayrıca belirlenmesi gerektiğini söylüyor ([Accendo Reliability — Temperature Humidity Accelerated Life Testing](https://accendoreliability.com/temperature-humidity-accelerated-life-testing/)). Conta yaşlandırmasıyla SE ölçümünü birleştiren yayınlar var, örneğin IMAPS 2026'da McBain ve diğerlerinin çalışması ([kayıt](https://www.citedrive.com/en/discovery/a-practical-shielding-effectiveness-evaluation-of-ece-gaskets-incorporating-accelerated-aging/)). Ancak erişebildiğim özetlerde sayısal bozulma verisi yoktu. Kanal hızları (dB/yıl, dB/döngü, dB/olay) bu yüzden temsilîdir. Tasarım bunu iki yolla telafi eder: ölçeği çevrimiçi öğrenir ve üslerin yanlış olması durumunu ayrıca test eder (P10).

**Bir mekanizma sınıfı tahmin edilemez.** Gevşeyen vida, tam kapanmayan kapı veya çarpma gibi ani arızalar trendden öngörülemez. Bunlar ancak algılanır (P9).

**Mevcut modülde bir dokümantasyon hatası bulundu.** `hardware_aging_model.js`'in açıklaması "dB'de giderek küçülen adımlar / kötüleşmiş kalkan hızla çöker" diyordu. Ancak leak·(1+p) çarpımsal büyümesi dB'de sabit bir adımdır: 10·log10(1+p) ≈ 0,13 dB/döngü ve SE'den bağımsızdır. seed=7 ile ölçülen adımlar 0,125, 0,140 ve 0,131 dB/döngü. Açıklama düzeltildi; davranış değişmedi ve mevcut testler (firstFailCycle=335 dahil) aynen geçiyor.

`photonnet_core.js` değiştirilmedi. SHA-256 değeri `8f879fde…dc7b05`; yeniden kullanılan dört modülle birlikte test öncesi ve sonrası doğrulanıyor.

## §1 — Çevresel yaşlanma modeli

Kayıp dB cinsinden kanal kanal toplanır. Bu, sızıntı (güç) alanında çarpımsal büyümeye karşılık gelir; `hardware_aging_model.js` ile aynı temsil kullanılır ve 0 dB tavanı oradan alınır.

| Kanal | Biçim | Sensör | Varsayılan (TEMSİLÎ) |
|---|---|---|---|
| Sıcaklık + nem (korozyon, sıkışma kalıcılığı) | AF = (RH/50)^n · exp[(Ea/k)(1/298,15 − 1/T)] | T, RH | 2,0 dB/yıl @ 25 °C %50; n = 2,7; Ea = 0,79 eV |
| Termal döngü (derz yorulması) | yarım döngü başına 0,5·c·(ΔT/20 °C)^q | T dizisi | c = 0,004 dB/döngü, q = 2, < 2 °C yok sayılır |
| Titreşim (fretting) | (g/0,5 g)^b | ivmeölçer (g RMS) | 1,0 dB/yıl @ 0,5 g; b = 4 |
| Kapı/panel açma-kapama | olay başına sabit | kapı anahtarı | 0,03 dB/olay |

Termal döngü sayacı akış hâlinde çalışır ve dönüm noktalarını histerezisle bulur. Bu yöntem ASTM E1049 tam rainflow sayımı değildir, iç içe döngüleri ayırmaz; günlük döngünün baskın olduğu kafes ortamı için yeterli bir yaklaşımdır.

Her saatlik artışa çarpımsal log-normal gürültü (σ = 0,3) eklenir. `unitScale` ise birimin gizli parti/montaj farkını temsil eder ve kestirimci katman tarafından öğrenilir.

`SiteClimate` saha profillerini üretir:

- **HVAC'lı veri merkezi:** 22 °C / %45 sabit; isteğe bağlı HVAC arıza haftaları.
- **Sokak dolabı:** dış sıcaklık + cihaz ısısı + gündüz güneş kazancı. Isınma bağıl nemi düşürür (Magnus, ~%6/°C).
- **Ray yanı:** 06–24 arası 0,8 g, gece 0,1 g titreşim.

Aylık değerler İstanbul'a yaklaşık, temsilî değerlerdir; ölçülmüş iklim normali değildir. Profiller iki biçimde kullanılır. Deterministik klimatoloji tahmin içindir. Tohumlu gerçekleşme ise gerçeği temsil eder: günlük AR(1) hava anomalisi, Poisson kapı olayları ve HVAC arızaları içerir.

P3'te aynı kafes, ölçek 1 ile yıllık kayıplar:

- **Veri merkezi:** 1,64 dB.
- **HVAC arızalı veri merkezi:** 1,80 dB.
- **Sokak dolabı:** 3,97 dB. Termal döngü ve kapı katkısı belirgin. Isı-nem kanalı beklenenden düşük, çünkü ısınma bağıl nemi düşürüyor.
- **Ray yanı:** 6,56 dB. Baskın mekanizma titreşim.

Referans ortamda model tam olarak doğrusal zaman yaşlanmasına indirgenir: her yıl 2,000000 dB (P2).

## §2 — Kestirimci monitör

**Model.** Fizik bilgili bir durum-uzayı modeli ve doğrusal Kalman filtresi kullanılır:

- Durum x = [L, s]. L, güncel SE seviyesidir; s, birimin bilinmeyen ölçeğidir.
- L ← L − s·ΔD. ΔD, ölçülen çevre örneğinin ölçek 1'deki beklenen kaybıdır. Gerçek sıcaklık, nem, titreşim ve kapı olayları sensörden gelir.
- s ← s + ζ (yavaş sürüklenme).
- Gözlem z = L + v. Saatlik toplu SE ölçümü kullanılır.

F = [[1, −ΔD], [0, 1]] doğrusal olduğu için filtre EKF değil, tam Kalman filtresidir. Kıyas için kullanılan "zaman-tabanlı" kipte ΔD = Δt alınır. Bu kip, mevcut modelin karşılığıdır ve aynı filtreyle, saha klimatolojisinin ortalama hızından türetilen aynı önsel bilgiyle çalışır.

**Gürültü ve kapılama.** Yenilik 4σ'nın dışına düşen ölçümler artefakt sayılıp elenir (P6). Aynı yönde art arda 3 saat elenen ölçüm görülürse bu ani değişim (STEP_CHANGE) olarak işaretlenir ve filtre yeni seviyeye yeniden oturtulur.

**Kalan ömür (RUL).** Posteriordan (L, s) çiftleri örneklenir. Gelecek maruziyet, saha klimatolojisinden birikimli olarak öngörülür. Her örnek için L − s·[D(t+h) − D(t)] ≤ eşik koşulunu sağlayan ilk h bulunur; buradan p10, p50 ve p90 elde edilir. Uyarılar muhafazakâr olan p10'a göre verilir.

**Kritik eşik.** Kritik eşik, kalkan karar katmanının dışa-sızıntı eşiğidir: SE_gerekli + ölçüm belirsizliği = 39,0 dB (P11). Yani "kritik sınır", düğümün HOLD'a girip yeni anahtarı karantinaya aldığı noktadır. Uyarı bundan önce gelmelidir. Ölçüm cihazının sabit ±1 dB sapması seviyeye karışır. Bu yüzden tahmin edilen şey, ölçülen SE'nin operasyonel eşiği geçme zamanıdır, yani HOLD'un gerçekten tetikleneceği an.

| Düzey | Koşul | Otonom yöneticinin eylemi |
|---|---|---|
| ADVISORY | p10 ≤ 60 gün | planlı bakım: min(21 gün, p10 − 7 gün) içinde |
| WARNING | p10 ≤ 14 gün | iş emri, ≤ 3 gün |
| CRITICAL | p10 ≤ 2 gün veya tahmini SE ≤ eşik + 0,5 dB | acil, ≤ 24 saat |
| STEP_CHANGE | ani düşüş/yükseliş | yerinde muayene, ≤ 24 saat |

**Öğrenme kapısı.** İlk 14 gün boyunca ve ölçek belirsizliği %30'un üstündeyken RUL tabanlı uyarı üretilmez. Geniş önsel, açılışta sahte "yakında arıza" alarmına yol açardı.

**Modelden bağımsız son savunma.** Tahmini SE ≤ eşik + 0,5 dB olduğunda her zaman CRITICAL üretilir. Model henüz öğrenmemişken eşik + 2 dB'de en az WARNING verilir.

**Düşürme histerezisi.** Bir uyarı düzeyi ancak p10, düzey sınırının 1,5 katını 24 saat boyunca aşarsa düşürülür.

`MaintenanceScheduler`, gelen olayları iş emrine çevirir. Bakım tamamlandığında `notifyMaintenance` çağrılır: filtre yeni seviyeye oturur, öğrenilmiş ölçek korunur.

## §3 — Sonuçlar (40 kafeslik filo, 2 yıl saatlik)

**Filo bileşimi.**

- **Saha sınıfları:** 13 sokak dolabı, 12 veri merkezi, 7 HVAC arızalı veri merkezi, 8 ray yanı.
- **Gizli ölçek:** 0,5–4,5 aralığında.
- **Başlangıç SE:** 44–54 dB.
- **Ölçüm:** cihaz sapması ±1 dB, saatlik gürültü 0,15 dB, ~%0,25 artefakt saati.

Bakımsız iki yılda 19 birim eşiği geçiyor.

| Ölçüt | çevre-duyarlı | zaman-tabanlı |
|---|---|---|
| WARNING'i kaçırılan geçiş | 0 / 19 | 0 / 19 |
| ADVISORY < 30 gün önce | 0 | 0 |
| medyan öncülük ADVISORY / WARNING | 61 / 23 gün | 60 / 23 gün |
| RUL-tabanlı erken alarm (gerçek ömür > 4× düzey) | 0 | 0 |
| eşiği geçmeyen birimde WARNING | 0 | 0 |
| RUL medyan mutlak hata, 90 / 60 / 30 gün kala | 3,4 / 1,9 / 2,5 g | 7,9 / 6,2 / 3,2 g |
| p10–p90 kapsaması (nominal %80), 90 / 60 gün kala | 0,58 / 0,68 | 0,16 / 0,21 |

**Ölçek öğrenme (P4).** 120 günlük veriden ölçek medyan %2,2 göreli hatayla öğreniliyor (p90: %5,2). %90'lık güven aralığı 40 birimin 40'ında gerçek değeri kapsıyor.

**Çevre farkı asıl nerede önemli (P13).** Karışık filoda iki tahminci uyarı zamanlamasında benzer davranıyor. Bunun nedeni, veri merkezlerinin ve ray yanının hızının neredeyse durağan olması. Fark, kış ile yaz arasında hızı değişen sokak dolaplarında ortaya çıkıyor. Bunu ölçmek için 1 Ocak'ta izlenmeye başlanan ve bahar/yaz sıcağında (108–205. gün) eşiği geçen 20 dolap simüle edildi:

- **Zaman-tabanlı tahminci** kış hızını yaza taşıyor ve kalan ömrü olduğundan uzun sanıyor. 90 gün kala medyan hatası 23,6 gün, ortalama +22,6 gün iyimser. En kısa ADVISORY öncülüğü 26 gün.
- **Çevre-duyarlı tahminci** iklim öngörüsünü kullanıyor. Medyan hatası 9,3 gün, ortalama +7,1 gün iyimser. En kısa ADVISORY öncülüğü 43 gün.

Çevre-duyarlı tahmincinin kalan iyimserliği dürüstçe not edilmeli: hava anomalileri dışbükey Arrhenius bağıntısında ortalama hızı yükseltir, klimatoloji ise bunu bilmez.

**Kapalı döngü bakım (P8).** Otonom planlayıcıyla iki yıl boyunca filoda HOLD eşiğine inilen saat sayısı:

- **Kestirimci (iki kip de):** 0 saat.
- **Reaktif bakım** (eşik geçilince 72 saat içinde sevk): 1533 saat.

Bakım sayıları benzer: 22'ye karşı 21. Bedeli ise şu: kestirimci bakım contayı medyan 42 gün erken değiştiriyor; o kadar ömür boşa harcanıyor.

**Ani değişim (P9).** 400. günde SE −9 dB düştü. Bu öngörülemez bir olay ve önceden uyarı üretilmedi. STEP_CHANGE uyarısı 2 saat sonra geldi. Ani düşüş içermeyen filoda hiç yanlış STEP_CHANGE görülmedi.

**Yanlış model (P10).** Bu testte gerçek üsler n = 1,5, Ea = 0,5 eV, q = 1,5 ve b = 3; tahminci ise 2,7 / 0,79 / 2 / 4 varsayıyor. Sonuçlar:

- **Kaçırılan WARNING:** yine 0.
- **60 gün kala RUL hatası:** 1,9 günden 3,1 güne çıkıyor.
- **Aralık kapsaması:** 0,50'ye düşüyor.

Çevrimiçi ölçek öğrenimi hatanın bir kısmını telafi ediyor. Modelden bağımsız marj kuralı da son savunma görevi görüyor.

## §4 — Bilinen sınırlar

**Aralıklar fazla dar.** p10–p90 aralığı nominal %80 yerine %26–68 oranında gerçek değeri kapsıyor. Bunun nedeni, süreç gürültüsü modelinin hava anomalilerinin birikimli etkisini küçük görmesi. Uyarılar p10'a dayandığı için hiçbir geçiş kaçmadı, ama aralıkların kalibrasyonu iyileştirilmeli. Bir yol, artık analizinden süreç gürültüsünü öğrenmek olabilir.

**Marj kuralı bazen erken çalıyor.** SE ≤ eşik + 0,5 dB kuralı, yavaş bozulan 3 birimde gerçek ömür 63–74 gün iken CRITICAL üretti. Bu, model yanlış olsa bile eşiği uyarısız geçirmemenin bilinçli bedelidir ve testte ayrıca sayılıyor.

**Ölçüm ve gerçeklik sınırları:**

- SE'nin saatlik toplu ölçümü, sürekli bir SE izleme donanımının varlığını varsayar. Projede böyle bir donanım yoktur.
- Katsayılar, üretici hızlandırılmış yaşlandırma verisiyle (ısı-nem, tuz sisi + IEEE 299) yeniden belirlenmelidir. Saha olay oranları da varsayımdır.

**Ağ bağlantısı (sonradan yapıldı).** Uyarılar `maintenance_traffic_coordinator.js` ile çok-düğümlü ağa bağlandı: WARNING/CRITICAL/ani düşüş ve planlı her pencereden 24 saat önce DRAIN (transit trafik kayar), pencerede planlı kesinti. Bkz. `docs/MAINTENANCE_TRAFFIC_SHIFT_DESIGN.md`. `production_gate.js` ve CI'a hâlâ bağlı değil.
