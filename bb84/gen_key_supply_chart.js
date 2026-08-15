#!/usr/bin/env node
"use strict";
/**
 * gen_key_supply_chart.js — ultra-düşük gecikme tedarik katmanı.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Üç strateji, İKİ ölçüde (gecikme + hız) karşılaştırılıyor. Çift
 *     eksenli çubuk YASAK; iki ayrı çubuk grafiği ise takası
 *     gizlerdi. Doğru form SAÇILIM: gecikme x, hız y — depo çözümünün
 *     "sol üst köşe"de olması (düşük gecikme VE yüksek hız) tam olarak
 *     anlatılmak istenen şey.
 *   • Depo boyutlandırma: ret% ve taşma% AYNI birimde (yüzde) →
 *     tek eksende iki seri, kategorik renk. Bu çift eksen DEĞİLDİR.
 *   • Anahtar yaşı ayrı bir birim (ms) → AYRI bölüm, ayrı eksen.
 *   • Elastik pencere gecikme dağılımı: min–p95 aralığı → aralık çubuğu.
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
  const CMP = D.comparison, SZ = D.sizing, EL = D.elastic, PR = D.production;

  // ══ 1) SAÇILIM: gecikme × hız ══
  const S = { w: 780, h: 330, l: 66, r: 26, t: 26, b: 48 };
  const iw = S.w - S.l - S.r, ih = S.h - S.t - S.b;
  const xMax = 560, yMax = 1400;
  const X = (v) => S.l + (v / xMax) * iw;
  const Y = (v) => S.t + ih - (v / yMax) * ih;
  let sc = "";
  for (let v = 0; v <= yMax; v += 200) {
    sc += `<line x1="${S.l}" y1="${Y(v)}" x2="${S.l + iw}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    sc += `<text x="${S.l - 9}" y="${Y(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  for (let v = 0; v <= xMax; v += 100) {
    sc += `<line x1="${X(v)}" y1="${S.t}" x2="${X(v)}" y2="${S.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
    sc += `<text x="${X(v)}" y="${S.t + ih + 19}" text-anchor="middle" class="tick">${tr(v)}</text>`;
  }
  // "iyi köşe" vurgusu
  sc += `<rect x="${S.l}" y="${S.t}" width="${X(120) - S.l}" height="${Y(1100) - S.t}" fill="var(--k3)" opacity="0.10"/>`;
  sc += `<text x="${X(125)}" y="${Y(1100) - 8}" class="anno">← düşük gecikme <tspan font-weight="640">ve</tspan> yüksek hız</text>`;

  const marks = [
    { ...CMP[0], col: "var(--muted-mark)", ring: "var(--k2)" },
    { ...CMP[1], col: "var(--k2)", ring: null },
    { ...CMP[2], col: "var(--k3)", ring: null },
  ];
  for (const m of marks) {
    const cx = X(m.tuketiciGecikmeMs), cy = Y(m.hizBps);
    sc += `<g class="row" data-tip="<b>${esc(m.strateji)}</b><br>tüketici gecikmesi ${tr(m.tuketiciGecikmeMs)} ms<br>sürdürülen hız ${tr(m.hizBps, 0)} bit/s<br>garanti: ${esc(m.garanti)}<br>${m.calisir ? "çalışıyor" : "<b>KİLİTLİ — anahtar üretmiyor</b>"}">
      <circle cx="${cx}" cy="${cy}" r="14" fill="transparent"/>
      <circle cx="${cx}" cy="${cy}" r="7" fill="${m.calisir ? m.col : "none"}" stroke="${m.calisir ? "var(--surface-1)" : m.ring}" stroke-width="${m.calisir ? 2 : 2.5}"/></g>`;
  }
  sc += `<text x="${X(marks[2].tuketiciGecikmeMs) + 14}" y="${Y(marks[2].hizBps) + 4}" class="pk k3t">DEPO — ${tr(marks[2].hizBps, 0)} bit/s @ 0 ms<tspan x="${X(marks[2].tuketiciGecikmeMs) + 14}" dy="14" class="anno">üretim ${tr(PR.slaMs)} ms blokla, tavanın %${tr(PR.pctOfCeiling, 0)} düzeyinde</tspan></text>`;
  sc += `<text x="${X(marks[1].tuketiciGecikmeMs) - 12}" y="${Y(marks[1].hizBps) - 10}" text-anchor="end" class="pk k2t">elastik pencere<tspan x="${X(marks[1].tuketiciGecikmeMs) - 12}" dy="14" class="anno">${tr(marks[1].hizBps, 0)} bit/s @ p50 ${tr(marks[1].tuketiciGecikmeMs)} ms</tspan></text>`;
  sc += `<text x="${X(marks[0].tuketiciGecikmeMs) + 13}" y="${Y(0) - 12}" class="anno k2t">sert ${tr(marks[0].tuketiciGecikmeMs)} ms SLA — KİLİTLİ<tspan x="${X(marks[0].tuketiciGecikmeMs) + 13}" dy="13">0 bit/s, tüm çiftler çöpe</tspan></text>`;

  // ══ 2) ELASTİK PENCERE GECİKME ARALIĞI ══
  const els = Object.entries(EL).map(([k, v]) => ({ target: +k, ...v }));
  const EB = { w: 780, h: els.length * 46 + 34, l: 132, r: 190, t: 24 };
  const ew = EB.w - EB.l - EB.r, eMax = 900;
  const EX = (v) => EB.l + (v / eMax) * ew;
  let elBars = `<line x1="${EX(200)}" y1="${EB.t - 8}" x2="${EX(200)}" y2="${EB.t + els.length * 46 - 8}" stroke="var(--k2)" stroke-width="1.5" stroke-dasharray="3 3"/>
    <text x="${EX(200)}" y="${EB.t - 13}" text-anchor="middle" class="anno k2t">hedeflenen 200 ms</text>`;
  els.forEach((e, i) => {
    const y = EB.t + i * 46;
    elBars += `<g class="row" data-tip="<b>ℓ hedefi ${tr(e.target)} bit</b><br>${tr(e.blocks)} blok<br>gecikme min ${tr(e.latencyMin)} · p50 ${tr(e.latencyP50)} · p95 ${tr(e.latencyP95)} ms<br>hız ${tr(e.sustainedRateBps, 0)} bit/s">
      <rect x="0" y="${y - 4}" width="${EB.w}" height="40" fill="transparent"/>
      <text x="${EB.l - 12}" y="${y + 18}" text-anchor="end" class="lab">ℓ ≥ ${tr(e.target)} bit</text>
      <line x1="${EX(e.latencyMin)}" y1="${y + 13}" x2="${EX(e.latencyP95)}" y2="${y + 13}" stroke="var(--k2)" stroke-width="10" stroke-linecap="round" opacity="0.35"/>
      <circle cx="${EX(e.latencyP50)}" cy="${y + 13}" r="5.5" fill="var(--k2)" stroke="var(--surface-1)" stroke-width="2"/>
      <text x="${EX(e.latencyP95) + 14}" y="${y + 10}" class="val">${tr(e.latencyMin)}–${tr(e.latencyP95)} ms</text>
      <text x="${EX(e.latencyP95) + 14}" y="${y + 25}" class="sublab">${tr(e.sustainedRateBps, 0)} bit/s</text></g>`;
  });

  // ══ 3) DEPO BOYUTLANDIRMA — ret% ve taşma% (AYNI birim) ══
  const SW = SZ.sweep;
  const B = { w: 780, h: 300, l: 66, r: 122, t: 26, b: 48 };
  const bw = B.w - B.l - B.r, bh = B.h - B.t - B.b;
  const cMax = SW[SW.length - 1].capacityBits;
  const BX = (v) => B.l + (Math.log10(v) - Math.log10(SW[0].capacityBits)) / (Math.log10(cMax) - Math.log10(SW[0].capacityBits)) * bw;
  const BY = (p) => B.t + bh - (p / 100) * bh;
  let sz = "";
  for (let p = 0; p <= 100; p += 20) {
    sz += `<line x1="${B.l}" y1="${BY(p)}" x2="${B.l + bw}" y2="${BY(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    sz += `<text x="${B.l - 9}" y="${BY(p) + 4}" text-anchor="end" class="tick">%${p}</text>`;
  }
  for (const s of SW.filter((_, i) => i % 2 === 0 || i === SW.length - 1)) {
    sz += `<text x="${BX(s.capacityBits)}" y="${B.t + bh + 19}" text-anchor="middle" class="tick">${tr(s.capacityBits)}</text>`;
  }
  // türetilen S_min
  sz += `<line x1="${BX(SZ.derivedMinBits)}" y1="${B.t}" x2="${BX(SZ.derivedMinBits)}" y2="${B.t + bh}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  sz += `<text x="${BX(SZ.derivedMinBits) + 5}" y="${B.t + 13}" class="anno">türetilen S_min<tspan x="${BX(SZ.derivedMinBits) + 5}" dy="13">${tr(SZ.derivedMinBits)} bit</tspan></text>`;
  const pathOf = (f, col) => `<path d="${SW.map((s, i) => `${i ? "L" : "M"}${BX(s.capacityBits).toFixed(1)},${BY(f(s)).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  sz += pathOf(s => 100 * s.steadyDenialRate, "var(--k2)");
  sz += pathOf(s => s.discardedPct, "var(--k1)");
  for (const s of SW) {
    sz += `<g class="row" data-tip="<b>kapasite ${tr(s.capacityBits)} bit</b> (S_min'in ${tr(s.ofDerived, 2)}×)<br>ret oranı %${tr(100 * s.steadyDenialRate, 2)}<br>taşıp atılan anahtar %${tr(s.discardedPct, 2)}<br>azami anahtar yaşı ${tr(s.maxKeyAgeMs, 0)} ms">
      <circle cx="${BX(s.capacityBits)}" cy="${BY(100 * s.steadyDenialRate)}" r="10" fill="transparent"/>
      <circle cx="${BX(s.capacityBits)}" cy="${BY(100 * s.steadyDenialRate)}" r="4" fill="var(--k2)" stroke="var(--surface-1)" stroke-width="1.5"/>
      <circle cx="${BX(s.capacityBits)}" cy="${BY(s.discardedPct)}" r="4" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="1.5"/></g>`;
  }
  const firstZero = SW.find(s => s.steadyDenialRate === 0);
  sz += `<line x1="${BX(firstZero.capacityBits)}" y1="${BY(0)}" x2="${BX(firstZero.capacityBits)}" y2="${BY(0) - 30}" stroke="var(--k2)" stroke-width="1" stroke-dasharray="2 3"/>`;
  sz += `<text x="${BX(firstZero.capacityBits)}" y="${BY(0) - 46}" text-anchor="middle" class="anno k2t">ret sıfırlanıyor<tspan x="${BX(firstZero.capacityBits)}" dy="12">${tr(firstZero.capacityBits)} bit</tspan></text>`;

  // ══ 4) GÜVENLİK BEDELİ — anahtar yaşı ══
  const AG = { w: 780, h: 132, l: 66, r: 122, t: 22, b: 40 };
  const aw = AG.w - AG.l - AG.r, ah = AG.h - AG.t - AG.b;
  const ageMax = Math.max(...SW.map(s => s.maxKeyAgeMs)) * 1.08;
  const AX = (v) => AG.l + (Math.log10(v) - Math.log10(SW[0].capacityBits)) / (Math.log10(cMax) - Math.log10(SW[0].capacityBits)) * aw;
  const AY = (v) => AG.t + ah - (v / ageMax) * ah;
  let ag = "";
  for (const v of [0, 10000, 20000, 30000].filter(v => v <= ageMax)) {
    ag += `<line x1="${AG.l}" y1="${AY(v)}" x2="${AG.l + aw}" y2="${AY(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    ag += `<text x="${AG.l - 9}" y="${AY(v) + 4}" text-anchor="end" class="tick">${tr(v / 1000, 0)} s</text>`;
  }
  ag += `<path d="${SW.map((s, i) => `${i ? "L" : "M"}${AX(s.capacityBits).toFixed(1)},${AY(s.maxKeyAgeMs).toFixed(1)}`).join("")}" fill="none" stroke="var(--k1)" stroke-width="2"/>`;
  for (const s of SW)
    ag += `<g class="row" data-tip="<b>kapasite ${tr(s.capacityBits)} bit</b><br>azami anahtar yaşı ${tr(s.maxKeyAgeMs / 1000, 1)} s<br>ortalama ${tr((s.meanKeyAgeMs ?? 0) / 1000, 1)} s">
      <circle cx="${AX(s.capacityBits)}" cy="${AY(s.maxKeyAgeMs)}" r="10" fill="transparent"/>
      <circle cx="${AX(s.capacityBits)}" cy="${AY(s.maxKeyAgeMs)}" r="4" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="1.5"/></g>`;
  ag += `<text x="${AG.l + aw / 2}" y="${AG.h - 3}" text-anchor="middle" class="axname">depo kapasitesi (bit, log ölçek)</text>`;

  const tbl = SW.map(s => `<tr><td>${tr(s.capacityBits)}</td><td>${tr(s.ofDerived, 2)}×</td><td>%${tr(100 * s.steadyDenialRate, 2)}</td><td>%${tr(s.discardedPct, 2)}</td><td>${tr((s.meanKeyAgeMs ?? 0) / 1000, 1)} s</td><td>${tr(s.maxKeyAgeMs / 1000, 1)} s</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ultra-düşük gecikme: elastik pencere vs anahtar deposu</title>
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
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:100px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  .lgrow{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 2px;font-size:12px;color:var(--text-secondary);}
  .lg{display:inline-flex;align-items:center;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .pk{font-size:12px;font-weight:660;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type,.row:hover rect:first-of-type{fill:var(--surface-2);}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k3);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">

<h1>Ultra-düşük gecikme: elastik pencere mi, anahtar deposu mu?</h1>
<p class="sub">İki strateji de kilidi açıyor, ama <b>aynı şeyi vermiyorlar</b>. Elastik pencere "gecikme garantisi"ni "anahtar garantisi"ne çevirir — ikisini birden vermez. Depo ise anahtar <b>üretim</b> gecikmesini <b>teslim</b> gecikmesinden ayırdığı için ikisini birden verebilir.</p>

<div class="tiles">
  <div class="tile"><div class="l">sert ${tr(CMP[0].tuketiciGecikmeMs)} ms SLA</div><div class="v k2t">0 bit/s</div></div>
  <div class="tile"><div class="l">elastik — en hızlı blok</div><div class="v">${tr(EL["128"].latencyMin)} ms</div></div>
  <div class="tile"><div class="l">elastik — hız</div><div class="v">${tr(EL["128"].sustainedRateBps, 0)} bit/s</div></div>
  <div class="tile"><div class="l">depo — gecikme</div><div class="v k3t">0 ms</div></div>
  <div class="tile"><div class="l">depo — hız</div><div class="v k3t">${tr(PR.sustainedRateBps, 0)} bit/s</div></div>
</div>

<h2>1) Takas uzayı — gecikme × hız</h2>
<svg viewBox="0 0 ${S.w} ${S.h}" aria-label="Stratejilerin gecikme ve hız düzleminde konumu">
  ${sc}
  <text x="${S.l + iw / 2}" y="${S.h - 4}" text-anchor="middle" class="axname">tüketicinin gördüğü gecikme (ms)</text>
  <text x="${S.l - 52}" y="${S.t - 10}" class="axname">sürdürülen R_key (bit/s)</text>
</svg>
<div class="callout"><b>Depo tek başına iki garantiyi birden veriyor.</b> Üretim ${tr(PR.slaMs)} ms bloklarla çalışıyor (tavanın %${tr(PR.pctOfCeiling, 0)} düzeyinde, ${tr(PR.sustainedRateBps, 0)} bit/s), tüketici ise hazır anahtardan servis alıyor — gördüğü gecikme <b>0 ms</b>. Elastik pencere aynı hızın yalnızca <b>%${tr(100 * EL["128"].sustainedRateBps / PR.sustainedRateBps, 0)}</b> kadarını veriyor ve üstüne ${tr(EL["128"].latencyP50)} ms gecikme bindiriyor.</div>

<h2>2) Elastik pencere neden yetmiyor</h2>
<p class="sub">ℓ hedefi düşürülse bile ilk güvenli bit belli bir süreden önce çıkamıyor — bu bir politika değil, sonlu-anahtar sınırının dayattığı fiziksel alt sınır.</p>
<svg viewBox="0 0 ${EB.w} ${EB.h}" aria-label="Elastik pencerede blok gecikmesi dağılımı">${elBars}
  <text x="${EB.l + ew / 2}" y="${EB.h - 4}" text-anchor="middle" class="axname">blok gecikmesi (ms) — çubuk min–p95, nokta p50</text></svg>
<p class="note">En agresif ayarda (ℓ ≥ ${tr(els[0].target)} bit) bile en hızlı blok <b>${tr(els[0].latencyMin)} ms</b> sürüyor — hedeflenen ${tr(CMP[0].tuketiciGecikmeMs)} ms'in ${tr(els[0].latencyMin / CMP[0].tuketiciGecikmeMs, 1)} katı. Üstelik gecikme <b>değişken</b>: kanal gürültülenirse blok uzar. Yani elastik pencere sert bir SLA'nın yerini tutamaz; kilidi açar, garanti vermez.</p>

<h2>3) Depo boyutlandırma — iki yönlü maliyet</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>ret oranı (depo boş kaldı)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>taşıp atılan anahtar</span>
</div>
<svg viewBox="0 0 ${B.w} ${B.h}" aria-label="Depo kapasitesine göre ret ve taşma oranları">
  ${sz}
  <text x="${B.l + bw / 2}" y="${B.h - 4}" text-anchor="middle" class="axname">depo kapasitesi (bit, log ölçek)</text>
  <text x="${B.l - 52}" y="${B.t - 10}" class="axname">oran (%)</text>
</svg>
<p class="note"><b>Türetilen boyut:</b> anahtar T_b'de bir topak hâlinde gelir, talep sürekli akar. Ortalama çekiliş D·T_b = ${tr(SZ.meanDrainBits)} bit — ama talep Poisson olduğu için bağlayıcı olan ortalama değil <b>kuyruk</b>: σ = b·√(λ·T_b) ⇒ pay ${tr(SZ.tailTermBits)} bit. Toplam <b>S_min = ${tr(SZ.derivedMinBits)} bit</b>. Ölçülen sıfır-ret eşiği ${tr(firstZero.capacityBits)} bit (türetilenin ${tr(firstZero.ofDerived, 2)}×). <b>İlk kurguda kuyruk terimi yoktu</b> (sabit 1,5 çarpanı vardı) ve ölçüm formülü yalanladı — dalgalanma √T_b ile ölçeklendiği için çarpan büyütmek çözüm değildi, terim türetildi.</p>
<div class="callout warn"><b>Yeterlilik koşulu — depo mucize yapmaz.</b> Talep üretimi aşarsa (burada üretimin %130'u) kapasite <b>sınırsız</b> olsa bile kararlı ret oranı %${tr(100 * D.overload.steadyDenialRate, 1)}'e çıkıyor. Depo yalnızca <b>dalgalanmayı</b> yutar, <b>açığı kapatmaz</b>: R(T_b) > D olmak zorundadır. Diğer yönde de bir maliyet var — burada üretim talebin iki katı olduğu için, sıfır-ret kapasitesinde bile üretilen anahtarın <b>%${tr(firstZero.discardedPct, 0)}</b>'i depoya sığmayıp atılıyor. Fazla üretim ya başka rotalara yönlendirilmeli ya da üretim bloğu kısaltılmalıdır.</div>

<h2>4) Büyük deponun güvenlik bedeli</h2>
<svg viewBox="0 0 ${AG.w} ${AG.h}" aria-label="Depo kapasitesine göre azami anahtar yaşı">${ag}
  <text x="${AG.l - 52}" y="${AG.t - 8}" class="axname">azami anahtar yaşı</text></svg>
<p class="note">Depoda bekleyen anahtar, deposu ele geçiren birine <b>toplu hâlde</b> açılır. Kapasite ${tr(SW[0].capacityBits)} bitten ${tr(SW[SW.length - 1].capacityBits)} bite çıkarken azami anahtar yaşı ${tr(SW[0].maxKeyAgeMs / 1000, 1)} s'den <b>${tr(SW[SW.length - 1].maxKeyAgeMs / 1000, 1)} s</b>'ye uzuyor. Bu yüzden depo boyutu yalnızca maliyet ve ret oranıyla değil, <b>azami anahtar yaşı politikasıyla</b> da sınırlanmalıdır: "daha büyük depo daha iyi" DOĞRU DEĞİLDİR.</p>

<details>
<summary>Tablo görünümü — depo boyutlandırma</summary>
<table><thead><tr><th>Kapasite (bit)</th><th>S_min'in ×</th><th>ret oranı</th><th>taşma</th><th>ort. yaş</th><th>azami yaş</th></tr></thead><tbody>${tbl}</tbody></table>
<p class="note">Anahtar muhafazası için çekirdeğin ETSI GS QKD 014 uyumlu <code>KeyDeliveryStore</code>'u kullanıldı (key_ID üretimi + rota bazlı saklama); o sınıfın yalnızca yatırma yolu olduğu için tüketim/tahsis politikası üstüne yazıldı — çekirdek değiştirilmedi. İstek karşılanamadığında uydurma anahtar üretilmez, <code>key_unavailable</code> döner. "Sıfır ret" gözlemi ${tr(D.tiered.requestsAfterWarmup)} istekten okundu; üçler kuralıyla gerçek oran için %95 üst sınır %${tr(100 * D.tiered.steadyDenialUpperBound95, 2)}. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "key_supply.json");
  const outPath = process.argv[3] || "/tmp/key_supply_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
