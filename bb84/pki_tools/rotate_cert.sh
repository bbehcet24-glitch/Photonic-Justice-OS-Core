#!/usr/bin/env bash
# rotate_cert.sh — KISA ÖMÜRLÜ sertifika stratejisinin gerektirdiği
# ROTASYON adımı: mevcut bir SAE/sunucu sertifikasının süresi dolmadan
# ÖNCE yenisini üretir. Kısa ömür (varsayılan 7 gün, bkz. sign_csr.sh)
# yalnızca DÜZENLİ rotasyon ile sürdürülebilir — aksi halde SAE'ler
# bağlantı kesintisi yaşar.
#
# KAPSAM NOTU: Bu script, CA ile SAE/sunucunun AYNI ortamda (test/küçük
# dağıtım) yönetildiği durumlar için bir KOLAYLIK sarmalayıcısıdır —
# issue_cert.sh + sign_csr.sh'i art arda çalıştırır. GERÇEK hava-
# boşluklu bir dağıtımda bu iki adım FİZİKSEL OLARAK AYRI makinelerde
# çalıştırılır (bkz. issue_cert.sh/sign_csr.sh dosya-üstü notları) —
# orada rotasyon, CSR'ı otomatik/manuel olarak CA'ya taşıyan bir süreç
# gerektirir (bu script o taşımayı SİMÜLE ETMEZ, yalnızca colocated
# durumda kısayoldur).
#
# ESKİ SERTİFİKAYI DA İPTAL ETMEK İSTER MİSİNİZ? Kısa ömürlü
# sertifikalarda bu genelde GEREKSİZDİR (birkaç gün içinde zaten süresi
# dolacak) — ama özel anahtarın SIZDIĞINDAN ŞÜPHELENİYORSANIZ,
# --revoke-old ile eski sertifikayı da ANINDA iptal edin (bkz.
# revoke_cert.sh).
#
# KULLANIM:
#   ./rotate_cert.sh <pki_dizini> client SAE-ANK [gün=7] [--revoke-old]
#   ./rotate_cert.sh <pki_dizini> server localhost 7
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

PKI_DIR="${1:?kullanım: rotate_cert.sh <pki_dizini> <server|client> <CN> [gün] [--revoke-old]}"
ROLE="${2:?rol gerekli}"
CN="${3:?CN gerekli}"
DAYS="${4:-7}"
REVOKE_OLD=0
for a in "${@:5}"; do
  [ "$a" = "--revoke-old" ] && REVOKE_OLD=1
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLD_CERT="$PKI_DIR/${CN}-cert.pem"

if [ "$REVOKE_OLD" = "1" ] && [ -f "$OLD_CERT" ]; then
  echo "[ROTATE] --revoke-old: eski sertifika iptal ediliyor..."
  "$SCRIPT_DIR/revoke_cert.sh" "$PKI_DIR" "$OLD_CERT"
fi

if [ -f "$OLD_CERT" ]; then
  mv "$OLD_CERT" "${OLD_CERT}.previous.$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo old)" 2>/dev/null || true
fi

TMP_DIR=$(mktemp -d)
"$SCRIPT_DIR/issue_cert.sh" "$TMP_DIR" "$ROLE" "$CN" >/dev/null
"$SCRIPT_DIR/sign_csr.sh" "$PKI_DIR" "$TMP_DIR/${CN}.csr" "$ROLE" "$DAYS" >/dev/null

cp "$TMP_DIR/${CN}-key.pem" "$PKI_DIR/${CN}-key.pem"
chmod 600 "$PKI_DIR/${CN}-key.pem"
cp "$TMP_DIR/${CN}-cert.pem" "$PKI_DIR/${CN}-cert.pem"
rm -rf "$TMP_DIR"

EXPIRY=$(openssl x509 -in "$PKI_DIR/${CN}-cert.pem" -noout -enddate | cut -d= -f2)
echo "[ROTATE] YENİLENDİ: ${CN} (rol=${ROLE}) — yeni sertifika ${DAYS} gün geçerli, bitiş: ${EXPIRY}"
echo "[ROTATE] Öneri: bu rotasyonu bitiş tarihinden ~2 gün önce tekrar çalıştıracak bir zamanlanmış görev kurun (ör. cron/systemd-timer) — kısa ömürlü sertifika stratejisi SÜREKLİ rotasyon gerektirir."
