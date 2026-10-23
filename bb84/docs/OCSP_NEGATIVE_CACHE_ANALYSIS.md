# Kapı 3a'daki ~30 s ve ~60 s OCSP gecikmeleri — kök neden ve düzeltme

## Özet

CI'da (koşu #52, iki deneme) yeni sertifikanın kabul edilmesi bir denemede S1'de, diğerinde S2'de yaklaşık
30 s sürdü (30 189 / 30 304 ms). Raporun kendisi de her koşuda "keep-alive bağlantıda iptal ~60 s'ye kadar
sürebiliyor" diyordu.

Ölçümler iki ayrı katmanda dört kusur gösterdi:

| Kod | Katman | Kusur | Etki |
|---|---|---|---|
| R1 | Yanıtlayıcı izleyicisi | index.txt 1 s'de bir taranıyordu | Yeni sertifikaya ~1 s "unknown" |
| R2 | Yanıtlayıcı izleyicisi | mtime saniye çözünürlüklüydü | Aynı saniyedeki ikinci değişiklik kayboluyordu |
| R3 | Yanıtlayıcı izleyicisi | İlk tarama yalnız taban kaydediyordu | (Yeniden) başlangıçtan sonraki ilk saniyedeki değişiklik **hiç** görülmüyordu; **iptal edilmiş sertifikaya "good"** |
| K1 | KME `checkOcsp` | Belirsiz sonuç ("unknown"/ulaşılamadı) "good" ile aynı 30 s önbelleğe alınıyordu | Tek bir geçici "unknown" geçerli sertifikayı 30 s kilitliyordu |

Bunlar CI'daki gecikmeleri şöyle üretiyordu:

- **S1/S2'deki ~30 s:** R1 + K1. Yeni sertifikanın ilk sorgusu R1 penceresine düşünce "unknown" alıyor, KME bu
  sonucu 30 s önbellekte tutuyordu.
- **S5'teki ~60 s:** R3 + 30 s'lik "good" önbelleği.
  1. S4 yanıtlayıcıyı yeniden başlatıyor; S5'in iptali yanıtlayıcının ilk saniyesine denk geliyor.
  2. İzleyici bu değişikliği görmüyor.
  3. 30 s sonraki sorgu iptal edilmiş sertifika için bayat "good" alıyor ve bunu bir 30 s daha önbelleğe koyuyor.

S5'teki gecikme bir **iptal gecikmesi**, yani güvenlik açısından önemli. Raporun eski açıklaması bunu "openssl CLI
tasarımının doğal sonucu" diye sunuyordu; asıl sebep izleyicinin başlangıç kusuruydu.

## Kanıt

### Yanıtlayıcı (`run_ocsp_responder.sh`), doğrudan `openssl ocsp` sorgularıyla

**R1 — imzadan d ms sonra yeni sertifikanın ilk sorgusu, 10'ar deneme:**

| d | 0 ms | 200 ms | 500 ms | 800 ms | ≥ 1200 ms |
|---|---|---|---|---|---|
| Eski: "unknown" | 10/10 | 7/10 | 4/10 | 4/10 | 0/10 |
| Yeni: "unknown" | 6/10 | 0/10 | 0/10 | 0/10 | 0/10 |

İkinci sorgu her zaman "good" çıkıyor. Sebep: `-nrequest 1` ilk istekten sonra süreci yeniden başlatıyor, yeni
süreç de index'i baştan okuyor.

**R2 — aynı saniyede iki değişiklik (A saniyenin ~%2'sinde, B ~%70'inde), 2,5 s sonra B'nin sertifikası:**

| | Eski | Yeni |
|---|---|---|
| A ve B aynı saniyede | 20 denemede **11** "unknown" | 20/20 good (ayrıca `ocsp_cache_staleness_test` O2: 8/8) |
| Kontrol: B sonraki saniyede | 20/20 good | 20/20 good |

**R3 — yanıtlayıcı başladıktan hemen sonra sorgu (good), iptal, 1 s boşta, sorgu:**

| | Sonuç |
|---|---|
| Eski | 6/6 **good**: iptal edilmiş sertifika geçerli görünüyor |
| Yeni | 6/6 revoked |

Eski izleyicinin zaman izi:

```
0.124 iptal başladı · 0.131 yeni süreç başladı (index mtime 586.412 = iptal ÖNCESİ) · 0.201 iptal bitti (mtime 586.621)
1.006 izleyici: mtime=586 last=(boş)   ← ilk tarama yalnız TABAN; iptal tabana karıştı
2.016 / 3.024 / 4.172 izleyici: mtime=586 last=586 → değişiklik yok sanıldı, süreç bayat kaldı
4.221 süreç ancak bir istek gelince çıktı
```

### KME, araçlı (geçici hata ayıklama günlüğü) senaryo koşusu, S5

```
419157 MISS  KEEPALIVE → 419167 good (önbelleğe, 30 s)        ← S5 ilk istek
419168–419237 revoke_cert.sh                                   ← S4'ün yeniden başlattığı yanıtlayıcının ilk saniyesi
449172 MISS → 449187 good   ← iptalden 30 s sonra BAYAT "good", bir 30 s daha önbelleğe
479417 MISS → 479431 revoked ← ~60 s
```

### Tam senaryo (`cert_rotation_revocation_scenarios.js`) önce ve sonra

| | Koşu | S1 yeni sertifika | S2 yeni sertifika | S4: kesintide reddedilen kimlik | S5 keep-alive iptali |
|---|---|---|---|---|---|
| Eski kod | 4 | 2/4 koşuda ~30,1–30,3 s | 2/4 koşuda ~30,1–30,3 s | 4/4 hâlâ RED | **4/4 ~60,2 s** |
| Yeni kod | 6 | 24–34 ms | 22 ms ya da 2,2 s (bir "unknown" + 2 s) | 2,3 s sonra KABUL | **6/6 ~29,9 s** |

### Kesin test (`ocsp_cache_staleness_test.js`)

| | Sonuç | Kontroller |
|---|---|---|
| Yeni kod | 6/6 geçti | O1–O6 |
| Aynı test eski kodda | 1/6 geçti | yalnız O5 (güvenlik özelliği) geçti |

Eski koddaki başarısızlıklar:

- **O1:** 6/6 iptal edilmiş sertifikaya "good".
- **O2:** 8/8 "unknown".
- **O3:** 300 ms'de 9/10 "unknown".
- **O4:** yanıtlayıcı tazelendikten 6 s sonra hâlâ RED.
- **O6:** geçersiz parametre sessizce yutuldu.

## Düzeltmeler

### Yanıtlayıcı izleyicisi

İzleyici artık şu değişmezi koruyor: **çalışan süreç index'in güncel hâlini yüklemiş olmalı.** Nasıl işliyor:

1. Ana döngü her `openssl ocsp` sürecini başlatmadan hemen önce index'in parmak izini (inode + boyut + nanosaniye
   mtime) bir dosyaya yazar.
2. İzleyici 0,2 s'de bir güncel parmak izini bu dosyadakiyle karşılaştırır; farklıysa süreci öldürür.
3. Ana döngü hemen taze bir süreç başlatır.

Bu tek değişiklik R1'i (0,2 s tarama), R2'yi (nanosaniye ve inode) ve R3'ü (karşılaştırma tabana değil, sürecin
yüklediği index'e göre) birlikte kapatıyor. Tarama aralığı `OCSP_INDEX_POLL_S` ile ayarlanabilir.

### KME `checkOcsp`

| Sonuç | Önbellek süresi | İstek |
|---|---|---|
| good | 30 s (`--ocsp-cache-ttl-ms`) | kabul |
| revoked | 30 s | RED |
| unknown / ulaşılamadı / anlaşılamadı | **2 s** (`--ocsp-indeterminate-ttl-ms`) | RED (fail-closed, değişmedi) |

Ek değişiklikler:

- Önbellek anahtarı artık sertifikanın SHA-256 parmak izi; eski kod yalnız seri numarasını kullanıyordu.
- "unknown" artık "ulaşılamadı" mesajından ayrı, kendi mesajıyla bildiriliyor.
- Geçersiz TTL parametresiyle KME açılmıyor (çıkış kodu 2).

Bu değişiklik raporun 9. maddesinde "kapsam dışı" diye önerilen iyileştirmenin ta kendisi.

**Güvenlik etkisi:** Hiçbir sertifika daha önce kabul edilmiyor. Değişen tek şey, belirsiz bir reddin daha erken
yeniden değerlendirilmesi. Yanıtlayıcı çöktüğünde bir sertifika için en fazla 2 s'de bir `openssl` süreci
başlatılıyor; böylece yük sınırlı kalıyor. R3 düzeltmesi ise iptal gecikmesinin üst sınırını ~60 s'den 30 s'ye
(good TTL) indiriyor.

### Senaryo raporu

- Başlıktaki "~60 s" iddiası artık sabit metin değil; o koşuda ölçülen S5 süresinden üretiliyor.
- "EN KRİTİK bulgu" bölümünün yerini ölçülen değerleri gösteren "OCSP zamanlaması" bölümü aldı.
- S4, belirsiz-sonuç TTL'i dolduktan sonra aynı kimliği yeniden deniyor; kabul edilmezse senaryo FAIL.

## Kalan sınırlar

- **R1'in kalıntısı:** imzadan sonraki ~0,2 s içinde yapılan ilk sorgu hâlâ "unknown" alabilir (6/10). KME bunu
  2 s sonra yeniden sorduğu için en kötü durumda yeni sertifika ~2,2 s sonra kabul edilir; S2'de 6 koşunun 3'ünde böyle
  oldu. Sıfırlamak için olay-tabanlı bir yanıtlayıcı gerekir (Dogtag OCSP, EJBCA, cfssl ocsprest); üretim önerisi
  değişmedi.
- **Keep-alive bağlantıda iptal gecikmesi:** üst sınır good TTL'i (30 s). Daha kısa bir sınır gerekiyorsa
  `--ocsp-cache-ttl-ms` düşürülebilir; bedeli daha sık OCSP sorgusu.
- **İzleyicinin süreci öldürmesi:** süreç tam bir isteğe yanıt verirken öldürülürse o istek bağlantı hatası alır.
  KME bunu "ulaşılamadı" sayar ve 2 s sonra yeniden sorar. Ardışık 200 sorguda (eski ve yeni) hiç hata görülmedi.
