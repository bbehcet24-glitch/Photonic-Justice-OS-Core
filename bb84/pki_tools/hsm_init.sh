#!/usr/bin/env bash
# hsm_init.sh — SoftHSM2 tabanlı YAZILIMSAL HSM havuzunu (bir PKCS#11
# token'ı) kurar/başlatır.
# ═══════════════════════════════════════════════════════════════════
# ⚠ DÜRÜSTLÜK NOTU (ÖNEMLİ): Bu script, çalıştığı sandbox'ta ağ erişimi
# (apt/npm/pip) engellendiği için YAZILDIĞI ORTAMDA hiç ÇALIŞTIRILAMADI
# — SoftHSM2/OpenSC paketleri BU sandbox'a hiç kurulamadı (tıpkı bu
# oturumda daha önce gerçek Qiskit'in kurulamaması gibi, bkz.
# bb84/ibm_qiskit_equivalent.py'nin üstündeki dürüstlük notu). Bu script
# standart, iyi belgelenmiş SoftHSM2/OpenSC komut satırı arayüzlerine
# (softhsm2-util, pkcs11-tool) dayanır ve GitHub Actions runner'ında
# (gerçek internet erişimi var) production-pipeline.yml'in
# "software-hsm-pkcs11" işinde İLK KEZ GERÇEKTEN çalıştırılıp doğrulanacaktır
# — bu depoya girene kadar sandbox-doğrulanmış DEĞİLDİR.
#
# AMAÇ: Gerçek donanım bir HSM (YubiHSM/CloudHSM/vb.) gelene kadar, CA
# özel anahtarının YEREL DİSKE HİÇ İNMEDEN standart bir PKCS#11
# arayüzü ÜZERİNDEN üretilip kullanılabildiğini KANITLAMAK — bu script
# yalnızca bir PKCS#11 TOKEN'ı (SoftHSM2'nin yazılımsal emülasyonu)
# kurar; ca_init.sh/sign_csr.sh bu token'a (veya gerçek donanıma)
# TAMAMEN AYNI kodla (openssl -engine pkcs11) konuşur — SoftHSM2'ye
# özel HİÇBİR kod yoktur, bu yüzden gerçek donanıma geçiş yalnızca
# modül yolu/token etiketi/PIN değişikliğidir.
#
# KULLANIM:
#   ./hsm_init.sh <hsm_çalışma_dizini> [token_etiketi] [pin] [so-pin]
# ÇIKTI: stdout'a "export FOO=bar" satırları yazar (source'lanabilir);
#   tanılama/log mesajları stderr'e gider. Örnek kullanım:
#     ./hsm_init.sh ./hsm-work my-ca 123456 654321 > hsm-env.sh
#     source hsm-env.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

HSM_DIR="${1:?kullanım: hsm_init.sh <hsm_çalışma_dizini> [token_etiketi] [pin] [so-pin]}"
TOKEN_LABEL="${2:-photonnet-ca}"
PIN="${3:-123456}"
SO_PIN="${4:-654321}"

# SoftHSM2 modülünün Debian/Ubuntu paket yollarındaki (softhsm2/libsofthsm2
# paketleri) standart konumları — dağıtıma göre ikisinden biri geçerlidir.
MODULE_CANDIDATES=(
  "/usr/lib/softhsm/libsofthsm2.so"
  "/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so"
  "/usr/local/lib/softhsm/libsofthsm2.so"
)
MODULE_PATH=""
for c in "${MODULE_CANDIDATES[@]}"; do
  if [ -f "$c" ]; then MODULE_PATH="$c"; break; fi
done
if [ -z "$MODULE_PATH" ]; then
  echo "HATA: libsofthsm2.so hiçbir standart yolda bulunamadı — SoftHSM2 kurulu mu? (apt-get install softhsm2)" >&2
  echo "Aranan yollar: ${MODULE_CANDIDATES[*]}" >&2
  exit 1
fi
if ! command -v softhsm2-util >/dev/null 2>&1; then
  echo "HATA: 'softhsm2-util' PATH'te bulunamadı — SoftHSM2 kurulu mu? (apt-get install softhsm2)" >&2
  exit 1
fi

mkdir -p "$HSM_DIR/tokens"
cat > "$HSM_DIR/softhsm2.conf" <<EOF
directories.tokendir = $HSM_DIR/tokens
objectstore.backend = file
log.level = INFO
EOF
export SOFTHSM2_CONF="$HSM_DIR/softhsm2.conf"

if softhsm2-util --show-slots 2>/dev/null | grep -q "label:.*${TOKEN_LABEL}\$"; then
  echo "[HSM] Token '${TOKEN_LABEL}' zaten var (${HSM_DIR}/tokens içinde) — yeniden başlatılmıyor." >&2
else
  softhsm2-util --init-token --free --label "$TOKEN_LABEL" --pin "$PIN" --so-pin "$SO_PIN" 1>&2
  echo "[HSM] Token '${TOKEN_LABEL}' başlatıldı (modül: $MODULE_PATH, çalışma dizini: $HSM_DIR)." >&2
fi

echo "[HSM] Kurulum tamam — aşağıdaki değişkenleri source'layın:" >&2

# stdout: source'lanabilir export satırları (yalnızca bunlar).
echo "export SOFTHSM2_CONF=\"$HSM_DIR/softhsm2.conf\""
echo "export PKCS11_MODULE_PATH=\"$MODULE_PATH\""
echo "export PKCS11_TOKEN_LABEL=\"$TOKEN_LABEL\""
echo "export PKCS11_PIN=\"$PIN\""
