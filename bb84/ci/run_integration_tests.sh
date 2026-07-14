#!/usr/bin/env bash
# run_integration_tests.sh — IBM/CI ENTEGRASYON TESTİ ORKESTRASYONU.
# ═══════════════════════════════════════════════════════════════════
# AMAÇ: GitHub Actions VE GitLab CI YAML dosyalarının İKİSİ de BU
# SCRIPT'İ çağırır — gerçek mantık (PKI kurulumu, sunucu başlatma,
# sağlık kontrolü, test çalıştırma, temizlik) TEK YERDE, iki farklı
# CI YAML lehçesinde TEKRAR EDİLMEDEN tutulur. "Üretim sınıfı" derken
# kastedilen budur: CI config dosyaları İNCE bir kabuk, gerçek
# davranış burada, yerel olarak da (bir geliştirici makinesinde)
# ÇALIŞTIRILIP hata ayıklanabilir — CI'ya push edip debug etmeye
# GEREK YOK.
#
# İKİ ÇALIŞMA MODU (KME_MODE ortam değişkeniyle seçilir):
#
#   1) "ephemeral" (VARSAYILAN) — bu script KENDİ geçici (throwaway)
#      CA'sını + sertifikalarını (pki_tools/ ile) üretir, bir OCSP
#      yanıtlayıcısı + KME sunucusunu YEREL OLARAK (localhost) başlatır,
#      mock_ibm_client.js'i buna karşı çalıştırır, sonra HER ŞEYİ
#      temizler. Bu mod PROTOKOL/mTLS/PKI DOĞRULUĞUNU test eder — her
#      commit'te/PR'da otomatik çalışacak varsayılan moddur, GERÇEK
#      üretim CA'sına veya gerçek IBM sertifikalarına İHTİYAÇ DUYMAZ.
#
#   2) "external" — IBM mühendisleri veya bir staging ortamı, GERÇEK
#      (CI secret'ları olarak sağlanan) sertifikalarla, GERÇEK bir KME
#      uç noktasına (KME_URL) karşı test çalıştırmak istediğinde
#      kullanılır. Bu modda script HİÇBİR yerel sunucu/PKI kurmaz —
#      yalnızca verilen CA_CERT/IBM_CERT/IBM_KEY/PEER_CERT/PEER_KEY
#      dosyalarıyla mock_ibm_client.js'i doğrudan KME_URL'e karşı
#      çalıştırır. --skip-rogue-test/--revoked-cert gibi bazı testler
#      bu modda İSTEĞE BAĞLI/OPSİYONELDİR (gerçek bir üretim KME'sine
#      karşı iptal/sahte-sertifika testleri, o ortamın kendi PKI
#      politikasına göre AYARLANMALIDIR — bkz. aşağıdaki değişkenler).
#
# GÜVENLİK NOTU (ÖNEMLİ): "ephemeral" modda üretilen CA/anahtarlar
# YALNIZCA bu CI çalıştırması için VARDIR, iş bitince SİLİNİR — bu,
# bb84/pki_tools/ca_init.sh'in üstündeki GERÇEK ÜRETİM CA'sı (hava-
# boşluklu/HSM'de saklanması gereken) İLE KARIŞTIRILMAMALIDIR. CI
# runner'ları (GitHub-hosted/GitLab SaaS runner'lar) hava boşluklu
# DEĞİLDİR — gerçek üretim CA özel anahtarının BU SCRIPT'E veya CI
# secret'larına HİÇBİR ZAMAN konulmaması GEREKİR. "external" modda
# dahi yalnızca İSTEMCİ (SAE) sertifikaları/anahtarları secret olarak
# verilir — CA özel anahtarı asla CI'ya girmemelidir.
#
# ORTAM DEĞİŞKENLERİ (hepsi opsiyonel, mantıklı varsayılanları var):
#   KME_MODE              ephemeral|external            (varsayılan: ephemeral)
#   REPORTS_DIR           JUnit XML + logların yazılacağı dizin (varsayılan: ./ci-reports)
#   KME_PORT              (yalnızca ephemeral) KME sunucu portu (varsayılan: 8443)
#   OCSP_PORT             (yalnızca ephemeral) OCSP yanıtlayıcı portu (varsayılan: 8888)
#   KME_URL               (yalnızca external) GERÇEK KME uç noktası, ör. https://kme.example.com:8443
#   CA_CERT               (yalnızca external) CA sertifikası (ÖZEL ANAHTAR DEĞİL) yolu
#   IBM_CERT / IBM_KEY    (yalnızca external) IBM düğümü istemci sertifikası/anahtarı
#   PEER_CERT / PEER_KEY  (yalnızca external) PhotonNet eş SAE istemci sertifikası/anahtarı
#   EXPECTED_SERVER_CN    (opsiyonel, her iki modda) KME sunucu sertifikası CN pinlemesi
#   SKIP_ROGUE_TEST       "1" ise sahte-sertifika testi atlanır (varsayılan: atlanmaz)
#   REVOKED_CERT / REVOKED_KEY  (opsiyonel) iptal-red testi için — verilmezse o test atlanır
#
# KULLANIM (yerel geliştirici makinesinde, tam ephemeral test):
#   ./bb84/ci/run_integration_tests.sh
#
# KULLANIM (CI'da GERÇEK IBM sertifikalarıyla, external mod):
#   KME_MODE=external KME_URL=https://staging-kme.internal:8443 \
#   CA_CERT=/secrets/ca-cert.pem IBM_CERT=/secrets/ibm-cert.pem IBM_KEY=/secrets/ibm-key.pem \
#   PEER_CERT=/secrets/peer-cert.pem PEER_KEY=/secrets/peer-key.pem \
#   ./bb84/ci/run_integration_tests.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BB84_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

KME_MODE="${KME_MODE:-ephemeral}"
REPORTS_DIR="${REPORTS_DIR:-$(pwd)/ci-reports}"
KME_PORT="${KME_PORT:-8443}"
OCSP_PORT="${OCSP_PORT:-8888}"
SKIP_ROGUE_TEST="${SKIP_ROGUE_TEST:-0}"

mkdir -p "$REPORTS_DIR"
JUNIT_OUT="$REPORTS_DIR/mock-ibm-client-junit.xml"

# ── Arka planda başlatılan süreçleri ve geçici dizini İZ SÜRME +
# script HANGİ SEBEPLE biterse bitsin (başarı/hata/kesinti) TEMİZLEME.
BG_PIDS=()
TMP_DIR=""
cleanup() {
  local ec=$?
  echo "[CI] Temizlik başlıyor (çıkış kodu bağlamı: ${ec})..."
  for pid in "${BG_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  # arka plan süreçlerinin (özellikle run_ocsp_responder.sh'in kendi alt
  # süreçlerinin) düzgünce sonlanması için kısa bir bekleme
  sleep 1
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
    echo "[CI] Geçici PKI/çalışma dizini silindi: $TMP_DIR"
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local host="$1" port="$2" timeout_s="${3:-20}"
  local waited=0
  while ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge $((timeout_s * 2)) ]; then
      echo "[CI] HATA: $host:$port $timeout_s saniye içinde AÇILMADI" >&2
      return 1
    fi
  done
  exec 3>&- 2>/dev/null || true
  return 0
}

# ÖNEMLİ: OCSP yanıtlayıcısı (pki_tools/run_ocsp_responder.sh) HER İSTEĞİ
# TEK SEFERLİK bir openssl süreciyle karşılar (-nrequest 1, döngüde yeniden
# başlar — bkz. o script'in dosya-üstü notu). Bu, wait_for_port'un ÇIPLAK
# TCP connect+close PROBE'unun "bir istek" olarak SAYILMASINA ve responder'ın
# bu sahte/boş isteği bekleyip TIMEOUT OLMASINA (gerçek ilk sorguyu
# BOZMASINA) yol açabileceğini bu ortamda CANLI OLARAK GÖZLEMLEDİK — bu
# yüzden OCSP yanıtlayıcısı için PROTOKOLÜ GERÇEKTEN KONUŞAN bir hazır-olma
# kontrolü kullanıyoruz: openssl'in KENDİ ocsp istemcisiyle GERÇEK bir sorgu
# göndeririz, "good"/"revoked"/"unknown" GİBİ GEÇERLİ herhangi bir yanıt
# (responder'ın CANLI ve DOĞRU konuştuğunun kanıtı) gelene kadar yeniden
# deneriz — bağlantı reddi/timeout SADECE "henüz hazır değil" sayılır.
wait_for_ocsp_responder() {
  local ca_cert="$1" probe_cert="$2" url="$3" timeout_s="${4:-20}"
  local waited=0 out
  while true; do
    out="$(openssl ocsp -issuer "$ca_cert" -cert "$probe_cert" -url "$url" -CAfile "$ca_cert" -timeout 2 2>&1 || true)"
    if echo "$out" | grep -qiE ': good|: revoked|: unknown'; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge $((timeout_s * 2)) ]; then
      echo "[CI] HATA: OCSP yanıtlayıcısı ($url) $timeout_s saniye içinde GEÇERLİ bir yanıt vermedi. Son çıktı:" >&2
      echo "$out" >&2
      return 1
    fi
  done
}

if [ "$KME_MODE" = "ephemeral" ]; then
  echo "[CI] Mod: EPHEMERAL — geçici test PKI'si + yerel KME sunucusu kuruluyor..."
  TMP_DIR="$(mktemp -d)"
  PKI_DIR="$TMP_DIR/pki"

  echo "[CI] 1/6: CA başlatılıyor (bkz. GÜVENLİK NOTU — bu CA yalnızca bu CI koşumu için var, iş bitince silinir)"
  "$BB84_DIR/pki_tools/ca_init.sh" "$PKI_DIR" > "$REPORTS_DIR/ca_init.log" 2>&1

  echo "[CI] 2/6: sunucu + istemci sertifikaları imzalanıyor (localhost, SAE-IBM-QNET, SAE-ANK, SAE-REVOKED-TEST)"
  for pair in "server:localhost" "client:SAE-IBM-QNET" "client:SAE-ANK" "client:SAE-REVOKED-TEST"; do
    role="${pair%%:*}"; cn="${pair##*:}"
    "$BB84_DIR/pki_tools/issue_cert.sh" "$PKI_DIR/reqs" "$role" "$cn" >> "$REPORTS_DIR/ca_init.log" 2>&1
    "$BB84_DIR/pki_tools/sign_csr.sh" "$PKI_DIR" "$PKI_DIR/reqs/$cn.csr" "$role" 7 >> "$REPORTS_DIR/ca_init.log" 2>&1
  done

  echo "[CI] 3/6: SAE-REVOKED-TEST iptal ediliyor (CRL/OCSP iptal-red testi için)"
  "$BB84_DIR/pki_tools/revoke_cert.sh" "$PKI_DIR" "$PKI_DIR/reqs/SAE-REVOKED-TEST-cert.pem" >> "$REPORTS_DIR/ca_init.log" 2>&1

  echo "[CI] 4/6: sentetik test anahtar deposu (keystore.json) üretiliyor — rota=ANK-IBM-QNET"
  node -e '
    const crypto = require("crypto");
    const keys = [];
    for (let i = 0; i < 8; i++) {
      keys.push({ key_ID: crypto.randomUUID(), key: crypto.randomBytes(32).toString("base64"), sizeBits: 256, blockIndex: i + 1 });
    }
    const out = { routes: { "ANK-IBM-QNET": keys }, exportNote: "CI ephemeral test fixture — GERÇEK QKD anahtar materyali DEĞİL" };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
  ' "$PKI_DIR/keystore.json"

  echo "[CI] 5/6: OCSP yanıtlayıcısı + KME sunucusu başlatılıyor (port ${OCSP_PORT}/${KME_PORT})"
  "$BB84_DIR/pki_tools/run_ocsp_responder.sh" "$PKI_DIR" "$OCSP_PORT" > "$REPORTS_DIR/ocsp_responder.log" 2>&1 &
  BG_PIDS+=("$!")

  node "$BB84_DIR/etsi014_kme_server.js" \
    --port="$KME_PORT" \
    --cert="$PKI_DIR/reqs/localhost-cert.pem" --key="$PKI_DIR/reqs/localhost-key.pem" --ca="$PKI_DIR/ca-cert.pem" \
    --crl="$PKI_DIR/crl/ca-crl.pem" --ocsp-responder="http://localhost:${OCSP_PORT}" \
    --keystore="$PKI_DIR/keystore.json" \
    > "$REPORTS_DIR/kme_server.log" 2>&1 &
  BG_PIDS+=("$!")

  echo "[CI] 6/6: sunucunun hazır olması bekleniyor..."
  # localhost-cert.pem'i PROBE sertifikası olarak kullanıyoruz — henüz
  # hiçbir gerçek test sorgusu tüketilmemiş "temiz" bir sertifika, ve zaten
  # bu ortamda mevcut (rol=server ama OCSP sorgusu sertifika ROLÜNE değil
  # yalnızca seri numarasına bakar, bu yüzden probe amaçlı kullanılabilir).
  wait_for_ocsp_responder "$PKI_DIR/ca-cert.pem" "$PKI_DIR/reqs/localhost-cert.pem" "http://localhost:${OCSP_PORT}" 15
  wait_for_port "localhost" "$KME_PORT" 15
  echo "[CI] Ephemeral ortam hazır."

  KME_URL="https://localhost:${KME_PORT}"
  CA_CERT="$PKI_DIR/ca-cert.pem"
  IBM_CERT="$PKI_DIR/reqs/SAE-IBM-QNET-cert.pem"; IBM_KEY="$PKI_DIR/reqs/SAE-IBM-QNET-key.pem"
  PEER_CERT="$PKI_DIR/reqs/SAE-ANK-cert.pem";     PEER_KEY="$PKI_DIR/reqs/SAE-ANK-key.pem"
  EXPECTED_SERVER_CN="${EXPECTED_SERVER_CN:-localhost}"
  CRL_PATH="$PKI_DIR/crl/ca-crl.pem"
  OCSP_RESPONDER_URL="http://localhost:${OCSP_PORT}"
  REVOKED_CERT="${REVOKED_CERT:-$PKI_DIR/reqs/SAE-REVOKED-TEST-cert.pem}"
  REVOKED_KEY="${REVOKED_KEY:-$PKI_DIR/reqs/SAE-REVOKED-TEST-key.pem}"

elif [ "$KME_MODE" = "external" ]; then
  echo "[CI] Mod: EXTERNAL — verilen GERÇEK sertifikalarla verilen KME_URL'e bağlanılacak (yerel sunucu KURULMAYACAK)"
  : "${KME_URL:?external modda KME_URL zorunlu}"
  : "${CA_CERT:?external modda CA_CERT zorunlu}"
  : "${IBM_CERT:?external modda IBM_CERT zorunlu}"
  : "${IBM_KEY:?external modda IBM_KEY zorunlu}"
  : "${PEER_CERT:?external modda PEER_CERT zorunlu}"
  : "${PEER_KEY:?external modda PEER_KEY zorunlu}"
  EXPECTED_SERVER_CN="${EXPECTED_SERVER_CN:-}"
  CRL_PATH="${CRL_PATH:-}"
  OCSP_RESPONDER_URL="${OCSP_RESPONDER_URL:-}"
  REVOKED_CERT="${REVOKED_CERT:-}"
  REVOKED_KEY="${REVOKED_KEY:-}"
else
  echo "[CI] HATA: bilinmeyen KME_MODE='$KME_MODE' (beklenen: ephemeral|external)" >&2
  exit 2
fi

echo "[CI] mock_ibm_client.js çalıştırılıyor → ${KME_URL}"
MOCK_ARGS=(
  --kme-url="$KME_URL" --ca="$CA_CERT"
  --ibm-cert="$IBM_CERT" --ibm-key="$IBM_KEY"
  --peer-cert="$PEER_CERT" --peer-key="$PEER_KEY"
  --junit-out="$JUNIT_OUT"
)
[ -n "$EXPECTED_SERVER_CN" ] && MOCK_ARGS+=(--expected-server-cn="$EXPECTED_SERVER_CN")
[ -n "$CRL_PATH" ] && MOCK_ARGS+=(--crl="$CRL_PATH")
[ -n "$OCSP_RESPONDER_URL" ] && MOCK_ARGS+=(--ocsp-responder="$OCSP_RESPONDER_URL")
[ -n "$REVOKED_CERT" ] && [ -n "$REVOKED_KEY" ] && MOCK_ARGS+=(--revoked-cert="$REVOKED_CERT" --revoked-key="$REVOKED_KEY")
[ "$SKIP_ROGUE_TEST" = "1" ] && MOCK_ARGS+=(--skip-rogue-test)

set +e
node "$BB84_DIR/mock_ibm_client.js" "${MOCK_ARGS[@]}" 2>&1 | tee "$REPORTS_DIR/mock_ibm_client.log"
TEST_EXIT_CODE="${PIPESTATUS[0]}"
set -e

if [ "$TEST_EXIT_CODE" -eq 0 ]; then
  echo "[CI] ✅ Mock IBM Network Client entegrasyon testleri BAŞARILI (rapor: $JUNIT_OUT)"
else
  echo "[CI] ❌ Mock IBM Network Client entegrasyon testleri BAŞARISIZ (exit=${TEST_EXIT_CODE}) — bkz. $REPORTS_DIR/mock_ibm_client.log"
  if [ "$KME_MODE" = "ephemeral" ]; then
    echo "[CI] --- KME sunucu logu (son 60 satır) ---"; tail -n 60 "$REPORTS_DIR/kme_server.log" || true
    echo "[CI] --- OCSP yanıtlayıcı logu (son 30 satır) ---"; tail -n 30 "$REPORTS_DIR/ocsp_responder.log" || true
  fi
fi

exit "$TEST_EXIT_CODE"
