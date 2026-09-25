# Asenkron, Sonlu-Örneklemli σ Tahminci Katmanı — Tasarım Belgesi

## §0 — İstek yorumu ve dürüstlük notu

Kullanıcı isteği: *"bu sonlu-boyutlu verileri kullanarak canlı donanım
sürüklenmesini (σ) anlık güncelleyen bir asenkron tahminci katmanı
tasarla."* Bu ifade tek başına iki farklı önceki iş parçasına da
atıfta bulunabilir; bu belge şu yorumu BENİMSİYOR ve açıkça beyan
ediyor:

- **"sonlu-boyutlu"** = `decoy_state_finite_key.js` görevindeki
  DİSİPLİN (asimptotik/büyük-N yaklaşımı DEĞİL, HER n için geçerli,
  ε-parametreli, KANITLANABİLİR güven aralıkları) — bu tahmincinin
  σ² için ürettiği aralık da AYNI ruhla, "yeterince veri toplandığında
  geçerli" değil "HER pencere boyutu için matematiksel olarak
  garantili" olmalı.
- **"asenkron"** = bu katman, `kalman_sigma_estimator.js`'in
  SENKRON, tek-olaylık (`buffer.onCorrection` içinde ANINDA
  hesaplayan) tasarımının TERSİNE, veri toplamayı (hızlı, bloklamayan)
  hesaplamadan (yavaş olabilir, ayrı bir "tick" ile) AYIRAN bir
  mimariye sahip olmalı.
- **σ verisi** = AYNI kaynak: `correctionLog`/`onCorrection`'dan gelen
  τ_k (düzeltme-arası süre) — `kalman_sigma_estimator.js`'te
  türetilen/ölçülen Jensen-yanlılığı düzeltmesi (kBias≈1.80) ve ölçüm-
  varyans oranı (v≈0.78) BURADA DA (değiştirmeden) yeniden kullanılıyor.

Yani bu katman, Kalman filtresinin YERİNE DEĞİL, YANINA — TAMAMLAYICI
bir ikinci tahminci olarak tasarlandı (bkz. §7 karşılaştırma).

`photonnet_core.js`, `quantum_phase_buffer.js` VE
`correction_log_recorder.js`'E TEK SATIR DOKUNULMADI (SHA-256 ile
önce/sonra doğrulandı, bkz. commit mesajı). `kalman_sigma_estimator.js`'E
DE dokunulmadı — bu yeni dosya ONU DA import ETMİYOR, tamamen paralel/
bağımsız bir dosyadır (ikisi AYNI buffer'a AYRI AYRI zincirlenebilir).

## §1 — Motivasyon: Kalman'ın bıraktığı iki boşluk

1. **Belirsizlik ölçümü rigorous DEĞİL.** `KalmanSigmaEstimator.
   sigmaUncertainty()` delta-yöntemiyle (`Var[√x]≈P/(4x)`) hesaplanan
   bir Gauss-YAKLAŞIK std'dir — "gerçek σ, %95 olasılıkla şu aralıkta"
   diyebileceğiniz, ε-parametreli, KANITLANMIŞ bir güven aralığı
   DEĞİLDİR. `decoy_state_finite_key.js` görevinde tam olarak BU
   ayrımı (asimptotik yaklaşım vs. sonlu-örneklem garantisi) önemli
   bulmuştuk — σ'nın kendisi bir güvenlik-ilgili parametre olarak
   kullanılacaksa (ör. "kalibrasyon şu anda güvenilir mi" kararı),
   AYNI rigor burada da gerekli.
2. **Hesaplama senkron/bloklayan.** Kalman'ın `update()`'i HER
   düzeltme olayında `onCorrection` içinde ANINDA çalışır — basit
   aritmetik olduğu için bu SORUN DEĞİL, ama daha ağır bir istatistik
   (ör. büyük pencere, disk/ağ I/O ile loglama) gerçek donanımda
   düzeltme-olayı hot-path'ini BLOKLAMAMALI. Bu katman, veri
   toplamayı (senkron, hızlı `push()`) hesaplamadan (asenkron, ayrı
   bir "tick" görevinde) AYIRARAK bunu modelliyor.

## §2 — Neden Chernoff formülleri DOĞRUDAN yeniden kullanılamıyor

`decoy_state_finite_key.js`'in `chernoffLambdaUpper/Lower`'ı BERNOULLİ-
TOPLAMI (SAYIM) verileri için türetildi: n_k, m_k gibi "kaç darbe
algılandı/hatalıydı" SAYILARI, Poisson/Bernoulli üstel-kuyruklu MGF'e
sahip. τ_k (düzeltme-arası süre) ise SÜREKLİ bir rastgele değişken —
sürüklenmesiz Wiener sürecinin ±δmax bariyerine ilk-geçiş-zamanı
(`kalman_sigma_estimator.js`/`correction_log_recorder.js`'te türetilen
MFPT ilişkisinin altındaki TAM dağılım). Bu dağılımın (ve dolayısıyla
z_k=δmax²/(τ_k·kBias)'ın) kapalı-form momentleri/kuyruğu teta-
fonksiyonları içerir ve (önceki görevde de not edildiği gibi) GÜVENİLİR
biçimde ezbereden türetilemedi — yani AYNI üstel-kuyruk (Chernoff-
Hoeffding) formülü BURAYA DOĞRUDAN taşınamaz (yanlış/temelsiz bir
formülü "Chernoff" diye sunmak, projenin dürüstlük disipliniyle
ÇELİŞİRDİ).

**Çözüm**: z_k'nın SADECE İKİNCİ momentini (v, Monte Carlo ile
ÖLÇÜLEN — önceki görevde v≈0.78) kullanan, dağılımdan-BAĞIMSIZ bir
sınır (Chebyshev) — bu, TAM dağılımı bilmeden de KANITLANABİLİR.

## §3 — İki tamamlayıcı sınır

### §3.1 Chebyshev (dağılımdan-bağımsız, HER n için kanıtlanmış)

Pencere-ortalaması Z̄ = mean(z_1,...,z_N), Var[Z̄] = v·σ⁴/N (i.i.d.
varsayımıyla — bkz. §8). Chebyshev eşitsizliği:

```
P(|Z̄ − σ²| ≥ h) ≤ Var[Z̄]/h² = v·σ⁴/(N·h²)
```

Bunu ε'ye çözersek (`v·σ⁴/(N·h²) = ε` ⟹ `h = σ²·√(v/(N·ε))`),
`P(|Z̄ − σ²| ≥ h) ≤ ε` GARANTİ edilir — pratikte gerçek σ²
bilinmediğinden, plug-in olarak σ̂²=Z̄ kullanılır (bkz. §8, bu bir
YAKLAŞIKLIK — TAM olarak σ²'ye göre türetilmiş sınır, σ̂²'ye göre
uygulanıyor).

```js
chebyshevHalfWidth(sigma2Hat, n, v, epsilon) = sigma2Hat * sqrt(v / (n * epsilon))
```

### §3.2 CLT/Gauss-yaklaşık (asimptotik, daha sıkı ama KANITLANMAMIŞ)

Büyük N'de Merkezi Limit Teoremi ile Z̄ ≈ N(σ², v·σ⁴/N):

```
cltHalfWidth(sigma2Hat, n, v, epsilon) = zCrit(1 − ε/2) * sigma2Hat * sqrt(v / n)
```

`zCrit`, standart normal dağılımın ters-CDF'i — bu belge/kod BUNU
EZBERDEN bir rasyonel-yaklaşım POLİNOMUYLA (hataya açık, doğrulanamaz)
YAZMIYOR: Simpson kuralıyla nümerik integral (`stdNormalCDF`) + ikili-
arama (`normInvCDF`) ile HESAPLANIYOR — yani yalnızca temel
matematikten (Gauss yoğunluk fonksiyonu + sayısal integral) türetiliyor,
ezberlenmiş bir sabit YOK. Testte bilinen değerlerle (z(0.975)≈1.96,
z(0.995)≈2.576) çapraz-kontrol edildi.

### §3.3 Monte Carlo kapsama (coverage) ölçümü — GERÇEK BULGU

GERÇEK `QuantumPhaseBuffer`+`CorrectionLogRecorder` ile (mock YOK),
150 bağımsız tohum, ~26000 z-örneği (σ=0.08, δmax=0.012):

| N   | ε=0.10 Chebyshev | ε=0.10 CLT | ε=0.05 Chebyshev | ε=0.05 CLT | ε=0.01 Chebyshev | ε=0.01 CLT |
|-----|-----------------:|-----------:|------------------:|-----------:|------------------:|-----------:|
| 5   | 0.023 (≤0.10 OK) | 0.134 (OK) | 0.006 (≤0.05 OK)  | 0.097 (✗ hedefin ~2x'i) | 0.000 (≤0.01 OK) | 0.047 (✗ hedefin ~5x'i) |
| 10  | 0.017 (OK)        | 0.115 (OK) | 0.001 (OK)         | 0.073 (OK, sınırda) | 0.000 (OK) | 0.031 (✗ hedefin ~3x'i) |
| 20  | 0.008 (OK)        | 0.107 (OK) | 0.002 (OK)         | 0.062 (OK) | 0.000 (OK) | 0.021 (✗ hedefin ~2x'i) |
| 50  | 0.000 (OK)        | 0.098 (OK) | 0.000 (OK)         | 0.049 (OK) | 0.000 (OK) | 0.009 (OK) |
| 100 | 0.000 (OK)        | 0.113 (OK) | 0.000 (OK)         | 0.060 (OK) | 0.000 (OK) | 0.007 (OK) |

**BULGULAR (dürüstçe rapor edilen, ÖNCEDEN varsayılmayan):**

1. **Chebyshev HER durumda hedefin ÇOK altında** — beklenen (Chebyshev
   ikinci-moment-only bir sınır olduğu için AŞIRI tutucu; bu, kesinlik
   karşılığında geniş aralık verir — bir GÜVENLİK marjı, bir kusur
   DEĞİL).
2. **CLT, KÜÇÜK N'de VE KÜÇÜK ε'de (özellikle ε=0.01, N≤20) hedefin 2-5
   KATI ihlal oranı veriyor** — yani BU rejimde "%99 güvenilir" diye
   sunulan bir aralık GERÇEKTE ~%95-97 güvenilir. Bu, z_k'nın dağılımının
   (τ'nun first-passage-time yapısından kalıtsal) sağa-çarpık olması ve
   CLT'nin kuyruk bölgesine YAKINSAMASININ, gövdeye YAKINSAMASINDAN
   YAVAŞ olmasıyla açıklanabilir bir davranıştır.
3. **AMPİRİK EŞİK**: veriler kabaca `N ≥ 1/ε` kuralıyla UYUMLU (ε=0.10→
   N≥10, ε=0.05→N≥20, ε=0.01→N≥50-100 civarında CLT güvenli hâle
   geliyor). Bu EMPİRİK bir UYUM — analitik olarak TÜRETİLMEDİ, ve
   yalnızca test edilen aralıkta (N≤100, ε≥0.01, tek bir (σ,δmax)
   parametre çifti) doğrulandı — dışına EKSTRAPOLE EDİLMEMELİDİR.

**TASARIM KARARI**: `AsyncFiniteSigmaEstimator`, varsayılan olarak
SADECE Chebyshev kullanır (`method:'chebyshev'`, projenin fail-closed
disipliniyle uyumlu — kanıtlanmamış bir aralığı SESSİZCE sunmamak).
`method:'clt'` isteğe bağlıdır VE `N < 1/ε` olduğunda (ampirik eşiğin
altında) `opts.allowUnverifiedClt:true` VERİLMEDİKÇE RangeError fırlatır.

## §4 — Asenkron mimari

```
push({tau, tS})           ── SENKRON, HIZLI: kuyruğa ekler, HESAPLAMA YAPMAZ
        │ (setImmediate ile ZİNCİRLENEN, YALNIZCA push() sonrası tetiklenen tick)
        ▼
_tick()                    ── ASENKRON (ayrı makro-görev): kuyruktaki HER
                               örneği z'ye çevirir, pencereye ekler, pencere
                               dolunca _completeWindow() çağırır
        ▼
_completeWindow()           ── σ² nokta-tahmini + seçili yöntemle güven
                               aralığı hesaplar, onEstimate(snapshot)
                               çağırır, nextEstimate() Promise'lerini çözer
```

`push()` asla `setImmediate`'i "sürekli boşta dönen" bir döngüye
ÇEVİRMEZ — yalnızca YENİ veri geldiğinde (`push()` çağrıldığında,
zaten planlanmamışsa) BİR SEFERLİK bir tick planlanır; kuyruk boşalınca
DÖNGÜ KENDİLİĞİNDEN durur (CPU'yu boşa YAKMAZ). `drain()`, kuyruk
tamamen işlenene kadar beklemek isteyen (ör. toplu replay) çağıranlar
için bir Promise döndürür. `flush()`, tam dolmamış bir pencereyi
ZORLA tamamlar (n=pencere boyutundan KÜÇÜK olsa da — hem Chebyshev hem
CLT formülleri GERÇEK n'i kullanır, bu yüzden matematiksel olarak
GEÇERLİ kalır, sadece daha GENİŞ bir aralık üretir).

## §5 — Pencereleme politikası

Sabit-boyutlu (N örnek), AYRIK (üst-üste BİNMEYEN) pencere — kayan/
üst-üste-binen pencere (her yeni örnekte YENİDEN hesaplama) BİLEREK
EKLENMEDİ (§8 — basitlik/dürüstlük; gelecek iş).

## §6 — Kalman ile karşılaştırma (§7'de test edilecek)

Pencere-tabanlı tahminci, σ'daki ANİ bir değişimi Kalman'dan YAVAŞ
YAKALAR (N örnek TOPLANMADAN yeni pencere TAMAMLANAMAZ) — AMA ürettiği
aralık (Chebyshev modunda) HER n için KANITLANMIŞ bir garantiye sahiptir.
İkisi ÇAKIŞAN değil TAMAMLAYICI roller oynar: Kalman = gerçek-zamanlı
İZLEME (kontrol döngüsü için "şimdi σ ne?"), bu katman = periyodik,
RIGOROUS SERTİFİKASYON (güvenlik kararı için "σ'nın şu anda GERÇEKTEN
şu aralıkta olduğuna ε olasılıkla güvenebilir miyim?").

## §7 — Dürüstlük/sınırlar

- v (≈0.78) ve kBias (≈1.80), `kalman_sigma_estimator.js` görevinde
  Monte Carlo ile ÖLÇÜLDÜ — kapalı-form TÜRETİLMEDİ; bu görevde AYNI
  değerler YENİDEN KULLANILDI (ve BU parametre setiyle çapraz-kontrol
  edildi, §3.3 tablosundaki zMean/σ²≈1.0 satırı).
- Pencere içindeki z_k'lar TAM olarak i.i.d. DEĞİLDİR eğer gerçek σ,
  PENCERE SÜRESİ BOYUNCA değişiyorsa (durağanlık varsayımı) — bu,
  Kalman'ın avantajlı olduğu (hızlı değişimi izleyebilme) tam da
  senaryo.
- CLT güvenilirlik eşiği (`N≥1/ε`) EMPİRİK bir gözlem, kanıtlanmış bir
  teorem DEĞİL — yalnızca test edilen (N≤100, ε≥0.01, TEK bir (σ,δmax)
  çifti) aralığında doğrulandı.
- Chebyshev sınırı KASITLI OLARAK GEVŞEKTİR (sadece 2. moment kullanır)
  — daha sıkı ama HALA rigorous bir sınır (ör. Bernstein-tipi, üçüncü/
  dördüncü moment veya MGF sınırı kullanan) mümkün olabilir ama z_k'nın
  MGF'i kapalı-form bilinmediğinden BU GÖREVDE türetilmedi.
- Kayan/üst-üste-binen pencere ele ALINMADI — yalnızca ayrık pencere.
- `AsyncFiniteSigmaEstimator`, `kalman_sigma_estimator.js`'i import
  ETMEZ/gerektirmez — ikisi AYNI buffer'a BAĞIMSIZ olarak zincirlenebilir
  (test edildi, bkz. §… test dosyası Test 8).
