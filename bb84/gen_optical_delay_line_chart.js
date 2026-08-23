#!/usr/bin/env node
"use strict";
/**
 * gen_optical_delay_line_chart.js — Kuantum Geciktirme Hattı (ODLS) paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — FİZİKSEL ZARF: toplam insertion-loss (dB) vs tutma süresi
 *     (log-μs). 3 dB bütçe çizgisi cliff'i belirler; 9-adımlık hızlı
 *     toparlanma altında (sığar), yavaş ms resync üstte (imkânsız). Tek
 *     eksen (dB). ANA panel — "bedava değil, hız şart" mesajı.
 *   • Panel 2 — AYAR: aynı tutmada kayıp ayrışması yığılmış çubuk — fiber
 *     TABANI (sabit) + anahtar EK YÜKÜ (n ile artar). n=1 eşlenmiş döngü
 *     en az; ayarsız küçük döngü bütçeyi patlatır. 3 dB çizgisi.
 *   • Panel 3 — SONUÇ: ODLS öncesi/sonrası paket kaderi. Öncesi %100
 *     zaman-aşımı düşüşü; sonrası zaman-aşımı 0 + %58 sağ kalır (kalan
 *     insertion-loss). Yığılmış çubuk.
 *   • Renk ENTİTEYE bağlı: k1 = ODLS/ayarlı/sığan (mavi), k2 = bütçe-dışı/
 *     ODLS'siz (turuncu/tehlike), k3 = sağ kalan/teslim (yeşil).
 *
 * Palet: kategorik 3 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const BUD = 3;   // dB bütçe tavanı
  const EN = D.envelope, TU = D.tuning, WO = D.withOdls, NO = D.withoutOdls, FB = D.fiber;

  // ══ 1) FİZİKSEL ZARF (loss vs hold, log-μs) ══
  const sweep = EN.sweep.map(r => ({ holdUs: r.holdMs * 1000, lossDb: r.totalLossDb, ok: r.withinBudget }));
  const L1 = { w: 790, h: 300, l: 60, r: 152, t: 26, b: 52 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const xMinUs = 10, xMaxUs = 3e4;                     // 10 μs .. 30 ms (log)
  const lx = (u) => Math.log10(Math.max(u, xMinUs));
  const X1 = (u) => L1.l + (lx(u) - lx(xMinUs)) / (lx(xMaxUs) - lx(xMinUs)) * iw1;
  const yMax1 = 8;                                     // dB (grafik tavanı)
  const Y1 = (d) => L1.t + ih1 - Math.min(d, yMax1) / yMax1 * ih1;
  let g1 = "";
  for (let d = 0; d <= yMax1; d += 2) {
    g1 += `<line x1="${L1.l}" y1="${Y1(d)}" x2="${L1.l + iw1}" y2="${Y1(d)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 8}" y="${Y1(d) + 4}" text-anchor="end" class="tick">${tr(d)}</text>`;
  }
  for (const u of [10, 100, 1000, 10000]) {
    g1 += `<line x1="${X1(u)}" y1="${L1.t}" x2="${X1(u)}" y2="${L1.t + ih1}" stroke="var(--grid)" stroke-width="1" opacity="0.5"/>`;
    const lab = u >= 1000 ? `${tr(u / 1000)} ms` : `${tr(u)} μs`;
    g1 += `<text x="${X1(u)}" y="${L1.t + ih1 + 17}" text-anchor="middle" class="tick">${lab}</text>`;
  }
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">tutma süresi (log)</text>`;
  g1 += `<text x="${L1.l - 44}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 44} ${L1.t + ih1 / 2})">toplam insertion-loss (dB)</text>`;
  // 3 dB bütçe çizgisi + cliff
  g1 += `<line x1="${L1.l}" y1="${Y1(BUD)}" x2="${L1.l + iw1}" y2="${Y1(BUD)}" stroke="var(--k2)" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(BUD) + 4}" class="anno k2t">3 dB bütçe</text>`;
  const cliffUs = FB.maxHoldMsAt3dB * 1000;
  g1 += `<line x1="${X1(cliffUs)}" y1="${L1.t}" x2="${X1(cliffUs)}" y2="${L1.t + ih1}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="3 3"/>`;
  g1 += `<text x="${X1(cliffUs)}" y="${L1.t - 6}" text-anchor="middle" class="anno">cliff ${tr(cliffUs, 0)} μs</text>`;
  // sığan bölge gölgesi (cliff'e kadar)
  g1 += `<rect x="${L1.l}" y="${L1.t}" width="${X1(cliffUs) - L1.l}" height="${ih1}" fill="var(--k3)" opacity="0.06"/>`;
  // eğri
  g1 += `<polyline points="${sweep.filter(p => p.holdUs >= xMinUs).map(p => `${X1(p.holdUs)},${Y1(p.lossDb)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  for (const p of sweep) {
    if (p.holdUs < xMinUs) continue;
    const col = p.ok ? "k3" : "k2";
    const tip = `tutma ${tr(p.holdUs, 0)} μs<br/>kayıp <b>${tr(p.lossDb, 2)} dB</b><br/>${p.ok ? "bütçede ✓" : "bütçe-dışı ✗"}`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(p.holdUs)}" cy="${Y1(p.lossDb)}" r="9" fill="transparent"/>` +
      `<circle cx="${X1(p.holdUs)}" cy="${Y1(p.lossDb)}" r="3.6" fill="var(--${col})"/></g>`;
  }
  // 9-adım hızlı işaret
  const fastUs = EN.fastRecovery.holdMs * 1000;
  const fastLoss = sweep.find(p => Math.abs(p.holdUs - fastUs) < 1).lossDb;
  g1 += `<line x1="${X1(fastUs)}" y1="${Y1(fastLoss)}" x2="${X1(fastUs)}" y2="${L1.t + ih1}" stroke="var(--k1)" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/>`;
  g1 += `<text x="${X1(fastUs)}" y="${Y1(fastLoss) - 9}" text-anchor="middle" class="anno k1t">9 adım · ${tr(fastUs, 0)} μs</text>`;
  // yavaş ms resync (grafiğin dışında → sağ üstte ok)
  g1 += `<text x="${L1.l + iw1 + 12}" y="${L1.t + 14}" class="anno k2t">yavaş resync →</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${L1.t + 29}" class="anno k2t">80 ms = ${tr(EN.slowReactive.lossDb, 0)} dB</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${L1.t + 44}" class="anno">(imkânsız)</text>`;

  // ══ 2) AYAR — kayıp ayrışması (yığılmış çubuk, n taraması) ══
  const rows = TU.rows;
  const L2 = { w: 790, h: 230, l: 60, r: 152, t: 22, b: 54 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const yMax2 = 12;
  const Y2 = (d) => L2.t + ih2 - Math.min(d, yMax2) / yMax2 * ih2;
  const bw = iw2 / rows.length * 0.6;
  let g2 = "";
  for (let d = 0; d <= yMax2; d += 3) {
    g2 += `<line x1="${L2.l}" y1="${Y2(d)}" x2="${L2.l + iw2}" y2="${Y2(d)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 8}" y="${Y2(d) + 4}" text-anchor="end" class="tick">${tr(d)}</text>`;
  }
  const floor = TU.fiberFloorDb;
  rows.forEach((r, i) => {
    const cx = L2.l + (i + 0.5) / rows.length * iw2;
    const swOver = r.totalLossDb - floor;
    // fiber tabanı (sabit) — k1
    g2 += `<rect x="${cx - bw / 2}" y="${Y2(floor)}" width="${bw}" height="${L2.t + ih2 - Y2(floor)}" fill="var(--k1)" opacity="0.85"/>`;
    // anahtar ek yükü (n ile) — k2
    g2 += `<rect x="${cx - bw / 2}" y="${Y2(r.totalLossDb)}" width="${bw}" height="${Y2(floor) - Y2(r.totalLossDb)}" fill="var(--k2)" opacity="0.9"/>`;
    const tip = `n=${r.passes} geçiş · döngü ${tr(r.loopKm, 2)} km<br/>fiber tabanı <b>${tr(floor, 2)} dB</b> + anahtar <b>${tr(swOver, 2)} dB</b><br/>= ${tr(r.totalLossDb, 2)} dB · ${r.withinBudget ? "bütçede ✓" : "bütçe-dışı ✗"}`;
    g2 += `<g class="row" data-tip="${esc(tip)}"><rect x="${cx - bw / 2 - 2}" y="${L2.t}" width="${bw + 4}" height="${ih2}" fill="transparent"/></g>`;
    g2 += `<text x="${cx}" y="${L2.t + ih2 + 16}" text-anchor="middle" class="tick">${r.passes}</text>`;
    g2 += `<text x="${cx}" y="${Y2(r.totalLossDb) - 5}" text-anchor="middle" class="anno" fill="${r.withinBudget ? "var(--k3)" : "var(--k2)"}">${r.withinBudget ? "✓" : "✗"}</text>`;
  });
  g2 += `<line x1="${L2.l}" y1="${Y2(BUD)}" x2="${L2.l + iw2}" y2="${Y2(BUD)}" stroke="var(--k2)" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(BUD) + 4}" class="anno k2t">3 dB bütçe</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(floor) + 4}" class="anno k1t">fiber tabanı</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(floor) + 19}" class="anno">${tr(floor, 2)} dB sabit</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 40}" text-anchor="middle" class="axname">döngü geçiş sayısı n (döngü = pencere / n)</text>`;
  g2 += `<text x="${L2.l - 44}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 44} ${L2.t + ih2 / 2})">insertion-loss (dB)</text>`;

  // ══ 3) SONUÇ — ODLS öncesi/sonrası paket kaderi ══
  const total = NO.packetsInWindow;
  const survPct = WO.worstCaseSurvival * 100, lossPct = 100 - survPct;
  const L3 = { w: 790, h: 150, l: 60, r: 152, t: 20, b: 40 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const barH = 34, gap = 30;
  const X3 = (p) => L3.l + p / 100 * iw3;
  let g3 = "";
  // ÖNCESİ: %100 zaman-aşımı düşüşü (k2)
  const y3a = L3.t + 6;
  g3 += `<rect x="${L3.l}" y="${y3a}" width="${iw3}" height="${barH}" fill="var(--k2)" opacity="0.9"/>`;
  g3 += `<text x="${L3.l + iw3 / 2}" y="${y3a + barH / 2 + 4}" text-anchor="middle" class="barlab">%100 zaman-aşımı düşüşü</text>`;
  g3 += `<text x="${L3.l - 8}" y="${y3a + barH / 2 + 4}" text-anchor="end" class="anno">ODLS'siz</text>`;
  // SONRASI: teslim (k3) + insertion-loss (k2, açık)
  const y3b = y3a + barH + gap;
  g3 += `<rect x="${L3.l}" y="${y3b}" width="${X3(survPct) - L3.l}" height="${barH}" fill="var(--k3)" opacity="0.9"/>`;
  g3 += `<rect x="${X3(survPct)}" y="${y3b}" width="${L3.l + iw3 - X3(survPct)}" height="${barH}" fill="var(--k2)" opacity="0.35"/>`;
  g3 += `<text x="${(L3.l + X3(survPct)) / 2}" y="${y3b + barH / 2 + 4}" text-anchor="middle" class="barlab">teslim %${tr(survPct, 0)}</text>`;
  g3 += `<text x="${(X3(survPct) + L3.l + iw3) / 2}" y="${y3b + barH / 2 + 4}" text-anchor="middle" class="barlab" fill="var(--text-secondary)">kayıp %${tr(lossPct, 0)}</text>`;
  g3 += `<text x="${L3.l - 8}" y="${y3b + barH / 2 + 4}" text-anchor="end" class="anno k1t">ODLS + ayar</text>`;
  g3 += `<text x="${L3.l + iw3 + 12}" y="${y3b + barH / 2 - 3}" class="anno">zaman-aşımı</text>`;
  g3 += `<text x="${L3.l + iw3 + 12}" y="${y3b + barH / 2 + 12}" class="anno k3t">→ 0</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kuantum geciktirme hattı</title>
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
  .barlab{font-size:12px;font-weight:640;fill:#fff;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Kuantum geciktirme hattı (ODLS) — şok anında paketi dondur</h1>
<p class="sub">Predictor'ın 9-adımlık geçiş evresinde pencereyi aşan paketler, düşürülmek yerine bir recirculating fiber döngüde (2×2 anahtar) geçici DONDURULUP toparlanınca bırakılıyor. Ama ODLS bedava değil: fiberde ışığı tutmanın kaçınılmaz bir kayıp bedeli var — bütçe (kayıp + faz) iyi ayarlanmalı. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">fiber tabanı</div><div class="v">${tr(FB.fiberFloorDbPerMs, 1)} dB/ms</div></div>
  <div class="tile"><div class="l">3 dB'de tutma</div><div class="v">${tr(FB.maxHoldMsAt3dB * 1000, 0)} μs</div></div>
  <div class="tile"><div class="l">9-adım kayıp</div><div class="v">${tr(WO.heldLossDb, 2)} dB</div></div>
  <div class="tile"><div class="l">zaman-aşımı</div><div class="v">→ 0</div></div>
</div>

<h2>1 · Fiziksel zarf — bedava değil, hız şart</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Fiziksel zarf">${g1}</svg>
<p class="note">Fiberde ışığı tutmanın kaçınılmaz bedeli: α·v = ${tr(FB.fiberFloorDbPerMs, 1)} dB/ms. 3 dB bütçe ⇒ en çok ${tr(FB.maxHoldMsAt3dB * 1000, 0)} μs tutma (cliff). Predictor'ın hızlı 9-adım toparlaması (${tr(fastUs, 0)} μs, ${tr(WO.heldLossDb, 2)} dB) rahat sığıyor; eski TEPKİSEL resync (80 ms → ${tr(EN.slowReactive.lossDb, 0)} dB) imkânsız. <b>L5.5'in μs hızında olması, ODLS'nin fiziksel ön koşulu.</b></p>

<h2>2 · Ayar — döngüyü pencereye eşle (n=1)</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Bütçe ayarı">${g2}</svg>
<p class="note">Aynı ${tr(TU.holdMs * 1000, 0)} μs tutmada fiber tabanı (${tr(floor, 2)} dB) sabittir — tasarımla değişmez. Tek serbestlik anahtar ek yükü: her geçiş 2×2 anahtar kaybını tekrar öder. Döngüyü tam pencereye eşleyip tek geçişte (n=1) tutmak ek yükü en aza indirir; ayarsız küçük döngü (n büyük) bütçeyi patlatır.</p>

<h2>3 · Sonuç — zaman-aşımı düşüşü sıfırlandı</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Öncesi sonrası">${g3}</svg>
<p class="note">ODLS'siz: geçiş penceresindeki ${tr(total)} paketin %100'ü zaman-aşımından düşer. Ayarlı ODLS ile: zaman-aşımı düşüşü 0'a iner, paketler dondurulup toparlanınca bırakılır — insertion-loss'tan en kötü %${tr(lossPct, 0)} kaybedilir, %${tr(survPct, 0)}'i sadakati (${tr(WO.heldFidelity, 3)} ≥ Bell) bozulmadan teslim edilir. %100 kayıp → %${tr(lossPct, 0)} kayıp.</p>

<div class="callout"><b>Dürüst bütçe:</b> ODLS bir "dondurucu" ama bedava değil. İki bağımsız bütçe farklı zaman ölçeğinde bağlar — μs fiber döngüde <b>kayıp</b> (faz ${tr(D.regime.fiberLoop.phaseLimitPasses)} geçiş boşta), ms gerçek kuantum bellekte <b>faz</b>. Fiber ODLS kayıp rejiminde çalışır: kaçınılmaz fiber tabanı yüzünden yalnız μs-ölçekli, hızlı toparlanan bir geçişi köprüleyebilir. Bu da tam olarak predictor'ın (L5.5) sağladığı şey. Çözüm, kaybı sıfıra indirmek değil — %100 zaman-aşımı kaybını, bütçesi iyi ayarlanmış küçük bir insertion-loss'a çevirmek.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/optical_delay_line.js</code> (modül) + <code>optical_delay_line_test.js</code>. Fizik motordan (<code>entanglement_swap_scheduler.js</code>) alınır; çekirdek SHA-256 değişmedi.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "optical_delay_line.json");
  const outPath = process.argv[3] || "/tmp/optical_delay_line_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
