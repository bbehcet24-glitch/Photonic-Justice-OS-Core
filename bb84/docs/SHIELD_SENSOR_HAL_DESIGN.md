# Kalkan Sensör HAL'i ve Veri Besleme Mock'ları — Tasarım Belgesi

Kod: `bb84/shield_sensor_hal.js`.

Küçük kancalar:

- `multinode_shielding_network.js`: `meas.y0Invalid` değerini karar katmanına iletir.
- `adaptive_shielding_mitigation.js`: `y0Invalid` gelen aralığı lekeler.
- `mesh_isolation.js`: NaN oranı kanıt saymaz.

Öz-testler üç parça halinde; raporları `bb84/reports/shield_sensor_*.json` altında.

| Test dosyası | Kapsam | Sonuç |
|---|---|---|
| `shield_sensor_physics_test.js` | Fiziksel senaryolar ve uçtan uca akış | 8/8 |
| `shield_sensor_faults_test.js` | Sensör arızaları | 9/9 |
| `shield_sensor_transport_test.js` | Kayıt/oynatma ve HTTP cihazı | 8/8 |

## §0 — İstek ve yerleşim kararı

İstek, `extract_core.js` ya da HAL katmanındaki gerçek dB/kalkan verilerini simüle eden veri besleme fonksiyonlarıydı.

**`extract_core.js` uygun yer değil.** Bu dosya yalnızca `PhotonNet2.jsx`'ten `photonnet_core.js`'i üreten bir derleme aracı. Oraya veri beslemesi eklemek çekirdeğin SHA-256'sını (`8f879fde…dc7b05`) değiştirirdi.

**Python `hal/` da uygun yer değil.** O katman foton click akışını taşıyor. dB/kalkan verisini tüketen her şey ise JS tarafında: karar katmanı, ağ, mesh izolasyonu ve kestirimci bakım.

Bu yüzden besleme, kabin kilidi HAL'iyle aynı desende JS tarafında kuruldu: bir sözleşme, ona uyan mock sürücüler ve gerçek bir HTTP cihaz simülatörü. Gerçek bir sensör geldiğinde yalnız `ShieldSensorHAL`'den türeyen tek bir sürücü sınıfı eklenir; tüketiciler değişmez.

## §1 — Akış

```
PhysicalShieldModel (gerçek değerler, t'nin saf fonksiyonu)
        │  kapı · conta yaşlanması · RF verici · dedektöre giriş (rogueRf) · fibere enjeksiyon · termal döngü
        ▼
MockShieldSensorDriver ── sensör gürültüsü (σ 0,3 dB), 0,1 dB nicemleme, 0–100 dB aralık/doyma,
        │                  Y0 = Poisson(Y0·1e8)/1e8, ARIZA enjeksiyonu
        │   ReplayShieldSensorDriver (JSONL/CSV) · HttpShieldSensorDriver ⇄ SimulatedSensorDeviceServer
        ▼  Frame[] (v1)
SensorFrameValidator ── KAPALI-BAŞARISIZ: geçersiz → NaN, Y0 doğrulanamadı → y0Invalid
        ▼
ShieldSensorFeed.read(t) → { meas:{se, y0, y0Invalid, ambient, probe}, env, quality, rejects }
        ├─▶ ShieldedQkdNetwork.step(t, {se, y0, y0Invalid}, hints)
        ├─▶ MeshIsolationController.update(t, {se, y0, ambient, probe})
        └─▶ PrognosticsMonitor.ingest(saat, ShieldSensorFeed.prognosticsSample(r, düğüm))
```

**Çerçeve (v1).** Her düğüm her örnekte bir çerçeve gönderir:

```
{ v:1, nodeId, seq, tMs, se:[{id, db, sat}], ambient:{dbuvm, sat}, env:{tempC, rh, vibGrms}, probeDb?, y0:{linkKey: Y0} }
```

`y0` alanı yalnız düğümün **alıcı** olduğu linkleri içerir, çünkü Y0'ı alıcının dedektörü ölçer. Doğrulayıcı başka linkler için gelen Y0'ı yok sayar.

**Tekrarlanabilirlik.** Gürültü sayaç-tabanlı bir RNG ile üretilir: aynı (tohum, düğüm, kanal, örnek) her zaman aynı değeri verir. Böylece değerler zamanın saf fonksiyonudur; kayıt/oynatma ve HTTP yolu birebir aynı çıktıyı verir (R1, R2, H1).

## §2 — Doğrulayıcı kuralları

| Durum | Karar | Neden |
|---|---|---|
| Çerçeve yok / sürücü istisnası / HTTP hatası | Tüm alanlar NaN | Veri yoksa en kötü varsayılır |
| `seq` tekrarı ya da geri gitmesi | Çerçeve reddedilir | Yeniden oynatılan eski ölçüm |
| `tMs` > alım + 50 ms | Reddedilir | Saat kayması; geleceğe ait veri olamaz |
| Alım − `tMs` > 150 ms | Reddedilir ("bayat") | Tampon gecikmesi bir sızıntıyı gizleyebilir |
| SE aralık dışı (< 0 ya da > 100 dB, NaN) | O sensör geçersiz | Fiziksel olarak imkânsız |
| SE doymuş (tavanda) | **Alt sınır olarak kabul** | Gerçek değer en az bu kadar; muhafazakâr yön |
| Ortam alanı doymuş | **Geçersiz** | Alanı düşük gösterir → beklenen Y0 düşer → güvensiz yön |
| 40 özdeş örnek (2 s) | Takılı → geçersiz | Gürültülü sensör tekrar etmez |
| İki SE sensörü | Küçüğü kullanılır; fark > 3 dB, ≥ 1 s sürerse bayrak | Muhafazakâr; kayan sensörü yakalar |
| Y0 yok / aralık dışı / takılı | `y0Invalid = true` → blok lekelenir | Parametre tahmini doğrulanamadan anahtar serbest bırakılmaz |

## §3 — Testlerin bulduğu iki kapalı-başarısızlık açığı

**1. Y0 telemetrisi kesikken anahtar serbest bırakılıyordu (F6).** Karar katmanı, ölçülmüş Y0 yoksa içeri-giriş modelinin Y0'ına düşüyordu. SE normal göründüğü için seviye NORMAL kalıyor ve blok serbest bırakılıyordu. Test senaryosu: ATS'nin Y0 telemetrisi 5 s kesik ve aynı anda KDK→ATS fiberine ×5 enjeksiyon var. Bu durumda gerçek Y0'ın beşte biriyle hesaplanan **14,5 Mbit** anahtar serbest bırakıldı.

Düzeltme şöyle çalışıyor: doğrulayıcı `y0Invalid` bayrağı üretir, ağ bu bayrağı iletir, denetleyici de o aralığı lekeler. Sınırdaki iki blok dahil 7 blok lekeleniyor ve 0 bit serbest bırakılıyor. Bayrak verilmeyen eski çağıranlarda davranış birebir aynı; tüm regresyonlar geçiyor.

**2. NaN oran temiz kanıt sayılıyordu (F7).** Ortam sensörü yokken beklenen Y0 hesaplanamıyor ve oran NaN çıkıyor. `attributeEvidence` filtresi yalnız `null`'ı eliyordu; NaN filtreyi geçip **temiz bağımsız kanıt** gibi sayılıyordu. Önceki kodla aynı senaryo çalıştırıldı: kilit olayıyla karantinaya alınan KDK 31,05 s'de PROBATION'a geçti. Artık NaN kanıt sayılmıyor ve düğüm serbest bırakılmıyor.

## §4 — Dürüst bulgular (testlerde ölçüldü, düzeltilemez ya da donanım gerektirir)

- **Takılı tek sensör bir sızıntıyı geç gösterir (F3).** Takılma ancak 40. özdeş örnekte (2 s) algılanabiliyor. Bu süre içinde açılan bir kapı ~1,45 s geç görülüyor. İkinci bir SE sensörü kapıyı rampa sırasında görüyor (2,6 s).
- **Tek sensörde yukarı kayma algılanamaz (F5).** Contanın 12 dB kaybı, +0,4 dB/s kayan bir sensörle tamamen maskelendi: ölçüm 12,4 dB iyimser kaldı ve hiçbir kural bunu yakalamadı. Çift sensörde uyuşmazlık bayrağı 10,65 s'de kalktı; küçük okuma kullanıldığı için hata en çok 0,98 dB'de kaldı.
- **Fiziksel model döngüseldir.** Mock'un Y0 üretimi, tüketicinin beklenen-Y0 modeliyle (`ingressEffectiveY0`) aynı. Dolayısıyla "model doğruysa çalışır" testi döngüsel. `ingressMismatchDb` parametresiyle gerçek dünyanın modelden sapması enjekte edilebilir, ama bu gerçek saha verisinin yerini tutmaz.
- **Y0 pencereleri bağımsız üretilir.** 1 s'lik vakum penceresi her örnekte bağımsız üretiliyor. Gerçek kayan bir pencere geçişleri yumuşatır; bir kapı açılışı Y0'da burada olduğundan daha yavaş görünür.
- **Sensör parametreleri varsayımdır.** σ, nicemleme, aralık, 150 ms tazelik, 40 örnek ve 3 dB / 1 s değerleri belirli bir cihazın veri sayfasından alınmadı.
- **HTTP katmanı.** Simüle cihaz düz HTTP konuşuyor ve sorgulama (polling) ile çalışıyor. Gerçek dağıtımda mTLS ve push (MQTT / webhook) gerekir.

## §5 — Kullanım

```js
const S = require("./shield_sensor_hal.js");
const model = new S.PhysicalShieldModel({ topology, ingress, events: [{ kind: "door", node: "KDK", startMs: 5000, durMs: 10000 }] });
const driver = new S.MockShieldSensorDriver({ model, seed: 9, sensors: { KDK: { dualSe: true, probe: true } },
  faults: [{ kind: "stuck", node: "KDK", field: "se", sensor: "A", startMs: 2000 }] });
const feed = new S.ShieldSensorFeed({ driver, validator: new S.SensorFrameValidator({ topology }) });
const r = await feed.read(t);
net.step(t, { se: r.meas.se, y0: r.meas.y0, y0Invalid: r.meas.y0Invalid }, mesh.update(t, r.meas));
```

**Kayıt.** Herhangi bir sürücünün çerçeveleri `FrameRecorder` ile kaydedilebilir (`toJsonl()` / `toCsv()`). Kayıt `ReplayShieldSensorDriver` ile adım adım ya da `play({speed})` ile gerçek zamanlı oynatılır. İleride gerçek sensör kaydı da aynı yoldan oynatılır.

**HTTP cihazı.** `SimulatedSensorDeviceServer` herhangi bir mock sürücüyü `GET /v1/frames?t=` uç noktasıyla sunar. `server.mode` alanıyla şu arızalar enjekte edilebilir: `latency`, `http503`, `malformed`, `truncated`, `hang`.

## §6 — Bağlanmayanlar

- `production_gate.js` ve CI'a bağlı değil.
- Çok-düğümlü test ağının gerçek süreç aşaması (L-testleri) hâlâ kendi iz üreticisini (`buildTraces`) kullanıyor; bu beslemeye taşınmadı.
- Kestirimci bakım için yalnız örnek biçimi (`prognosticsSample`) sağlandı. Aylar süren saatlik bir zincir bu besleme üzerinden test edilmedi.
