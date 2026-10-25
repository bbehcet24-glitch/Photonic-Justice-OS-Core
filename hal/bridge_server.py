"""
bridge_server — PhotonNet tarayıcı arayüzü ile bu native HAL servisi
arasındaki köprü.

DÜRÜST DURUM: gerçek bir WebSocket kütüphanesi (`websockets`, `fastapi`)
bu geliştirme sandbox'ında kurulu DEĞİL (pip yeni paket kuramıyor — bu
oturumda birden çok kez doğrulandı). Bunun yerine yalnızca stdlib +
Flask (kurulu) kullanan bir REST + Server-Sent-Events (SSE) köprüsü
kuruldu:
  - REST uçları (connect/disconnect/acquire/status) kontrol için,
  - `/api/stream` SSE ucu düşük-gecikmeli tek-yönlü telemetri push'u için
    (tarayıcıda `new EventSource(...)` ile tüketilir, ekstra kütüphane
    gerektirmez, tüm modern tarayıcılarda yerleşik).
Gerçek donanıma bağlanacağınız üretim makinesinde `pip install websockets`
(veya fastapi) çalıştırılabiliyorsa, bu dosya değiştirilmeden bir
WebSocket sürümüne geçirilebilir — LinkManager/TimeTagCorrelator katmanları
buradan TAMAMEN BAĞIMSIZDIR, hiçbir şeyi bilmezler.

ÇALIŞTIRMA:  python3 -m hal.bridge_server
Test:        curl -X POST localhost:8765/api/acquire -H 'Content-Type: application/json' \
                   -d '{"distance_km": 25, "eavesdrop": false, "duration_s": 0.0005}'
"""
from __future__ import annotations

import base64
import dataclasses
import json
import logging
import os
import queue
import threading
import time

from flask import Flask, Response, jsonify, request

from .hardware_interface import HardwareError
from .link_manager import LinkManager
from .qrng_health_tests import bytes_to_bits, run_health_tests
from .qrng_interface import QRNGError
from .qrng_simulated import SimulatedQRNG
from .simulated_hardware import SimulatedAliceSource, SimulatedHardware
from .time_tag_correlator import TimeTagCorrelator
from .types import AcquisitionConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("photonnet.hal.bridge_server")

app = Flask(__name__)


@app.after_request
def _add_cors_headers(resp):
    """PhotonNet.html tarayıcıda genelde file:// (Origin: null) ya da
    ayrı bir statik-dosya sunucusundan açılır — bu köprü sunucusundan
    (localhost:8765) FARKLI bir origin sayılır, bu yüzden CORS başlıkları
    olmadan tarayıcı fetch()/EventSource isteklerini engeller.
    `flask-cors` bu sandbox'ta kurulu değil (pip yeni paket kuramıyor —
    bkz. modül başlığı), bu yüzden başlıklar burada elle ekleniyor. Bu
    yalnızca yerel bir geliştirme/demo köprüsü olduğundan `*` ile
    kısıtlamasız izin vermek kabul edilebilir; üretimde belirli bir
    origin'e daraltılmalıdır."""
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ── Süreç-genelinde tekil (singleton) durum ──────────────────────────────
# Küçük bir HAL demo servisi için kabul edilebilir; gerçek çok-oturumlu
# bir dağıtımda bu bir oturum/kullanıcı başına nesne haline getirilir.
_link_manager: LinkManager | None = None
_status_subscribers: list["queue.Queue"] = []
_subscribers_lock = threading.Lock()

# ── QRNG donanım köprüsü (bkz. qrng_interface.py'nin baş yorumu) ─────────
# BAĞLAM: bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md, çekirdeğin "kuantum" bit
# üretiminin gerçekte 32-bit mulberry32'den türediğini kanıtlamıştı.
# `bb84/timetag_acquisition_bridge.js`'in ZATEN doğru tasarlanmış
# `opts.qrng` seam'ine (mulberry32'yi TAMAMEN by-pass eden, crypto.randomBytes
# varsayılanlı enjekte edilebilir arayüz) gerçek/harici bir entropi
# KAYNAĞI takmak için bu uç noktalar var. Backend seçimi env değişkeniyle:
#   PHOTONNET_QRNG_BACKEND=simulated              (varsayılan — os.urandom, DONANIM DEĞİL)
#   PHOTONNET_QRNG_BACKEND=tcp:<host>:<port>      (TCPQRNG — gerçek/ağ QRNG cihazı)
#   PHOTONNET_QRNG_BACKEND=serial:<port>[:<baud>] (SerialQRNG — gerçek USB QRNG dongle'ı)
# `PHOTONNET_QRNG_MIN_ENTROPY_BITS`: örnek başına VENDOR'IN BEYAN ETTİĞİ
# min-entropi (bit) — GERÇEK donanımda bu değer cihazın karakterizasyon
# raporundan gelmelidir, burada VARSAYILMAZ (varsayılan 1.0, SimulatedQRNG
# için makuldür ama gerçek donanım için ASLA kör kör kopyalanmamalıdır).
_qrng_source = None
_qrng_lock = threading.Lock()


def _make_qrng_source():
    backend = os.environ.get("PHOTONNET_QRNG_BACKEND", "simulated")
    if backend == "simulated":
        return SimulatedQRNG()
    if backend.startswith("tcp:"):
        from .qrng_tcp_hardware import TCPQRNG
        _, host, port = backend.split(":", 2)
        return TCPQRNG(host, int(port))
    if backend.startswith("serial:"):
        from .qrng_serial_hardware import SerialQRNG
        parts = backend.split(":")
        port = parts[1]
        baud = int(parts[2]) if len(parts) > 2 else 921600
        return SerialQRNG(port, baud)
    raise ValueError(f"tanınmayan PHOTONNET_QRNG_BACKEND: {backend!r}")


def _get_qrng_source():
    global _qrng_source
    with _qrng_lock:
        if _qrng_source is None:
            src = _make_qrng_source()
            src.connect()
            _qrng_source = src
        return _qrng_source


def _qrng_min_entropy_bits() -> float:
    return float(os.environ.get("PHOTONNET_QRNG_MIN_ENTROPY_BITS", "1.0"))


# ── Aralıklı (intermittent) ve kalıcı (persistent) sağlık testi hatası ──
# α = 2⁻²⁰ örnek başına yanlış-alarm sınırıdır; 2048 baytlık (16.384 bit) BİR partide sağlam bir kaynağın
# RCT'ye takılma olasılığı ≈ N·2⁻²¹ ≈ %0,78'dir (ölçüldü: 40.000 os.urandom partisinde %0,79). Eskiden tek
# başarısız parti isteği 503 ile düşürüyordu; `npm test` koşu başına ~20 parti çektiği için bu, analitik olarak
# ≈ %13 olasılıkla rastgele kırmızı demekti (CI Kapı 5'in ilk GitHub koşusu böyle düştü:
# chaos_mtls_handshake_qrng_sync_test, "RCT/APT"). Ölçüm, iki QRNG testinin 40 tekrarı: eski davranış
# 3 başarısız test, yeni davranış 0 (806 partiden 6'sı atıldı, kalıcı hata 0).
# Yeni davranış (SP 800-90B'nin aralıklı/kalıcı hata ayrımına uygun):
#   • Başarısız parti ASLA servis edilmez — atılır, sayaçlara yazılır, kaynaktan TAZE bir parti çekilir.
#   • Aynı istekte art arda PHOTONNET_QRNG_MAX_ATTEMPTS (varsayılan 3) parti başarısızsa → KALICI hata, 503.
#   • α ve dolayısıyla parti başına tespit gücü DEĞİŞMEDİ (α'yı 2⁻⁴⁰'a çekmek p=0,6 yanlılığın parti başına
#     tespitini %100'den %8'e düşürüyordu — ölçüldü; o yol bilerek seçilmedi).
#   • Bedel: atılan partiler (%0,8) uzun koşu içerenlerdir; servis edilen parti dağılımının min-entropisi
#     parti başına −log2(1−0,0078) ≈ 0,011 bit azalır (16.384 bitin yanında ihmal edilebilir, ama sıfır değil).
#   • Sabit bir yanlılık/sıkışma her partide tekrarlandığı için 3 denemede de yakalanır (fail-closed korunur).
_QRNG_ATTEMPTS_DEFAULT = 3
_qrng_health_stats = {"batchesServed": 0, "batchesDiscarded": 0, "persistentFailures": 0, "lastDiscardReason": None}
_qrng_stats_lock = threading.Lock()


def _qrng_max_attempts() -> int:
    raw = os.environ.get("PHOTONNET_QRNG_MAX_ATTEMPTS", str(_QRNG_ATTEMPTS_DEFAULT))
    try:
        v = int(raw)
    except ValueError:
        v = -1
    if not 1 <= v <= 10:
        raise QRNGError(f"PHOTONNET_QRNG_MAX_ATTEMPTS 1..10 arasında bir tam sayı olmalı (alınan: {raw!r})")
    return v


def _health_fail_reason(health: dict) -> str:
    return "; ".join(f"{k.upper()}: {health[k]['detail']}" for k in ("rct", "apt") if not health[k]["passed"])


def _broadcast_status(status) -> None:
    payload = json.dumps({"type": "status", "data": dataclasses.asdict(status)})
    with _subscribers_lock:
        for q in _status_subscribers:
            q.put(payload)


@app.route("/api/connect", methods=["POST"])
def api_connect():
    """LinkManager'ı başlatır — arka planda sürekli bağlan/dinle döngüsü
    kurar (SimulatedHardware ile; gerçek donanımda burada SerialHardware
    veya TCPHardware kullanılır, bkz. modül başlığı).

    PERFORMANS NOTU: bu SÜREKLİ akış yolu, /api/acquire'daki tek-seferlik
    kısa-pencereli (mikrosaniye mertebesi) yüksek hızlı (80MHz) üretimden
    FARKLI bir amaca hizmet eder — burada LinkManager'ın poll_interval_s
    (varsayılan 0.25s) periyoduyla SÜREKLİ çalışması gerekir. Gerçek
    kaynak hızını (80MHz) saf Python'da sürekli üretmeye çalışmak (0.25s'te
    20 milyon darbe) pratik olarak DONAR — gerçek donanımda bu iş FPGA/özel
    silikonda yapılır, Python yalnızca SONUÇLARI okur. Bu yüzden sürekli
    akış demosu, KASITLI OLARAK çok daha düşük bir "demo kaynak hızı"
    (DEMO_SOURCE_RATE_HZ) kullanır — LinkManager/TimeTagCorrelator
    mimarisini gerçek zamanlı olarak sergilemek içindir, gerçek anahtar
    üretimi için /api/acquire kullanılmalıdır.
    """
    global _link_manager
    body = request.get_json(silent=True) or {}
    distance_km = float(body.get("distance_km", 25.0))
    eavesdrop = bool(body.get("eavesdrop", False))
    seed = body.get("seed")

    if _link_manager is not None:
        _link_manager.stop()

    DEMO_SOURCE_RATE_HZ = 4000.0  # bkz. yukarıdaki performans notu
    hw = SimulatedHardware(distance_km=distance_km, eavesdrop=eavesdrop, seed=seed)
    hw.attach_source(SimulatedAliceSource(source_rate_hz=DEMO_SOURCE_RATE_HZ, seed=seed))
    _link_manager = LinkManager(hw)
    _link_manager.subscribe_status(_broadcast_status)
    _link_manager.start(AcquisitionConfig(source_rate_hz=DEMO_SOURCE_RATE_HZ))
    return jsonify({"ok": True, "message": "LinkManager başlatıldı (arka planda bağlanıyor, demo kaynak hızı=4kHz)"})


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    global _link_manager
    if _link_manager is not None:
        _link_manager.stop()
        _link_manager = None
    return jsonify({"ok": True})


@app.route("/api/status", methods=["GET"])
def api_status():
    if _link_manager is None:
        return jsonify({"connected": False, "armed": False, "driver_name": "none"})
    return jsonify(dataclasses.asdict(_link_manager.status()))


@app.route("/api/acquire", methods=["POST"])
def api_acquire():
    """Tek seferlik, SENKRON bir BB84 edinim oturumu çalıştırır: bağımsız
    bir Alice kaynağı + Bob dedektörü kurar, `duration_s` boyunca darbe
    üretir, TimeTagCorrelator ile eşleştirir, SiftingResult'ı JSON olarak
    döndürür. Bu, canlı LinkManager akışından KASITLI OLARAK BAĞIMSIZDIR
    — "bir mesaj gönder, sonucu hemen al" isteyen bir UI için en basit
    ve doğru desendir (LinkManager'ın sürekli arka plan akışı ayrı bir
    kullanım senaryosuna, örn. bir "canlı sayım hızı" göstergesine hizmet
    eder)."""
    body = request.get_json(silent=True) or {}
    distance_km = float(body.get("distance_km", 25.0))
    eavesdrop = bool(body.get("eavesdrop", False))
    seed = body.get("seed")
    # DİKKAT: duration_s doğrudan üretilecek darbe sayısını belirler
    # (source_rate_hz × duration_s) — saf Python nesne üretimi olduğundan
    # büyük değerler (>0.01s @ 80MHz = 800bin darbe) yavaş olabilir. REST
    # demo/test amaçlı küçük pencereler için tasarlandı.
    duration_s = float(body.get("duration_s", 0.0005))
    coincidence_window_ps = int(body.get("coincidence_window_ps", 500))
    # GÜVENLİK/PERFORMANS: ham anahtar bitleri VARSAYILAN OLARAK dönmez —
    # bir UI genelde yalnızca özet istatistikleri (QBER, sayaçlar) gösterir
    # ve ham anahtar materyalini yerel olmayan bir HTTP yanıtında taşımak
    # (localhost'ta bile) kötü bir alışkanlıktır. Gerçekten ihtiyaç varsa
    # (örn. bir sonraki OTP adımı için) include_bits:true ile istenebilir.
    include_bits = bool(body.get("include_bits", False))

    source = SimulatedAliceSource(seed=seed)
    hw = SimulatedHardware(distance_km=distance_km, eavesdrop=eavesdrop, seed=seed)
    hw.attach_source(source)

    t0 = time.monotonic()
    try:
        with hw:
            hw.arm(AcquisitionConfig(coincidence_window_ps=coincidence_window_ps))
            clicks = hw.read_clicks(timeout_s=duration_s)
    except HardwareError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    alice_log = hw.get_last_transmit_log()
    elapsed = time.monotonic() - t0

    correlator = TimeTagCorrelator(coincidence_window_ps=coincidence_window_ps)
    result = correlator.correlate(alice_log, clicks)

    result_payload = {
        "qber": result.qber,
        "eavesdrop_detected": result.eavesdrop_detected,
        "lost_count": result.lost_count,
        "dark_click_count": result.dark_click_count,
        "match_rate": result.match_rate,
        "detected_count": result.detected_count,
        "sifted_key_len": len(result.sifted_key_bits),
    }
    if include_bits:
        result_payload["sifted_key_bits"] = result.sifted_key_bits
        result_payload["bob_key_bits"] = result.bob_key_bits

    return jsonify({
        "ok": True,
        "distance_km": distance_km,
        "eavesdrop": eavesdrop,
        "duration_s": duration_s,
        "pulses_sent": len(alice_log),
        "clicks_received": len(clicks),
        "wall_clock_s": round(elapsed, 4),
        "result": result_payload,
    })


@app.route("/api/clicks", methods=["GET"])
def api_clicks():
    """LinkManager'ın arka planda biriktirdiği click kuyruğunu boşaltır.

    NEDEN GEREKLİ: /api/connect başlattığı sürekli akış, click'leri
    LinkManager._click_queue içine yazar ama hiçbir şey onları tüketmezse
    kuyruk büyümeye devam eder (bkz. link_manager.py'deki
    DEFAULT_CLICK_QUEUE_MAXSIZE notu — artık sınırlı ve en-eski-düşürme
    korumalı, ama yine de düzenli drenaj olmadan sürekli drop yaşanır).
    Bir UI, bunu periyodik çağırıp (örn. saniyede birkaç kez) "canlı sayım
    hızı" göstergesini besleyebilir. `?max=` ile tek seferde çekilecek üst
    sınır, `?timeout_s=` ile ne kadar bekleneceği ayarlanabilir (kuyruk
    anlık boşsa varsayılan olarak hemen boş liste döner)."""
    if _link_manager is None:
        return jsonify({"ok": False, "error": "bağlı değil — önce /api/connect çağırın"}), 400

    max_items = int(request.args.get("max", 5000))
    timeout_s = float(request.args.get("timeout_s", 0.0))
    clicks = _link_manager.get_clicks(max_items=max_items, timeout_s=timeout_s)
    stats = _link_manager.queue_stats()

    return jsonify({
        "ok": True,
        "count": len(clicks),
        "clicks": [{"timestamp_ps": c.timestamp_ps, "channel": c.channel.value} for c in clicks],
        "queue": stats,
    })


@app.route("/api/stream")
def api_stream():
    """SSE ucu — LinkManager durum değişikliklerini gerçek zamanlı
    tarayıcıya iter. Tarayıcı tarafında: `new EventSource('/api/stream')`."""
    q: "queue.Queue" = queue.Queue()
    with _subscribers_lock:
        _status_subscribers.append(q)

    def gen():
        try:
            # Bağlantı anında mevcut durumu hemen gönder.
            if _link_manager is not None:
                yield f"data: {json.dumps({'type': 'status', 'data': dataclasses.asdict(_link_manager.status())})}\n\n"
            while True:
                try:
                    payload = q.get(timeout=15)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"  # SSE yorum satırı — bağlantıyı canlı tutar
        finally:
            with _subscribers_lock:
                if q in _status_subscribers:
                    _status_subscribers.remove(q)

    return Response(gen(), mimetype="text/event-stream")


@app.route("/api/qrng/status", methods=["GET"])
def api_qrng_status():
    try:
        src = _get_qrng_source()
        st = src.status()
        with _qrng_stats_lock:
            stats = dict(_qrng_health_stats)
        return jsonify({"ok": True, "connected": st.connected, "isCertifiedHardware": st.is_certified_hardware,
                         "vendor": st.vendor, "driverName": st.driver_name, "lastError": st.last_error,
                         "healthStats": stats})
    except QRNGError as e:
        return jsonify({"ok": False, "error": str(e)}), 503


@app.route("/api/qrng/bytes", methods=["GET"])
def api_qrng_bytes():
    """Bir parti (batch) ham entropi baytı döndürür — HER partide RCT+APT
    çalıştırılır (bkz. qrng_health_tests.py'nin baş yorumu: bu testler
    BÜYÜK/biriken akışlar üzerinde DEĞİL, sınırlı boyutlu partiler üzerinde
    çalıştırılmalı). Sağlık testi BAŞARISIZ olursa 503 + `ok:false` döner
    — bu baytlar HTTP gövdesine dahi YERLEŞTİRİLMEZ (fail-closed: çağıran
    tarafın "belki kullanılabilir" bir şeyle karşılaşma riski YOK).
    `?n=` bayt sayısı (varsayılan 256, üst sınır 65536 — tek istekte
    sınırsız büyümeyi önlemek için).

    Aralıklı hata: başarısız parti atılır ve taze parti çekilir; art arda PHOTONNET_QRNG_MAX_ATTEMPTS parti
    başarısızsa kalıcı hata (503). Ayrıntı ve ölçümler: yukarıdaki "Aralıklı ... hatası" bloğu."""
    n = min(int(request.args.get("n", 256)), 65536)
    timeout_s = float(request.args.get("timeout_s", 5.0))
    try:
        attempts = _qrng_max_attempts()
        src = _get_qrng_source()
    except QRNGError as e:
        return jsonify({"ok": False, "error": str(e)}), 503

    discarded = []
    for _ in range(attempts):
        try:
            data = src.read_bytes(n, timeout_s=timeout_s)
        except QRNGError as e:
            return jsonify({"ok": False, "error": str(e), "discardedBeforeError": len(discarded)}), 503
        health = run_health_tests(bytes_to_bits(data), min_entropy_bits=_qrng_min_entropy_bits())
        if health["overall_pass"]:
            with _qrng_stats_lock:
                _qrng_health_stats["batchesServed"] += 1
            return jsonify({"ok": True, "n": n, "bytesBase64": base64.b64encode(data).decode("ascii"),
                             "health": health, "discardedBeforeServe": len(discarded)})
        reason = _health_fail_reason(health)
        discarded.append(reason)
        del data  # başarısız parti hiçbir yanıta, loga ya da tampona girmez
        with _qrng_stats_lock:
            _qrng_health_stats["batchesDiscarded"] += 1
            _qrng_health_stats["lastDiscardReason"] = reason
        logger.warning("QRNG sağlık testi başarısız — parti ATILDI (%d/%d): %s", len(discarded), attempts, reason)

    with _qrng_stats_lock:
        _qrng_health_stats["persistentFailures"] += 1
    logger.error("QRNG KALICI sağlık testi hatası — art arda %d parti başarısız, bayt SERVİS EDİLMİYOR", attempts)
    return jsonify({"ok": False, "persistent": True,
                     "error": f"QRNG sağlık testi art arda {attempts} partide başarısız (RCT/APT) — kalıcı hata, bkz. detail",
                     "detail": discarded, "health": health}), 503


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"ok": True, "service": "photonnet-hal-bridge"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8765, threaded=True)
