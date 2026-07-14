"""
LinkManager — bir HardwareInterface'i sarmalayıp GERÇEK DÜNYADA olması
gereken şeyi ekler: bağlantı kopabilir, yeniden denenmeli, arka planda
sürekli veri toplanmalı, ana thread (örn. bridge_server) bunu bloklamadan
okuyabilmeli.

Kullanıcının ikinci seçeneği ("gerçek cihaz bağlantılarını yönetecek bir
Bağlantı Katmanı") burada karşılığını buluyor — ama bilerek transport.py'nin
BİR ÜST katmanında: LinkManager, "seri mi TCP mi" ayrımını BİLMEZ (bu,
HardwareInterface implementasyonunun/Transport'un işidir) — yalnızca
"bağlan, koptuysa yeniden dene, arka planda oku, durumu raporla" döngüsünü
yönetir. Bu ayrım kasıtlı: LinkManager'ı DEĞİŞTİRMEDEN yeni bir donanım
türü (örn. gelecekte bir PCIe kart) eklenebilir.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Callable, Optional

from .hardware_interface import HardwareError, HardwareInterface
from .types import AcquisitionConfig, HardwareStatus, TimestampedClick

logger = logging.getLogger("photonnet.hal.link_manager")

DEFAULT_BACKOFF_SCHEDULE_S = (1, 2, 5, 10, 30, 30, 30)  # tekrarlanan denemeler için artan bekleme

# Hiçbir tüketici get_clicks() çağırmadan connect() uzun süre açık kalırsa
# (örn. bridge_server'da /api/clicks hiç sorulmazsa) kuyruk SINIRSIZ
# büyüyüp bellek sızıntısına dönüşebilirdi. Bir üst sınır koyup, dolduğunda
# EN ESKİ click'leri düşürüyoruz (canlı telemetri için "en taze" veri en
# değerlisidir) — gerçek TDC donanımının kendi dahili tamponu da benzer
# şekilde sınırlıdır.
DEFAULT_CLICK_QUEUE_MAXSIZE = 200_000


class LinkManager:
    def __init__(
        self,
        hardware: HardwareInterface,
        backoff_schedule_s: tuple[float, ...] = DEFAULT_BACKOFF_SCHEDULE_S,
        poll_interval_s: float = 0.25,
        click_queue_maxsize: int = DEFAULT_CLICK_QUEUE_MAXSIZE,
    ):
        self._hw = hardware
        self._backoff_schedule = backoff_schedule_s
        self._poll_interval_s = poll_interval_s

        self._click_queue: "queue.Queue[TimestampedClick]" = queue.Queue(maxsize=click_queue_maxsize)
        self._dropped_click_count = 0
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        self._status_lock = threading.Lock()
        self._status = HardwareStatus()
        self._status_callbacks: list[Callable[[HardwareStatus], None]] = []

        self._config: Optional[AcquisitionConfig] = None

    # -- Genel durum bildirimi ------------------------------------------------

    def subscribe_status(self, callback: Callable[[HardwareStatus], None]) -> None:
        """bridge_server gibi tüketicilerin, her durum değişikliğinde
        (bağlandı/koptu/hata) haberdar olmasını sağlar."""
        self._status_callbacks.append(callback)

    def status(self) -> HardwareStatus:
        with self._status_lock:
            return self._status

    def _set_status(self, status: HardwareStatus) -> None:
        with self._status_lock:
            self._status = status
        for cb in self._status_callbacks:
            try:
                cb(status)
            except Exception:
                logger.exception("status callback hata fırlattı, yoksayılıyor")

    # -- Yaşam döngüsü ----------------------------------------------------------

    def start(self, config: AcquisitionConfig) -> None:
        """Arka plan thread'ini başlatır: bağlan (gerekirse yeniden dene),
        arm et, sürekli read_clicks() ile veri topla. Bu metod HEMEN döner
        — bağlantı/toplama arka planda devam eder."""
        if self._thread is not None and self._thread.is_alive():
            raise HardwareError("LinkManager zaten çalışıyor — önce stop() çağırın")
        self._config = config
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="photonnet-link-manager", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        try:
            self._hw.disconnect()
        except Exception:
            logger.exception("disconnect() sırasında hata (yoksayılıyor, zaten durduruluyoruz)")
        self._set_status(HardwareStatus(connected=False, armed=False, driver_name=self._status.driver_name))

    def get_clicks(self, max_items: int = 10_000, timeout_s: float = 0.5) -> list[TimestampedClick]:
        """Kuyruğa arka planda biriken click'leri boşaltıp döndürür.
        Bloklamayan bir "poll" deseni — bridge_server bunu periyodik
        çağırıp SSE üzerinden istemciye iletir."""
        items: list[TimestampedClick] = []
        deadline = time.monotonic() + timeout_s
        try:
            while len(items) < max_items:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                items.append(self._click_queue.get(timeout=remaining))
        except queue.Empty:
            pass
        return items

    def queue_stats(self) -> dict:
        """get_clicks() ile drenaj yapmayan tüketiciler (örn. yalnızca
        durum takip eden bir istemci) için basit bir telemetri özeti —
        bridge_server'daki GET /api/clicks bunu kullanır."""
        return {
            "pending": self._click_queue.qsize(),
            "maxsize": self._click_queue.maxsize,
            "dropped_total": self._dropped_click_count,
        }

    # -- Arka plan döngüsü --------------------------------------------------------

    def _run(self) -> None:
        backoff_idx = 0
        while not self._stop_event.is_set():
            try:
                self._hw.connect()
                self._hw.arm(self._config)
                backoff_idx = 0  # başarılı bağlantı sonrası backoff sıfırlanır
                self._set_status(self._hw.status())
                logger.info("Donanım bağlandı ve kuruldu (armed).")

                # Bağlantı sağlıklıyken sürekli oku.
                while not self._stop_event.is_set():
                    try:
                        clicks = self._hw.read_clicks(timeout_s=self._poll_interval_s)
                    except HardwareError:
                        logger.exception("read_clicks() sırasında donanım hatası — yeniden bağlanılacak")
                        break
                    for c in clicks:
                        try:
                            self._click_queue.put_nowait(c)
                        except queue.Full:
                            # Kuyruk dolu — tüketici (get_clicks) yeterince
                            # sık çağrılmıyor demektir. En eski click'i
                            # düşürüp yerine yenisini koyuyoruz (drop-oldest);
                            # sessizce sonsuza dek büyümek yerine sınırlı
                            # bellek + "en taze veri kalır" garantisi.
                            try:
                                self._click_queue.get_nowait()
                            except queue.Empty:
                                pass
                            self._dropped_click_count += 1
                            try:
                                self._click_queue.put_nowait(c)
                            except queue.Full:
                                pass
                    self._set_status(self._hw.status())

            except HardwareError as e:
                wait_s = self._backoff_schedule[min(backoff_idx, len(self._backoff_schedule) - 1)]
                backoff_idx += 1
                self._set_status(HardwareStatus(connected=False, armed=False, last_error=str(e)))
                logger.warning("Bağlantı başarısız (%s) — %.0fs sonra tekrar denenecek", e, wait_s)
                self._stop_event.wait(wait_s)
                continue

        # Döngüden çıkarken (stop istendi) bağlantıyı temizle.
        try:
            self._hw.disconnect()
        except Exception:
            pass
