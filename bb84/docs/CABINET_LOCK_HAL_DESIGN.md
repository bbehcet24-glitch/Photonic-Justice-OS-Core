# Kabin Kilidi HAL'i — Tasarım Belgesi

Kod: `bb84/cabinet_lock_hal.js` · Koordinatör kancaları: `maintenance_traffic_coordinator.js` (`authorizeDoor`, `onLockEvent`, `clearIncident`) · Öz-testler: `bb84/cabinet_lock_hal_test.js` (7/7, ~2 s) · Rapor: `bb84/reports/cabinet_lock_hal.json`

## §0 — Amaç ve dürüstlük notu

İstek, M4 testindeki `doorMayOpen()` kararını, `production_gate.js` adımından önce, gerçek bir akıllı kilide ya da kilit API'sine bağlayacak simüle bir donanım arayüzü (HAL) kurmaktı.

Projede kilit donanımı yok. Bu yüzden kurduğum şey bir **sözleşme**, bu sözleşmeye uyan **simüle bir kilit**, simüle kilidi sunan **gerçek bir HTTP API** ve bu API'ye bağlanan bir **sürücü**. Belirli bir üreticinin API'sini taklit etmiyor; uç noktalar bu projenin kendi tasarımı. Tasarım, `hal/hardware_interface.py` ile aynı ilkeyi izliyor: arayüz küçük ve vendor'dan bağımsız. Gerçek bir kilit eklemek için `CabinetLockHAL`'den türetilmiş tek bir sınıf yazmak yeterli; koordinatör, ağ ve testler değişmiyor.

`photonnet_core.js` değiştirilmedi. SHA-256 değeri `8f879fde…dc7b05`; ağ katmanı, karar katmanı ve KME sunucusuyla birlikte test öncesi ve sonrasında doğrulanıyor.

## §1 — Akış

```
PrognosticsMonitor ──uyarı──▶ MaintenanceTrafficCoordinator ──ipuçları──▶ ShieldedQkdNetwork
                                   │  doorMayOpen (pencere + plan düğümü bıraktı)
                                   ▼
                         UnlockGrantAuthority (Ed25519 ÖZEL anahtar)
                                   │  imzalı, kısa ömürlü, tek kullanımlık belge
                                   ▼
             CabinetLockHAL ── InProcessLockAdapter | HttpLockAdapter ──HTTP──▶ SimulatedLockApiServer
                                                                                    │
                                                         SimulatedSmartLock (yalnız AÇIK anahtar)
                                                                   │ kapı sensörü (reed, 5 ms)
                     onLockEvent ◀── UNLOCKED / DOOR_OPENED / TAMPER / OVERRIDE / RELOCKED
                         │ yetkisiz → INCIDENT → anında yeniden planlama (SE örneği beklenmez)
```

**Sözleşme (`CabinetLockHAL`).** Dört metot tanımlar: `requestUnlock(nodeId, grant)`, `lock(nodeId)`, `status(nodeId)` ve `pollEvents(nodeId, sinceSeq)`. Hepsi Promise döndürür. İki sürücü var:

- **`InProcessLockAdapter`:** simülasyon zamanıyla çalışır.
- **`HttpLockAdapter`:** HTTP üzerinden konuşur; zaman aşımına uğrarsa kilidi "KİLİTLİ varsayılır" kabul eder.

## §2 — Güvenlik kararları

**Açma yetkisi.** Yetki, Ed25519 ile imzalanmış bir belgedir. İçeriği:

- `nodeId`, `workOrderId`, `technicianId`
- `nbf` / `exp` (geçerlilik başlangıcı ve sonu)
- `nonce`
- `attestation: { drained: true, planCheckedAtMs }` (boşaltıldı beyanı)

Koordinatör bu belgeyi yalnızca `doorMayOpen()` doğruyken üretir: pencere başlamış ve ağın yürürlükteki planı düğümü kullanmıyor olmalıdır. Kilit yalnızca **açık** anahtarı tutar. Bu yüzden ele geçirilen bir kilitten yetki üretilemez.

**Kilit tarafında bağımsız doğrulama.** Kilit belgeyi kendisi yeniden denetler; aşağıdakilerden herhangi biri başarısız olursa kilitli kalır:

- imza,
- tür ve sürüm,
- düğüm eşleşmesi,
- zaman penceresi (±2 s saat kayması toleransıyla),
- kilit tarafındaki azami belge ömrü (10 dk),
- nonce'un daha önce kullanılmamış olması,
- boşaltma beyanının tazeliği (≤ 5 s),
- kapının o an kapalı olması.

Nonce, eyleyici sonucundan bağımsız olarak harcanır. Böylece aynı belgeyle ikinci bir deneme yapılamaz.

**Fail-secure davranış.** Aşağıdaki durumların hepsinde kapı kilitli kalır:

- Eyleyici arızası → `UNLOCK_FAILED` olayı.
- İletişim kopması veya API zaman aşımı → sürücü "KİLİTLİ varsayılır" döner.
- Kapı açma penceresi (30 s) içinde açılmazsa → kilit kendiliğinden yeniden kilitlenir.

**Bağımsız kapı sensörü.** Reed kontağı kilitten bağımsız çalışır ve iki yetkisiz açılış türünü raporlar:

- Kilitliyken zorla açma → `TAMPER`.
- Mekanik acil anahtar → `OVERRIDE`.

Mekanik acil anahtar **engellenmez**. Kabinlerde acil erişim ve insan güvenliği ihtiyacı gerçektir; bu yüzden kilit bunu durdurmaz, yalnızca raporlar.

Koordinatör yetkisiz bir açılış gördüğünde düğümü `INCIDENT` durumuna alır. Düğüm o anda ağdan çıkarılır ve ancak `clearIncident` çağrılınca geri döner. Ağ, SE izleyicisinin bir sonraki örneğini beklemeden olay anında yeniden planlanır (olay-tetikli ara adım; ağ düzensiz adım aralığını zaten destekliyordu).

## §3 — Sonuçlar

| Test | Sonuç |
|---|---|
| H1 belge kriptografisi | Geçerli belge kabul edildi. Reddedilen 10 durumun hepsinde kilit KİLİTLİ kaldı: kurcalanmış içerik, sahte anahtar, başka düğüm, nbf, exp, aşırı ömür, beyan yok, bayat beyan, çözülemeyen belge, tekrar |
| H2 kilitleme şartı | Koordinatör iki aşamada yetkiyi reddetti: "pencere başlamadı" → "ağ planı hâlâ kullanıyor". Kilitli kapı açılamadı. Plan yenilendikten sonra yetki verildi, kilit açıldı, giriş yetkili oldu |
| H3 fail-secure | Sıkışık eyleyicide kapı açılamadı. Açılmayan kapı 30 s sonra yeniden kilitlendi. Yanıtsız API'de istemci 400 ms zaman aşımıyla "KİLİTLİ varsayılır" döndü |
| H4 gerçek HTTP API | `POST unlock` 200 döndü. Olaylar HTTP üzerinden alındı (UNLOCKED, DOOR_OPENED, DOOR_CLOSED, RELOCKED). Tekrar kullanılan ve sahte imzalı belgeler 403 aldı |
| H5 zorla açma (40 deneme) | Kafes açıkken KDK'dan geçen bit: yalnız SE izleyicisiyle ortalama 4365, en çok 7827; kapı sensörü ve olay-tetikli planlamayla ortalama 787, en çok 800 (160 bit/ms × 5 ms). INCIDENT 40/40 |
| H6 koordineli bakım + acil anahtar | Kafes açıkken KDK'dan geçen bit 0. Bakım sonrası düğüm NORMAL. Acil anahtar → OVERRIDE → INCIDENT; aynı adımda düğüm plan dışına alındı, inceleme sonrası NORMAL |

H5'in gösterdiği şu: **zorla açmada maruziyet sıfır değildir.** Kapı sensörü maruziyeti ortalama ~5,5 kat düşürür, ama yalnızca sensör gecikmesine kadar. Sıfır maruziyet ancak planlı, yetkili girişte (H6) elde edilir.

## §4 — Sınırlar

- **Simülasyon kapsamı.** Kilit, kapı fiziği ve sensör gecikmesi simüle edildi. 5 ms gecikme, 30 s açma penceresi ve 10 dk azami belge ömrü varsayımdır.
- **Taşıma katmanı.** Simüle API düz HTTP konuşuyor (127.0.0.1). Gerçek dağıtımda mTLS gerekir; `pki_tools` ile aynı CA kullanılabilir. Yetkilendirme şu anda yalnızca imzalı belgeye dayanıyor.
- **Olay alma yöntemi.** Olaylar sorgulamayla (polling) alınıyor. Gerçek kilitlerde genellikle push (webhook/MQTT) bulunur. Sorgulama aralığı H5'teki kazancı küçültür; sensör olayının koordinatöre ulaşma gecikmesi burada 5 ms varsayıldı.
- **Anahtar yönetimi.** Yetki makamının özel anahtarı test sırasında bellekte üretiliyor. Gerçek dağıtımda HSM'de tutulmalıdır (projede SoftHSM/PKCS#11 yolu mevcut).
- **Bağlanmayanlar.** `production_gate.js` ve CI'a hâlâ bağlı değil.
