#!/usr/bin/env bash
# revoke_cert.sh — CA TARAFINDA çalıştırılır. Bir sertifikayı ANINDA
# iptal eder (index.txt'te "R" olarak işaretler) ve CRL'yi (Sertifika
# İptal Listesi) YENİDEN ÜRETİR — etsi014_kme_server.js --crl= ile bu
# dosyayı okuyup iptal edilen sertifikaların TLS handshake aşamasında
# REDDEDİLMESİNİ sağlar (bkz. sunucu kodundaki hot-reload mekanizması —
# CRL dosyası değiştiğinde sunucuyu YENİDEN BAŞLATMANIZA GEREK YOKTUR).
#
# KULLANIM:
#   ./revoke_cert.sh <CA_pki_dizini> <sertifika_dosyası.pem>
#   ./revoke_cert.sh <CA_pki_dizini> --serial 100A
#   HSM-ARKALI CA (ca_init.sh --pkcs11-uri ile kurulmuş; ca-key.pem YOK):
#   ./revoke_cert.sh <CA_pki_dizini> <sertifika.pem> --engine pkcs11 --key-uri "pkcs11:token=...;object=...;type=private"
#     (PKCS11_MODULE_PATH + PKCS11_PIN env gerekir — bkz. hsm_init.sh; sign_csr.sh ile AYNI arayüz)
#
# FAIL-CLOSED (GERÇEK BULGU): bu script önceden `openssl ca -revoke`'u
# `... || true` ile çalıştırıyordu — iptal GERÇEKTEN başarısız olsa bile
# "İPTAL EDİLDİ" yazıp CRL'i o sertifika OLMADAN yeniden üretiyor ve 0 ile
# çıkıyordu (çağıran, geçerliliğini koruyan bir sertifikayı iptal edilmiş
# sanıyordu). Artık: (1) openssl hatası yalnızca "Already revoked" ise
# (idempotent, zararsız) tolere edilir, başka her hatada çıkış 1; (2)
# "İPTAL EDİLDİ" yalnızca index.txt'te "R" VE yeni CRL'de o serial
# DOĞRULANDIKTAN sonra yazılır.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

CA_DIR="${1:?kullanım: revoke_cert.sh <CA_pki_dizini> <sertifika.pem | --serial HEX> [--engine pkcs11 --key-uri URI]}"
TARGET="${2:?iptal edilecek sertifika dosyası veya --serial <hex> gerekli}"
if [ "$TARGET" = "--serial" ]; then
  SERIAL_ARG="${3:?--serial ile hex serial numarası verilmeli}"
  shift 3
else
  shift 2
fi
ENGINE_MODE=0
KEY_URI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE_MODE=1; shift; [ "${1:-}" = "pkcs11" ] && shift ;;
    --key-uri) KEY_URI="${2:?--key-uri bir değer ister}"; shift 2 ;;
    *) echo "HATA: bilinmeyen argüman: $1" >&2; exit 1 ;;
  esac
done

# ÖNEMLİ: sertifika dosya yolunu $CA_DIR'e cd YAPMADAN ÖNCE mutlak yola
# çeviriyoruz — $TARGET göreli bir yol olarak verilmiş olabilir (çağıranın
# O ANKİ dizinine göre), --serial ile çağrıldıysa bu adım atlanır (o zaten
# CA veritabanı içindeki bir yola işaret eder).
if [ "$TARGET" != "--serial" ]; then
  if [ ! -f "$TARGET" ]; then echo "HATA: sertifika dosyası bulunamadı: $TARGET" >&2; exit 1; fi
  TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
fi

cd "$CA_DIR"
if [ ! -f ca-cert.pem ]; then
  echo "HATA: bu dizinde ca-cert.pem yok" >&2
  exit 1
fi
# Anahtar argümanları: dosya modunda BOŞ (config'deki private_key =
# ca-key.pem kullanılır), HSM modunda token (sign_csr.sh/ca_init.sh ile
# AYNI desen; -keyfile config'deki private_key'i geçersiz kılar).
KEYARGS=()
if [ "$ENGINE_MODE" = "1" ]; then
  : "${PKCS11_MODULE_PATH:?--engine pkcs11 verildi ama PKCS11_MODULE_PATH env değişkeni BOŞ (bkz. hsm_init.sh)}"
  : "${PKCS11_PIN:?--engine pkcs11 verildi ama PKCS11_PIN env değişkeni BOŞ (bkz. hsm_init.sh)}"
  if [ -z "$KEY_URI" ]; then echo "HATA: --engine pkcs11 verildi ama --key-uri eksik" >&2; exit 1; fi
  KEYARGS=(-engine pkcs11 -keyform engine -keyfile "${KEY_URI};pin-value=${PKCS11_PIN}")
  echo "[REVOKE] --engine pkcs11: iptal kaydı ve CRL token'daki CA anahtarıyla imzalanacak ('$KEY_URI')"
elif [ ! -f ca-key.pem ]; then
  echo "HATA: bu dizinde ca-key.pem yok — HSM-arkalı bir CA ise --engine pkcs11 --key-uri ... verin" >&2
  exit 1
fi

if [ "$TARGET" = "--serial" ]; then
  CERT_PATH="ca-db/newcerts/${SERIAL_ARG}.pem"
  if [ ! -f "$CERT_PATH" ]; then
    echo "HATA: ca-db/newcerts/${SERIAL_ARG}.pem bulunamadı — bu CA tarafından imzalanmamış olabilir" >&2
    exit 1
  fi
else
  CERT_PATH="$TARGET"
fi

CN=$(openssl x509 -in "$CERT_PATH" -noout -subject -nameopt multiline | awk -F= '/commonName/{gsub(/^ +| +$/,"",$2); print $2}')
SERIAL=$(openssl x509 -in "$CERT_PATH" -noout -serial | cut -d= -f2)

set +e
REVOKE_OUT=$(openssl ca -config ca-db/openssl-ca.cnf "${KEYARGS[@]}" -revoke "$CERT_PATH" -crl_reason keyCompromise 2>&1)
REVOKE_RC=$?
set -e
printf '%s\n' "$REVOKE_OUT" | grep -v "^$" || true
if [ "$REVOKE_RC" -ne 0 ]; then
  if printf '%s' "$REVOKE_OUT" | grep -q "Already revoked"; then
    echo "[REVOKE] Bu sertifika ZATEN iptal edilmişti (serial=${SERIAL}) — CRL yine de yeniden üretilecek."
  else
    echo "HATA: iptal BAŞARISIZ (openssl çıkış kodu ${REVOKE_RC}) — CRL GÜNCELLENMEDİ; CN=${CN}, serial=${SERIAL} sertifikası HÂLÂ GEÇERLİ olabilir." >&2
    exit 1
  fi
fi
# Son-koşul #1: CA veritabanında GERÇEKTEN "R" (revoked) mi?
DB_STATUS=$(awk -F'\t' -v s="$SERIAL" 'toupper($4)==toupper(s){print $1}' ca-db/index.txt | tail -n 1)
if [ "$DB_STATUS" != "R" ]; then
  echo "HATA: openssl başarılı döndü ama ca-db/index.txt'te serial=${SERIAL} durumu 'R' değil ('${DB_STATUS:-kayıt yok}') — iptal DOĞRULANAMADI." >&2
  exit 1
fi

# ATOMİK YAZMA (Kaos Mühendisliği #7 bulgusu): openssl'in `-out FILE`
# doğrudan hedef dosyaya yazması, dosyayı ÖNCE 0 byte'a KISALTIP sonra
# içeriği yazıyor — bu, etsi014_kme_server.js'in fs.watchFile ile bu
# dosyayı İZLEYEN hot-reload'ının, tam da bu birkaç-milisaniyelik
# pencerede bir okuma yapması durumunda BOŞ/KESİK bir CRL okumasına yol
# açabileceği GERÇEK, ÖLÇÜLEREK DOĞRULANMIŞ bir yarış durumu (bkz. commit
# mesajı). Sunucu tarafı bunu ZATEN güvenle ele alıyor (Node'un TLS
# katmanı boş/bozuk bir CRL'i "Failed to parse CRL" ile REDDEDİYOR,
# sunucunun try/catch'i eski CRL'i korumaya devam ediyor — yani bu BİR
# GÜVENLİK AÇIĞI DEĞİLDİ, sadece kaçırılan bir yeniden-yükleme
# denemesiydi). Ama üretimde bunun HİÇ yaşanmaması gereken bir sınıf hata
# olduğu için — standart PKI hijyeni — CRL artık AYNI dizinde bir geçici
# dosyaya yazılıp ATOMİK olarak (rename/`mv`, POSIX'te tek bir syscall)
# hedef ada taşınıyor: okuyucular HER ZAMAN ya TAM eski ya TAM yeni
# içeriği görür, ARA bir durum asla.
openssl ca -config ca-db/openssl-ca.cnf "${KEYARGS[@]}" -gencrl -out crl/ca-crl.pem.tmp
# Son-koşul #2: yeni CRL bu serial'i GERÇEKTEN içeriyor mu? (içermiyorsa
# eski CRL KORUNUR — geçici dosya yayına alınmaz.)
if ! openssl crl -in crl/ca-crl.pem.tmp -noout -text | grep -qiE "Serial Number: *${SERIAL}\$"; then
  rm -f crl/ca-crl.pem.tmp
  echo "HATA: yeni CRL serial=${SERIAL} kaydını İÇERMİYOR — CRL yayına ALINMADI (eski CRL korunuyor)." >&2
  exit 1
fi
mv -f crl/ca-crl.pem.tmp crl/ca-crl.pem
echo "[REVOKE] İPTAL EDİLDİ ve DOĞRULANDI: CN=${CN}, serial=${SERIAL} (index.txt=R, CRL'de mevcut)"
echo "[REVOKE] CRL yeniden üretildi (atomik yeniden adlandırma ile): $(pwd)/crl/ca-crl.pem"
echo "[REVOKE] Sunucu bu dosyayı --crl=$(pwd)/crl/ca-crl.pem ile izliyorsa, iptal EN GEÇ birkaç saniye içinde (dosya-değişikliği algılamasıyla) yürürlüğe girer — yeniden başlatma GEREKMEZ."
