#!/usr/bin/env node
"use strict";
/**
 * gen_odls_optimization_chart.js — ODLS taban kaybını düşürme paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — İZ 1: PJA agresifleştir. Insertion-loss (dB) vs toparlanma
 *     adımı; adım↓ ⇒ taban↓ (doğrusal). Sweet-spot (5 adım) işaretli;
 *     aşırı-agresif bölge (bedel patlar) gölgeli. Tek eksen (dB); bedel%
 *     nokta etiketinde.
 *   • Panel 2 — İZ 2: ortam tabanı (α·v) LOG çubuk. SMF referans; ULL/hollow
 *     DAHA İYİ (k3), Si₃N₄/Si ×100+ DAHA KÖTÜ (k2). "Çip daha iyi" önermesini
 *     görsel olarak çürütür. Log-x zorunlu (386×–175000× yayılım).
 *   • Panel 3 — REJİM & SENTEZ: en çok tutma (log) ortam başına + kuantum
 *     bellek kaçışı (μs→ms). Kayıp duvarı vs faz duvarı. Sentez noktası
 *     (5 adım × hollow-core).
 *   • Renk ENTİTEYE bağlı: k1 = SMF/referans (mavi), k2 = daha kötü/tehlike
 *     (turuncu), k3 = daha iyi/kazanç (yeşil).
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const BUD = 3;
  const T1 = D.track1, T2 = D.track2, SY = D.synthesis, QM = D.qmemory;

  // ══ 1) İZ 1 — PJA agresifleştir (loss vs adım) ══
  // Aynı adım sayısına düşen q'ları tekilleştir (en düşük bedelli temsilci) —
  // grafik monoton kalsın; "bedelle kazanç yok" nüansı başlıkta.
  const byStep = new Map();
  for (const r of T1.rows) {
    const cur = byStep.get(r.recoverySteps);
    if (!cur || r.ssDropTightPct < cur.ssDropTightPct) byStep.set(r.recoverySteps, r);
  }
  const rows = [...byStep.values()].sort((a, b) => b.recoverySteps - a.recoverySteps); // 8..2
  const L1 = { w: 790, h: 285, l: 60, r: 152, t: 26, b: 52 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const sMax = 10, sMin = 1;
  const X1 = (s) => L1.l + (sMax - s) / (sMax - sMin) * iw1;   // adım azaldıkça sağa
  const yMax1 = 2.6;
  const Y1 = (d) => L1.t + ih1 - Math.min(d, yMax1) / yMax1 * ih1;
  let g1 = "";
  for (let d = 0; d <= yMax1; d += 0.5) {
    g1 += `<line x1="${L1.l}" y1="${Y1(d)}" x2="${L1.l + iw1}" y2="${Y1(d)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 8}" y="${Y1(d) + 4}" text-anchor="end" class="tick">${tr(d, 1)}</text>`;
  }
  for (const s of [9, 8, 6, 5, 4, 3, 2]) g1 += `<text x="${X1(s)}" y="${L1.t + ih1 + 17}" text-anchor="middle" class="tick">${s}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">PJA toparlanma adımı (← daha agresif)</text>`;
  g1 += `<text x="${L1.l - 44}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 44} ${L1.t + ih1 / 2})">insertion-loss tabanı (dB)</text>`;
  // aşırı-agresif bölge gölgesi (5 adımdan sonra)
  g1 += `<rect x="${X1(5)}" y="${L1.t}" width="${L1.l + iw1 - X1(5)}" height="${ih1}" fill="var(--k2)" opacity="0.06"/>`;
  g1 += `<text x="${(X1(5) + L1.l + iw1) / 2}" y="${L1.t + 14}" text-anchor="middle" class="anno k2t">bedel patlar (dar-drop ↑)</text>`;
  // baseline 9-adım referans (senaryo)
  const bx = X1(T1.baseline.recoverySteps), by = Y1(T1.baseline.floorDb);
  // loss curve
  g1 += `<polyline points="${rows.map(r => `${X1(r.recoverySteps)},${Y1(r.floorDb)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  // baseline marker (dashed, from scenario 9-step)
  g1 += `<line x1="${bx}" y1="${L1.t}" x2="${bx}" y2="${L1.t + ih1}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="3 3"/>`;
  g1 += `<circle cx="${bx}" cy="${by}" r="4" fill="var(--k1)"/>`;
  g1 += `<text x="${bx}" y="${by - 10}" text-anchor="middle" class="anno">senaryo 9 adım · ${tr(T1.baseline.floorDb, 2)} dB</text>`;
  for (const r of rows) {
    const col = r.recoverySteps >= 5 ? "k3" : "k2";
    const tip = `${r.recoverySteps} adım (q=${r.q})<br/>tutma ${tr(r.holdUs, 0)} μs · taban <b>${tr(r.floorDb, 2)} dB</b><br/>uçurum payı ${tr(r.cliffMarginUs, 0)} μs<br/>dar-pencere drop <b>%${tr(r.ssDropTightPct, 2)}</b>`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.recoverySteps)}" cy="${Y1(r.floorDb)}" r="9" fill="transparent"/>` +
      `<circle cx="${X1(r.recoverySteps)}" cy="${Y1(r.floorDb)}" r="3.6" fill="var(--${col})"/></g>`;
    g1 += `<text x="${X1(r.recoverySteps)}" y="${Y1(r.floorDb) + 17}" text-anchor="middle" class="tick" fill="${r.recoverySteps >= 5 ? "var(--k3)" : "var(--k2)"}">%${tr(r.ssDropTightPct, 1)}</text>`;
  }
  // sweet-spot işareti
  const tx = X1(T1.target.recoverySteps), ty = Y1(T1.target.floorDb);
  g1 += `<circle cx="${tx}" cy="${ty}" r="6.5" fill="none" stroke="var(--k3)" stroke-width="2"/>`;
  g1 += `<text x="${tx}" y="${ty - 12}" text-anchor="middle" class="anno k3t">sweet-spot ${T1.target.recoverySteps} adım</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${L1.t + ih1 - 6}" class="anno">nokta altı = kararlı-durum bedeli</text>`;

  // ══ 2) İZ 2 — ortam tabanı (log çubuk) ══
  const meds = T2.rows;
  const L2 = { w: 790, h: 235, l: 158, r: 96, t: 20, b: 46 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const fMin = 10, fMax = 1e7;   // dB/ms log
  const lf = (v) => Math.log10(Math.max(v, fMin));
  const X2 = (v) => L2.l + (lf(v) - lf(fMin)) / (lf(fMax) - lf(fMin)) * iw2;
  const bh = ih2 / meds.length * 0.62;
  let g2 = "";
  for (const gx of [10, 100, 1000, 1e4, 1e5, 1e6, 1e7]) {
    g2 += `<line x1="${X2(gx)}" y1="${L2.t}" x2="${X2(gx)}" y2="${L2.t + ih2}" stroke="var(--grid)" stroke-width="1" opacity="0.6"/>`;
    const lab = gx >= 1e6 ? `10${sup(Math.log10(gx))}` : tr(gx);
    g2 += `<text x="${X2(gx)}" y="${L2.t + ih2 + 16}" text-anchor="middle" class="tick">${lab}</text>`;
  }
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 38}" text-anchor="middle" class="axname">insertion-loss tabanı α·v (dB/ms, log)</text>`;
  const smfFloor = meds.find(m => m.key === "smf").floorDbPerMs;
  meds.forEach((m, i) => {
    const cy = L2.t + (i + 0.5) / meds.length * ih2;
    const col = m.key === "smf" ? "k1" : (m.vsSmf < 1 ? "k3" : "k2");
    g2 += `<rect x="${L2.l}" y="${cy - bh / 2}" width="${X2(m.floorDbPerMs) - L2.l}" height="${bh}" fill="var(--${col})" opacity="0.85"/>`;
    g2 += `<text x="${L2.l - 8}" y="${cy + 4}" text-anchor="end" class="tick" style="font-size:10px">${esc(m.name)}</text>`;
    const lbl = m.key === "smf" ? "referans" : (m.vsSmf < 1 ? `×${tr(m.vsSmf, 2)} iyi` : `×${tr(m.vsSmf, 0)} KÖTÜ`);
    g2 += `<text x="${X2(m.floorDbPerMs) + 6}" y="${cy + 4}" class="anno" fill="var(--${col})">${lbl}</text>`;
    const tip = `${esc(m.name)}<br/>α ${tr(m.alphaDbPerM)} dB/m · taban <b>${tr(m.floorDbPerMs, 1)} dB/ms</b><br/>3 dB'de ${tr(m.maxHoldUs, 2)} μs tutma`;
    g2 += `<g class="row" data-tip="${esc(tip)}"><rect x="${L2.l}" y="${cy - bh / 2 - 2}" width="${iw2}" height="${bh + 4}" fill="transparent"/></g>`;
  });
  g2 += `<line x1="${X2(smfFloor)}" y1="${L2.t}" x2="${X2(smfFloor)}" y2="${L2.t + ih2}" stroke="var(--k1)" stroke-width="1.3" stroke-dasharray="4 4"/>`;

  // ══ 3) REJİM & SENTEZ — en çok tutma (log μs→ms) ══
  const L3 = { w: 790, h: 150, l: 60, r: 96, t: 22, b: 44 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const hMin = 0.1, hMax = 1e5;   // μs log (0.1 μs .. 100 ms)
  const lh = (v) => Math.log10(Math.max(v, hMin));
  const X3 = (us) => L3.l + (lh(us) - lh(hMin)) / (lh(hMax) - lh(hMin)) * iw3;
  let g3 = "";
  for (const gx of [0.1, 1, 10, 100, 1000, 1e4, 1e5]) {
    g3 += `<line x1="${X3(gx)}" y1="${L3.t}" x2="${X3(gx)}" y2="${L3.t + ih3}" stroke="var(--grid)" stroke-width="1" opacity="0.5"/>`;
    const lab = gx >= 1000 ? `${tr(gx / 1000)} ms` : `${tr(gx)} μs`;
    g3 += `<text x="${X3(gx)}" y="${L3.t + ih3 + 16}" text-anchor="middle" class="tick">${lab}</text>`;
  }
  // fiber kayıp-duvarı rejimi (μs) vs kuantum bellek faz-duvarı (ms)
  const yA = L3.t + 24;
  // fiber medya noktaları
  const fiberMeds = meds.filter(m => m.vsSmf <= 1);
  for (const m of fiberMeds) {
    const col = m.key === "smf" ? "k1" : "k3";
    g3 += `<circle cx="${X3(m.maxHoldUs)}" cy="${yA}" r="4" fill="var(--${col})"/>`;
  }
  const smfMax = meds.find(m => m.key === "smf").maxHoldUs;
  const hollowMax = meds.find(m => m.key === "hollowCore").maxHoldUs;
  g3 += `<line x1="${X3(smfMax)}" y1="${yA}" x2="${X3(hollowMax)}" y2="${yA}" stroke="var(--k3)" stroke-width="2"/>`;
  g3 += `<text x="${X3(smfMax)}" y="${yA - 10}" text-anchor="middle" class="anno k1t">fiber KAYIP duvarı ~${tr(smfMax, 0)}–${tr(hollowMax, 0)} μs</text>`;
  // sentez noktası
  g3 += `<circle cx="${X3(SY.holdUs)}" cy="${yA}" r="5.5" fill="none" stroke="var(--k3)" stroke-width="2"/>`;
  g3 += `<text x="${X3(SY.holdUs)}" y="${yA + 20}" text-anchor="middle" class="anno k3t">sentez: ${tr(SY.steps)} adım×hollow · %${tr(SY.survivalPct)}</text>`;
  // kuantum bellek faz-duvarı (ms)
  const qmUs = QM.phaseBoundHoldVsFiberUs;
  g3 += `<circle cx="${X3(qmUs)}" cy="${yA}" r="5" fill="var(--k2)"/>`;
  g3 += `<text x="${X3(qmUs)}" y="${yA - 10}" text-anchor="middle" class="anno k2t">kuantum bellek FAZ duvarı ~${tr(QM.phaseBoundHoldMs)} ms</text>`;
  g3 += `<text x="${L3.l + iw3 / 2}" y="${L3.t + ih3 + 36}" text-anchor="middle" class="axname">en çok tutma süresi (log) — kayıp rejimi (μs) vs faz rejimi (ms)</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ODLS taban optimizasyonu</title>
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
  h2{font-size:14px;margin:30px 0 4px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:104px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type,.row:hover rect:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>ODLS taban kaybını düşürmek — iki kaldıraç, ölçümle</h1>
<p class="sub">ODLS'nin bağlayıcı bedeli fiber tabanı = α·v·tutma. İki yol var: (1) PJA'yı agresifleştirip TUTMA SÜRESİNİ kısalt, (2) TABAN α·v'yi düşür (ortam). İz 1 gerçek ve nerdeyse bedava; İz 2'nin "çip < 0,1 dB/m" önermesi <b>ters</b> — SMF zaten 0,0002 dB/m, bilinen en düşük kayıplı ortam. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">9→5 adım tutma</div><div class="v">54→30 μs</div></div>
  <div class="tile"><div class="l">taban kaybı</div><div class="v">2,21→1,23 dB</div></div>
  <div class="tile"><div class="l">Si₃N₄ çip</div><div class="v">×386 kötü</div></div>
  <div class="tile"><div class="l">sentez sağkalım</div><div class="v">%${tr(SY.baselineSurvivalPct)}→%${tr(SY.survivalPct)}</div></div>
</div>

<h2>1 · İz 1 — PJA agresifleştir (adım↓ ⇒ taban↓, ama sınırlı)</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="PJA agresifleştirme">${g1}</svg>
<p class="note">Taban tutma süresiyle DOĞRUSAL: adımı 9→5'e düşürmek tabanı ${tr(T1.baseline.floorDb, 2)}→${tr(T1.target.floorDb, 2)} dB'ye indirir, uçurum payını ×${tr(T1.target.cliffMarginUs / T1.baseline.cliffMarginUs, 1)} açar — kararlı-durum bedeli yalnız %${tr(T1.target.ssDropTightPct, 1)} (nokta altı etiketler). Ama sınırsız değil: 5 adımdan sonra kazanç doyar, dar-pencere drop süper-doğrusal patlar (gölgeli bölge). Model tabanı ~2 adım (sabit-hızlı Kalman ≥2 ölçüm ister).</p>

<h2>2 · İz 2 — ortam tabanı: önerme ters</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Ortam tabanı">${g2}</svg>
<p class="note">Depolamada önemli olan dB/METRE değil <b>dB/ZAMAN = α·v</b>. SMF (0,0002 dB/m) bilinen en düşük kayıplı optik ortamdır; Si₃N₄ çip (0,1 dB/m) tabanı ×386, Si tel ×175.000 <b>YÜKSELTİR</b> — çip kayıpta değil ayak izinde kazanır. Tabanı gerçekten düşüren: ultra-düşük-kayıp silika (×1,4) ve hollow-core NANF (×1,7, düşük α + hava çekirdek) — gerçek ama mütevazı.</p>

<h2>3 · Rejim & sentez — kayıp duvarı vs faz duvarı</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Rejim ve sentez">${g3}</svg>
<p class="note">Fiber ODLS kayıp rejiminde ~${tr(meds.find(m => m.key === "smf").maxHoldUs, 0)}–${tr(meds.find(m => m.key === "hollowCore").maxHoldUs, 0)} μs tavana çarpar. Kriyo bu tavanı açmaz (silika α'sı %96 Rayleigh, çekimde donmuş). Tabanı BÜSBÜTÜN aşmak isteyen: gerçek kuantum bellek (t₂=${tr(QM.t2Ms)} ms) — depolama propagasyonla değil, ~${tr(QM.phaseBoundHoldMs)} ms tutar; ama kayıp duvarı yerine FAZ/T2 duvarına çarpar (yazma/okuma verimi + dekoherans bedeli). İki GERÇEK kaldıracı yığ (5 adım × hollow-core): sağkalım %${tr(SY.baselineSurvivalPct)}→%${tr(SY.survivalPct)}.</p>

<div class="callout"><b>Karar:</b> İz 1 (PJA'yı 5 adıma agresifleştir) doğru kaldıraç — taban tutma süresiyle doğrusal, kazanç nerdeyse bedava, çekirdek/donanım değişmez. İz 2 dikkatli okunmalı: <b>çip dalga kılavuzu tabanı ×386 kötüleştirir</b> (ayak izinde kazanır, kayıpta değil); tabanı gerçekten düşüren yalnız hollow-core NANF (×1,7). Kriyo fiber kaybını açmaz — payı bir kuantum belleğin T2'sinde. Tabanı <i>büsbütün</i> aşmak kuantum bellek ister ama bu sefer faz/T2 duvarına çarpılır (check-C rejimi). Pratik reçete: <b>5-adım PJA + hollow-core</b> → %82 sağkalım, çekirdeğe dokunmadan.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/optical_delay_line.js</code> (MEDIA + mediumFloor) + <code>predictive_jitter_alignment.js</code> (q-sweep) + <code>odls_optimization_drill.js</code>. Çekirdek SHA-256 değişmedi.</p>
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

function sup(n) { const m = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷" }; return String(n).split("").map(c => m[c] || c).join(""); }

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "odls_optimization.json");
  const outPath = process.argv[3] || "/tmp/odls_optimization_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
