# QKDNetSim'i sıfırdan derleme (bu sandbox ortamında)

QKDNetSim, Saraybosna Üniversitesi ve VSB Ostrava Teknik Üniversitesi
telekomünikasyon bölümlerince geliştirilen, akademik olarak yayınlanmış
(JOCN / IEEE Network / ACM Computing Surveys) bir NS-3 modülüdür. ETSI GS
QKD 014 ve 004 arayüzlerini destekleyen tam işlevsel bir Anahtar Yönetim
Sistemi (KMS) simülasyonu sunar.

**Bu, PhotonNet'in bir parçası DEĞİLDİR** — bilinçli olarak `/tmp` içinde
izole tutulan, üçüncü taraf bir karşılaştırma referansıdır. Repoya yalnızca
onun ürettiği veriden çıkarılan profil (`bb84/qkdnetsim_traffic_profile.json`)
ve o profili üreten araç (`bb84/tools/extract_qkdnetsim_profile.js`) girer.

## Neden bu doküman var

Bulut konteyneri sıfırlandığında `/tmp` içindeki derleme ağacı tamamen
kaybolur ve onunla birlikte `qkdnetsim_traffic_profile.json`'u yeniden
üretme yeteneği de gider. Bu doküman, o yeteneği kalıcı kılar.

## Ortam kısıtı (önemli)

Bu sandbox'ta **`apt-get` tamamen çalışmıyor** — `archive.ubuntu.com` ve
`security.ubuntu.com` HTTP 403 döndürüyor. Dolayısıyla QKDNetSim'in
README'sindeki `sudo apt-get install libcrypto++-dev ...` adımı
UYGULANAMAZ. Tek zorunlu yerel bağımlılık olan Crypto++ **kaynaktan**
derlenir. Ayrıca `gitlab.com` bloklu (CONNECT tünelinde 403), bu yüzden
README'nin `gitlab.com/nsnam/ns-3-dev.git` adresi yerine resmî GitHub
aynası kullanılır (aynı `ns-3.46` etiketi mevcuttur).

## Adımlar

```bash
mkdir -p /tmp/qkdnetsim_build && cd /tmp/qkdnetsim_build

# 1) Crypto++ (tek zorunlu yerel bağımlılık) — kaynaktan, ~5 dk
git clone --depth 1 https://github.com/weidai11/cryptopp.git
cd cryptopp && make -j2 libcryptopp.a && make install PREFIX=/usr && cd ..

# 2) ÜÇ İSİM UYUŞMAZLIĞININ ÇÖZÜMÜ (bunlar olmadan derleme BAŞARISIZ olur)
#    (a) contrib/qkdnetsim/CMakeLists.txt hem 'crypto++' hem 'cryptopp'
#        kütüphane adını arar ve İKİSİNİ DE bulmayı şart koşar; upstream
#        Crypto++ ise yalnızca libcryptopp.a kurar (artı işaretsiz).
ln -sf /usr/lib/libcryptopp.a /usr/lib/libcrypto++.a
#    (b) qkdnetsim'in kendi kaynağı (model/qkd-encryptor.h) Debian
#        paketleme geleneğine göre `#include <crypto++/aes.h>` yapar;
#        upstream ise başlıkları /usr/include/cryptopp altına kurar.
ln -sf /usr/include/cryptopp /usr/include/crypto++
#    (c) ns-3.46'nın örnek-bağlama CMake mantığı, MPI kapalı olsa bile
#        (`MPI Support: OFF`) bağlantı komutuna koşulsuz `-lmpi` ekliyor.
#        Gerçek MPI kod yolları #ifdef ile derleme dışı kaldığı için
#        boş bir stub bağlayıcıyı memnun etmeye YETER (hiçbir MPI
#        sembolü gerçekte çağrılmaz).
echo 'int __qkdnetsim_libmpi_stub_symbol = 0;' > /tmp/mpi_stub.c
gcc -shared -fPIC -o /usr/lib/libmpi.so /tmp/mpi_stub.c

# 3) ns-3.46 (gitlab bloklu → resmî GitHub aynası, aynı etiket)
git clone --depth 1 -b ns-3.46 https://github.com/nsnam/ns-3-dev-git.git ns-3-dev

# 4) QKDNetSim'i contrib altına al + yamaları uygula
git clone --depth 1 -b master https://github.com/QKDNetSim/qkdnetsim.git /tmp/qkdnetsim_real
cp -r /tmp/qkdnetsim_real ns-3-dev/contrib/qkdnetsim
cd ns-3-dev
git apply contrib/qkdnetsim/patches/gnuplot_h.patches
git apply contrib/qkdnetsim/patches/gnuplot_cc.patches

# 5) Yapılandır — çıktıda şunları GÖRMELİSİNİZ:
#      "find_external_library: CRYPTOPP was found."  (iki kez)
#      "Modules configured to be built:" listesinde  qkdnetsim
#    (README --enable-mpi diyor ama bu ortamda MPI yok; örnekler MPI'sız
#     de sorunsuz derleniyor.)
./ns3 configure --enable-examples

# 6) Derle — TEK PARÇADA ~35-40 dk. Bash aracının 10 dk sınırı yüzünden
#    aynı komut arka arkaya birkaç kez çalıştırılmalıdır; ninja artımlı
#    olduğu için her seferinde kaldığı yerden devam eder.
./ns3 build examples_qkdnetsim_etsi_014

# 7) Koş (~16 sn) — çıktı deterministiktir: 28.295 satır, 28.140 anahtar
./ns3 run examples_qkdnetsim_etsi_014 > /tmp/qkd_etsi014_full.log 2>&1
wc -l /tmp/qkd_etsi014_full.log            # → 28295
grep -c "Served (bits)" /tmp/qkd_etsi014_full.log   # → 28140
```

## Profili yeniden üret

```bash
cd /root/work/photonnet
node bb84/tools/extract_qkdnetsim_profile.js
# → bb84/qkdnetsim_traffic_profile.json (28140 olay, 130.67 bit ort.)
```

Sonra köprü ve havuz-tıkanması testleri yeniden çalışır hâle gelir:

```bash
cd bb84
./run_qkdnetsim_traffic_bridge.sh      # → 2814/2814 mTLS teslimi, 3/3 sahte-sertifika reddi
./run_buffer_starvation_test.sh        # → temiz 503 tükenme davranışı
```

## Doğrulanmış çıktı değerleri

Bu adımlar iki ayrı oturumda uygulandı ve **birebir aynı** sonucu verdi
(ns-3 varsayılan sabit tohumlarla çalıştığı için koşum deterministiktir):

| Ölçüm | Değer |
|---|---|
| Log satırı | 28.295 |
| Teslim edilen anahtar | 28.140 |
| Ortalama anahtar boyutu | 130,67 bit |
| Toplam teslim edilen bit | 3.677.184 |
| Kümülatif eğri veri noktası | 27.484 |
| Simüle süre | 500 s |
| Gerçek koşum süresi | ~16 s |

## Kaynak

Repo: <https://github.com/QKDNetSim/qkdnetsim> · Doküman: <https://www.qkdnetsim.info>

Atıf (README'den): Dervisevic, E., Voznak, M. ve Mehic, M., 2024.
*Large-Scale Quantum Key Distribution Network Simulator.* Journal of
Optical Communications and Networking. doi:10.1364/JOCN.503356
