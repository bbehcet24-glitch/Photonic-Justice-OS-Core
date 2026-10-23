#!/usr/bin/env bash
# run_ocsp_responder.sh — CA veritabanına (ca-db/index.txt) dayalı GERÇEK
# bir OCSP (Online Certificate Status Protocol) yanıtlayıcısı başlatır.
#
# NEDEN CRL'YE EK OLARAK OCSP: CRL, sunucunun periyodik olarak indirdiği
# bir "iptal edilenler listesi"dir — dosya değişikliği algılamasıyla
# (bkz. etsi014_kme_server.js fs.watchFile) makul derecede taze
# tutulabilir, ama OCSP her istekte (veya kısa TTL'li bir önbellekle)
# CA'ya "bu SERİ NUMARASI şu an geçerli mi?" diye CANLI SORAR — iptal,
# CRL'nin yeniden üretilip DAĞITILMASINI beklemeden ANINDA etkili olur.
# etsi014_kme_server.js, --ocsp-responder=<bu_sunucunun_URL'si> ile
# verildiğinde her mTLS isteğinde openssl'in `ocsp` istemci komutunu
# alt-süreç olarak çağırıp durumu CANLI kontrol eder (bkz. sunucu kodu,
# checkOcsp fonksiyonu).
#
# KULLANIM:
#   ./run_ocsp_responder.sh <CA_pki_dizini> [port=8888]
# (arka planda çalıştırmak için sonuna '&' ekleyin)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

CA_DIR="${1:?kullanım: run_ocsp_responder.sh <CA_pki_dizini> [port]}"
PORT="${2:-8888}"

cd "$CA_DIR"
if [ ! -f ca-key.pem ] || [ ! -f ca-cert.pem ]; then
  echo "HATA: bu dizinde ca-key.pem/ca-cert.pem yok" >&2
  exit 1
fi

echo "[OCSP] Yanıtlayıcı başlatılıyor: http://0.0.0.0:${PORT} (CA veritabanı: ca-db/index.txt)"
echo "[OCSP] İKAZ (dürüstlük notu): bu referans yanıtlayıcı CA'nın KENDİ anahtarını (ca-key.pem) doğrudan OCSP yanıtı imzalamak için kullanıyor — gerçek üretim dağıtımlarında genelde CA'dan AYRI, kısa ömürlü, delege edilmiş bir 'OCSP signing' sertifikası kullanılır (ki CA anahtarı OCSP yanıtlayıcı sürecine hiç maruz kalmasın). Bu basitleştirme, CA anahtarının hava-boşluklu/HSM saklanması gerekliliğiyle GERİLİM içindedir — gerçek dağıtımda OCSP yanıtlayıcısını CA'dan ayırın."
echo "[OCSP] TESPİT EDİLEN GERÇEK DÜNYA SORUNU #1 (bu ortamda ölçüldü): openssl'in 'ocsp' komutu -index dosyasını YALNIZCA BAŞLANGIÇTA okur ve süreç çalışmaya devam ettikçe İPTALLERİ (revoke_cert.sh sonrası) ASLA YENİDEN OKUMAZ."
echo "[OCSP] TESPİT EDİLEN GERÇEK DÜNYA SORUNU #2 (İLK DÜZELTME YETERSİZ ÇIKTI — bu ortamda ölçülerek bulundu): yalnızca '-nrequest 1' ile döngüde yeniden başlatmak TEK BAŞINA YETERLİ DEĞİL — yeniden başlayan süreç index.txt'yi KENDİ BAŞLANGICINDA bir kez okur, sonra YENİ BİR İSTEK GELENE KADAR (bu, isteksiz kalırsa saniyeler-dakikalar sürebilir) BOŞTA BEKLER. Bu bekleme SIRASINDA bir iptal olursa, süreç bunu ASLA öğrenmez ve isteğe ESKİ (iptal-öncesi) yanıtı verir — canlı olarak ölçüldü: revoke_cert.sh çalıştıktan 31+ saniye sonra bile 'good' yanıtı verilmeye devam ettiği görüldü."
echo "[OCSP] GERÇEK ÇÖZÜM: '-nrequest 1' döngüsüne EK OLARAK, ayrı bir arka-plan izleyici index.txt'nin güncel parmak izini (inode + boyut + nanosaniye mtime) her ${OCSP_INDEX_POLL_S:-0.2} s'de bir, ÇALIŞAN SÜRECİN YÜKLEDİĞİ parmak iziyle karşılaştırır; farklıysa süreci ÖLDÜRÜR — ana döngü HEMEN index.txt'yi YENİDEN OKUYAN taze bir süreçle yeniden başlar. Kalan bayatlık penceresi ~tarama aralığı + yeniden başlama (ölçüm: bkz. bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md). Eski izleyici (saniye çözünürlüğü, 1 s tarama, ilk taramada taban) üç biçimde bayat kalabiliyordu."
echo "[OCSP] İKAZ (kalan küçük yarış durumu, dürüstlük notu): index.txt tam olarak bir openssl ocsp süreci başlatılıp PID dosyasına henüz yazmadığı ÇOK KISA an içinde değişirse, izleyici bir SONRAKI taramada bunu yakalar (yani en kötü durum ~2 tarama aralığı, sıfır DEĞİL; KME bu yüzden belirsiz/unknown sonucu yalnız 2 s önbelleğe alır) — bu referans/demo kullanımı için kabul edilebilir görülmüştür; üretimde OpenSSL'in kendi ocsp yanıtlayıcı CLI'ı yerine index.txt/veritabanı değişikliklerini olay-tabanlı (event-driven) izleyen adanmış bir OCSP yanıtlayıcı (ör. Dogtag OCSP, EJBCA, cfssl ocsprest) kullanılmalıdır."

INDEX_FILE="$(pwd)/ca-db/index.txt"
PIDFILE=$(mktemp)
WATCHER_PID=""
cleanup() {
  rm -f "$PIDFILE"
  [ -n "$WATCHER_PID" ] && kill "$WATCHER_PID" 2>/dev/null || true
  [ -f "$PIDFILE.child" ] && kill "$(cat "$PIDFILE.child" 2>/dev/null)" 2>/dev/null || true
  rm -f "$PIDFILE.child" "$PIDFILE.fp"
}
trap 'cleanup; echo "[OCSP] durduruluyor."; exit 0' INT TERM

# ── index.txt izleyici (arka plan alt-kabuk) ────────────────────────
# DEĞİŞMEZ: çalışan openssl ocsp süreci, index.txt'nin ŞU ANKİ hâlini
# yüklemiş olmalı. Ana döngü her süreci başlatmadan HEMEN ÖNCE index'in
# parmak izini (inode + boyut + NANOSANİYE mtime) "$PIDFILE.fp"ye yazar;
# izleyici her OCSP_INDEX_POLL_S'de (vars. 0,2 s) güncel parmak izini
# bununla karşılaştırır, farklıysa süreci öldürür — ana döngü HEMEN
# index'i YENİDEN OKUYAN taze bir süreç başlatır.
#
# ÖLÇÜLEREK DÜZELTİLDİ (bb84/docs/OCSP_NEGATIVE_CACHE_ANALYSIS.md). Eski
# izleyici "önceki taramada gördüğüm mtime"a (SANİYE çözünürlüğü, 1 s'de
# bir) bakıyordu; üç ayrı biçimde bayat kalabiliyordu:
#   R1 1 s'lik tarama → yeni imzalanan sertifikaya ~1 s "unknown"
#      (imzadan 0 ms sonra 10/10, 500 ms sonra 4/10)
#   R2 aynı saniyedeki ikinci değişiklik görülmüyordu (20 denemede 11)
#   R3 ilk tarama (başlangıçtan ~1 s sonra) yalnız TABAN kaydediyordu:
#      yanıtlayıcı (yeniden) başladıktan sonraki ilk saniyedeki değişiklik
#      tabana karışıp HİÇ fark edilmiyordu → bir sonraki isteğe kadar bayat.
#      Senaryo S5'teki tutarlı ~60 s'nin kaynağı buydu (S4 yanıtlayıcıyı
#      yeniden başlatıyor, S5'in iptali o ilk saniyeye düşüyordu).
# "Sürecin yüklediği parmak izi"ne karşı karşılaştırma üçünü birden kapatır.
INDEX_POLL_S="${OCSP_INDEX_POLL_S:-0.2}"
index_fp() { stat -c '%i %s %.9Y' "$INDEX_FILE" 2>/dev/null || echo "yok"; }
(
  while true; do
    sleep "$INDEX_POLL_S"
    [ -f "$PIDFILE.child" ] && [ -f "$PIDFILE.fp" ] || continue
    if [ "$(index_fp)" != "$(cat "$PIDFILE.fp" 2>/dev/null)" ]; then
      kill "$(cat "$PIDFILE.child" 2>/dev/null)" 2>/dev/null || true
    fi
  done
) &
WATCHER_PID=$!

while true; do
  index_fp > "$PIDFILE.fp"   # süreç index'i bu andan SONRA okur; arada değişirse izleyici gereksiz bir yeniden başlatma yapar (zararsız)
  openssl ocsp -port "$PORT" -index ca-db/index.txt -CA ca-cert.pem -rkey ca-key.pem -rsigner ca-cert.pem -nrequest 1 -text >/dev/null 2>&1 &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PIDFILE.child"
  wait "$CHILD_PID" 2>/dev/null || true
done
