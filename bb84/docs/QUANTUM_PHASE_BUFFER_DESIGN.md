# Kuantum Buffer — faz birikimini (phase accumulation) engelleyen tampon/geri-besleme mantığı

## 0. Bu belge NE'dir, NE DEĞİLDİR

`bb84/docs/SI3N4_PIC_DESIGN.md`'nin §5'i bir sorunu AÇIK BIRAKMIŞTI: termo-optik
faz kaydırıcılar (10–100μs yanıt) MHz-hızlı darbe akışına göre YAVAŞ — bu
belge o boşluğu dolduruyor. Yine AYNI dürüstlük sınırı geçerli: bu, gerçek
bir kontrol-döngüsü ASIC'i veya FPGA firmware'i DEĞİL, literatür-tipik
parametrelerle kurulmuş, **gerçek kodla çalıştırılıp doğrulanmış bir
fiziksel model + tampon/geri-besleme mantığıdır**. Çekirdeğe
(`bb84/photonnet_core.js`) bu çalışmanın hiçbir adımında dokunulmadı.

## 1. Problem: "faz birikimi" tam olarak nedir

`SI3N4_PIC_DESIGN.md`'deki asimetrik MZI kodlayıcı, DIAG bazını göreli faz
(0 veya π) ile kodluyor. Bu fazı üreten termo-optik ısıtıcı, İKİ ayrı
kaynaktan sürüklenir:

1. **Kasıtlı olmayan ortam driftı**: oda sıcaklığı dalgalanması, çipin
   kendi komşu (kayıplı) bileşenlerinden gelen öz-ısınma. Si₃N₄'ün
   kendi termo-optik katsayısı (dn/dT≈2.5×10⁻⁵/K) silikona göre (≈1.8×10⁻⁴/K)
   ZATEN düşük — bu Si₃N₄'ün bir AVANTAJIDIR, ortam driftına karşı
   nispeten bağışık. **Ama** bu belgedeki asıl kaygı bu DEĞİL.
2. **Aktif sürücü elektroniğinin kendi kararsızlığı**: ısıtıcıyı süren
   DAC/akım kaynağının 1/f gürültüsü + termal zaman sabiti — istenen faz
   değerini (0 veya π) ANLIK olarak tam isabetle tutamaz, zamanla KÜÇÜK
   hatalar BİRİKİR (rastgele yürüyüş/Wiener süreci benzeri).

Bu biriken hata (δ, radyan), kodlanan qubit'in GERÇEK fazını istenenden
kaydırır — DIAG bazında bu, Bob'un doğru bazı seçtiği durumlarda bile
BEKLENMEDİK bir bit hatası olarak ortaya çıkar (küçük δ için
yaklaşık P_hata ≈ δ²/4, bkz. §3). Bu hata, `photonnet_core.js`'in
zaten modellediği KANAL kaybı/gürültüsünden (fiberT, propPhoton) TAMAMEN
AYRI bir fiziksel katmandır — **kaynak/kodlayıcının kendi doğruluğu**dur,
fotonun kanalda başına gelenle ilgisi yoktur.

**Neden önemli:** kontrolsüz bırakılırsa bu hata KANAL kaybından
BAĞIMSIZ, SABİT bir taban-QBER'i (baseline QBER) yaratır — casus (Eve)
hiç yokken bile QBER zamanla sürünerek yükselir. Yeterince büyürse
(teorik eşik ~%11) sistemin KENDİ eşik-tabanlı casus tespiti
(`eavesdropDetected = qber > 0.11`, bkz. `deriveSiftedKey`) YANLIŞ ALARM
verir — bu, protokolün GÜVENLİĞİNİ değil KULLANILABİLİRLİĞİNİ (kendi
kendine hizmet reddi) tehdit eder, ama yine de gerçek ve ciddi bir
operasyonel risktir.

## 2. Neden "tampon" (buffer) — neden basitçe "daha hızlı düzelt" değil

Isıtıcının fiziksel yanıt süresi (10–100μs, `SI3N4_PIC_DESIGN.md` §5)
BİR ALT SINIRDIR — MHz-sınıfı darbe hızında (darbe periyodu ~1μs veya
altı) bu, **her düzeltme fırsatı arasında yüzlerce-binlerce darbenin
geçtiği** anlamına gelir. Düzeltme daha SIK yapılamaz (fiziksel yanıt
süresi sınırı) — bu yüzden çözüm "daha hızlı düzelt" değil, **"düzeltme
arada geçen darbeleri BİLEREK riskli sayıp, ölçülen hata payı toleransı
aşarsa o darbeleri KODLAMADAN TUT/İPTAL ET (fail-closed), sonra
düzelt"** mantığıdır — adı buradan gelir: bir **Kuantum Buffer**, faz
DÜZELTİLENE kadar darbe akışını GEÇİCİ OLARAK durdurur/damgalar; hatalı
fazla SESSİZCE kodlamaya devam ETMEZ. Bu, projenin genel fail-closed
felsefesiyle (`production_gate.js`, `qrng_hardware_bridge.js`,
`mtls_handshake_qrng_sync.js`) AYNI disiplindir — burada "bağlantıyı
kapat" yerine "bu darbe penceresini kodlama".

Bu aynı zamanda `bb84/epoch_reset_controller.js` ile YAPISAL bir
benzerlik taşır (biri "sayaç eşiği aşılınca sıfırla", öbürü "faz hatası
eşiği aşılınca sıfırla") ama **KASITLI OLARAK AYRI bir modüldür** —
`EpochResetController` SABİT ZAMAN ARALIĞINDA (30 gün) tetiklenen
DİJİTAL bir sayaç disiplinidir; Kuantum Buffer ise SÜREKLİ/ANALOG bir
fiziksel büyüklüğün (faz, radyan) EŞİK-AŞIMINA göre (olay-tetiklemeli,
zaman aralığı SABİT DEĞİL) tetiklenir. İkisini TEK bir sınıfa
zorlamak, `EpochResetController`'ın zaten belgelenmiş "bu bir dijital
sayaç-taşması disiplinidir" kapsamını genişletip bulanıklaştırırdı —
bkz. `mtls_handshake_qrng_sync.js`'in tasarımında bulunan AYNI sınıf
"granülerlik uyuşmazlığı" dersi.

## 3. Faz hatası → bit-hatası dönüşümü (gerçek hesaplanan, kod ile doğrulanan)

Asimetrik-MZI faz kodlamalı bir kübitte, istenen göreli faz φ_hedef
(0 veya π) yerine φ_hedef+δ uygulanırsa, Bob'un DOĞRU bazda ölçtüğü
durumda yanlış-sonuç (bit-flip) olasılığı standart interferometrik
görünürlük kaybı formülüyle verilir:

```
P_hata(δ) = sin²(δ/2)
```

Özellikler (kod ile doğrulanıyor, bkz. §6):
- δ=0 → P_hata=0 (hata yok, mükemmel kalibrasyon)
- δ=π → P_hata=1 (fazın TAM TERSİ — garanti hatalı)
- Küçük δ için P_hata ≈ δ²/4 (ikinci dereceden — KÜÇÜK bir faz hatası
  ORANTISIZ ÖLÇÜDE KÜÇÜK bir bit-hatası riski taşır, bu yüzden "sıkı ama
  makul" bir tolerans seçilebilir)
- Monoton artan, simetrik (δ ve -δ aynı hata olasılığını verir)

**Tolerans seçimi:** hedef, faz-kaynaklı hatanın protokolün KENDİ
eşiğine (%11) göre İHMAL EDİLEBİLİR kalmasıdır — bu belge, hedef katkıyı
**%1'in altında** tutacak δ_max'ı GERİYE ÇÖZEREK (kod ile) hesaplıyor:
`δ_max = 2·arcsin(√0.01) ≈ 0.2003 rad ≈ 11.48°`. Bu, keyfi bir sayı
DEĞİL — güvenlik eşiğinden (0.11) ONDA-BİR'lik bir güvenlik payıyla
geriye türetilmiş bir mühendislik kararıdır (bkz. `bb84/si3n4_pic_link_budget.js`'in
`PARAM_RANGES` disipliniyle AYNI "keyfi sabit YAZMA, gerekçelendirilmiş
ARALIK/formülle türet" yaklaşımı).

## 4. Sürüklenme modeli

Biriken faz hatası, ayrık-zamanlı bir rastgele yürüyüş (Wiener süreci
yaklaşımı) olarak modellenir:

```
δ(t+dt) = δ(t) + N(0, σ²·dt)
```

`σ` (rad/√s), DAC gürültüsü + termal kararsızlığın BİRLEŞİK etkisini
temsil eden TEK bir parametredir — bu belge onu ÖLÇÜLMÜŞ bir değer
olarak DEĞİL, `PhaseDriftModel`'in `sigmaRadPerSqrtS` parametresiyle
AÇIKÇA ayarlanabilir, varsayılanı yorumlarda gerekçelendirilmiş bir
büyüklük mertebesi (order-of-magnitude) olarak sunar (bkz.
`quantum_phase_buffer.js` başlığı). Gerçek bir çipte bu parametre pilot-
ton ölçümüyle KARAKTERİZE EDİLİR, tahmin EDİLMEZ.

## 5. Kuantum Buffer mantığı

```
her darbe periyodunda (yüksek frekans, MHz):
    drift modeli bir adım ilerler (δ birikir)
    eğer buffer "TUTMA" durumundaysa:
        darbe KODLANMAZ (fail-closed) — sayaca eklenir, log'lanır
    değilse:
        darbe normal kodlanır

her ölçüm/düzeltme aralığında (düşük frekans, ısıtıcının fiziksel
yanıt süresine bağlı — 10-100μs, SI3N4_PIC_DESIGN.md §5 ile TUTARLI):
    mevcut δ "ölçülür" (pilot-ton simülasyonu)
    eğer |δ| > δ_max:
        buffer "TUTMA" durumuna geçer (bu andan itibaren gelecek darbeler
        düzeltme TAMAMLANANA kadar kodlanmaz)
        düzeltme darbesi uygulanır (δ → 0'a sıfırlanır — gerçek bir geri-
        besleme döngüsünün ısıtıcı DAC'ına düzeltici akım göndermesini
        temsil eder)
        buffer "AKIŞTA" durumuna geri döner
        olay log'lanır (rolloverLog'a benzer bir "correctionLog")
    değilse:
        hiçbir şey yapılmaz (buffer zaten "AKIŞTA")
```

Bu mantık `bb84/quantum_phase_buffer.js`'te `QuantumPhaseBuffer` sınıfı
olarak uygulanır — API'si KASITLI OLARAK `EpochResetController`'ın
`record()`/`onEpochRollover` desenine BENZER (proje içi tutarlılık için)
ama yukarıda açıklanan olay-tetiklemeli/eşik-tabanlı farkı KORUR.

## 6. Mevcut simülatöre entegrasyon — ÇEKİRDEĞE DOKUNMADAN

`photonnet_core.js`'in `deriveSiftedKey`'i KANAL fiziğini (kayıp/saçılma,
`propPhoton` üzerinden) modelliyor — KAYNAK/kodlayıcı doğruluğu için bir
parametre YOK (ve olmaması da doğru: bu, çekirdeğin kapsamı DIŞINDA yeni
bir fiziksel katman). Bu yüzden entegrasyon, `bb84/si3n4_pic_link_budget.js`'in
"eşdeğer km" yaklaşımıyla AYNI disiplinle ama farklı bir mekanizmayla
yapılır: **Kuantum Buffer'ın ürettiği "bu darbe TUTULDU/bu darbenin fazı
δ hatalıydı" kararları, Alice'in bit dizisi ÇEKİRDEĞE VERİLMEDEN ÖNCE
uygulanır** — `applyPhaseBufferToBits(bits, bufferLog)` bit dizisini
ÖNCEDEN işler (TUTULAN darbeler diziden ÇIKARILIR — gerçek sistemde
hiç gönderilmemiş olurlardı; hatalı-fazlı ama TUTULMAMIŞ darbeler
P_hata(δ) olasılıkla ÇEVRİLİR), SONRA bu işlenmiş bit dizisi mevcut,
DEĞİŞTİRİLMEMİŞ `QuantumKeyDistribution.deriveSiftedKey`'e verilir. Bu,
`mtls_handshake_qrng_sync.js`'in "entropi kararını TLS'in KENDİSİNE değil
uygulama katmanına bağla" desenindeki AYNI mimari disiplindir.

## 7. Dürüstlük sınırları

- Bu, gerçek bir kapalı-döngü kontrolcünün (PID/Kalman filtresi tabanlı,
  gerçek pilot-ton fotodiyot okumasıyla çalışan) FPGA/ASIC gerçeklemesi
  DEĞİLDİR — bu bir SİMÜLASYON + tampon/karar mantığıdır.
  Gerçek bir sistemde ölçüm gürültüsü, döngü gecikmesi ve DAC
  kuantalanması gibi EK, burada modellenmeyen etkiler vardır.
- `σ` (sürüklenme hızı) ve δ_max dışındaki gerekçelendirilmemiş sabitler
  (Wiener süreci varsayımı dahil) literatürde YAYGIN kullanılan ama
  BU ÇİP için ÖLÇÜLMEMİŞ bir modelleme tercihidir.
- P_hata(δ)=sin²(δ/2) formülü, kayıpsız/ideal bir interferometre
  varsayar — gerçek bir MZI'nin sonlu görünürlüğü (imperfect 50/50
  bölücüler, kutuplanma çapraz-konuşması) EK bir taban-hata terimi
  ekler; bu belge o terimi AYRI, HENÜZ modellenmemiş bir katkı olarak
  bırakır (SI3N4_PIC_DESIGN.md §8'deki "decoy-state modellenmedi"
  notuyla AYNI dürüstlük disiplini).
