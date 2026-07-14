# PhotonNet KME — IBM Entegrasyonu İçin Üretime Hazırlık Yol Haritası

*Hazırlanma amacı: bu doküman, PhotonNet KME'nin (ETSI GS QKD 014 / mTLS)
IBM Quantum Network tarafıyla teknik entegrasyonunun MEVCUT durumunu,
bu duruma nasıl ulaşıldığını (canlı test kanıtlarıyla) ve üretim onayı
için KAPATILMASI gereken maddeleri tek bir yerde toplar. Her madde,
bu proje kapsamında yapılan gerçek test/analiz çalışmalarına
(mock_ibm_client.js'in 19 testi, CI/CD boru hattı, sertifika rotasyon/
iptal senaryo analizi) dayanır — varsayımsal bir kontrol listesi
DEĞİLDİR.*

## Önceliklendirme

| Seviye | Anlamı |
|--------|--------|
| **P0 — Engelleyici** | Herhangi bir üretim/canlı trafik ÖNCESİNDE kesin olarak kapatılmalı. Bu maddeler olmadan onay beklenmemelidir. |
| **P1 — GA öncesi gerekli** | Sınırlı/pilot kullanımdan genel kullanılabilirliğe (GA) geçmeden önce tamamlanmalı. |
| **P2 — Önerilen iyileştirme** | Üretimi engellemez, ama IBM'in güvenlik/operasyon ekiplerinin gözden geçirmesinde muhtemelen soru olarak çıkar. |

## Özet Tablo

| # | Madde | Öncelik | Kanıt / gerekçe | Tahmini efor |
|---|-------|---------|------------------|---------------|
| 1 | Referans OCSP yanıtlayıcısını üretim sınıfı bir çözümle değiştir | P0 | S5: kalıcı bağlantıda azami kilitlenme ~60sn ölçüldü | Orta (1-2 hafta) |
| 2 | HSM/PKCS#11: yazılımsal soyutlama (SoftHSM2+Node-PKCS11) YAZILDI, CI'da doğrulanıyor; GERÇEK donanımla test hâlâ bekliyor | P0 | `ca_init.sh --pkcs11-uri`/`sign_csr.sh --engine pkcs11` artık gerçek kod (stub değil) — ama sandbox'ta hiç çalıştırılamadı, ilk doğrulama CI'da | Orta (donanım erişimine bağlı; yazılımsal katman tamam) |
| 3 | Bağımsız güvenlik denetimi / sızma testi | P0 | Şimdiye kadarki tüm doğrulama İÇ testlerdir | Yüksek (3. taraf gerekir) |
| 4 | Demo/header-tabanlı kimlik doğrulama geri-düşüşünün üretimde KAPALI olduğunu garanti eden dağıtım kontrolü | P0 | `etsi014_kme_server.js`'in kendi notu: bu mod "ÜRETİMDE KULLANILMAMALIDIR" | Düşük (1-2 gün) |
| 5 | OCSP yanıtlayıcısı için yüksek erişilebilirlik (HA) + izleme/alarm | P1 | S4: OCSP çökerse TÜM geçerli istemciler reddedilir (kasıtlı fail-closed, ama SPOF) | Orta (altyapıya bağlı) |
| 6 | PKI yönetişim dokümantasyonu (CP/CPS) | P1 | Şu an yalnızca kod yorumlarında dağınık kurallar var, resmî politika dokümanı yok | Orta (1 hafta, hukuki/uyum girdisi gerekebilir) |
| 7 | Operasyonel olay müdahale runbook'u | P1 | Sızıntı/OCSP kesintisi/CRL bozulması için adım adım prosedür yok | Düşük-Orta (3-5 gün) |
| 8 | Sertifika rotasyonunun otomasyonu (cron/systemd-timer) | P1 | `rotate_cert.sh` yalnızca ÖNERİYOR, otomatik ÇALIŞMIYOR | Düşük (2-3 gün) |
| 9 | CI/CD "external" modunun IBM'in GERÇEK staging KME'sine karşı fiilen çalıştırılması | P1 | Şu ana kadar yalnızca YAML söz dizimi + mantık doğrulandı, gerçek uçtan uca koşum YAPILMADI | Düşük (IBM tarafından ortam/secret sağlanınca ~1 gün) |
| 10 | OCSP negatif önbellek TTL'ini "unknown" yanıtı için kısalt | P2 | S2/9. madde: yeni sertifika nadiren ~30sn gecikebiliyor | Düşük (birkaç saat, kod değişikliği) |
| 11 | IBM istemci kütüphanesi için bağlantı yeniden-kullanım rehberi | P2 | `https.globalAgent` keepAlive:true bulgusu (madde 6, senaryo raporu) | Düşük (dokümantasyon) |
| 12 | Toeplitz Web Worker optimizasyonunun üretim yükü altında ayrı yük testi | P2 | Şimdiye kadarki test tek-tarayıcı/tek-oturum senaryosu | Düşük-Orta |

---

## P0 — Engelleyici maddeler (ayrıntı)

### 1. Referans OCSP yanıtlayıcısının değiştirilmesi
**Mevcut durum:** `pki_tools/run_ocsp_responder.sh`, openssl'in `ocsp` CLI
komutunu `-nrequest 1` döngüsünde yeniden başlatarak çalıştırıyor.
Sertifika rotasyon/iptal senaryo analizinde (S5), kalıcı bir mTLS
bağlantısı üzerinden yapılan izleme, bir iptalin GERÇEKTEN etkili
olmasının teorik ~30 saniye değil, ~60 saniyeye kadar sürebildiğini
CANLI olarak, üç ayrı çalıştırmada tekrarlanabilir şekilde gösterdi.
**Kabul kriteri:** Aynı S5 senaryosu, olay-tabanlı (event-driven) bir
OCSP yanıtlayıcısına karşı çalıştırıldığında azami kilitlenme süresi
tek bir önbellek döngüsünü (~30sn, ya da düşürülmüş TTL'e göre daha
az) AŞMAMALI.
**Önerilen çözümler:** Dogtag OCSP, EJBCA, cfssl `ocsprest`, veya
bulut sağlayıcısının yönetilen PKI/OCSP servisi.

### 2. HSM/PKCS#11 entegrasyonunun gerçek donanımla doğrulanması
**Güncellendi (14 Temmuz):** `ca_init.sh --pkcs11-uri` ve `sign_csr.sh
--engine pkcs11` artık GERÇEK, çalışan kod — önceki "yalnızca referans
komut yazdırıyor" stub'ı kaldırıldı. Yeni `bb84/pki_tools/hsm_init.sh`
bir SoftHSM2 (yazılımsal PKCS#11) token'ı kurar; CA anahtar çifti
`pkcs11-tool --keypairgen` ile DOĞRUDAN token içinde üretilir (ca-key.pem
dosyası hiç oluşmaz), CA sertifikası ve sonraki istemci sertifikaları
`openssl -engine pkcs11` ile token'daki anahtarla imzalanır. Ayrıca
`bb84/pki_tools/pkcs11_bridge.js` (pkcs11js), Node.js'in de AYNI token'a
doğrudan konuşup imzalama yapabildiğini kanıtlıyor. Bu kod SoftHSM2'ye
ÖZEL hiçbir şey içermez (yalnızca standart PKCS#11/openssl-engine
arayüzü) — gerçek donanıma geçiş yalnızca modül yolu/PIN değişikliğidir.

**Doğrulama durumu (dürüstlük notu):** Bu kod, geliştirme sandbox'ında
ağ kısıtı yüzünden SoftHSM2/OpenSC/pkcs11js hiç KURULAMADIĞI için orada
çalıştırılıp test EDİLEMEDİ — CI/CD'ye (`.github/workflows/
production-pipeline.yml`, "software-hsm-pkcs11" işi) eklendi ve İLK
GERÇEK doğrulaması, gerçek internet erişimi olan GitHub Actions
runner'ında olacak. Bu, projedeki DİĞER her şeyden (ki hepsi teslimattan
önce burada çalıştırılıp doğrulandı) farklı bir güvence seviyesidir —
CI'daki ilk çalıştırma yeşil olana kadar bu madde "yazıldı ama
doğrulanmadı" olarak ele alınmalıdır.

**Kalan kapsam (bu iş henüz KAPATMIYOR):** (a) gerçek donanım bir HSM
(YubiHSM/CloudHSM/vb.) ile doğrulama hâlâ yapılmadı — SoftHSM2 yazılımsal
bir emülasyondur, donanımın kendi fiziksel/yan-kanal güvence özellikleri
test edilmiş olmaz; (b) KME sunucusunun CANLI TLS dinleme soketi
(`https.createServer`) HSM'e bağlı DEĞİLDİR — yalnızca CA imzalama
operasyonları ve Node'un token'a genel bağlanabilirliği kanıtlandı, bu
daha büyük ve ayrı bir mühendislik çalışması olarak kalıyor.
**Kabul kriteri (güncellenmiş):** (1) production-pipeline.yml'in
"software-hsm-pkcs11" işi CI'da yeşil olmalı [şu an: ilk çalıştırma
bekleniyor], (2) gerçek bir donanım HSM ile aynı uçtan uca akış tekrar
doğrulanmalı, (3) CA özel anahtarının hiçbir noktada yerel diske
İNMEDİĞİ (yalnızca token içinde var olduğu) her iki ortamda da
kanıtlanmalı.

### 3. Bağımsız güvenlik denetimi
**Mevcut durum:** Tüm doğrulama bu proje ekibi tarafından yazılan
testlerle (mock_ibm_client.js, senaryo analizi) yapıldı — bunlar
DEĞERLİ ama İÇ testlerdir, kör noktaları olabilir.
**Kabul kriteri:** mTLS/PKI katmanı, ETSI 014 uygulaması ve KME sunucu
kodu üzerinde üçüncü taraf bir güvenlik değerlendirmesi/pentest
tamamlanmalı, bulunan KRİTİK/YÜKSEK bulgular kapatılmalı.

### 4. Demo kimlik doğrulama geri-düşüşünün üretimde kapalı olduğunun garantisi
**Mevcut durum:** `--ca` verilmediğinde sunucu, X-SAE-ID header +
statik bir Bearer token ile çalışan bir "demo modu"na düşüyor (kod
içinde "ÜRETİMDE KULLANILMAMALIDIR" diye işaretli). Bu şu an yalnızca
bir YORUM/dokümantasyon uyarısı — dağıtım sırasında bunu ZORUNLU
KILAN bir teknik kontrol (ör. `NODE_ENV=production` iken `--ca`
verilmezse süreç başlamayı REDDETSİN) yok.
**Kabul kriteri:** Üretim dağıtım script'i/konteyner imajı, mTLS
parametreleri eksikse KME sürecinin BAŞLAMAMASINI garanti etmeli.

---

## P1 — GA öncesi gerekli maddeler (ayrıntı)

### 5. OCSP yüksek erişilebilirlik + izleme
S4 senaryosu, OCSP yanıtlayıcısı erişilemez olduğunda sistemin
GÜVENLİ (fail-closed) ama TÜM istemcileri reddederek davrandığını
doğruladı — bu doğru bir güvenlik kararı ama tek örnekli bir
yanıtlayıcıyı tek nokta arızası (SPOF) yapıyor. Aktif-pasif veya
aktif-aktif bir dağıtım + sağlık kontrolü/alarm gerekir.

### 6. PKI yönetişim dokümantasyonu (CP/CPS)
Sertifika politikası (kim, hangi koşullarda sertifika alabilir),
sertifikasyon uygulama beyanı (CA nasıl işletilir, anahtar yaşam
döngüsü, iptal süreçleri) — bunlar şu an `pki_tools/` script'lerinin
yorum satırlarına DAĞILMIŞ durumda. Kurumsal bir partner (IBM), resmî,
tek bir doküman bekler.

### 7. Olay müdahale runbook'u
"Bir SAE sertifikası sızdı, ne yapılır" / "OCSP yanıtlayıcısı 3 saattir
çöktü, ne yapılır" / "CRL bozuldu, sunucu eski CRL'i mi kullanıyor"
gibi somut, adım adım prosedürler yazılmalı — şu an bu bilgi kod
yorumlarında (doğru ama dağınık) mevcut.

### 8. Rotasyon otomasyonu
`rotate_cert.sh` bitiş tarihinden ~2 gün önce bir rotasyon görevi
ÖNERİYOR ama bunu OTOMATİK ÇALIŞTIRAN bir cron/systemd-timer/K8s
CronJob entegrasyonu henüz yazılmadı.

### 9. CI/CD "external" modunun gerçek IBM ortamına karşı koşulması
`.github/workflows/production-pipeline.yml` ve `.gitlab-ci.yml`
içindeki "external-real-certs" işi, YAML söz dizimi ve
`run_integration_tests.sh`'in ortam değişkeni sözleşmesiyle
TUTARLILIK açısından doğrulandı — ama gerçek bir `KME_URL` + gerçek
IBM sertifikalarına karşı HİÇ ÇALIŞTIRILMADI (bu ortamda mümkün
değildi). IBM'in bir staging KME uç noktası sağlamasıyla bu işin en
az bir kez BAŞARIYLA koştuğu görülmeli.

---

## P2 — Önerilen iyileştirmeler

Bunlar üretimi engellemez ama gözden geçirme sırasında muhtemelen
gündeme gelir: OCSP `checkOcsp()`'teki "unknown" yanıtının negatif
önbellek TTL'inin kısaltılması (madde 9, senaryo raporu); IBM'in
istemci kütüphanesi için HTTP bağlantı yeniden-kullanımı konusunda bir
rehber notu (madde 6, senaryo raporu — `https.globalAgent`
`keepAlive:true` bulgusu); Toeplitz gizlilik güçlendirme Web Worker
optimizasyonunun gerçek üretim yükü altında ayrı bir performans/yük
testiyle doğrulanması.

---

## Şimdiye kadar doğrulanmış ve ÇALIŞAN olduğu kanıtlanmış maddeler

Bu liste, yukarıdaki eksiklerin yanında GÖRMEZDEN GELİNMEMELİ — bunlar
gerçek, canlı testlerle doğrulandı:

- **Kısa ömürlü sertifikalar + rotasyon mekanizması** — 7 günlük
  varsayılan geçerlilik, `rotate_cert.sh` ile sıfır kesintili
  (S1) ve iptalli (S2) rotasyon senaryoları CANLI test edildi.
- **Çift katmanlı iptal (CRL + OCSP)** — TLS handshake seviyesinde CRL
  (~2sn hot-reload) ve uygulama seviyesinde OCSP (canlı sorgu, 30sn
  önbellek) bağımsız olarak doğrulandı (S1-S6).
- **Fail-closed güvenlik davranışı** — OCSP yanıtlayıcısı erişilemez
  olduğunda geçerli sertifikaların bile reddedildiği doğrulandı (S4) —
  güvenlik açısından doğru varsayılan.
- **Kısa ömür, iptalden BAĞIMSIZ ikinci bir güvence** — süresi dolmuş
  ama hiç iptal edilmemiş bir sertifikanın TLS katmanında (CRL/OCSP'ye
  hiç ulaşmadan) reddedildiği doğrulandı (S6).
- **mTLS + ETSI GS QKD 014 protokol uyumluluğu** — `mock_ibm_client.js`
  ile 19/19 test (sertifika doğrulama + tam enc_keys/dec_keys akışı +
  5 olumsuz güvenlik senaryosu) BAŞARILI.
- **CI/CD entegrasyonu** — GitHub Actions ve GitLab CI için, aynı
  paylaşılan script'i (`run_integration_tests.sh`) çağıran, ephemeral
  (secret gerektirmeyen) modda otomatik çalışan boru hatları hazır ve
  test edildi.
- **Hava boşluğu mimarisi (tasarım seviyesinde)** — CA özel anahtarının
  ağa bağlı hiçbir sunucuya kopyalanmasını GEREKTİRMEYEN üç-adımlı
  iş akışı (`ca_init.sh` → `issue_cert.sh` → `sign_csr.sh`) kuruldu (bkz.
  madde 2'deki "gerçek donanımla doğrulanmadı" notuyla birlikte
  okunmalı).

---

## Önerilen aşamalandırma

1. **Şimdi — Teknik inceleme/pilot:** Mevcut hâliyle IBM mühendislerine
   CI/CD pipeline'ı ve senaryo analiz raporunu sunup geri bildirim
   almak İÇİN uygundur. Üretim trafiği TAŞIMAMALIDIR.
2. **P0 tamamlandıktan sonra — Sınırlı/staging entegrasyon:** Gerçek
   ama düşük hacimli/izole trafikle, yakın izleme altında.
3. **P1 tamamlandıktan sonra — Genel kullanılabilirlik (GA):** Tam
   üretim trafiği.

---
*Bu doküman, `bb84/pki_tools/cert_rotation_revocation_scenarios.js`
senaryo analizi, `bb84/mock_ibm_client.js` entegrasyon testleri ve
`.github/workflows/production-pipeline.yml` / `.gitlab-ci.yml`
CI/CD boru hatları temel alınarak hazırlanmıştır.*
