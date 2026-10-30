"""
clock_tracker.py — Alice ile Bob saatleri arasındaki ofset ve kaymayı edinim BOYUNCA izleyen dinamik düzeltme.

NEDEN: TimeTagCorrelator.estimate_timing() edinim başına TEK bir ofset + doğrusal kayma kestirir. Gerçek bir
osilatörde kayma sabit değildir (sıcaklıkla gezinir), saat ani sıçrayabilir ve bir PLL tam bir periyot
"kayabilir" (cycle slip). Doğrusal modelin kalıntısı eşleşme penceresini (±500 ps) aşınca click'ler yanlış
darbeye eşlenir: eşleşme düşer, QBER yükselir — ve bu, dinleme gibi görünür.

YÖNTEM (bb84/predictive_jitter_alignment.js'teki JitterPredictor'ın Python karşılığı, iki girdiyle):
  Durum x = [g, d]: Bob saat ekseninde ofset g(t) = t_Bob − t_Alice (ps) ve kayma d = dg/dt (boyutsuz).
  Süreç modeli: d rastgele yürüyüş (spektral yoğunluk q, 1/ps) — sabit-hızlı Kalman.
  Ölçüm kaynakları:
    • "sync": donanımın ayrı bir senkron kanalı (ör. ayrı dalga boyunda çerçeve işaretli darbe) verirse,
      (t_Bob, t_Alice) çiftleri doğrudan g ölçümüdür. Tamsayı periyot belirsizliği YOKTUR, bit açıklanmaz.
    • "data": senkron kanalı yoksa veri click'lerinin kendisi. Her parçada (varsayılan 1000 click) click'ler
      ÖNGÖRÜLEN ofsetle Alice darbe ızgarasına katlanır; kalıntının tepe çevresi ortalaması periyot-altı ölçümdür.
      Bu ölçüm yalnız ±P/2 içinde anlamlıdır: periyodun tam katları (cycle slip) zamanlamadan GÖRÜLEMEZ.
      Bu yüzden her parçada küçük bir doğrulama örneğinin bitleri karşılaştırılır (açıklanır, anahtardan
      çıkarılır). Hata oranı yüksekse ±slip_search_periods içinde tamsayı arama yapılır.
  Sıçrama: yenilik (innovation) kapı dışındaysa normal güncelleme yapılmaz; ofset ölçüme yeniden kurulur ve
  olay raporlanır. Doğrulama ölçütü sağlanamayan parça anahtara GİRMEZ; art arda `max_bad_segments` kötü
  parça → LOST (fail-closed): kalan veriden anahtar üretilmez.

KAPSAM / DÜRÜSTLÜK:
  • Yalnız öngörülebilir yapıyı (ofset, kayma, yavaş gezinme) izler; detektör jitter'ı gibi beyaz gürültüyü
    kaldıramaz (bkz. bb84/predictive_jitter_test.js'teki aynı sınır).
  • Gerçek bir zaman etiketleyiciyle denenmedi; testler SimulatedHardware click'lerine bilinen bir saat
    bozulması uygular (hal/test_clock_tracker.py).
  • Alice olaylarının sabit periyotlu olduğunu varsayar (estimate_timing ile aynı varsayım).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .types import CHANNEL_DECODE, SiftingResult, TimestampedClick, TransmitEvent

QBER_EAVESDROP_THRESHOLD = 0.11


class ClockKalman:
    """Sabit-hızlı Kalman filtresi: durum [g, d] (ps, boyutsuz), zaman ekseni Bob saati (ps)."""

    def __init__(self, t_ps: float, g_ps: float, d: float, var_g: float, var_d: float, q: float):
        self.t = float(t_ps)
        self.g = float(g_ps)
        self.d = float(d)
        self.P = [[float(var_g), 0.0], [0.0, float(var_d)]]
        self.q = float(q)

    def predict(self, t_ps: float) -> None:
        dt = float(t_ps) - self.t
        if dt <= 0:
            return   # yalnız ileri yönde öngörü
        self.g += self.d * dt
        p00, p01, p10, p11 = self.P[0][0], self.P[0][1], self.P[1][0], self.P[1][1]
        q = self.q
        # P ← F P Fᵀ + Q,  F = [[1, dt], [0, 1]],  Q = q·[[dt³/3, dt²/2], [dt²/2, dt]]
        n00 = p00 + dt * (p10 + p01) + dt * dt * p11 + q * dt ** 3 / 3
        n01 = p01 + dt * p11 + q * dt * dt / 2
        n11 = p11 + q * dt
        self.P = [[n00, n01], [n01, n11]]
        self.t = float(t_ps)

    def innovation(self, z: float, r: float) -> tuple[float, float]:
        return z - self.g, self.P[0][0] + r

    def update(self, z: float, r: float) -> None:
        nu, s = self.innovation(z, r)
        k0, k1 = self.P[0][0] / s, self.P[1][0] / s
        self.g += k0 * nu
        self.d += k1 * nu
        p00, p01, p11 = self.P[0][0], self.P[0][1], self.P[1][1]
        self.P = [[(1 - k0) * p00, (1 - k0) * p01], [(1 - k0) * p01, p11 - k1 * p01]]

    def reset_offset(self, g_ps: float, var_g: float) -> None:
        """Sıçrama sonrası: ofseti ölçüme kur, kaymayı koru, ofset belirsizliğini büyüt."""
        self.g = float(g_ps)
        self.P = [[float(var_g), 0.0], [0.0, self.P[1][1]]]

    def offset_at(self, t_ps: float) -> float:
        return self.g + self.d * (float(t_ps) - self.t)


@dataclass
class TrackingReport:
    found: bool
    mode: str                                   # "sync" | "data"
    lost: bool = False
    reason: str = ""
    segments: int = 0
    good_segments: int = 0
    discarded_segments: int = 0
    jumps: list = field(default_factory=list)   # (t_Bob_ps, ölçülen sıçrama ps)
    slips: list = field(default_factory=list)   # (t_Bob_ps, düzeltilen periyot sayısı)
    disclosed_clicks: int = 0                   # bitleri açıklanan click sayısı (ilk kilit + doğrulama + slip araması)
    trajectory: list = field(default_factory=list)  # (t_Bob_ps, g_ps, d, σ_g_ps) — parça başına, teşhis için
    # PE kipi (pe_seed verildiğinde): zamanlama doğrulaması YALNIZ parametre kestirimi test click'leriyle yapılır
    pe_mode: bool = False
    pe_key_pairs: list = field(default_factory=list)    # (click, alice_bit, bob_bit) — anahtar çiftleri
    pe_test_pairs: list = field(default_factory=list)   # (click, alice_bit, bob_bit) — kabul edilen parçalardaki test çiftleri
    unexplained_discard_tests: int = 0          # cycle slip ile AÇIKLANAMAYAN atılmış pencerelerdeki test karşılaştırmaları
    slip_discard_tests: int = 0                 # slip düzeltmesiyle atılan pencerelerdeki test karşılaştırmaları


def _wrap(x: float, period: int) -> float:
    return ((x + period / 2) % period) - period / 2


def correlate_tracked(
    correlator,
    alice_events: list[TransmitEvent],
    bob_clicks: list[TimestampedClick],
    *,
    sync=None,
    sync_sigma_ps: float = 30.0,
    nominal_offset_ps: int = 0,
    search_ps: int = 2_000_000,
    seg_clicks: int = 1000,
    acq_clicks: int = 12_000,
    verify_fraction: float = 0.05,
    verify_min: int = 24,
    slip_search_periods: int = 8,
    slip_sample: int = 400,
    max_error_rate: float = 0.35,
    min_separation: float = 0.15,
    gate_sigma: float = 6.0,
    q: float = 1e-19,
    max_bad_segments: int = 3,
    max_sync_gap_ps: float | None = None,
    pe_seed: bytes | None = None,
    pe_fraction: float | None = None,
) -> tuple[TrackingReport, SiftingResult | None]:
    """Dinamik saat izlemeli korelasyon. Dönüş (TrackingReport, SiftingResult | None); kilit kurulamazsa
    SiftingResult None'dır (fail-closed). `sync`: [(t_Bob_ps, t_Alice_ps), ...] — verilirse "sync" kipi.

    `pe_seed` verilirse (PE kipi) tıklamaların `pe_fraction`'ı (varsayılan çekirdeğin testFraction'ı) parametre
    kestirimi test kümesidir (hal/pe_sampling.py). İlk kilit, parça doğrulaması ve slip araması YALNIZ bu
    tıklamaları kullanır; başka bit açıklanmaz. Sonuçta test çiftleri anahtardan ayrılır ve
    TrackingReport.pe_key_pairs / pe_test_pairs ile çekirdeğe (bb84/hal_pe_bridge.js) aktarılır."""
    window = correlator.coincidence_window_ps
    mode = "sync" if sync else "data"
    rep = TrackingReport(found=False, mode=mode)
    if len(alice_events) < 2 or len(bob_clicks) < 30:
        rep.reason = "yetersiz veri"
        return rep, None
    t0 = alice_events[0].timestamp_ps
    P = alice_events[1].timestamp_ps - t0
    n_a = len(alice_events)
    if P <= 0 or alice_events[-1].timestamp_ps - t0 != P * (n_a - 1):
        rep.reason = "Alice olayları sabit periyotlu değil"
        return rep, None
    times = [c.timestamp_ps for c in bob_clicks]
    n_b = len(times)
    disclosed: set[int] = set()
    pe_mask = None
    if pe_seed is not None:
        from .pe_sampling import PE_TEST_FRACTION, test_mask
        pe_mask = test_mask(pe_seed, n_b, PE_TEST_FRACTION if pe_fraction is None else pe_fraction)
        disclosed.update(i for i in range(n_b) if pe_mask[i])   # protokol gereği açıklanan test click'leri
        rep.pe_mode = True

    def alice_index(t_bob: float, g: float) -> tuple[int, float]:
        x = (t_bob - g - t0) / P
        i = int(round(x))
        return i, (x - i) * P

    def compare(idxs, g_of) -> tuple[int, int]:
        """idxs click'lerinin bitlerini (açıklanmış sayılır) eşlenen Alice bitleriyle karşılaştır."""
        n = e = 0
        for ci in idxs:
            i, dt = alice_index(times[ci], g_of(times[ci]))
            if 0 <= i < n_a and abs(dt) <= window:
                b_basis, b_bit = CHANNEL_DECODE[bob_clicks[ci].channel]
                ev = alice_events[i]
                if b_basis == ev.basis:
                    n += 1
                    e += b_bit != ev.bit
        return n, e

    # ── İlk kilit ──────────────────────────────────────────────────────────
    if mode == "sync":
        sync = sorted(sync)
        tb, ta = sync[0]
        kf = ClockKalman(tb, tb - ta, 0.0, sync_sigma_ps ** 2, (50e-6) ** 2, q)
        si = 1
        if max_sync_gap_ps is None:
            gaps = [sync[k + 1][0] - sync[k][0] for k in range(len(sync) - 1)]
            max_sync_gap_ps = 5 * (sorted(gaps)[len(gaps) // 2] if gaps else 1e9)
        start = 0
        while start < n_b and times[start] < tb:   # ilk senkron darbesinden önceki click'ler kullanılmaz
            start += 1
    else:
        acq_sample = [i for i in range(min(acq_clicks, n_b)) if pe_mask[i]] if pe_mask else None
        est = correlator.estimate_timing(alice_events, bob_clicks[:acq_clicks], nominal_offset_ps=nominal_offset_ps,
                                         search_ps=search_ps, sample_clicks=acq_sample)
        disclosed.update(est.disclosed_clicks)
        if not est.found:
            rep.reason = f"ilk kilit kurulamadı: {est.reason}"
            rep.disclosed_clicks = len(disclosed)
            return rep, None
        # estimate_timing modeli: t_B = t_A + ofset + kayma·(t_A − t0)  →  Bob ekseninde g(t_B) ve dg/dt_B
        tb0 = times[0]   # filtre yalnız ileri yönde çalışır: ilk click'te başlat
        g0 = (est.offset_ps + est.drift * (tb0 - t0)) / (1 + est.drift)
        kf = ClockKalman(tb0, g0, est.drift / (1 + est.drift), 25.0 ** 2, (0.2e-6) ** 2, q)
        start = 0
        si = 0

    # ── Parça parça izleme ─────────────────────────────────────────────────
    # Veri kipinde parçalar "beklemede" tutulur ve ancak bir sonraki doğrulama penceresi (en az verify_min
    # karşılaştırma) geçince anahtara alınır. Doğrulama slip gösterirse bekleyen parçaların HEPSİ ve en son
    # kabul edilen parça atılır: slip'in başladığı an bir parça sınırına denk gelmeyebilir.
    committed: dict[int, list] = {}        # parça no → [(alice_idx, |dt|, click_idx)]
    last_committed: list[int] = []
    pending: list[tuple[int, list]] = []
    pend_n = pend_e = 0
    bad_run = 0

    def matches_for(seg):
        out = []
        for i in seg:
            ai, dt = alice_index(times[i], kf.offset_at(times[i]))
            if 0 <= ai < n_a and abs(dt) <= window:
                out.append((ai, abs(dt), i))
        return out

    def commit_pending():
        nonlocal pending, pend_n, pend_e
        for sid, m in pending:
            committed[sid] = m
            last_committed.append(sid)
            rep.good_segments += 1
        pending, pend_n, pend_e = [], 0, 0

    def drop_pending(retract_last: bool, explained: bool):
        nonlocal pending, pend_n, pend_e
        if explained:
            rep.slip_discard_tests += pend_n
        else:
            rep.unexplained_discard_tests += pend_n
        rep.discarded_segments += len(pending)
        if retract_last and last_committed:
            sid = last_committed.pop()
            if committed.pop(sid, None) is not None:
                rep.good_segments -= 1
                rep.discarded_segments += 1
        pending, pend_n, pend_e = [], 0, 0

    # Senkron kipinde her click, kendisinden ÖNCEKİ son senkron ölçümünden sonraki filtre durumuyla eşlenir
    # (parça ortasındaki tek bir durumla değil). Bir sıçramanın tam anı iki senkron darbesi arasında bilinmez:
    # o aralıktaki click'ler anahtara alınmaz.
    sync_states: list[tuple[float, float, float]] = []   # (t, g, d) — her senkron güncellemesinden sonra
    blackout: list[tuple[float, float]] = []

    def sync_matches(seg):
        import bisect
        ts = [st[0] for st in sync_states]
        out = []
        for i in seg:
            t = times[i]
            if any(lo < t <= hi for lo, hi in blackout):
                continue
            k = bisect.bisect_right(ts, t) - 1
            if k < 0:
                continue
            tk, gk, dk = sync_states[k]
            ai, dt = alice_index(t, gk + dk * (t - tk))
            if 0 <= ai < n_a and abs(dt) <= window:
                out.append((ai, abs(dt), i))
        return out

    if mode == "sync":
        sync_states.append((kf.t, kf.g, kf.d))

    seg_no = 0
    for a_ in range(start, n_b, seg_clicks):
        b_ = min(a_ + seg_clicks, n_b)
        if b_ - a_ < 50:
            break
        seg_no += 1
        rep.segments += 1
        seg = range(a_, b_)
        t_mid = times[(a_ + b_) // 2]
        why = ""
        measured = True

        if mode == "sync":
            while si < len(sync) and sync[si][0] <= times[b_ - 1]:
                tb, ta = sync[si]
                kf.predict(tb)
                nu, s = kf.innovation(tb - ta, sync_sigma_ps ** 2)
                if abs(nu) > gate_sigma * math.sqrt(s) and abs(nu) > window / 2:
                    kf.reset_offset(tb - ta, sync_sigma_ps ** 2)
                    rep.jumps.append((tb, nu))
                    blackout.append((sync_states[-1][0], tb))
                else:
                    kf.update(tb - ta, sync_sigma_ps ** 2)
                sync_states.append((kf.t, kf.g, kf.d))
                si += 1
            if times[b_ - 1] - sync[si - 1][0] > max_sync_gap_ps:
                measured, why = False, "senkron ölçümü yok (boşluk)"
        else:
            kf.predict(t_mid)
            g_pred, d_pred = kf.g, kf.d
            # periyot-altı faz ölçümü: öngörülen ofsetle katla, tepe çevresinin ortalaması
            res = [_wrap(times[i] - (g_pred + d_pred * (times[i] - t_mid)) - t0, P) for i in seg]
            nb = max(8, P // 250)
            hist = [0] * nb
            for r in res:
                hist[int((r + P / 2) * nb // P) % nb] += 1
            pk = max(range(nb), key=lambda k: hist[k] + hist[(k - 1) % nb] + hist[(k + 1) % nb])
            c = (pk + 0.5) * P / nb - P / 2
            for _ in range(2):
                near = [r for r in res if abs(_wrap(r - c, P)) <= window]
                if not near:
                    break
                c = c + sum(_wrap(r - c, P) for r in near) / len(near)
            near = [r for r in res if abs(_wrap(r - c, P)) <= window]
            if len(near) < 0.3 * len(res) or len(near) < 30:
                measured, why = False, f"faz tepesi zayıf ({len(near)}/{len(res)} click)"
            else:
                var = sum(_wrap(r - c, P) ** 2 for r in near) / len(near)
                r_meas = max(var / len(near), 1.0)
                z = g_pred + c
                nu, s = kf.innovation(z, r_meas)
                if abs(nu) > gate_sigma * math.sqrt(s) and abs(nu) > window / 2:
                    kf.reset_offset(z, r_meas)
                    rep.jumps.append((t_mid, nu))
                else:
                    kf.update(z, r_meas)

        rep.trajectory.append((t_mid, kf.g, kf.d, math.sqrt(max(kf.P[0][0], 0.0))))
        if not measured:
            rep.discarded_segments += 1
            bad_run += 1
            if bad_run >= max_bad_segments:
                rep.lost = True
                rep.reason = f"kilit kaybedildi (art arda {bad_run} kötü parça; son: {why}) — kalan veriden anahtar üretilmedi"
                break
            continue
        bad_run = 0

        if mode == "sync":   # senkron kanalı tamsayı belirsizliği bırakmaz: doğrulama gerekmez, bit açıklanmaz
            pending.append((seg_no, sync_matches(seg)))
            commit_pending()
            continue

        # doğrulama: periyodun tam katı kayması zamanlamadan görülemez → küçük bir bit örneği (açıklanır)
        if pe_mask:
            vids = [i for i in seg if pe_mask[i]]   # PE test click'leri — zaten açıklanıyor, ek bedel yok
        else:
            k = max(1, round((b_ - a_) * verify_fraction))
            step = max(1, (b_ - a_) // k)
            vids = [i for i in range(a_, b_, step) if i not in disclosed][:k]
            disclosed.update(vids)
        n, e = compare(vids, kf.offset_at)
        pending.append((seg_no, matches_for(seg)))
        pend_n += n
        pend_e += e
        if pend_n < verify_min:
            continue
        if pend_e / pend_n <= max_error_rate:
            commit_pending()
            continue
        # cycle slip şüphesi: son parçada ±slip_search_periods tamsayı arama
        if pe_mask:
            sids = [i for i in seg if pe_mask[i]]
        else:
            step2 = max(1, (b_ - a_) // slip_sample)
            sids = [i for i in range(a_, b_, step2)][:slip_sample]
            disclosed.update(sids)
        cand = []
        for m in range(-slip_search_periods, slip_search_periods + 1):
            nn, ee = compare(sids, lambda t, m=m: kf.offset_at(t) + m * P)
            if nn >= 20:
                cand.append((ee / nn, m))
        cand.sort()
        clear = cand and cand[0][0] <= max_error_rate and (len(cand) < 2 or cand[1][0] - cand[0][0] >= min_separation)
        if clear and cand[0][1] != 0:
            kf.g += cand[0][1] * P
            rep.slips.append((t_mid, cand[0][1]))
            drop_pending(retract_last=True, explained=True)   # bekleyenler ve son kabul edilen parça karışık hizada olabilir
        elif clear:
            commit_pending()                   # m = 0: istatistiksel dalgalanma (ör. dinleme altında), slip yok
        else:
            drop_pending(retract_last=True, explained=False)
            bad_run += 1
            if bad_run >= max_bad_segments:
                rep.lost = True
                rep.reason = (f"kilit kaybedildi (doğrulama hata oranı %{pend_e / max(pend_n, 1) * 100:.0f}, "
                              "tamsayı aramada belirgin aday yok) — kalan veriden anahtar üretilmedi")
                break

    if pending and not rep.lost:
        if pend_n >= max(8, verify_min // 3) and pend_e / pend_n <= max_error_rate:
            commit_pending()
        else:
            drop_pending(retract_last=False, explained=False)   # son parçalar doğrulanamadı: anahtara girmez

    rep.disclosed_clicks = len(disclosed)
    if not committed:
        rep.reason = rep.reason or "doğrulanmış parça yok"
        return rep, None
    rep.found = True
    best_for_alice: dict[int, tuple[float, int]] = {}
    for m in committed.values():
        for ai, adt, ci in m:
            prev = best_for_alice.get(ai)
            if prev is None or adt < prev[0]:
                best_for_alice[ai] = (adt, ci)

    # ── Anahtar ────────────────────────────────────────────────────────────
    alice_bits: list[int] = []
    bob_bits: list[int] = []
    matched = detected = disclosed_pairs = errors = 0
    used_clicks = set()
    for ai in sorted(best_for_alice):
        ci = best_for_alice[ai][1]
        if ci in used_clicks:
            continue
        used_clicks.add(ci)
        detected += 1
        b_basis, b_bit = CHANNEL_DECODE[bob_clicks[ci].channel]
        ev = alice_events[ai]
        if b_basis != ev.basis:
            continue
        matched += 1
        if ci in disclosed:
            disclosed_pairs += 1
            if pe_mask:
                rep.pe_test_pairs.append((ci, ev.bit, b_bit))
            continue
        if pe_mask:
            rep.pe_key_pairs.append((ci, ev.bit, b_bit))
        alice_bits.append(ev.bit)
        bob_bits.append(b_bit)
        errors += ev.bit != b_bit
    qber = errors / len(alice_bits) if alice_bits else 0.0
    return rep, SiftingResult(
        sifted_key_bits=alice_bits,
        bob_key_bits=bob_bits,
        qber=qber,
        eavesdrop_detected=qber > QBER_EAVESDROP_THRESHOLD,
        lost_count=n_a - detected,
        dark_click_count=n_b - len(used_clicks),
        match_rate=(matched / detected) if detected else 0.0,
        detected_count=len(alice_bits),
        disclosed_count=disclosed_pairs,
    )
