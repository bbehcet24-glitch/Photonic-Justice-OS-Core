# Kaos Mühendisliği #3 — Stokastik/Patlama (Burst) Gürültü Enjeksiyonu

**Talep:** "Gürültü üreten fonksiyonlara Monte Carlo simülasyonları veya Gaussian/Rayleigh dağılımları ekleyin. Gürültü statik olmasın; anlık sıçramalar (burst noise) ve rastgele faz kaymaları yaratsın. Algoritmanın bu dinamik kaosta kararlı bir anahtar üretip üretemediğini görün." → ardından **"sessiz/yanlış anlama eşiğini düzelt"** → ardından **"bağla"**.

Bu rapor üç aşamayı da kapsar: test, düzeltme, gerçek çağrı noktasına bağlama.

**Çekirdek bütünlüğü:** `bb84/photonnet_core.js` bu turun HİÇBİR adımında değiştirilmedi. SHA-256 (`8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05`) her commit öncesi/sonrası doğrulandı, `extract_core.js --check` her seferinde SENKRON döndü.

---

## Aşama 1 — Ön-tarama: kullanıcının önermesinin kısmi düzeltmesi

Talepte "gürültü muhtemelen sabit çarpanlarla/deterministik formüllerle hesaplanıyor" varsayımı vardı. İnceleme bunu **kısmen** doğruladı, kısmen düzeltti:

- Çekirdek zaten gerçek stokastik mekanizmalara sahip: `gaussianRandom()` (Box-Muller), `poissonSample(lambda)` (küçük λ için tam Poisson), `ScintillationEngine` (AR(1)/Ornstein-Uhlenbeck süreciyle **zamanla korelasyonlu** log-normal sönümleme — kendi yorumunda açıkça "türbülansın bursty/kümeli kayıp karakterini" hedeflediğini söylüyor), SNSPD sıcaklık sürüklenmesi (mean-reverting random walk).
- **Gerçek boşluk:** bu mekanizmaların HİÇBİRİ, BB84 anahtar-değişim yolunun (`deriveSiftedKey → propPhoton`) kullandığı çağrı biçiminde aktif değil. `ScintillationEngine` yalnızca `legaCtx.atmosphericConditions + elevationDeg` verilirse devreye girer; `deriveSiftedKey`, `propPhoton`'ı bu bağlamı **hiç geçmeden** çağırır (satır ~878). Yani üretimde kullanılan fiber/QKD fiziği, foton-başına tamamen bağımsız (IID) bir rastgelelik akışıyla çalışır — gerçek donanımda beklenen "anlık sıçrama" (EMI olayı, titreşim, lazer-modu-atlaması) hiçbir yerde modellenmiyor.

## Aşama 2 — Test yöntemi (çekirdeğe dokunmadan)

`deriveSiftedKey`'in kendi desteklediği `historicalRng` enjeksiyon noktası kullanıldı: Gilbert-Elliott 2-durumlu (İYİ/PATLAMA) Markov süreci + Gaussian-dağılımlı "faz kayması" büyüklüğüyle taban rastgele akış büküldü, ve **gerçek** (mock değil) `deriveSiftedKey → ParameterEstimationFilter.split → CascadeReconciliation.reconcile → QKDSecurityProof.run` boru hattı koşturuldu. Her patlama senaryosu, **aynı ortalama şiddete sahip ama kümelenmemiş (IID)** bir kontrol grubuyla karşılaştırıldı — böylece "kümelenme etkisi" ile "salt ortalama gürültü etkisi" birbirinden ayrıştırıldı.

Parametreler: 7 senaryo × 300 deneme, mesajda 6000 ham bit, 8 km fiber, %25 test payı. (`bb84/chaos_stochastic_noise_test.js`, commit `a63e0b9`)

### Sonuç tablosu

| Senaryo | Ort. QBER | Cascade yakınsama | Ort. sızıntı (bit) | Güvenli-anahtar oranı | Yanlış-eavesdrop-alarmı |
|---|---|---|---|---|---|
| Taban (gürültü yok) | %1.38 | %96.0 | 205.7 | %100.0 | %0.0 |
| Patlama — hafif | %1.65 | %97.0 | 246.6 | %100.0 | %0.0 |
| Kontrol (IID) — hafif | %1.61 | %99.3 | 239.2 | %100.0 | %0.0 |
| Patlama — orta | %4.53 | %100.0 | 607.9 | **%9.3** | %0.0 |
| Kontrol (IID) — orta | %4.08 | %100.0 | 528.9 | %25.7 | %0.0 |
| Patlama — şiddetli | %14.91 | %100.0 | 1721.1 | %0.0 | **%100.0** |
| Kontrol (IID) — şiddetli | %15.06 | %100.0 | 1591.4 | %0.0 | %100.0 |

### Bulgular

1. **Hafif patlama, IID kontrolden istatistiksel olarak ayırt edilemez** (ΔQBER=%0.03 puan, Δgüvenli-anahtar-oranı=0). `ParameterEstimationFilter.split`'in konumdan bağımsız rastgele Bernoulli seçimi ve `CascadeReconciliation`'ın her geçişte tam rastgele permütasyonu, düşük şiddette kümelenmeyi başarıyla "dağıtıyor".
2. **Orta patlamada kümelenme GERÇEKTEN fark yaratıyor:** QBER ort. %4.53 (IID kontrol %4.08, Δ=%0.44 puan) — ama daha çarpıcısı, güvenli-anahtar oranı %9.3'e düşerken IID kontrolde %25.7'de kalıyor (Δ=-%16.3 puan). Mekanizma: Markov hafızası, TEK bir fotonun kendi ardışık `rand()` kararları İÇİNDE ek korelasyon yaratıyor — bu, IID modelin taklit edemediği bir etki.
3. **Şiddetli patlamada saf çevresel gürültü (saldırgan YOK) denemelerin %100'ünde yanlış "eavesdropDetected=true" alarmı üretti.** Beklenen fail-closed davranış, ama gerçek bir kullanılabilirlik/DoS bulgusu.
4. **Çöken şey hata düzeltme protokolü DEĞİL:** `CascadeReconciliation` tüm senaryolarda (şiddetli dahil) %96-100 yakınsadı. Çöken, güvenlik-kanıtı katmanı (`QKDSecurityProof`) — yüksek `qPhUpper` tahmini yüzünden `ℓ≤0` (abort).
5. Ekstra elle test: %80 patlama oranı + severity=8 gibi uç bir senaryoda bile 50/50 deneme **crashsız** tamamlandı (0 anahtar, çökme değil) — `CascadeReconciliation.reconcile`/`QKDSecurityProof.run` boş girdide (n=0) bile zaten zarifçe dönüyordu (ek keşif, mevcut davranış).

## Aşama 3 — Düzeltme: "yanlış anlama eşiğini düzelt"

**Sınır (güvenlik ASLA yumuşatılmadı):** `deriveSiftedKey`'in `qber > 0.11` bayrağı **değiştirilmedi**. Gerçek BB84 güvenlik kanıtları (Shor-Preskill/GLLP) yüksek QBER'in nedenini kasıtlı olarak ayırt etmez — çünkü bunu güvenilir şekilde yapmanın yolu yoktur (Eve kendi saldırısını kanal gürültüsü gibi gösterebilir). Düzeltilen şey **güvenlik kararı değil, operatöre sunulan yorumdur**.

**Ayırt edici sinyal:** gerçek Eve her fotonu bağımsız ölçtüğü için sifted hata dizisi İİD/düzgün-yayılmıştır; çevresel patlama tanım gereği zamansal olarak kümelenmiştir. Bu, hata dizisi üzerinde bir **Wald–Wolfowitz koşu (runs) testi**yle ölçülüyor (z≪0 → kümelenmiş/muhtemelen donanım; z≈0 → düzgün/muhtemelen gerçek dinleme). `bb84/chaos_eavesdrop_discriminator.js` (commit `acb026d`) — verdict SALT OPERASYONELDİR, `securityDecisionUnaffected: true` — `QKDSecurityProof`'un ℓ/abort kararını asla etkilemez/atlamaz.

### Doğrulama tablosu (300 deneme/senaryo, `chaos_eavesdrop_discriminator_test.js`)

| Senaryo | Ham alarm oranı | "GERÇEK_DİNLEME" teşhisi | "ÇEVRESEL_PATLAMA" teşhisi |
|---|---|---|---|
| Taban (Eve yok, patlama yok) | %0.0 | — | — |
| Sadece gerçek Eve | %100.0 | **%97.0** | %3.0 |
| Sadece orta patlama | %0.0 | — | — |
| Sadece şiddetli patlama | %100.0 | %0.3 | **%99.7** |
| Eve + hafif patlama | %100.0 | %98.0 | %2.0 |
| Eve + şiddetli patlama (saldırgan gürültünün ardına saklanıyor) | %100.0 | **%92.7** | **%7.3** |

**Dürüst sınır:** en kötü senaryoda — bir saldırganın kendi saldırısını şiddetli çevresel gürültüyle maskelemeye çalışması — teşhis katmanı %92.7 doğru kalıyor ama %7.3 yanlışlıkla "çevresel" diyor (saf-Eve senaryosundaki %3.0'dan yüksek, sıfır değil). Bu sonuç yumuşatılmadan raporlanıyor. Ama bu katman salt tavsiye niteliğinde olduğu için, anahtar reddi/kısaltması bu %7.3'ten **etkilenmiyor**.

## Aşama 4 — "bağla": gerçek çağrı noktasına bağlama

`deriveSiftedKey`/`QuantumKeyDistribution`'ı doğrudan çağıran tek gerçek Node call site'ı, önceden dokümante edilmiş şekilde bozuk olan `compare_js4.js`'ti (kapsam dışı). Geri kalan tek gerçek üretim kullanımı `PhotonNet2.jsx`'in tarayıcı-içi UI katmanı — orası, çekirdeğin `extract_core.js` ile senkronize KAYNAĞI olduğu için kasıtlı olarak dışarıda tutuldu.

Bunun yerine, projenin kendi emsaline bağlandı: **`client_network_report.js`** (commit `bd1efac`) — bu dosya `propPhoton`/`bb84Reconcile`'ı çekirdekten doğrudan çağırıp `deriveSiftedKey` ile matematiksel olarak aynı `>%11` eşiğini (`assessRagnarokResilience → olculenGercekAlarmUstundeMi`) kendi ayrı ölçüm döngüsünde tekrarlıyordu. `measureLinkQber` artık zaman-sıralı bir hata-bayrağı dizisi tutuyor; eşik aşıldığında `diagnoseFromErrorFlags` çağrılıp sonuç yeni `dinlemeTeshisi` alanına ekleniyor — mevcut `olculenGercekAlarmUstundeMi`'nin YANINA, üstüne yazmadan.

**Regresyon doğrulaması:**
- `sample_client_network.json` (geçerli veri): çıktı, yeni alan ve zaman damgası hariç eski sürümle **programatik olarak birebir aynı**.
- `/tmp/bozuk_client_network.json` (bozuk veri, önceki turdan): crashsız tamamlandı, mevcut guard davranışı (girdi uyarıları, sanitize) değişmedi.
- Discriminator'ın kendi testi, refactor sonrası **aynı sonuçları** verdi (tablo yukarıda).

## Dosya rolleri

| Dosya | Rol |
|---|---|
| `bb84/chaos_stochastic_noise_test.js` | Monte Carlo burst/Gaussian-faz-kayması testi — bulgu turu |
| `bb84/reports/chaos_stochastic_noise_report.json` | Ham sayısal sonuçlar (Aşama 2 tablosu) |
| `bb84/chaos_eavesdrop_discriminator.js` | Düzeltme: koşu-testi tabanlı, salt operasyonel teşhis katmanı |
| `bb84/chaos_eavesdrop_discriminator_test.js` | Düzeltmenin doğrulama testi |
| `bb84/reports/chaos_eavesdrop_discriminator_report.json` | Ham doğrulama sonuçları (Aşama 3 tablosu) |
| `bb84/client_network_report.js` | Gerçek çağrı noktası — `dinlemeTeshisi` alanı eklendi |

## Commit'ler

- `a63e0b9` — Kaos Mühendisliği #3: test
- `acb026d` — Düzeltme: koşu-testi teşhis katmanı
- `bd1efac` — Bağlama: `client_network_report.js`

Çekirdeğe (`photonnet_core.js`) bu turun hiçbir adımında tek satır dokunulmadı.
