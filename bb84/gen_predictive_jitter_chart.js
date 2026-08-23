#!/usr/bin/env node
"use strict";
/**
 * gen_predictive_jitter_chart.js — tahminsel jitter hizalama paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — canlı-kilit uçurumu kalktı: drop% vs drift, ön-besleme
 *     (düz 0) vs düzeltmesiz (uçuruma çıkıyor). async_sync'in bulduğu
 *     uçurumun kaldırıldığını gösteren ana panel. Tek eksen (%).
 *   • Panel 2 — yakınsama: artık skew zaman serisi (ön-besleme jitter
 *     tabanına iner, düzeltmesiz sürüklenir). Jitter tabanı referans.
 *   • Panel 3 — adaptasyon: ani offset sıçraması çevresinde artık;
 *     kestirici birkaç adımda toparlıyor. Pencere ± bandı referans.
 *   • Renk ENTİTEYE bağlı: k1 = ön-besleme (yeni modül), k2 = düzeltmesiz
 *     (tehlike/naif).
 *
 * Palet: kategorik 2 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const LL = D.livelock, CV = D.convergence, AD = D.adaptation, W = D.params.windowMs, JIT = D.params.jitter;

  // ══ 1) CANLI-KİLİT UÇURUMU ══
  const rows = LL.rows;
  const L1 = { w: 790, h: 280, l: 64, r: 150, t: 26, b: 50 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const dMax = rows[rows.length - 1].driftPerStep;
  const X1 = (d) => L1.l + (d / dMax) * iw1;
  const Y1 = (p) => L1.t + ih1 - (p / 100) * ih1;
  let g1 = "";
  for (let p = 0; p <= 100; p += 25) {
    g1 += `<line x1="${L1.l}" y1="${Y1(p)}" x2="${L1.l + iw1}" y2="${Y1(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(p) + 4}" text-anchor="end" class="tick">%${tr(p)}</text>`;
  }
  for (const r of rows) g1 += `<text x="${X1(r.driftPerStep)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${tr(r.driftPerStep, 2)}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">asimetrik sürüklenme (ms / adım)</text>`;
  g1 += `<text x="${L1.l - 48}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 48} ${L1.t + ih1 / 2})">geçerli paket düşme %</text>`;
  // düzeltmesiz (naif, uçuruma çıkıyor)
  g1 += `<polyline points="${rows.map(r => `${X1(r.driftPerStep)},${Y1(r.naiveDropPct)}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].naiveDropPct) + 4}" class="endlab k2t">düzeltmesiz</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].naiveDropPct) + 19}" class="anno k2t">canlı-kilit</text>`;
  // ön-besleme (düz 0)
  g1 += `<polyline points="${rows.map(r => `${X1(r.driftPerStep)},${Y1(r.alignedDropPct)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(0) - 2}" class="endlab k1t">ön-besleme</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(0) + 13}" class="anno">sabit %0</text>`;
  for (const r of rows) {
    for (const [key, col] of [["naiveDropPct", "k2"], ["alignedDropPct", "k1"]]) {
      const tip = `drift ${tr(r.driftPerStep, 2)} ms/adım<br/>${col === "k1" ? "ön-besleme" : "düzeltmesiz"} drop <b>%${tr(r[key], 1)}</b>`;
      g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.driftPerStep)}" cy="${Y1(r[key])}" r="9" fill="transparent"/>` +
        `<circle cx="${X1(r.driftPerStep)}" cy="${Y1(r[key])}" r="3.6" fill="var(--${col})"/></g>`;
    }
  }

  // ══ 2) YAKINSAMA (artık zaman serisi) ══
  const al = CV.alignedTrace, na = CV.naiveTrace, n = al.length;
  const L2 = { w: 790, h: 210, l: 64, r: 150, t: 24, b: 46 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const rMax = Math.max(...na, ...al, W * 2) * 1.05;
  const X2 = (i) => L2.l + (i / (n - 1)) * iw2;
  const Y2 = (v) => L2.t + ih2 - (Math.min(v, rMax) / rMax) * ih2;
  let g2 = "";
  for (const v of [0, W, 20, 40].filter(v => v <= rMax)) {
    g2 += `<line x1="${L2.l}" y1="${Y2(v)}" x2="${L2.l + iw2}" y2="${Y2(v)}" stroke="var(--grid)" stroke-width="${v === W ? 1.4 : 1}" ${v === W ? 'stroke-dasharray="5 4"' : ""}/>`;
    g2 += `<text x="${L2.l - 9}" y="${Y2(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(W) + 4}" class="anno" fill="var(--text-muted)">pencere ${tr(W)} ms</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 22}" text-anchor="middle" class="axname">oturum boyunca (drift ${tr(D.drift.driftPerStep, 2)} ms/adım)</text>`;
  g2 += `<text x="${L2.l - 48}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 48} ${L2.t + ih2 / 2})">artık |skew| (ms)</text>`;
  g2 += `<polyline points="${na.map((v, i) => `${X2(i)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.2"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(na[na.length - 1]) + 4}" class="endlab k2t">düzeltmesiz</text>`;
  g2 += `<polyline points="${al.map((v, i) => `${X2(i)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.2"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(al[al.length - 1]) + 4}" class="endlab k1t">ön-besleme</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(al[al.length - 1]) + 19}" class="anno">jitter tabanı</text>`;

  // ══ 3) ADAPTASYON (sıçrama çevresi) ══
  const tr3 = AD.trace, n3 = tr3.length, x0 = AD.traceStart;
  const L3 = { w: 790, h: 190, l: 64, r: 150, t: 24, b: 46 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const a3Max = Math.max(...tr3.map(Math.abs), W) * 1.1;
  const X3 = (i) => L3.l + (i / (n3 - 1)) * iw3;
  const Y3 = (v) => L3.t + ih3 / 2 - (v / a3Max) * (ih3 / 2);
  let g3 = "";
  // pencere ± bandı
  g3 += `<rect x="${L3.l}" y="${Y3(W)}" width="${iw3}" height="${Y3(-W) - Y3(W)}" fill="var(--k1)" opacity="0.07"/>`;
  g3 += `<line x1="${L3.l}" y1="${Y3(W)}" x2="${L3.l + iw3}" y2="${Y3(W)}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="4 4"/>`;
  g3 += `<line x1="${L3.l}" y1="${Y3(-W)}" x2="${L3.l + iw3}" y2="${Y3(-W)}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="4 4"/>`;
  g3 += `<line x1="${L3.l}" y1="${Y3(0)}" x2="${L3.l + iw3}" y2="${Y3(0)}" stroke="var(--grid)" stroke-width="1"/>`;
  g3 += `<text x="${L3.l + iw3 + 12}" y="${Y3(W) + 4}" class="anno" fill="var(--text-muted)">±pencere</text>`;
  for (const v of [-W, 0, W]) g3 += `<text x="${L3.l - 9}" y="${Y3(v) + 4}" text-anchor="end" class="tick">${v > 0 ? "+" : ""}${tr(v)}</text>`;
  // sıçrama çizgisi (x=0 → index -x0)
  const stepIdx = -x0;
  g3 += `<line x1="${X3(stepIdx)}" y1="${L3.t}" x2="${X3(stepIdx)}" y2="${L3.t + ih3}" stroke="var(--k2)" stroke-width="1.4" stroke-dasharray="3 3"/>`;
  g3 += `<text x="${X3(stepIdx)}" y="${L3.t - 4}" text-anchor="middle" class="anno k2t">${tr(AD.stepSize)} ms sıçrama</text>`;
  g3 += `<polyline points="${tr3.map((v, i) => `${X3(i)},${Y3(v)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.2"/>`;
  g3 += `<text x="${X3(stepIdx) + 6}" y="${L3.t + ih3 + 6}" class="anno">${tr(AD.recoverySteps)} adımda toparlıyor →</text>`;
  g3 += `<text x="${L3.l + iw3 / 2}" y="${L3.t + ih3 + 34}" text-anchor="middle" class="axname">adım (ani yeniden-yönlendirme çevresi)</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tahminsel jitter hizalama</title>
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
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover circle:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Tahminsel jitter hizalama — pencere açılmadan skew'i silmek</h1>
<p class="sub">Hatlar arası zamanlama fluluğu (skew/drift/termal) bir Kalman saat kestiricisiyle önceden öğrenilip ön-beslemeli düzeltiliyor — PTP/GPS saat disiplininin yerleşik tekniği. async_sync'in bulduğu canlı-kilit uçurumu bu sayede kalkıyor. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">canlı-kilit (ön-besleme)</div><div class="v">yok</div></div>
  <div class="tile"><div class="l">drift artığı</div><div class="v">${tr(D.drift.alignedTailResidual, 1)} ms</div></div>
  <div class="tile"><div class="l">sıçrama toparlama</div><div class="v">${tr(AD.recoverySteps)} adım</div></div>
  <div class="tile"><div class="l">vs persistence</div><div class="v">%${tr(D.vsPersistence.improvementPct, 0)} ↑</div></div>
</div>

<h2>1 · Canlı-kilit uçurumu kalktı</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Canlı-kilit uçurumu">${g1}</svg>
<p class="note">Sürüklenme arttıkça düzeltmesiz zaman-penceresi alıcısı geçerli paketleri düşürüp canlı-kilide giriyor (%${tr(rows[rows.length - 1].naiveDropPct, 0)}). Ön-besleme her drift düzeyinde skew'i tahmin edip önceden telafi ettiği için pencere hiç açılmıyor — drop sabit %0.</p>

<h2>2 · Yakınsama — artık jitter tabanına iniyor</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Yakınsama">${g2}</svg>
<p class="note">Ön-besleme artığı birkaç pencerede jitter tabanına (~${tr(JIT, 1)} ms, pencerenin altında) iniyor; düzeltmesiz artık ise sürüklenmeyle sınırsız büyüyor. Kestirici offset + drift + yavaş termali öğrenip önceden siliyor — geriye yalnız öngörülemez jitter kalıyor.</p>

<h2>3 · Adaptasyon — ani yeniden-yönlendirmeye tepki</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Adaptasyon">${g3}</svg>
<p class="note">Bir fiber yeniden-yönlendirmesi ${tr(AD.stepSize)} ms'lik ani offset sıçraması yaratıyor. Kestirici Kalman kazancıyla bunu ${tr(AD.recoverySteps)} adımda yakalayıp artığı yeniden pencere altına indiriyor.</p>

<div class="callout"><b>Tasarım:</b> "AI tabanlı" burada bir kara kutu değil — <b>çevrimiçi uyarlamalı Kalman saat kestiricisi</b> (PTP/GPS disiplininin standardı). Durum [offset, drift]; her ölçümle özyinelemeli güncellenir; bir adım ileri tahmin ön-beslemeli düzeltme olur. <b>Dürüst sınır:</b> yalnız öngörülebilir yapıyı (offset/drift/termal) siler; saf beyaz jitter'da artık = tam jitter (×${tr(D.limit.ratio, 2)}) — kestirici olmayan örüntüyü <i>uydurmaz</i>. Öğrenen model 'son değeri tekrarla' tahmincisini %${tr(D.vsPersistence.improvementPct, 0)} yeniyor. async_sync'in içerik-adresli bağışıklığına ek olarak, bu modül bir <i>zaman-penceresi</i> alıcısını bile canlı-kilitten kurtarıyor.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/predictive_jitter_alignment.js</code> (modül) + <code>predictive_jitter_test.js</code>. Çekirdek SHA-256 değişmedi.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "predictive_jitter.json");
  const outPath = process.argv[3] || "/tmp/predictive_jitter_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
