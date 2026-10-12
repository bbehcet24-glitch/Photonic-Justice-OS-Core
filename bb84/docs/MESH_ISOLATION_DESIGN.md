# Ağ Düzeyinde Mesh İzolasyonu — Tasarım Belgesi

Kod: `bb84/mesh_isolation.js` · Ağ uzantıları: `multinode_shielding_network.js` (`addLink`, `setLinkEnabled`, `nodePenaltyKm` / `quarantine` / `probation` ipuçları, uç-yalnız gruplu yönlendirme) · Karar katmanı uzantıları: `adaptive_shielding_mitigation.js` (`suspend`/`resume`, `setPartition`, `revokePool`)

Öz-testler (üç ayrı parça):

- `mesh_topology_transit_test.js` — 7/7
- `mesh_quarantine_test.js` — 9/9
- `mesh_optical_bypass_test.js` — 8/8

Raporlar `bb84/reports/mesh_*.json` altında. Sistem resmi: `docs/photonnet_system_overview.svg` (ve `.png`).

## §0 — İstek ve kapsam

İki istek vardı:

1. Bir düğümün Faraday marjı düştüğünde, düğümü tamamen kapatmadan kuantum trafiğini güvenli komşular üzerinden otomatik olarak bypass etmek.
2. Şüpheli RF gürültüsü üreten bir düğümü, ana ağı tehlikeye atmadan izole bir karantina bölgesine almak.

`photonnet_core.js` değiştirilmedi; SHA-256 değeri (`8f879fde…dc7b05`) her test koşusunda doğrulanıyor. Optik anahtar, RF probu ve kilit donanımı projede yok; hepsi simüle.

## §1 — Üç mekanizma

| Mekanizma | Tetik | Ağ etkisi |
|---|---|---|
| **Kademeli transit daraltma** | SE ile dışa-sızıntı eşiği (38,0 + 1 dB) arasındaki marj m < 10 dB | Düğüme dokunan her linke `1500·(1 − m/10)²` km ceza eklenir; m ≤ 0 veya ölçüm yoksa 1500 km |
| **Karantina** | Herhangi bir güven alanından güçlü kanıt | Düğüm relay, uç ve mTLS dışında kalır; dokunan linklerin havuzu iptal edilir; linkler `quarantine` bölmesinde çalışır |
| **Optik bypass** | Karantina girişi, yararlı ve fizibıl bir komşu çifti varsa | X'teki optik anahtar A–X–B fiberlerini pasif olarak birleştirir; sanal A–B linki 20 s sonra etkin olur; X fotonları ölçmez, anahtarı görmez |

**Kademeli daraltma neden yalnız transiti kaydırır?** Düğümün kendi uç talepleri, alternatif yollardan hangisi seçilirse seçilsin düğüme dokunan tam bir linkten geçer. Bu yüzden her alternatif aynı cezayı alır ve uç talepleri etkilenmez. Transit talepler ise düğümü atlayan bir yol bulabilir. Ceza bir tercih ağırlığıdır, dışlama değildir: alternatif yoksa (kesim düğümü) trafik kesilmez (T5).

## §2 — Karantina: kanıt füzyonu ve güven alanları

Dört güven alanı var:

| Alan | Kaynak | Tetik |
|---|---|---|
| `self` | Düğümün kendi alıcı linklerinde ölçtüğü Y0 | Çevre modeline göre oran ≥ 3, ardışık 20 örnek (≈ 1 s) |
| `neighbor` | Düğümün verici olduğu linklerde komşu alıcının ölçtüğü Y0 | Aynı eşik |
| `independent` | Operatöre ait RF probu | ≥ 6 dB açıklanamayan alan, tek örnek |
| `lock` | Kabin kilidi HAL'i INCIDENT (TAMPER/OVERRIDE) | Tek olay |

"Oran", ölçülen Y0'ın, düğümün ortam alanı sensörü ve ölçülen SE ile `ingressEffectiveY0` modelinden beklenen Y0'a bölümüdür. Yani karantina "Y0 yüksek" demez; "Y0 çevreyle açıklanamıyor" der. Q5 testi farkı gösteriyor: aynı Y0 = 3,3e-5 değeri, KDK'nın SE'si 45 dB'ye düştüğünde model tarafından bekleniyor (oran ~1,1). Bu durumda karantina yok, kademeli daraltma devrede.

**Serbest bırakma asimetriktir.** Kendi-raporu temiz olsa bile tek başına yetmez, çünkü ele geçirilmiş bir düğüm yalan söyleyebilir. En az bir bağımsız alan (komşu ya da prob) 30 s boyunca temiz kalmalıdır. Sonra düğüm PROBATION'a geçer: yalnız uç trafiği alır, transit yasaktır. 30 s daha temiz kalırsa CLEAR olur. Gözetimdeki bir nüks düğümü anında karantinaya geri alır. Bağımsız kaynağı olmayan bir düğüm ancak operatör onayıyla serbest bırakılır.

**Havuz ve bölme.**

- Karantina girişinde dokunan linklerin mevcut temiz havuzu iptal edilir (`revokePool`), çünkü düğüm sızdırmış olabilir. Q3'te bu değer 22,55 Mbit oldu.
- Linkler `quarantine` bölmesinde çalışmaya devam eder. Böylece telemetri ve kanıt akmaya devam eder, ama üretilen anahtar ana havuza girmez ve verilebilir bit sayısı 0 olur.
- Bölme `main`'e döndüğünde biriken bölme anahtarı imha edilir. Q3'te imha edilen miktar 146,5 Mbit.

## §3 — Testlerin bulduğu iki hata

**1. Kanıt atfı (parça 2, Q3).** a→b linkindeki Y0'ı b'nin dedektörü ölçer. Açıklanamayan bir artışın kaynağı verici a (fibere ışık enjeksiyonu) da olabilir, alıcı b (dedektöre RF girişi) de. İlk sürüm her artışı vericiye "komşu kanıtı" olarak yazıyordu. Sonuç: KDK'nın alıcısındaki gürültü, KDK'ya ışık gönderen masum BKR, MSL ve ASY'yi de karantinaya soktu ve KDK'ya dokunmayan talepler %0'a düştü.

Düzeltme `attributeEvidence()` içinde, en az sayıda düğümle açıklama ilkesine dayanıyor:

1. b'nin ≥ 2 alıcı linki varsa ve hepsi etkilenmişse neden **alıcı**dır.
2. b'nin başka bir alıcı linki temizse neden **verici**dir.
3. a'nın başka bir verici linki de etkilenmişse neden **verici**dir.
4. Aksi hâlde neden **belirsiz**dir. Kapalı başarısızlık gereği kanıt iki uca da yazılır.

Düzeltmeden sonra:

- Q3: yalnız KDK karantinaya alınıyor; diğer talepler %99,95 karşılanıyor.
- Q4: KDK→ATS'ye enjeksiyon yapan KDK yakalanıyor, ölçümü yapan ATS karantinaya alınmıyor.
- Q6: tek alıcı linkli MSL'de kaynak ayırt edilemiyor ve iki uç da karantinaya alınıyor. Bu davranış dürüstçe raporlanıyor.

Varsayım: RF girişi bir kabindeki tüm alıcıları birlikte etkiler; seçici enjeksiyon ise tek fiberde olabilir.

**2. Yarar şartı (parça 3, B2).** Planlayıcı, güvenilir ara düğüm tasarrufu 0 olan bir sanal linki (BKR–ASY) yalnızca hız eşitlik bozucusuyla seçiyordu. Böyle bir seçim fiberleri boşuna askıya alır ve kanıt kaybettirir. Artık yalnız tasarrufu > 0 olan kümeler seçiliyor.

## §4 — Sonuçlar

| Test | Sonuç |
|---|---|
| T1–T2 topoloji | Hat A–B–C–D → kesim düğümleri {B, C}; halka → yok; yıldız → merkez; test ağı → yok. Test ağında her transit talep bypass edilebilir; hattaki A↔C "bypass edilemez" olarak raporlanıyor |
| T3 ceza eğrisi | 8 dB → 60, 6 → 240, 4 → 540, 2 → 960, 0,5 → 1354, ≤ 0/NaN → 1500 km; tekdüze ve sürekli |
| T4 kademeli daraltma | Marj 9,5 dB → ceza 3,7 km, transit KDK'da kalıyor (kısa yol farkı 31 km). Marj 6 dB → ceza 240 km, BKR↔ATS BKR→AVR→MSL→ASY→ATS yoluna geçiyor. KDK uç talepleri her durumda %100 |
| T5 / T6 | Kesim düğümünde ceza trafiği kesmiyor. Daraltma kapalıyken aynı marjda transit KDK'da kalıyor; yani kaymanın kaynağı ceza |
| Q1–Q2 birim | 19 örnek yetmiyor, 20. örnek tetikliyor; kesintili seri sayılmıyor; yalnız kendi-raporu temiz düğüm 120 s sonra hâlâ karantinada; nüks anında geri alıyor |
| Q3 ağda karantina | Tetik @1950 ms. Karantina boyunca KDK'dan geçen bit 0; ana havuz ve verilebilir 0. PROBATION @35 s, CLEAR @65 s; transit KDK'ya geri dönüyor |
| B1 planlayıcı | KDK için 4 aday; seçilen BKR–ATS (53 km, ~138 kbps); güvenilir ara düğüm sayısı 3 → 0 |
| B3 fizibilite | 300 km sanal link eşik altında; bypass önerilmiyor ve nedeni raporlanıyor |
| B4 kesim düğümü | Bypass yokken A↔B %0. Bypass ile 20 s anahtarlama, ilk blok (1 s) sonrası %100; X hiçbir yolda değil |
| B5 zaman çizelgesi | Kilit @1 s → fiberler hemen askıya alınıyor → @21 s sanal link etkin, BKR→ATS doğrudan, %100 → prob temiz → PROBATION @60 s, sanal link aynı adımda askıda → @80 s fiberler geri → CLEAR @90 s |

## §5 — Sınırlar

- **Algılama gecikmesi.** 20 örneklik kanıt birikimi (≈ 0,95 s) sürerken şüpheli düğümden trafik geçer; Q3'te bu 152 kbit oldu. Prob ve kilit tek örnekte tetikler.
- **Bypass anahtarlaması sırasında transit.** Anahtarlama süren 20 s boyunca transit uzun yoldan gider. Kesim düğümünde ise bu 20 s tam kesintidir.
- **Komşu kanıtı kaybı (B6).** Bypass, KDK'nın tek verici fiberini aldığı için komşu kanıtı kayboluyor. Bağımsız prob yoksa otomatik serbest bırakma yapılamıyor; operatör onayı gerekiyor.
- **Ayırt edilemeyen kaynak.** Tek alıcı linkli düğümde kaynak ayırt edilemiyor ve iki uç da karantinaya giriyor. Bağımsız RF probu bu belirsizliği çözebilir, ama şu an atıf kuralına bağlı değil.
- **Neden ayrımı yok.** Karantina bir güven kararıdır: Y0 artışının nedenini (saldırı mı, donanım mı) ayırt etmez.
- **Varsayımlar.** 1,5 dB anahtar kaybı ve 20 s yeniden yapılandırma süresi literatürden alınmış varsayımlar. Oran 3, 20 örnek, 6 dB, 30 s ve 1500 km değerleri politika parametreleri; ölçümden türetilmedi.
- **Bağlanmayanlar.** `production_gate.js` ve CI'a hâlâ bağlı değil.
