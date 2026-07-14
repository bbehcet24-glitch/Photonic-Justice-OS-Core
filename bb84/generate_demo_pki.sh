#!/usr/bin/env bash
# generate_demo_pki.sh
# ═══════════════════════════════════════════════════════════════════
# ★★★ GÜNCELLEME NOTU: Bu script SADECE hızlı/tek-komutluk mTLS DEMOsu
# içindir (openssl x509 -req ile basit öz-imzalama — CA veritabanı
# YOK). SERTİFİKA İPTALİ (CRL/OCSP) veya HSM/hava-boşluğu ayrımı
# GEREKTİREN her senaryo için bunun yerine pki_tools/ dizinindeki
# script SETİNİ kullanın: ca_init.sh → issue_cert.sh + sign_csr.sh →
# (gerekirse) revoke_cert.sh / rotate_cert.sh / run_ocsp_responder.sh.
# O set, openssl'in GERÇEK CA veritabanını (index.txt/serial/crlnumber)
# kurar — iptal ve CRL üretimi için ZORUNLU alt yapı budur, bu dosyada
# YOKTUR. Bu dosya yalnızca geriye dönük uyumluluk/hızlı-tek-seferlik-
# test amacıyla korunmaktadır.
#
# PhotonNet — etsi014_kme_server.js için GERÇEK mTLS'i çalıştırabilmek
# amacıyla DEMO bir PKI (kök CA + KME sunucu sertifikası + her SAE için
# bir istemci sertifikası) üretir.
#
# NEDEN GEREKLİ: ETSI GS QKD 014, SAE↔KME arasında KARŞILIKLI TLS
# (mutual TLS) ZORUNLU KILAR — KME, çağıran SAE'nin kimliğini onun
# İSTEMCİ SERTİFİKASINDAN (Distinguished Name / CN alanı) doğrular,
# bir HTTP header'ından DEĞİL. Bu script, o sertifika zincirini
# üretir: kök CA kendi kendini imzalar; KME sunucu sertifikası ve her
# SAE istemci sertifikası bu KÖK CA tarafından imzalanır — böylece
# sunucu `--ca=ca-cert.pem` ile yalnızca BU CA'nın imzaladığı istemci
# sertifikalarını kabul eder (bkz. etsi014_kme_server.js, requestCert:
# true, rejectUnauthorized:true).
#
# ÜRETİM UYARISI: Bu script bir DEMO/TEST PKI'sıdır — kök CA anahtarı
# (ca-key.pem) diskte düz metin olarak durur. GERÇEK bir dağıtımda kök
# CA anahtarı bir HSM'de veya çevrimdışı/hava boşluklu bir ortamda
# saklanmalı, sertifikalar kısa ömürlü olmalı ve iptal (CRL/OCSP)
# mekanizması kurulmalıdır — bunların hiçbiri bu demo'da YOKTUR.
#
# KULLANIM:
#   ./generate_demo_pki.sh [çıktı_dizini] [SAE_ID_1] [SAE_ID_2] ...
#   ./generate_demo_pki.sh ./pki SAE-ANK SAE-IST SAE-IZM
#   (SAE ID listesi verilmezse varsayılan: SAE-ANK SAE-IST)
#
# ÇIKTI (çıktı_dizini altında):
#   ca-cert.pem              — kök CA sertifikası (sunucuya --ca= ile verilir; SAE'lere de dağıtılabilir, GİZLİ DEĞİLDİR)
#   ca-key.pem                — kök CA ÖZEL anahtarı (GİZLİ — yalnızca yeni sertifika imzalamak için gerekir, sunucuda/SAE'de KULLANILMAZ)
#   kme-server-cert.pem/-key.pem — KME sunucusunun TLS sertifikası/anahtarı (sunucuya --cert=/--key= ile verilir)
#   <SAE_ID>-cert.pem/-key.pem   — her SAE'nin istemci sertifikası/anahtarı (o SAE'nin uygulamasına/curl'e --cert=/--key= ile verilir)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

OUT="${1:-./pki}"
shift || true
SAE_IDS=("$@")
if [ ${#SAE_IDS[@]} -eq 0 ]; then
  SAE_IDS=("SAE-ANK" "SAE-IST")
fi

mkdir -p "$OUT"
cd "$OUT"
echo "[PKI] Çıktı dizini: $(pwd)"

# ── 1) Kök CA ────────────────────────────────────────────────────
if [ ! -f ca-cert.pem ]; then
  openssl genrsa -out ca-key.pem 4096 2>/dev/null
  openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
    -subj "/C=TR/O=PhotonNet Quantum Network/CN=PhotonNet Root CA (DEMO)" \
    -out ca-cert.pem
  echo "[PKI] Kök CA üretildi: ca-cert.pem / ca-key.pem"
else
  echo "[PKI] Kök CA zaten var, yeniden kullanılıyor: ca-cert.pem"
fi

# ── 2) KME sunucu sertifikası (CN=localhost + SAN) ────────────────
openssl genrsa -out kme-server-key.pem 4096 2>/dev/null
openssl req -new -key kme-server-key.pem \
  -subj "/C=TR/O=PhotonNet Quantum Network/CN=localhost" \
  -out kme-server.csr
cat > kme-server-ext.cnf <<EOF
subjectAltName = DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF
openssl x509 -req -in kme-server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out kme-server-cert.pem -days 825 -sha256 -extfile kme-server-ext.cnf 2>/dev/null
rm -f kme-server.csr kme-server-ext.cnf
echo "[PKI] KME sunucu sertifikası üretildi: kme-server-cert.pem / kme-server-key.pem (CN=localhost)"

# ── 3) Her SAE için istemci sertifikası (CN=<SAE_ID>) ─────────────
# NOT: CN, etsi014_kme_server.js'in mTLS modunda çağıranın kimliğini
# (SAE_ID) DOĞRUDAN bu alandan okuduğu yerdir — bkz. sunucu kodundaki
# `req.socket.getPeerCertificate().subject.CN`.
for SAE in "${SAE_IDS[@]}"; do
  openssl genrsa -out "${SAE}-key.pem" 4096 2>/dev/null
  openssl req -new -key "${SAE}-key.pem" \
    -subj "/C=TR/O=PhotonNet Quantum Network/CN=${SAE}" \
    -out "${SAE}.csr"
  cat > "${SAE}-ext.cnf" <<EOF
extendedKeyUsage = clientAuth
basicConstraints = CA:FALSE
EOF
  openssl x509 -req -in "${SAE}.csr" -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
    -out "${SAE}-cert.pem" -days 825 -sha256 -extfile "${SAE}-ext.cnf" 2>/dev/null
  rm -f "${SAE}.csr" "${SAE}-ext.cnf"
  echo "[PKI] SAE istemci sertifikası üretildi: ${SAE}-cert.pem / ${SAE}-key.pem (CN=${SAE})"
done

echo ""
echo "[PKI] TAMAMLANDI. Sunucuyu gerçek mTLS ile başlatmak için:"
echo "  node etsi014_kme_server.js --keystore=<export.json> --cert=$OUT/kme-server-cert.pem --key=$OUT/kme-server-key.pem --ca=$OUT/ca-cert.pem"
echo ""
echo "Örnek istemci çağrısı (SAE-ANK kimliğiyle, kendi sertifikasını sunarak):"
echo "  curl --cert $OUT/SAE-ANK-cert.pem --key $OUT/SAE-ANK-key.pem --cacert $OUT/ca-cert.pem \\"
echo "       https://localhost:8443/api/v1/keys/SAE-IST/status"
