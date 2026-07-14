"""
PhotonNet Hardware Abstraction Layer (HAL).

Katmanlar (aşağıdan yukarıya):
  transport.py            — ham bayt bağlantısı (seri port / TCP soket)
  hardware_interface.py   — TÜM sürücülerin uyduğu soyut sözleşme
  simulated_hardware.py   — bugün çalışan, gerçekçi sahte donanım (test/geliştirme)
  link_manager.py         — bağlan/yeniden-bağlan/arka-plan-dinle döngüsü
  time_tag_correlator.py  — gerçek BB84 sifting/QBER mantığı (RNG'siz, saf zaman-damgası eşleştirme)
  bridge_server.py        — Flask+SSE üzerinden PhotonNet tarayıcı arayüzüne köprü

Gerçek donanım eklemek için: hardware_interface.HardwareInterface'ten türeyen
yeni bir sınıf yazın. `serial_hardware.py` (SerialHardware) ve
`tcp_hardware.py` (TCPHardware) BUNUN BİR ÖRNEĞİ olarak zaten yazıldı —
ikisi de wire-protokol/çerçeveleme mantığını `binary_click_hardware.py`'den
PAYLAŞIR (bkz. o dosyanın başlığı — GERÇEK bir vendor spesifikasyonu
DEĞİL, makul bir referans varsayımdır; gerçek cihazınıza göre değiştirin).
LinkManager/TimeTagCorrelator/bridge_server'ın TEK SATIRI değişmez.
"""
from .binary_click_hardware import BinaryClickHardware
from .hardware_interface import HardwareError, HardwareInterface
from .link_manager import LinkManager
from .serial_hardware import SerialHardware
from .simulated_hardware import SimulatedAliceSource, SimulatedHardware
from .tcp_hardware import TCPHardware
from .time_tag_correlator import TimeTagCorrelator
from .types import (
    AcquisitionConfig,
    Basis,
    DetectorChannel,
    HardwareStatus,
    SiftingResult,
    TimestampedClick,
    TransmitEvent,
)

__all__ = [
    "BinaryClickHardware",
    "HardwareError",
    "HardwareInterface",
    "LinkManager",
    "SerialHardware",
    "SimulatedAliceSource",
    "SimulatedHardware",
    "TCPHardware",
    "TimeTagCorrelator",
    "AcquisitionConfig",
    "Basis",
    "DetectorChannel",
    "HardwareStatus",
    "SiftingResult",
    "TimestampedClick",
    "TransmitEvent",
]
