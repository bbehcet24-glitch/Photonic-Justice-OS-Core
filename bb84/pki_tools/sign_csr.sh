#!/usr/bin/env bash
# sign_csr.sh — CA TARAFINDA çalıştırılır (ca-key.pem'in veya HSM'in
# bulunduğu, TERCİHEN hava-boşluklu makine). issue_cert.sh'in ürettiği
# bir CSR'ı openssl'in CA veritabanına (ca_init.sh tarafından kurulan
# index.txt/serial) KAYITLI olacak şekilde imzalar — bu kayıt, ileride
# revoke_cert.sh ile bu sertifikayı iptal edebilmek için ZORUNLUDUR.
#
# KISA ÖMÜR: varsayılan geçerlilik süresi 7 GÜNDÜR (openssl-ca.cnf'teki
# default_days ile aynı, ama -days ile override edilebilir). Bu,
# "sertifikalar kısa ömürlü olmalı" gereksinimini karşılar — çalınan/
# sızdırılan bir istemci sertifikası en fazla birkaç gün geçerli kalır,
# iptal listesine (CRL) hiç girmese bile kendiliğinden süresi dolar.
# Kısa ömür otomatik ROTASYON gerektirir — bkz. rotate_cert.sh.
#
# GERÇEK HSM/PKCS#11: --engine pkcs11 --key-uri "pkcs11:..." verilirse,
# imzalama işlemi ca-key.pem YERİNE `-engine pkcs11 -keyform engine
# -keyfile "<uri>"` ile HSM üzerinden yapılır (CA özel anahtarı YEREL
# DİSKE HİÇ İNMEZ). Bu ortamda gerçek HSM olmadığından bu bayrak yalnızca
# KOMUTU YAZDIRIR, ÇALIŞTIRMAZ — gerçek donanımda kullanılacak doğru
# arayüzü göstermek içindir.
#
# KULLANIM:
#   ./sign_csr.sh <CA_pki_dizini> <csr_dosyası> server [gün_sayısı=7]
#   ./sign_csr.sh <CA_pki_dizini> <csr_dosyası> client [gün_sayısı=7]
#   ./sign_csr.sh <CA_pki_dizini> <csr_dosyası> client 7 --engine pkcs11 --key-uri "pkcs11:..."
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

CA_DIR="${1:?kullanım: sign_csr.sh <CA_pki_dizini> <csr_dosyası> <server|client> [gün] [--engine ... --key-uri ...]}"
CSR="${2:?csr dosyası gerekli}"
ROLE="${3:?rol gerekli: server veya client}"
DAYS="${4:-7}"
ENGINE_MODE=0
KEY_URI=""
SHIFT_N=$(( $# < 4 ? $# : 4 ))
shift "$SHIFT_N"
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE_MODE=1; shift ;;
    --key-uri) KEY_URI="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ ! -f "$CSR" ]; then echo "HATA: CSR bulunamadı: $CSR" >&2; exit 1; fi
CN=$(openssl req -in "$CSR" -noout -subject -nameopt multiline | awk -F= '/commonName/{gsub(/^ +| +$/,"",$2); print $2}')
if [ -z "$CN" ]; then echo "HATA: CSR'dan CN okunamadı" >&2; exit 1; fi

# ÖNEMLİ: mutlak yolu $CA_DIR'e cd YAPMADAN ÖNCE çözüyoruz — CSR göreli
# bir yol olarak verilmiş olabilir (çağıranın O ANKİ dizinine göre).
CSR_ABS="$(cd "$(dirname "$CSR")" && pwd)/$(basename "$CSR")"
OUT_CERT_DIR="$(dirname "$CSR_ABS")"

cd "$CA_DIR"
if [ ! -f ca-key.pem ] || [ ! -f ca-cert.pem ]; then
  echo "HATA: bu dizinde ca-key.pem/ca-cert.pem yok — önce ca_init.sh çalıştırılmalı" >&2
  exit 1
fi

EXTFILE=$(mktemp)
if [ "$ROLE" = "server" ]; then
  cat > "$EXTFILE" <<EOF
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
subjectAltName = DNS:${CN},DNS:localhost,IP:127.0.0.1
EOF
else
  cat > "$EXTFILE" <<EOF
extendedKeyUsage = clientAuth
basicConstraints = CA:FALSE
EOF
fi

OUT_CERT="${OUT_CERT_DIR}/${CN}-cert.pem"

if [ "$ENGINE_MODE" = "1" ]; then
  echo "[SIGN] --engine pkcs11 istendi: '$KEY_URI'"
  echo "[SIGN] BU ORTAMDA gerçek bir PKCS#11/HSM modülü YOK — komut ÇALIŞTIRILMIYOR, yalnızca referans amaçlı gösteriliyor:"
  echo "  openssl ca -engine pkcs11 -keyform engine -keyfile \"$KEY_URI\" \\"
  echo "    -config ca-db/openssl-ca.cnf -in \"$CSR_ABS\" -out \"$OUT_CERT\" \\"
  echo "    -days $DAYS -md sha256 -batch -extfile \"$EXTFILE\""
  rm -f "$EXTFILE"
  exit 0
fi

openssl ca -config ca-db/openssl-ca.cnf -in "$CSR_ABS" -out "$OUT_CERT" \
  -days "$DAYS" -md sha256 -batch -extfile "$EXTFILE" >/dev/null
rm -f "$EXTFILE"

SERIAL=$(openssl x509 -in "$OUT_CERT" -noout -serial | cut -d= -f2)
echo "[SIGN] İmzalandı: $OUT_CERT (CN=${CN}, rol=${ROLE}, geçerlilik=${DAYS} gün, serial=${SERIAL})"
echo "[SIGN] CA veritabanına kaydedildi (ca-db/index.txt) — bu sertifika artık revoke_cert.sh ile iptal edilebilir."
