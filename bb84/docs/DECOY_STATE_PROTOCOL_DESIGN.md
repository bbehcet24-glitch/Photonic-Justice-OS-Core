# Decoy-State Protokolü — Poisson Çoklu-Foton Riskine Karşı Matematiksel Model

## 0. Bu belge NE'dir, NE DEĞİLDİR (baştan, dürüstçe)

- Bu belge, **`bb84/docs/SI3N4_PIC_DESIGN.md` §8** ve **`bb84/docs/
  QUANTUM_PHASE_BUFFER_DESIGN.md`**'de AÇIKÇA belirtilen şu sınırlamanın
  doğrudan devamıdır: *"Weak-coherent-pulse (WCP) çoklu-foton istatistiği
  mevcut simülatörde MODELLENMİYOR ... GERÇEK bir sahada bu, decoy-state
  protokolü GEREKTİRİR ... bu belge decoy-state protokolünü UYGULAMAZ —
  bu, AÇIKÇA belirtilen bir sonraki adımdır."* Bu belge o adımı atar.
- Aşağıdaki **Y₁ alt-sınırı** ve **e₁ üst-sınırı** formülleri literatürde
  standarttır (Lo, Ma, Chen, *"Decoy State Quantum Key Distribution"*,
  PRL 94, 230504 (2005); Ma, Qi, Zhao, Lo, PRA 72, 012326 (2005)) — bu
  belgede **sıfırdan yeniden türetilmiş** (aşağıda §4) VE **4 farklı
  parametre kümesiyle sayısal olarak doğrulanmıştır** (bkz. §7,
  `chaos_decoy_state_protocol_test.js`), literatürden kopyalanıp
  doğrulanmadan kullanılmamıştır.
- **GERÇEK bir foundry/deneysel WCP kaynağı YOK.** Kanal modeli (§5)
  literatür-tipik ("GYS-tipi", Gobby-Yuan-Shields 2004 tarzı) parametre
  ARALIKLarıdır — ölçülmüş donanım verisi DEĞİLDİR. Bu, `si3n4_pic_link_
  budget.js`'deki aynı dürüstlük ilkesinin (varsayılan + kabul edilebilir
  aralık, her ikisi de belgelenmiş) tekrarıdır.
- **Bu belge, `bb84/photonnet_core.js`'e TEK SATIR DOKUNMAZ.** Ama
  `SI3N4_PIC_DESIGN.md`/`QUANTUM_PHASE_BUFFER_DESIGN.md`'nin aksine, bu
  tasarımda ÇEKİRDEKTE GERÇEKTEN VAR OLAN bir entegrasyon noktası bulundu
  (bkz. §6) — `QKDSecurityProof.secureKeyLengthWithMu`'nun `opts.
  realLeakEC` ile ZATEN desteklediği "teorik tahmin yerine GERÇEK ölçülmüş
  değer" deseninin BİREBİR AYNISI, burada n/qBit için uygulanıyor. Bu,
  önceki iki tasarımdaki "eşdeğer km" enjeksiyonundan DAHA DOĞRUDAN bir
  entegrasyondur çünkü çekirdek zaten bu ESNEKLİĞİ (genişletilebilirliği)
  taşıyordu.
- **Ne YAPILMIYOR** (açık liste, §8'de detaylandırılır): sonlu-boyutlu
  decoy istatistiği (Qμ/Qν/Eμ/Eν'nin KENDİLERİNİN ölçüm-örneklem
  dalgalanması — bu belge onları ASİMPTOTİK/tam bilinen değerler gibi
  kullanır); genel koherent saldırılara karşı tam güvenlik kanıtı (GLLP
  formülü kullanılır ama yeniden kanıtlanmaz); kaynak kusurları (faz
  ilintili emisyon, vs.); PNS DIŞINDA saldırı sınıfları.

## 1. Bağlam: neden bu belge şimdi gerekli

`SI3N4_PIC_DESIGN.md` (VOA ile μ ayarı, §4/§8) ve `QUANTUM_PHASE_BUFFER_
DESIGN.md` (termo-optik faz kaydırıcının kararlılığı) birlikte, çipin
kaynağını ve faz kodlamasını fiziksel olarak gerçekçi hale getirdi — ama
her iki belge de kaynağın ÜRETTİĞİ ışığın **foton SAYISI istatistiğini**
modellemeden bıraktı. `bb84/photonnet_core.js`'in `propPhoton`/
`deriveSiftedKey`'i her "gönderilen bit"i **tam olarak bir foton**
taşıyormuş gibi simüle eder (bkz. çekirdeğin kendi QBER/kayıp modeli —
foton SAYISI hiçbir yerde parametre değildir). Gerçek bir WCP kaynağı
(lazer + VOA) bunun aksine **Poisson-dağılımlı** bir foton sayısı üretir
— ve bu, protokolün güvenliğini GERÇEKTEN tehdit eden bir açık bırakır
(Photon-Number-Splitting saldırısı, §2).

## 2. Problem: Poisson çoklu-foton riski ve PNS saldırısı

Zayıf-tutarlı-darbe (WCP) kaynağı, ortalama foton sayısı μ olan bir
darbe başına, gerçek foton sayısı n için

```
P(n | μ) = e^(−μ) μⁿ / n!            (Poisson olasılık dağılım fonksiyonu)
```

olasılığıyla n foton üretir. Tipik QKD işletim noktası μ ≈ 0.1–0.5
olsa da, P(n≥2|μ) **sıfır değildir** (μ=0.5 için ≈%9, μ=0.1 için ≈%0.5)
— ve tam da bu çoklu-foton darbeleri, tek-foton varsayımını (BB84'ün
güvenlik kanıtının temel dayanağı: "bir kübiti klonlamak imkânsız")
delen bir yan kapı açar.

**Photon-Number-Splitting (PNS) saldırısı**: Eve, kanal üzerinde
foton-sayısı-olmayan-bozan (quantum non-demolition, QND) bir ölçümle bir
darbenin n≥2 foton taşıdığını GİZLİCE tespit eder, bir fotonu çalıp
saklar/ölçer (Alice'in temeli açıklanınca doğru sonucu okur), kalan
n−1 fotonu ise **kayıpsız bir kanalda** Bob'a iletir — böylece (a) Bob
hâlâ bir click alır (görünürde normal), (b) hiçbir ek hata eklenmez
(Eve'in müdahalesi Bob'un ölçtüğü foton(lar)ı BOZMAZ, çünkü Eve fazladan
kopyayı çalar, kalanı dokunmadan geçirir), (c) Eve mesaj sonunda tam bit
bilgisini elde eder. **Tek-foton (n=1) darbeler bu saldırıya karşı
BAĞIŞIKTIR** (klonlanacak "fazladan" foton yok) — bu yüzden savunma,
anahtarın GÜVENLİ kısmını n=1 darbelerden gelen bitlerle SINIRLAMAK
üzerine kuruludur.

**Sorunun özeti**: mevcut çekirdeğin `QKDSecurityProof.
secureKeyLengthWithMu(n, qBit, mu, opts)` fonksiyonu, sifted anahtarın
TÜMÜNÜ (n bit) — n=1 VE n≥2 darbelerden gelen bitleri AYIRMADAN — güvenli
sayar (bkz. §6). Eve'in PNS saldırısı altında bu, **YANLIŞ bir "güvenli"
sonucu** üretebilir (bkz. §7 "naif vs decoy-düzeltilmiş" testi) — çünkü
düşük genel QBER, aslında çoğu bitin Eve'in TAM BİLDİĞİ çoklu-foton
darbelerden geldiği gerçeğini gizleyebilir.

## 3. Savunma: Decoy-State (vakum + zayıf-decoy) protokolü

Fikir (Hwang 2003; Lo-Ma-Chen 2005): Alice, VOA'sını (bkz.
`si3n4_pic_link_budget.js`'deki `meanPhotonNumberToVoaDb`) her darbe
için **rastgele** birkaç farklı ortalama-foton-sayısı ayarından birine
çevirir — burada **üç seviye** kullanılır:

- **Sinyal (μ)**: gerçek anahtar üretimi için asıl yoğunluk (tipik 0.3–0.6).
- **Zayıf-decoy (ν)**: μ'den daha düşük bir yoğunluk (0 < ν < μ).
- **Vakum (0)**: kaynak KAPALI — hiç foton gönderilmez.

Hangi darbenin hangi yoğunlukta gönderildiği **Bob'un ölçümünden SONRA**
(sifting'le birlikte) açık kanalda AÇIKLANIR — Eve saldırısını darbe
GÖNDERİLMEDEN ÖNCE hangi yoğunlukta olduğunu bilmeden yapmak ZORUNDADIR
(aksi hâlde decoy'un anlamı kalmaz). Eve'in saldırısı **foton SAYISINA**
bağlı olabilir ama (fiziksel olarak) **hangi yoğunluk ayarından
geldiğine** bağlı OLAMAZ — çünkü bu bilgi darbe yayılırken Eve'e HENÜZ
açıklanmamıştır. Bu, aşağıdaki türetimin temel varsayımıdır: **Y_n
(n-foton verimi) ve e_n (n-foton hata oranı) yoğunluk ayarından
BAĞIMSIZDIR** — sadece gerçek foton sayısı n'e bağlıdır.

Alice, μ ve ν darbeleri için ayrı ayrı ölçülen **kazanç (gain)**
Q_μ, Q_ν ve **QBER** E_μ, E_ν'den (vakum darbeleri için sadece Q₀=Y₀
— karanlık-sayım/arka-plan verimi, doğrudan ölçülür) tek-foton
bileşenini (Y₁, e₁) İSTATİSTİKSEL OLARAK KESTİRİR — foton sayısını
TEK TEK ÖLÇMEDEN (bu fiziksel olarak imkânsızdır — foton-sayısı-çözen
detektörler bu simülasyonun kapsamı DIŞINDADIR, bkz. §8).

## 4. Matematiksel türetim

Poisson ağırlıklı kazanç toplamı (her yoğunluk k için):

```
Q_k · e^k =: f(k) = Σ_{n=0}^∞ (kⁿ/n!) · Y_n            (★)
```

(Q_k = Σ_n P(n|k)·Y_n = e^(−k) Σ_n (kⁿ/n!)Y_n olduğundan, e^k ile
çarpınca e^(−k)·e^k=1 sadeleşir — f(k) tanımı budur.)

### 4.1 Y₁ alt-sınırı

`ν²·f(μ) − μ²·f(ν)` kombinasyonunu (★) ile açalım:

```
ν²f(μ) − μ²f(ν) = Σ_n (Y_n/n!)·[ν²μⁿ − μ²νⁿ]
```

Terim terim:
- **n=0**: Y₀·(ν² − μ²)
- **n=1**: Y₁·(ν²μ − μ²ν) = Y₁·μν·(ν − μ)
- **n=2**: (Y₂/2)·(ν²μ² − μ²ν²) = **0** (tam sadeleşir)
- **n≥3**: ν²μⁿ − μ²νⁿ = μ²ν²·(μ^(n−2) − ν^(n−2)); μ>ν>0 ve n−2≥1 için
  μ^(n−2) > ν^(n−2), yani bu terim **≥ 0** (Y_n≥0 olduğundan).

Yani: `ν²f(μ) − μ²f(ν) = Y₀(ν²−μ²) + Y₁μν(ν−μ) + (n≥3 terimleri, ≥0)`.

n≥3 terimlerini (≥0 olduklarından) ATIP bir EŞİTSİZLİK elde ederiz —
sağ tarafı BÜYÜTEREK (çünkü onları düşürmek RHS'yi büyütür, bu da Y₁
için bir ALT sınır — değil üst — verir; işaretleri dikkatle takip
etmek gerekir, bkz. aşağıdaki bölme adımı):

```
ν²f(μ) − μ²f(ν)  ≤  Y₀(ν²−μ²) + Y₁μν(ν−μ)
```

`μν(ν−μ)` NEGATİFTİR (μ>ν>0 olduğundan ν−μ<0) — eşitsizliği bu negatif
sayıya bölerken YÖN DEĞİŞİR:

```
Y₁  ≥  [ν²f(μ) − μ²f(ν) − Y₀(ν²−μ²)] / [μν(ν−μ)]
    =  [μ²f(ν) − ν²f(μ) − Y₀(μ²−ν²)] / [μν(μ−ν)]        (pay/payda ×(−1))
```

Bunu `μ/(μν−ν²) = μ/(ν(μ−ν))` ortak çarpanıyla yeniden yazarsak (μν−ν²
= ν(μ−ν) olduğundan):

```
┌─────────────────────────────────────────────────────────────────┐
│  Y₁^L = (μ / (μν − ν²)) · [ Q_ν e^ν − Q_μ e^μ (ν/μ)²             │
│              − ((μ² − ν²)/μ²) · Y₀ ]                             │
└─────────────────────────────────────────────────────────────────┘
```

(f(ν)=Q_ν e^ν, f(μ)=Q_μ e^μ yerine yazıldı.) Bu, literatürde (Lo-Ma-
Chen 2005; Ma-Qi-Zhao-Lo 2005) standart olarak verilen formüldür —
burada bağımsız olarak yeniden türetildi ve §7'de 4 farklı parametre
kümesiyle sayısal doğrulandı (Y₁^L ≤ gerçek Y₁, her zaman — bkz.
`verify_decoy_math.js` çalıştırma kaydı, oturum notları).

### 4.2 e₁ üst-sınırı

Benzer şekilde, ν yoğunluğundaki gözlenen hata katkısı:

```
E_ν · Q_ν · e^ν = Σ_n (νⁿ/n!)·e_n·Y_n  ≥  e₀Y₀ + e₁Y₁ν
```

(n≥2 terimleri e_n,Y_n≥0 olduğundan ATILDI — bu bir ALT sınır verir,
yani e₁ için bir ÜST sınır çıkarmak üzere kullanılabilir):

```
e₁  ≤  (E_ν Q_ν e^ν − e₀Y₀) / (Y₁·ν)
```

Burada GERÇEK Y₁ yerine (bilinmeyen) Y₁^L (bilinen alt sınır) kullanmak
— Y₁^L ≤ Y₁ olduğundan, daha KÜÇÜK bir sayıya bölmek sonucu BÜYÜTÜR —
yani daha KÖTÜMSER (güvenli tarafta) bir üst sınır verir:

```
┌─────────────────────────────────────────────┐
│  e₁^U = (E_ν Q_ν e^ν − Y₀·e₀) / (ν · Y₁^L)   │
└─────────────────────────────────────────────┘
```

(e₀ = 0.5, karanlık-sayım/arka-plan tıklamalarının rastgele/temelsiz
olduğu geleneksel varsayımı — literatür standardı.)

### 4.3 GLLP güvenli anahtar oranı (asimptotik, referans amaçlı)

Standart GLLP (Gottesman-Lo-Lütkenhaus-Preskill 2004) formülü,
tek-foton bileşeni ayrıştırıldığında:

```
R ≥ q · [ −Q_μ · f_EC(E_μ) · H₂(E_μ)  +  Q₁^L · (1 − H₂(e₁^U)) ]

  q = 1/2 (BB84 temel-uyuşma verimliliği)
  Q₁^L = μ·e^(−μ)·Y₁^L   (tek-foton darbelerin Poisson-ağırlıklı payı)
  H₂(x) = ikili Shannon entropisi (= çekirdeğin QKDSecurityProof.h2 —
          bkz. §6, bu belge FORMÜLÜ TEKRARLAMAZ, ÇAĞIRIR)
  f_EC ≈ 1.16 (Cascade tipi verimsizlik — çekirdekle AYNI varsayılan)
```

Bu formül **bu belgede** yalnızca referans/karşılaştırma amaçlı
(`secureKeyRateLowerBound`, standalone) olarak uygulanır — GERÇEK
entegrasyon (§6) çekirdeğin KENDİ `secureKeyLengthWithMu`'sunu (sonlu-
boyutlu Serfling düzeltmesiyle) DÜZELTİLMİŞ (n₁, e₁^U) girdileriyle
çağırır, bu formülü YENİDEN UYGULAMAZ.

## 5. Kanal modeli (simülasyon/doğrulama için — GYS-tipi)

Literatürde standart, foton-sayısına-bağlı kayıp+gürültü modeli
(Gobby-Yuan-Shields, Appl. Phys. Lett. 84, 3762 (2004) tarzı):

```
Y_n = 1 − (1 − Y₀)·(1 − η)ⁿ                              (n-foton verimi)
e_n = [ e₀·Y₀ + e_detector·(1 − (1 − η)ⁿ) ] / Y_n         (n-foton hata oranı)
```

- **Y₀**: karanlık-sayım/arka-plan verimi (vakum darbesi başına click
  olasılığı) — literatür-tipik 10⁻⁶–10⁻⁴ (bkz. `DEFAULTS`/`PARAM_
  RANGES`, aşağıda kodda).
- **η**: kanal+detektör TOPLAM iletim olasılığı (fiber kaybı × detektör
  verimliliği) — SI3N4_PIC_DESIGN.md'deki `si3n4LinkBudget`/
  `equivalentExtraKm` ile AYNI fiziksel büyüklüğün (toplam kayıp) farklı
  bir görünümüdür, ama bu belgede AYRI bir parametre olarak tutulur
  (fiber-km'den η'ya çevirmek — η=10^(−toplamKayıpDb/10) — kullanıcıya
  bırakılmıştır, bkz. §8 "entegre EDİLMEDİ" notu).
- **e_detector**: detektörün içsel hizalama hatası (tipik %1-3).
- **e₀ = 0.5**: karanlık sayımların temelsiz/rastgele olduğu varsayımı.

n=0'da Y₀ıdoğrudan çıkar (Y_n formülünde (1-η)⁰=1 ⇒ Y_0=Y₀ ✓) ve e_0
formülde e₀ olarak sadeleşir (Y_n=Y₀ ⇒ e_n=[e₀Y₀+0]/Y₀=e₀ ✓) — kod
testinde bu iki özdeşlik doğrudan kontrol edilir.

### 5.1 PNS-saldırı KÖTÜ-DURUM modeli (illüstratif)

Decoy-state'in NEDEN sadece "faydalı" değil "GEREKLİ" olduğunu
göstermek için, literatürün klasik motivasyon argümanını (GLLP 2004,
§"Why decoy states are necessary") kullanıyoruz — Eve'in TEORİK olarak
mümkün en kötü stratejisi:

```
Y_n^PNS = { Y₀           n = 0   (Eve vakuma dokunamaz)
          { 0            n = 1   (TÜM tek-foton darbeler BLOKE edilir)
          { 1            n ≥ 2   (TÜM çoklu-foton darbeler KAYIPSIZ iletilir)

e_n^PNS = { e₀           n = 0
          { — (tanımsız, Y=0 → hiç katkı yok)   n = 1
          { e_detector   n ≥ 2   (Eve müdahale ETMEDEN geçirir — hata eklemez)
```

**Dürüstlük notu**: bu, Eve'in GERÇEKTE uygulayabileceği EN GENEL
strateji değildir (adaptif/koherent saldırılar daha karmaşık olabilir)
— bu, GLLP'nin kendisinin decoy-state'i MOTİVE ETMEK için kullandığı,
literatürde İYİ BİLİNEN bir "worst-case" referans modelidir; bu belge
bunu YENİDEN İCAT ETMEZ, uygular ve test eder (bkz. §7).

## 6. Mevcut çekirdeğe entegrasyon — ÇEKİRDEĞE DOKUNMADAN

**Bulgunun özeti**: `QKDSecurityProof.secureKeyLengthWithMu(n, qBit, mu,
opts)` çekirdekte ZATEN şu deseni destekliyor (bkz. `photonnet_core.js`
satır ~1603-1638, `opts.realLeakEC`): *"teorik bir tahmin yerine GERÇEK
ölçülmüş bir değer verilirse, o kullanılır."* Bu desen ŞU ANA KADAR
sadece `leakEC` (hata-düzeltme sızıntısı, Cascade/LDPC entegrasyonuyla)
için kullanılıyordu. **Bu belge AYNI deseni n VE qBit girdileri için
uygular** — decoy-state'in ürettiği (n₁, e₁^U) çiftini, çekirdeğin
`ProductionSecurityAudit.audit()`'inin doğrudan sifted-key uzunluğu/QBER
ölçümü yerine GEÇİRİR:

```
naif   : secureKeyLengthWithMu(n_toplam,      qBit_toplam,  μ_serfling(n_toplam), opts)
decoy  : secureKeyLengthWithMu(n₁_kestirimi,  e₁^U,         μ_serfling(n₁),       opts)
```

**n₁ kestirimi**: μ yoğunluğunda gönderilip sifted olan n_toplam bitin
KAÇI gerçekten tek-foton darbelerden geldi?

```
Q₁^L = μ·e^(−μ)·Y₁^L          (tek-foton darbelerin Poisson-ağırlıklı kazancı)
n₁   = round( n_toplam · Q₁^L / Q_μ )     (Q_μ = μ yoğunluğunda GERÇEK ölçülen toplam kazanç)
```

**Neden bu, `equivalentExtraKm` paterninden (Si₃N₄/Kuantum Buffer
tasarımlarında kullanılan) DAHA DOĞRUDAN bir entegrasyon**: o iki
tasarımda yeni bir fiziksel etki (sabit dB kaybı, faz sürüklenmesi),
çekirdeğin `totalKm` PARAMETRESİNE eşdeğer bir değer olarak enjekte
ediliyordu — çekirdek bu ENJEKSİYONUN farkında değildi, sadece "daha
uzun bir fiber" görüyordu. Burada ise çekirdek zaten (leakEC için)
"harici olarak hesaplanmış GERÇEK bir değer, teorik tahminin YERİNE
geçebilir" arayüzünü taşıyor — bu belge sadece bu AÇIK genişletme
noktasını n/qBit'e de uyguluyor. `poissonSample` (çekirdeğin kendi dark-
count kalibrasyon fonksiyonu, satır ~528) da doğrudan tekrar kullanılır
(Monte Carlo simülasyonunda foton-sayısı örneklemek için) — YENİDEN
UYGULANMAZ.

**Dürüstlük notu (gerçek sınır)**: `propPhoton`/`deriveSiftedKey`'in
KENDİSİ tek-foton varsayımıyla çalıştığından, "μ yoğunluğunda GERÇEKTEN
gönderilmiş bir çekirdek koşusu"ndan n₁/n_toplam ayrımını GERÇEKTEN
ÖLÇMEK mümkün DEĞİLDİR — bu değerler, §5'teki BAĞIMSIZ WCP kanal
modeliyle simüle edilir (bkz. `simulateIntensity`, ayrı bir Monte Carlo,
`propPhoton`'ı ÇAĞIRMAZ). Entegrasyon noktası (yukarıdaki kod bloğu)
GERÇEKTİR ve çalıştırılabilir haldedir (bkz. §7, `applyDecoyCorrection`)
— ama besleyen veri (n₁, e₁^U) şu an için AYRI bir simülasyondan gelir,
çekirdeğin TEK bir `transmit()` çağrısından DEĞİL. Bunu tam olarak
birleştirmek (`propPhoton`'a foton-sayısı parametresi eklemek) ÇEKİRDEĞE
DOKUNMAYI gerektirir — bu, bu tasarımın KASITLI OLARAK yapmadığı şeydir
(bkz. §8).

## 7. Uygulama ve test planı

- `bb84/decoy_state_protocol.js`: `poissonPmf`, `channelYield`/
  `channelError` (GYS), `pnsWorstCaseYield`/`pnsWorstCaseError`,
  `theoreticalGainAndQber` (analitik/kesinlik referansı), 
  `simulateIntensity` (Monte Carlo — `core.poissonSample` + 
  `core.mulberry32` yeniden kullanır), `estimateY1Lower`,
  `estimateE1Upper`, `binaryEntropy` (bağımsız/çekirdeksiz referans —
  teste `core.QKDSecurityProof.h2` ile bit-bit karşılaştırılır),
  `secureKeyRateLowerBound` (§4.3, standalone referans),
  `naiveSecurityAudit` ve `applyDecoyCorrection` (§6'nın GERÇEK
  entegrasyon çağrıları — `core.QKDSecurityProof.secureKeyLengthWithMu`'yu
  ÇAĞIRIR, yeniden uygulamaz).
- `bb84/chaos_decoy_state_protocol_test.js`: (1) Poisson pmf toplamı=1
  ve bilinen değerlerle eşleşme; (2) Y_n/e_n formüllerinin n=0'da
  sadeleşme özdeşlikleri; (3) Monte Carlo'nun analitik `Q,E`'ye
  yakınsaması (büyük örneklem); (4) Y₁^L≤gerçekY₁ VE e₁^U≥gerçekE₁
  — GYS normal kanalında, ÇOK sayıda rastgele parametre kümesiyle;
  (5) `binaryEntropy` ile `core.QKDSecurityProof.h2`'nin bit-bit
  eşleşmesi; (6) `applyDecoyCorrection`'ın GERÇEKTEN
  `core.QKDSecurityProof.secureKeyLengthWithMu`'yu doğru girdilerle
  çağırdığının doğrulanması; (7) **PNS kötü-durum gösterimi**: naif
  denetim POZİTİF (yanlışlıkla "güvenli") bir ℓ üretirken,
  decoy-düzeltilmiş denetimin Y₁^L≈0 ⇒ n₁≈0 ⇒ "güvenli anahtar YOK"
  sonucuna ulaştığını GERÇEKTEN çalıştırıp göstermek; (8) çekirdek
  SHA-256'sının değişmediğinin doğrulanması.

## 8. Dürüstlük sınırları (açık, somut)

- **Sonlu-boyutlu decoy istatistiği YOK.** Q_μ, Q_ν, E_μ, E_ν burada
  (büyük örneklemli Monte Carlo dışında) ASİMPTOTİK/tam bilinen
  değerler gibi ele alınır — gerçek bir sonlu-veri protokolünde bu dört
  ölçümün KENDİSİ de bir güven aralığı taşır (bkz. Lim, Curty, Walenta,
  Xu, Zbinden, PRA 89, 022307 (2014) "finite-key decoy-state QKD") —
  bu ek istatistiksel katman burada UYGULANMAMIŞTIR.
- **`propPhoton`/`deriveSiftedKey` ile TAM birleşme YOK** — §6'da
  açıklandığı gibi, decoy istatistikleri AYRI bir Monte Carlo
  simülasyonundan gelir, çekirdeğin gerçek `transmit()` akışından
  otomatik ÇIKARILMAZ. Entegrasyon noktası (`secureKeyLengthWithMu`'ya
  düzeltilmiş girdi) GERÇEK ve ÇALIŞIR durumdadır; besleyen veri
  simülasyondandır.
- **PNS kötü-durum modeli illüstratiftir** (bkz. §5.1) — genel
  koherent/adaptif saldırı sınıfının TAMAMINI KAPSAMAZ; GLLP formülünün
  GÜVENLİK KANITI burada yeniden yapılmaz, yalnızca (bağımsız
  doğrulanmış) SONUÇ formülü kullanılır.
- **η (kanal iletimi) ile Si₃N₄/fiber km arasında OTOMATİK dönüşüm
  YOK** — kullanıcı η'yi kendisi (toplam-dB'den 10^(−dB/10) ile)
  hesaplayıp vermelidir; `si3n4_pic_link_budget.js` ile doğrudan
  birleştirme YAPILMAMIŞTIR (bu, gelecekteki bir adım olarak AÇIKÇA
  bırakılmıştır, önceki iki belgenin izlediği dürüstlük deseniyle
  tutarlı).
- **Kanal parametreleri (Y₀, η, e_detector) literatür-tipik
  ARALIKLARdır, ölçülmüş DEĞİLDİR** — bkz. §0.
