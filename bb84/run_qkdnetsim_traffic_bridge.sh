#!/usr/bin/env bash
# run_qkdnetsim_traffic_bridge.sh — QKDNetSim (Saraybosna Üni. + VSB Ostrava,
# /tmp içinde İZOLE) tarafından üretilen GERÇEK 500 saniyelik trafik ŞEKLİNİ
# (bb84/qkdnetsim_traffic_profile.json), PhotonNet'in GERÇEK mTLS/ETSI-014
# KME sunucusuna (etsi014_kme_server.js) besleyen uçtan-uca kurgu.
#
# Bu script bb84/ci/run_integration_tests.sh'in "ephemeral" moduyla AYNI
# deseni izler (geçici CA + sertifikalar, yerel KME sunucusu, iş bitince
# TAM temizlik) — ama TEK bir statik anahtar alışverişi yerine, çoklu-düğüm
# (3 SAE rotası) ve QKDNetSim'in GERÇEK zaman-profiline göre ölçeklenmiş
# bir YÜK testi çalıştırır.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KME_PORT="${KME_PORT:-8543}"
SCALE="${SCALE:-0.1}"
REAL_DURATION_S="${REAL_DURATION_S:-80}"
OUT_REPORT="${OUT_REPORT:-/tmp/qkdnetsim_bridge_report.json}"
ROUTES=(ANK IZM BUR)

TMP_DIR="$(mktemp -d)"
PKI_DIR="$TMP_DIR/pki"
BG_PIDS=()
cleanup() {
  local ec=$?
  for pid in "${BG_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  sleep 1
  rm -rf "$TMP_DIR"
  exit "$ec"
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local host="$1" port="$2" timeout_s="${3:-20}" waited=0
  while ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
    sleep 0.5; waited=$((waited+1))
    [ "$waited" -ge $((timeout_s*2)) ] && { echo "HATA: $host:$port açılmadı" >&2; return 1; }
  done
  exec 3>&- 2>/dev/null || true
}

echo "[BRIDGE-RUN] 1/5: geçici PKI kuruluyor (CA + server + SAE-IBM-QNET master + ${ROUTES[*]/#/SAE-} slave sertifikaları)"
"$SCRIPT_DIR/pki_tools/ca_init.sh" "$PKI_DIR" > "$TMP_DIR/ca_init.log" 2>&1
for pair in "server:localhost" "client:SAE-IBM-QNET"; do
  role="${pair%%:*}"; cn="${pair##*:}"
  "$SCRIPT_DIR/pki_tools/issue_cert.sh" "$PKI_DIR/reqs" "$role" "$cn" >> "$TMP_DIR/ca_init.log" 2>&1
  "$SCRIPT_DIR/pki_tools/sign_csr.sh" "$PKI_DIR" "$PKI_DIR/reqs/$cn.csr" "$role" 7 >> "$TMP_DIR/ca_init.log" 2>&1
done
for r in "${ROUTES[@]}"; do
  "$SCRIPT_DIR/pki_tools/issue_cert.sh" "$PKI_DIR/reqs" client "SAE-$r" >> "$TMP_DIR/ca_init.log" 2>&1
  "$SCRIPT_DIR/pki_tools/sign_csr.sh" "$PKI_DIR" "$PKI_DIR/reqs/SAE-$r.csr" client 7 >> "$TMP_DIR/ca_init.log" 2>&1
done

PER_ROUTE_ESTIMATE="$(node -e "console.log(Math.round(28140*${SCALE}/${#ROUTES[@]})+50)")"
echo "[BRIDGE-RUN] 2/5: ölçeklenmiş keystore.json üretiliyor (rota başına ~${PER_ROUTE_ESTIMATE} anahtar, 128-bit)"
PKI_DIR="$PKI_DIR" node -e '
  const crypto = require("crypto");
  const routes = process.argv.slice(1);
  const perRoute = Math.round(28140 * '"$SCALE"' / routes.length) + 50; // küçük güvenlik payı
  const out = { routes: {}, exportNote: "qkdnetsim_traffic_bridge.js YÜK TESTİ için ölçeklenmiş sentetik keystore — GERÇEK QKD anahtar materyali DEĞİL" };
  const strip = s => s.replace(/^SAE-/i, "");
  for (const r of routes) {
    const routeKey = [strip(r), "IBM-QNET"].sort().join("-");
    const keys = [];
    for (let i = 0; i < perRoute; i++) keys.push({ key_ID: crypto.randomUUID(), key: crypto.randomBytes(16).toString("base64"), sizeBits: 128, blockIndex: i + 1 });
    out.routes[routeKey] = keys;
  }
  require("fs").writeFileSync(process.env.PKI_DIR + "/keystore.json", JSON.stringify(out));
  console.log("keystore rotaları:", Object.keys(out.routes).join(", "), "| rota başına:", perRoute);
' "${ROUTES[@]}"

echo "[BRIDGE-RUN] 3/5: KME sunucusu başlatılıyor (port $KME_PORT)"
node "$SCRIPT_DIR/etsi014_kme_server.js" \
  --port="$KME_PORT" \
  --cert="$PKI_DIR/reqs/localhost-cert.pem" --key="$PKI_DIR/reqs/localhost-key.pem" --ca="$PKI_DIR/ca-cert.pem" \
  --keystore="$PKI_DIR/keystore.json" \
  > "$TMP_DIR/kme_server.log" 2>&1 &
BG_PIDS+=("$!")
wait_for_port "localhost" "$KME_PORT" 15
echo "[BRIDGE-RUN] KME sunucusu hazır."

echo "[BRIDGE-RUN] 4/5: qkdnetsim_traffic_bridge.js çalıştırılıyor (ölçek=×$SCALE, gerçek-süre=${REAL_DURATION_S}s)..."
set +e
node "$SCRIPT_DIR/qkdnetsim_traffic_bridge.js" \
  --kme-url="https://localhost:${KME_PORT}" --ca="$PKI_DIR/ca-cert.pem" \
  --master-cert="$PKI_DIR/reqs/SAE-IBM-QNET-cert.pem" --master-key="$PKI_DIR/reqs/SAE-IBM-QNET-key.pem" \
  --pki-dir="$PKI_DIR" --routes="$(IFS=,; echo "${ROUTES[*]}")" \
  --scale="$SCALE" --real-duration="$REAL_DURATION_S" --out="$OUT_REPORT"
BRIDGE_EXIT=$?
set -e

echo "[BRIDGE-RUN] 5/5: tamamlandı (çıkış kodu: $BRIDGE_EXIT). Rapor: $OUT_REPORT"
if [ "$BRIDGE_EXIT" -ne 0 ]; then
  echo "[BRIDGE-RUN] --- KME sunucu logu (son 40 satır) ---"; tail -n 40 "$TMP_DIR/kme_server.log" || true
fi
exit "$BRIDGE_EXIT"
