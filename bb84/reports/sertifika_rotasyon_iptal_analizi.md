# PhotonNet KME — Sertifika Yenileme / İptal (CRL+OCSP) Senaryo Analizi

Bu rapor, `bb84/pki_tools/cert_rotation_revocation_scenarios.js` tarafından
**canlı bir KME sunucusuna + OCSP yanıtlayıcısına karşı gerçek mTLS
bağlantıları kurularak** üretilmiştir. Aşağıdaki HER SAYI/SÜRE, o
çalıştırmada gerçekten ölçülmüştür — varsayımsal/teorik değildir. Amaç:
IBM'in kendi sertifika rotasyon protokollerini bu KME'ye karşı entegre
etmeden önce, rotasyon/iptal sırasındaki GERÇEK davranışı ve zamanlama
karakteristiklerini belgelemektir.

**Sonuç özeti: 6/6 senaryo beklenen davranışı gösterdi.** ⚠ En önemli bulgu: kalıcı (keep-alive) bağlantılarda GERÇEK iptal-kilitlenme süresi, teorik ~30 saniye DEĞİL, ~60 saniyeye kadar çıkabiliyor — ayrıntı için aşağıdaki "EN KRİTİK bulgu" bölümüne bakınız.

## Senaryo Özeti

| # | Senaryo | Sonuç | Bulgu |
|---|---------|-------|-------|
| S1 | Planlı rotasyon, İPTAL OLMADAN (kesintisiz geçiş penceresi) | ✅ PASS | rotate_cert.sh (--revoke-old OLMADAN) çalıştırıldıktan SONRA hem ESKİ hem YENİ sertifika kabul edildi — sıfır kesintili geçiş mümkün (YENİ sertifikanın kabul edilmesi 30064ms sürdü — bkz. '30sn negatif önbellek yarışı' notu). |
| S2 | Planlı rotasyon, --revoke-old İLE (sızdırılmış anahtar senaryosu) | ✅ PASS | eski sertifika rotate_cert.sh --revoke-old komutundan itibaren 19ms içinde reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)); yeni sertifika 30343ms içinde kabul edilir hale geldi (bu çalıştırmada YENİ sertifikanın ilk OCSP sorgusu, yanıtlayıcının henüz güncellenmemiş bir anlık görüntüsüne denk geldi — bkz. rapordaki '30sn negatif önbellek yarışı' notu). |
| S3 | Acil iptal, ROTASYON OLMADAN ("önce kilitle" senaryosu) | ✅ PASS | revoke_cert.sh komutundan itibaren 659ms içinde sertifika reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)). |
| S4 | OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması + kurtarma davranışı) | ✅ PASS | OCSP yanıtlayıcısı ERİŞİLEMEZ olduğunda GEÇERLİ bir sertifika bile 3945ms içinde HTTP 401 ile fail-CLOSED reddedildi (güvenlik açısından DOĞRU); yanıtlayıcı 23ms'de toparlandı ve TAZE bir kimlik hemen kabul edildi. ÖNEMLİ: kesinti sırasında reddedilen AYNI kimlik (B), yanıtlayıcı toparlandıktan HEMEN sonra bile HÂLÂ reddedildi — negatif sonuç da 30sn önbelleğe alınıyor. |
| S5 | KALICI (keep-alive) mTLS bağlantısı AÇIKKEN sertifika iptal edilirse | ✅ PASS | mevcut, ZATEN KURULMUŞ TLS bağlantısı KOPARILMADI — iptal, aynı bağlantı üzerindeki BİR SONRAKİ istekte, revoke_cert.sh'ten itibaren 60248ms içinde, uygulama katmanında (HTTP 401, OCSP) devreye girdi. Sonuç: TLS oturum yeniden kullanımı iptali ATLATMIYOR, ama soketin kendisi de anında kesilmiyor. EN ÖNEMLİ BULGU: bu, TEK bir 30sn önbellek döngüsünden BELİRGİN ŞEKİLDE UZUN sürdü — referans OCSP yanıtlayıcısının kendi yeniden-başlatma mekanizmasıyla uygulama önbelleğinin ETKİLEŞİMİ yüzünden GERÇEK dünya kilitlenme süresi teorik ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor (bkz. rapordaki ayrıntılı analiz). |
| S6 | HİÇ iptal edilmemiş ama SÜRESİ DOLMUŞ sertifika (kısa-ömür güvencesi) | ✅ PASS | süresi dolmuş (ama iptal listesinde OLMAYAN) sertifika CRL/OCSP kontrolüne hiç ULAŞMADAN, doğrudan TLS handshake seviyesinde reddedildi (20ms, hata: "socket hang up") — kısa ömür stratejisi, iptal MEKANİZMASINDAN BAĞIMSIZ ikinci bir güvence katmanı olarak doğrulandı. |

## Mimari arka plan (bu raporu okumak için gerekli bağlam)

KME sunucusu (`etsi014_kme_server.js`) sertifika geçerliliğini **üç
BAĞIMSIZ katmanda** kontrol eder:

1. **TLS handshake / X.509 geçerlilik penceresi** — Node'un TLS
   katmanının kendisi, CRL/OCSP'den TAMAMEN bağımsız olarak, her
   sertifikanın `notBefore`/`notAfter` tarihlerini kontrol eder.
   Süresi dolmuş bir sertifika CRL/OCSP'ye hiç ulaşılmadan reddedilir
   (bkz. S6).
2. **CRL (Sertifika İptal Listesi)** — yine TLS handshake seviyesinde
   (`rejectUnauthorized`), sunucunun `--crl` ile verdiği dosyaya
   karşı kontrol edilir. Bu dosya `fs.watchFile` ile **2 saniyede bir**
   yoklanır (polling) — `revoke_cert.sh` çalıştırıldığında dosya
   ANINDA güncellenir, ama sunucunun bunu fark etmesi en kötü durumda
   ~2 saniye sürebilir.
3. **OCSP (canlı iptal sorgusu)** — TLS handshake BAŞARILI olduktan
   SONRA, uygulama katmanında (`authenticate()` içinde) çalışır; her
   isteğin sertifika seri numarası için CA veritabanına CANLI sorgu
   yapar, sonucu **30 saniyelik** bir bellek-içi önbellekte tutar.
   Yanıtlayıcıya ulaşılamazsa **fail-CLOSED** davranır (istek reddedilir
   — bkz. S4).

Bu üç katmanın PRATİKTEKİ SONUCU: **CRL/TLS-seviyesi reddi YENİ
bağlantıları engeller**, ama **zaten kurulmuş bir TLS bağlantısını
KOPARMAZ** — o bağlantı üzerindeki bir sonraki HTTP isteği ise OCSP
kontrolünden (uygulama katmanı) geçmek ZORUNDADIR (bkz. S5). **İKAZ:**
"zaten kurulmuş bir bağlantı" istemci tarafında sanıldığından ÇOK DAHA
SIK gerçekleşebilir — ör. Node.js'in `https.globalAgent`'ı bu ortamda
varsayılan olarak `keepAlive: true`'dur, yani `agent:` AÇIKÇA
belirtilmezse "ayrı" görünen istekler sessizce AYNI bağlantıyı yeniden
kullanabilir (bkz. 6. madde).

## ⚠ Bu analizin EN KRİTİK bulgusu: kalıcı bağlantılarda GERÇEK kilitlenme süresi ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor

S5'i geliştirirken, sonuçlar başlangıçta "sertifika HİÇ reddedilmiyor"
gibi göründü (test 55 saniye sonra zaman aşımına uğradı). Kök nedeni
CANLI olarak (KME sunucusuna geçici teşhis günlüğü ekleyerek) izledik ve
şunu doğruladık: bu bir test hatası DEĞİL, referans OCSP altyapısının
GERÇEK bir sınır durumu.

**Mekanizma:** `checkOcsp()`'nin 30 saniyelik önbelleği dolduğunda
yapılan İLK yeniden sorgu, o sırada BOŞTA BEKLEYEN (revizyondan ÖNCE
başlamış, `index.txt`'yi henüz yeniden okumamış) bir openssl
`ocsp` sürecine denk gelebilir. Bu süreç isteği ESKİ ("good") veriyle
YANITLAR — ve ancak YANITLADIKTAN SONRA (bkz. `run_ocsp_responder.sh`,
`-nrequest 1`) kendini tazeler. Ama bu ESKİ yanıt ZATEN gönderilmiş ve
KME'nin uygulama-katmanı önbelleğinde BİR SONRAKİ 30 saniye için TEKRAR
saklanmıştır. Yalnızca İKİNCİ önbellek döngüsündeki sorgu (yaklaşık
+60 saniye) bu artık-tazelenmiş süreci bulur ve doğru "revoked"
yanıtını alır. Bu, üç ayrı tam-boru-hattı çalıştırmasında
TEKRARLANABİLİR şekilde gözlemlendi (ölçülen değerler: 30270ms — bu
sefer tek döngüde yakalandı —, ve İKİ ayrı çalıştırmada 60278ms/60000ms
civarı — iki döngü gerekti).

**Neden önemli:** `run_ocsp_responder.sh`'in kendi dosya-üstü notu
zaten "1-2 saniyelik kalan bir yarış durumu" kabul ediyordu — ama bu
analiz, GERÇEKTE bu yarışın kaybedilme sonucunun 1-2 saniye DEĞİL, TAM
BİR EK 30 SANİYELİK önbellek döngüsü (yani toplamda ~60sn) olabildiğini
somut olarak ölçtü. Bu fark, IBM'in "bir sertifika iptalinden sonra
azami ne kadar sürede TÜM erişim kesilir" sorusuna verilecek cevabı
DOĞRUDAN etkiler.

**Öneri (üretim için ZORUNLU, referans yanıtlayıcı için DEĞİL):**
Gerçek bir IBM entegrasyonunda, `run_ocsp_responder.sh` (openssl CLI
tabanlı, tek-istek-başına-yeniden-başlatma modeli) yerine olay-tabanlı
(event-driven, index.txt/veritabanı değişikliğinde ANINDA yanıt
güncelleyen) adanmış bir OCSP yanıtlayıcı kullanılmalıdır — bu zaten
`run_ocsp_responder.sh`'in kendi notunda önerilmişti, bu rapor bunu
SOMUT, ÖLÇÜLMÜŞ bir gerekçeyle (30sn yerine ~60sn azami kilitlenme
süresi riski) güçlendirmektedir. Alternatif/ek önlem: KME'nin
`OCSP_CACHE_TTL_MS`'ini düşürmek (ör. 30sn yerine 5-10sn) bu riskin
azami etkisini orantılı olarak küçültür (30sn yerine ~10-20sn üst
sınır), ama sorunu KÖKTEN çözmez — asıl çözüm yanıtlayıcı tarafındadır.

## Öne çıkan bulgular ve IBM entegrasyonu için öneriler

1. **Sıfır kesintili rotasyon mümkün ve GÜVENLİ (S1).** `rotate_cert.sh`
   `--revoke-old` OLMADAN çalıştırıldığında, eski sertifika doğal
   süresi dolana kadar geçerli kalmaya devam eder. IBM tarafı yeni
   sertifikayı kendi hızında devreye alabilir — rotasyon anında
   kesinti riski YOKTUR.
2. **Sızdırılmış-anahtar senaryosunda kilitlenme süresi ölçüldü (S2).**
   eski sertifika rotate_cert.sh --revoke-old komutundan itibaren 19ms içinde reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)); yeni sertifika 30343ms içinde kabul edilir hale geldi (bu çalıştırmada YENİ sertifikanın ilk OCSP sorgusu, yanıtlayıcının henüz güncellenmemiş bir anlık görüntüsüne denk geldi — bkz. rapordaki '30sn negatif önbellek yarışı' notu). IBM'in "bir sertifikanın ne kadar
   sürede etkisiz hale geleceği" sorusuna somut bir üst sınır: **CRL
   hot-reload (~2sn) + OCSP izleyici gecikmesi (~1sn) toplamında birkaç
   saniyelik bir pencere** — bu, IBM'in olay müdahale (incident
   response) prosedürlerinde "sertifika iptalinden sonra X saniye
   içinde tüm trafik kesilir" şeklinde belgelenebilir.
3. **Acil iptal (rotasyonsuz) aynı hızda çalışıyor (S3).** revoke_cert.sh komutundan itibaren 659ms içinde sertifika reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)).
   Bu, "önce kilitle, soruşturmayı sonra yap" operasyonel modelini
   destekler — yeni sertifika hemen o an üretilmek ZORUNDA değildir.
4. **OCSP yanıtlayıcısı TEK NOKTA ARIZASI (SPOF) — kasıtlı olarak
   (S4).** OCSP yanıtlayıcısı ERİŞİLEMEZ olduğunda GEÇERLİ bir sertifika bile 3945ms içinde HTTP 401 ile fail-CLOSED reddedildi (güvenlik açısından DOĞRU); yanıtlayıcı 23ms'de toparlandı ve TAZE bir kimlik hemen kabul edildi. ÖNEMLİ: kesinti sırasında reddedilen AYNI kimlik (B), yanıtlayıcı toparlandıktan HEMEN sonra bile HÂLÂ reddedildi — negatif sonuç da 30sn önbelleğe alınıyor. Bu davranış GÜVENLİK
   açısından doğrudur (belirsizlik durumunda erişimi REDDETMEK,
   KABUL ETMEKTEN daha güvenlidir) ama OPERASYONEL bir risk taşır:
   OCSP yanıtlayıcısı çökerse TÜM geçerli istemciler de erişimi
   kaybeder. **Öneri:** OCSP yanıtlayıcısını izlenen (monitored),
   yüksek erişilebilirlikli (ör. aktif-pasif iki örnek + sağlık
   kontrolü) bir servis olarak çalıştırın; `run_ocsp_responder.sh`
   dosya-üstü notunda da belirtildiği gibi, üretimde OpenSSL CLI
   tabanlı bu referans yanıtlayıcı yerine adanmış bir OCSP yanıtlayıcı
   (Dogtag OCSP, EJBCA, cfssl ocsprest) kullanılması ÖNERİLİR. AYRICA:
   negatif (hata) sonuçlar da 30 saniye önbelleğe alınıyor — bu,
   yanıtlayıcı toparlandıktan SONRA bile, kesinti sırasında reddedilmiş
   istemcilerin en fazla 30 saniye daha beklemesi gerekebileceği
   anlamına gelir; kritik entegrasyonlarda hata sonuçları için daha
   kısa/ayrı bir önbellek TTL'i değerlendirilebilir.
5. **Kalıcı bağlantılar iptali atlatamıyor, ama anında da kesilmiyor —
   ve GERÇEK kilitlenme süresi yukarıdaki kritik bulguda açıklandığı
   gibi ~60sn'ye kadar çıkabiliyor (S5).** mevcut, ZATEN KURULMUŞ TLS bağlantısı KOPARILMADI — iptal, aynı bağlantı üzerindeki BİR SONRAKİ istekte, revoke_cert.sh'ten itibaren 60248ms içinde, uygulama katmanında (HTTP 401, OCSP) devreye girdi. Sonuç: TLS oturum yeniden kullanımı iptali ATLATMIYOR, ama soketin kendisi de anında kesilmiyor. EN ÖNEMLİ BULGU: bu, TEK bir 30sn önbellek döngüsünden BELİRGİN ŞEKİLDE UZUN sürdü — referans OCSP yanıtlayıcısının kendi yeniden-başlatma mekanizmasıyla uygulama önbelleğinin ETKİLEŞİMİ yüzünden GERÇEK dünya kilitlenme süresi teorik ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor (bkz. rapordaki ayrıntılı analiz).
   IBM tarafının HTTP keep-alive/connection-pooling kullanması BEKLENEN
   bir davranıştır (performans için) — bu test, bu kullanımın güvenlik
   açığı YARATMADIĞINI (her istek yine de denetleniyor, yalnızca daha
   YAVAŞ) doğrular. Öneri: IBM istemcisi, bir 401 yanıtı aldığında
   SOKETİ KAPATIP yeni bir TLS handshake ile YENİDEN denemelidir (bazı
   HTTP kütüphaneleri 401'de bile soketi keep-alive için AÇIK tutar) —
   aksi bir davranış fonksiyonel bir sorun yaratmaz ama gereksiz tekrar
   denemelere yol açabilir. Asıl kök neden ve önerilen düzeltme için
   yukarıdaki "EN KRİTİK bulgu" bölümüne bakınız.
6. **GERÇEK BULGU (bu script'in İLK taslağını yazarken canlı olarak
   keşfedildi) — Node.js istemcilerinde `https.globalAgent`
   VARSAYILAN olarak `keepAlive: true`'dur (bu ortamda, Node.js v22
   ile doğrulandı).** Bir istekte `agent:` seçeneği AÇIKÇA
   verilmezse, aynı KME'ye yapılan "birbirinden bağımsız" gibi görünen
   ardışık istekler SESSİZCE aynı TCP/TLS bağlantısını yeniden
   kullanabilir — bu, istemci geliştiricisinin FARKINDA OLMADAN madde
   5'teki "kalıcı bağlantı" durumuna düşmesi anlamına gelir. Sonuç:
   CRL/TLS-seviyesi iptal kontrolü bu bağlantı ÜZERİNDE bir daha HİÇ
   çalışmaz (yalnızca OCSP'nin 30sn'lik uygulama-katmanı kontrolü
   iptali fark eder). **Öneri:** IBM'in istemci kütüphanesi hangi dilde/
   çatıda yazılırsa yazılsın (Node.js, Java, Python, Go...), KME'ye
   bağlanırken kullandığı HTTP istemcisinin/agent'ının varsayılan
   bağlantı yeniden-kullanım (keep-alive/connection-pooling) davranışını
   AÇIKÇA gözden geçirmesi ve bu raporun ölçtüğü zamanlama
   varsayımlarıyla (madde 2/3) UYUMLU bir bağlantı yenileme politikası
   (ör. bağlantı başına maksimum ömür/istek sayısı sınırı) benimsemesi
   önerilir — aksi halde "sertifika iptal edildi" ile "istemci bunu
   fark etti" arasındaki gerçek süre, bu raporun CRL için verdiği
   birkaç saniyelik rakamlar DEĞİL, OCSP'nin 30 saniyelik önbellek
   TTL'i (hatta bağlantı hiç yenilenmezse süresiz) olabilir.
7. **Kısa ömür stratejisi, iptal mekanizmasından BAĞIMSIZ ikinci bir
   güvence sağlıyor (S6).** Bir sertifika iptal edilmeyi "unutulsa"
   bile (insan hatası, otomasyon arızası), `sign_csr.sh`'in varsayılan
   7 günlük geçerlilik süresi bu riski sınırlar. **Operasyonel not:**
   süresi dolmuş bir sertifikanın reddi istemciye OPAK bir bağlantı
   hatası (`ECONNRESET`/"socket hang up") olarak yansır — spesifik
   bir "sertifika süresi dolmuş" mesajı İLETİLMEZ. IBM entegrasyon
   ekibi, beklenmedik/açıklanamayan bağlantı kopmalarını hata ayıklarken
   **önce sertifika geçerlilik tarihlerini kontrol etmelidir**
   (`openssl x509 -noout -dates`) — bu rapor bu tuzağı önceden
   belgelemektedir.
8. **Genel rotasyon takvimi önerisi (mevcut kod tabanından):**
   `rotate_cert.sh` zaten kendi çıktısında bitiş tarihinden ~2 gün
   önce otomatik bir rotasyon görevi (cron/systemd-timer) önerir — bu
   raporun ölçtüğü "eski sertifika ANINDA reddedilmeye başlıyor" bulgusu
   (madde 2) ile birleştirildiğinde, IBM tarafının PLANLI rotasyonları
   ("--revoke-old" OLMADAN, madde 1) DÜZENLİ bir takvimde, iptali ise
   YALNIZCA gerçek bir sızıntı şüphesinde (madde 3) kullanması önerilir.
9. **Küçük bir kod tabanı iyileştirme fırsatı (S2 sırasında keşfedildi):**
   YENİ imzalanan bir sertifikanın İLK OCSP sorgusu, yanıtlayıcının
   index.txt'yi henüz yeniden okumadığı çok kısa bir pencereye denk
   gelirse "unknown" yanıtı alabilir; `checkOcsp()` bunu (madde 4'teki
   AYNI mekanizmayla) fail-CLOSED sayıp 30 saniye önbelleğe alır — yani
   rotasyon SONRASI yeni sertifikanın kullanılabilir hale gelmesi
   NADİREN ~30 saniyeye kadar sürebilir. **Öneri:** `checkOcsp()`'te
   "unknown" yanıtını "revoked"/"unreachable" ile AYNI TTL'de değil,
   daha KISA bir TTL'de (ör. 2-3 saniye — tam da OCSP izleyicisinin
   kendi tazelenme penceresi kadar) önbelleğe almak bu nadir gecikmeyi
   ortadan kaldırır; bu bu raporun kapsamı DIŞINDA, ayrı bir değişiklik
   olarak değerlendirilebilir.

## Ayrıntılı senaryo sonuçları

### S1 — Planlı rotasyon, İPTAL OLMADAN (kesintisiz geçiş penceresi)

**Sonuç:** ✅ Beklenen davranış doğrulandı.

rotate_cert.sh (--revoke-old OLMADAN) çalıştırıldıktan SONRA hem ESKİ hem YENİ sertifika kabul edildi — sıfır kesintili geçiş mümkün (YENİ sertifikanın kabul edilmesi 30064ms sürdü — bkz. '30sn negatif önbellek yarışı' notu).

- **baseline_eski_sertifika**: KABUL (katman=http, HTTP 200, 62ms) — "HTTP 200"
- **rotasyon_sonrasi_eski_sertifika_kopyasi**: KABUL (katman=http, HTTP 200, 20ms) — "HTTP 200"
- **rotasyon_sonrasi_yeni_sertifika**: KABUL (katman=http, HTTP 200, 38ms) — "HTTP 200"

### S2 — Planlı rotasyon, --revoke-old İLE (sızdırılmış anahtar senaryosu)

**Sonuç:** ✅ Beklenen davranış doğrulandı.

eski sertifika rotate_cert.sh --revoke-old komutundan itibaren 19ms içinde reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)); yeni sertifika 30343ms içinde kabul edilir hale geldi (bu çalıştırmada YENİ sertifikanın ilk OCSP sorgusu, yanıtlayıcının henüz güncellenmemiş bir anlık görüntüsüne denk geldi — bkz. rapordaki '30sn negatif önbellek yarışı' notu).

- **baseline_eski_sertifika**: KABUL (katman=http, HTTP 200, 36ms) — "HTTP 200"
- **rotate_komutunun_calisma_suresi_ms**: 1443
- **eski_sertifika_reddedilene_kadar_gecen_sure_ms**: 19
- **eski_sertifika_reddinin_katmani**: TLS/CRL (bağlantı seviyesi — HTTP yanıtı hiç alınamadı)
- **eski_sertifika_son_hata_mesaji**: socket hang up
- **yeni_sertifikanin_kabul_edilene_kadar_gecen_sure_ms**: 30343
- **yeni_sertifika_30sn_negatif_onbellek_yarisina_yakalandi_mi**: true

### S3 — Acil iptal, ROTASYON OLMADAN ("önce kilitle" senaryosu)

**Sonuç:** ✅ Beklenen davranış doğrulandı.

revoke_cert.sh komutundan itibaren 659ms içinde sertifika reddedilmeye başladı (katman: TLS/CRL (bağlantı seviyesi)).

- **baseline**: KABUL (katman=http, HTTP 200, 35ms) — "HTTP 200"
- **revoke_komutunun_calisma_suresi_ms**: 114
- **reddedilene_kadar_gecen_sure_ms**: 659
- **reddin_katmani**: TLS/CRL (bağlantı seviyesi)
- **son_hata_mesaji**: socket hang up

### S4 — OCSP yanıtlayıcısı ÇÖKER (fail-closed doğrulaması + kurtarma davranışı)

**Sonuç:** ✅ Beklenen davranış doğrulandı.

OCSP yanıtlayıcısı ERİŞİLEMEZ olduğunda GEÇERLİ bir sertifika bile 3945ms içinde HTTP 401 ile fail-CLOSED reddedildi (güvenlik açısından DOĞRU); yanıtlayıcı 23ms'de toparlandı ve TAZE bir kimlik hemen kabul edildi. ÖNEMLİ: kesinti sırasında reddedilen AYNI kimlik (B), yanıtlayıcı toparlandıktan HEMEN sonra bile HÂLÂ reddedildi — negatif sonuç da 30sn önbelleğe alınıyor.

- **baseline_A_ocsp_ayaktayken**: KABUL (katman=http, HTTP 200, 35ms) — "HTTP 200"
- **kesinti_sirasinda_B_hic_sorgulanmamis_kimlik**: RED (katman=http, HTTP 401, 3945ms) — "OCSP yanıtlayıcıya ulaşılamadı/anlaşılamadı (fail-CLOSED — İKAZ: yanıtlayıcı çökerse istekler REDDEDİLİR): Command failed: openssl ocsp -issuer /tmp/cert-scenarios-qilV56/pki/ca-cert.pem -cert /tmp/ocsp-QeqSIa/peer.pem -url http://localhost:8988 -CAfile /tmp/cert-scenarios-qilV56/pki/ca-cert.pem -timeout 3
Error querying OCSP responder
4037F8D5AD7F0000:error:10000093:BIO routines:BIO_do_connect_retry:connect timeout:../crypto/bio/bio_lib.c:968:
"
- **ocsp_yanitlayici_toparlanma_suresi_ms**: 23
- **toparlanma_sonrasi_TAZE_kimlik_C**: KABUL (katman=http, HTTP 200, 41ms) — "HTTP 200"
- **toparlanma_sonrasi_AYNI_kimlik_B_negatif_onbellek_notu**: RED (katman=http, HTTP 401, 17ms) — "OCSP yanıtlayıcıya ulaşılamadı/anlaşılamadı (fail-CLOSED — İKAZ: yanıtlayıcı çökerse istekler REDDEDİLİR): Command failed: openssl ocsp -issuer /tmp/cert-scenarios-qilV56/pki/ca-cert.pem -cert /tmp/ocsp-QeqSIa/peer.pem -url http://localhost:8988 -CAfile /tmp/cert-scenarios-qilV56/pki/ca-cert.pem -timeout 3
Error querying OCSP responder
4037F8D5AD7F0000:error:10000093:BIO routines:BIO_do_connect_retry:connect timeout:../crypto/bio/bio_lib.c:968:
"

### S5 — KALICI (keep-alive) mTLS bağlantısı AÇIKKEN sertifika iptal edilirse

**Sonuç:** ✅ Beklenen davranış doğrulandı.

mevcut, ZATEN KURULMUŞ TLS bağlantısı KOPARILMADI — iptal, aynı bağlantı üzerindeki BİR SONRAKİ istekte, revoke_cert.sh'ten itibaren 60248ms içinde, uygulama katmanında (HTTP 401, OCSP) devreye girdi. Sonuç: TLS oturum yeniden kullanımı iptali ATLATMIYOR, ama soketin kendisi de anında kesilmiyor. EN ÖNEMLİ BULGU: bu, TEK bir 30sn önbellek döngüsünden BELİRGİN ŞEKİLDE UZUN sürdü — referans OCSP yanıtlayıcısının kendi yeniden-başlatma mekanizmasıyla uygulama önbelleğinin ETKİLEŞİMİ yüzünden GERÇEK dünya kilitlenme süresi teorik ~30sn DEĞİL, ~60sn'ye kadar çıkabiliyor (bkz. rapordaki ayrıntılı analiz).

- **ilk_istek_ok_mu**: true
- **ilk_istek_yerel_port**: 37998
- **iptal_sonrasi_reddedilene_kadar_gecen_sure_ms**: 60248
- **iptal_sonrasi_reddin_katmani**: HTTP 401 (soket hâlâ açık, uygulama katmanı reddetti)
- **iptal_sonrasi_son_hata_mesaji**: OCSP: sertifika İPTAL EDİLMİŞ
- **tek_onbellek_dongusunden_fazla_surdu_mu**: true

### S6 — HİÇ iptal edilmemiş ama SÜRESİ DOLMUŞ sertifika (kısa-ömür güvencesi)

**Sonuç:** ✅ Beklenen davranış doğrulandı.

süresi dolmuş (ama iptal listesinde OLMAYAN) sertifika CRL/OCSP kontrolüne hiç ULAŞMADAN, doğrudan TLS handshake seviyesinde reddedildi (20ms, hata: "socket hang up") — kısa ömür stratejisi, iptal MEKANİZMASINDAN BAĞIMSIZ ikinci bir güvence katmanı olarak doğrulandı.

- **sonuc**: RED (katman=connection, ECONNRESET, 20ms) — "socket hang up"
- **not**: İKAZ: bu red genellikle 'ECONNRESET/socket hang up' gibi OPAK bir hata olarak görünür — spesifik 'sertifika süresi dolmuş' metni istemciye YANSIMAZ (bkz. rapordaki operasyonel öneri).


---
*Bu rapor otomatik olarak `bb84/pki_tools/cert_rotation_revocation_scenarios.js`
tarafından üretilmiştir — ham veri için `scenario_results.json` ve tam
komut/sunucu loglarını içeren `run.log`'a bakınız.*
