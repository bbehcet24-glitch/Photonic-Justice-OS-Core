# multinode_shielding_testbed L8 — kararsızlığın kök nedeni ve çözümü

## Özet

L8 ("KÖKEN") kontrolü yaklaşık 10 koşuda 1 başarısız oluyordu. Sebep ağ gecikmesi ya da `KeyPoolBuffer` değil.

Asıl sebep ETSI GS QKD 014'ün **iki adımlı** olması: master SAE `enc_keys`, ardından slave SAE `dec_keys` çağırır.
Kalkan kapısı bu iki çağrının **arasında** kapanırsa olaylar şöyle gelişir:

- KME, slave'e teslimi doğru şekilde reddeder (fail-closed, 503).
- Master'da 4 "yarı-açık" anahtar kalır.
- Eski L8 bu anahtarları "SAE aldı ama eşleşmedi" diye sayıyordu.

Anahtarların kökeni temizdi: kayıttaydı, baytları aynıydı, sızıntılı değildi. Hata testin kendisindeydi
(yanlış alarm). Bunun yanında gerçek bir eksik de vardı: yarı-açık anahtarlar hiç tamamlanmıyordu.

## Kanıt

### 1) Yeniden üretim

Ölçüm düzeni:

- Testbed'in canlı aşamasından araçlı bir kopya alındı (geçici, depoya girmedi).
- Kopya, her başarısız L8 kaydını, enc/dec zamanlarını ve KME'nin red mesajını kaydetti.
- 36 koşu yapıldı, 6'sı paralel.

Sonuç: **36 koşuda 1 L8 hatası.** Kayıt:

| Alan | Değer |
|---|---|
| Akış | MSL↔KDK, t = 6020 ms (KDK bakım kapısı 6000 ms'de açılıyor) |
| enc_keys | 200, t = 6026 ms |
| dec_keys | **503**, t = 6032 ms — "Kalkan kapısı: 'SAE-KDK' düğümüne anahtar teslimi şu an izinli değil (HOLD_FLOOR)" |
| 4 anahtar | kayıtta ✓, bayt eşleşmesi ✓, sızıntılı ✗, `match = false` |
| Zaman çizelgesi | 6020 ms'de KDK = HOLD_FLOOR; 6070 ms'de MSL↔KDK yolu kapatıldı |

Yaşananlar sırasıyla şöyle:

1. Karar döngüsü 6000 ms adımında KDK'yı HOLD_FLOOR'a aldı ve MSL KME'sinin kapı dosyasını yeniden yazdı.
2. `enc_keys`, kapıyı bu yazımdan **hemen önce** okudu. KDK'ya teslim hâlâ açık göründü (`handleEncKeys → assertShieldGate`).
3. 6 ms sonra gelen `dec_keys`'te `authenticate → assertShieldGate([SAE-KDK])` yeni kapıyı okudu ve isteği reddetti.

Bu klasik bir **TOCTOU** durumu (kontrol zamanı ile kullanım zamanı farkı). İki ayrı HTTP çağrısı arasında atomik
bir kapı kontrolü yoktur, olamaz da.

### 2) Olasılık neden ~%1–3

- enc→dec penceresi küçük: bir koşuda 100 akışta medyan 2 ms, p95 12 ms, en çok 30 ms.
- KDK uçlu iki talep (MSL↔KDK, AVR↔KDK) ~610 ms'de bir döner.
- Bir talebin penceresinin 6000 ms'deki kapı yazımına denk gelme olasılığı ≈ 4 ms / 610 ms ≈ %0,7.
- İki talep ve diğer geçişlerle birlikte koşu başına ~%1–3 eder.

Gözlem bununla uyumlu: önce 10 koşuda 1, sonra 36 koşuda 1.

### 3) İkinci alt-durum: master KME'nin kendi kapısı bayatladı

İlk düzeltmeden (yalnız slave-kapalı redlerini açıklayan sınıflandırıcı) sonra 42 koşuluk bir doğrulama kampanyası
yapıldı. Bu kampanyada **1 L8 hatası daha** çıktı:

- Akış: AVR↔ASY, `dec_keys` → 503, slave ASY'ye teslim açık.
- Sebep: senaryo AVR'nin SE izleyicisini 19000 ms'de bilerek çökertiyor (L7). AVR'nin kapı dosyası artık
  tazelenmiyor ve 1000 ms sonra KME onu **bayat** sayıyor.
- `enc_keys` 20000 ms'den hemen önce geçti, `dec_keys` hemen sonra "BAYAT" ile reddedildi. Bazen de TLS oturumu
  kesildiği için yanıt yerine ECONNRESET geldi.

Bu da aynı TOCTOU'dur; yalnızca kapanan kapı slave'inki değil, master KME'nin kendisininkidir. 900 ms'lik yapay
enc→dec aralığıyla (`--enc-dec-gap-ms=900`) her koşuda üretilebiliyor. Sınıflandırıcı bu yüzden genelleştirildi
(aşağıda B).

### 4) Kesin yeniden üretim

`kme_half_open_gate_test.js` kapıyı iki çağrının arasında **bilerek** çevirir. Sonuç her koşuda aynıdır
(H1: enc 200 → dec 503).

## Önerilen iki hipotezin değerlendirmesi

| Hipotez | Sonuç | Kanıt |
|---|---|---|
| 1. Canlı API zaman aşımı / ağ titremesi | **Kök neden değil, yalnız büyüteç** | Zaman aşımı `httpsCall`'da istisna fırlatır; o akışta `rec.keys` hiç doldurulmaz, dolayısıyla L8'e girmez (kod incelemesi). Başarısız kayıtta zaman aşımı yok, enc→dec 6 ms. Yük yalnızca pencereyi genişletiyor (p95 12 ms, en çok 30 ms) ve olasılığı biraz artırıyor. |
| 2. `KeyPoolBuffer._finalizeBlock` bildirimi ile doğrulama arasında yarış | **Uygulanamaz** | Testbed `KeyPoolBuffer`'ı hiç kullanmıyor (`grep` boş). Anahtarlar doğrudan `crypto.randomBytes` ile üretilip KME gelen kutusuna yazılıyor. 0,25 s'lik blok kapanışı tarayıcıdaki çekirdek yolunda; bu testte yok. |
| (Bulunan) İki adımlı ETSI-014 ile kalkan kapısı geçişi arasında TOCTOU | **Kök neden** | Yukarıdaki kayıt; zorlanmış yeniden üretim (H1); eski kuralın bu kayıtta düştüğünü gösteren H6. |

### Ayrı bulgu: yük altında L3 ve L4

6 kopya paralel koşturulduğunda (42 KME süreci) 36 koşuda 18 kez L3, 19 kez L4 başarısız oldu. Sebep ayrı:

- Kapı dosyasının tazelik sınırı 1000 ms.
- CPU çekişmesinde karar döngüsü kapıyı zamanında tazeleyemiyor.
- KME kapıyı bayat sayıp mTLS'i kesiyor (örnek: L4'te 655 ms'de, kapı açılmadan önce kesinti).

Bu fail-closed davranışın kendisidir, hata değildir. Testbed regresyon koşucusunda zaten sıralı (seq) listede.
Düzeltme bu kapsamın dışında bırakıldı; öneri aşağıda.

## Çözüm (uygulandı)

### A. Slave SAE ertelenmiş `dec_keys` yapar (gerçek ETSI-014 davranışı)

ETSI-014'te slave, key_ID'leri master'dan alır ve **istediği zaman** çeker. Kapı kapalıyken gelen red kalıcı
değildir. Testbed'in `flowWorker`'ı artık şöyle çalışıyor:

- Reddedilen key_ID'leri `pending` listesinde tutar. Yeni redler listeye eklenir, var olanları ezmez.
- Her turda önce bekleyen anahtarlar için `dec_keys`'i yeniden dener, sonra yeni `enc_keys` ister.

KME tarafında değişiklik gerekmedi. `kme_half_open_gate_test` şunları doğruluyor:

- Yarı-açık anahtarlar depoda "master'a verildi" olarak kalıyor ve bir daha verilmiyor (H2).
- Kapı açılınca ertelenmiş `dec_keys` aynı baytları döndürüyor (H3).
- Üçüncü bir deneme replay olarak reddediliyor (H4).

### B. L8 kökeni üç sınıfa ayırıyor (`key_provenance_audit.js` → `classifyL8`)

1. Master'a verilen her anahtar: kayıtta, bayt aynı, sızıntısız, tekrarsız.
2. Slave'e verilen her anahtar (anında ya da ertelenmiş): bayt kayıtla ve master'ın aldığıyla aynı.
3. Yarı-açık anahtar yalnız gerekçesi **kanıtla** eşleşiyorsa kabul edilir. Kanıt KME'nin mesajından değil,
   testbed'in kendi kayıtlarından gelir:

   | Gerekçe | KME yanıtı | Kanıt |
   |---|---|---|
   | slave-kapalı | 503 "…teslimi şu an izinli değil" | zaman çizelgesinde `delivery[slave] = false` |
   | master-bayat | 503 "BAYAT" ya da bağlantı kesildi | kapı yazım günlüğünde enc→dec penceresinde > maxAge boşluk |
   | master-blok | 503 "düğüm kalkanı" ya da bağlantı kesildi | zaman çizelgesinde `mtls[master] = false` |
   | taşıma | HTTP yanıtı yok, kapı gerekçesi yok | koşul hemen kalkar, bu yüzden tamamlanması zorunlu |

   Ek olarak koşul kalktıktan sonra 3 s içinde ertelenmiş `dec_keys` ile tamamlanmış olmalı. Tek istisna: koşu
   o süre dolmadan bittiyse (ör. AVR'nin izleyicisi koşu sonuna dek çökük) anahtar "açıklanan bekleyen" sayılır.

Bu sınıflandırma güvenlik denetimini gevşetmiyor:

- Kapı **açıkken** gelen bir red, uyuşmayan bir bayt, sızıntılı köken, tekrar, kayıtsız anahtar ya da hiç
  tamamlanmayan bir yarı-açık anahtar hâlâ L8'i düşürür.
- H5 bunu 14 durumda sınar: 6 kabul ve 8 ret durumu, aralarında kapı tazeyken "BAYAT" iddiası da var.

Testbed'e eklenen kayıtlar:

- Zaman çizelgesine düğüm başına `delivery` ve `mtls` (kapıya yazılan değerler). Yalıtılmış bir düğüm HOLD
  durumundayken teslim alabilir; yalnız durum adına bakmak yanlış sonuç verir.
- Rapora yazılmayan bir **kapı yazım günlüğü** (düğüm başına yazım anları). "BAYAT" iddiası bununla doğrulanır;
  kapı tazeyken gelen bir "BAYAT" yanıtı ihlal sayılır.

### C. Stres doğrulama seçenekleri

- `--enc-dec-gap-ms=N`: enc ile dec arasına N ms ekler. Yarı-açık durumunu neredeyse her koşuda üretir, böylece
  ertelenmiş-dec yolu canlı olarak sınanır.
- `--base-port=P`: paralel koşularda port çakışmasını önler.

## Önerilen ama uygulanmayanlar

1. **KME'de yarı-açık anahtar için süre sınırı (TTL).** Slave hiç gelmezse yarı-açık kayıtlar bellekte kalır.
   `state_poisoning_drill` bunun hız tarafını O(1) yapıyla çözmüştü, bellek tarafı açık.
   - Öneri: `--half-open-ttl-ms`. Süresi dolan kayıt silinir, `dec_keys` 410 döner.
   - TTL en uzun HOLD+kurtarma süresinden (testte ~10,3 s) uzun olmalı; aksi halde A'daki ertelenmiş teslim
     bozulur.
   - KME'nin dış davranışını değiştirdiği için ayrı bir karar gerektirir.
2. **Yük altında L3/L4.** İki seçenek var:
   - Kapı tazeliğini karar döngüsünden ayrı bir zamanlayıcıyla yazmak,
   - ya da L3/L4 pencerelerini duvar saati yerine kapının gerçek yazım zamanlarına göre ölçmek.

## Doğrulama

**Kesin test:** `kme_half_open_gate_test.js` 6/6 geçiyor. İçeriği:

- H1–H4: tek KME ile yarış penceresi zorlanıyor.
- H5: sınıflandırıcı 14 durumda sınanıyor.
- H6: eski kuralın aynı kayıtta yanlış alarm verdiği gösteriliyor.

**Canlı kampanya** (düzeltilmiş testbed, yalnız canlı aşama; her koşu ~45 s):

| Koşu türü | Koşu | L8 hatası | Yarı-açık oluşan koşu (eski kuralla yanlış alarm) | Gerekçe |
|---|---|---|---|---|
| Normal, sıralı | 10 | **0** | 1 | master-bayat 1 |
| Normal, 3 paralel | 42 | **0** | 2 | slave-kapalı 1 (ertelenmiş tamamlandı), master-bayat 1 (koşu sonunda bekleyen) |
| Stres `--enc-dec-gap-ms=300`, 3 paralel | 15 | **0** | 11 | slave-kapalı 10 (hepsi ertelenmiş tamamlandı), master-bayat 1 |
| **Toplam** | **67** | **0** | **14** | |

Eski kural bu 14 koşunun hepsinde yanlış alarm verirdi. Normal koşularda yarı-açık oranı 52'de 3 (~%6) çıktı;
bu, başta gözlenen 10'da 1 ve 36'da 1 ile aynı mertebede.

Tam testbed (`--stage=all`, sıralı) 21/21 geçiyor.

**L3/L4:** Bu kontroller 3 paralel koşuda 42 koşunun 18'inde (L3 8, L4 10), stres koşularında 15'in 8'inde başarısız
oldu. Sıralı 10 koşuda hiç başarısız olmadı. Sebep yukarıdaki "Ayrı bulgu" bölümündeki kapı tazeliği sınırı;
L8 ile ilişkisi yok. Regresyon koşucusu testbed'i zaten sıralı çalıştırıyor.
