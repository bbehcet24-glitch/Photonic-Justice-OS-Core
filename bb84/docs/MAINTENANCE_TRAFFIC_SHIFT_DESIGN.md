# Bakım Öncesi Trafik Kaydırma — Tasarım Belgesi

Kod: `bb84/maintenance_traffic_coordinator.js` · `bb84/multinode_shielding_network.js` (nedensel teslim + bakım ipuçları) · Öz-testler: `bb84/maintenance_traffic_shift_test.js` (9/9) · Rapor: `bb84/reports/maintenance_traffic_shift.json`

## §0 — Kabul edilen öneri ve kapsam

Kabul edilen öneri şuydu: WARNING alan düğümden trafik, bakımdan önce kaydırılsın. Bu çalışma kestirimci bakım uyarılarını (`predictive_maintenance.js`) çok-düğümlü ağa (`multinode_shielding_network.js`) ve dolaylı olarak KME kapısına bağlıyor. `production_gate.js` ve CI hâlâ bağlı değil; o adım ayrı bir karar. `photonnet_core.js` değiştirilmedi ve SHA-256'sı her koşuda doğrulanıyor.

## §1 — Düğüm durumları

Koordinatör olayları prognostik monitörden, iş emirlerini ise bakım planlayıcıdan alır. Her düğüm için aşağıdaki durumlardan birini tutar.

| Durum | Ne zaman | Ağ etkisi |
|---|---|---|
| NORMAL | — | yok |
| PLANNED | ADVISORY uyarısı | yok (bakım yalnızca planlanır) |
| DRAIN | WARNING, CRITICAL, ani SE düşüşü **veya** planlı pencereye 24 saat kalmışsa | düğüme dokunan linklere +2000 km ceza ağırlığı eklenir |
| MAINTENANCE | bakım penceresi başladığında | düğüm relay, uç ve mTLS dışında kalır (KME kapısında `level=MAINTENANCE`) |

Tasarımdaki seçimler şunlar:

- **DRAIN bir ceza, dışlama değil.** Transit trafik varsa alternatif yola geçer. Alternatif yol yoksa trafik kesilmez (M3). Düğümün kendi SAE'leri pencere başlayana kadar hizmet almaya devam eder ve önceden bir planlı kesinti bildirimi alır.
- **Ceza büyüklüğü bilinçli seçildi.** DRAIN cezası (2000 km), HOLD cezasından (1000 km) büyüktür, çünkü yakında kapanacak bir düğüm en son tercih olmalıdır.
- **Ön-boşaltma her planlı bakıma uygulanır.** Bu kural, uçtan uca zincir testinde (M6) bulunan bir boşluğu kapatır. ADVISORY ile erken planlanan bir bakım WARNING'den önce geldiğinde, düğüm hiç DRAIN'den geçmeden MAINTENANCE'a giriyordu ve transit trafik pencere anında kesiliyordu. Artık her pencereden 24 saat önce kendiliğinden DRAIN başlar.
- **Kapı yalnızca boşaltma teyidinden sonra açılır.** `doorMayOpen()` ancak iki koşul birlikte sağlandığında doğru döner: pencere başlamıştır ve ağın yürürlükteki planı düğümü artık kullanmamaktadır. Teknisyen kafes kapısını bu teyitten sonra açar.
- **MAINTENANCE kendiliğinden bitmez.** Pencere süresi aşılsa bile durum, `completeMaintenance` çağrılana kadar sürer (bakım uzayabilir).

## §2 — Bu iş sırasında bulunan ve düzeltilen nedensellik hatası

Önceki ağ katmanı, (t₋₁, t] aralığının teslimini aralığın **sonundaki** okumayla verilen kararla yapıyordu. Yani sızıntının başladığı örnekleme aralığındaki trafiği "zaten bilerek" yönlendiriyordu. Bu nedensel değildir ve güvenlik denetimini olduğundan iyi gösterir.

Düzeltilmiş adım sırası şöyle:

1. Geçen aralık, önceki adımda yapılan planla teslim edilir. Link bütçeleri henüz güncellenmemiş kararlardan gelir.
2. Ardından yeni okumalar alınır: düğümler, linkler ve bakım ipuçları.
3. Son olarak bir sonraki aralığın planı yapılır. Plan bit/ms oranı olarak saklanır. Bir linkin bütçesi plandan azsa, o linkten geçen tüm yollar orantılı olarak kısılır.

Düzeltmenin ortaya çıkardığı sonuç: **habersiz** bir kafes açılışında, izole olmayan düğümden tam bir örnekleme aralığı kadar teslimat-yolu maruziyeti kaçınılmazdır. Aşağıdaki testlerde bu değer ölçüldü:

- **M5:** 50 ms × KDK'dan geçen 160 kbps = 8000 bit; bir sonraki aralıkta 0.
- **Çok-düğümlü test ağı canlı koşusu (L9):** 8160 bit / 1 aralık (gerçek zamanlı aralık ~51 ms).

Simüle sahada (S2) bu iz özelinde maruziyet 0 çıktı, çünkü KDK kapı açıldığı anda bir artefakt yüzünden zaten HOLD'daydı. S2 ve L9 kontrolleri artık "sıfır" yerine "habersiz olay başına en fazla bir aralık" sınırını doğruluyor. Planlı bakımda bu maruziyet 0'dır (M4); düzeltmenin pratik değeri de burada.

## §3 — Sonuçlar

**M2 — DRAIN.** KDK WARNING aldığı anda BKR↔ATS transit trafiği BKR→KDK→ATS yolundan BKR→AVR→MSL→ASY→ATS yoluna geçti; bu sırada KDK hâlâ sağlıklıydı. KDK'nın kendi uç talepleri (MSL↔KDK, AVR↔KDK) pencereye kadar hizmet almaya devam etti.

**M4 — Önce kur, sonra kes** (60 s, 50 ms adım, gerçek ağ katmanı):

| | Habersiz kapı açılışı | Koordineli bakım |
|---|---|---|
| Kafes kapısı | 22 000 ms (habersiz) | pencere 20 000 ms → plan KDK'yı bıraktı → kapı 21 050 ms |
| KDK SAE↔KME hizmeti kapanışı | 22 650 ms (kapı açıldıktan sonra, debounce ile) | 20 000 ms (kapıdan **önce**, bildirimle) |
| Teslimat-yolu maruziyeti | 8000 bit (1 aralık) | **0** |
| Kapı açıkken KDK'dan geçen bit | — | 0 |
| BKR↔ATS transit teslimi | kesintisiz | %100 |

**M6 — Uçtan uca zincir** (sokak dolabı, saatlik, aylar boyunca). Çevresel prognostik ADVISORY verdi. Planlayıcı 335. güne bir iş emri açtı. Ön-boşaltma 334. günde başladı. Bakım 335. günde yapıldı ve düğüm NORMAL'e döndü. Bakım yapılmasaydı gerçek eşik geçişi 363,6. günde olacaktı. Bu birimde erken planlama sayesinde WARNING'e hiç gerek kalmadı.

**M7 — KME kapısı.** MAINTENANCE'taki düğümün kapı belgesi `self.mtlsAllowed=false`, `level=MAINTENANCE` ve `peers.KDK.deliveryAllowed=false` taşıyor. Mevcut `--shield-gate` mantığı bununla oturumları keser ve karşı KME'ler bu düğüme anahtar vermez. Bu davranış çok-düğümlü test ağının L4 ve L7 kontrollerinde gerçek süreçlerle doğrulandı.

## §4 — Sınırlar

- **Bildirimler yalnızca bir olay listesi.** Gerçek bir SAE yönetim kanalı bu projede yok; ETSI 014 böyle bir kanal tanımlamaz.
- **Kapı açma "izni" yalnızca bir fonksiyon.** Teknisyenin bu prosedüre uyması operasyonel bir varsayımdır. Fiziksel kilit veya kapı sensörüyle bağlantı yok.
- **Ön-boşaltma süresi ve ceza ağırlığı politika parametreleri.** 24 saat ve 2000 km değerleri ölçümden türetilmedi.
- **Koordinatör çok-düğümlü test ağının gerçek süreç aşamasına bağlanmadı.** Orada KDK kapısı bilinçli olarak habersiz açılıyor; bu, BLOCK ve TLS kesme yolunu test etmek için bırakıldı.
