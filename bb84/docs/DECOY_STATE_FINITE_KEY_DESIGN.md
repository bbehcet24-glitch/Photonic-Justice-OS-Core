# Sonlu-Boyutlu Decoy İstatistiği — Chernoff Tabanlı Güven Aralıkları

## 0. Bu belge NE'dir, NE DEĞİLDİR (baştan, dürüstçe)

- Bu belge `bb84/docs/DECOY_STATE_PROTOCOL_DESIGN.md`'nin §0/§8'inde AÇIKÇA
  belirtilen şu sınırlamanın devamıdır: *"Sonlu-boyutlu decoy istatistiği
  YOK. Q_μ, Q_ν, E_μ, E_ν burada ... ASİMPTOTİK/tam bilinen değerler gibi
  ele alınır ... bu ek istatistiksel katman burada UYGULANMAMIŞTIR."* Bu
  belge o katmanı ekler.
- **Aşağıdaki Chernoff-tabanlı güven aralığı formülleri (§2) bu oturumda
  SIFIRDAN türetilmiştir** (standart çarpımsal Chernoff sınırlarının
  ATANLIK ters-çevirisiyle) **VE Monte Carlo kapsama (coverage) testiyle
  sayısal olarak doğrulanmıştır** (bkz. §2.3 — 6 farklı (N,p,ε) kombinasyonu,
  100.000-300.000 deneme/kombinasyon). Bu, literatürdeki (Lim, Curty,
  Walenta, Xu, Zbinden, PRA 89, 022307 (2014)) formüllerin BİREBİR
  KOPYASI DEĞİLDİR — o makalenin TAM sabitlerini bu oturumda güvenilir
  şekilde hatırlayabileceğimizden EMİN OLMADIĞIMIZ için (bu, projenin
  "asla doğrulanmamış bir formülü olduğu gibi kullanma" disipliniyle
  TUTARLIDIR), standart ders-kitabı Chernoff-Hoeffding eşitsizliklerinden
  BAĞIMSIZ olarak türetilmiş VE test edilmiş bir sürümdür. Sonuç,
  literatürdeki formüllerden muhtemelen biraz DAHA GEVŞEK (daha az sıkı)
  ama KESİNLİKLE GEÇERLİDİR (bkz. §2.3 — gözlenen ihlal oranı, HER
  durumda hedeflenen ε'den ONLARCA KAT düşük çıktı — güvenli tarafta).
- **`bb84/decoy_state_protocol.js`'e TEK SATIR DOKUNULMAZ.** Bu belgenin
  koduB (`decoy_state_finite_key.js`) o dosyanın `estimateY1Lower` ve
  `estimateE1Upper` fonksiyonlarını DEĞİŞTİRMEDEN, PARAMETRE İKAMESİYLE
  (bkz. §4) yeniden kullanır.
- **Bu, tam bir sonlu-anahtar GÜVENLİK KANITI DEĞİLDİR** — yalnızca
  decoy istatistiklerinin (Q_μ, Q_ν, Y_0, E_ν) KENDİLERİNİN sonlu-örneklem
  güven aralıklarını hesaplar. `QKDSecurityProof.secureKeyLengthWithMu`'nun
  KENDİ sonlu-anahtar Serfling düzeltmesi (n₁ örnekleminin İSTATİSTİKSEL
  dalgalanması) AYRI ve zaten mevcuttur — bu belge SADECE decoy
  istatistiklerinin girdi katmanını düzeltir (bkz. §5, epsilon bütçesi
  birleştirme).

## 1. Problem: neden asimptotik Q/E'ye GÜVENMEK yeterli değil

`DECOY_STATE_PROTOCOL_DESIGN.md`'nin `applyDecoyCorrection`'ı, Q_μ, Q_ν,
E_ν, Y_0'ı **doğrudan ölçülen (asimptotik/tam bilinen) sayılar** gibi
`estimateY1Lower`/`estimateE1Upper`'a verir. Gerçekte bunlar, μ/ν/vakum
yoğunluğunda gönderilen **SONLU** N_μ/N_ν/N_vakum darbeden tahmin
edilir — ve BU tahminlerin KENDİ istatistiksel dalgalanması vardır
(N_k→∞ olmadıkça). Eğer bu dalgalanma yoksayılırsa, `applyDecoyCorrection`'ın
ürettiği "Y₁ alt-sınırı" ARTIK bir alt-sınır DEĞİLDİR — sadece bir NOKTA
TAHMİNİDİR (şans eseri gerçek Y₁'in ÜSTÜNE çıkabilir), ve projenin
fail-closed felsefesiyle (her güvenlik iddiası GERÇEKTEN ε-kesin olmalı)
DOĞRUDAN ÇELİŞİR.

## 2. Chernoff-tabanlı güven aralığı — türetim ve doğrulama

### 2.1 Kurulum

N_k darbe gönderilip n_k'sının algılandığı bir intensitede, n_k
(gözlenen SAYI) Bernoulli(Q_k) toplamıdır — E[n_k] = N_k·Q_k =: λ.
Amaç: **gözlenen n_k'den**, GERÇEK λ'nın (dolayısıyla Q_k=λ/N_k'nın) bir
üst-sınırı (λ⁺) ve alt-sınırı (λ⁻) — her biri en fazla ε başarısızlık
olasılığıyla.

### 2.2 Türetim

Standart çarpımsal Chernoff sınırları (Mitzenmacher & Upfal, *Probability
and Computing*, Thm 4.4-4.5 tarzı, ders-kitabı standardı):

```
alt-kuyruk:  P(X ≤ (1−δ)λ) ≤ exp(−λδ²/2)              , δ∈(0,1)
üst-kuyruk:  P(X ≥ (1+δ)λ) ≤ exp(−λδ²/(2+δ))           , δ>0
```

**λ⁺ türetimi** (alt-kuyruktan — "gerçek λ bu kadar BÜYÜK olsaydı, n_k
kadar AZ bir sayı gözlemlemek ε'den DAHA OLASI OLMAZDI"): (1−δ)λ=n
yerine koyup exponent'i β=ln(1/ε)'e eşitleyip λ için çözünce (ikinci
derece denklem, büyük kök):

```
┌───────────────────────────────────────┐
│  λ⁺(n,ε) = n + β + √(2nβ + β²)          │
└───────────────────────────────────────┘
```

**λ⁻ türetimi** (üst-kuyruktan, benzer şekilde, küçük kök):

```
┌───────────────────────────────────────────┐
│  λ⁻(n,ε) = max(0, n + β/2 − √(2nβ + β²/4)) │
└───────────────────────────────────────────┘
```

(İki türetimin TAM cebirsel adımları oturum notlarında — ikinci derece
denklemin ayrıştırılması + kök seçimi λ⁺≥n, λ⁻≤n özdeşliğiyle
doğrulandı.)

### 2.3 Sayısal doğrulama (Monte Carlo kapsama testi)

Bilinen bir gerçek λ=Np için N deneme Binomiyal(N,p) örneklemesi
BİNLERCE kez tekrarlanıp, her seferinde gözlenen n'den λ⁺/λ⁻ hesaplanıp
"gerçek λ, λ⁺'ı AŞTI mı" / "λ⁻'nin ALTINA indi mi" oranları ölçüldü:

| N | p | hedef ε | deneme | λ⁺ ihlal oranı | λ⁻ ihlal oranı |
|---|---|---|---|---|---|
| 2000 | 0.3 | 0.02 | 100.000 | 0.00036 | 0.00031 |
| 5000 | 0.05 | 0.01 | 100.000 | 0.00070 | 0.00069 |
| 1000 | 0.5 | 0.05 | 100.000 | 0.00028 | 0.00014 |
| 3000 | 0.1 | 0.005 | 300.000 | 0.00019 | 0.00020 |
| Poisson(λ=100) | — | 0.01 | 300.000 | 0.00050 | 0.00016 |
| Poisson(λ=20) | — | 0.02 | 300.000 | 0.00074 | 0.00154 |

**SONUÇ**: TÜM durumlarda gözlenen ihlal oranı, hedeflenen ε'den
**10-100× DAHA DÜŞÜK** — sınırlar GEÇERLİ (güvenli tarafta) ama
literatürün optimize formüllerinden muhtemelen DAHA GEVŞEK (bkz. §0).
Bu, projenin "keyfi bir sabit değil, gerekçelendirilmiş ve DOĞRULANMIŞ"
disipliniyle tutarlı bir dürüstlük ödünleşimidir: SIKILIK yerine
DOĞRULANABİLİRLİK tercih edildi.

## 3. Doğru büyüklüğü bağlamak: n_k VE m_k, AYRI Chernoff uygulamaları

**Bulgunun özeti**: Q_k ve E_k'yi BAĞIMSIZ iki güven aralığıyla
kestirip sonra ÇARPMAK (E_k^U × Q_k^U), gerekmeyen bir SIZINTI/gevşeklik
ekler — çünkü gerçekte decoy formüllerinin ihtiyacı `E_k·Q_k` (ölçülen
TÜM N_k darbe içinde, hem algılanan HEM hatalı olan darbelerin ORANI)
tek bir DOĞRUDAN gözlenen sayıdır: `m_k` (N_k darbe içinde hem algılanan
HEM hatalı olan darbe SAYISI). Bu belgenin tasarımı, Q_k İÇİN `n_k`
(algılanan sayı) ve `E_k·Q_k` İÇİN `m_k`'yı AYRI AYRI (ikisi de N_k
denemeli birer Bernoulli toplamı) Chernoff'a sokar — E_k'nin KENDİ ayrı
bir güven aralığı HİÇ HESAPLANMAZ (gerekmiyor).

## 4. Yön-farkındalıklı (monotonluk-korumalı) worst-case birleştirme

`estimateY1Lower({Qmu,Qnu,mu,nu,Y0})` formülü (`decoy_state_protocol.js`,
DEĞİŞTİRİLMEDEN): `Y1L = (μ/(μν−ν²))·[Qν e^ν − Qμ e^μ(ν/μ)² −
((μ²−ν²)/μ²)Y0]`. Y1L'nin her girdiye göre KISMİ TÜREVİNİN İŞARETİ:

```
∂Y1L/∂Qν > 0  → GÜVENLİ (küçük) Y1L için Qν'nün ALT-SINIRINI kullan
∂Y1L/∂Qμ < 0  → GÜVENLİ (küçük) Y1L için Qμ'nün ÜST-SINIRINI kullan
∂Y1L/∂Y0  < 0  → GÜVENLİ (küçük) Y1L için Y0'ın ÜST-SINIRINI kullan
```

`estimateE1Upper({Enu,Qnu,nu,Y0,e0,Y1Lower})` formülü: `e1U =
(Eν·Qν·e^ν − Y0·e0)/(ν·Y1L)`. Kısmi türevler:

```
∂e1U/∂(EνQν) > 0  → GÜVENLİ (büyük) e1U için (EνQν)'nün ÜST-SINIRINI kullan
∂e1U/∂Y0     < 0  → GÜVENLİ (büyük) e1U için Y0'ın ALT-SINIRINI kullan
```

**GERÇEK BULGU (dikkat gerektiren asimetri)**: Y0, İKİ formülde de
geçiyor ama TERS yönlerde — Y1L için Y0**⁺** (üst), e1U için Y0**⁻**
(alt) GEREKİYOR. Bu, AYNI güven aralığının İKİ UCUNUN da (Y0⁺ VE Y0⁻)
HESAPLANMASI ve HER formülde KENDİ doğru ucunun kullanılması gerektiği
anlamına gelir — "tek bir Y0 nokta-tahmini + tek yönlü pay" gibi
BASİTLEŞTİRİLMİŞ bir yaklaşım burada YANLIŞ sonuç verirdi (ör. e1U için
Y0⁺ kullanmak, e1U'yu YANLIŞLIKLA KÜÇÜK/tehlikeli gösterirdi).

## 5. Epsilon bütçesi — UNION BOUND ile birleştirme

Y1LowerFinite, ÜÇ bağımsız Chernoff uygulaması (Q_μ⁺, Q_ν⁻, Y0⁺) kullanır
— her biri kendi ε/3 payıyla. e1UpperFinite, İKİ bağımsız uygulama daha
kullanır ((EνQν)⁺, Y0⁻) — her biri kendi ε/5 payıyla (TOPLAM 5 pay,
Y1LowerFinite'ın ÜÇÜ + e1UpperFinite'ın İKİSİ — Y0⁺ ile Y0⁻ AYNI ölçümün
İKİ AYRI ucu olduğundan İKİ AYRI Chernoff uygulaması SAYILIR, tek bir pay
DEĞİL). Union bound (olasılık teorisinin temel eşitsizliği, P(A∪B)≤P(A)+P(B)):
BEŞ bağımsız olayın (her biri ≤ε/5 başarısızlık payıyla) HİÇBİRİNİN
başarısız OLMAMA olasılığı ≥ 1−5·(ε/5) = 1−ε. Yani **tüm decoy finite-key
katmanının toplam başarısızlık payı = epsPE (kullanıcının verdiği TEK
parametre)** — 5'e bölünüp her Chernoff uygulamasına eşit dağıtılır.

**GERÇEK BULGU/EKSİKLİK (önceki tasarımın flag ETTİĞİ ama düzeltmediği
nokta)**: `DECOY_STATE_PROTOCOL_DESIGN.md`'nin `applyDecoyCorrection`'ı,
bu epsPE payını `core.QKDSecurityProof.secureKeyLengthWithMu`'nun KENDİ
epsPE'siyle (Serfling düzeltmesi için) TOPLAMIYOR DEĞİLDİ — iki AYRI ε
kaynağı (decoy istatistiği ε'si + sonlu-anahtar Serfling ε'si) sanki
BAĞIMSIZ/ilişkisizmiş gibi ele alınıyordu. Bu belgenin
`combinedSecurityEpsilon()` yardımcı fonksiyonu, İKİSİNİ union-bound ile
TOPLAR — TOPLAM güvenlik iddiasının GERÇEKTEN iddia ettiği ε'yi
sağlaması için (bkz. §7).

## 6. Sayısal uçtan-uca doğrulama planı

`decoy_state_protocol.js`'in `simulateIntensity()`'si (DEĞİŞTİRİLMEDEN,
zaten mevcut) ile GERÇEK bir GYS-kanalı simüle edilip (BİLİNEN gerçek
Y1, e1 ile), tüm boru hattı (finite n_k/m_k → Chernoff sınırları →
Y1LowerFinite/e1UpperFinite) YÜZLERCE kez tekrarlanarak:

```
P(Y1LowerFinite > gerçek Y1)  ≤  epsPE   (deneysel olarak ÖLÇÜLECEK)
P(e1UpperFinite < gerçek e1)  ≤  epsPE   (deneysel olarak ÖLÇÜLECEK)
```

Bkz. `chaos_decoy_state_finite_key_test.js` — bu, `decoy_state_protocol.js`'in
Test 4'ünün (asimptotik Y1L/e1U geçerliliği) SONLU-ÖRNEKLEM analoğudur.

## 7. Uygulama — `bb84/decoy_state_finite_key.js`

- `chernoffLambdaUpper(n, epsilon)`, `chernoffLambdaLower(n, epsilon)` — §2.
- `finiteRateBounds({ count, pulses, epsilon })` → {lower, upper} (Q_k
  VEYA E_k·Q_k için — aynı genel Bernoulli-oranı fonksiyonu, hangi SAYIM
  verildiğine göre).
- `estimateY1LowerFinite({ mu, nu, muRun, nuRun, vacRun, epsPE })` —
  `decoy_state_protocol.estimateY1Lower`'ı YÖN-FARKINDALIKLI sınırlarla
  ÇAĞIRIR (DEĞİŞTİRMEZ).
- `estimateE1UpperFinite({ nu, nuRun, vacRun, epsPE, Y1LowerFinite })` —
  `decoy_state_protocol.estimateE1Upper`'ı `Enu=1, Qnu=(EνQν)⁺` PARAMETRE
  İKAMESİYLE (bkz. §4, kod yorumunda AÇIKÇA belgelendi) ÇAĞIRIR.
- `combinedSecurityEpsilon({ decoyEpsPE, coreEpsPE, epsCor, epsPA })` —
  §5'in union-bound toplamı.

## 8. Dürüstlük sınırları (açık, somut)

- **Formüller literatürün TAM optimize sabitleriyle EŞLEŞMEYEBİLİR** —
  bkz. §0/§2.3: kendi türetilmiş, sayısal doğrulanmış ama muhtemelen
  DAHA GEVŞEK bir sürüm.
- **N_μ/N_ν/N_vakum arasında darbe TAHSİSİ OPTİMİZE EDİLMEDİ** — gerçek
  decoy-state literatürü (Lim et al. dahil), toplam darbe bütçesi
  sabitken hangi intensiteye kaç darbe ayrılacağının OPTİMİZASYONUNU da
  içerir (ör. ν'ye daha AZ darbe, μ'ye daha ÇOK) — bu belge bunu YAPMAZ,
  kullanıcı N_k'leri KENDİSİ verir.
- **Koherent/aktif saldırılara karşı ek bir güvenlik terimi YOK** — bu
  belge SADECE İSTATİSTİKSEL (sonlu-örneklem) belirsizliği ele alır,
  DECOY_STATE_PROTOCOL_DESIGN.md §8'in diğer sınırlamaları (adaptif Eve,
  vs.) HALA GEÇERLİDİR.
- **Intensite-bağımlı darbe SAYISI DALGALANMASI (Poisson kaynak
  tetikleme jitter'ı, ör. gerçek bir lazer TAM OLARAK N_k darbe
  üretmeyebilir) MODELLENMEDİ** — N_k'nin KENDİSİ sabit/bilinen kabul
  edilir.
