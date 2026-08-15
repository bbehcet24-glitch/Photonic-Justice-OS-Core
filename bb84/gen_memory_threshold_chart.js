#!/usr/bin/env node
"use strict";
/**
 * gen_memory_threshold_chart.js
 * memory_technology_threshold_test.js'in ürettiği JSON'dan tek-dosya,
 * etkileşimli (hover + tablo görünümü + koyu mod) bir HTML grafik üretir.
 *
 * RENK KARARI: T2 basamakları SIRALI bir büyüklüktür (1 ms < 10 ms < …),
 * kimlik değil. Bu yüzden kategorik palet değil, TEK HUE'lu SIRALI
 * (ordinal) mavi rampa kullanılır. Her iki mod da doğrulayıcıdan
 * geçirilmiştir (validate_palette.js --ordinal → ALL CHECKS PASS):
 *   açık: #86b6ef #5598e7 #2a78d6 #1c5cab #0d366b
 *   koyu: #cde2fb #9ec5f4 #6da7ec #2a78d6 #184f95
 *
 * Kullanım: node gen_memory_threshold_chart.js [girdi.json] [cikti.html]
 */
const fs = require("fs");

const RAMP_LIGHT = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_DARK  = ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#184f95"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function build(data) {
  const tiers = data.tiers;
  const n = tiers.length;
  const maxCritical = Math.max(...tiers.map(t => t.criticalKm ?? 0));
  const maxYield = Math.max(...tiers.flatMap(t => t.curve.map(c => c.meanYieldPct)));
  const maxKmPlot = 60; // eğrilerin tamamı bu aralıkta sıfırlanıyor

  // ── GRAFİK A: kritik eşik (yatay çubuk) + çalışma eşiği işareti ──
  const A = { w: 720, h: 56 * n + 62, l: 92, r: 78, t: 34, b: 28 };
  const aPlotW = A.w - A.l - A.r;
  const aScale = (km) => (km / (maxCritical * 1.08)) * aPlotW;
  let barsSvg = "";
  tiers.forEach((t, i) => {
    const y = A.t + i * 56;
    const bw = aScale(t.criticalKm ?? 0);
    const wx = aScale(t.workingKm ?? 0);
    barsSvg += `
    <g class="bar-row" data-idx="${i}" tabindex="0" role="listitem"
       aria-label="T2 ${esc(t.label)}: kritik eşik ${t.criticalKm} kilometre, çalışma eşiği ${t.workingKm} kilometre">
      <rect class="hit" x="${A.l}" y="${y}" width="${aPlotW}" height="44" fill="transparent"/>
      <text x="${A.l - 12}" y="${y + 27}" text-anchor="end" class="tick">${esc(t.label)}</text>
      <rect x="${A.l}" y="${y + 10}" width="${Math.max(bw, 2)}" height="24" rx="4" fill="var(--s${i + 1})"/>
      <rect x="${A.l}" y="${y + 10}" width="${Math.min(6, Math.max(bw, 2))}" height="24" fill="var(--s${i + 1})"/>
      <line x1="${A.l + wx}" y1="${y + 6}" x2="${A.l + wx}" y2="${y + 38}" stroke="var(--surface-1)" stroke-width="4"/>
      <line x1="${A.l + wx}" y1="${y + 6}" x2="${A.l + wx}" y2="${y + 38}" stroke="var(--text-secondary)" stroke-width="2"/>
      <text x="${A.l + bw + 10}" y="${y + 27}" class="val">${t.criticalKm} km</text>
    </g>`;
  });

  // ── GRAFİK B: verim eğrileri ──
  const B = { w: 720, h: 300, l: 56, r: 108, t: 26, b: 46 };
  const bW = B.w - B.l - B.r, bH = B.h - B.t - B.b;
  const bx = (km) => B.l + (km / maxKmPlot) * bW;
  const yTopScale = Math.ceil(maxYield / 10) * 10;
  const by = (v) => B.t + bH - (v / yTopScale) * bH;
  // Y ekseni TEMİZ sayılara yuvarlanır (10'un katları) — ham max'ı
  // 1.06 ile çarpıp 42.5% / 31.8% gibi okunmaz etiketler üretmek yerine.
  const yTop = Math.ceil(maxYield / 10) * 10;
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = yTop * (1 - i / 4);
    const y = B.t + (bH / 4) * i;
    grid += `<line x1="${B.l}" y1="${y}" x2="${B.l + bW}" y2="${y}" class="grid"/>
             <text x="${B.l - 10}" y="${y + 4}" text-anchor="end" class="tick">${v % 1 === 0 ? v : v.toFixed(1)}%</text>`;
  }
  for (let km = 0; km <= maxKmPlot; km += 10) {
    grid += `<text x="${bx(km)}" y="${B.t + bH + 20}" text-anchor="middle" class="tick">${km}</text>`;
  }
  let lines = "";
  tiers.forEach((t, i) => {
    const pts = t.curve.filter(c => c.km <= maxKmPlot);
    const d = pts.map((c, j) => `${j ? "L" : "M"} ${bx(c.km).toFixed(1)},${by(c.meanYieldPct).toFixed(1)}`).join(" ");
    lines += `<path d="${d}" fill="none" stroke="var(--s${i + 1})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" data-idx="${i}" class="curve"/>`;
    // Kritik eşik noktası: yüzeye halkalı uç noktası (2px ring)
    if (t.criticalKm != null && t.criticalKm <= maxKmPlot) {
      const p = pts.find(c => c.km === t.criticalKm);
      if (p) {
        lines += `<circle cx="${bx(p.km)}" cy="${by(p.meanYieldPct)}" r="5.5" fill="var(--s${i + 1})" stroke="var(--surface-1)" stroke-width="2"/>`;
      }
    }
  });

  const legend = tiers.map((t, i) =>
    `<span class="lg"><span class="key" style="background:var(--s${i + 1})"></span>T2 = ${esc(t.label)}</span>`).join("");

  const tableRows = tiers.map((t, i) => `
    <tr>
      <td><span class="key" style="background:var(--s${i + 1})"></span>${esc(t.label)}</td>
      <td>${esc(t.tech)}</td>
      <td>${t.criticalKm} km</td>
      <td>${t.workingKm} km</td>
      <td>%${t.at40km ? t.at40km.meanYieldPct : "—"}</td>
    </tr>`).join("");

  const budgetRows = (data.budgetLifted || []).map(b => `
    <tr><td>${esc(b.label)}</td><td>${b.attemptsPerLink.toLocaleString("tr-TR")}</td><td>${b.criticalKm} km</td></tr>`).join("");

  const curveJson = JSON.stringify(tiers.map(t => ({
    label: t.label,
    pts: t.curve.filter(c => c.km <= maxKmPlot).map(c => [c.km, c.meanYieldPct, c.nonZeroSeeds, c.totalSeeds]),
  })));

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Bellek teknolojisi ↔ kritik mesafe eşiği</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --surface-2: #f5f4f1;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #78766f;
    --grid: #e3e2dd;
    --s1: ${RAMP_LIGHT[0]}; --s2: ${RAMP_LIGHT[1]}; --s3: ${RAMP_LIGHT[2]}; --s4: ${RAMP_LIGHT[3]}; --s5: ${RAMP_LIGHT[4]};
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --surface-2: #242422;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #96958c;
      --grid: #383835;
      --s1: ${RAMP_DARK[0]}; --s2: ${RAMP_DARK[1]}; --s3: ${RAMP_DARK[2]}; --s4: ${RAMP_DARK[3]}; --s5: ${RAMP_DARK[4]};
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #242422;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #96958c;
    --grid: #383835;
    --s1: ${RAMP_DARK[0]}; --s2: ${RAMP_DARK[1]}; --s3: ${RAMP_DARK[2]}; --s4: ${RAMP_DARK[3]}; --s5: ${RAMP_DARK[4]};
  }
  body { margin:0; background:var(--surface-1); }
  .viz-root { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--surface-1); color:var(--text-primary); max-width:860px; margin:0 auto; padding:28px 20px 56px; }
  h1 { font-size:21px; line-height:1.3; margin:0 0 6px; font-weight:650; }
  h2 { font-size:15px; margin:34px 0 4px; font-weight:600; }
  p.sub { color:var(--text-secondary); font-size:13.5px; line-height:1.6; margin:0 0 4px; }
  p.note { color:var(--text-muted); font-size:12px; line-height:1.6; margin:8px 0 0; }
  .kpi { display:flex; gap:10px; flex-wrap:wrap; margin:18px 0 6px; }
  .tile { background:var(--surface-2); border-radius:9px; padding:11px 15px; min-width:104px; }
  .tile .l { font-size:11px; color:var(--text-secondary); display:flex; align-items:center; gap:6px; }
  .tile .v { font-size:21px; font-weight:680; margin-top:3px; letter-spacing:-0.01em; }
  .key { display:inline-block; width:10px; height:10px; border-radius:3px; vertical-align:middle; margin-right:5px; }
  .lg { font-size:12px; color:var(--text-secondary); margin-right:14px; display:inline-flex; align-items:center; }
  .legend { margin:6px 0 2px; }
  svg { display:block; max-width:100%; height:auto; }
  .tick { font-size:11px; fill:var(--text-secondary); }
  .val { font-size:12px; fill:var(--text-primary); font-weight:600; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .bar-row .hit { cursor:pointer; }
  .bar-row:hover .hit, .bar-row:focus .hit { fill:var(--surface-2); }
  .bar-row:focus { outline:none; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; margin-top:10px; }
  th,td { border:1px solid var(--grid); padding:6px 10px; text-align:left; }
  th { background:var(--surface-2); font-weight:600; }
  .tip { position:fixed; pointer-events:none; background:var(--surface-2); color:var(--text-primary);
    border:1px solid var(--grid); border-radius:7px; padding:7px 10px; font-size:12px; line-height:1.5;
    opacity:0; transition:opacity .1s; z-index:9; box-shadow:0 2px 10px rgba(0,0,0,.13); }
  details { margin-top:14px; } summary { cursor:pointer; font-size:13px; color:var(--text-secondary); }
</style></head>
<body><div class="viz-root">

<h1>Bellek teknolojisi ↔ kritik mesafe eşiği</h1>
<p class="sub">Kuantum belleğin tutarlılık süresi (T₂) uzadıkça, dolanıklık takasının "sıfırdan kurtulduğu" düğümler-arası mesafe sınırı nereye taşınıyor? Her nokta ${data.method.seeds} tohumla, DEJMPS arıtma ve akıllı bellek zamanlayıcısıyla ölçülmüştür.</p>

<div class="kpi">
${tiers.map((t, i) => `  <div class="tile"><div class="l"><span class="key" style="background:var(--s${i + 1})"></span>T₂ = ${esc(t.label)}</div><div class="v">${t.criticalKm} km</div></div>`).join("\n")}
</div>

<h2>1) Kritik eşik — bellek basamağı başına ulaşılabilen en uzak mesafe</h2>
<p class="sub">Çubuk: <b>kritik eşik</b> (tohumların en az yarısı ≥1 nihai çift üretiyor). Dikey çizgi: <b>çalışma eşiği</b> (ortalama verim ≥%0,5 — yani "ara sıra bir çift" değil, işe yarar hız).</p>
<svg viewBox="0 0 ${A.w} ${A.h}" role="list" aria-label="Bellek basamağı başına kritik mesafe eşiği">
  <rect width="${A.w}" height="${A.h}" fill="var(--surface-1)"/>
  ${barsSvg}
  <text x="${A.l}" y="${A.h - 8}" class="tick">Düğümler arası mesafe (km) →</text>
</svg>

<h2>2) Verim eğrileri — eşiğin nasıl çöktüğü</h2>
<div class="legend">${legend}</div>
<svg id="cv" viewBox="0 0 ${B.w} ${B.h}" aria-label="Bellek basamağı başına verim eğrileri">
  <rect width="${B.w}" height="${B.h}" fill="var(--surface-1)"/>
  ${grid}
  ${lines}
  <line id="cross" x1="0" y1="${B.t}" x2="0" y2="${B.t + bH}" stroke="var(--text-muted)" stroke-width="1" opacity="0"/>
  <rect id="cvhit" x="${B.l}" y="${B.t}" width="${bW}" height="${bH}" fill="transparent"/>
  <text x="${B.l + bW / 2}" y="${B.h - 8}" text-anchor="middle" class="tick">Düğümler arası mesafe (km)</text>
</svg>
<p class="note">İçi dolu nokta = o basamağın kritik eşiği. Eğriler kısa mesafede üst üste biner (bellek orada darboğaz değildir) ve yalnızca uzun mesafede ayrışır — bu, "bellek ne zaman önemli olmaya başlar" sorusunun cevabıdır.</p>

<h2>3) Doyma neyin sınırı? (dürüstlük denetimi)</h2>
<p class="sub">T₂ = 1 s ile 10 s arasında kritik eşik neredeyse aynı çıkıyor. Bu, o noktadan sonra <b>belleğin artık darboğaz olmadığı</b> anlamına gelir. Sınırı koyan şeyin foton deneme bütçesi olduğunu, bütçeyi 10 katına çıkarıp eşiğin ilerlediğini göstererek doğruladık:</p>
<table><thead><tr><th>T₂</th><th>Deneme / bağ</th><th>Kritik eşik</th></tr></thead><tbody>${budgetRows}</tbody></table>

<details open>
<summary>Tablo görünümü (tüm değerler)</summary>
<table>
<thead><tr><th>T₂</th><th>Temsil ettiği mertebe</th><th>Kritik eşik</th><th>Çalışma eşiği</th><th>40 km'de ort. verim</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</details>

<p class="note"><b>Yöntem ve dürüstlük notu:</b> ${esc(data.method.honestyNote)} Kritik eşik kuralı: ${esc(data.method.criticalRule)}. Çalışma eşiği kuralı: ${esc(data.method.workingRule)}. Fiber sabitleri: ${data.constants.attenuationDbPerKm} dB/km sönümleme, n=${data.constants.refractiveIndex}, ışık hızı ${data.constants.velocityKmPerMs} km/ms. Hedef nihai sadakat F ≥ ${data.constants.targetFinalFidelity}, bellek ${data.constants.memorySlots} yuva/düğüm, protokol ${esc(data.constants.protocol)}. Eşiğin yakınında ölçüm doğal olarak gürültülüdür; bu yüzden tek tohum değil çoklu tohum + çoğunluk kuralı kullanılmıştır ve iki farklı eşik tanımı ayrı ayrı raporlanır.</p>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var CURVES = ${curveJson};
  var B = { l:${B.l}, t:${B.t}, w:${bW}, h:${bH}, maxKm:${maxKmPlot}, maxY:${(Math.ceil(maxYield / 10) * 10).toFixed(6)} };
  var tip = document.getElementById('tip');
  function show(html, ev){ tip.innerHTML = html; tip.style.opacity = 1;
    var x = ev.clientX + 14, y = ev.clientY + 14;
    var r = tip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
  function hide(){ tip.style.opacity = 0; }

  document.querySelectorAll('.bar-row').forEach(function(g){
    g.addEventListener('mousemove', function(ev){
      show(g.getAttribute('aria-label').replace(/: /, '<br><b>').replace(/, /, '</b><br>') + '</b>', ev);
    });
    g.addEventListener('mouseleave', hide);
  });

  var svg = document.getElementById('cv'), hit = document.getElementById('cvhit'), cross = document.getElementById('cross');
  hit.addEventListener('mousemove', function(ev){
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    var km = Math.round(((loc.x - B.l) / B.w) * B.maxKm / 2) * 2;
    if (km < 0) km = 0; if (km > B.maxKm) km = B.maxKm;
    var xPix = B.l + (km / B.maxKm) * B.w;
    cross.setAttribute('x1', xPix); cross.setAttribute('x2', xPix); cross.setAttribute('opacity', 1);
    var rows = CURVES.map(function(c, i){
      var p = c.pts.find(function(q){ return q[0] === km; });
      if (!p) return '';
      return '<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:var(--s' + (i+1) + ')"></span>'
        + c.label + ': <b>%' + p[1].toFixed(2) + '</b> <span style="opacity:.7">(' + p[2] + '/' + p[3] + ' tohum üretti)</span></div>';
    }).join('');
    show('<b>' + km + ' km</b>' + rows, ev);
  });
  hit.addEventListener('mouseleave', function(){ hide(); cross.setAttribute('opacity', 0); });
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || "/tmp/memory_technology_threshold.json";
  const outPath = process.argv[3] || "/tmp/memory_threshold_chart.html";
  const data = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  fs.writeFileSync(outPath, build(data));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
