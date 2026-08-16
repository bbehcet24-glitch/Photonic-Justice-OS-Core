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

Mod değişimi `±h = ±0,08` histerezis bandıyla geciktirilir; yani gerçekte
**iki eşik** vardır (`φ_low = 0,72`, `φ_up = 0,88`). Bant kapatılınca mod
değişimi 6 noktalık ızgara ortalamasında 9,0 → 20,3'e çıkıyor (**×2,3
chatter**). Bandın kendisi de ölçülerek gerekçelendirildi — bkz. **§8**.

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
5. Histerezisi **açık bırak**. Bandı elle verme — `ProductionThrottle`
   φ_high'tan çözer (0,50 → 0,28 · 0,80 → 0,08 · 0,90 → 0,02).
   Ölçülmemiş bir φ_high kullanıyorsanız `recommendHysteresis()`
   `measured: false` döner; bandı taramadan üretime almayın — bkz. §8.

---

## 7. Değişmeyen sınır

Geri-basınç **israfı önler, kapasite yaratmaz.** Talep azami üretimi aşarsa
(ölçülen: üretimin %130'u) ret oranı %25,3'e çıkar ve hiçbir φ_high bunu
kurtarmaz. `R(T_b) > D` koşulu her zaman geçerlidir.

---

## 8. Histerezis bandı — `h = 0,08`

Kodda: `bb84/qkd_backpressure.js` → `HYSTERESIS_BAND`
Doğrulama: `bb84/hysteresis_band_test.js` (16/16) · Ham veri: `reports/hysteresis_band.json`

### İki eşik, tek bant

Arayüzde tek sayı (φ_high) var ama denetleyici **iki eşikle** çalışır:

```
φ_up  = φ_high + h = 0,88   → bu seviyenin ÜSTÜNDE üretim DURUR
φ_low = φ_high − h = 0,72   → bu seviyenin ALTINDA üretim GERİ BAŞLAR
```

Arada kalan bantta mevcut mod korunur. Kararsızlık (chatter) tam olarak
buradan çıkar: bant olmazsa her mevduat doluluğu eşiğin üstüne, her talep
altına iter.

### Ölçülen zorunluluk

6 çalışma noktasının ortalaması (talep/üretim 0,3–0,7 × depo 1–2 × S_min):

| h | φ_low / φ_up | mod değişimi | blok başına | tasarruf | ret |
|---|---|---|---|---|---|
| 0,00 | 0,80 / 0,80 | **20,3** | 1,26 | %25,1 | %0 |
| 0,02 | 0,78 / 0,82 | 17,0 | 1,08 | %25,5 | %0 |
| 0,04 | 0,76 / 0,84 | 14,3 | 0,90 | %26,0 | %0 |
| 0,06 | 0,74 / 0,86 | 10,3 | 0,63 | %25,2 | %0 |
| **0,08** | **0,72 / 0,88** | **9,0** | **0,58** | **%25,3** | %0 |
| 0,12 | 0,68 / 0,92 | 4,7 | 0,25 | %19,2 | %0 |
| 0,16 | 0,64 / 0,96 | 3,8 | 0,15 | %15,9 | %0 |
| 0,20 | 0,60 / 1,00 | 0,3 | 0,01 | **%9,7** | %0 |

Bantsız çalıştırmak anahtarlamayı **×2,3** artırıyor (tek noktadaki
"17 → 9" ölçümü ızgarada 20,3 → 9,0 olarak doğrulandı).

### Reddedilen ölçüt

İlk ölçüt *"anahtarlamayı tabana indiren en dar bant"* idi. **Dejenere
çıktı:** anahtarlama h ile monoton azalıyor (20,3 → 17,0 → 14,3 → 10,3 →
9,0 → 4,7 → 3,8 → 0,3), hiç dip yapmıyor; dolayısıyla ölçüt her zaman
taranan en geniş bandı seçiyor.

### Kabul edilen ölçüt

*"Tasarrufu düşürmeye başlamadan önceki **en geniş** bant."*
Tasarruf h ≤ 0,08'e kadar sabit (%25–26), h = 0,12'de %19,2'ye düşüyor.
Yani 0,08'e kadarki anahtarlama azalması **bedava**; ötesi değil.

> Not: "geniş bant depo salınımını açar" diye varsaymıştım; **veri
> çürüttü** (salınım %25,4 → %24,0, yani daralıyor). Bandın gerçek
> bedeli tasarrufta.

### Sert kısıt — gerekli ama **yeterli değil**

```
h  <  1 − φ_high        (φ_high = 0,80 için h < 0,20)
```

Aksi hâlde φ_up ≥ 1 olur ve **kısma hiç tetiklenmez** — depo doluluğu
%100'ü aşamayacağı için üretim hiç durmaz. Üç profilde de ölçüldü:

| profil | φ_high | h = 1−φ_high'ta tasarruf |
|---|---|---|
| verimlilik-önce | 0,50 | %41,1 → **%13,7** |
| dengeli | 0,80 | %25,1 → **%9,7** |
| dayanıklılık-önce | 0,90 | %14,1 → **%4,7** |

> **Bu doküman önce şöyle diyordu:** *"φ = 0,90 için h < 0,10."* Doğru ama
> **eksik.** h = 0,08 o kısıtı sağlıyor — yine de o profilde tasarrufu
> düşürüyor. Bağlayıcı olan sert kısıt değil, tasarruf ölçütüdür.

### Bant profile bağlıdır — ölçülen değerler

Aynı ölçüt ("tasarrufu düşürmeden alınabilen en geniş bant") üç profilde
de çalıştırıldı:

| profil | φ_high | sert kısıt | **ölçülen h** | φ_low / φ_up | mod değişimi | tasarruf |
|---|---|---|---|---|---|---|
| verimlilik-önce | 0,50 | h < 0,50 | **0,28** | 0,22 / 0,78 | 13,5 → 4,3 | %40,3 |
| **dengeli** | 0,80 | h < 0,20 | **0,08** | 0,72 / 0,88 | 20,3 → 9,0 | %25,3 |
| ara nokta | 0,85 | h < 0,15 | **0,04** | 0,81 / 0,89 | 22,0 → 13,2 | %20,7 |
| dayanıklılık-önce | 0,90 | h < 0,10 | **0,02** | 0,88 / 0,92 | 19,5 → 12,0 | %13,4 |

**Bant, φ_high yükseldikçe daralıyor**: üst bandın bıraktığı boşluk
küçüldüğü için geniş bant kısmayı devre dışı bırakmaya yaklaşır.
Tek bir h bütün profillere uymaz.

Kodda `HYSTERESIS_BANDS` olarak tutulur ve `ProductionThrottle`, bant
açıkça verilmediyse **φ_high'tan otomatik çözer** — φ = 0,90 seçen biri
sessizce 0,08 almaz:

```js
BP.recommendHysteresis(0.90)
// → { band: 0.02, hardCap: 0.1, measured: true, phiLow: 0.88, phiUp: 0.92 }

BP.recommendHysteresis(0.85)          // artık ölçüldü
// → { band: 0.04, hardCap: 0.15, measured: true, phiLow: 0.81, phiUp: 0.89 }

BP.recommendHysteresis(0.70)          // hâlâ ölçülmemiş
// → { band: 0.15, hardCap: 0.30, measured: false,
//     warning: "φ_high = 0.7 için bant ÖLÇÜLMEDİ … hysteresis_band_test.js ile taranmalıdır." }
```

### Ölçülmemiş φ için başlangıç tahmini

Dört ölçüm noktası bir örüntü gösteriyor (c = 1 − φ_high):

```
ĥ  =  min( c/2 ,  2c² )
```

| c | ĥ (sezgisel) | ölçülen |
|---|---|---|
| 0,50 | 0,25 | 0,28 |
| 0,20 | 0,08 | 0,08 |
| 0,15 | 0,045 | 0,04 |
| 0,10 | 0,02 | 0,02 |

**Bu bir formül değil, dört noktaya uyan bir sezgiseldir.** Testte
doğrulanıyor (ölçüm noktalarını ±0,04 içinde yeniden üretiyor) ve
`recommendHysteresis()` bu yoldan gelen değeri `measured: false` ile
işaretler. Ölçmeden üretime almayın.
