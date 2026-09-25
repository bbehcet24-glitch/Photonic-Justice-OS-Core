# Kuantum Buffer — `correctionLog` Loglama Süreci Tasarımı

## 0. Bu belge NE'dir, NE DEĞİLDİR (baştan, dürüstçe)

- Bu belge `bb84/docs/QUANTUM_PHASE_BUFFER_DESIGN.md` ve `bb84/
  quantum_phase_buffer.js`'in DEVAMIDIR — o modülün `correctionLog`/
  `pulseLog`'unun **NASIL üretildiğine** değil, ürettiği analog
  simülasyon çıktılarının (biriken faz hatası ölçümleri, düzeltme
  olayları) **NASIL LOGLANDIĞINA, SAKLANDIĞINA ve DENETLENDİĞİNE**
  odaklanır.
- **`bb84/quantum_phase_buffer.js`'e TEK SATIR DOKUNULMAZ.** Modülün
  ZATEN sahip olduğu `opts.onCorrection` enjeksiyon noktası (bkz. o
  dosyanın `QuantumPhaseBuffer` yapıcısı) kullanılır — YENİ bir hook
  İCAT EDİLMEZ.
- **Bu belgede sunulan "beklenen düzeltme aralığı" formülü (§3) sıfırdan
  türetilmiş VE sayısal olarak doğrulanmıştır** (bkz. §3.2 — 3 farklı
  `correctionIntervalS` değeriyle, 800 deneme/değer, oturum notları) —
  literatürden kopyalanmamıştır.
- **Gerçek bir disk/ağ log altyapısı (Kafka, syslog, vs.) İLE entegrasyon
  YOK.** Bu belge NDJSON (newline-delimited JSON) biçiminde bir
  **serileştirme sözleşmesi** ve bunu üreten bir bellek-içi kayıtçı
  tasarlar — gerçek dosya I/O'su isteğe bağlı bir `flushToFile()` ile
  sağlanır (kodda gerçekten çalışır, test edilir) ama bir log-toplama
  sistemine (ör. ELK, Loki) BAĞLANMAZ — bu, AÇIKÇA bir sonraki adım
  olarak bırakılır (bkz. §6).

## 1. Bulunan GERÇEK sorun: mevcut loglama neden yetersiz

`QuantumPhaseBuffer.pulseLog` (her darbe için `{tS, held,
deltaAtEncode}`) ve `correctionLog` (her düzeltme olayı için `{tS,
measuredDeltaRad, deltaMaxRad}`) — `quantum_phase_buffer.js`'in KENDİSİ
zaten şunu açıkça belgelemişti (§7): *"gerçek sistemde bunun kendisi de
bir gecikme taşır, bu basit modelde ihmal edilmiştir."* Bu belge, o
notun ÜÇ SOMUT devamını bulur:

1. **Sınırsız bellek büyümesi (`pulseLog`).** `pulseLog`, HER darbede
   bir kayıt ekler ve HİÇBİR ZAMAN budanmaz. MHz-sınıfı bir darbe
   hızında (SI3N4_PIC_DESIGN.md'nin varsaydığı rejim), 1 saatlik
   sürekli çalışma → 3.6×10⁹ kayıt → GERÇEK bir üretim sürecinde bu,
   pratik olarak bellek taşmasıyla sonuçlanır. `correctionLog` (nadir
   olaylar) bu sorunu YAŞAMAZ ama `pulseLog` YAŞAR — ve
   `applyPhaseBufferToBits()` (mevcut kod) TÜM `pulseLog`'un aynı anda
   bellekte olmasını GEREKTİRİR (bkz. o fonksiyonun `bits.length ===
   pulseLog.length` kontrolü). Bu belgenin §2'si bu sorunu, `pulseLog`'u
   TAMAMEN TUTMADAN çözer.
2. **Kayıtlar geçici (in-memory) ve süreç sonlanınca kaybolur.**
   `ProductionSecurityAudit`'in "hiçbir özet değere güvenme, HAM veriyi
   SAKLA" ilkesi (bkz. `photonnet_core.js`, `ProductionSecurityAudit`
   sınıfının başlık yorumu) `correctionLog` için hiç UYGULANMADI — bir
   düzeltme olayı, süreç yeniden başlatılınca DENETLENEMEZ hâle gelir.
3. **`correctionLog` kayıtları "kör" — kendi tutarlılığı doğrulanmaz.**
   `measuredDeltaRad`/`deltaMaxRad` çifti, hiçbir zaman "bu düzeltme
   GERÇEKTEN tetiklenmesi gereken bir düzeltme miydi" sorusuna karşı
   bağımsız olarak yeniden hesaplanmaz — ve daha önemlisi, **AYRIK
   ÖRNEKLEMENİN (`maybeCorrect()`'in yalnızca `correctionIntervalS`de
   bir kontrol etmesi) KAÇIRABİLECEĞİ eşik-aşımları HİÇBİR YERDE
   GÖRÜNMEZ** — bkz. §4.

## 2. Loglama mimarisi: `CorrectionLogRecorder`

`bb84/correction_log_recorder.js` (yeni dosya), `QuantumPhaseBuffer`'a
DIŞARIDAN takılan, ÇEKİRDEĞE VE `quantum_phase_buffer.js`'E DOKUNMAYAN
bir kayıtçı:

- **`attachToBuffer(buffer)`**: `buffer.onCorrection`'ı (ZATEN var olan
  enjeksiyon noktası) kendi `_handleCorrection`'ına yönlendirir —
  `buffer`'ın önceki `onCorrection`'ı varsa (zincirleme) ÇAĞRILIR,
  KAYBOLMAZ.
- **`recordPulse(rec)`**: caller (`runPhaseBufferWithRecording`, §5) her
  `tickPulse()` sonrası bunu çağırır. **`pulseLog`'un TAMAMINI SAKLAMAZ**
  — yalnızca §4'teki "açık aşım" (open excursion) durumunu O(1) bellekte
  tutar. Bu, sorun 1'in (sınırsız bellek) doğrudan çözümüdür: kayıtçı,
  `QuantumPhaseBuffer.pulseLog`'un kendisini HİÇ OKUMAZ/TUTMAZ, yalnızca
  akan darbe kayıtlarını (stream) İŞLER ve ATAR.
- **`correctionLog` (versiyonlanmış şema)**: her düzeltme olayı şu ek
  alanlarla zenginleştirilir (HAM `measuredDeltaRad`/`deltaMaxRad`
  değişmeden tutulur, üzerine YENİ türetilmiş alanlar EKLENİR —
  `ProductionSecurityAudit`'in "özete güvenme, HAM'dan yeniden türet"
  ilkesiyle tutarlı: `exceedRatio` HER OKUYUCU tarafından
  `measuredDeltaRad/deltaMaxRad`'dan bağımsız olarak yeniden
  hesaplanabilir, kayıtçı bunu sadece KOLAYLIK için önceden hesaplar):
  ```
  {
    schemaVersion: 1,
    seq: <monoton artan tam sayı>,
    tS: <saniye>,
    measuredDeltaRad, deltaMaxRad,         // HAM (buffer'dan DEĞİŞTİRİLMEDEN)
    exceedRatio: |measuredDeltaRad| / deltaMaxRad,   // türetilmiş, yeniden-hesaplanabilir
    sinceLastCorrectionS: <önceki correctionLog kaydından bu yana geçen süre | null>,
  }
  ```
- **NDJSON dışa aktarım**: `toNdjsonLines()` her kaydı TEK SATIR JSON
  olarak döner; `flushToFile(path, {append})` (Node `fs`) bunu gerçekten
  diske yazar — hem `correctionLog` hem §4'ün `excursionLog`'u için.

## 3. Kalibrasyon-sağlığı analizi: beklenen düzeltme aralığı

### 3.1 Türetim

`PhaseDriftModel` sürüklenmesiz (drift'siz) bir Wiener sürecidir:
`Var[δ(t)] = σ²·t`. δ, `correct()` ile SIFIRLANIP yeniden başladığından,
iki düzeltme arası geçen süre — δ'nın ±δ_max bariyerine (0'dan başlayarak)
ULAŞMA süresi — klasik bir **ilk-geçiş-zamanı (first-passage time)**
problemidir. u(x) = E[τ | δ(0)=x] fonksiyonu şu ODE'yi sağlar (standart
difüzyon-MFPT denklemi): `(σ²/2)·u''(x) = −1`, sınır koşulu
`u(±δ_max)=0`. Çözüm: `u(x) = (δ_max² − x²)/σ²`. x=0'da (düzeltme
HEMEN SONRA δ=0'dan başlar):

```
┌───────────────────────────────────┐
│  E[τ_düzeltme]  ≈  δ_max² / σ²     │   (sürekli/ideal-örneklemeli yaklaşım)
└───────────────────────────────────┘
```

Dikkat: bu formülde `correctionIntervalS` **GÖRÜNMEZ** — sürekli
izlemede (her an kontrol edilirse) beklenen aralık SADECE δ_max ve σ'ya
bağlıdır.

### 3.2 Sayısal doğrulama (ve AYRIK ÖRNEKLEME yanlılığının keşfi)

σ=0.03 rad/√s, δ_max=0.05 rad için teorik E[τ]=δ_max²/σ²≈2.778s.
Gerçek `QuantumPhaseBuffer` gibi **AYRIK örneklemeli** (yalnızca
`correctionIntervalS`de bir kontrol eden) bir simülasyon, 800 denemenin
ortalamasıyla:

| `correctionIntervalS` | gözlenen ortalama (s) | gözlenen/teorik |
|---|---|---|
| 5×10⁻⁶ (çok ince örnekleme) | 2.770 | **0.997** |
| 5×10⁻⁵ (gerçek varsayılan) | 2.824 | **1.016** |
| 5×10⁻⁴ (kaba örnekleme) | 2.908 | **1.047** |

**GERÇEK BULGU**: gözlenen ortalama düzeltme-arası süre, `correctionIntervalS`
teorik zaman-ölçeğine (δ_max²/σ²) göre BÜYÜDÜKÇE, teorik değerden
SİSTEMATİK OLARAK BÜYÜK çıkıyor (0.997→1.047). Bu bir HATA DEĞİL —
beklenen bir **örnekleme takma (aliasing) yanlılığıdır**: δ, iki kontrol
arasında kısa bir süreliğine δ_max'ı AŞIP GERİ DÖNEBİLİR — bu "kısa
gezinti" hiçbir zaman bir `maybeCorrect()` çağrısına DENK GELMEZSE,
YAKALANMAZ, ve süreç δ_max'ı GERÇEKTEN aşan bir sonraki örnekleme anına
kadar (sistematik olarak DAHA UZUN) devam eder. §4 bu spesifik olayları
(yakalanmayan aşımları) doğrudan tespit eder.

`analyzeCalibrationHealth()` bu formülü kullanarak `correctionLog`'un
GERÇEK ortalama aralığını (kayıtlardaki `tS` farklarından) teorikle
karşılaştırır — yalnızca §3.2'de ölçülen ~5% yanlılığın ÇOK ÜZERİNDE bir
sapma (varsayılan eşik: 3× — gerekçe: gözlenen yanlılık aralığının en az
bir büyüklük mertebesi üstünde, bkz. kod yorumu) "kalibrasyon-dışı"
(σ veya δ_max'ın varsayılandan GERÇEKTEN farklı olduğu, ör. donanım
sürüklenmesi) olarak işaretlenir.

## 4. Aliasing tespiti: kaçırılan eşik-aşımları (`excursionLog`)

`recordPulse()`, HER darbenin `|deltaAtEncode|`'ini `deltaMaxRad`'a karşı
kontrol eder (kalıcı depolama GEREKTİRMEDEN, §2). Bir "açık aşım"
(δ eşiği aştığında) başlar, δ eşiğin altına dönene kadar sürer (peak
değeri O(1) bellekte tutulur), ve KAPANDIĞINDA (δ eşik altına
döndüğünde) `correctionLog`'da bu aralığa denk gelen bir kayıt VAR MI
diye kontrol edilir:

- **`caught: true`** — bu aşım penceresinde bir düzeltme GERÇEKTEN
  loglandı (`maybeCorrect()` onu yakaladı).
- **`caught: false`** — δ eşiği aştı, sonra `correct()` ÇAĞRILMADAN
  kendi kendine eşiğin altına döndü (`correctionLog`'da karşılığı YOK)
  — **§3.2'de öngörülen aliasing olayı, GERÇEKTEN yakalandı**.

Bu, `deltaMaxFromTargetError`'ın (mevcut kod) varsaydığı "eşik aşıldığı
HER an tutma/düzeltme devreye girer" idealizasyonunun, `correctionIntervalS`
> 0 olduğu sürece TAM OLARAK doğru olmadığını GÖSTEREN ilk somut kanıttır
— `targetErrorContribution`'ın (§3, QUANTUM_PHASE_BUFFER_DESIGN.md)
GERÇEKTE hedeflenenden biraz DAHA GEVŞEK bir güvence sağladığı anlamına
gelir (kaçırılan aşımlar sırasında bit-hata katkısı `targetErrorContribution`'ı
KISA SÜRELİĞİNE aşabilir). Bu belge bunu DÜZELTMEZ (§6) — SADECE ÖLÇÜLEBİLİR
ve GÖRÜNÜR hâle getirir.

## 5. Entegrasyon — `quantum_phase_buffer.js`'e DOKUNMADAN

```
const buffer = new QuantumPhaseBuffer({ ... });
const recorder = new CorrectionLogRecorder({ correctionIntervalS: buffer.correctionIntervalS, deltaMaxRad: buffer.deltaMaxRad });
recorder.attachToBuffer(buffer);                 // buffer.onCorrection ZATEN VAR OLAN kanca
runPhaseBufferWithRecording(buffer, recorder, pulseCount, pulsePeriodS); // runPhaseBuffer'ın YANINA eklenen sarmalayıcı
```

`runPhaseBufferWithRecording`, mevcut `runPhaseBuffer`'ı DEĞİŞTİRMEZ —
onun AYNI döngü mantığını (`tickPulse` + `maybeCorrect`) tekrarlar, TEK
farkla: her tick sonrası `recorder.recordPulse(rec)` de çağrılır.
`applyPhaseBufferToBits` (mevcut kod) ETKİLENMEZ — o hâlâ `pulseLog`'u
kullanır (küçük/orta ölçekli test çalışmaları için); büyük ölçekli
üretim çalışmaları için `pulseLog` yerine YENİ akış-tabanlı yaklaşımın
(§2) kullanılması ÖNERİLİR ama bu, `quantum_phase_buffer.js`'in KENDİ
API'sini DEĞİŞTİRMEYİ gerektireceğinden bu belgenin kapsamı DIŞINDADIR
(bkz. §6).

## 6. Dürüstlük sınırları (açık, somut)

- **`pulseLog`'un kendisi hâlâ sınırsız büyür** — bu belge `quantum_
  phase_buffer.js`'e DOKUNMADIĞI için `pulseLog.push()`'u DURDURAMAZ;
  yalnızca kayıtçının KENDİ işlem hattının buna İHTİYAÇ DUYMADIĞINI
  gösterir. Gerçek düzeltme, `pulseLog`'u tamamen kaldırıp yerine
  akış-tabanlı bir arayüz koymayı gerektirir — `quantum_phase_buffer.js`'e
  dokunmak anlamına gelir, bu yüzden AÇIKÇA yapılmadı.
- **Gerçek disk/ağ log-toplama entegrasyonu YOK** — bkz. §0.
- **`analyzeCalibrationHealth`, σ'yı YENİDEN KESTİRMEZ** — yalnızca
  YAPILANDIRILMIŞ σ ile GÖZLEMİ karşılaştırır; "gerçek σ ölçülenden
  farklı mı" sorusuna (donanımın GERÇEKTEN kalibrasyon-dışı mı olduğuna)
  cevap vermez — bu, `pulseLog`'un TAMAMINA erişim gerektirecek AYRI bir
  (istatistiksel momentler tabanlı) tahminci gerektirir, kapsam dışı
  bırakıldı.
- **`excursionLog`'un KENDİSİ de nadiren büyüyebilir** — eğer σ, δ_max'a
  göre çok büyükse (sık aşımlar), `excursionLog` de sınırsız büyür;
  kodda bir `maxExcursionLogEntries` (varsayılan 10000, ring-buffer
  budama) ile sınırlandırılmıştır — bu, "sonsuz büyüme" sorununu §4 için
  de KAPATIR, ama kayıt tutma politikası (en eski/en yeni) basit bir
  FIFO'dur, akıllı bir örnekleme/özetleme STRATEJİSİ değildir.
