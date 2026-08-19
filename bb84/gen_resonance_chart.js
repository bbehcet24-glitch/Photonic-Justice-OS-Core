#!/usr/bin/env node
"use strict";
/**
 * gen_resonance_chart.js — kararlılık sınırı rezonansı tatbikatının paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — rezonans eğrisi: anahtarlama hızı vs zorlama frekansı
 *     (log x, f/f_r). Blok-ritmi tavanı yatay referans. Keskin Q-tepesi
 *     OLMADIĞINI göstermek için tavan çizgisi şart.
 *   • Panel 2 — sönümleme kararı: rezonansta röle çevrim genliği (düz)
 *     vs kenetsiz ζ=0 doğrusal zarf (∝ t, patlıyor). Aynı eksende
 *     karşılaşmalı — asıl "felaket mi?" sorusunun cevabı bu.
 *   • Panel 3 — band savunması: h vs tepe anahtarlama hızı. Bandın
 *     sönümleme mekanizması olduğunu gösterir.
 *   • Renk ENTİTEYE bağlı: k1 (mavi) = mimarinin gerçek davranışı
 *     (röle/band); k2 (turuncu) = tehlike/kıyas (tavan aşımı, ζ=0 patlama,
 *     bandsız chatter).
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
  const N = D.natural, SW = D.sweep, DM = D.damping, BD = D.bandDamping;
  if (!SW || !DM || !BD) throw new Error("rapor eksik — resonance.json eski");

  // ══ 1) REZONANS EĞRİSİ (log x) ══
  const rows = SW.rows;
  const L1 = { w: 790, h: 290, l: 66, r: 150, t: 30, b: 52 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const xr = rows.map(r => Math.log2(r.ratio));
  const xMin = Math.min(...xr), xMax = Math.max(...xr);
  const yMax = Math.max(SW.blockCeilingPerMin, ...rows.map(r => r.switchRatePerMin)) * 1.15;
  const X1 = (ratio) => L1.l + (Math.log2(ratio) - xMin) / (xMax - xMin) * iw1;
  const Y1 = (v) => L1.t + ih1 - (v / yMax) * ih1;
  let g1 = "";
  for (let v = 0; v <= yMax; v += 4) {
    g1 += `<line x1="${L1.l}" y1="${Y1(v)}" x2="${L1.l + iw1}" y2="${Y1(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  for (const r of rows)
    g1 += `<text x="${X1(r.ratio)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${r.ratio < 1 ? "1/" + tr(Math.round(1 / r.ratio)) : tr(r.ratio) + "×"}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">zorlama frekansı (f / f_r)</text>`;
  g1 += `<text x="${L1.l - 52}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 52} ${L1.t + ih1 / 2})">mod anahtarlama /dk</text>`;
  // f_r işareti
  g1 += `<line x1="${X1(1)}" y1="${L1.t}" x2="${X1(1)}" y2="${L1.t + ih1}" stroke="var(--muted-mark)" stroke-width="1.2" stroke-dasharray="3 4"/>`;
  g1 += `<text x="${X1(1)}" y="${L1.t - 6}" text-anchor="middle" class="anno">f_r</text>`;
  // blok tavanı
  g1 += `<line x1="${L1.l}" y1="${Y1(SW.blockCeilingPerMin)}" x2="${L1.l + iw1}" y2="${Y1(SW.blockCeilingPerMin)}" stroke="var(--k2)" stroke-width="1.4" stroke-dasharray="6 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(SW.blockCeilingPerMin) - 4}" class="anno k2t">blok ritmi tavanı</text>`;
  // eğri
  g1 += `<polyline points="${rows.map(r => `${X1(r.ratio)},${Y1(r.switchRatePerMin)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  for (const r of rows) {
    const tip = `f = ${tr(r.ratio)}×f_r (${tr(r.freqHz, 3)} Hz)<br/>anahtarlama <b>${tr(r.switchRatePerMin, 1)}/dk</b><br/>` +
      `blok ${tr(r.blockRatePerMin, 1)}/dk · genlik %${tr(100 * r.amplitude, 0)}<br/>maxDoluluk %${tr(100 * r.maxFill, 1)} · ret %${tr(r.denialPct, 1)}`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.ratio)}" cy="${Y1(r.switchRatePerMin)}" r="10" fill="transparent"/>` +
      `<circle cx="${X1(r.ratio)}" cy="${Y1(r.switchRatePerMin)}" r="4" fill="var(--k1)"/></g>`;
  }
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].switchRatePerMin) + 4}" class="endlab k1t">anahtarlama</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].switchRatePerMin) + 19}" class="anno">doyuyor</text>`;

  // ══ 2) SÖNÜMLEME KARARI ══
  const env = DM.linearUndampedEnvelope;
  const ca = DM.cycleAmp;
  const L2 = { w: 790, h: 250, l: 66, r: 150, t: 26, b: 50 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  // Normalize her iki seriyi kendi başlangıcına: karşılaştırılan BÜYÜME.
  const env0 = env[Math.floor(env.length / 4)] || 1;
  const envN = env.map(v => v / env0);
  const ca0 = ca.length ? (ca.reduce((s, x) => s + x, 0) / ca.length) : 1;
  const caN = ca.map(v => v / (ca0 || 1));
  const gyMax = Math.max(4, Math.max(...envN)) * 1.1;
  const nx = Math.max(env.length, ca.length);
  const X2 = (i, n) => L2.l + (n <= 1 ? 0 : i / (n - 1)) * iw2;
  const Y2 = (v) => L2.t + ih2 - (v / gyMax) * ih2;
  let g2 = "";
  for (let v = 0; v <= gyMax; v += 1) {
    g2 += `<line x1="${L2.l}" y1="${Y2(v)}" x2="${L2.l + iw2}" y2="${Y2(v)}" stroke="var(--grid)" stroke-width="${v === 1 ? 1.6 : 1}"/>`;
    g2 += `<text x="${L2.l - 9}" y="${Y2(v) + 4}" text-anchor="end" class="tick">×${tr(v)}</text>`;
  }
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 22}" text-anchor="middle" class="axname">oturum boyunca (rezonansta sürülüyor)</text>`;
  g2 += `<text x="${L2.l - 52}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 52} ${L2.t + ih2 / 2})">genlik (başlangıca oranla)</text>`;
  // ζ=0 doğrusal zarf (patlıyor)
  g2 += `<polyline points="${envN.map((v, i) => `${X2(i, envN.length)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.6"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(envN[envN.length - 1]) + 4}" class="endlab k2t">ζ=0 kenetsiz</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(envN[envN.length - 1]) + 19}" class="anno k2t">∝ t · patlıyor</text>`;
  // röle çevrim genliği (düz)
  if (caN.length) {
    g2 += `<polyline points="${caN.map((v, i) => `${X2(i, caN.length)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
    g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(caN[caN.length - 1]) + 4}" class="endlab k1t">röle döngüsü</text>`;
    g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(caN[caN.length - 1]) + 19}" class="anno">kenetli · düz</text>`;
  }

  // ══ 3) BAND SAVUNMASI ══
  const bl = BD.rows;
  const L3 = { w: 790, h: 210, l: 66, r: 60, t: 24, b: 46 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const bMax = Math.max(...bl.map(b => b.switchRatePerMin)) * 1.15;
  const bw = iw3 / bl.length;
  const Y3 = (v) => L3.t + ih3 - (v / bMax) * ih3;
  let g3 = "";
  for (let v = 0; v <= bMax; v += 4) {
    g3 += `<line x1="${L3.l}" y1="${Y3(v)}" x2="${L3.l + iw3}" y2="${Y3(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${L3.l - 9}" y="${Y3(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  bl.forEach((b, i) => {
    const x = L3.l + i * bw + bw * 0.2, w = bw * 0.6;
    const col = b.band === 0 ? "k2" : "k1";
    const tip = `h = ${tr(b.band, 2)}<br/>tepe anahtarlama <b>${tr(b.switchRatePerMin, 1)}/dk</b><br/>genlik %${tr(100 * b.amplitude, 0)}`;
    g3 += `<g class="row" data-tip="${esc(tip)}"><rect x="${x}" y="${Y3(b.switchRatePerMin)}" width="${w}" height="${L3.t + ih3 - Y3(b.switchRatePerMin)}" rx="3" fill="var(--${col})"/></g>`;
    g3 += `<text x="${x + w / 2}" y="${Y3(b.switchRatePerMin) - 5}" text-anchor="middle" class="val">${tr(b.switchRatePerMin, 1)}</text>`;
    g3 += `<text x="${x + w / 2}" y="${L3.t + ih3 + 17}" text-anchor="middle" class="tick">h=${tr(b.band, 2)}${b.band === 0 ? " (bandsız)" : ""}</text>`;
  });
  g3 += `<text x="${L3.l + iw3 / 2}" y="${L3.t + ih3 + 38}" text-anchor="middle" class="axname">histerezis bant yarı-genişliği (rezonansta tepe anahtarlama)</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kararlılık sınırı rezonansı</title>
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
  .val{font-size:11.5px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover circle:first-of-type,.row:hover rect:first-of-type{opacity:.72;}
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
<h1>Kararlılık sınırı rezonansı — dengeleme döngüsüne rezonans saldırısı</h1>
<p class="sub">Talep, kontrol döngüsünün doğal frekansı f_r ≈ ${tr(N.frHz, 3)} Hz civarında kare dalgayla vuruldu. Soru: sönümleme bozulup genlik sürekli büyüyen bir felakete gider mi? Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">doğal frekans f_r</div><div class="v">${tr(N.frHz, 3)} Hz</div></div>
  <div class="tile"><div class="l">genlik büyümesi</div><div class="v">×${tr(1 + DM.amplitudeSlopePerCycle, 2)}</div></div>
  <div class="tile"><div class="l">tavan (blok ritmi)</div><div class="v">${tr(SW.blockCeilingPerMin, 1)}/dk</div></div>
  <div class="tile"><div class="l">öz-test</div><div class="v">${D.checks.filter(c => c.ok).length}/${D.checks.length}</div></div>
</div>

<h2>1 · Rezonans eğrisi — keskin tepe yok, doyum var</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Rezonans eğrisi">${g1}</svg>
<p class="note">Anahtarlama hızı düşük frekansta zorlamayı izliyor, f_r ve üstünde <b>blok ritmi tavanına doyuyor</b> (f_r üstü satırlar ×${tr(SW.plateauSpread, 2)} içinde). Bang-bang döngüsü doğrusal bir rezonatör değil: hızlı zorlamak onu bloktan hızlı anahtarlatamaz, keskin bir Q-tepesi oluşmuyor.</p>

<h2>2 · Sönümleme kararı — genlik büyüyor mu?</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>röle döngüsü (kenetli)</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>ζ=0 kenetsiz doğrusal rezonatör (kıyas)</span>
</div>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Sönümleme kararı">${g2}</svg>
<p class="note">Rezonansta röle döngüsünün çevrim genliği düz (eğim ${tr(DM.amplitudeSlopePerCycle, 4)}/çevrim ≈ 0), doluluk %100'ü aşmıyor. Kıyas: kenetsiz <b>ζ=0</b> doğrusal rezonatör aynı frekansta ×${tr(DM.linearUndampedGrowthRatio, 1)} genlikle patlıyor (zarf ∝ t). Not: ζ=${tr(0.03, 2)} (az sönümlü, &lt;1) bile patlamıyor, ${tr(DM.linearUnderdampedMax, 2)}'de oturuyor — <b>"ζ&lt;1 ⇒ felaket" varsayımı yanlış</b>, felaket ζ=0 ister; röle döngüsünde kenet ζ=0'da bile büyümeyi keser.</p>

<h2>3 · Histerezis bandı rezonans savunmasıdır</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Band savunması">${g3}</svg>
<p class="note">Rezonansta bile geçiş yükünü sınırlayan şey bandın kendisi: bandsız (h=0) chatter fırtınası (${tr(bl[0].switchRatePerMin, 1)}/dk), bant genişledikçe tepe anahtarlama hızı düşüyor (h=${tr(bl[bl.length - 1].band, 2)} → ${tr(bl[bl.length - 1].switchRatePerMin, 1)}/dk).</p>

<div class="callout"><b>Sonuç:</b> saldırı histerezis döngüsünü kendi doğal frekansında sürebiliyor ama <b>rezonans felaketi oluşturamıyor</b>. Sistem doğrusal bir rezonatör değil, kenetli bir röle döngüsü: (1) genlik [0, kapasite] aralığına kilitli, büyümüyor; (2) anahtarlama hızı blok ritmine doyuyor, süper-doğrusal artmıyor; (3) geçiş yükünü sınırlayan histerezis bandı, aynı zamanda daha önce ayarladığımız φ_high savunmasının parçası. Saldırının etkisi bir yük artışıyla (daha sık ama sınırlı anahtarlama) sınırlı; kilitlenme ya da patlama yok.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length}) ve kurulum</summary>
<table><tbody>${D.checks.map(c => `<tr><td>${c.ok ? "✓" : "✗"}</td><td>${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kurulum: üretim ${tr(N.prodBps)} bit/s · talep ${tr(N.demandBps)} · depo ${tr(N.capacityBits)} bit · φ=${tr(N.phi, 2)} · h=${tr(N.band, 2)}. Kaynak: <code>bb84/resonance_drill.js</code>.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "resonance.json");
  const outPath = process.argv[3] || "/tmp/resonance_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
