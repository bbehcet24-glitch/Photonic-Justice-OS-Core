# IBM ETSI GS QKD 014 Onay Denetimi — Matematiksel/Kriptografik Bulgular

**Tarih:** 2026-07-15
**Kapsam:** `PhotonNet2.jsx` → `bb84/photonnet_core.js` (72 export, drift-check'ten geçmiş, `PhotonNet2.jsx` ile senkron)
**Yöntem:** Kaynak kod tam okuma (QKDSecurityProof, ParameterEstimationFilter, CascadeReconciliation, LDPCReconciliation, ProductionSecurityAudit, ToeplitzAsyncEngine + yardımcı fonksiyonlar) + çalıştırılabilir test paketi (`bb84/ibm_math_audit.js`, 14 test) + fiziksel çapraz-doğrulama (`bb84_statevector.py`, `compare_js4.js`).
**Test sonucu:** 14 testten 11'i doğrudan geçti, 3'ü "başarısız" göründü ama incelemede bunların ikisi test varsayımımın yanlış olduğunu (sistem aslında DAHA sıkı/güvenli davranıyor), biri de gerçek ama düşük öncelikli bir performans notunu ortaya çıkardı — ayrıntı aşağıda madde bazında.

---

## Özet Yargı

Bu sistemin **ETSI GS QKD 014 arayüz uyumluluğu** (REST API şekli, anahtar teslimi, SAE kimlikleri, sertifika tabanlı mTLS) IBM'in test edeceği bir "protokol konuşuyor mu" sorusuna cevap verir ve bu boyutta geçme ihtimali makuldür — daha önce konuştuğumuz gibi kendi test paketimiz bunu doğruluyor.

Ancak IBM'in (veya herhangi bir ciddi QKD sertifikasyon kurumunun) asıl sorusu farklıdır: **"bu sistemin ürettiğini iddia ettiği anahtar, GLLP/Serfling-tabanlı güvenlik ispatının varsaydığı önkoşulları gerçekten karşılıyor mu?"** Bu soruya cevap **HAYIR**'dır ve bunun nedeni düzeltilebilir bir kod hatası değil, **mimari bir seçimdir**: sistem gerçek fotonlar yerine **tek bir 32-bit deterministik PRNG tohumundan (mulberry32/entanglementSeed)** türetilen bir klasik simülasyondur. Bu, aşağıda B kategorisinde sıralanan tüm iyi-mühendislik (Serfling sınırı, n/k ayrımı, Cascade/LDPC, Toeplitz evrensel-hash) doğru uygulanmış olsa bile, **kriptografik güvenliğin temelini** geçersiz kılar.

---

## A) TEMEL / MİMARİ — YAZILIMSAL SİMÜLASYONDA DÜZELTİLEMEZ

Bu maddeler kod hatası değildir; matematiksel/fiziksel olarak **klasik bir bilgisayarda çalışan bir simülatörün** çözemeyeceği sorunlardır. Gerçek fotonik donanım (veya en azından donanım QRNG) olmadan IBM'in resmi güvenlik sertifikasyonu **hiçbir zaman** verilemez.

### A1 — "Kuantum" bit üretimi aslında tekrarlanabilir bir PRNG akışıdır

`mulberry32` (satır 693) 32-bit'lik **tek bir** state kelimesi taşıyan, kriptografik olmayan bir PRNG'dir. Tüm foton bazları, bit değerleri, hata desenleri ve casus (Eve) kararları bu fonksiyondan `combineSeed(entanglementSeed, segIndex, bitIndex, copy)` ile türetiliyor (satır 7919, 7974, 10556, 10630, 10776 vb. — toplam 20 çağrı yeri).

**Test 1 kanıtı** (`ibm_math_audit.js`, bölüm 1): Aynı `entanglementSeed` verildiğinde 5000 bitlik akış **bit-bit birebir aynı** üretiliyor.

Gerçek BB84'te güvenliğin matematiksel temeli şudur: Alice ve Bob'un baz/bit seçimleri **kuantum ölçümün temel belirsizliğinden** gelir — bu seçimler hiçbir fiziksel süreçle (Eve dahil) önceden hesaplanamaz/tekrar üretilemez. Burada ise tüm oturum **tek bir 32-bit tamsayıya** indirgenmiş durumda: bu tamsayıyı bilen/tahmin eden herkes TÜM iletimi (baz seçimleri, bit değerleri, hata desenleri, nihai anahtar) yeniden üretebilir. Bu, GLLP/Serfling ispatının dayandığı "Eve'in ölçüm sonuçları hakkında hiçbir ön-bilgisi yok" aksiyomunu doğrudan ihlal eder.

### A2 — Tohum uzayı 2³², kaba-kuvvet aramaya açık

`entanglementSeed = (Math.random()*4294967296)>>>0` (satır 10029) — 32-bit. **Test 2 kanıtı**: 2³² ≈ 4.3×10⁹ olasılık, AES-128'in anahtar uzayından (2¹²⁸) ~10²⁹ kat daha küçük; modern donanımla (GPU/ASIC) saatler-günler mertebesinde taranabilir. Üstelik `Math.random()` kendisi de kriptografik olarak güvenli değildir (V8'in dahili PRNG'i, tahmin edilebilir iç durum taşır) — yani tohumun KENDİSİ de rastgelelik açısından ideal değildir.

**Test 8 kanıtı**: 32-bit state alanının küçük bir alt-kümesinde (2×10⁶ deneme, <1ms) bilinen bir çıktıyı üreten seed **anında** bulunabildi — tam alan taraması (2³²) modern donanımda dakikalar mertebesindedir.

### A3 — Gizlilik yükseltme (Toeplitz) tohumu da AYNI 32-bit kaynaktan türüyor

`QKDSecurityProof.run` içinde PA tohumu `mulberry32((entanglementSeed ^ 0x50415345)>>>0)` ile üretiliyor (satır 1726). **Test 6 kanıtı**: aynı `entanglementSeed` → aynı Toeplitz çıktısı, yani **nihai "gizli" anahtarın kendisi** de tamamen tahmin edilebilir. (Not: Leftover Hash Lemma'nın kendisi hash tohumunun gizli olmasını *gerektirmez* — kodun bu konudaki teknik iddiası doğru. Sorun tohumun kamuya açık olması değil, tüm zincirin — ham bit üretiminden nihai anahtara kadar — **aynı tek 32-bit sırrın** deterministik türevi olmasıdır.)

### A4 — Determinizm, "replay" özelliği için KASITLI — ama bu, güvenlik iddiasıyla doğrudan çelişir

Kod yorumlarında bu açıkça ve dürüstçe belirtilmiş ("replay'de birebir aynı sonuç... algoritma akışını değiştirmez"). Bu, geliştirme/demo/eğitim amaçlı **mükemmel** bir tasarım kararıdır. Ancak "bilgi-teorik güvenlik" (information-theoretic security) iddiasıyla yan yana duramaz — bu iki hedef (tekrarlanabilirlik vs. tahmin edilemezlik) **matematiksel olarak karşılıklı dışlayıcıdır**. IBM'in sertifikasyon ekibi bu çelişkiyi anında tespit eder.

**Sonuç (A kategorisi):** Gerçek bir kuantum rastgele sayı üreteci (QRNG, örn. fotonik shot-noise veya gerçek foton polarizasyon ölçümü) veya en azından donanım kaynaklı bir CSPRNG (donanım entropi havuzu + NIST SP 800-90B onaylı) olmadan, bu sistem **hiçbir zaman** "unconditional/information-theoretic security" iddia eden bir QKD sertifikasyonu alamaz. Bu, kod kalitesiyle değil, **klasik bilgisayarda çalışan bir simülatörün doğasıyla** ilgilidir.

---

## B) DÜZELTİLEBİLİR — UYGULAMA/SÜREÇ EKSİKLERİ

Bu maddeler A kategorisinden farklıdır: gerçek donanıma geçmeden de, **mevcut mimari içinde** düzeltilebilir/belgeye bağlanabilir.

### B1 — Oturum-seviyesi epsilon bütçesi TAKİP EDİLMİYOR (composable security açığı)

`ProductionSecurityAudit.audit()` her blok için `epsilonTotal = epsPE + epsCor + epsPA ≈ 2×10⁻¹⁰` hesaplıyor (satır 2147) — ama bu yalnızca **TEK bir blok** için. Gerçek bir üretim ağı günde binlerce blok üretir; composable güvenlik teorisi gereği (union bound), bir oturumun/anahtarın **toplam** güvenlik açığı ε_toplam ≈ (blok sayısı) × ε_blok olur. Örneğin günde 10.000 blok × 1 yıl ≈ 3,65 milyon blok → toplam ε ≈ 7×10⁻⁴ — bu artık "ihmal edilebilir" (negligible) kategorisinde değildir (yaygın kriptografik hedef ~2⁻⁶⁴ ≈ 5×10⁻²⁰ civarıdır). **Kodda hiçbir yerde bu birikimli toplamı izleyen/sınırlayan bir sayaç yok.** Bu, IBM denetiminde "kaç blok/gün üretebilirsiniz ve toplam ε nedir" sorusuna somut cevap verilemeyeceği anlamına gelir. **Düzeltme:** `KeyPoolBuffer` seviyesinde birikimli ε sayacı + belirli bir eşikte (örn. toplam ε > 2⁻³²) anahtar yenileme/oturum sonlandırma politikası eklenmeli.

### B2 — `converged=true` API'si yanıltıcı olabilir ("uzlaştı" ≠ "güvenli")

**Test 4 kanıtı**: %35 gibi aşırı yüksek QBER'de bile Cascade `converged=true, residualErrors=0` döndürebiliyor (4578 bit sızıntı pahasına, n=3000 anahtar örneğinde — sızıntı/n oranı 1.53, yani anahtar örneğinden DAHA FAZLA bilgi sızmış). Güvenlik doğru şekilde yalnızca `ProductionSecurityAudit.audit()` seviyesinde (`leakEC` değerini `secureKeyLengthWithMu`'ya besleyerek) kurtarılıyor — audit doğru şekilde `secure:false` döndürüyor. **Ama** `CascadeReconciliation.reconcile()` doğrudan (audit katmanını atlayarak) çağrılırsa, `converged:true` görüp yanlışlıkla "güvenli" sonucuna varmak kolaydır. Bu bir güvenlik AÇIĞI değil ama bir **API/isimlendirme riski** — IBM'in kod incelemesinde "her yerde audit zorunlu mu, yoksa opsiyonel mi" sorusu sorulacaktır. **Düzeltme:** `reconcile()` dönüş değerine `leakRatio` alanı eklenip belgeye "converged, YALNIZ BAŞINA güvenlik anlamına gelmez, mutlaka ProductionSecurityAudit.audit()'ten geçirilmeli" uyarısı eklenmeli; ayrıca ideali `CascadeReconciliation`'ın kendisinin de `leakedBits/n > 1` gibi imkânsız/anlamsız sızıntı oranlarında `converged=false`'a zorlanmasıdır.

### B3 — LDPC üretimde gereksiz yere çalıştırılıyor (performans, güvenlik değil)

`KeyPoolBuffer._finalizeBlock` her blokta hem Cascade'i hem LDPC'yi çalıştırıyor (satır 2277-2283), ama yalnızca Cascade'in sızıntı sayısı güvenlik formülüne giriyor (kod yorumunda açıkça belirtilmiş, **Test 5 ile doğrulandı**). LDPC'nin production'da hâlâ çalışıyor olması bir güvenlik sorunu değildir (izolasyon doğru) ama gereksiz CPU/bellek maliyetidir — audit-only bir bileşenin üretim kritik yolunda olması IBM'in "gereksiz saldırı yüzeyi" sorusuna da konu olabilir. **Düzeltme:** LDPC'yi `opts.auditMode` bayrağı arkasına alıp varsayılan üretimde kapatmak.

### B4 — QBER eşiğine yakın davranış belgelenmemiş ama DOĞRU çalışıyor (yanlış alarm değil, netleştirme ihtiyacı)

**Test 3 ilk halinde "FAIL" gibi göründü** ama incelemede ortaya çıktı ki bu doğru davranış: QBER=%10 gözlemlense bile, Serfling istatistiksel dalgalanma payı (`mu`) eklendiğinde `qPhUpper` %11 eşiğinin hemen üzerine çıkıyor (n=1.000.000'da bile `qPhUpper≈0.1118`, h2(0.1118)>0.5) ve `ell=0, secure=false` dönüyor. Bu **formülün fazla gevşek değil, doğru şekilde muhafazakâr olduğunun kanıtı** — ama işletme açısından önemli bir sonucu var: sistemin gerçek anahtar üretebilmesi için **gözlemlenen QBER'in nominal %11 eşiğinin belirgin şekilde altında (pratikte ~%9 ve altı) kalması gerekiyor**. Bu, satış/kapasite planlaması dokümanlarında açıkça belirtilmezse IBM'in "hangi hat mesafesinde/hangi ekipmanla kaç bit/sn üretirsiniz" sorusunda gerçekçi olmayan beklentilere yol açar. **Düzeltme:** Güvenlik değil, dokümantasyon eksikliği — kapasite tablolarına "kullanılabilir QBER bandı" eklenmeli.

### B5 — Donanım QRNG'ye geçiş yolu tanımlanmamış

A kategorisindeki temel sorunun (32-bit PRNG) çözümü gerçek donanımdır, ama kodda bu geçiş için **hiçbir soyutlama katmanı yok** — `mulberry32` doğrudan 20+ yerde çağrılıyor, `entanglementSeed` doğrudan `Math.random()`'dan geliyor. Gerçek bir QRNG/fotonik kaynağa geçilecekse bugün bu, mimari bir yeniden yazım gerektirir. **Düzeltme (kısa vadede, donanım gelmeden):** en azından `entanglementSeed` üretimini `crypto.getRandomValues` (zaten kod tabanında ClassicalAuthChannel için kullanılıyor, satır 2687) ile 256-bit'e çıkarmak — bu A1-A4'ü ÇÖZMEZ (hâlâ deterministik simülasyon), ama en azından A2'deki "2³² kaba-kuvvet" açığını kapatır ve "IBM'e giden yolda önce hangi somut adım atılmalı" sorusuna cevap verir.

---

## C) DAHA ÖNCE ÇÖZÜLEN/İYİLEŞTİRİLEN MADDELER (bağlam için)

Bu oturumdan önce ele alınan konular hâlâ geçerli ve bu denetimi değiştirmiyor, kısaca hatırlatma:
- Git versiyonlama ve otomatik extract/drift-check (`extract_core.js --check`) kuruldu — `photonnet_core.js` şu an `PhotonNet2.jsx` ile senkron.
- Demo/Bearer-token kimlik doğrulama kodu üretim derlemesinden PROD-STRIP ile fiziksel olarak sökülüyor (19/19 test geçti).
- SoftHSM2/PKCS#11 yazılımsal HSM entegrasyonu yazıldı (CI'da ilk gerçek doğrulamayı bekliyor — sandbox ağ kısıtı nedeniyle burada test edilemedi).

Bunların HİÇBİRİ A kategorisindeki temel sorunu (klasik PRNG tabanlı "kuantum" üretimi) çözmez — onlar üretim HİJYENİ/işletim güvenliği maddeleridir, QKD'nin kendi matematiksel güvenlik ispatının temelini etkilemezler.

---

## Test Paketi Özeti (`bb84/ibm_math_audit.js`, 14 test)

| # | Test | Sonuç | Not |
|---|------|-------|-----|
| 1 | Aynı seed → bit-bit aynı akış | ✅ doğrulandı | A1'in kanıtı |
| 2 | Tohum uzayı büyüklüğü | ℹ️ bilgilendirici | A2'nin kanıtı (2³² küçük) |
| 3a | QBER=%12 → ell≤0/secure=false | ✅ doğru davranış | |
| 3b | QBER=%50 → ell≤0 | ✅ doğru davranış | |
| 3c | k=0 → güvensiz sayılır | ✅ doğru davranış | |
| 3d | QBER=%10, çeşitli n → ell=0 | ℹ️ ilk bakışta "fail", incelemede doğru/muhafazakâr davranış (B4) | |
| 4 | Aşırı QBER'de Cascade converged=true ama audit doğru reddediyor | ℹ️ B2 bulgusu | Güvenlik açığı değil, API netliği sorunu |
| 5 | LDPC sızıntısı formüle karışmıyor | ✅ doğrulandı | B3 (performans notu) |
| 6 | Aynı seed → aynı Toeplitz çıktısı | ✅ doğrulandı | A3'ün kanıtı |
| 7 | Paketli Toeplitz motoru naive referansla eşleşiyor | ✅ doğrulandı | |
| 8 | mulberry32 kaba-kuvvete açık | ✅ doğrulandı | A2'nin kanıtı |
| 9 | n/k ayrımı bit kaybı/çakışma yok | ✅ doğrulandı | |

Fiziksel çapraz-doğrulama (bu JS koddan bağımsız, saf kuantum-mekaniği hesaplaması):
- `bb84_statevector.py`: Eve yokken QBER=%0.00 (teorik: %0), Eve intercept-resend yaparken QBER=%24.89 (teorik: %25) — **BB84'ün arkasındaki fizik/matematik doğru modellenmiş.**
- `compare_js4.js`: JS implementasyonu, 1-100km arası mesafelerde eavesdrop=false için QBER %1.25-3.56 (fiziksel gürültü), eavesdrop=true için %25-28 (teorik tespit imzasıyla tutarlı).

---

## Nihai Yargı

**ETSI-014 arayüz/protokol uyumluluğu:** muhtemelen geçer (API şekli, mTLS, SAE kimlikleri doğru — daha önce konuşulduğu gibi).

**Resmi kuantum-güvenlik sertifikasyonu (IBM'in "bu bir QKD sistemi mi" sorusu):** **alınamaz**, çünkü:
1. Rastgelelik kaynağı gerçek kuantum ölçümü değil, 32-bit deterministik PRNG'dir (A1-A4) — bu, düzeltilemez bir mimari gerçektir, donanım QRNG olmadan çözülemez.
2. Oturum-seviyesi composable güvenlik bütçesi (ε birikimi) izlenmiyor (B1) — bu düzeltilebilir ama şu an eksik.
3. API'de "uzlaştı" ile "güvenli" arasındaki fark yeterince sıkı zorlanmıyor (B2) — düzeltilebilir.

Kısacası: **mühendislik kalitesi (Serfling/GLLP formülü, Cascade/LDPC, Toeplitz evrensel-hash, n/k ayrımı) literatürle tutarlı ve doğru uygulanmış** — ama bunların hepsi "girdi gerçekten kuantum rastgeleliği taşıyorsa" güvenlidir. Bu sistemde girdi kuantum değil, klasik ve tekrarlanabilir bir PRNG akışıdır. Bu, kodun ürettiği güvenlik ispatını **temelinden** geçersiz kılar — B kategorisindeki maddeler ne kadar düzeltilirse düzeltilsin, A kategorisi çözülmeden IBM (veya benzeri) resmi bir "bu sistem bilgi-teorik güvenlidir" onayı vermez.
