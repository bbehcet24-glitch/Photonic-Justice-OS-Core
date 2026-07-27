#!/usr/bin/env node
"use strict";
// entanglement_hom_fidelity_test.js sonuçlarından statik, tek-dosya bir HTML
// rapor üretir (3 SVG grafik: mesafeye göre F, başarı-oranı/sadakat
// ödünleşimi, ve klasik HOM "dip" eğrisi).
const fs = require("fs");
const sim = require("./entanglement_hom_fidelity_sim.js");
const results = JSON.parse(fs.readFileSync("/tmp/entanglement_hom_fidelity_results.json", "utf8"));

const PAL = {
  surface: "#fcfcfb", textPrimary: "#0b0b0b", textSecondary: "#52514e",
  s1: "#2a78d6", // blue  — 2-düğüm doğrudan
  s2: "#1baf7a", // aqua  — 3-düğüm+takas
  s3: "#4a3aa7", // violet — HOM temiz kanal
  s4: "#eb6834", // orange — HOM gürültülü kanal
  critical: "#d03b3b", // eşik çizgisi (F=0.5)
  grid: "#e3e2dd",
};

// ── Grafik 1 verisi: mesafeye göre F (Test 1 + Test 3) ──────────────────
const t1 = results.test1_distance_sweep.map(r => ({ x: r.totalKm, y: r.F }));
const t3 = results.test3_swap_sweep.map(r => ({ x: r.totalKm, y: r.F }));

// ── Grafik 2 verisi: başarı-oranı vs sadakat (Test 2a) ───────────────────
const t2 = results.test2_window_sweep.map(r => ({ x: r.F, y: r.successHz }));

// ── Grafik 3 verisi: HOM dip eğrisi (temiz vs gürültülü kanal) ───────────
function homDipCurve(V, n = 81, range = 4) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const dt = -range + (2 * range * i) / (n - 1);
    const c = 1 - V * Math.exp(-(dt * dt));
    pts.push({ x: dt, y: c });
  }
  return pts;
}
const cleanArm = sim.coincidenceRates(0, 0, 1.0);
const Vclean = sim.homVisibility(cleanArm.trueRate, cleanArm.accidentalRate);
const noisyArm = sim.coincidenceRates(290, 290, 1.0);
const Vnoisy = sim.homVisibility(noisyArm.trueRate, noisyArm.accidentalRate);
const homClean = homDipCurve(Vclean);
const homNoisy = homDipCurve(Vnoisy);

// ── Basit SVG çizgi-grafik üretici (eksen, ızgara, çizgi, eşik) ──────────
function lineChart({ width = 720, height = 320, margin = { t: 28, r: 24, b: 44, l: 64 },
  series, xLabel, yLabel, xDomain, yDomain, thresholdY = null, thresholdLabel = "",
  xTickFmt = (v) => v.toFixed(0), yTickFmt = (v) => v.toFixed(2), title = "" }) {
  const w = width - margin.l - margin.r, h = height - margin.t - margin.b;
  const sx = (x) => margin.l + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * w;
  const sy = (y) => margin.t + h - ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * h;
  const nGridY = 5, nGridX = 6;
  let gridLines = "";
  for (let i = 0; i <= nGridY; i++) {
    const y = yDomain[0] + (i / nGridY) * (yDomain[1] - yDomain[0]);
    gridLines += `<line x1="${margin.l}" y1="${sy(y)}" x2="${margin.l + w}" y2="${sy(y)}" stroke="${PAL.grid}" stroke-width="1"/>`;
    gridLines += `<text x="${margin.l - 8}" y="${sy(y) + 4}" text-anchor="end" font-size="11" fill="${PAL.textSecondary}">${yTickFmt(y)}</text>`;
  }
  for (let i = 0; i <= nGridX; i++) {
    const x = xDomain[0] + (i / nGridX) * (xDomain[1] - xDomain[0]);
    gridLines += `<text x="${sx(x)}" y="${margin.t + h + 18}" text-anchor="middle" font-size="11" fill="${PAL.textSecondary}">${xTickFmt(x)}</text>`;
  }
  let paths = "";
  let legend = "";
  series.forEach((s, i) => {
    const d = s.data.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.showPoints) {
      s.data.forEach(p => { paths += `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${xLabel}=${xTickFmt(p.x)}, ${yLabel}=${yTickFmt(p.y)}</title></circle>`; });
    }
    legend += `<g transform="translate(${margin.l + i * 210}, ${height - 8})"><line x1="0" y1="0" x2="18" y2="0" stroke="${s.color}" stroke-width="3"/><text x="24" y="4" font-size="12" fill="${PAL.textPrimary}">${s.label}</text></g>`;
  });
  let thresholdSvg = "";
  if (thresholdY !== null) {
    thresholdSvg = `<line x1="${margin.l}" y1="${sy(thresholdY)}" x2="${margin.l + w}" y2="${sy(thresholdY)}" stroke="${PAL.critical}" stroke-width="1.5" stroke-dasharray="6,4"/>` +
      `<text x="${margin.l + w - 4}" y="${sy(thresholdY) - 6}" text-anchor="end" font-size="11" fill="${PAL.critical}">${thresholdLabel}</text>`;
  }
  return `<svg width="${width}" height="${height + 24}" viewBox="0 0 ${width} ${height + 24}" role="img" aria-label="${title}">
    <rect x="0" y="0" width="${width}" height="${height + 24}" fill="${PAL.surface}"/>
    <text x="${margin.l}" y="18" font-size="13" font-weight="600" fill="${PAL.textPrimary}">${title}</text>
    ${gridLines}
    <line x1="${margin.l}" y1="${margin.t}" x2="${margin.l}" y2="${margin.t + h}" stroke="${PAL.textSecondary}" stroke-width="1"/>
    <line x1="${margin.l}" y1="${margin.t + h}" x2="${margin.l + w}" y2="${margin.t + h}" stroke="${PAL.textSecondary}" stroke-width="1"/>
    ${thresholdSvg}
    ${paths}
    <text x="${margin.l + w / 2}" y="${height + 20}" text-anchor="middle" font-size="11" fill="${PAL.textSecondary}">${xLabel}</text>
    ${legend}
  </svg>`;
}

const chart1 = lineChart({
  title: "Bell-durumu sadakati (F) — toplam mesafeye göre (2-düğüm doğrudan vs 3-düğüm+takas)",
  xLabel: "toplam mesafe (km)", yLabel: "F",
  xDomain: [0, 1300], yDomain: [0, 1],
  series: [
    { data: t1, color: PAL.s1, label: "2-düğüm (doğrudan)" },
    { data: t3, color: PAL.s2, label: "3-düğüm (takas)" },
  ],
  thresholdY: 0.5, thresholdLabel: "F=0.5 dolanıklık eşiği",
});

const chart2 = lineChart({
  title: "Başarı-oranı vs Sadakat ödünleşimi (eşzamanlılık penceresi taranıyor, kol-başı=20km)",
  xLabel: "F (Bell sadakati)", yLabel: "başarı oranı (Hz)",
  xDomain: [0.88, 0.915], yDomain: [0, 600000],
  xTickFmt: (v) => v.toFixed(3), yTickFmt: (v) => (v / 1000).toFixed(0) + "k",
  series: [ { data: t2, color: PAL.s1, label: "başarı-oranı(Hz) vs F", showPoints: true } ],
});

const chart3 = lineChart({
  title: "Hong-Ou-Mandel girişim 'dip' eğrisi — temiz vs gürültülü kanal",
  xLabel: "göreli gecikme Δτ (τc birimi)", yLabel: "normalize çakışma",
  xDomain: [-4, 4], yDomain: [0, 1.05],
  xTickFmt: (v) => v.toFixed(1),
  series: [
    { data: homClean, color: PAL.s3, label: `temiz (0km, V=${Vclean.toFixed(3)})` },
    { data: homNoisy, color: PAL.s4, label: `gürültülü (290km/kol, V=${Vnoisy.toFixed(3)})` },
  ],
});

const html = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>Dolanıklık-Dağıtım Testi — HOM Girişimi + Bell Sadakati</title>
<style>
  body { font-family: -apple-system,Segoe UI,Roboto,sans-serif; background:${PAL.surface}; color:${PAL.textPrimary}; max-width:800px; margin:32px auto; padding:0 16px; }
  h1 { font-size:20px; } p.note { color:${PAL.textSecondary}; font-size:13px; line-height:1.5; }
  .chart-block { margin-bottom:32px; }
  table { border-collapse:collapse; font-size:12px; margin-top:8px; }
  th,td { border:1px solid ${PAL.grid}; padding:4px 8px; text-align:right; }
  th { background:#f5f4f1; }
</style></head>
<body>
<h1>2-3 Düğümlü Dolanıklık-Dağıtım Testi — İdeal Parametreler Kapalı</h1>
<p class="note">Kaynak g²(0)=${sim.SOURCE_G2_ZERO}, ayırt-edilemezlik=%${(sim.SOURCE_INDISTINGUISHABILITY*100).toFixed(1)} · dedektör verimi=%${(sim.DETECTOR_QUANTUM_EFFICIENCY*100).toFixed(1)}, karanlık-sayım=${sim.DETECTOR_DARK_RATE_HZ}Hz. Bu, PhotonNet2.jsx'in BB84 ana motorundan AYRI, dürüstçe etiketlenmiş bir dolanıklık-dağıtım test harness'idir (bkz. bb84/entanglement_hom_fidelity_sim.js başlığı).</p>
<div class="chart-block">${chart1}</div>
<div class="chart-block">${chart2}</div>
<div class="chart-block">${chart3}</div>
</body></html>`;

fs.writeFileSync("/root/work/photonnet/bb84/entanglement_report.html", html);
console.log("Yazıldı: bb84/entanglement_report.html");
console.log(`Vclean=${Vclean.toFixed(4)}  Vnoisy(290km/kol)=${Vnoisy.toFixed(4)}`);
