#!/usr/bin/env bash
# run_buffer_starvation_test.sh — "Havuz Tıkanması" testi: PhotonNet'in
# etsi014_kme_server.js'ini KASITLI OLARAK talebin altında bir keystore
# ile başlatır (arz < QKDNetSim-şekilli talep), sonra buffer_starvation_test.js
# ile bu tükenmenin GÜVENLİ ele alınıp alınmadığını doğrular.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KME_PORT="${KME_PORT:-8643}"
SCALE="${SCALE:-0.05}"
REAL_DURATION_S="${REAL_DURATION_S:-40}"
SUPPLY_KEYS="${SUPPLY_KEYS:-120}"   # kasıtlı olarak talebin altında (bkz. aşağıdaki tahmini talep logu)
ROUTE="ANK"
OUT_REPORT="${OUT_REPORT:-/tmp/buffer_starvation_report.json}"

TMP_DIR="$(mktemp -d)"; PKI_DIR="$TMP_DIR/pki"
BG_PIDS=()
cleanup() { local ec=$?; for pid in "${BG_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; sleep 1; rm -rf "$TMP_DIR"; exit "$ec"; }
trap cleanup EXIT INT TERM
wait_for_port() { local host="$1" port="$2" timeout_s="${3:-20}" waited=0
  while ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do sleep 0.5; waited=$((waited+1))
    [ "$waited" -ge $((timeout_s*2)) ] && { echo "HATA: $host:$port açılmadı" >&2; return 1; }; done
  exec 3>&- 2>/dev/null || true; }

ESTIMATED_DEMAND="$(node -e "console.log(Math.round(28140*${SCALE}))")"
echo "[STARV-RUN] Tahmini talep (×${SCALE} ölçekli QKDNetSim şekli): ~${ESTIMATED_DEMAND} istek — arz KASITLI olarak ${SUPPLY_KEYS} anahtarla sınırlı (tükenme GARANTİ)"

echo "[STARV-RUN] 1/5: geçici PKI kuruluyor"
"$SCRIPT_DIR/pki_tools/ca_init.sh" "$PKI_DIR" > "$TMP_DIR/ca_init.log" 2>&1
for pair in "server:localhost" "client:SAE-IBM-QNET" "client:SAE-$ROUTE"; do
  role="${pair%%:*}"; cn="${pair##*:}"
  "$SCRIPT_DIR/pki_tools/issue_cert.sh" "$PKI_DIR/reqs" "$role" "$cn" >> "$TMP_DIR/ca_init.log" 2>&1
  "$SCRIPT_DIR/pki_tools/sign_csr.sh" "$PKI_DIR" "$PKI_DIR/reqs/$cn.csr" "$role" 7 >> "$TMP_DIR/ca_init.log" 2>&1
done

echo "[STARV-RUN] 2/5: SINIRLI keystore.json üretiliyor (rota=${ROUTE}, yalnızca ${SUPPLY_KEYS} anahtar)"
PKI_DIR="$PKI_DIR" SUPPLY_KEYS="$SUPPLY_KEYS" ROUTE="$ROUTE" node -e '
  const crypto = require("crypto");
  const n = parseInt(process.env.SUPPLY_KEYS, 10);
  const routeKey = [process.env.ROUTE, "IBM-QNET"].sort().join("-");
  const keys = [];
  for (let i = 0; i < n; i++) keys.push({ key_ID: crypto.randomUUID(), key: crypto.randomBytes(16).toString("base64"), sizeBits: 128, blockIndex: i + 1 });
  const out = { routes: { [routeKey]: keys }, exportNote: "buffer_starvation_test.js için KASITLI OLARAK SINIRLI keystore — havuz tükenmesi senaryosu" };
  require("fs").writeFileSync(process.env.PKI_DIR + "/keystore.json", JSON.stringify(out));
  console.log("keystore rotası:", routeKey, "| anahtar sayısı:", n);
'

echo "[STARV-RUN] 3/5: KME sunucusu başlatılıyor (port $KME_PORT)"
node "$SCRIPT_DIR/etsi014_kme_server.js" \
  --port="$KME_PORT" \
  --cert="$PKI_DIR/reqs/localhost-cert.pem" --key="$PKI_DIR/reqs/localhost-key.pem" --ca="$PKI_DIR/ca-cert.pem" \
  --keystore="$PKI_DIR/keystore.json" \
  > "$TMP_DIR/kme_server.log" 2>&1 &
BG_PIDS+=("$!")
wait_for_port "localhost" "$KME_PORT" 15
echo "[STARV-RUN] KME sunucusu hazır."

echo "[STARV-RUN] 4/5: buffer_starvation_test.js çalıştırılıyor..."
set +e
node "$SCRIPT_DIR/buffer_starvation_test.js" \
  --kme-url="https://localhost:${KME_PORT}" --ca="$PKI_DIR/ca-cert.pem" \
  --master-cert="$PKI_DIR/reqs/SAE-IBM-QNET-cert.pem" --master-key="$PKI_DIR/reqs/SAE-IBM-QNET-key.pem" \
  --pki-dir="$PKI_DIR" --route="$ROUTE" \
  --scale="$SCALE" --real-duration="$REAL_DURATION_S" --out="$OUT_REPORT"
TEST_EXIT=$?
set -e

echo "[STARV-RUN] 5/5: tamamlandı (çıkış kodu: $TEST_EXIT). Rapor: $OUT_REPORT"
if [ "$TEST_EXIT" -ne 0 ]; then
  echo "[STARV-RUN] --- KME sunucu logu (son 40 satır) ---"; tail -n 40 "$TMP_DIR/kme_server.log" || true
fi
exit "$TEST_EXIT"
