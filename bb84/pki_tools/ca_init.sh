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
# YAZILIMSAL/GERÇEK HSM (PKCS#11) KULLANIMI: --pkcs11-uri
# "pkcs11:token=...;object=ca-key;type=private" verilirse, ca-key.pem
# YEREL DOSYA OLARAK HİÇ ÜRETİLMEZ — bunun yerine anahtar çifti
# `pkcs11-tool --keypairgen` ile DOĞRUDAN token İÇİNDE üretilir/saklanır
# ve ÖZEL kısmı ASLA dışarı çıkmaz; CA sertifikası da
# `openssl req -engine pkcs11 -keyform engine` ile token'daki anahtarla
# imzalanır. Bu mod şu env değişkenlerini GEREKTİRİR:
#   PKCS11_MODULE_PATH — PKCS#11 modülünün (.so) yolu
#   PKCS11_PIN          — token kullanıcı PIN'i
# (bkz. hsm_init.sh — bir SoftHSM2 token'ını bu değişkenlerle birlikte
# tek komutla kurar/başlatır.)
#
# GERÇEK DONANIMA GEÇİŞ: Bu kod SoftHSM2'ye ÖZEL HİÇBİR ŞEY içermez —
# yalnızca standart PKCS#11/openssl-engine arayüzünü kullanır. Gerçek
# bir donanım HSM'e (YubiHSM/CloudHSM/vb.) geçmek için tek değişen şey
# PKCS11_MODULE_PATH'in o HSM'in KENDİ modülünü göstermesidir — bu
# script'te veya sign_csr.sh'de TEK SATIR KOD DEĞİŞMEZ.
#
# ⚠ DÜRÜSTLÜK NOTU: --pkcs11-uri kod yolu, çalıştığı sandbox'ta ağ
# kısıtı yüzünden PKCS#11 araçları (SoftHSM2/OpenSC) hiç kurulamadığından
# BU ORTAMDA çalıştırılıp test EDİLEMEDİ. İlk gerçek doğrulama, GitHub
# Actions'ın "software-hsm-pkcs11" işinde (gerçek internet erişimiyle
# SoftHSM2 kurup çalıştırır) olacaktır — bkz. production-pipeline.yml.
# Argüman yoksa (varsayılan) davranış DEĞİŞMEDİ: yerel dosya-tabanlı
# anahtar üretimi, tıpkı önceden olduğu gibi.
#
# KULLANIM:
#   ./ca_init.sh ./pki                                  (yerel dosya-tabanlı CA anahtarı — demo/test)
#   ./ca_init.sh ./pki --pkcs11-uri "pkcs11:token=photonnet-ca;object=ca-key;type=private"
#     (YAZILIMSAL/GERÇEK HSM — PKCS11_MODULE_PATH + PKCS11_PIN env gerekir)
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
  # ── YAZILIMSAL/GERÇEK HSM YOLU: anahtar DOĞRUDAN token içinde üretilir ──
  : "${PKCS11_MODULE_PATH:?--pkcs11-uri verildi ama PKCS11_MODULE_PATH env değişkeni BOŞ (bkz. hsm_init.sh)}"
  : "${PKCS11_PIN:?--pkcs11-uri verildi ama PKCS11_PIN env değişkeni BOŞ (bkz. hsm_init.sh)}"

  # pkcs11 URI'sinden token/object etiketlerini çıkar (RFC 7512'nin tam
  # bir ayrıştırıcısı DEĞİL — yalnızca bu script'in ihtiyaç duyduğu
  # ';anahtar=değer' alanlarının pragmatik bir alt kümesi).
  TOKEN_LABEL=$(echo "$PKCS11_URI" | grep -oE 'token=[^;]+' | cut -d= -f2)
  OBJECT_LABEL=$(echo "$PKCS11_URI" | grep -oE 'object=[^;]+' | cut -d= -f2)
  if [ -z "$TOKEN_LABEL" ] || [ -z "$OBJECT_LABEL" ]; then
    echo "HATA: --pkcs11-uri içinde 'token=' ve 'object=' alanları bulunamadı: $PKCS11_URI" >&2
    exit 1
  fi

  echo "[CA] --pkcs11-uri: token='$TOKEN_LABEL' object='$OBJECT_LABEL' modül='$PKCS11_MODULE_PATH'"
  echo "[CA] CA anahtar çifti DOĞRUDAN token içinde üretiliyor (özel anahtar hiçbir zaman diske inmeyecek)..."
  pkcs11-tool --module "$PKCS11_MODULE_PATH" --token-label "$TOKEN_LABEL" \
    --login --pin "$PKCS11_PIN" \
    --keypairgen --key-type rsa:4096 --label "$OBJECT_LABEL" --id 01
  echo "[CA] ✓ Anahtar çifti token içinde üretildi (label=$OBJECT_LABEL) — ca-key.pem dosyası ÜRETİLMEYECEK."

  echo "[CA] CA sertifikası, token'daki özel anahtarla (openssl -engine pkcs11) öz-imzalanıyor..."
  openssl req -engine pkcs11 -keyform engine \
    -key "${PKCS11_URI};pin-value=${PKCS11_PIN}" \
    -x509 -new -days 3650 -sha256 \
    -subj "/C=TR/O=PhotonNet Quantum Network/CN=PhotonNet Root CA" \
    -out ca-cert.pem

  # Yalnızca AÇIKLAYICI/OPERASYONEL bir referans dosyası — GİZLİ hiçbir
  # şey içermez (yalnızca URI + modül yolu, PIN İÇERMEZ), yalnızca
  # "bu CA'nın özel anahtarı hangi token'da/hangi etiketle" bilgisini
  # insan-okunabilir şekilde kaydeder.
  cat > ca-key.HSM_REFERENCE.txt <<EOF
Bu CA'nın ÖZEL anahtarı bu dizinde bir DOSYA OLARAK YOKTUR.
PKCS#11 token içinde saklanır:
  token label : $TOKEN_LABEL
  object label: $OBJECT_LABEL
  modül       : $PKCS11_MODULE_PATH
Kullanmak için (imzalama): sign_csr.sh ... --engine pkcs11 --key-uri "$PKCS11_URI"
(PIN bu dosyada YOKTUR — PKCS11_PIN env değişkeni olarak ayrıca sağlanmalıdır.)
EOF
  echo "[CA] Kök CA üretildi: ca-cert.pem (10 yıl) / özel anahtar TOKEN İÇİNDE (bkz. ca-key.HSM_REFERENCE.txt)."
else
  # ── VARSAYILAN: yerel dosya-tabanlı CA anahtarı (demo/test) ──────────
  # CA'nın KENDİ ömrü UZUN olabilir (10 yıl, standart PKI hiyerarşi
  # pratiği) — asıl korunması gereken şey ca-key.pem'in KENDİSİ (bkz.
  # dosya-üstü hava-boşluğu/HSM notu), sertifikanın süresi DEĞİL.
  openssl genrsa -out ca-key.pem 4096 2>/dev/null
  chmod 600 ca-key.pem
  openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
    -subj "/C=TR/O=PhotonNet Quantum Network/CN=PhotonNet Root CA" \
    -out ca-cert.pem
  echo "[CA] Kök CA üretildi: ca-cert.pem (10 yıl) / ca-key.pem (GİZLİ — chmod 600)."
fi

# Başlangıç CRL'i (boş — henüz iptal edilen yok). Sunucunun --crl= ile
# başından itibaren geçerli bir dosya bulabilmesi için üretiliyor.
openssl ca -config ca-db/openssl-ca.cnf -gencrl -out crl/ca-crl.pem >/dev/null 2>&1
echo "[CA] Başlangıç CRL'i üretildi: crl/ca-crl.pem (boş — henüz iptal yok, 1 gün geçerli, bkz. default_crl_days)."
echo "[CA] İKAZ: ca-key.pem'i şimdi bu makineden GÜVENLİ ŞEKİLDE KALDIRIP hava-boşluklu bir ortama/HSM'e taşımayı düşünün — yalnızca ca-cert.pem'in (ve issue_cert.sh'in ürettiği CSR'ların imzalanması sırasında ca-key.pem'in) ağa bağlı makinelere ihtiyacı YOKTUR."
