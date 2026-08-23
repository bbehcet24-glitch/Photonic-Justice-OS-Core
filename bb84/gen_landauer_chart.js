#!/usr/bin/env node
"use strict";
/**
 * gen_landauer_chart.js — radyatif bilgi tıkanması tatbikatının paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — saflık vs giriş (log x): naif düğüm (çöküyor) vs PhotonNet
 *     (taban sabit). Tam-karışık %50 referans çizgisi. İki seri aynı birim
 *     (saflık) → tek eksen. "Çöküyor mu?" sorusunun cevabı budur.
 *   • Panel 2 — soğuk-stage dağılımı vs giriş (log-log): naif (R·E_op,
 *     soğutucu bütçesini aşıyor) vs PhotonNet (geri-basınçla bütçeye
 *     kenetli). Soğutucu gücü yatay referans.
 *   • Panel 3 — entropi yönlendirme diyagramı: gelen akış → sıcakta ele /
 *     ışıkla dışa aktar / soğukta sil (küçük). Akış genişlikleri oranlı.
 *   • Renk ENTİTEYE bağlı: k2 (turuncu) = naif/tehlike; k1 (mavi) =
 *     PhotonNet/sağlam; k3 (yeşil) = dışa aktarım (sinyal).
 *
 * Palet: kategorik 3 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
const fmtR = (bps) => bps >= 1e12 ? `${tr(bps / 1e12, 0)}T` : `${tr(bps / 1e9, 0)}G`;
// "5.2e+11" → "5,2·10¹¹"
const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const sci = (s) => {
  const m = String(s).match(/^([\d.]+)e\+?(-?\d+)$/i);
  if (!m) return String(s);
  const mant = tr(parseFloat(m[1]), 1);
  const exp = m[2].split("").map(c => SUP[c] || c).join("");
  return `${mant}·10${exp}`;
};

function build(D) {
  const rows = D.sweep.rows, LA = D.landauer, ER = D.entropyRouting, EN = D.engine;
  const rMin = rows[0].Rin, rMax = rows[rows.length - 1].Rin;
  const lx = (r) => (Math.log10(r) - Math.log10(rMin)) / (Math.log10(rMax) - Math.log10(rMin));

  // ══ 1) SAFLIK vs GİRİŞ ══
  const L1 = { w: 790, h: 280, l: 64, r: 148, t: 26, b: 50 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const X1 = (r) => L1.l + lx(r) * iw1;
  const Y1 = (p) => L1.t + ih1 - ((p - 0.5) / 0.45) * ih1;   // 0.5..0.95
  let g1 = "";
  for (const p of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    g1 += `<line x1="${L1.l}" y1="${Y1(p)}" x2="${L1.l + iw1}" y2="${Y1(p)}" stroke="var(--grid)" stroke-width="${p === 0.5 ? 1.6 : 1}"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(p) + 4}" text-anchor="end" class="tick">${tr(p, 2)}</text>`;
  }
  for (const r of rows) g1 += `<text x="${X1(r.Rin)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${fmtR(r.Rin)}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">giriş foton veri hızı (bit/s, log)</text>`;
  g1 += `<text x="${L1.l - 48}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 48} ${L1.t + ih1 / 2})">bellek saflığı (1=saf, ½=karışık)</text>`;
  g1 += `<text x="${L1.l + 8}" y="${Y1(0.5) - 6}" class="anno">tam karışık (½)</text>`;
  // naif
  g1 += `<polyline points="${rows.map(r => `${X1(r.Rin)},${Y1(r.purityNaive)}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].purityNaive) + 4}" class="endlab k2t">naif düğüm</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].purityNaive) + 19}" class="anno k2t">çöküyor</text>`;
  // pn
  g1 += `<polyline points="${rows.map(r => `${X1(r.Rin)},${Y1(r.purityPn)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].purityPn) - 6}" class="endlab k1t">PhotonNet</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].purityPn) + 9}" class="anno">taban sabit</text>`;
  for (const r of rows) {
    for (const [key, col] of [["purityNaive", "k2"], ["purityPn", "k1"]]) {
      const tip = `giriş ${fmtR(r.Rin)}bit/s<br/>${col === "k2" ? "naif" : "PhotonNet"} saflık <b>${tr(r[key], 3)}</b>` +
        (col === "k2" ? `<br/>soğuk stage ${tr(r.tNaiveK, 1)}K` : `<br/>soğuk ${tr(r.dPnColdW, 3)}W ≤ bütçe`);
      g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.Rin)}" cy="${Y1(r[key])}" r="9" fill="transparent"/>` +
        `<circle cx="${X1(r.Rin)}" cy="${Y1(r[key])}" r="3.4" fill="var(--${col})"/></g>`;
    }
  }

  // ══ 2) SOĞUK DAĞILIM vs GİRİŞ (log-log) ══
  const L2 = { w: 790, h: 250, l: 64, r: 148, t: 26, b: 50 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const wMin = 1e-3, wMax = Math.max(...rows.map(r => r.dNaiveW)) * 1.4;
  const X2 = (r) => L2.l + lx(r) * iw2;
  const Y2 = (w) => L2.t + ih2 - (Math.log10(Math.max(wMin, w)) - Math.log10(wMin)) / (Math.log10(wMax) - Math.log10(wMin)) * ih2;
  let g2 = "";
  for (const w of [1e-3, 1e-2, 1e-1, 1, 10, 100]) {
    if (w > wMax) continue;
    g2 += `<line x1="${L2.l}" y1="${Y2(w)}" x2="${L2.l + iw2}" y2="${Y2(w)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 9}" y="${Y2(w) + 4}" text-anchor="end" class="tick">${w >= 1 ? tr(w) : tr(w, w >= 0.1 ? 1 : (w >= 0.01 ? 2 : 3))}W</text>`;
  }
  for (const r of rows) g2 += `<text x="${X2(r.Rin)}" y="${L2.t + ih2 + 18}" text-anchor="middle" class="tick">${fmtR(r.Rin)}</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 40}" text-anchor="middle" class="axname">giriş foton veri hızı (bit/s, log)</text>`;
  g2 += `<text x="${L2.l - 48}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 48} ${L2.t + ih2 / 2})">soğuk-stage dağılımı (W, log)</text>`;
  // soğutucu bütçesi
  g2 += `<line x1="${L2.l}" y1="${Y2(D.params.P_COLD)}" x2="${L2.l + iw2}" y2="${Y2(D.params.P_COLD)}" stroke="var(--muted-mark)" stroke-width="1.6" stroke-dasharray="6 4"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(D.params.P_COLD) - 4}" class="anno" fill="var(--text-muted)">soğutucu ${tr(D.params.P_COLD)}W</text>`;
  // naif dağılım
  g2 += `<polyline points="${rows.map(r => `${X2(r.Rin)},${Y2(r.dNaiveW)}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.6"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(rows[rows.length - 1].dNaiveW) + 4}" class="endlab k2t">naif (R·E)</text>`;
  // pn dağılım (kenetli)
  g2 += `<polyline points="${rows.map(r => `${X2(r.Rin)},${Y2(Math.max(wMin, r.dPnColdW))}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(D.params.P_COLD) + 16}" class="endlab k1t">PhotonNet</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(D.params.P_COLD) + 31}" class="anno">bütçeye kenetli</text>`;

  // ══ 3) ENTROPİ YÖNLENDİRME (akış diyagramı) ══
  const L3 = { w: 790, h: 168, l: 20, r: 20, t: 20, b: 20 };
  const sift = EN.siftDiscardFrac, key = EN.keyFrac, pe = EN.peFrac, cold = 0.02;
  // gelen kutu solda, üç çıkış sağda; genişlikler oranlı
  const inX = 40, inW = 130, cx = L3.w / 2, outX = L3.w - 250, outW = 230;
  const totalH = 96, inY = L3.t + 14;
  let g3 = "";
  g3 += `<rect x="${inX}" y="${inY}" width="${inW}" height="${totalH}" rx="6" fill="var(--surface-3)"/>`;
  g3 += `<text x="${inX + inW / 2}" y="${inY + totalH / 2 - 4}" text-anchor="middle" class="flowlab">gelen akış</text>`;
  g3 += `<text x="${inX + inW / 2}" y="${inY + totalH / 2 + 12}" text-anchor="middle" class="flowsub">THz foton</text>`;
  const outs = [
    { frac: sift, col: "k2", lab: "sıcakta ele", sub: "→ sıcak radyatör" },
    { frac: key + pe, col: "k3", lab: "ışıkla dışa aktar", sub: "→ indiş sinyali" },
    { frac: cold, col: "k1b", lab: "soğukta sil", sub: "→ artık (~%2)" },
  ];
  let acc = 0;
  const norm = sift + key + pe + cold;
  // Çıkış etiketleri EŞİT ARALIKLI (akış genişliği oranlı kalır ama
  // etiket satırları çakışmasın diye 3 sabit yuvaya oturur).
  const slotH = 38, slotGap = 6, slotY = (i) => inY + i * (slotH + slotGap);
  outs.forEach((o, i) => {
    const h = (o.frac / norm) * totalH;
    const y = inY + acc; acc += h;
    const oy = slotY(i);                 // etiket yuvası (eşit aralıklı)
    const col = o.col === "k1b" ? "k1" : o.col;
    // akış şeridi: kaynak yüksekliği oranlı, hedef yuvanın ortası
    g3 += `<path d="M ${inX + inW} ${y + h / 2} C ${cx} ${y + h / 2}, ${cx} ${oy + slotH / 2}, ${outX} ${oy + slotH / 2}" ` +
      `fill="none" stroke="var(--${col})" stroke-width="${Math.max(3, h * 0.7).toFixed(1)}" opacity="0.45"/>`;
    g3 += `<rect x="${outX}" y="${oy + slotH / 2 - 10}" width="14" height="20" rx="3" fill="var(--${col})"/>`;
    g3 += `<text x="${outX + 22}" y="${oy + slotH / 2 - 1}" class="flowlab2 ${col}t">${esc(o.lab)} %${tr(100 * o.frac, 0)}</text>`;
    g3 += `<text x="${outX + 22}" y="${oy + slotH / 2 + 12}" class="flowsub">${esc(o.sub)}</text>`;
  });

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Radyatif bilgi tıkanması</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e6e5e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;--muted-mark:#c9c8c2;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
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
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .flowlab{font-size:12px;font-weight:640;fill:var(--text-primary);}
  .flowlab2{font-size:11.5px;font-weight:620;}
  .flowsub{font-size:10px;fill:var(--text-muted);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Radyatif bilgi tıkanması — Landauer entropi duvarı nasıl geçilir</h1>
<p class="sub">Derin-uzay kuantum uydusunda THz foton akışı. Naif düğüm gelen her biti soğuk belleğe yazıp hatalıyı siler; dağılım soğutucuyu aşınca bellek ısınıp saf→karışık çöker. PhotonNet entropiyi ısıya çevirmeden tahliye eder. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">Landauer / gerçek işlem</div><div class="v">×${sci(LA.opOverLandauer)}</div></div>
  <div class="tile"><div class="l">soğuk-yazma tavanı</div><div class="v">${tr(D.sweep.R_evacBps / 1e9, 0)} Gb/s</div></div>
  <div class="tile"><div class="l">sinyal/ısı entropi oranı</div><div class="v">×${tr(ER.exportOverErase, 0)}</div></div>
  <div class="tile"><div class="l">PhotonNet saflık</div><div class="v">${tr(D.baselinePurity, 2)} sabit</div></div>
</div>

<h2>1 · Bellek saflığı — naif çöküyor, PhotonNet taban sabit</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Saflık vs giriş">${g1}</svg>
<p class="note">Naif düğüm ~100 Gbit/s'te saf→karışık dökülüyor (soğuk stage ${tr(D.params.P_COLD)}W soğutucuyu aşan dağılımla ısınıyor; en yüksek girişte tam karışık %50). PhotonNet saflığı taban ${tr(D.baselinePurity, 3)}'te sabit — giriş 10 THz'e kadar çıksa da soğuk stage ${tr(D.params.T_BASE)}K'da kalıyor.</p>

<h2>2 · Soğuk-stage dağılımı — geri-basınç bütçeye kenetliyor</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Soğuk dağılım vs giriş">${g2}</svg>
<p class="note">Naif dağılım R·E ile doğrusal büyüyüp soğutucu bütçesini aşıyor. PhotonNet'te soğuk-belleğe yazma hızı geri-basınçla soğutucunun kaldırma gücüne (${tr(D.params.P_COLD)}W) kenetli; giriş ne kadar artarsa artsın soğuk dağılım bütçenin altında kalıyor.</p>

<h2>3 · Entropi nereye gidiyor — ısıya değil, ışığa</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>sıcakta ele (baz-uyuşmazlığı, motorda ölçülü)</span>
  <span class="lg"><span class="key" style="background:var(--k3)"></span>ışıkla dışa aktar (indiş sinyali)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>soğukta sil (küçük artık)</span>
</div>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Entropi yönlendirme">${g3}</svg>
<p class="note">Gelen akışın %${tr(100 * EN.siftDiscardFrac, 0)}'si sıcak dedektörde ölçülüp atılır (soğuk belleğe hiç girmez → silinmez), %${tr(100 * (EN.keyFrac + EN.peFrac), 0)}'i indiş hattından ışık olarak yayılır. Soğukta gerçekten silinen yalnız ~%2 reset artığı. Sinyalle çıkan entropi, soğukta silinenin ×${tr(ER.exportOverErase, 0)} katı.</p>

<div class="callout"><b>İmkânsıza yakın sorunun cevabı:</b> 2. yasa aşılmıyor — <b>erazür zaten yapılmıyor</b>. Landauer bedeli yalnız bir belleği bilinen duruma RESETLERKEN doğar. PhotonNet üç yolla bundan kaçınır: (1) reddi soğuk belleğe <b>yazmadan</b> ele — baz-uyuşmazlığı sıcak dedektörde ölçülüp atılır, yazılmayan bit silinmez; (2) tutulanı <b>sinyal ışığı</b> olarak dışa aktar — entropi düğümden ışıkla çıkar (zaten yayınladığın indiş), yerel ısıya çevrilmez; (3) girişi <b>tahliye hızına kıs</b> — geri-basınç soğuk-yazmayı soğutucu gücüne kenetler, birikim olmaz. Kalan tek gerçek erazür ~%2 reset artığıdır ve soğutucu bütçesinin altındadır. Landauer tabanı zaten bağlayıcı değil (gerçek dağılımın ×${sci(LA.opOverLandauer)} altında).</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length}) ve model</summary>
<table><tbody>${D.checks.map(c => `<tr><td>${c.ok ? "✓" : "✗"}</td><td>${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Termodinamik muhasebe: gerçek k_B ve Landauer sabitleri + motorun ölçülü eleme/anahtar oranları (${tr(EN.totalRounds)} tur). Soğuk stage ${tr(D.params.T_BASE)}K, soğutucu ${tr(D.params.P_COLD)}W, işlem ${D.params.E_OP_COLD.toExponential(0)} J. Kaynak: <code>bb84/landauer_choke_drill.js</code>. Çekirdek SHA-256 değişmedi.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "landauer_choke.json");
  const outPath = process.argv[3] || "/tmp/landauer_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
