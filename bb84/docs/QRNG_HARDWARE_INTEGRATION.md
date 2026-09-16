# Donanımsal QRNG Entegrasyon Şeması — mulberry32/32-bit tohum sorununu kapatma

## 1. Sorun (tekrar, hassasiyetle)

`bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md`'nin kanıtladığı gibi, çekirdeğin
(`photonnet_core.js`) canlı tarayıcı akışındaki "kuantum" bit üretimi
gerçekte **tek bir 32-bit `mulberry32` PRNG tohumundan** (`entanglementSeed`)
türeyen, tamamen deterministik bir akıştır. Tohum uzayı (2³²≈4.3×10⁹) modern
donanımla saatler-günler mertebesinde kaba-kuvvetle taranabilir — bu,
GLLP/Serfling güvenlik ispatının dayandığı "Eve'in ölçüm sonuçları hakkında
ön-bilgisi yok" aksiyomunu ihlal eder.

**Kritik nüans — bu şemanın çıkış noktası:** çözüm mulberry32'ye "daha
rastgele bir tohum" beslemek DEĞİLDİR. `mulberry32(seed)` çıktısı, `seed`
hangi kaynaktan geldiğine bakılmaksızın, o 32-bit değerden DETERMİNİSTİK
olarak türer — arama uzayı hâlâ 2³²'dir. **Tek doğru çözüm, güvenlik-kritik
baz/bit seçimini mulberry32'yi TAMAMEN BY-PASS EDEREK bir gerçek entropi
akışından okumaktır.**

## 2. Mimari kısıt — neden bu bir "bridge" olmak ZORUNDA

Bu depodaki değişmez kural: `bb84/photonnet_core.js` asla elle değiştirilmez
(SHA-256 ile her committe doğrulanır). Çekirdeğin kendi tarayıcı/canlı
simülasyon akışı (`QuantumKeyDistribution`, `physicalSimulation`,
`deriveSiftedKeyChain`) baz/bit üretimini **doğrudan** `mulberry32(combineSeed(...))`
çağırarak yapar — bu, mimariye gömülüdür ve çekirdeğe dokunmadan
**değiştirilemez**. Bu şema, o gerçeği gizlemez: **çekirdeğin kendi canlı
tarayıcı akışı bu değişiklikle düzelmez** — bu, "tasarla" talebinin kapsamı
dışında bırakılan, açıkça işaretlenmiş bir sınırdır.

Düzeltilebilir olan, ve bu şemanın hedefi: projenin **"gerçek makinelere
bağlanma" üretim hattı** — `timetag_acquisition_bridge.js` (Faz 1) →
`detector_recalibration.js` (Faz 3) → `production_gate.js` (Faz 4) →
`etsi014_kme_server.js` zinciri. Bu zincir zaten çekirdeği by-pass eder
(kendi `TimeTagEmulator`'ını çalıştırır) ve zaten mulberry32'yi
**by-pass edecek şekilde tasarlanmıştır**:

```js
// timetag_acquisition_bridge.js — MEVCUT kod, DEĞİŞTİRİLMEDİ
function cryptoQrng() { let buf = crypto.randomBytes(4096), ...
this.qrng = opts.qrng || cryptoQrng();   // ← "QRNG SEAM" (B2), zaten var
```

Bu şema, tam olarak bu **zaten var olan** `opts.qrng` sözleşmesinin ARKASINA
gerçek/donanım-destekli bir uygulama takar — hiçbir mevcut dosyanın
davranışını değiştirmeden.

## 3. Katmanlı mimari

```
Gerçek QRNG cihazı (USB-seri dongle / TCP-ağ kutusu / henüz yok→simülasyon)
       │  ham bayt akışı (komutsuz, sürekli — çoğu gerçek USB QRNG böyle çalışır)
       ▼
hal/qrng_serial_hardware.py  /  hal/qrng_tcp_hardware.py  /  hal/qrng_simulated.py
       │  ortak sözleşme: QRNGInterface (connect/disconnect/read_bytes/status)
       │  (bkz. hal/qrng_raw_stream.py — Serial/TCP'nin PAYLAŞTIĞI protokol)
       ▼
hal/qrng_health_tests.py  — NIST SP 800-90B'den esinlenen RCT+APT
       │  HER partiye (batch) uygulanır — cihaz "sessizce" bozulursa
       │  (sıkışma/yanlılaşma) burada YAKALANIR, aşağı akışa SIZMAZ
       ▼
hal/bridge_server.py  — GET /api/qrng/status, GET /api/qrng/bytes?n=
       │  sağlık testi BAŞARISIZ → 503 + ok:false (bayt HTTP gövdesine
       │  bile KONMAZ — fail-closed)
       ▼
bb84/qrng_hardware_bridge.js  — HardwareQrngClient: { bit(): 0|1 }
       │  köprü ulaşılamaz/unhealthy/tampon-tükendi → THROW (asla
       │  Math.random()/mulberry32'ye SESSİZCE düşmez)
       ▼
timetag_acquisition_bridge.js'in opts.qrng seam'i  (DEĞİŞTİRİLMEDİ)
       │
       ▼
production_gate.js'in qrngHealth()/kriter-3'ü  (DEĞİŞTİRİLMEDİ)
  → state.qrngFit=true (mulberry32'nin TERSİ) + state.qrngHardware
    (gerçek sertifikalı cihaz bağlandığında true yapılır — YAZILIMLA
    KANITLANAMAZ, vendor beyanına dayanır, bkz. §5)
```

## 4. Neden sağlık testleri gerekli — "by-pass etmek" tek başına yetmez

mulberry32'yi by-pass edip GERÇEK donanıma geçmek, YENİ bir tehdit sınıfı
açar: donanım **sessizce bozulabilir** (foton kaynağı tıkanır, karşılaştırıcı
DC'ye kilitlenir, kablo gevşer) — sonucu genelde "hata" değil, öngörülebilir/
yanlı bir bayt akışıdır. `hal/qrng_health_tests.py`, NIST SP 800-90B'nin
**çevrimiçi (online) sağlık testleri** (§4.4) bölümünden iki testi uygular:

- **RCT (Repetition Count Test, §4.4.1):** ardışık aynı örnek sayısı bir
  eşiği (`cutoff = 1 + ⌈-log2(α)/H⌉`) aşarsa kaynağı reddeder — "sıkışma"yı
  yakalar.
- **APT (Adaptive Proportion Test, §4.4.2):** kayan bir pencerede bir
  sembolün BEKLENENDEN sık tekrarını yakalar — "sıkışma olmadan ama
  beklenenden çok daha yanlı" durumları, RCT'nin KAÇIRABİLECEĞİ türden,
  yakalar.

**Bu şemanın kendi test dosyasında ÖLÇÜLEREK bulunan gerçek bir nüans**
(`hal/qrng_health_tests.py`'nin baş yorumunda ayrıca belgelenir): standart
formüldeki `α` parametresi, "N örneklik BİR PARÇANIN toplam yanlış-alarm
olasılığı" DEĞİLDİR — N arttıkça bir run'ın başlayabileceği konum sayısı
artar, dolayısıyla aggregate yanlış-alarm oranı `α`'dan büyük ve N'e bağlı
büyür. Bunun pratik sonucu: sağlık testleri **büyük, biriken bir akış
üzerinde bir kerede DEĞİL, sınırlı boyutlu ardışık partiler** üzerinde
çalıştırılmalıdır — `hal/bridge_server.py`'nin `/api/qrng/bytes` ucu tam
bunu yapar (her istekte yalnızca o partiyi test eder).

## 5. Dürüstlük — bu şema NE YAPAR, NE YAPMAZ

**Yapar:**
- Güvenlik-kritik baz/bit seçimini mulberry32'den TAMAMEN AYIRIR (üretim
  hattında — `timetag_acquisition_bridge.js`+ötesi).
- Gerçek/harici bir entropi akışını, SÜREKLİ sağlık testinden geçirerek,
  fail-closed bir sözleşmeyle üretim hattına bağlar.
- `SerialQRNG`/`TCPQRNG` ile gerçek donanıma (USB dongle veya ağ cihazı)
  TEK SATIR üst-katman kodu değişmeden takılabilecek somut sürücüler sağlar.
- `production_gate.js`'in ZATEN var olan QRNG kriterini (kriter 3)
  mulberry32'den crypto-entropiye geçirir (bu depoda `qrngHealth()`
  çağrısı zaten `crypto.randomBytes`'ı "fit" olarak kabul ediyordu —
  bu şema ona GERÇEK bir donanım-destekli/HTTP-üzerinden alternatif verir).

**YAPMAZ (açıkça sınırlı):**
- **Çekirdeğin kendi tarayıcı/canlı simülasyon akışını DÜZELTMEZ** — o akış
  mulberry32'yi doğrudan çağırır ve çekirdeğe dokunmadan değiştirilemez.
  Bu, kullanıcı talebinin "çekirdeğe zarar vermeden" kısıtıyla doğrudan
  çakışan, ÇÖZÜLEMEYEN bir mimari gerçektir.
- **`is_certified_hardware=True`'yu YAZILIMLA KANITLAMAZ** — bu bayrak,
  yazılımın "kaynak öngörülemez" diye ölçtüğü şeyden (`qrngHealth`) AYRI bir
  iddiadır (vendor'ın gerçek fiziksel süreç + laboratuvar karakterizasyonu +
  genelde NIST SP 800-90B/90C sertifikasyonu). `SimulatedQRNG` (os.urandom)
  bu testi GEÇER ama `is_certified_hardware=False` kalır — tam olarak
  `production_gate.js`'in "CSPRNG uygun; ÜRETİM için sertifikalı DONANIM
  QRNG gerekir" ayrımıyla tutarlı.
- **Bu sandbox'ta GERÇEK bir USB/seri QRNG cihazına karşı test EDİLMEDİ**
  (`pyserial` kurulu değil — bu projede tekrar eden, dürüstçe belgelenen bir
  sınır, bkz. `hal/serial_hardware.py`). `SerialQRNG`/`TCPQRNG` PAYLAŞTIĞI
  protokol mantığı (`RawStreamQRNG`) sahte bir TCP cihaz sunucusuna karşı
  uçtan uca doğrulandı — gerçek cihaza karşı ilk doğrulama, donanım
  bağlandığında yapılmalıdır.
- **Von Neumann debiasing varsayılan olarak AKTİF DEĞİLDİR** (`hal/qrng_health_tests.
  von_neumann_debias`, çağıran isteğe bağlı kullanır) — çünkü debiasing SAĞLIK
  TESTİNİN YERİNİ TUTMAZ (bkz. fonksiyonun kendi dürüstlük notu: kaynak tamamen
  sıkışırsa debias çıktıyı SESSİZCE sıfıra indirebilir) — bu yüzden sağlık
  testleri HER ZAMAN ham örnekler üzerinde çalıştırılır.

## 6. Nasıl gerçek donanıma geçilir

```bash
# 1) Cihazı bağla, hangi porttan/adresten eriştiğini belirle.
# 2) hal/bridge_server.py'yi doğru backend ile başlat:
PHOTONNET_QRNG_BACKEND=serial:/dev/ttyUSB0:921600 \
PHOTONNET_QRNG_MIN_ENTROPY_BITS=<vendor karakterizasyon raporundan> \
python3 -m hal.bridge_server
#   (ağ cihazı için: PHOTONNET_QRNG_BACKEND=tcp:192.168.1.50:9999)

# 3) pip install pyserial (SADECE serial: backend için gerekli).

# 4) Node.js tarafında HİÇBİR KOD DEĞİŞMEZ — HardwareQrngClient zaten
#    HTTP üzerinden konuşuyor:
const client = new HardwareQrngClient({ baseUrl: "http://<hal-sunucu-adresi>:8765" });
await client.warmUp(...);
new TimeTagEmulator({ ...opts, qrng: client });

# 5) production_gate.js'e state.qrngHardware=true GEÇİRİLİR (vendor'ın
#    sertifikasyon/karakterizasyon raporu elde bulunduğunda) — bu bayrağı
#    YAZILIM OTOMATİK OLARAK ayarlamaz, kasıtlı olarak bir insan kararıdır.
```

## 7. Gerçek testlerle doğrulanan davranış (özet — tam koşum sonuçları commit mesajında)

- `hal/test_qrng_health_tests.py`: RCT sıkışmış kaynağı (5000× aynı bit)
  yakalıyor, APT RCT'nin kaçırdığı "yanlı ama patlak vermeyen" deseni
  yakalıyor, gerçek CSPRNG akışı (os.urandom, 50 bağımsız 1024-bitlik
  parça) istatistiksel olarak beklenen düzeyde geçiyor.
- `hal/test_qrng_raw_stream.py`: gerçek TCP soketi üzerinden connect/
  read_bytes/health-test zinciri uçtan uca; erişilemeyen sunucu ve
  eksik/yavaş akış fail-closed.
- `bb84/chaos_qrng_hardware_bridge_test.js`: gerçek Flask köprüsüne karşı
  `qrngHealth()` `fit=true` veriyor (mulberry32 `fit=false` verirdi);
  `TimeTagEmulator`'a bu istemci enjekte edilince BB84 güvenlik özelliği
  (casus → QBER~%26 → iptal) DEĞİŞMEDEN çalışıyor; erişilemez/unhealthy/
  tükenmiş-tampon senaryolarının HEPSİ throw ediyor.
- Çekirdek SHA-256 (`8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05`)
  bu çalışmanın HİÇBİR adımında değişmedi.

## 8. Üst katman senkronizasyon — mTLS el sıkışması ↔ epoch_reset_controller.js (bb84/mtls_handshake_qrng_sync.js)

**Talep (birebir):** "Sunucunun bu canlı QRNG tohumlarını, her mTLS el
sıkışması yenilendiğinde otomatik olarak `epoch_reset_controller.js`
kancalarına enjekte etmesini sağlayacak üst katman senkronizasyon."

**Bulunan granülerlik uyumsuzluğu (dürüstçe):** `epoch_reset_controller.js`'in
`onEpochRollover` kancası **30 günde bir** tetiklenen, sayaç-taşması-önleme
amaçlı TEK bir olaydır. mTLS el sıkışması ise saniyede onlarca/yüzlerce kez
olabilen YÜKSEK FREKANSLI bir olaydır. "Her el sıkışmayı doğrudan
`onEpochRollover`'a bağlamak" bu kancanın 30-günlük anlamını YOK EDERDİ. Bu
yüzden talep, ayrıştırılmadan uygulanmadı — İKİ AYRI ama BİRBİRİNİ tamamlayan
mekanizmaya bölündü:

1. **`attachHandshakeQrngSync(server, { qrngClient, epochController, ... })`**
   — HER GERÇEK, KABUL EDİLMİŞ mTLS el sıkışmasında (Node'un `secureConnection`
   olayı) canlı QRNG akışından taze bit çekilir ve bu tüketim
   `EpochResetController.record(n, nowS)` — dosyanın ZATEN VAR OLAN, hiç
   değiştirilmemiş API'si — ile epoch muhasebesine işlenir. "Canlı QRNG
   tohumu her el sıkışmada epoch mekanizmasına enjekte edilir" isteği BÖYLECE
   lafzen karşılanır.
2. **`attachEpochRolloverHardReseed(epochController, qrngClient, ...)`** —
   `onEpochRollover` kancasının KENDİSİ (30 günlük, değişmeyen frekansında)
   artık gerçek bir eylem tetikler: `HardwareQrngClient.hardReseed()` —
   tamponun TAMAMEN atılıp sıfırdan doldurulması. Sertifika rotasyonu
   (`pki_tools/rotate_cert.sh`) KASITLI OLARAK otomatik tetiklenmez — sadece
   bir işaretçi log'lanır; bu, geri döndürülemez bir PKI eylemi olduğu için
   operatör onayına bırakılmıştır.

**Kritik dürüstlük sınırı — bu tasarımın YANLIŞ anlaşılmaması için:**
`secureConnection` olayı ateşlendiğinde TLS el sıkışması (sertifika
doğrulaması, oturum anahtarı türetimi) OpenSSL/Node'un KENDİ dahili RNG'siyle
ZATEN TAMAMLANMIŞTIR. Bu katmanın çektiği QRNG bit'leri o el sıkışmasının
kriptografik oturum anahtarına HİÇBİR ŞEKİLDE karışmaz — JavaScript
katmanından Node'un TLS/OpenSSL RNG'sini değiştirmek bu projenin kapsamı
dışındadır (ve gerekli de değildir: `IBM_ONAY_MATEMATIKSEL_DENETIM.md`'nin
bulduğu sorun SADECE BB84 fiziksel katmanının taban/bit üretimiydi — mTLS
taşıma güvenliği hiçbir zaman kırık değildi). Bu katmanın gerçek işlevi:
(a) her kabul edilen el sıkışmada donanım entropi kaynağının CANLI/SAĞLIKLI
olduğunu kanıtlamak, (b) bu tüketimi epoch/hardReseed disiplinine doğru
şekilde bağlamak. "QRNG tohumunu mTLS'e enjekte etmek" ifadesi BU anlamda
karşılanmıştır — TLS oturum anahtarının kendisini değiştirmek anlamında
DEĞİL.

**Fail-closed:** bir el sıkışmada entropi çekimi başarısız olursa (HAL
köprüsü sağlıksız/erişilemez/tükenmiş), varsayılan davranış — TLS katmanı
zaten o bağlantıyı kabul etmiş olsa BİLE — soketi `destroy()` eder. Gerçek
test (`bb84/chaos_mtls_handshake_qrng_sync_test.js`, Test 4) bunu doğrudan
kanıtlıyor: `secureConnect` (OpenSSL katmanı) başarıyla ateşleniyor, AMA
bağlantı hemen ardından uygulama katmanınca sonlandırılıyor.

**Gerçek testlerle doğrulanan davranış (`chaos_mtls_handshake_qrng_sync_test.js`,
gerçek openssl-üretimli PKI + gerçek `hal/bridge_server.py` + gerçek
`tls.connect()` el sıkışmaları — 12/12 kontrol geçti):**
- Geçerli istemci sertifikalı GERÇEK el sıkışma → `secureConnection` →
  doğru `n` ile `record()` çağrısı.
- İstemci sertifikası sunmayan bağlantı `tlsClientError` ile reddediliyor
  ve `secureConnection`/senkronizasyon katmanı bunu HİÇ saymıyor.
- 30 günlük epoch yerine test edilebilirlik için kısa (5s) bir epoch sınırı
  gerçekten geçilince (`record()` ile, doğrudan) `hardReseed()` tetikleniyor,
  ÖNCEDEN var olan `onEpochRollover` davranışı (zincirleme) korunuyor, VE
  tamponun bit içeriği rollover öncesi/sonrası GERÇEKTEN farklı (eski bitler
  sessizce yeniden servis edilmiyor).
- HAL köprüsü erişilemez olduğunda, TAMAMLANMIŞ bir mTLS el sıkışması bile
  fail-closed olarak sonlandırılıyor.
