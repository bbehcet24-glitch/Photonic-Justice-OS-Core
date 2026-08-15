# φ_high — üretim geri-basıncı üst su seviyesi

**Önerilen üretim ayarı: `φ_high = 0,80`**

Kodda: `bb84/qkd_backpressure.js` → `RECOMMENDED_PHI_HIGH`
Doğrulama: `bb84/phi_high_tuning_test.js` (7/7 öz-test)
Ham veri: `bb84/reports/phi_high_tuning.json`

---

## 1. φ_high ne yapar?

`ProductionThrottle`, depo doluluğu `φ = seviye / kapasite` değerini izler:

| bölge | davranış |
|---|---|
| `φ < φ_high` | **ÜRETİM** — blok, boş alanın izin verdiği en uzun hâline çıkar (hız maksimize edilir) |
| `φ ≥ φ_high` | **KISMA** — üretim durur, depo talep tarafından `φ_high`'a inene kadar beklenir |

Mod değişimi `±0,08` histerezis bandıyla geciktirilir. Histerezis kapatılınca
mod değişimi 9 → 17'ye çıkıyor (×1,9 chatter) — her mevduat eşiği yukarı,
her talep aşağı ittiği için.

φ_high **yalnızca** iki şeyi ayarlar: ne kadar fiziksel kaynak tasarruf
edildiği ve ani talep sıçramasında elde ne kadar yedek bulunduğu.

---

## 2. Sayı nereden geldi

### Önce reddedilen ölçüt

İlk yaklaşım şuydu: *"her çalışma noktasında sıçrama reddini ulaşılabilir
tabanının 1 puan içinde tutan en tasarruflu φ."*

**Ölçüm bunu çürüttü.** Talep/üretim oranı 0,3–0,7 ve depo kapasitesi
1–3 × S_min olacak şekilde 9 noktalık bir ızgarada koşturulduğunda diz
noktası **0,60 ile 0,95 arasında dolaştı** (aralık 0,35). Ölçüt ayrıca
bıçak sırtıydı: 0,8 puanlık bir fark uygunluğu ters çevirip seçimi
tasarrufun %0 olduğu bir φ'ye kaydırabiliyordu.

> **Nokta bazında diz noktası yoktur.** Tek bir sayı bu ölçütle
> savunulamaz. Bu kontrol testte bilerek bırakıldı — reddedilme
> gerekçesinin kanıtı olarak.

### Kabul edilen ölçüt: değişim oranının çöküşü

Izgara **ortalamasında** takas neredeyse doğrusaldır ama bir yerde kırılır.
Soru şu: φ'yi artırmak, birim tasarruf başına ne kadar sıçrama reddi
azalması satın alıyor?

| geçiş | kaybedilen tasarruf | kazanılan ret azalması | oran |
|---|---|---|---|
| 0,50 → 0,60 | 4,5 puan | 5,9 puan | **1,337** |
| 0,60 → 0,70 | 4,2 puan | 3,2 puan | **0,748** |
| 0,70 → 0,80 | 7,0 puan | 2,2 puan | **0,311** |
| 0,80 → 0,85 | 8,7 puan | 0,1 puan | **0,011** ← çöküş |
| 0,85 → 0,90 | 8,6 puan | 0,6 puan | 0,068 |
| 0,90 → 0,95 | 5,9 puan | 0,4 puan | 0,069 |

`φ = 0,80`, φ'yi artırmanın hâlâ anlamlı dayanıklılık satın aldığı **son**
noktadır. Ötesinde 8,7 puan tasarruf verilip yalnızca 0,1 puan ret
azalması alınıyor.

Eşik `EXCHANGE_COLLAPSE_RATIO = 0,1` olarak kodda açıkça tanımlıdır.

### Bu bir keşif değil, duruş

Dürüstçe: 0,80 "ölçümden çıkan tek doğru" değildir. *"Verimliliği,
dayanıklılık satın almayı bıraktığı ana kadar tercih et"* duruşunun
sayısal karşılığıdır. Farklı duruşlar farklı sayı verir; üçü de ölçüldü.

---

## 3. Profiller (9 noktalık ızgara ortalamaları)

| profil | φ_high | kaynak tasarrufu | sıçramada ret | en kötü ret |
|---|---|---|---|---|
| verimlilik-önce | 0,50 | **%43,0** | %30,3 | %43,0 |
| **dengeli (varsayılan)** | **0,80** | **%27,3** | **%19,0** | %36,4 |
| dayanıklılık-önce | 0,90 | %9,9 | **%18,4** | %37,7 |

Kodda `PHI_PROFILES` olarak dışa aktarılır.

Üç profilin de **düz talepte reddi %0** ve **taşması %0**'dır; fark yalnızca
ani sıçrama davranışında ve kaynak tüketiminde ortaya çıkar.

---

## 4. Sert kısıt: bant kuralı (öneriden ÖNCE gelir)

Üst bant en az bir bloğun ürettiği anahtarı almalıdır:

```
φ_high  ≤  1 − ℓ(T_b) / S  −  pay
```

Sağlanmazsa **her mevduat eşiği aşar** ve denetleyici hemen ardından kısar —
aşırı yükte bile. Ölçülen örnek: ℓ(blok) = 14.644 bit, üst bant yalnızca
2.606 bit → kısma yüzünden 21.616 çift boşa atlandı.

**Bu durumda φ_high'ı oynatmak çözmez.** `recommendPhiHigh()` öneriyi
reddeder ve gereken iki sayıyı döndürür:

```js
BP.recommendPhiHigh({ capacityBits: 10422, blockMs: 10000, ellModel })
// → { feasible: false,
//     reason: "bant kuralı sağlanamıyor: tek blok, üst banda hiçbir φ_high için sığmıyor",
//     requiredCapacityBits: 97624,      // ya depoyu bu boyuta çıkar
//     maxBlockMsForCapacity: 1652 }     // ya bloğu bu süreye indir
```

Kısıt bağlayıcı değilse öneri diz noktasına bağlanır:

```js
BP.recommendPhiHigh({ capacityBits: 200000, blockMs: 5000, ellModel })
// → { feasible: true, phiHigh: 0.8, boundBy: "önerilen diz noktası", bandCap: 0.9173 }
```

---

## 5. Geçerlilik zarfı

Ölçüm şu aralıkta yapıldı:

- talep / üretim oranı: **0,3 – 0,7**
- depo kapasitesi: **1 – 3 × S_min** (`requiredStoreBits`)
- blok: 5.000 ms · istek 128 bit · akış 40,8 s / 438.716 çift
- sıçrama senaryosu: oturumun %40–%70 aralığında talep ×3

Bu zarfın **dışında yeniden ölçün**. `bb84/phi_high_tuning_test.js` ızgarayı
olduğu gibi yeniden koşturur; sabitleri değiştirip kendi çalışma noktanızı
tarayabilirsiniz.

---

## 6. Konuşlandırma sırası

1. `requiredStoreBits(D, T_b, requestBits, 3)` ile depoyu boyutlandır.
2. `recommendPhiHigh({ capacityBits, blockMs, ellModel })` çağır.
3. `feasible: false` dönerse **önce** bloğu kısalt veya depoyu büyüt —
   φ_high'la uğraşma.
4. Talep sıçraması riskin ana kaynağıysa `dayanıklılık-önce` (0,90),
   kaynak maliyeti baskınsa `verimlilik-önce` (0,50) profiline geç.
5. Histerezisi **açık bırak** (varsayılan 0,08).

---

## 7. Değişmeyen sınır

Geri-basınç **israfı önler, kapasite yaratmaz.** Talep azami üretimi aşarsa
(ölçülen: üretimin %130'u) ret oranı %25,3'e çıkar ve hiçbir φ_high bunu
kurtarmaz. `R(T_b) > D` koşulu her zaman geçerlidir.
