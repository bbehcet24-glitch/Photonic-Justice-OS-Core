# Çip-üstü Si₃N₄ Fotonik Entegre Devre (PIC) Tasarımı — fiziksel kablo sınırlarını aşmak

## 0. Bu belge NE'dir, NE DEĞİLDİR (baştan, dürüstçe)

Bu bir **mimari + fizik-düzeyinde parametrik tasarım**dır: gerçek bir foundry'ye
(LioniX/TriPleX, imec, AMF, Ligentec, AIM Photonics vb.) gönderilebilecek bir
GDSII layout dosyası, bir PDK (Process Design Kit) çıktısı veya bir tape-out
paketi **DEĞİLDİR**. Bu sandbox'ta ne bir fotonik tasarım aracı (Lumerical,
Ansys/Tidy3D, KLayout+PDK) ne de gerçek bir fabrikasyon süreci mevcut — bu
yüzden burada üretilen sayılar (kayıp bütçesi, faz kaydırıcı gücü vb.)
**literatürde yaygın olarak raporlanan, foundry-tipik değer ARALIKLARINDAN**
türetilmiştir, belirli bir foundry'nin ÖLÇÜLMÜŞ karakterizasyon verisi
DEĞİLDİR. Gerçek üretim kararı için bir foundry'nin PDK'sındaki GERÇEK
ölçülmüş kayıp/coupling/Vπ değerleri kullanılmalı ve bir MPW (Multi-Project
Wafer) koşusuyla doğrulanmalıdır — bu belge o sürecin **başlangıç noktası**
(mimari + gerçekçi bir bütçe hesaplayıcısı), sonu değil.

Bu, `bb84/docs/QRNG_HARDWARE_INTEGRATION.md`'nin kurduğu AYNI disipline
uyar: gerçek donanım burada YOK, ama seam/arayüz tasarımı ve doğrulanabilir
bir model VAR — donanım geldiğinde tek değişen, aynı arayüzün arkasındaki
sabitler olacak.

Çekirdeğe (`bb84/photonnet_core.js`) bu çalışmanın HİÇBİR adımında
dokunulmadı — bkz. §7.

## 1. Problem: fiber kablonun fiziksel sınırları

PhotonNet'in mevcut fiziksel katmanı (`WL`/`fiberT`, `propPhoton`) saf fiber
optik iletimi modelliyor — bu, gerçek bir QKD dağıtımında şu somut kısıtları
beraberinde getirir:

- **Konnektör/ek noktası kaybı**: her fiber-fiber veya fiber-ekipman bağlantısı
  tipik olarak 0.3–0.5 dB ek kayıp getirir; saha kurulumunda düzinelerce böyle
  nokta birikebilir.
- **Mekanik kırılganlık + hizalama driftı**: sıcaklık/gerinim, polarizasyon
  durumunu (ve zamanla hizalamayı) kayırır — laboratuvar dışı sahada sürekli
  yeniden kalibrasyon gerektirir.
- **Boyut/ağırlık/güç**: kesik-ayrık optik bankı (lazer + modülatör + dedektör
  + polarizasyon kontrolörü, hepsi ayrı kutu/fiber-jumper'larla bağlı) uydu
  yükü, mobil düğüm veya veri-merkezi-içi yoğun dağıtım için pratik değil.
- **Tekil arıza noktası + maliyet**: saha fiberi döşemek/onarmak pahalı ve
  yavaş; bir kesik tüm bağlantıyı düşürür.
- **Ölçeklenmezlik**: N-düğümlü bir ağda her düğüm çifti için ayrı optik bank
  gerektirmek, `NetworkTopology`/`routeCalculation`'ın zaten simüle ettiği
  çok-düğümlü mesh topolojisini fiziksel olarak pahalılaştırır.

Bunların HİÇBİRİ "fiber kaybı fazla" gibi tek boyutlu bir sorun değil —
asıl sorun **ayrık-bileşen optik bankının kendisi**. Çözüm, Alice/Bob
tarafındaki kaynak/kodlayıcı/dedektör-arayüzü zincirini **tek bir çipe**
entegre etmek — kablo kendisini "kısaltmak" değil, kablonun İKİ UCUNDAKİ
kırılgan/hacimli optik bankı ORTADAN KALDIRMAK.

## 2. Neden Si₃N₄ (ve neden InP/SOI/LiNbO₃ değil)

| Platform | Yayılım kaybı (1550nm, tipik) | İki-foton soğurma (TPA) @1550nm | Şeffaflık penceresi | CMOS uyumu | Not |
|---|---|---|---|---|---|
| **Si₃N₄** | ~0.1–1 dB/cm (foundry-standart), <0.1 dB/m (ultra-düşük-kayıp) | **YOK** (bant aralığı ~5eV, 1550nm fotonu absorbe edemez) | ~400nm–2350nm (görünürden orta-IR'a) | Evet (BEOL-uyumlu) | Tek-foton QKD için TPA'nın YOKLUĞU kritik — bkz. aşağı |
| SOI (Silikon) | ~1–3 dB/cm | **VAR** (bant aralığı 1.1eV, 1550nm'de aktif) | ~1100nm+ (1550nm'de çalışır ama TPA riski) | Evet | TPA, tek-foton rejiminde parazitik foton-çifti/gürültü kaynağı olabilir |
| InP | ~1–2 dB/cm | Var (daha zayıf) | Dar (uygulamaya özel) | Hayır (ayrı foundry ekosistemi) | Aktif lazer/detektör entegrasyonu için güçlü, ama tek başına pasif devre için TPA riski + daha yüksek maliyet |
| LiNbO₃ (TFLN) | ~0.1–0.3 dB/cm | Yok (geniş bant aralığı) | Geniş | Kısmi (yeni nesil TFLN foundry'ler var) | En hızlı elektro-optik modülasyon (GHz), ama süreç daha az olgun/daha pahalı |

**Karar gerekçesi:** Si₃N₄'ün buradaki belirleyici avantajı **iki-foton
soğurmanın (TPA) tamamen yokluğu**dur — SOI/InP'de yüksek foton yoğunluklu
noktalarda (özellikle kaynak/modülatör bölgesinde, WCP zayıflatılmadan
ÖNCE) TPA istenmeyen foton-çifti üretebilir, bu da tek-foton QKD'de
GERÇEK bir gürültü/güvenlik kaygısı olur (spontane parametrik saçılma
benzeri parazitik olaylar). Si₃N₄'ün geniş bant aralığı bunu YAPISAL
olarak imkânsız kılar. İkinci sırada: düşük yayılım kaybı + CMOS-uyumlu,
olgun foundry ekosistemi (MPW koşuları mevcut, üretim ölçeklenebilir) —
LiNbO₃'ün üstün modülasyon hızına burada ihtiyaç YOK (BB84 kodlama hızı
zaten dedektör/elektronik tarafından sınırlı, GHz-sınıfı modülasyon bu
uygulamada fazladan karmaşıklık).

## 3. Mimari

```
                          ALICE ÇİPİ (Si₃N₄ PIC)                                    BOB ÇİPİ (Si₃N₄ PIC)
  ┌──────────────────────────────────────────────────────┐        ┌──────────────────────────────────────────────┐
  │  [Lazer] ─edge/hibrit─▶ [Giriş kuplörü] ─▶ [VOA #1]   │        │  [Giriş kuplörü] ─▶ [50/50 MZI (baz seçici)]  │
  │       (off-chip veya hibrit-entegre, μ-hazırlığı)     │        │        │                    │                │
  │              │                                        │        │        ▼                    ▼                │
  │              ▼                                        │        │  [Faz kolu θ_B]      [Faz kolu θ_B']         │
  │  [Faz/zaman-dilimi kodlayıcı: asimetrik MZI, θ_A]     │        │        │                    │                │
  │              │                                        │        │        ▼                    ▼                │
  │              ▼                                        │        │  [Çıkış kuplörü A]   [Çıkış kuplörü B]        │
  │  [VOA #2: μ hedefine son ince-ayar]                   │  ──▶   │        │                    │                │
  │              │                                        │ fiber  │        ▼                    ▼                │
  │              ▼                                        │ (kısa/ │   [SNSPD-A, off-chip]  [SNSPD-B, off-chip]   │
  │  [Çıkış kuplörü] ──────────────────────────────────── │  uzun) │   (kriyostat gerektirir — bkz. §8)            │
  └──────────────────────────────────────────────────────┘        └──────────────────────────────────────────────┘
```

**Neden faz/zaman-dilimi kodlama, polarizasyon DEĞİL:** Si₃N₄ dalga
kılavuzları tipik olarak TEK baskın modu (TE) tek biçimli/dengeli taşır —
polarizasyon kodlaması çip-üstünde pratik değildir (çip üstü PBS/
polarizasyon-döndürücüler ek karmaşıklık+kayıp getirir, ve çipten fibere
geçişte polarizasyon durumu kararsızlaşır). Bunun yerine literatürdeki
yaygın entegre-QKD yaklaşımı olan **asimetrik Mach-Zehnder ile faz/
zaman-dilimi kodlama** kullanılır — REC bazı = zaman-dilimi (erken/geç),
DIAG bazı = faz (0/π ile ayırt edilen ara-zamanlı interferans) — mevcut
simülatörün REC/DIAG baz modeliyle (`LinkGradedEavesdropThresholdAlgorithm`,
`bb84Reconcile`) DOĞRUDAN uyumlu, çekirdek protokol mantığı DEĞİŞMEZ,
yalnızca FİZİKSEL taşıyıcı kodlama yöntemi değişir.

**Bileşenler:**
- **VOA (Değişken Optik Zayıflatıcı)**: termo-optik veya PIN-diyot tabanlı
  bir MZI-zayıflatıcı; lazerin klasik gücünü zayıf-tutarlı-darbe (WCP)
  rejimine (μ ≈ 0.1–0.5 ortalama foton/darbe, decoy-state protokolüyle
  BİRLİKTE kullanılması standart pratiktir — bkz. §8 sınırlama notu)
  indirir.
- **Kodlayıcı/kod-çözücü MZI**: termo-optik faz kaydırıcı (TiN/Pt ısıtıcı,
  tipik ~10–30 mW/π güç, ~10–100 μs yanıt süresi) veya daha hızlı gerekiyorsa
  yük-taşıyıcı-tükenmeli (carrier-depletion) elektro-optik faz kaydırıcı.
- **Kenar kuplörü (edge coupler, ters-koni/inverse-taper)**: çip-fiber
  arayüzü; grating coupler'a göre daha az kayıplı ve polarizasyon/dalga
  boyu-bağımsız, ama daha hassas hizalama gerektirir.
- **Dedektör arayüzü**: SNSPD (Superconducting Nanowire Single-Photon
  Detector) off-chip kalır (kriyojenik soğutma gerektirir, bu PIC'in
  kapsamı DIŞINDA — bkz. §8).

## 4. Kayıp bütçesi — GERÇEK HESAPLANMIŞ (bkz. `bb84/si3n4_pic_link_budget.js`)

Kod ile hesaplanan (varsayılan parametrelerle, tek yön — Alice veya Bob
çipi tek başına) tipik bütçe:

| Bileşen | Varsayılan değer | Kaynak/gerekçe |
|---|---|---|
| Yayılım kaybı | 0.5 dB/cm (foundry-standart varsayım) | §2 tablosundaki orta değer — ultra-düşük-kayıp platform seçilirse 0.05 dB/cm'e düşer |
| Kenar kuplörü (×2, giriş+çıkış) | 1.5 dB/yüz × 2 = 3.0 dB | İnverse-taper, literatür-tipik |
| Kodlayıcı/kod-çözücü MZI ek kaybı | 1.0 dB | Bükülme+faz-bölge saçılması, literatür-tipik |
| **Toplam çip kaybı (1cm çip uzunluğu)** | **≈4.5 dB** | Kod ile hesaplanıyor, aşağıdaki testte doğrulanıyor |

Bu, `WL[1550].loss=0.20 dB/km` tablosuna göre **~22.5 km eşdeğer fiber
kaybı**na denk düşer — yani 1cm'lik bir Si₃N₄ çip, ayrık-bileşen optik
banktaki konnektör/hizalama kayıplarının çoğunu ortadan kaldırırken,
kendi başına ~22.5km'lik bir "sanal mesafe vergisi" ekliyor. Bu vergi,
**sabit** bir bütçedir (mesafeden bağımsız, çip TASARIMINA bağlı) — gerçek
saha fiberine EKLENİR, onun YERİNE geçmez (bkz. §7, "eşdeğer km" entegrasyonu).

VOA'nın μ-hedefine ulaşmak için uyguladığı zayıflatma (tipik olarak
20–40 dB, lazer çıkış gücüne bağlı) bu bütçeye DAHİL DEĞİLDİR — bu,
kaynağın GÜCÜNÜ ayarlamaktır, sonradan "kaybedilen" bir sinyal değildir
(bkz. `meanPhotonNumberToVoaDb` fonksiyonu, ayrı raporlanır).

## 5. Termo-optik faz kaydırıcı — hız/güç ödünleşimi

BB84'te baz seçimi her darbe için DEĞİŞİR (Alice: 2 baz × rastgele bit;
Bob: 2 baz rastgele seçim) — bu, faz kaydırıcının darbe hızıyla
(gerçekçi bir saha sisteminde MHz mertebesi) senkron anahtarlanabilmesini
gerektirir. Termo-optik kaydırıcılar (10–100 μs yanıt) MHz-hızlı anahtarlama
için YAVAŞTIR — bu yüzden gerçekçi bir tasarımda ya (a) birden fazla
ÖNCEDEN-AYARLANMIŞ pasif yol arasında hızlı bir elektro-optik anahtar
seçim yapar (termo-optik sadece kaba/yavaş kalibrasyon için kullanılır),
ya da (b) doğrudan hızlı elektro-optik (yük-tükenmeli) faz kaydırıcıya
geçilir. Bu belge varsayılan olarak (a)'yı öngörür — mevcut simülatörün
`CalibrationRateLimiter`/`NoiseMatrixCalibration` katmanıyla kavramsal
olarak uyumlu (yavaş "kalibrasyon" + hızlı "veri yolu" ayrımı zaten var).

## 6. WDM ile çok-kanallı ölçeklendirme

Si₃N₄'ün geniş şeffaflık penceresi, aynı fiber üzerinde birden fazla dalga
boyu kanalını (WDM) taşımaya uygundur — `NetworkTopology`/`routeCalculation`
zaten çok-düğümlü mesh'i simüle ediyor; her düğüm-çifti için ayrı bir WDM
kanalı (ör. ITU-T 100GHz ızgarasında) tahsis edilerek TEK bir fiber
üzerinde birden fazla eşzamanlı BB84 bağlantısı taşınabilir — bu,
`bb84/qkdnetsim_traffic_bridge.js`'in modellediği trafik yönlendirme
katmanıyla doğal olarak birleşir (kapsam dışında, yalnızca not).

## 7. Mevcut simülatöre entegrasyon — ÇEKİRDEĞE DOKUNMADAN

`bb84/photonnet_core.js`, `fiberT(nm, km) = 10^(-(WL[nm].loss × km)/10)`
formülüyle SADECE mesafeye göre kayıp hesaplıyor — çipin kendi kaybını
ayrı bir parametre olarak MODELLEMİYOR (ve modellememesi gerekiyor,
çekirdeğe DOKUNULMUYOR). Bunun yerine `bb84/si3n4_pic_link_budget.js`,
çip kaybını (dB) `WL[1550].loss` ile **eşdeğer ekstra km**'ye çevirip
mevcut `totalKm` parametresine EKLER — `QuantumKeyDistribution.
deriveSiftedKey(bits, totalKm, evesdrop)` hiçbir değişiklik görmeden,
"çip + N km fiber" senaryosunu doğru fiziksel ağırlıkla simüle eder.
Bu, `bb84/qrng_hardware_bridge.js`'in `opts.qrng` seam'ine takılmasıyla
AYNI disiplin: var olan, test edilmiş bir arayüze (burada: `totalKm`
parametresi) DEĞİŞİKLİKSİZ entegre olmak.

## 8. Dürüstlük sınırları (tekrar, somut)

- **Gerçek fabrikasyon YOK.** Bu bir mimari + parametrik bütçe, GDS/PDK
  tape-out dosyası değil.
- **SNSPD off-chip kalır ve kriyojenik soğutma (~2-4K) gerektirir** — bu
  PIC'in kapsamı bunu ÇÖZMEZ, yalnızca ışığı SNSPD'nin girişine kadar
  taşır. Bu, saha dağıtımında hâlâ GERÇEK bir mühendislik yüküdür
  (kablo problemini çözerken yeni bir soğutma-lojistiği problemi
  YARATMIYORUZ ama gizlemiyoruz da).
- **Weak-coherent-pulse (WCP) çoklu-foton istatistiği mevcut simülatörde
  MODELLENMİYOR.** `propPhoton`/`deriveSiftedKey` foton-başına-tek-olay
  (idealize tek-foton) varsayıyor; gerçek bir Si₃N₄+VOA kaynağı Poisson-
  dağılımlı foton sayısı üretir (μ>0 için çoklu-foton olasılığı sıfır
  değildir) — GERÇEK bir sahada bu, decoy-state protokolü GEREKTİRİR
  (photon-number-splitting saldırısına karşı). Bu belge VOA'nın μ'yü
  NASIL ayarladığını (§4, `meanPhotonNumberToVoaDb`) hesaplar ama decoy-
  state protokolünü UYGULAMAZ — bu, mevcut simülatöre eklenmemiş, AÇIKÇA
  belirtilen bir sonraki adımdır.
- **Parametreler foundry-tipik ARALIKLARDIR, ölçülmüş DEĞİLDİR** — bkz. §0.
