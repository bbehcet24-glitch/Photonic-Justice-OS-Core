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
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

CA_DIR="${1:?kullanım: revoke_cert.sh <CA_pki_dizini> <sertifika.pem | --serial HEX>}"
TARGET="${2:?iptal edilecek sertifika dosyası veya --serial <hex> gerekli}"

# ÖNEMLİ: sertifika dosya yolunu $CA_DIR'e cd YAPMADAN ÖNCE mutlak yola
# çeviriyoruz — $TARGET göreli bir yol olarak verilmiş olabilir (çağıranın
# O ANKİ dizinine göre), --serial ile çağrıldıysa bu adım atlanır (o zaten
# CA veritabanı içindeki bir yola işaret eder).
if [ "$TARGET" != "--serial" ]; then
  if [ ! -f "$TARGET" ]; then echo "HATA: sertifika dosyası bulunamadı: $TARGET" >&2; exit 1; fi
  TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
fi

cd "$CA_DIR"
if [ ! -f ca-key.pem ] || [ ! -f ca-cert.pem ]; then
  echo "HATA: bu dizinde ca-key.pem/ca-cert.pem yok" >&2
  exit 1
fi

if [ "$TARGET" = "--serial" ]; then
  SERIAL="${3:?--serial ile hex serial numarası verilmeli}"
  CERT_PATH="ca-db/newcerts/${SERIAL}.pem"
  if [ ! -f "$CERT_PATH" ]; then
    echo "HATA: ca-db/newcerts/${SERIAL}.pem bulunamadı — bu CA tarafından imzalanmamış olabilir" >&2
    exit 1
  fi
else
  CERT_PATH="$TARGET"
fi

CN=$(openssl x509 -in "$CERT_PATH" -noout -subject -nameopt multiline | awk -F= '/commonName/{gsub(/^ +| +$/,"",$2); print $2}')
SERIAL=$(openssl x509 -in "$CERT_PATH" -noout -serial | cut -d= -f2)

openssl ca -config ca-db/openssl-ca.cnf -revoke "$CERT_PATH" -crl_reason keyCompromise 2>&1 | grep -v "^$" || true
echo "[REVOKE] İPTAL EDİLDİ: CN=${CN}, serial=${SERIAL}"

openssl ca -config ca-db/openssl-ca.cnf -gencrl -out crl/ca-crl.pem
echo "[REVOKE] CRL yeniden üretildi: $(pwd)/crl/ca-crl.pem"
echo "[REVOKE] Sunucu bu dosyayı --crl=$(pwd)/crl/ca-crl.pem ile izliyorsa, iptal EN GEÇ birkaç saniye içinde (dosya-değişikliği algılamasıyla) yürürlüğe girer — yeniden başlatma GEREKMEZ."
