# Dedektör Profili Mimarisi — tek `config.json`, dinamik seçim

## 1. Sorun

Çekirdek v2 ile ağ katmanları farklı dedektör varsayıyordu ve bu, kodun dağınık sabitlerinde gizliydi:

| Yer | Varsayım | Nasıl yazılmıştı |
|---|---|---|
| `photonnet_core.js` `DetectorNoiseModel` / `NoiseGateMiddleware` | SNSPD, 50 Hz karanlık sayım, 12,5 ns pencere | `DETECTOR_DARK_RATE_HZ`, `SOURCE_GATE_WIDTH_S` sabitleri |
| `photonnet_core.js` `deriveSiftedKey` | dedektör verimi örtük olarak 1 (hiç uygulanmıyordu) | — |
| `multinode_shielding_network.js` `linkEta` | InGaAs, verim %10 | `detectorEfficiency = 0.1` varsayılanı |
| `adaptive_shielding_mitigation.js`, `mesh_isolation.js`, `shield_sensor_hal.js` | InGaAs, Y0 = 10⁻⁵ | `baseY0: 1e-5` varsayılanları |
| `hal/types.py` `AcquisitionConfig` | 50 Hz | `dark_count_rate_hz = 50.0` |

Sonuç: anahtar InGaAs modelinde ~112 km'de sıfırlanırken çekirdek SNSPD'yle çok daha uzağa gidiyordu.
İkisi de kendi içinde tutarlıydı, ama aynı ağ için iki farklı dedektör anlatıyordu.

## 2. Hedefler

1. **Tek kaynak:** dedektör sayıları yalnızca depo kökündeki `config.json` dosyasında yazılır.
   Kodda hiçbir dedektör sayısı kalmaz (yalnızca doğrulama sınırları kalır).
2. **Dinamik seçim:** etkin profil çalışma anında değiştirilebilir. Bunun yolları:
   - Node'da `PHOTONNET_DETECTOR` ortam değişkeni,
   - tarayıcıda `?detector=` URL parametresi,
   - arayüz seçicisi,
   - API'de `setActiveDetectorProfile(id)`.
3. **Fail-closed:** eksik, bozuk ya da tanınmayan yapılandırma sessizce varsayılana düşmez, açık bir hata verir.
   Bilinmeyen bir anahtar (yazım hatası) da reddedilir.
4. **Çekirdek hash'i yapılandırmadan bağımsızdır:** `config.json` değişince `photonnet_core.js`
   yeniden üretilmez. Değerler çalışma anında okunur, çekirdeğe gömülmez.
5. **Çevrimdışı çalışma:** `PhotonNet_offline.html` dosyası `file://` ile açıldığında da çalışır.
   Yapılandırma derleme sırasında HTML'e gömülür.
6. **Diller arası tutarlılık:** Python HAL aynı dosyayı aynı kurallarla okur.
   JS ve Python'un türettiği değerlerin aynı olduğu test edilir.

## 3. `config.json` şeması (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "detector": {
    "active": "snspd",
    "profiles": {
      "snspd":  { "label": "…", "technology": "snspd", "efficiency": 0.80,
                  "darkCountRateHz": 50, "detectionWindowS": 1.25e-8,
                  "provenance": "assumption", "sources": ["…"], "notes": "…" },
      "ingaas": { "label": "…", "technology": "ingaas-spad", "efficiency": 0.10,
                  "darkCountProbPerWindow": 1e-5, "detectionWindowS": 1e-9,
                  "provenance": "assumption", "sources": ["…"] }
    }
  }
}
```

### Alan kuralları

| Alan | Zorunlu | Kural |
|---|---|---|
| `label` | evet | boş olmayan metin |
| `technology` | evet | `snspd` ya da `ingaas-spad` |
| `efficiency` | evet | (0, 1] aralığında sonlu sayı |
| `detectionWindowS` | evet | (0, 1e-6] aralığında, saniye cinsinden |
| `darkCountRateHz` / `darkCountProbPerWindow` | **tam olarak biri** | Hz için ≥ 0 sonlu; olasılık için [0, 1) |
| `provenance` | evet | `assumption` ya da `measured` |
| `measuredAt` | yalnız `measured` ise | ISO tarih |
| `sources` | evet | en az bir kaynak metni |
| `notes` | hayır | metin |

Bunların dışındaki her anahtar reddedilir. `detector.active` alanı `profiles` içindeki bir kimliğe karşılık gelmelidir.

### Türetilen değerler

Kullanıcı bu değerleri yazmaz; yükleyici hesaplar:

- `darkCountProbPerWindow = 1 − exp(−darkCountRateHz · detectionWindowS)`: decoy modelindeki **Y0**, yani bir penceredeki boş tıklama olasılığı.
- `darkCountRateHz = −ln(1 − Y0) / detectionWindowS`: `NoiseGateMiddleware`'in Hz cinsinden çalışan kalibrasyonu için.

Hangisi yazılırsa yazılsın iki değer birbirinin tam tersi işlemdir. JS ve Python aynı formülle hesaplar.

## 4. Değer seçimi ve kaynaklar

Her iki profilin değerleri de **varsayımdır, ölçülmedi** (`provenance: "assumption"`).

**SNSPD.** Ticari bir SNSPD broşürü (ID Quantique ID281) şunları verir:
- tepe sistem verimi %80–95,
- 1300–1600 nm'de karanlık sayım < 100 cps ile < 1 cps arası,
- jitter tipik < 30 ps,
- toparlanma süresi tipik < 30 ns.

Profil bu aralıkların temkinli ucunu seçer: verim %80, karanlık sayım 50 Hz (çekirdek v2 değeri).
Pencere, çekirdek v2 ile aynı kalsın diye 12,5 ns'dir (80 MHz kaynağın tam periyodu). Bu en kötü durumdur;
gerçek bir sistem jitter'a göre çok daha dar bir pencere kullanır.

**InGaAs.** 200 MHz kapılı bir InGaAs/InP SPAD ölçümü (arXiv:1105.3760) şunları verir:
- %10 verimde kapı başına 4·10⁻⁶ karanlık sayım,
- etkin pencere 200 ps,
- %6,4 verimde %6,3 afterpulse.

Profil, katmanların kalibre edildiği Y0 = 10⁻⁵ değerini kullanır. Bu, ölçümden 2,5 kat kötüdür, yani temkinlidir.
Profilde 1 ns pencere ve %10 verim vardır.

**Modellenmeyenler:** afterpulse, ölü zaman ve InGaAs'ın sıcaklık davranışı. `NoiseGateMiddleware`'in
termal sürüklenme modeli SNSPD'ye göre kurulmuştur ve iki profile de aynı uygulanır. Bu bilinen bir sınırdır.

## 5. Mimari

```
                 config.json  (tek kaynak, depo kökü)
                      │
      ┌───────────────┼──────────────────────────┐
      │ Node: require │ derleme: build_photonnet_html.js
      │ (çalışma anı) │ doğrular + <script> olarak gömer
      ▼               ▼                          ▼
 photonnet_core.js  PhotonNet.html / _offline.html   hal/detector_profile.py
 DetectorProfiles   window.__PHOTONNET_CONFIG__      (aynı kurallar, Python)
  ├ validateDetectorConfig(cfg)  → normalize + dondur, hata → TypeError/RangeError
  ├ activeDetectorProfile()      → { id, efficiency, darkCountRateHz, darkCountProbPerWindow, detectionWindowS, … }
  ├ setActiveDetectorProfile(id) → bilinmeyen id → hata; NoiseGate profile göre sıfırlanır; dinleyiciler çağrılır
  ├ listDetectorProfiles(), onDetectorProfileChange(fn), configureDetectorProfiles(cfg)
      │
      ├─ DetectorNoiseModel / NoiseGateMiddleware : karanlık sayım + pencere profilden
      ├─ deriveSiftedKey (detectorCtx verilince)  : verim + karanlık sayım profilden
      │     detectorCtx.detectorProfile = "<id>" ile çağrı başına seçim de mümkün
      └─ bb84/detector_profile.js (Node köprüsü) ─► linkEta (verim), adaptif/mesh/sensör HAL (baseY0)
```

### Etkin profilin seçim önceliği

İlk eşleşen kazanır:

1. `setActiveDetectorProfile(id)`: arayüz seçicisi ya da test.
2. Çağrı başına `detectorCtx.detectorProfile`. Bu yalnız o çağrıyı etkiler, küresel durumu değiştirmez.
3. Node'da `PHOTONNET_DETECTOR`; tarayıcıda `?detector=`.
4. `config.json` → `detector.active`.

Hangi adımda olursa olsun, bilinmeyen bir kimlik hata verir. Başka bir profile düşülmez.

### Çekirdek dosyası nasıl okunur

- **Tarayıcı:** önce `globalThis.__PHOTONNET_CONFIG__` aranır.
- **Node:** yoksa `PHOTONNET_CONFIG` yolu, o da yoksa `<çekirdek dizini>/../config.json` require edilir.
- **İkisi de yoksa:** ilk kullanımda açık bir hata verilir.

### Geriye dönük uyumluluk

`deriveSiftedKey` `detectorCtx` olmadan çağrılırsa ideal dedektör modellenir: verim 1, karanlık sayım yok.
Bu v2 ile aynı davranıştır ve dedektör modellemeyen eski testler değişmez.

## 6. Testlerin profil bağımlılığı

InGaAs'a göre kalibre edilmiş sayıları doğrulayan testler (ör. SKR taraması S4: ~81/112/119 km) bunu artık
**açıkça beyan eder**. Dosyanın başında `setActiveDetectorProfile("ingaas")` çağrılır ve neden çağrıldığı yazılır.
Böylece "hangi dedektör için doğru?" sorusunun cevabı test dosyasında görünür.

Yeni `detector_profile_config_test.js` şunları doğrular:

- şema ve fail-closed kuralları,
- türetme formüllerinin iki yöndeki tutarlılığı,
- ortam değişkeniyle seçim,
- çekirdek ve katmanların aynı profilde birleşmesi,
- iki profil arasındaki fiziksel farkın yönü (SNSPD daha uzağa gider),
- JS ile Python'un aynı değerleri türetmesi,
- HTML'e gömülü yapılandırmanın `config.json` ile aynı olması.

### Ölçülen sonuçlar (çekirdek v3)

Sabitlenen testler `pinDetectorProfile("ingaas", …)` çağırır:

- `mesh_topology_transit_test`
- `mesh_quarantine_test`
- `mesh_optical_bypass_test`
- `shield_sensor_physics_test`
- `multinode_shielding_testbed`

Bu testler SNSPD ile koşturulduğunda başarısız oldu. Sebep hata değil, kalibrasyon farkıydı: ceza km'leri ve
menziller değişiyor, testbed S8'de eski sabit parametreli sistem de anahtar üretmeye devam ediyor. Bu yüzden
InGaAs'a sabitlendiler. `skr_distance_sweep_test` ise artık iki profili de aynı kodla tarıyor.
Ters yönde, `core_v2_fixes_test` SNSPD'ye sabitlendi (`pinDetectorProfile("snspd", …)`). Sebebi: 85 km'de
%10 verimle aynı darbe sayısı çok küçük bir QBER örneklemi veriyor. Sabitlemelerden sonra tam regresyon
iki profilde de koşturuldu: varsayılan (SNSPD) ve `PHOTONNET_DETECTOR=ingaas`.

| Ölçüm | SNSPD (η %80, Y0 6,25·10⁻⁷) | InGaAs (η %10, Y0 10⁻⁵) |
|---|---|---|
| Decoy modelinde en uzun mesafe, N = 10⁸ / 10¹⁰ / 10¹² | 144 / 203 / 221 km | 81 / 112 / 119 km |
| 0 km gizli anahtar hızı, N = 10¹⁰ | 36,5 Mbps | 4,08 Mbps |
| Çekirdekte 10 km algılama sayısı oranı | 8,08 (beklenen 8) | — |
| 50 km tek hat, mesaj iletimi | teslim, 131 072 darbe | teslim, 917 504 darbe |
| Arayüz, IST→BAG zinciri | teslim, 212 992 darbe/link | teslim, 1 048 576 darbe/link |

Bu sayıların hepsi config.json'daki **varsayılan** değerlerle hesaplandı, hiçbiri ölçülmedi.

## 7. Bu sürümde bağlanmayanlar (bilerek)

Bu dosyalar kendi başlıklarında belgelenmiş, bağımsız varsayımlarla çalışan test düzenekleridir:
`entanglement_hom_fidelity_sim.js`, `client_network_report.js`, `shielded_detector_physics.js`.
Sonraki adımda bunlar da aynı kaynağa bağlanmalıdır.

Hizalama hatasında da bir tutarsızlık sürüyor: çekirdek e_d = %1,5, katmanlar %2 kullanıyor. Bu bir dedektör
değil optik kanal özelliği olduğu için bu tasarımın kapsamı dışında bırakıldı. Aynı `config.json` dosyasında
bir `channel` bölümü olarak ele alınması önerilir.
