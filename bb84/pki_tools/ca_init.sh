#!/usr/bin/env bash
# ca_init.sh — Kök CA'yı BİR KEZ başlatır (HAVA BOŞLUKLU/HSM-arkalı
# çalıştırılmak üzere tasarlanmıştır).
# ═══════════════════════════════════════════════════════════════════
# KULLANICI TALEBİ: "gerçek üretimde bir HSM'de veya hava boşluklu
# ortamda saklanmalı, sertifikalar kısa ömürlü olmalı, iptal (CRL/OCSP)
# mekanizması ekle — demodan çıkartılması gerekiyor."
#
# BU SCRIPT NE YAPAR: ca-key.pem (kök CA ÖZEL anahtarı) + ca-cert.pem
# (kök CA sertifikası) + openssl'in standart CA veritabanını (index.txt,
# serial, crlnumber — CRL üretimi ve sertifika iptali için ZORUNLU alt
# yapı) tek seferlik olarak kurar.
#
# HAVA BOŞLUĞU MİMARİSİ (ÖNEMLİ — bu, PKI'yi "demo" olmaktan çıkaran
# asıl tasarım kararıdır): Bu dizindeki SAE/KME sunucu sertifikaları
# artık TEK BİR script'te (eskiden generate_demo_pki.sh) üretilip
# imzalanmıyor. Bunun yerine üç AYRI adıma bölündü:
#   1) ca_init.sh   (BU DOSYA) — SADECE BİR KEZ, TERCİHEN İNTERNETTEN
#      YALITILMIŞ bir makinede/HSM'de çalışır. ca-key.pem'i ASLA ağa
#      bağlı bir sunucuya KOPYALAMAYIN.
#   2) issue_cert.sh — SERVER/SAE tarafında (yani sertifikayı
#      KULLANACAK makinede) bir anahtar çifti + CSR (sertifika imza
#      isteği) üretir. Özel anahtar BU MAKİNEDEN HİÇ ÇIKMAZ — yalnızca
#      CSR (genel bilgi) CA'ya taşınır (USB/güvenli kopyalama ile).
#      Sonra --sign ile (yalnızca ca-key.pem'in bulunduğu makinede)
#      CSR imzalanır ve imzalı sertifika SERVER/SAE makinesine geri
#      taşınır.
#   3) revoke_cert.sh — yalnızca CA tarafında çalışır, bir sertifikayı
#      iptal eder ve CRL'yi yeniden üretir.
# Bu ayrım, ca-key.pem'in HİÇBİR ZAMAN bir server/SAE makinesine
# kopyalanmasını GEREKTİRMEZ — gerçek hava-boşluklu/HSM dağıtımının
# önkoşulu budur.
#
# GERÇEK HSM (PKCS#11) KULLANIMI: --pkcs11-uri "pkcs11:token=...;object=ca-key"
# verilirse, ca-key.pem YEREL DOSYA OLARAK HİÇ ÜRETİLMEZ — bunun yerine
# `openssl genpkey -engine pkcs11 -pkeyopt pkcs11_uri:<uri>` ile anahtar
# DOĞRUDAN HSM İÇİNDE üretilir/saklanır ve asla dışarı çıkmaz; sonraki
# imzalama işlemleri de `-engine pkcs11 -keyform engine` ile HSM'e
# yönlendirilir (bkz. issue_cert.sh --engine seçeneği). BU ORTAMDA
# GERÇEK bir HSM/PKCS#11 modülü (ör. SoftHSM2, YubiHSM, CloudHSM)
# MEVCUT OLMADIĞINDAN varsayılan davranış YEREL dosya-tabanlı anahtar
# üretimidir — --pkcs11-uri yalnızca gerçek donanımınız olduğunda
# kullanılacak DOĞRU KANCA/arayüzdür, bu demo onu çalıştırıp test EDEMEZ.
#
# KULLANIM:
#   ./ca_init.sh ./pki                                  (yerel dosya-tabanlı CA anahtarı — yalnızca demo/test)
#   ./ca_init.sh ./pki --pkcs11-uri "pkcs11:token=..."   (GERÇEK HSM — bu ortamda test edilemez, üretim için)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

PKI_DIR="${1:-./pki}"
shift || true
PKCS11_URI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pkcs11-uri) PKCS11_URI="$2"; shift 2 ;;
    *) echo "Bilinmeyen argüman: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$PKI_DIR"/ca-db/newcerts "$PKI_DIR"/crl
cd "$PKI_DIR"

# ── openssl CA veritabanı iskeleti (CRL + iptal için ZORUNLU) ──────
touch ca-db/index.txt
[ -f ca-db/index.txt.attr ] || echo "unique_subject = no" > ca-db/index.txt.attr
[ -f ca-db/serial ] || echo 1000 > ca-db/serial
[ -f ca-db/crlnumber ] || echo 1000 > ca-db/crlnumber

cat > ca-db/openssl-ca.cnf <<'CNFEOF'
[ ca ]
default_ca = CA_default

[ CA_default ]
dir             = .
database        = ca-db/index.txt
serial          = ca-db/serial
new_certs_dir   = ca-db/newcerts
certificate     = ca-cert.pem
private_key     = ca-key.pem
crlnumber       = ca-db/crlnumber
crl              = crl/ca-crl.pem
default_days     = 7      ; KISA ÖMÜRLÜ sertifika varsayımı (bkz. issue_cert.sh notu)
default_crl_days = 1      ; CRL'nin kendisi de SIK yenilenmeli (iptal bilgisi taze kalsın diye)
default_md       = sha256
policy           = policy_loose
copy_extensions  = copy
unique_subject   = no

[ policy_loose ]
countryName            = optional
organizationName       = optional
commonName              = supplied

[ req ]
distinguished_name = req_distinguished_name
[ req_distinguished_name ]
CNFEOF
echo "[CA] openssl CA veritabanı hazırlandı: ca-db/ (index.txt/serial/crlnumber)"

if [ -f ca-cert.pem ]; then
  echo "[CA] ca-cert.pem zaten var — yeniden üretilmiyor (mevcut CA korunuyor)."
  exit 0
fi

if [ -n "$PKCS11_URI" ]; then
  echo "[CA] --pkcs11-uri verildi: '$PKCS11_URI'"
  echo "[CA] BU ORTAMDA gerçek bir PKCS#11/HSM modülü YÜKLÜ DEĞİL — bu yüzden BURADA çalıştırılamaz."
  echo "[CA] GERÇEK bir HSM'e sahip bir makinede çalıştırılacak KOMUT ŞUDUR (referans):"
  echo "     openssl genpkey -engine pkcs11 -algorithm RSA -pkeyopt pkcs11_uri:$PKCS11_URI -pkeyopt rsa_keygen_bits:4096 -out /dev/null"
  echo "     openssl req -engine pkcs11 -keyform engine -key \"$PKCS11_URI\" -x509 -new -days 3650 -sha256 \\"
  echo "       -subj \"/C=TR/O=PhotonNet Quantum Network/CN=PhotonNet Root CA\" -out ca-cert.pem"
  echo "[CA] Bu ortamda demo/test amaçlı YEREL dosya-tabanlı anahtar ile devam ediliyor (ca-key.pem üretilecek)."
fi

# CA'nın KENDİ ömrü UZUN olabilir (10 yıl, standart PKI hiyerarşi
# pratiği) — asıl korunması gereken şey ca-key.pem'in KENDİSİ (bkz.
# dosya-üstü hava-boşluğu/HSM notu), sertifikanın süresi DEĞİL.
openssl genrsa -out ca-key.pem 4096 2>/dev/null
chmod 600 ca-key.pem
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
  -subj "/C=TR/O=PhotonNet Quantum Network/CN=PhotonNet Root CA" \
  -out ca-cert.pem
echo "[CA] Kök CA üretildi: ca-cert.pem (10 yıl) / ca-key.pem (GİZLİ — chmod 600)."

# Başlangıç CRL'i (boş — henüz iptal edilen yok). Sunucunun --crl= ile
# başından itibaren geçerli bir dosya bulabilmesi için üretiliyor.
openssl ca -config ca-db/openssl-ca.cnf -gencrl -out crl/ca-crl.pem >/dev/null 2>&1
echo "[CA] Başlangıç CRL'i üretildi: crl/ca-crl.pem (boş — henüz iptal yok, 1 gün geçerli, bkz. default_crl_days)."
echo "[CA] İKAZ: ca-key.pem'i şimdi bu makineden GÜVENLİ ŞEKİLDE KALDIRIP hava-boşluklu bir ortama/HSM'e taşımayı düşünün — yalnızca ca-cert.pem'in (ve issue_cert.sh'in ürettiği CSR'ların imzalanması sırasında ca-key.pem'in) ağa bağlı makinelere ihtiyacı YOKTUR."
