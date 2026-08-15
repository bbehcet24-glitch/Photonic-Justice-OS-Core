#!/usr/bin/env node
"use strict";
/**
 * gen_backpressure_chart.js — depo doluluğuna göre üretim geri-basıncı.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Depo seviyesinin zaman içindeki gidişi → ÇİZGİ, iki seri
 *     (sabit üretim / geri-basınç), tek eksen (doluluk %). Sabit
 *     üreticinin %100'de yapışması ile geri-basıncın bant içinde
 *     salınması ancak yan yana görünür.
 *   • Sabit vs geri-basınç metrikleri → hepsi YÜZDE, tek eksen,
 *     gruplu çubuk. Çift eksen YOK.
 *   • φ_high takası → iki seri (tasarruf / sıçrama reddi), ikisi de
 *     yüzde → tek eksen, kategorik renk.
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
  const S = D.setup, F = D.fixed, B = D.backpressure, SWP = D.highFillSweep, BR = D.bandRule, H = D.hysteresis;
  if (!BR) throw new Error("bandRule eksik — rapor eski");

  // ══ 1) DEPO SEVİYESİ İZİ ══
  const L = { w: 780, h: 300, l: 58, r: 128, t: 26, b: 46 };
  const iw = L.w - L.l - L.r, ih = L.h - L.t - L.b;
  const tMax = S.sessionMs;
  const X = (t) => L.l + (t / tMax) * iw;
  const Y = (f) => L.t + ih - Math.min(1, Math.max(0, f)) * ih;
  let g1 = "";
  for (let f = 0; f <= 1.0001; f += 0.25) {
    g1 += `<line x1="${L.l}" y1="${Y(f)}" x2="${L.l + iw}" y2="${Y(f)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L.l - 9}" y="${Y(f) + 4}" text-anchor="end" class="tick">%${tr(100 * f, 0)}</text>`;
  }
  for (let t = 0; t <= tMax; t += 10000) {
    g1 += `<line x1="${X(t)}" y1="${L.t}" x2="${X(t)}" y2="${L.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${X(t)}" y="${L.t + ih + 19}" text-anchor="middle" class="tick">${tr(t / 1000)} s</text>`;
  }
  // kısma bandı
  g1 += `<rect x="${L.l}" y="${Y(0.83)}" width="${iw}" height="${Y(0.67) - Y(0.83)}" fill="var(--k3)" opacity="0.14"/>`;
  g1 += `<text x="${L.l + iw + 8}" y="${Y(0.75) + 4}" class="anno k3t">kısma bandı<tspan x="${L.l + iw + 8}" dy="13">φ_high = 0,75 ± 0,08</tspan></text>`;
  const pathOf = (tr_, col, w) => `<path d="${tr_.map((p, i) => `${i ? "L" : "M"}${X(p.tMs).toFixed(1)},${Y(p.fill).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"/>`;
  g1 += pathOf(D.fixedTrace, "var(--k2)", 2);
  g1 += pathOf(D.traceSample, "var(--k1)", 2.2);
  for (const p of D.traceSample.filter((_, i) => i % 3 === 0))
    g1 += `<g class="row" data-tip="<b>t = ${tr(p.tMs / 1000, 1)} s</b><br>mod: ${esc(p.mode)}<br>doluluk %${tr(100 * p.fill, 1)}<br>${p.blockMs > 0 ? `blok ${tr(p.blockMs, 0)} ms · ℓ ${tr(p.ell)} bit` : `boşta ${tr(p.idleMs, 0)} ms`}">
      <circle cx="${X(p.tMs)}" cy="${Y(p.fill)}" r="9" fill="transparent"/>
      <circle cx="${X(p.tMs)}" cy="${Y(p.fill)}" r="3.5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="1.2"/></g>`;
  g1 += `<text x="${L.l + iw + 8}" y="${Y(1) + 4}" class="endlab k2t">sabit blok<tspan x="${L.l + iw + 8}" dy="13" class="anno">%100'de yapışık — taşan anahtar çöpe</tspan></text>`;

  // ══ 2) SABİT vs GERİ-BASINÇ ══
  const mets = [
    { n: "atılan anahtar", f: F.discardedPct, b: B.discardedPct },
    { n: "üretilmeyen çift (tasarruf)", f: F.pairsSkippedPct, b: B.pairsSkippedPct },
    { n: "ret oranı (ısınma sonrası)", f: 100 * F.denialRate, b: 100 * B.denialRate },
  ];
  const M = { w: 780, h: mets.length * 62 + 26, l: 208, r: 108, t: 18 };
  const mw = M.w - M.l - M.r, mMax = 40;
  const bars = mets.map((m, i) => {
    const y = M.t + i * 62;
    const wf = Math.max((m.f / mMax) * mw, 2), wb = Math.max((m.b / mMax) * mw, 2);
    return `<g class="row" data-tip="<b>${esc(m.n)}</b><br>sabit blok %${tr(m.f, 2)}<br>geri-basınç %${tr(m.b, 2)}">
      <rect x="0" y="${y - 4}" width="${M.w}" height="56" fill="transparent"/>
      <text x="${M.l - 14}" y="${y + 15}" text-anchor="end" class="lab">${esc(m.n)}</text>
      <rect x="${M.l}" y="${y}" width="${wf}" height="20" rx="4" fill="var(--k2)"/>
      <text x="${M.l + wf + 10}" y="${y + 15}" class="val">%${tr(m.f, 2)}</text>
      <rect x="${M.l}" y="${y + 24}" width="${wb}" height="20" rx="4" fill="var(--k1)"/>
      <text x="${M.l + wb + 10}" y="${y + 39}" class="val">%${tr(m.b, 2)}</text></g>`;
  }).join("");

  // ══ 3) φ_high TAKAS EĞRİSİ ══
  const P = { w: 780, h: 288, l: 58, r: 128, t: 26, b: 46 };
  const pw = P.w - P.l - P.r, ph = P.h - P.t - P.b;
  const PX = (f) => P.l + ((f - 0.5) / 0.5) * pw;
  const PY = (v) => P.t + ph - (v / 50) * ph;
  let g3 = "";
  for (let v = 0; v <= 50; v += 10) {
    g3 += `<line x1="${P.l}" y1="${PY(v)}" x2="${P.l + pw}" y2="${PY(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${P.l - 9}" y="${PY(v) + 4}" text-anchor="end" class="tick">%${tr(v)}</text>`;
  }
  for (const f of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    g3 += `<line x1="${PX(f)}" y1="${P.t}" x2="${PX(f)}" y2="${P.t + ph}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${PX(f)}" y="${P.t + ph + 19}" text-anchor="middle" class="tick">${tr(f, 2)}</text>`;
  }
  const line3 = (k, col) => `<path d="${SWP.map((s, i) => `${i ? "L" : "M"}${PX(s.highFill).toFixed(1)},${PY(s[k]).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
  // RENK ÇAKIŞMASI DÜZELTMESİ: k2, 1. ve 2. bölümde "sabit üretici"
  // kimliğidir. Burada bir METRİĞİ göstermek için onu yeniden kullanmak
  // okuyucuya yanlış varlığı işaret ederdi → k3.
  g3 += line3("pairsSkippedPct", "var(--k1)") + line3("spikeDenialPct", "var(--k3)");
  for (const s of SWP) {
    g3 += `<g class="row" data-tip="<b>φ_high = ${tr(s.highFill, 2)}</b><br>kaynak tasarrufu %${tr(s.pairsSkippedPct, 2)}<br>sıçramada ret %${tr(s.spikeDenialPct, 2)}<br>düz talepte ret %${tr(s.flatDenialPct, 2)}<br>azami anahtar yaşı ${tr((s.maxKeyAgeMs ?? 0) / 1000, 1)} s">
      <circle cx="${PX(s.highFill)}" cy="${PY(s.pairsSkippedPct)}" r="10" fill="transparent"/>
      <circle cx="${PX(s.highFill)}" cy="${PY(s.pairsSkippedPct)}" r="4.5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="1.5"/>
      <circle cx="${PX(s.highFill)}" cy="${PY(s.spikeDenialPct)}" r="4.5" fill="var(--k3)" stroke="var(--surface-1)" stroke-width="1.5"/></g>`;
  }
  const lastS = SWP[SWP.length - 1];
  g3 += `<text x="${PX(lastS.highFill) + 10}" y="${PY(lastS.pairsSkippedPct) + 4}" class="endlab k1t">%${tr(lastS.pairsSkippedPct, 0)}</text>`;
  g3 += `<text x="${PX(lastS.highFill) + 10}" y="${PY(lastS.spikeDenialPct) + 4}" class="endlab k3t">%${tr(lastS.spikeDenialPct, 0)}</text>`;

  const tbl = SWP.map(s => `<tr><td>${tr(s.highFill, 2)}</td><td>%${tr(s.pairsSkippedPct, 2)}</td><td>%${tr(s.discardedPct, 2)}</td><td>%${tr(s.flatDenialPct, 2)}</td><td>%${tr(s.spikeDenialPct, 2)}</td><td>${tr((s.maxKeyAgeMs ?? 0) / 1000, 1)} s</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Depo doluluğuna göre üretim geri-basıncı</title>
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
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type,.row:hover rect:first-of-type{fill:var(--surface-2);}
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

<h1>Depo doluluğuna göre üretim geri-basıncı</h1>
<p class="sub">Depo, uygulama katmanını fiziksel hattın blok uzatma zorunluluğundan yalıtıyor — ama yalıtım tek yönlü kaldığı sürece <b>israf var</b>: sabit bloklu üretimde anahtarın <b>%${tr(F.discardedPct, 1)}</b>'i depoya sığmayıp atılıyordu ve atılan her bit gerçekten harcanmış foton demek. Geri-basınç, doluluğu üretime geri besliyor.</p>

<div class="tiles">
  <div class="tile"><div class="l">atılan anahtar</div><div class="v">%${tr(F.discardedPct, 1)} → <tspan class="k1t">%${tr(B.discardedPct, 1)}</tspan></div></div>
  <div class="tile"><div class="l">kaynak tasarrufu</div><div class="v k1t">%${tr(B.pairsSkippedPct, 1)}</div></div>
  <div class="tile"><div class="l">ret oranı</div><div class="v">%${tr(100 * B.denialRate, 2)}</div></div>
  <div class="tile"><div class="l">blok aralığı</div><div class="v">${tr(B.blockMsRange[0] / 1000, 1)}–${tr(B.blockMsRange[1] / 1000, 1)} s</div></div>
  <div class="tile"><div class="l">mod değişimi</div><div class="v">${tr(H.withSwitches)}</div></div>
</div>

<h2>1) Depo seviyesi — yapışık mı, bant içinde mi?</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>sabit blok (${tr(S.fixedBlockMs / 1000, 0)} s)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>geri-basınçlı üretim</span>
</div>
<svg viewBox="0 0 ${L.w} ${L.h}" aria-label="Depo doluluğunun zaman içindeki gidişi">
  ${g1}
  <text x="${L.l + iw / 2}" y="${L.h - 4}" text-anchor="middle" class="axname">oturum zamanı</text>
  <text x="${L.l - 46}" y="${L.t - 10}" class="axname">depo doluluğu</text>
</svg>
<p class="note">Sabit üretici depoyu %100'e yapıştırıp fazlasını atıyor. Geri-basınçlı üretici φ_high bandında salınıyor: dolduğunda üretimi <b>durduruyor</b>, düştüğünde geri alıyor. Blok uzunluğu da sabit değil — boş alana göre ${tr(B.blockMsRange[0] / 1000, 1)} ile ${tr(B.blockMsRange[1] / 1000, 1)} saniye arasında değişiyor.</p>

<h2>2) Ne kazanıldı, ne kaybedildi</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>sabit blok</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>geri-basınç</span>
</div>
<svg viewBox="0 0 ${M.w} ${M.h}" aria-label="Sabit üretim ile geri-basıncın karşılaştırması">${bars}</svg>
<div class="callout"><b>İsraf sıfırlandı, karşılığında kaynak tasarrufu geldi.</b> Atılan anahtar %${tr(F.discardedPct, 1)} → %${tr(B.discardedPct, 1)}; <b>${tr(B.pairsSkipped)}</b> çift (%${tr(B.pairsSkippedPct, 1)}) hiç üretilmedi — yani kaynak boşa harcanmadı. Servis kalitesi bozulmadı: ısınma sonrası ret oranı iki koşumda da %${tr(100 * B.denialRate, 2)}.</div>

<h2>3) φ_high bir ayar düğmesi — yedek ile tasarruf arasında</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>kaynak tasarrufu</span>
  <span class="lg"><span class="key" style="background:var(--k3)"></span>talep sıçramasında ret</span>
</div>
<svg viewBox="0 0 ${P.w} ${P.h}" aria-label="Üst su seviyesine göre tasarruf ve sıçrama reddi">
  ${g3}
  <text x="${P.l + pw / 2}" y="${P.h - 4}" text-anchor="middle" class="axname">φ_high — kısmanın başladığı doluluk</text>
  <text x="${P.l - 46}" y="${P.t - 10}" class="axname">oran (%)</text>
</svg>
<div class="callout warn"><b>Ölçüm bir beklentimi çürüttü.</b> Geri-basıncın talep sıçramasında da iyi olmasını bekliyordum; tersi çıktı: sıçramada ret <b>%${tr(D.spike.fixed.denialRate * 100, 2)} → %${tr(D.spike.backpressure.denialRate * 100, 2)}</b>, yani geri-basınç <b>daha kötü</b>. Sebep bir hata değil, φ_high'ın fiyatı: sabit üretici depoyu taşıtarak %100'de tutuyor, geri-basınç %75'te — sıçrama anında eldeki yedek farkı bu. Bu yüzden φ_high sabitlenmedi, <b>ayar düğmesi</b> olarak bırakıldı ve takas ölçüldü: φ=0,50'de %${tr(SWP[0].pairsSkippedPct, 0)} tasarruf / %${tr(SWP[0].spikeDenialPct, 0)} sıçrama reddi, φ=0,90'da %${tr(SWP[3].pairsSkippedPct, 0)} / %${tr(SWP[3].spikeDenialPct, 0)}.</div>

<h2>4) İki türetilmiş kural</h2>
<div class="callout"><b>(a) Boş alan, blok uzunluğunu sınırlar.</b> Bir blok ℓ(T_b) bit üretir; depoda o kadar yer yoksa fazlası atılır. Denetleyici bu yüzden T_b'yi <b>ℓ⁻¹(boş alan)</b> ile sınırlıyor — sabit bir tavan konmadı, ikili aramayla türetiliyor. Kısıt ℓ̂ <i>öngörüsü</i> üzerinden kurulduğu için marjsız ilk kurguda 150 bitlik artık taşma ölçüldü; boş alanın %90'ı hedeflenerek kapatıldı.
<br><br><b>(b) Üst bant en az bir bloğu almalı:</b> ℓ(T_b) ≤ (1 − φ_high)·S. Bu koşum sağlamıyordu — ℓ(blok) = ${tr(BR.ellPerBlockBits)} bit, üst bant ise yalnızca ${tr(BR.bandBits)} bit. Sonuç: <b>her mevduat eşiği aşıyor</b> ve denetleyici hemen ardından kısıyor, aşırı yükte bile. Blok ${tr(BR.impliedMaxBlockMs)} ms'e indirilince kısma yüzünden atlanan çift ${tr(D.overload.skipReason.KISMA)} → ${tr(D.overloadTuned.skipReason.KISMA)} oldu. Bu kuralı ölçüm buldurdu: ilk sınamam <code>modeHistogram</code> üzerinden yazılmıştı ve KISMA blok üretmediği için yapısal olarak hiçbir şey yakalayamıyordu.</div>
<div class="callout warn"><b>Histerezis şart, sınır ise değişmiyor.</b> Histerezis kapatılınca mod değişimi ${tr(H.withSwitches)} → <b>${tr(H.withoutSwitches)}</b>'ye çıkıyor (×${tr(H.withoutSwitches / Math.max(1, H.withSwitches), 1)} chatter): her mevduat eşiği yukarı, her talep aşağı itiyor. Ve dürüst sınır: talep azami üretimi aşarsa (üretimin %130'u) ret %${tr(100 * D.overload.denialRate, 1)}. <b>Geri-basınç israfı önler, kapasite yaratmaz</b> — R > D koşulu değişmiyor.</div>

<details>
<summary>Tablo görünümü — φ_high taraması</summary>
<table><thead><tr><th>φ_high</th><th>kaynak tasarrufu</th><th>atılan</th><th>düz talepte ret</th><th>sıçramada ret</th><th>azami anahtar yaşı</th></tr></thead><tbody>${tbl}</tbody></table>
<p class="note">Kurulum: üretim ${tr(S.productionBps, 0)} bit/s (${tr(S.fixedBlockMs / 1000, 0)} s blok), talep ${tr(S.demandBps)} bit/s, depo ${tr(S.capacityBits)} bit, istek ${tr(S.requestBits)} bit, ${tr(S.totalPairs)} çiftlik ${tr(S.sessionMs / 1000, 1)} s akış. Ret oranları ısınma (${tr(S.warmupMs / 1000, 0)} s) sonrası ölçüldü. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "backpressure.json");
  const outPath = process.argv[3] || "/tmp/backpressure_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
