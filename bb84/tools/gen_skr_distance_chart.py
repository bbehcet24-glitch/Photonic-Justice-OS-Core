"""gen_skr_distance_chart.py — reports/skr_distance_sweep.json → docs/skr_qber_distance.png
Kullanım: python3 bb84/tools/gen_skr_distance_chart.py  (önce: node bb84/skr_distance_sweep_test.js)"""
import json, sys, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "..", "reports", "skr_distance_sweep.json")))["table"]
for r in rows:
    r["plob"] = r["plobBps"]; r["physE"] = r["N1e10"]["qber"]; r["coreQber"] = r["coreMessageQber"]
km = [r["km"] for r in rows]
INK, INK2, GRID, SURF = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": GRID, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURF, "figure.facecolor": SURF})
fig, (a1, a2) = plt.subplots(2, 1, figsize=(8, 10.5), gridspec_kw={"height_ratios": [1.35, 1]})
def series(key):
    xs, ys = [], []
    for r in rows:
        v = r[key]["bps"]
        if v > 0: xs.append(r["km"]); ys.append(v)
    return xs, ys
for key, col, lab, off in [("N1e8", "#86b6ef", "N = 10⁸", (5, -4)), ("N1e10", "#2a78d6", "N = 10¹⁰ (vars.)", (5, -12)), ("N1e12", "#104281", "N = 10¹²", (5, 2))]:
    xs, ys = series(key); a1.plot(xs, ys, color=col, lw=2, solid_capstyle="round", label=lab + " darbe/blok, Y0 = 10⁻⁵")
    a1.annotate(lab, (xs[-1], ys[-1]), xytext=off, textcoords="offset points", fontsize=8.5, color=INK2)
xs, ys = series("N1e10_Y0_1e-6"); a1.plot(xs, ys, color="#eb6834", lw=2, label="N = 10¹⁰, Y0 = 10⁻⁶ (daha az karanlık sayım)")
a1.annotate("Y0 = 10⁻⁶", (xs[-1], ys[-1]), xytext=(5, -4), textcoords="offset points", fontsize=8.5, color=INK2)
a1.plot(km, [r["plob"] for r in rows], color=INK2, lw=1.5, ls=(0, (5, 3)), label="PLOB sınırı (tekrarlayıcısız kapasite)")
a1.annotate("PLOB sınırı", (180, next(r["plob"] for r in rows if r["km"] == 180)), xytext=(6, 8), textcoords="offset points", fontsize=8.5, color=INK2)
# literatür noktaları (farklı donanım)
for x, y, t, off in [(10.0, 64e6, "Grünenfelder 2023: 64 Mbps @10 km", (8, -14)), (102.4, 3.0e6, "Grünenfelder 2023: 3,0 Mbps @102 km", (8, -14)), (251.7, 4.9e3, "Boaron 2018:\n4,9 kbps @252 km", (-30, 10))]:
    a1.scatter([x], [y], s=46, marker="D", color=INK, zorder=5, edgecolors=SURF, linewidths=2)
    a1.annotate(t, (x, y), xytext=off, textcoords="offset points", fontsize=8, color=INK)
a1.text(1, 2.2, "◆ literatür: SNSPD (%60–85 verim, 0,1 Hz karanlık sayım), 2,5 GHz — PhotonNet'in varsayılan donanımı DEĞİL", fontsize=7.8, color=INK2)
a1.set_yscale("log"); a1.set_ylim(1, 3e9); a1.set_xlim(0, 270)
a1.set_xlabel("Fiber uzunluğu (km), 0,2 dB/km + 3 dB ekleme kaybı"); a1.set_ylabel("Gizli anahtar hızı (bit/s), 1 GHz")
a1.set_title("Gizli anahtar hızı — PhotonNet sonlu-anahtar decoy modeli (dedektör verimi %10, Y0 = 10⁻⁵, e_d = %2)", fontsize=10, color=INK, loc="left")
a1.grid(True, which="major", color=GRID, lw=0.8); a1.set_axisbelow(True)
a1.legend(loc="lower left", bbox_to_anchor=(0, 0.06), fontsize=8, frameon=False, labelcolor=INK2)
for s in ["top", "right"]: a1.spines[s].set_visible(False)
# QBER
phys = [(r["km"], 100 * r["physE"]) for r in rows if r["N1e10"]["bps"] > 0]
a2.plot([p[0] for p in phys], [p[1] for p in phys], color="#2a78d6", lw=2, label="fiziksel model (decoy/GYS, adaptif katman) — anahtar > 0")
a2.annotate("fiziksel model: düz, sonra uçurum", (60, 2.3), xytext=(-40, 34), textcoords="offset points", fontsize=8.5, color=INK2, arrowprops=dict(arrowstyle="-", color=INK2, lw=0.8))
a2.plot(km, [100 * r["physE"] for r in rows], color="#2a78d6", lw=1.2, ls=(0, (2, 2)), label="fiziksel model — anahtar = 0 bölgesi")
a2.plot(km, [100 * r["coreQber"] for r in rows], color="#eb6834", lw=2, label="çekirdek mesaj yolu: 0,012 + km/4000")
a2.annotate("çekirdek: doğrusal, 200 km'de bile %6,2", (175, 5.6), xytext=(-150, -26), textcoords="offset points", fontsize=8.5, color=INK2, arrowprops=dict(arrowstyle="-", color=INK2, lw=0.8))
a2.axhline(11, color=INK2, lw=1.2, ls=(0, (5, 3)))
a2.annotate("%11 bayrağı (BB84, ideal EC)", (2, 11), xytext=(0, 4), textcoords="offset points", fontsize=8.5, color=INK2)
a2.axvline(112, color=GRID, lw=1.5)
a2.annotate("anahtar = 0 (N=10¹⁰): 112 km →", (112, 20), xytext=(-168, 0), textcoords="offset points", fontsize=8.5, color=INK2)
a2.set_xlim(0, 210); a2.set_ylim(0, 50)
a2.legend(loc="upper left", bbox_to_anchor=(0, 0.93), fontsize=8, frameon=False, labelcolor=INK2)
a2.set_xlabel("Fiber uzunluğu (km)"); a2.set_ylabel("QBER (%)")
a2.set_title("QBER — iki model aynı mesafede farklı şey söylüyor", fontsize=10, color=INK, loc="left")
a2.grid(True, color=GRID, lw=0.8); a2.set_axisbelow(True)
for s in ["top", "right"]: a2.spines[s].set_visible(False)
fig.tight_layout(h_pad=2.5)
fig.savefig(os.path.join(HERE, "..", "docs", "skr_qber_distance.png"), dpi=160)
