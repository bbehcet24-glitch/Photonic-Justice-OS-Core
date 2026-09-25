# Kuantum Buffer — Kalman Filtresiyle Canlı σ (Donanım Sürüklenmesi) Kestirimi

## 0. Bu belge NE'dir, NE DEĞİLDİR (baştan, dürüstçe)

- Bu belge, `bb84/docs/CORRECTION_LOG_RECORDER_DESIGN.md` §6'da AÇIKÇA
  belirtilen şu sınırlamanın devamıdır: *"analyzeCalibrationHealth, σ'yı
  YENİDEN KESTİRMEZ — yalnızca YAPILANDIRILMIŞ σ ile GÖZLEMİ karşılaştırır
  ... bu, pulseLog'un TAMAMINA erişim gerektirecek AYRI bir (istatistiksel
  momentler tabanlı) tahminci gerektirir, kapsam dışı bırakıldı."* Bu
  belge o tahminciyi — kullanıcının istediği biçimde, bir **Kalman
  Filtresi** olarak — ekler.
- **`bb84/quantum_phase_buffer.js`'e VE `bb84/correction_log_recorder.js`'E
  TEK SATIR DOKUNULMAZ.** Bu belgenin kayıtçısı, `CorrectionLogRecorder`
  ZATEN ÜRETTİĞİ `correctionLog`'u (`sinceLastCorrectionS` alanı) GİRDİ
  olarak kullanır — `pulseLog`'a HİÇ İHTİYAÇ YOKTUR (bu, `correction_log_
  recorder.js`'in ZATEN bellek-sınırlı tasarımıyla TAM TUTARLIDIR — bkz.
  §2).
- **Bu belgedeki İKİ sabit (§3.2, §4.2) bu oturumda Monte Carlo ile
  SIFIRDAN ÖLÇÜLMÜŞTÜR** — literatürden alınmamıştır (iki-taraflı ilk-
  geçiş-zamanının TAM olasılık dağılımı, teta-fonksiyonu serileriyle
  ifade edilen bilinen ama KAPALI-FORMDA basit olmayan bir sonuçtur; bu
  oturumda güvenilir şekilde yeniden türetilemeyeceği için, GEREKEN İKİ
  moment SAYISAL olarak ölçüldü — bkz. §3.2/§4.2'deki tablo değerleri).
- **Bu bir "gerçek zamanlı sinyal işleme" değil, "olay-tetiklemeli seyrek
  ölçüm" Kalman filtresidir** — her `correctionLog` kaydı (nadir bir
  olay, bkz. `CORRECTION_LOG_RECORDER_DESIGN.md` §3.1) TEK bir ölçüm
  üretir; darbe hızında (MHz) değil, düzeltme hızında (tipik saniyede
  birkaç-onlarca) güncellenir.

## 1. Problem: σ zamanla DEĞİŞEBİLİR, ama şu ana kadar hiçbir yerde YENİDEN TAHMİN EDİLMİYOR

`quantum_phase_buffer.js`'in `DEFAULTS.sigmaRadPerSqrtS` SABİT bir
YAPILANDIRMA değeridir — gerçek donanımda bu, sıcaklık sürüklenmesi,
yaşlanma, veya harici titreşim gibi etkenlerle ZAMANLA DEĞİŞEBİLİR.
`CorrectionLogRecorder.analyzeCalibrationHealth()` bu SAPMAYI tespit
edebilir (flagged=true) ama YENİ σ'yı KESTİREMEZ — sadece "eski σ artık
yanlış" der, "yeni σ şu" demez. Bu belge, `correctionLog`'un ÜRETTİĞİ
düzeltme-arası süreleri (τ_k = `sinceLastCorrectionS`) canlı bir Kalman
Filtresine besleyerek σ'nın KENDİSİNİ, ZAMANLA DEĞİŞEBİLECEK bir durum
değişkeni olarak, ANLIK (her yeni düzeltme olayında) yeniden tahmin eder.

## 2. Neden `correctionLog` (ve NEDEN `pulseLog` DEĞİL)

`CorrectionLogRecorder`, bilinçli bir tasarım kararıyla (bkz.
`CORRECTION_LOG_RECORDER_DESIGN.md` §2) `pulseLog`'un TAMAMINI SAKLAMAZ.
Bu, "σ'yı istatistiksel MOMENTLERDEN (ör. δ'nin örneklem varyansından)
kestirmek için TÜM darbe geçmişine erişim gerekir" varsayımını
GEÇERSİZLEŞTİRİR — ama iyi haber: **buna gerek YOK**. `correctionLog`'un
KENDİSİ zaten σ hakkında GÜÇLÜ bir sinyal taşıyor: `CORRECTION_LOG_
RECORDER_DESIGN.md` §3.1'de türetilen `E[τ]=δ_max²/σ²` ilişkisi, HER
düzeltme-arası süre τ_k'nın, TEK BAŞINA, σ'nın (gürültülü ama BİLGİ
İÇEREN) bir ölçümü olduğu anlamına gelir. Bu belge τ_k'yı DOĞRUDAN Kalman
filtresinin ölçüm girdisi yapar — `pulseLog`'a hiç dokunmaz.

## 3. τ_k'dan σ² ölçümüne: Jensen yanlılığı (GERÇEK BULGU)

### 3.1 Naif yaklaşım ve BULUNAN sorun

E[τ]=δ_max²/σ² olduğundan, ilk bakışta "z_k = δ_max²/τ_k" σ²'nin
YANSIZ (unbiased) bir ölçümü gibi görünür. **BU YANLIŞTIR.** 1/x
fonksiyonu x>0 için DIŞBÜKEYDİR (convex) — Jensen eşitsizliği:
`E[1/τ] ≥ 1/E[τ]` (kesin eşitsizlik, τ sabit olmadığı sürece). Yani
`E[z_k] = δ_max²·E[1/τ] > δ_max²/E[τ] = σ²_gerçek` — **z_k, σ²'yi
SİSTEMATİK OLARAK YÜKSEK tahmin eder.**

### 3.2 Ölçüm (Monte Carlo)

İki-taraflı ilk-geçiş-zamanının VARYANS/ORTALAMA² oranı (cv²) VE bu
yanlılığın BÜYÜKLÜĞÜ (k), 5 farklı (σ,δ_max) çiftinde, her biri
6000-8000 bağımsız denemeyle ölçüldü (sürekliye yakın ince örnekleme):

| σ | δ_max | cv² (Var[τ]/E[τ]²) | k = E[z_ham]/σ²_gerçek |
|---|---|---|---|
| 0.05 | 0.015 | 0.672 | 1.803 |
| 0.08 | 0.030 | — | 1.821 |
| 0.03 | 0.010 | — | 1.787 |
| 0.10 | 0.050 | — | 1.777 |
| 0.06 | 0.020 | — | 1.799 |

**SONUÇ**: cv²≈0.67 VE k≈1.80, σ/δ_max'tan BAĞIMSIZ (boyutsuz,
EVRENSEL) sabitler — iki-taraflı ilk-geçiş-zamanı probleminin ölçek-
değişmez (scale-invariant) doğasının beklenen bir sonucu. Not: k'nin
basit "1+cv²" (delta-yöntemi/1.-derece Taylor yaklaşıklığı) tahmini
1.67 verir — GERÇEK ölçülen 1.80'den FARKLIDIR, çünkü cv²=0.67 "küçük"
sayılamayacak kadar büyük (delta-yöntemi yalnızca KÜÇÜK cv² için
GEÇERLİDİR) — bu yüzden k, YAKLAŞIK bir formülle DEĞİL, DOĞRUDAN
ölçülerek kullanılıyor (bkz. §0, dürüstlük notu).

### 3.3 Yanlılık düzeltmesi

```
z_k (düzeltilmiş) = δ_max² / (τ_k · k),   k ≈ 1.80 (ölçülen)
```

Bu düzeltmeyle E[z_k]≈σ²_gerçek (§4.2'de doğrulandı — düzeltilmemiş
z'nin σ tahminini ~%30-80 YÜKSEK gösterdiği, düzeltilmiş z'nin ise
Kalman filtresini GERÇEK σ'ya yakınsattığı GÖZLEMLENDİ, bkz. §6).

## 4. Kalman Filtresi tasarımı

### 4.1 Durum ve süreç modeli

Durum: `x = σ²` (varyans hızı, rad²/s) — pozitiflik doğal olarak KORUNUR
çünkü σ (değil σ²) yerine σ² izlenir ve güncelleme sonrası ALT SINIR
(1e-12) uygulanır.

Süreç modeli (durum, ölçümler ARASI GERÇEK zamanla ÖLÇEKLENEN bir
rastgele-yürüyüş — donanımın KENDİSİNİN ne kadar hızlı DRİFT edebileceği
hakkında GEREKÇELENDİRİLMİŞ ama ÖLÇÜLMEMİŞ bir varsayım, `si3n4_pic_
link_budget.js`'deki PARAM_RANGES ruhuyla TUTARLI):

```
x_k = x_{k-1} + w_k,   w_k ~ N(0, Q_k),   Q_k = (r·x_{k-1})²·Δt_gerçek
```

`r` (processNoiseRelRate) — "σ² birim zamanda göreli olarak ne kadar
değişebilir" — varsayılan 0.05 (saniyede %5'lik göreli DRİFT payı,
donanım kalibrasyon zaman ölçekleriyle [dakikalar-saatler] kabaca
TUTARLI bir mertebe — ÖLÇÜLMEMİŞ, kullanıcı KENDİ donanımına göre
AYARLAMALI).

### 4.2 Ölçüm modeli

```
z_k = δ_max² / (τ_k · k),    R_k = v · x_{k|k-1}²
```

`v` (measurementVarianceRatio) — Var[z_düzeltilmiş]/σ⁴ — AYNI Monte
Carlo deneyinde DOĞRUDAN ölçüldü (delta-yöntemiyle cv²'den TÜRETMEK
YERİNE — §3.2'nin aynı nedenle: cv² büyük olduğunda delta-yöntemi
yetersiz):

| σ | δ_max | v = Var[z_düz]/σ⁴ |
|---|---|---|
| 0.05 | 0.015 | 0.818 |
| 0.08 | 0.030 | 0.734 |
| 0.03 | 0.010 | 0.803 |
| 0.10 | 0.050 | 0.762 |

Ortalama v≈0.78 kullanılır (varsayılan).

### 4.3 Güncelleme (standart skaler Kalman denklemleri)

```
Öngörü:     x⁻=x_{k-1},  P⁻=P_{k-1}+Q_k
Kazanç:     K = P⁻/(P⁻+R_k)
Güncelleme: x_k = max(1e-12, x⁻ + K·(z_k−x⁻)),  P_k=(1−K)·P⁻
Rapor:      σ̂_k = √x_k
```

## 5. τ_k KAYNAĞI: `correctionLog.sinceLastCorrectionS` — DOĞRUDAN kullanım

`CorrectionLogRecorder.correctionLog[i].sinceLastCorrectionS` ZATEN
TAM OLARAK τ_k'dır (bkz. `correction_log_recorder.js`, DEĞİŞTİRİLMEDEN).
Bu belgenin kayıtçısı bu diziyi (ya TOPLU/`replayCorrectionLog` ile
GEÇMİŞ verilerden ISINDIRMA, ya CANLI/`attachToBuffer` ile ZİNCİRLEME
enjeksiyon noktasından) tüketir — `CorrectionLogRecorder`'ın KENDİSİNE
YENİ bir kanca EKLEMEDEN, `buffer.onCorrection`'ı (ZATEN `CorrectionLogRecorder.
attachToBuffer`'ın zincirlediği AYNI kanca) BİR KEZ DAHA zincirleyerek —
`τ_k`'yı KENDİ BAŞINA (ardışık `info.tS` farkından) hesaplar, `recorder`'ın
İÇ VERİSİNE erişmeye GEREK KALMADAN.

## 6. Sayısal doğrulama

**Senaryo A** (SABİT gerçek σ=0.05 rad/√s, filtre YANLIŞ bir başlangıç
tahminiyle (0.15) başlatıldı, 5 bağımsız tohum, ~30-36 düzeltme
olayı/tohum): TÜMÜ 0.042-0.054 aralığında YAKINSADI (gerçek değerin
±%16'sı içinde — cv²≈0.67'nin GETİRDİĞİ doğal örneklem gürültüsüyle
TUTARLI bir dağılım, sistematik bir YANLILIK YOK).

**Senaryo B** (gerçek σ, tS=1.5s'de 0.03'ten 0.09'a ANİ SIÇRAR —
donanım kalibrasyon-dışı olma senaryosu): filtre sıçramayı yaklaşık
1-1.5 saniye (birkaç düzeltme olayı) içinde ALGILAYIP YENİ değere
(0.08-0.10 aralığında SALINARAK) YAKINSADI.

Yanlılık-düzeltmesi (k≈1.80) OLMADAN aynı senaryolar çalıştırıldığında
(bkz. oturum notları), tahminler SİSTEMATİK OLARAK gerçek σ'nın
%30-80 ÜZERİNDE YAKINSADI — düzeltmenin (§3.3) NEDEN GEREKLİ olduğunun
somut kanıtı.

## 7. Uygulama — `bb84/kalman_sigma_estimator.js`

- `DEFAULTS` — {kBias≈1.80, measurementVarianceRatio≈0.78,
  processNoiseRelRate=0.05, initialVarianceMultiplier=4} (§3.2/§4.2/§4.1).
- `KalmanSigmaEstimator` sınıfı — `update({tau,tS})`, `sigmaEstimate()`,
  `sigmaUncertainty()` (delta-yöntemiyle √x'in std'si), `snapshot()`.
- `attachToBuffer(buffer)` — `buffer.onCorrection`'ı (ZATEN mevcut,
  `CorrectionLogRecorder`'ın da kullandığı) BİR KEZ DAHA zincirler.
- `replayCorrectionLog(estimator, correctionLog)` — bir `CorrectionLogRecorder.
  correctionLog` dizisini (GEÇMİŞ veri) SIRAYLA besler — "ISINDIRMA"
  (warm-start) için.

## 8. Dürüstlük sınırları (açık, somut)

- **k ve v sabitleri KESİN kapalı-form DEĞİL, Monte Carlo ÖLÇÜMÜDÜR** —
  bkz. §0/§3.2/§4.2. Farklı bir δ_max/σ rejiminde (ör. ÇOK küçük veya
  ÇOK büyük cv²) bu sabitlerin GEÇERLİLİĞİ YENİDEN doğrulanmalıdır.
- **`excursionLog`'un "kaçırılan" (caught=false) olayları KULLANILMAZ**
  — bunlar da σ hakkında BİLGİ TAŞIR (bkz. `CORRECTION_LOG_RECORDER_
  DESIGN.md` §4) ama bu belge SADECE `correctionLog`'un ZATEN VAR OLAN
  `sinceLastCorrectionS`'ini kullanır — excursion-tabanlı EK bir ölçüm
  kanalı AÇIKÇA bir sonraki adım olarak bırakılmıştır.
- **AYRIK-ÖRNEKLEME ALIASING yanlılığı (bkz. CORRECTION_LOG_RECORDER_
  DESIGN.md §3.2, ~%1-5) BU BELGEDE DÜZELTİLMEZ** — τ_k, GERÇEK
  `correctionIntervalS`'e bağlı olarak HAFİFÇE şişkin olabilir; k≈1.80
  düzeltmesi bunu KAPSAMAZ (ayrı bir, DAHA KÜÇÜK etkidir).
- **processNoiseRelRate (§4.1) GEREKÇELENDİRİLMİŞ ama ÖLÇÜLMEMİŞ bir
  varsayımdır** — gerçek donanımın kalibrasyon zaman ölçeği bilinmeden
  KESİN bir değer verilemez.
- **Bu, KLASİK (doğrusal, Gauss ölçüm gürültülü) bir Kalman filtresi
  DEĞİLDİR** — z_k'nın GERÇEK dağılımı (τ'nun tersinin dağılımı) Gauss
  DEĞİLDİR; bu yaklaşım yalnızca 1. ve 2. momentleri (ortalama, varyans)
  eşleştiren bir "moment-eşleştirmeli" Kalman uygulamasıdır (Genişletilmiş
  Kalman Filtresi'nin (EKF) doğrusallaştırma ruhuna YAKINDIR ama TAM bir
  EKF türetimi DEĞİLDİR) — pratikte İŞE YARADIĞI §6'da GÖSTERİLDİ ama
  optimal bir tahminci OLDUĞU İDDİA EDİLMEZ.
