# Kaos Mühendisliği / Fuzz Testi ve Girdi Doğrulama Düzeltmesi — Rapor

**Tarih:** 2026-09-12
**Kapsam:** `bb84/photonnet_core.js` (çekirdek) — **hiçbir şekilde değiştirilmedi**, yalnızca test edildi ve önüne bir koruma katmanı eklendi.
**İlgili commit'ler:** `0d4721c` (fuzz testi) → `d18966a` (guard düzeltmesi) → `04d5ef5` (gerçek çağrı noktalarına bağlama)

---

## 1. Amaç

Sahadaki gerçeklik: gerçek donanım/harici veri kaynakları (müşterinin kendi fiber hat envanteri, bir sensörün telemetrisi) bazen eksik veri gönderir (`null`/`undefined`), bazen saçmalar (`NaN`, `Infinity`, sayaç taşması sonucu aşırı büyük integer'lar, negatif mesafe değerleri). Bu çalışma üç aşamada ilerledi:

1. **Tespit** — çekirdeğin dışa açık fonksiyonlarına kasıtlı olarak bozuk girdi beslenip, her birinin "zarif bozulma" mı yoksa sessiz veri bozulması/çökme mi gösterdiği ölçüldü.
2. **Düzeltme** — çekirdeğe dokunmadan, bulunan sorunları gideren bir girdi doğrulama (guard) katmanı yazıldı.
3. **Bağlama** — bu guard katmanı, gerçekten harici/güvenilmeyen veri alan kod yollarına takıldı.

---

## 2. Aşama 1 — Fuzz Testi Bulguları (`chaos_fuzz_test.js`, commit `0d4721c`)

**Yöntem:** çekirdeğin `EXPORT_MANIFEST`'inde listelenen 15 fonksiyonuna (fiziksel kanal, PRNG/seed, BB84 protokolü katmanlarından) `NaN`, `undefined`, `null`, `Infinity`, `-Infinity`, negatif sayı, aşırı büyük sayı (`1e308`), sayısal olmayan metin, boş obje/dizi ve bozuk bit değerleri beslendi. Her çağrı, olası bir sonsuz döngüyü ana test sürecini kilitlemeden tespit edebilmek için **izole bir alt-process'te, zaman aşımıyla** çalıştırıldı.

**Sonuç: 197 çağrı, 24.9 saniye**

| Sınıf | Adet | Anlamı |
|---|---|---|
| `HANDLED` | 133 | Sonlu/mantıklı bir değere geriledi — zarif bozulma ✓ |
| `KONTROLLÜ_HATA` | 16 | İstisna fırlattı, process çökmedi ✓ |
| `SESSİZ_NaN` | 40 | Hatasız döndü ama sonuç sessizce `NaN` içeriyordu ✗ |
| `SESSİZ_SONSUZ` | 4 | Hatasız döndü ama sonuç sessizce `Infinity` içeriyordu ✗ |
| `ZAMAN_AŞIMI` | 4 | Çağrı hiç dönmedi — gerçek sonsuz döngü ✗ (kritik) |

**48/197 çağrı "zarif bozulma" göstermedi.**

### 2.1 Kritik bulgu — DoS riski (sonsuz döngü)

`propPhoton(nm, km, reps, ...)` ve `bb84Reconcile(bitCount, rng)`, `reps`/`bitCount` parametresi `Infinity` veya aşırı büyük bir sayı (`1e308`) olduğunda **gerçekten sonsuz/aşırı-uzun döngüye giriyor**. Kök neden: her ikisi de `for (let i=0; i<N; i++)` deseninde döngü sınırını doğrulanmamış bir sayısal girdiye doğrudan bağlıyor. `propPhoton`'da ek olarak: `reps=Infinity` iken segment uzunluğu `sk = km/(reps+1)` sıfıra iner, bu da SCATTER/ABSORB/DECOHERE olaylarının hiçbirinin tetiklenmemesine (dolayısıyla döngüyü sonlandıran `alive=false` durumunun hiç oluşmamasına) yol açıyor.

**Gerçek risk:** bozuk bir tekrarlayıcı-sayısı veya bit-sayısı telemetrisi (örn. bir sayaç taşması) bu fonksiyonları çağıran süreci süresiz kilitleyebilir.

### 2.2 Orta bulgu — sessiz veri bozulması

`estimateLinkSurvival`, `computeRepeaterGain`, `satQ`, `fiberT`, `eavesdropProbability` fonksiyonları, `km`/`reps`/`el` parametresi `NaN` veya `Infinity` olduğunda **hiçbir hata vermeden** sessizce `NaN`/`Infinity` döndürüyor. Bu, özellikle güvenlik-kritik bir noktada tehlikeli: `NaN` karşılaştırmaları JavaScript'te her zaman `false` döner, yani bu değerler routing/risk-eşiği kararlarına sızarsa ilgili "riskli" kontroller fark ettirmeden atlanabilir.

---

## 3. Aşama 2 — Düzeltme (`chaos_input_guard.js`, commit `d18966a`)

Proje kuralı gereği `photonnet_core.js` hiçbir şekilde değiştirilemez. Düzeltme, projenin zaten kullandığı "kanca/köprü katmanı" deseniyle, **çekirdeğin önüne konan bir doğrulama/temizleme adımı** olarak uygulandı — çekirdek fonksiyonlarının kendisi birebir aynı kaldı.

**Mekanizma:**
- **Girdi doğrulama:** `km`, `reps`, `el`, `bitCount` gibi sayısal parametreler `NaN`/`undefined`/`null`/`±Infinity`/sayısal-olmayan-değer ise fiziksel olarak anlamlı bir varsayılana düşürülüyor; aralık dışı değerler en yakın güvenli sınıra kırpılıyor. Üst sınırlar (`reps` için 200, `bitCount` için 100.000, `km` için 100.000) aynı zamanda 2.1'deki sonsuz döngü riskini kapatıyor.
- **Çıktı doğrulama (ikinci savunma katmanı):** girdi kırpmak her zaman yetmiyor — `computeRepeaterGain`'in `Math.pow(10, x/10)` hattı, `km=100.000` sınırının **içinde bile** üstel taşmaya (`Infinity`) uğrayabildiği guard'ın kendi doğrulama testinde ortaya çıktı. Bu yüzden çıktı da kontrol ediliyor; taşma durumunda **fail-closed** bir varsayılana düşülüyor (`computeRepeaterGain` → 1.0 "kazanç yok"; `estimateLinkSurvival` → 0 "hayatta kalmadı" — belirsizlikte iyimser değil kötümser varsayım, projenin güvenlik felsefesiyle tutarlı).
- **Bit dizisi doğrulama:** `hEnc`/`hDec`'e giden dizi-olmayan veya 0/1 dışı bit değerleri normalize ediliyor.
- **Şeffaflık:** her düzeltme `_guard` alanında **açıkça loglanıyor** — sessizce yutulmuyor.

### 3.1 Düzeltme sürecinde bulunan iki yeni sorun (dürüstçe)

- İlk denemede `bitCount` varsayılanı `0` seçilmişti — bu, `bb84Reconcile`'ın kendi `matchRate = eşleşen/bitCount` hesabında **yeni bir `0/0=NaN` kaynağı** açtı. Guard doğrulama testi bunu yakaladı; `bitCount` alt sınırı/varsayılanı `1`'e çekilerek düzeltildi.
- `sanitizeNumber`'ın kendisi, çağıranın verdiği `fallback` değerinin **kendisinin** sınırlar içinde olduğunu varsayıyordu — bu varsayım Aşama 3'te yanlış çıktı (bkz. 4.1).

**Doğrulama:** `chaos_input_guard_test.js`, Aşama 1'in 91 temsilci bulgusunu (fonksiyon × argüman × fuzz-değeri kombinasyonu) guard'lı sürümler üzerinden tekrar çalıştırdı. **Sonuç: 91/91 artık `HANDLED`.**

---

## 4. Aşama 3 — Gerçek Çağrı Noktalarına Bağlama (commit `04d5ef5`)

Guard katmanı, gerçekten harici/güvenilmeyen veri alan iki dosyaya bağlandı:

- **`client_network_report.js`** — projenin "şirketler kendi ham fiber hat verisini (`km`) JSON olarak sağlar" iş modelinin ta kendisi; yani Aşama 1'in simüle ettiği "harici veri bozuk olabilir" senaryosu burada **gerçek, kurgusal olmayan bir tehdit yüzeyi**. `propPhoton`/`bb84Reconcile` artık çekirdekten doğrudan değil, guard'dan çağrılıyor.
- **`entanglement_hom_fidelity_sim.js`** — `fiberT()` dışa açık (`module.exports`) bir fonksiyonun içinde kullanıldığı için savunma amaçlı bağlandı.
- **`compare_js4.js`** de `fiberT()` çağırıyor, ama bu dosya (bu çalışmadan bağımsız, ilk taban commit'ten beri) var olmayan bir mutlak yola (`/root/work/photonnet/...`) `require` ediyor ve zaten hiç çalışmıyor — kapsam dışı bırakıldı.

### 4.1 Bu entegrasyonda bulunan üçüncü ve dördüncü sorun (dürüstçe)

- `client_network_report.js`, geçersiz `reps` için varsayılan olarak `autoReps(lk.km)`'yi (henüz doğrulanmamış ham `km`'den) hesaplıyordu. `km=1e20` gibi bir fuzz değeriyle bu, `"1.250.000.000.000.000.000 röle"` gibi saçma bir sayı üretip guard'ı **sessizce by-pass** ediyordu.
- Bu, `sanitizeNumber`'ın genel bir eksiğini ortaya çıkardı: fallback değerinin kendisi hiç doğrulanmıyordu. **Düzeltme:** `sanitizeNumber` artık verilen `fallback`'i de her zaman `[min,max]` aralığına kırpıyor — guard artık hiçbir koşulda sınır dışı bir değer döndürmüyor.

**Doğrulama:**
- Geçerli örnek veriyle (`sample_client_network.json`) üretilen rapor **değişmedi** (zaman damgası hariç birebir aynı) — regresyon yok.
- Kasıtlı bozuk bir müşteri girdisiyle (`km=null`/`"sensör-hatası"`/`1e20`, `reps="NaN"`) uçtan uca test edildi: artık çökme/asılma/`NaN`-sızması yok; her düzeltme raporda `girdiUyarilari` alanıyla açıkça görünüyor.
- `chaos_input_guard_test.js` hâlâ **91/91 HANDLED**.

---

## 5. Çekirdek Bütünlüğü

Her aşamada `photonnet_core.js`'nin SHA-256 hash'i doğrulandı ve **hiç değişmedi**:

```
8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05
```

`node bb84/tools/extract_core.js --check` her aşamadan sonra "SENKRON" (`PhotonNet2.jsx` ile birebir güncel) sonucunu doğruladı.

---

## 6. Kalan Kapsam / Sonraki Adımlar

- Guard katmanı şu an yalnızca yukarıdaki iki dosyaya bağlı. `bb84/` içindeki diğer ~35 dosya çekirdeği `require` ediyor ama guard'lı fonksiyonları (propPhoton/bb84Reconcile/fiberT/vb.) doğrudan çağırmıyor — bu yüzden bağlanmadılar (kapsam dışı, risksiz).
- `compare_js4.js` zaten kırık (yanlış mutlak yol) — istenirse ayrı bir adımda düzeltilebilir, bu çalışmanın kapsamında değildi.
- Guard'ın kapsadığı fonksiyon listesi: `fiberT`, `eavesdropProbability`, `computeRepeaterGain`, `estimateLinkSurvival`, `propPhoton`, `satQ`, `bb84Reconcile`, `hEnc`, `hDec`.

---

## 7. Dosyalar

| Dosya | Rol |
|---|---|
| `bb84/chaos_fuzz_test.js` | Fuzz testi orkestratörü (197 çağrı) |
| `bb84/chaos_fuzz_worker.js` | Her fuzz çağrısını izole çalıştıran alt-process işçisi |
| `bb84/chaos_input_guard.js` | Girdi/çıktı doğrulama katmanı (asıl düzeltme) |
| `bb84/chaos_input_guard_test.js` | Guard doğrulama testi (91 vaka) |
| `bb84/chaos_guard_verify_worker.js` | Guard doğrulama testinin alt-process işçisi |
| `bb84/reports/chaos_fuzz_report.json` | Aşama 1'in tam ham verisi |
| `bb84/reports/chaos_input_guard_verify_report.json` | Aşama 2'nin tam ham verisi |
| `bb84/client_network_report.js` | Guard'ın bağlandığı gerçek çağrı noktası (müşteri verisi) |
| `bb84/entanglement_hom_fidelity_sim.js` | Guard'ın bağlandığı ikinci çağrı noktası |

---

*Bu rapor, üç commit'in ({0d4721c, d18966a, 04d5ef5}) commit mesajlarında ve ilgili `reports/*.json` dosyalarında zaten kayıtlı olan bulguların ve sayıların derlenmiş halidir — hiçbir sayı bu rapor için ayrıca uydurulmamıştır.*
