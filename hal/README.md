# PhotonNet HAL — Hardware Abstraction Layer

`hal/`, PhotonNet'in tarayıcı-içi BB84 simülasyonunu (`PhotonNet2.jsx` içindeki
`propPhoton()` / `deriveSiftedKey()`) gerçek kuantum anahtar dağıtım donanımına
bağlamak için tasarlanmış, saf Python tabanlı bir soyutlama katmanıdır.

Bugün elde gerçek donanım yok — bu paket, donanım geldiğinde **yalnızca bir
sınıf eklenerek** (mevcut hiçbir kod değiştirilmeden) devreye alınabilecek
şekilde inşa edildi. Aşağıda mimari, veri akışı, çalıştırma talimatları ve
gerçek bir cihaz eklerken izlenecek adımlar var.

## Neden bu ayrım gerekli?

`PhotonNet2.jsx`'teki `propPhoton()` bir **olasılık modelidir** — "bu foton
hayatta kaldı mı, hangi bit üretildi" sorusunu bir RNG ile üretir. Gerçek
donanımda bu soru zaten CEVAPLANMIŞTIR: dedektör ya bir click üretir ya
üretmez, olay fiziksel olarak gerçekleşmiştir. Yazılımın işi artık bit
*üretmek* değil, Bob'un gerçek zaman-damgalı click'lerini Alice'in gönderim
zaman damgalarıyla **eşleştirmek** (time-tag correlation) ve QBER'i bu
eşleşmeden türetmektir. Bu, iki farklı matematik — bu yüzden HAL, `propPhoton`
ile HİÇ ilişkili olmayan, bağımsız bir katman olarak yazıldı.

## Mimari (aşağıdan yukarıya)

```
                         ┌─────────────────────────┐
                         │   PhotonNet.html (UI)    │  ← 🔧 DONANIM sekmesi
                         │   fetch() + EventSource  │
                         └────────────┬─────────────┘
                                      │ HTTP + SSE (localhost:8765)
                         ┌────────────▼─────────────┐
                         │    bridge_server.py       │  Flask — REST + SSE köprü
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │      link_manager.py      │  bağlan/yeniden-dene/arka-plan-oku
                         └────────────┬─────────────┘
                                      │ HardwareInterface sözleşmesi
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
   ┌──────────▼─────────┐  ┌───────────▼──────────┐  ┌──────────▼───────────┐
   │ simulated_hardware.py│  │  serial_hardware.py   │  │   tcp_hardware.py     │
   │  (BUGÜN ÇALIŞIYOR)   │  │ (BUGÜN YAZILDI —      │  │ (BUGÜN YAZILDI VE     │
   │                       │  │  pyserial olmadan     │  │  MOCK CİHAZA KARŞI    │
   │                       │  │  CANLI test edilemedi)│  │  TEST EDİLDİ)         │
   └───────────────────────┘  └───────────┬───────────┘  └──────────┬────────────┘
                                           │                         │
                                           └────────────┬────────────┘
                                                         │ (protokol/çerçeveleme
                                                         │  mantığı PAYLAŞILIR)
                                          ┌──────────────▼──────────────┐
                                          │  binary_click_hardware.py    │  referans wire-protokol
                                          │  BinaryClickHardware         │  (ARM/STATUS/STREAM_* +
                                          └──────────────┬──────────────┘  13-bayt ikili kayıt)
                                                         │
                                          ┌──────────────▼──────────────┐
                                          │  transport.py                 │
                                          │  SerialTransport / TCPTransport│  ham bayt seviyesi
                                          └────────────────────────────────┘

                         ┌────────────────────────────┐
                         │   time_tag_correlator.py     │  RNG'siz — yalnızca
                         │   (bridge_server tarafından   │  zaman-damgası
                         │    her katmanda kullanılır)   │  eşleştirme + QBER
                         └────────────────────────────┘
```

## Dosyalar ve sorumlulukları

| Dosya | Sorumluluk |
|---|---|
| `types.py` | Ortak veri tipleri: `Basis`, `DetectorChannel`, `TransmitEvent`, `TimestampedClick`, `AcquisitionConfig`, `HardwareStatus`, `SiftingResult`. Hiçbir donanıma özgü kod içermez. |
| `hardware_interface.py` | `HardwareInterface` soyut sınıfı — `connect() / disconnect() / arm() / read_clicks() / status()`. TÜM sürücülerin uyduğu sözleşme. |
| `transport.py` | Ham bayt taşıma soyutlaması: `TCPTransport` (stdlib `socket`, bugün çalışır), `SerialTransport` (`pyserial` gerektirir, opsiyonel bağımlılık). |
| `simulated_hardware.py` | `SimulatedHardware` — bugün çalışan, gerçekçi sahte donanım. Kayıp/faz-kayması fiziği `PhotonNet2.jsx`'teki `propPhoton()`'dan bilerek portlandı (aynı `fiberT` ve `phaseProb` formülleri) — böylece ürettiği QBER, tarayıcı simülasyonu ve Qiskit-eşdeğeri doğrulama raporuyla tutarlı kalır. |
| `binary_click_hardware.py` | `BinaryClickHardware` — `serial_hardware.py`/`tcp_hardware.py` arasında PAYLAŞILAN referans wire-protokol/çerçeveleme mantığı (ARM/STATUS/STREAM_START/STREAM_STOP metin komutları + 13-baytlık ikili click kaydı akışı). **GERÇEK bir vendor spesifikasyonu DEĞİLDİR** — makul bir varsayımdır, gerçek cihazınıza göre 6 encode/parse metodu değiştirilmelidir (bkz. dosya başlığı). |
| `serial_hardware.py` | `SerialHardware(BinaryClickHardware)` — gerçek bir seri port (USB-UART) sürücüsü. `pyserial` gerektirir, bu sandbox'ta kurulu değil, bu yüzden CANLI test edilemedi (yalnızca sözdizimi + import doğrulandı, ayrıca `pyserial` yokken `connect()`'in net bir `HardwareError` ile başarısız olduğu doğrulandı). |
| `tcp_hardware.py` | `TCPHardware(BinaryClickHardware)` — ağ üzerinden erişilebilen bir cihaz sürücüsü. Yalnızca stdlib `socket` kullanır, bu sandbox'ta BUGÜN çalışır — `test_binary_click_hardware.py`'deki sahte-cihaz (mock) sunucusuna karşı uçtan uca doğrulandı. |
| `link_manager.py` | `LinkManager` — bağlan/kopunca-yeniden-dene (backoff), arka plan thread'inde sürekli `read_clicks()` çağırma, durum yayını, sınırlı click kuyruğu (`maxsize=200_000`, dolarsa en-eskiyi düşürür). |
| `time_tag_correlator.py` | `TimeTagCorrelator` — Alice/Bob zaman damgalarını bir eşleştirme penceresi (`coincidence_window_ps`) içinde O(n+m) eşleştirir, sifting + QBER üretir. **RNG kullanmaz** — girdisi tamamen gerçek/gerçekçi olaylardır. |
| `bridge_server.py` | Flask tabanlı REST + Server-Sent-Events köprüsü — `PhotonNet.html`'in tarayıcıdan bu pakete erişmesini sağlar (bkz. [API uçları](#api-uçları)). |
| `test_pipeline.py` | `pytest` gerektirmeyen, düz `assert` tabanlı uçtan uca fizik doğrulama scripti (`SimulatedHardware` → `TimeTagCorrelator`). |
| `test_binary_click_hardware.py` | `pytest` gerektirmeyen, düz `assert` tabanlı uçtan uca protokol doğrulama scripti — gerçek bir soket üzerinden sahte bir cihaza (`_MockDeviceServer`) karşı `TCPHardware`'i test eder. |
| `test_serial_hardware_mock.py` | `pyserial` kurulu OLMADIĞI için, `serial.Serial`'ı taklit eden sahte bir sınıfı `sys.modules["serial"]`'a enjekte edip `SerialHardware`'i (özellikle `TCPTransport`'ta OLMAYAN, `SerialTransport`'a özgü `read()` toplama döngüsünü) doğrudan egzersiz eden bir doğrulama scripti. Gerçek pyserial/gerçek donanımın YERİNE GEÇMEZ — bkz. [Gerçek donanım olmadan ne test edildi, ne edilemedi](#gerçek-donanım-olmadan-ne-test-edildi-ne-edilemedi). |
| `__init__.py` | Paket dışına açılan public API. |

## Hızlı başlangıç

```bash
# 1) Uçtan uca fizik doğrulaması (sunucu gerekmez)
python3 -m hal.test_pipeline

# 1b) Gerçek donanım sürücülerinin (Serial/TCP) wire-protokol/çerçeveleme
#     mantığını, sahte ama protokolü doğru konuşan bir "cihaza" karşı
#     uçtan uca doğrula (sunucu gerekmez)
python3 -m hal.test_binary_click_hardware

# 1c) SerialHardware'e özgü SerialTransport.read() toplama döngüsünü,
#     sahte (mock) bir pyserial ile doğrudan egzersiz et (pyserial kurulu
#     olmasa BİLE çalışır — bkz. "Gerçek donanım olmadan ne test edildi,
#     ne edilemedi")
python3 -m hal.test_serial_hardware_mock

# 2) Köprü sunucusunu başlat
python3 -m hal.bridge_server
# → http://127.0.0.1:8765'te dinler

# 3) Tek seferlik bir BB84 edinimi (sunucu ayrı bir terminalde çalışırken)
curl -X POST localhost:8765/api/acquire -H 'Content-Type: application/json' \
     -d '{"distance_km": 25, "eavesdrop": false, "duration_s": 0.0005}'

# 4) PhotonNet.html'i aç → 🔧 DONANIM sekmesi → "SUNUCUYU DENE" → BAĞLAN
#    (varsayılan köprü adresi http://localhost:8765, panelden değiştirilebilir)
```

## API uçları

| Uç | Metod | Açıklama |
|---|---|---|
| `/api/health` | GET | Sunucu ayakta mı — panel bunu "SUNUCUYU DENE" ile çağırır. |
| `/api/connect` | POST | `{distance_km, eavesdrop, seed?}` — `LinkManager`'ı arka-plan sürekli-akış modunda başlatır. |
| `/api/disconnect` | POST | `LinkManager`'ı durdurur, donanımı bağlantısını keser. |
| `/api/status` | GET | Anlık `HardwareStatus` (connected/armed/driver_name/sıcaklık/vb.). |
| `/api/acquire` | POST | `{distance_km, eavesdrop, duration_s, coincidence_window_ps?, include_bits?}` — bağımsız, senkron tek-seferlik BB84 oturumu. Varsayılan olarak yalnızca özet istatistikler döner (ham anahtar bitleri `include_bits:true` istenmedikçe taşınmaz). |
| `/api/clicks` | GET | `?max=&timeout_s=` — `LinkManager`'ın arka planda biriktirdiği click kuyruğunu boşaltıp döndürür (canlı sayım hızı telemetrisi için). |
| `/api/stream` | GET (SSE) | `EventSource` ile tüketilir — durum değişikliklerini gerçek zamanlı iter. |

Tüm uçlar `Access-Control-Allow-Origin: *` ile CORS'a açıktır çünkü
`PhotonNet.html` genelde `file://` (Origin: `null`) üzerinden açılır — bu,
`localhost:8765`'ten farklı bir origin sayılır. Bu yalnızca yerel bir
geliştirme köprüsü olduğu için kabul edilebilir; üretimde belirli bir origin'e
daraltılmalıdır.

## Sandbox kısıtları — neden Flask+SSE, WebSocket değil

Bu geliştirme ortamında `pip` yeni paket **kuramıyor** (`websockets`,
`fastapi`, `pyserial`, `qiskit` dahil hiçbiri kurulamadı — birden fazla kez
doğrulandı). Bu yüzden köprü, yalnızca stdlib + kurulu olan Flask kullanan bir
REST + Server-Sent-Events tasarımıyla yazıldı — tarayıcıda `new
EventSource(...)` ekstra kütüphane gerektirmeden çalışır.

Gerçek donanıma bağlanacağınız üretim makinesinde `pip install websockets`
(veya `fastapi`) çalıştırılabiliyorsa, `bridge_server.py` bir WebSocket
sürümüne geçirilebilir — `LinkManager`/`TimeTagCorrelator`/`HardwareInterface`
katmanları bundan TAMAMEN BAĞIMSIZDIR, hiçbir şeyi bilmezler.

Aynı şekilde `SerialTransport`, `pyserial` kurulu olmadığından burada test
edilemedi ama doğru arayüzle tanımlı — kurulumdan sonra tek satır başka kod
değişmeden çalışır (`transport.py`'deki lazy-import + net hata mesajına
bakın).

## Gerçek donanım olmadan ne test edildi, ne edilemedi

Bu sorulmaya değer bir soru, dürüst cevabı şu:

**Gerçek donanıma karşı test — MÜMKÜN DEĞİL, iki bağımsız engelden.** (1) Bu
oturum izole bir bulut konteynerinde çalışıyor — kullanıcının kendi
bilgisayarına fiziksel USB/seri port erişimi YOKTUR, kullanıcının gerçek
donanımı olsa bile. (2) `pyserial` bu sandbox'ta kurulamıyor (`pip install
pyserial` "No matching distribution found" ile başarısız oluyor — birden
fazla kez doğrulandı), bu yüzden `SerialTransport`'un GERÇEK pyserial
üzerinden çalıştığı bile bu ortamda kanıtlanamaz.

**Yapılabilecek en iyisi yapıldı — iki katmanlı doğrulama:**
1. **Protokol/çerçeveleme mantığının kendisi** (`BinaryClickHardware` —
   `SerialHardware` ve `TCPHardware`'in İKİSİ TARAFINDAN PAYLAŞILAN kod)
   gerçek bir TCP soketi üzerinden, protokolü doğru konuşan sahte bir
   "cihaz" sunucusuna karşı uçtan uca doğrulandı (`test_binary_click_
   hardware.py`) — el sıkışma, arm, kasıtlı olarak kayıt sınırlarını kesen
   parçalara bölünmüş ikili akışın doğru tamponlanması, status önbellekleme,
   temiz disconnect, ve ulaşılamayan bir adrese bağlanmaya çalışınca net bir
   `HardwareError` fırlatılması dahil.
2. **`SerialTransport`'a ÖZGÜ kod** (`TCPTransport`'ta karşılığı olmayan,
   yalnızca seri porta özgü `read()` toplama döngüsü) ayrıca, `pyserial`'ı
   taklit eden sahte bir sınıfı `sys.modules["serial"]`'a enjekte ederek
   doğrudan egzersiz edildi (`test_serial_hardware_mock.py`) — AYNI
   senaryolar (el sıkışma, arm, bölünmüş akış, status, disconnect) bu kez
   `SerialHardware`/`SerialTransport` üzerinden de geçti. Bu test ayrıca
   ilginç bir davranış farkı ortaya çıkardı: `SerialTransport.read(n,
   timeout_s)`, `TCPTransport.read()`'in aksine `n` bayt birikene KADAR
   veya zaman aşımına kadar bekler (erken çıkış yoktur) — bu, `read_clicks
   (timeout_s=X)`'in Serial üzerinde neredeyse HER ZAMAN `X` saniyeye yakın
   sürmesi anlamına gelir. Bu bir hata değil, aslında `LinkManager`'ın
   istediği "gerçekten `timeout_s` kadar blokla" davranışını DOĞAL olarak
   sağlıyor (`SimulatedHardware`'e bu yüzden eklenen yapay `time.sleep()`
   hack'i, gerçek bir Serial sürücüde GEREKMEYECEKTİR).

**Doğrulanamayan TEK şey:** gerçek pyserial'ın kendi iç davranışı (USB
sürücü katmanı, gerçek donanım gecikmesi/jitter'ı, işletim sistemine özgü
seri port tuhaflıkları). Bunun için gerçek donanım makinesinde `pip install
pyserial` çalıştırıp gerçek bir cihaza karşı test etmek gerekir — bu paket
o noktada TEK SATIR değişmeden kullanılabilir olacak şekilde tasarlandı.

## Gerçek donanım ekleme (adım adım)

`serial_hardware.py` (`SerialHardware`) ve `tcp_hardware.py` (`TCPHardware`)
zaten yazıldı — ikisi de `HardwareInterface`'i implemente eder ve wire-
protokol mantığını `binary_click_hardware.py`'deki `BinaryClickHardware`
taban sınıfından PAYLAŞIR. Oradaki protokol (ARM/STATUS/STREAM_START/
STREAM_STOP metin komutları + 13-baytlık `<timestamp_ps:uint64><channel:
uint8><amplitude:float32>` ikili kaydı) **gerçek bir vendor spesifikasyonu
DEĞİL**, makul bir referans varsayımıdır — gerçek cihazınızın protokolü
büyük olasılıkla farklı olacaktır. İki yol var:

**A) Cihazınız benzer bir ham ikili akış protokolü konuşuyorsa** (çoğu
FPGA-tabanlı TDC/SPAD kontrolcüsü buna yakındır): yalnızca
`binary_click_hardware.py`'deki 6 encode/parse metodunu vendor'ınızın gerçek
komut/kayıt formatına göre düzenleyin:
   - `_encode_arm_command()` / `_parse_arm_response()` — ARM komutunun
     gerçek sözdizimi ve başarı/hata yanıtı.
   - `_encode_status_query()` / `_parse_status_response()` — STATUS
     sorgusu ve yanıtının gerçek formatı (JSON olmak zorunda değil).
   - `_encode_stream_start()` / `_encode_stream_stop()` — akışı başlatma/
     durdurma komutları.
   - `RECORD_STRUCT` / `_parse_click_record()` — click kaydının gerçek
     bayt düzeni (`struct.Struct` format string'ini değiştirin; alan sayısı/
     sırası farklıysa `_parse_click_record()`'u buna göre güncelleyin).
   `SerialHardware`, `TCPHardware`, `LinkManager`, `TimeTagCorrelator`,
   `bridge_server.py` ve `PhotonNet.html`'deki 🔧 DONANIM paneli **TEK
   SATIR DEĞİŞMEDEN** çalışmaya devam eder.

**B) Cihazınız tamamen farklı bir model kullanıyorsa** (örn. bir vendor
SDK/DLL çağrısı, USB-HID, ya da satır-tabanlı olmayan özel bir el sıkışma):
`hardware_interface.HardwareInterface`'ten DOĞRUDAN türeyen yeni bir sınıf
yazın (`BinaryClickHardware`'i kullanmak ZORUNLU DEĞİL — o yalnızca ortak
bir örnek/yardımcı taban sınıftır). 4 soyut metodu doldurun:
   - `connect()` — fiziksel bağlantıyı kurun (vendor SDK init, `transport.py`
     üzerinden port açma, vb.). Başarısızsa `HardwareError` fırlatın.
   - `arm(config)` — donanımı `AcquisitionConfig` parametreleriyle
     (kapı genişliği, eşleştirme penceresi vb.) hazırlayın.
   - `read_clicks(timeout_s)` — vendor'ın ham çıktısını
     `TimestampedClick(timestamp_ps, channel, amplitude=None)` listesine
     çevirin. **Gerçekten `timeout_s` kadar bloklamalı** (ya da erken veri
     gelince dönmeli) — `LinkManager`'ın arka plan döngüsü bu blocking
     semantiğine güvenir (bkz. `simulated_hardware.py`'deki
     `time.sleep(_remaining_s)` notu — gerçek TDC donanımının doğal
     blocking I/O davranışını simüle etmek için eklendi; gerçek donanımda
     bu zaten doğaldır, ekstra `sleep` gerekmez).
   - `status()` — anlık sağlık/telemetri bilgisini `HardwareStatus` olarak
     döndürün.

Her iki yolda da son adım aynı: `bridge_server.py`'de `SimulatedHardware(...)`
yaratılan iki yeri (`api_connect()` ve `api_acquire()`) yeni sürücünüzle
değiştirin (veya bir ortam değişkeni/config ile hangi sürücünün
kullanılacağını seçilebilir hale getirin). **`LinkManager`,
`TimeTagCorrelator`, `bridge_server.py`'nin geri kalanı ve `PhotonNet.html`'
deki 🔧 DONANIM paneli TEK SATIR DEĞİŞMEDEN çalışmaya devam eder** — hepsi
`HardwareInterface` sözleşmesine karşı yazıldı, `SimulatedHardware`'e özgü
hiçbir varsayım içermiyorlar.

### Alice tarafı için not

`SimulatedAliceSource`, test/geliştirme kolaylığı için Bob'un simülasyonuyla
aynı süreçte tutuluyor. Gerçek bir dağıtımda Alice'in gönderim logu
(`TransmitEvent` listesi) ayrı bir fiziksel sistemden, bir dosya veya klasik
kanal mesajlaşma protokolü üzerinden içeri aktarılmalıdır —
`TimeTagCorrelator.correlate(alice_events, bob_clicks, ...)` bu iki listeyi
NASIL elde ettiğinizi bilmez, yalnızca ikisini de zaman damgasına göre
sıralanmış olarak bekler.

## Veri sözleşmesi — neden `SiftingResult` alanları JS tarafıyla paralel

`SiftingResult` (`qber`, `sifted_key_bits`, `lost_count`, `eavesdrop_detected`,
`match_rate`, `detected_count`, `dark_click_count`) alan isimleri,
`PhotonNet2.jsx`'teki `deriveSiftedKey()`'in döndürdüğü şekille **bilerek
paralel** tutuldu. `bridge_server.py` bunu JSON'a çevirip gönderdiğinde,
PhotonNet UI'daki BB84 log satırları/QBER rozeti gibi tüketiciler ek dönüşüm
olmadan anlayabilir — bu, `hal/` paketinin PhotonNet'in geri kalanına
"yabancı" hissettirmemesi için kasıtlı bir tasarım kararı.

## Bilinen sınırlamalar

- `LinkManager`'ın sürekli akış yolu (`/api/connect` → `/api/stream`), demo
  amaçlı düşük bir kaynak hızı (`DEMO_SOURCE_RATE_HZ = 4000 Hz`) kullanır —
  gerçek kaynak hızını (80 MHz) saf Python'da sürekli üretmeye çalışmak
  pratik olarak donar (gerçek donanımda bu iş FPGA/özel silikonda yapılır,
  Python yalnızca sonuçları okur). Yüksek-doğruluklu tek-seferlik sonuç
  isteyen bir UI için `/api/acquire` kullanılmalıdır — o, varsayılan 80 MHz
  `AcquisitionConfig`'i kısa/sınırlı pencerelerde kullanır.
- `click_queue`, `/api/clicks` düzenli olarak drenaj edilmezse büyür — bir üst
  sınırla (`maxsize=200_000`) ve en-eskiyi-düşürme davranışıyla korumaya
  alındı, ama uzun süreli bağlantılarda `/api/clicks`'i periyodik çağırmak
  önerilir.
- `SerialTransport`/`SerialHardware`, GERÇEK pyserial veya gerçek bir seri
  port üzerinden test EDİLEMEDİ (bu sandbox'ta ne `pyserial` kurulabiliyor
  ne fiziksel bir port var). Ama kodun kendisi iki ayrı yoldan doğrulandı:
  paylaştığı protokol mantığı (`BinaryClickHardware`) `TCPHardware`
  üzerinden gerçek bir soket bağlantısıyla (`test_binary_click_
  hardware.py`), `SerialTransport`'a ÖZGÜ `read()` toplama döngüsü ise
  sahte bir `pyserial` enjeksiyonuyla (`test_serial_hardware_mock.py`)
  uçtan uca test edildi — bkz. [Gerçek donanım olmadan ne test edildi, ne
  edilemedi](#gerçek-donanım-olmadan-ne-test-edildi-ne-edilemedi). Gerçek
  donanım makinesinde `pip install pyserial` sonrası, gerçek bir cihaza
  karşı ayrıca doğrulanmalıdır.
- `SerialTransport.read(n, timeout_s)`, `TCPTransport.read()`'in aksine `n`
  bayt birikene KADAR veya zaman aşımına kadar bekler — tek bir okuma
  çağrısıyla erken dönmez. Sonuç olarak Serial tabanlı bir sürücüde
  `read_clicks(timeout_s=X)` neredeyse HER ZAMAN `X` saniyeye yakın sürer
  (veri erken tükense bile), TCP tabanlı bir sürücüde ise veri tükenince
  erken dönebilir. Bu bir hata değil — `LinkManager`'ın istediği "gerçekten
  `timeout_s` kadar blokla" davranışını Serial için DOĞAL olarak sağlıyor
  (bkz. `test_serial_hardware_mock.py` başlığındaki "İLGİNÇ BULGU" notu).
- `binary_click_hardware.py`'deki referans protokol, kontrol komutlarını
  (ARM/STATUS) ve ikili click akışını AYNI bağlantı üzerinde karıştırır —
  bu yüzden `status()`, akış başladıktan (`arm()`'dan) SONRA artık canlı
  bir sorgu göndermez, yalnızca `arm()` sırasında (akış başlamadan hemen
  önce) alınan son bilinen durumu döndürür. Gerçek vendor protokolünüz
  kontrol/veri kanallarını düzgün ayırıyorsa (örn. ayrı bir port/soket ile)
  bu kısıtlamayı kaldırabilirsiniz — bkz. `binary_click_hardware.py`
  başlığındaki "BİLİNEN BASİTLEŞTİRME" notu.
