#!/usr/bin/env bash
# issue_cert.sh — SAE/KME sunucu tarafında ÇALIŞTIRILIR: özel anahtarı
# üretir ve CSR (Sertifika İmza İsteği) oluşturur. ÖZEL ANAHTAR BU
# MAKİNEDEN HİÇ ÇIKMAZ — yalnızca CSR (gizli bilgi İÇERMEZ) CA'ya
# taşınır (bkz. sign_csr.sh, ca-key.pem'in/HSM'in bulunduğu tarafta
# çalışır).
# ═══════════════════════════════════════════════════════════════════
# KULLANIM:
#   ./issue_cert.sh <çıktı_dizini> server localhost
#   ./issue_cert.sh <çıktı_dizini> client SAE-ANK
#   ./issue_cert.sh <çıktı_dizini> client SAE-IST
#
# ÇIKTI: <çıktı_dizini>/<CN>-key.pem (ÖZEL, chmod 600) + <çıktı_dizini>/<CN>.csr (CA'ya taşınacak dosya — gizli değil)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

OUT_DIR="${1:?kullanım: issue_cert.sh <çıktı_dizini> <server|client> <CN>}"
ROLE="${2:?rol gerekli: server veya client}"
CN="${3:?CN (ör. localhost veya SAE-ANK) gerekli}"

if [ "$ROLE" != "server" ] && [ "$ROLE" != "client" ]; then
  echo "HATA: rol 'server' veya 'client' olmalı, verilen: $ROLE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

openssl genrsa -out "${CN}-key.pem" 4096 2>/dev/null
chmod 600 "${CN}-key.pem"
openssl req -new -key "${CN}-key.pem" \
  -subj "/C=TR/O=PhotonNet Quantum Network/CN=${CN}" \
  -out "${CN}.csr"

echo "[ISSUE] ${ROLE} CSR üretildi: $(pwd)/${CN}.csr"
echo "[ISSUE] Özel anahtar (GİZLİ, bu makinede kalmalı): $(pwd)/${CN}-key.pem"
echo "[ISSUE] Sonraki adım: bu .csr dosyasını CA'nın (ca-key.pem/HSM) bulunduğu tarafa taşıyın ve orada çalıştırın:"
echo "        ./sign_csr.sh <CA_pki_dizini> $(pwd)/${CN}.csr ${ROLE} [gün_sayısı]"
