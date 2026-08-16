#!/usr/bin/env node
"use strict";
/**
 * gen_hysteresis_band_chart.js — histerezis bandının φ_high haritası.
 *
 * ANLATILAN BULGU: bant φ_high'te MONOTON DEĞİL. İki ayrı kısıt bandı
 * iki yandan sıkıştırır — düşük φ'de RET, yüksek φ'de TASARRUF — ve
 * kullanılabilir bant ortada tepe yapar.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Ana panel: φ_high ekseninde İZİN VERİLEN BÖLGE (0 … h) alan
 *     olarak, üstünde sert kısıt (1 − φ_high) çizgi olarak. İkisi de
 *     "bant genişliği" birimindedir → TEK eksen, çift eksen YOK.
 *   • Renk ENTİTEYE bağlı, sıraya değil: k1 = ölçülen bant boyunca
 *     sabit; bağlayıcı kısıtın hangisi olduğu RENKLE DEĞİL, nokta
 *     işaretiyle (dolu/halka) + doğrudan etiketle ayrılır. Böylece
 *     "ret" ve "tasarruf" ayrı hue'lar isteyip paleti şişirmez.
 *   • İkinci panel: her profilde tasarruf ve ret Δ'sı, ikisi de PUAN
 *     birimi → tek eksen, gruplu çubuk; ±2·SE hata çubuğu ile, çünkü
 *     ölçütün kendisi anlamlılığa dayanıyor.
 *   • Çürütülen sezgisel ayrı bir panelde DEĞİL, ana panelde kesikli
 *     referans çizgisi olarak: iddia ile ölçümün aynı eksende
 *     karşılaşması gerekiyor.
 *
 * Palet: kategorik 3 slot, her iki modda validate_palette.js PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const P = D.profiles;
  if (!P || !P.length) throw new Error("profiles eksik — rapor eski");
  if (!D.nonMonotone) throw new Error("nonMonotone eksik — rapor eski");
  const rows = [...P].sort((a, b) => a.phi - b.phi);
  const peak = D.nonMonotone;
  const oldH = (D.rejectedHeuristic || {}).points || [];

  // ══ 1) BANT HARİTASI ══
  const L = { w: 790, h: 340, l: 62, r: 150, t: 30, b: 52 };
  const iw = L.w - L.l - L.r, ih = L.h - L.t - L.b;
  const phiMin = 0.45, phiMax = 0.95;
  const hMax = 0.55;
  const X = (p) => L.l + ((p - phiMin) / (phiMax - phiMin)) * iw;
  const Y = (h) => L.t + ih - (h / hMax) * ih;

  let g = "";
  for (let h = 0; h <= hMax + 1e-9; h += 0.1) {
    g += `<line x1="${L.l}" y1="${Y(h)}" x2="${L.l + iw}" y2="${Y(h)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${L.l - 9}" y="${Y(h) + 4}" text-anchor="end" class="tick">${tr(h, 2)}</text>`;
  }
  for (const p of [0.5, 0.6, 0.7, 0.8, 0.9])
    g += `<text x="${X(p)}" y="${L.t + ih + 18}" text-anchor="middle" class="tick">${tr(p, 2)}</text>`;
  g += `<text x="${L.l + iw / 2}" y="${L.t + ih + 40}" text-anchor="middle" class="axname">φ_high (üretimi durduran doluluk eşiği)</text>`;
  g += `<text x="${L.l - 46}" y="${L.t + ih / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L.l - 46} ${L.t + ih / 2})">histerezis bant yarı-genişliği h</text>`;

  // Sert kısıt çizgisi: h = 1 − φ_high (üstünde kısma HİÇ tetiklenmez)
  const capPts = [];
  for (let p = phiMin; p <= phiMax + 1e-9; p += 0.01) capPts.push(`${X(p)},${Y(Math.min(hMax, 1 - p))}`);
  g += `<polyline points="${capPts.join(" ")}" fill="none" stroke="var(--muted-mark)" stroke-width="1.6" stroke-dasharray="7 4"/>`;
  g += `<text x="${X(0.615)}" y="${Y(0.40)}" class="anno" fill="var(--text-muted)">sert kısıt h = 1 − φ_high</text>`;
  g += `<text x="${X(0.615)}" y="${Y(0.40) + 13}" class="anno" fill="var(--text-muted)">üstünde kısma hiç tetiklenmez</text>`;

  // Çürütülen sezgisel
  if (oldH.length) {
    const gp = [];
    for (let p = phiMin; p <= phiMax + 1e-9; p += 0.01) {
      const c = 1 - p;
      gp.push(`${X(p)},${Y(Math.min(hMax, Math.min(c / 2, 2 * c * c)))}`);
    }
    g += `<polyline points="${gp.join(" ")}" fill="none" stroke="var(--k2)" stroke-width="1.8" stroke-dasharray="3 4" opacity="0.85"/>`;
    g += `<text x="${X(0.505)}" y="${Y(0.285)}" class="anno k2t">çürütülen sezgisel ĥ = min(c/2, 2c²)</text>`;
    g += `<text x="${X(0.505)}" y="${Y(0.285) + 13}" class="anno k2t">— monoton, ölçüm değil</text>`;
  }

  // İzin verilen bölge (0 … h_ölçülen)
  const area = rows.map(r => `${X(r.phi)},${Y(r.derivedBand)}`).join(" ");
  g += `<polygon points="${X(rows[0].phi)},${Y(0)} ${area} ${X(rows[rows.length - 1].phi)},${Y(0)}" fill="var(--k1)" opacity="0.14"/>`;
  g += `<polyline points="${area}" fill="none" stroke="var(--k1)" stroke-width="2.6" stroke-linejoin="round"/>`;

  for (const r of rows) {
    const solid = r.bindingConstraint === "ret";
    const tip = `φ_high = ${tr(r.phi, 2)}<br/>ölçülen h = <b>${tr(r.derivedBand, 2)}</b><br/>` +
      `φ_low / φ_up = ${tr(r.atDerived.phiLow, 2)} / ${tr(r.atDerived.phiUp, 2)}<br/>` +
      `bağlayıcı kısıt: <b>${esc(r.bindingConstraint)}</b><br/>` +
      `ilk duraklama h = ${tr(r.firstStop ? r.firstStop.band : 0, 2)}<br/>` +
      `mod değişimi ${tr(r.rows[0].switches, 1)} → ${tr(r.atDerived.switches, 1)}<br/>` +
      `sert kısıt h &lt; ${tr(r.hardCapBand, 2)}`;
    g += `<g class="row" data-tip="${esc(tip)}">` +
      `<circle cx="${X(r.phi)}" cy="${Y(r.derivedBand)}" r="11" fill="transparent"/>` +
      `<circle cx="${X(r.phi)}" cy="${Y(r.derivedBand)}" r="4.6" fill="${solid ? "var(--k1)" : "var(--surface-1)"}" stroke="var(--k1)" stroke-width="2.2"/>` +
      `</g>`;
    g += `<text x="${X(r.phi)}" y="${Y(r.derivedBand) - 12}" text-anchor="middle" class="val">${tr(r.derivedBand, 2)}</text>`;
  }
  // Rejim ayracı + bölge etiketleri. Bölgeyi RENKLE ayırmıyoruz (renk
  // entiteye bağlı kalsın); ince bir ayraç ve doğrudan etiket yeterli.
  // Etiketler grafiğin ÜST boşluğuna konur — veri hattı sağda 0,02'ye
  // kadar iniyor, alt bölge kalabalık.
  const div = 0.65;
  g += `<line x1="${X(div)}" y1="${L.t + 4}" x2="${X(div)}" y2="${L.t + ih}" stroke="var(--grid)" stroke-width="1.4" stroke-dasharray="2 5"/>`;
  g += `<text x="${X(0.555)}" y="${L.t + 14}" text-anchor="middle" class="anno">← RET bağlıyor</text>`;
  g += `<text x="${X(0.80)}" y="${L.t + 14}" text-anchor="middle" class="anno">TASARRUF bağlıyor →</text>`;
  g += `<text x="${L.l + iw + 12}" y="${Y(rows[rows.length - 1].derivedBand) - 4}" class="endlab k1t">ölçülen bant</text>`;

  // ══ 2) İLK DURAKLAMADAKİ Δ'LAR ══
  const L2 = { w: 790, h: 250, l: 62, r: 128, t: 26, b: 46 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const dvals = rows.flatMap(r => r.firstStop ? [r.firstStop.sav.delta - 2 * r.firstStop.sav.se, r.firstStop.den.delta + 2 * r.firstStop.den.se] : [0]);
  const dMin = Math.min(-1, Math.floor(Math.min(...dvals)) - 1), dMax = Math.max(4, Math.ceil(Math.max(...dvals)) + 1);
  const Y2 = (v) => L2.t + ih2 - ((v - dMin) / (dMax - dMin)) * ih2;
  const bw = iw2 / rows.length;
  let g2 = "";
  for (let v = Math.ceil(dMin / 2) * 2; v <= dMax; v += 2) {
    g2 += `<line x1="${L2.l}" y1="${Y2(v)}" x2="${L2.l + iw2}" y2="${Y2(v)}" stroke="var(--grid)" stroke-width="${v === 0 ? 1.8 : 1}"/>`;
    g2 += `<text x="${L2.l - 9}" y="${Y2(v) + 4}" text-anchor="end" class="tick">${v > 0 ? "+" : ""}${tr(v, 0)}</text>`;
  }
  g2 += `<text x="${L2.l - 46}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 46} ${L2.t + ih2 / 2})">ilk duraklamadaki Δ (puan)</text>`;
  rows.forEach((r, i) => {
    const x0 = L2.l + i * bw, cw = bw * 0.30;
    if (!r.firstStop) return;
    const series = [
      { k: "k1", lab: "tasarruf", d: r.firstStop.sav.delta, se: r.firstStop.sav.se, off: bw * 0.16 },
      { k: "k2", lab: "ret", d: r.firstStop.den.delta, se: r.firstStop.den.se, off: bw * 0.54 },
    ];
    for (const s of series) {
      const x = x0 + s.off, y0 = Y2(0), y1 = Y2(s.d);
      const tip = `φ_high = ${tr(r.phi, 2)} · h = ${tr(r.firstStop.band, 2)}<br/>` +
        `Δ${s.lab} = <b>${s.d >= 0 ? "+" : ""}${tr(s.d, 2)}</b> ± ${tr(s.se, 2)} (SE)<br/>` +
        `2·SE eşiği = ${tr(2 * s.se, 2)} → ${Math.abs(s.d) > 2 * s.se ? "<b>anlamlı</b>" : "ayırt edilemiyor"}`;
      g2 += `<g class="row" data-tip="${esc(tip)}">` +
        `<rect x="${x}" y="${Math.min(y0, y1)}" width="${cw}" height="${Math.max(1.5, Math.abs(y1 - y0))}" rx="2" fill="var(--${s.k})"/>`;
      const eTop = Y2(s.d + 2 * s.se), eBot = Y2(s.d - 2 * s.se), xc = x + cw / 2;
      g2 += `<line x1="${xc}" y1="${eTop}" x2="${xc}" y2="${eBot}" stroke="var(--text-secondary)" stroke-width="1.3"/>` +
        `<line x1="${xc - 3.5}" y1="${eTop}" x2="${xc + 3.5}" y2="${eTop}" stroke="var(--text-secondary)" stroke-width="1.3"/>` +
        `<line x1="${xc - 3.5}" y1="${eBot}" x2="${xc + 3.5}" y2="${eBot}" stroke="var(--text-secondary)" stroke-width="1.3"/></g>`;
    }
    g2 += `<text x="${x0 + bw / 2}" y="${L2.t + ih2 + 17}" text-anchor="middle" class="tick">φ=${tr(r.phi, 2)}</text>`;
    g2 += `<text x="${x0 + bw / 2}" y="${L2.t + ih2 + 31}" text-anchor="middle" class="tick">h=${tr(r.firstStop.band, 2)}</text>`;
  });

  const tbl = rows.map(r => `<tr><td>${tr(r.phi, 2)}</td><td>h &lt; ${tr(r.hardCapBand, 2)}</td>` +
    `<td><b>${tr(r.derivedBand, 2)}</b></td><td>${tr(r.atDerived.phiLow, 2)} / ${tr(r.atDerived.phiUp, 2)}</td>` +
    `<td>${tr(r.rows[0].switches, 1)} → ${tr(r.atDerived.switches, 1)}</td><td>${esc(r.bindingConstraint)}</td>` +
    `<td>${tr(r.atDerived.savingsPct, 1)}</td><td>${tr(r.atDerived.denialPct, 2)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Histerezis bandının φ_high haritası</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;--muted-mark:#c9c8c2;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:880px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:32px 0 4px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:104px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  .lgrow{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 2px;font-size:12px;color:var(--text-secondary);}
  .lg{display:inline-flex;align-items:center;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover circle:first-of-type,.row:hover rect:first-of-type{opacity:.78;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Histerezis bandının φ_high haritası</h1>
<p class="sub">Bant, üretimi durduran eşiğin iki yanına açılan tolerans: φ_up = φ_high + h üstünde üretim durur, φ_low = φ_high − h altında geri başlar. Altı çalışma noktası tarandı.</p>

<div class="tiles">
  <div class="tile"><div class="l">tepe</div><div class="v">φ = ${tr(peak.peakPhi, 2)}</div></div>
  <div class="tile"><div class="l">tepede bant</div><div class="v">h = ${tr(peak.peakBand, 2)}</div></div>
  <div class="tile"><div class="l">önerilen (dengeli)</div><div class="v">h = ${tr((rows.find(r => r.phi === 0.8) || {}).derivedBand || 0, 2)}</div></div>
  <div class="tile"><div class="l">taranan nokta</div><div class="v">${tr(rows.length)}</div></div>
</div>

<h2>1 · Kullanılabilir bant φ_high boyunca</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>ölçülen bant — dolu nokta: ret bağlıyor · halka: tasarruf bağlıyor</span>
  <span class="lg"><span class="key" style="background:var(--muted-mark)"></span>sert kısıt 1 − φ_high</span>
</div>
<svg viewBox="0 0 ${L.w} ${L.h}" role="img" aria-label="Histerezis bandının φ_high haritası">${g}</svg>
<p class="note">Taralı alan, ölçütü geçen bant aralığıdır (0 … h). Sert kısıt çizgisi her yerde ölçülen bandın üstünde: yani hiçbir profilde bağlayıcı olan sert kısıt değil.</p>

<div class="callout warn">
  <b>Önceki sürüm yanlıştı.</b> Yalnız 0,50 / 0,80 / 0,85 / 0,90 taranmışken “bant φ_high yükseldikçe monoton daralır” denmişti. 0,60 ve 0,70 eklenince bant <b>monoton çıkmadı</b> — φ ≈ ${tr(peak.peakPhi, 2)}’te tepe yapıyor. Monoton olan çürütülen sezgisel eğrisiydi, ölçüm değil.
</div>

<h2>2 · İlk duraklamayı hangi kısıt tetikliyor</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>Δ tasarruf</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>Δ ret</span>
  <span class="lg">dikey çubuk: ±2·SE (eşleştirilmiş)</span>
</div>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="İlk duraklamadaki delta değerleri">${g2}</svg>
<p class="note">Ölçüt h = 0’dan yürür ve tasarruf ya da ret oranında ilk <b>anlamlı</b> bozulmada durur (|Δ| &gt; 2·SE, eşleştirilmiş fark). Düşük φ’de ret, yüksek φ’de tasarruf önce bozulur — bandı iki yandan sıkıştıran şey bu.</p>

<div class="callout">
  Bandı sıkıştıran iki mekanizma: <b>düşük φ’de</b> geniş bant φ_low’u dibe indirir, depo boşalır ve istekler reddedilir; <b>yüksek φ’de</b> geniş bant φ_up’ı 1’e iter, kısma hiç tetiklenmez ve tasarruf çöker. Ortada ikisi de gevşektir — bant orada en geniştir.
</div>

<details><summary>Ölçülen değerler</summary>
<table><thead><tr><th>φ_high</th><th>sert kısıt</th><th>ölçülen h</th><th>φ_low / φ_up</th><th>mod değişimi</th><th>bağlayıcı</th><th>tasarruf %</th><th>ret %</th></tr></thead>
<tbody>${tbl}</tbody></table>
<p class="note">Kaynak: <code>bb84/hysteresis_band_test.js</code> · ${tr((D.checks || []).length)} öz-testin tamamı geçiyor. Her satır 6 çalışma noktasının (talep/üretim 0,3–0,7 × depo 1–2 × S_min) ortalamasıdır.</p>
</details>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip');
  document.querySelectorAll('.row').forEach(function(g){
    g.addEventListener('mousemove',function(ev){
      tip.innerHTML=g.dataset.tip;tip.style.opacity=1;
      var x=ev.clientX+14,y=ev.clientY+14,r=tip.getBoundingClientRect();
      if(x+r.width>innerWidth-8)x=ev.clientX-r.width-14;
      if(y+r.height>innerHeight-8)y=ev.clientY-r.height-14;
      tip.style.left=x+'px';tip.style.top=y+'px';});
    g.addEventListener('mouseleave',function(){tip.style.opacity=0;});});
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "hysteresis_band.json");
  const outPath = process.argv[3] || "/tmp/hysteresis_band_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
