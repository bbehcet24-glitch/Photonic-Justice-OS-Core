"""
HardwareInterface — HER donanım sürücüsünün uyması gereken SÖZLEŞME.

Bu soyut sınıf KASITLI OLARAK küçük tutuldu: gerçek donanım entegrasyonlarında
en büyük hata, arayüzü belirli bir vendor'ın API'sine göre tasarlamaktır
(sonra başka bir cihaza geçince her şeyi yeniden yazarsınız). Burada
yalnızca HER foton-sayım donanımının (SPAD dizisi + TDC, ister seri
port, ister PCIe kart, ister ağ üzerinden) ortak olarak sağlayabileceği
4 temel yetenek soyutlanıyor: bağlan, kur (arm), oku, durum bildir.

Yeni bir gerçek cihaz eklemek için: bu sınıftan türetin, 4 metodu vendor'ın
gerçek SDK'sını/protokolünü kullanarak doldurun. LinkManager, TimeTagCorrelator
ve bridge_server'ın TEK SATIRI değişmez — hepsi bu arayüze karşı yazılmıştır.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .types import AcquisitionConfig, HardwareStatus, TimestampedClick


class HardwareError(Exception):
    """Donanım katmanından yükselen tüm hatalar için ortak taban sınıf —
    üst katmanlar (LinkManager, bridge_server) vendor'a özgü istisna
    tiplerini bilmek zorunda kalmadan tek bir except HardwareError ile
    hepsini yakalayabilir."""


class HardwareInterface(ABC):
    """Soyut taban sınıf — TÜM gerçek/simüle donanım sürücüleri bunu
    implemente eder. Metodlar KASITLI OLARAK senkron (blocking) tasarlandı;
    LinkManager bunları kendi arka plan thread'inde çalıştırıp asenkron
    hale getirir (bkz. link_manager.py) — böylece her sürücü yazarı
    asyncio ile uğraşmak zorunda kalmaz, yalnızca "connect/arm/read_clicks/
    status" mantığını doğru yazmaya odaklanır."""

    @abstractmethod
    def connect(self) -> None:
        """Fiziksel bağlantıyı kurar (seri port aç, TCP soket bağlan,
        vendor SDK init, vb.). Başarısızsa HardwareError fırlatır."""
        raise NotImplementedError

    @abstractmethod
    def disconnect(self) -> None:
        """Bağlantıyı güvenli şekilde kapatır. connect() hiç çağrılmamışsa
        veya zaten kapalıysa sessizce no-op olmalıdır (idempotent)."""
        raise NotImplementedError

    @abstractmethod
    def arm(self, config: AcquisitionConfig) -> None:
        """Donanımı verilen edinim parametreleriyle (kapı genişliği,
        eşleştirme penceresi vb.) bir sonraki read_clicks() çağrısına
        hazırlar. Gerçek donanımda bu genelde bir kayıt yazma/kalibrasyon
        işlemidir; simülasyonda yalnızca config'i saklamak yeterlidir."""
        raise NotImplementedError

    @abstractmethod
    def read_clicks(self, timeout_s: float) -> list[TimestampedClick]:
        """En fazla `timeout_s` saniye bekleyip, o ana kadar biriken TÜM
        ham dedektör click'lerini döndürür. Boş liste = zaman aşımı,
        hiçbir click gelmedi (hata DEĞİLDİR — düşük sayım hızında normaldir).
        Bu metod TEKRAR TEKRAR çağrılabilir olmalıdır (polling deseni);
        LinkManager bunu kendi döngüsünde sürekli çağırır."""
        raise NotImplementedError

    @abstractmethod
    def status(self) -> HardwareStatus:
        """Anlık sağlık/telemetri durumunu döndürür — bloklamamalı,
        önbelleklenmiş son bilinen durumu dönebilir."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Context manager desteği — `with SomeHardware(...) as hw:` kullanımını
    # mümkün kılar, connect/disconnect'i unutma riskini azaltır.
    # ------------------------------------------------------------------
    def __enter__(self) -> "HardwareInterface":
        self.connect()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.disconnect()
