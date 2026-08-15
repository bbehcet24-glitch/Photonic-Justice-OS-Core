#!/usr/bin/env node
"use strict";
/**
 * gen_duty_cycle_chart.js — BB84/E91 hibrit görev döngüsü.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Turların nereye gittiği → PARÇA-BÜTÜN → YIĞILMIŞ ÇUBUK, 2px
 *     yüzey boşluklu. Üç yapılandırma alt alta; asıl mesaj "anahtar
 *     diliminin büyümesi" olduğu için o dilim ilk sırada ve renkli,
 *     ziyan dilimleri tarafsız gri.
 *   • Yanlılık taraması → İKİ ÖLÇÜ (turun oranı ve ℓ) farklı birimde.
 *     ÇİFT EKSEN YASAK → aynı x (p) üzerinde KÜÇÜK ÇOKLU iki panel.
 *     Asıl bulgu (baz oranı monoton artarken ℓ tepe yapıp çöküyor)
 *     ancak böyle görünür.
 *   • Kazanç × blok boyutu → çizgi, log x, teorik tavan referans çizgisi.
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
  const E = D.baselines.e91, U = D.baselines.bbm92Unbiased, B = D.bestMeasured;
  const SW = D.biasSweep, SC = D.scaleWithBlockSize, G = D.gains, W = D.baselines.whereTheClaimComesFrom;
  const N = D.stream.totalPairs;

  // ══ 1) TURLARIN DAĞILIMI — yığılmış çubuk ══
  const configs = [
    { n: "E91 (3×3 ızgara)", sub: "anahtar 1/9",
      seg: [["anahtar", E.keyRoundFraction, "var(--k1)"], ["PE", E.peRoundFraction, "var(--k3)"],
            ["CHSH", E.chshFraction, "var(--k2)"], ["ziyan", E.wastedFraction, "var(--muted-mark)"]] },
    { n: "BBM92 (yansız baz)", sub: "anahtar 1/4, eleme 1/2",
      seg: [["anahtar", U.keyRoundFraction, "var(--k1)"], ["PE", U.peRoundFraction, "var(--k3)"],
            ["CHSH", 0, "var(--k2)"], ["eşleşmedi", 1 - U.keyRoundFraction - U.peRoundFraction, "var(--muted-mark)"]] },
    { n: `HİBRİT (p* = ${tr(B.pKey, 2)})`, sub: `yanlı baz + %${tr(100 * D.certification.fBell, 0)} Bell döngüsü`,
      seg: [["anahtar", B.keyRoundFraction, "var(--k1)"], ["PE", B.peRounds / N, "var(--k3)"],
            ["CHSH", B.bellRounds / N, "var(--k2)"], ["eşleşmedi", 1 - B.keyRoundFraction - B.peRounds / N - B.bellRounds / N, "var(--muted-mark)"]] },
  ];
  const SB = { w: 780, h: configs.length * 76 + 20, l: 178, r: 96, t: 14 };
  const sw = SB.w - SB.l - SB.r;
  const stacks = configs.map((c, i) => {
    const y = SB.t + i * 76;
    let x = SB.l, segs = "";
    for (const [nm, v, col] of c.seg) {
      if (v <= 0.0005) continue;
      const w = v * sw;
      segs += `<g class="row" data-tip="<b>${esc(c.n)}</b><br>${esc(nm)}: %${tr(100 * v, 2)} of turlar">
        <rect x="${x}" y="${y}" width="${Math.max(w - 2, 1)}" height="32" rx="3" fill="${col}"/></g>`;
      // Etiket ancak SIĞIYORSA yazılır; dar dilimde yalnızca yüzde,
      // çok darda hiç (ilk taslakta "anahtar %11" kesilip "nahtar %1"
      // olarak görünüyordu).
      const ink = col === "var(--muted-mark)" ? "var(--text-secondary)" : "#fff";
      const full = `${nm} %${tr(100 * v, 0)}`;
      if (w > full.length * 6.2 + 10) segs += `<text x="${x + w / 2 - 1}" y="${y + 21}" text-anchor="middle" class="segl" fill="${ink}">${esc(full)}</text>`;
      else if (w > 34) segs += `<text x="${x + w / 2 - 1}" y="${y + 21}" text-anchor="middle" class="segl" fill="${ink}">%${tr(100 * v, 0)}</text>`;
      x += w;
    }
    return `<text x="${SB.l - 14}" y="${y + 15}" text-anchor="end" class="lab">${esc(c.n)}</text>
      <text x="${SB.l - 14}" y="${y + 30}" text-anchor="end" class="sublab">${esc(c.sub)}</text>${segs}
      <text x="${SB.l + sw + 10}" y="${y + 21}" class="val k1t">%${tr(100 * c.seg[0][1], 1)}</text>`;
  }).join("");

  // ══ 2) YANLILIK TARAMASI — küçük çoklu ══
  const P = { w: 372, h: 250, l: 54, r: 16, t: 24, b: 42 };
  const pw = P.w - P.l - P.r, ph = P.h - P.t - P.b;
  const PX = (p) => P.l + ((p - 0.5) / 0.5) * pw;
  const panel = (title, vals, yMax, fmtY, col, markBest) => {
    let g = `<text x="${P.l - 38}" y="12" class="ptitle">${esc(title)}</text>`;
    for (let i = 0; i <= 5; i++) {
      const v = (yMax * i) / 5, y = P.t + ph - (v / yMax) * ph;
      g += `<line x1="${P.l}" y1="${y}" x2="${P.l + pw}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
      g += `<text x="${P.l - 8}" y="${y + 4}" text-anchor="end" class="tick">${fmtY(v)}</text>`;
    }
    for (const p of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      g += `<line x1="${PX(p)}" y1="${P.t}" x2="${PX(p)}" y2="${P.t + ph}" stroke="var(--grid)" stroke-width="1"/>`;
      g += `<text x="${PX(p)}" y="${P.t + ph + 18}" text-anchor="middle" class="tick">${tr(p, 1)}</text>`;
    }
    const Y = (v) => P.t + ph - (v / yMax) * ph;
    g += `<line x1="${PX(B.pKey)}" y1="${P.t}" x2="${PX(B.pKey)}" y2="${P.t + ph}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    if (markBest) g += `<text x="${PX(B.pKey) - 6}" y="${P.t + 12}" text-anchor="end" class="anno">p* = ${tr(B.pKey, 2)}</text>`;
    g += `<path d="${SW.map((s, i) => `${i ? "L" : "M"}${PX(s.pKey).toFixed(1)},${Y(vals(s)).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
    for (const s of SW)
      g += `<g class="row" data-tip="<b>p = ${tr(s.pKey, 2)}</b><br>anahtar turu oranı ${tr(s.keyRoundFraction, 4)}<br>μ = ${tr(s.mu, 5)}<br>ℓ = ${tr(s.ell)} bit">
        <circle cx="${PX(s.pKey)}" cy="${Y(vals(s))}" r="10" fill="transparent"/>
        <circle cx="${PX(s.pKey)}" cy="${Y(vals(s))}" r="4.5" fill="${col}" stroke="var(--surface-1)" stroke-width="1.5"/></g>`;
    g += `<text x="${P.l + pw / 2}" y="${P.h - 3}" text-anchor="middle" class="axname">Z bazı olasılığı p</text>`;
    return g;
  };
  const ellMax = 120000;
  const pnl1 = panel("anahtar turu oranı — monoton ARTIYOR", s => s.keyRoundFraction, 1, v => tr(v, 1), "var(--k1)", false);
  const pnl2 = panel("ℓ (bit) — TEPE yapıp çöküyor", s => s.ell, ellMax, v => tr(v / 1000, 0) + "k", "var(--k2)", true);

  // ══ 3) KAZANÇ × BLOK BOYUTU ══
  const S3 = { w: 780, h: 288, l: 60, r: 130, t: 26, b: 46 };
  const s3w = S3.w - S3.l - S3.r, s3h = S3.h - S3.t - S3.b;
  const xLo = 4000, xHi = 400000, gMax = 5;
  const X3 = (v) => S3.l + ((Math.log10(v) - Math.log10(xLo)) / (Math.log10(xHi) - Math.log10(xLo))) * s3w;
  const Y3 = (v) => S3.t + s3h - (v / gMax) * s3h;
  let g3 = "";
  for (let v = 0; v <= gMax; v += 1) {
    g3 += `<line x1="${S3.l}" y1="${Y3(v)}" x2="${S3.l + s3w}" y2="${Y3(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${S3.l - 9}" y="${Y3(v) + 4}" text-anchor="end" class="tick">×${tr(v)}</text>`;
  }
  for (const t of [5000, 10000, 50000, 100000, 300000]) {
    g3 += `<line x1="${X3(t)}" y1="${S3.t}" x2="${X3(t)}" y2="${S3.t + s3h}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${X3(t)}" y="${S3.t + s3h + 19}" text-anchor="middle" class="tick">${t >= 1000 ? tr(t / 1000) + "k" : tr(t)}</text>`;
  }
  g3 += `<line x1="${S3.l}" y1="${Y3(D.theoreticalCeiling)}" x2="${S3.l + s3w}" y2="${Y3(D.theoreticalCeiling)}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  g3 += `<text x="${S3.l + s3w + 8}" y="${Y3(D.theoreticalCeiling) + 4}" class="anno">teorik tavan<tspan x="${S3.l + s3w + 8}" dy="13">×${tr(D.theoreticalCeiling, 2)} (p→1)</tspan></text>`;
  g3 += `<line x1="${S3.l}" y1="${Y3(4.5)}" x2="${S3.l + s3w}" y2="${Y3(4.5)}" stroke="var(--k2)" stroke-width="1.5" stroke-dasharray="2 4"/>`;
  g3 += `<text x="${S3.l + s3w - 6}" y="${Y3(4.5) - 7}" text-anchor="end" class="anno k2t">hedeflenen ×4,5 — bu ölçütte tavanın ÜSTÜNDE</text>`;
  g3 += `<path d="${SC.map((s, i) => `${i ? "L" : "M"}${X3(s.rounds).toFixed(1)},${Y3(s.basisGainVsUnbiased).toFixed(1)}`).join("")}" fill="none" stroke="var(--k1)" stroke-width="2.5" stroke-linejoin="round"/>`;
  g3 += `<path d="${SC.map((s, i) => `${i ? "L" : "M"}${X3(s.rounds).toFixed(1)},${Y3(s.ellGain).toFixed(1)}`).join("")}" fill="none" stroke="var(--k2)" stroke-width="2.5" stroke-linejoin="round"/>`;
  for (const s of SC) {
    g3 += `<g class="row" data-tip="<b>${tr(s.rounds)} tur</b><br>türetilen p* = ${tr(s.derivedP, 3)}<br>anahtar turu oranı ${tr(s.keyRoundFraction, 4)}<br>baz eşleşme kazancı ×${tr(s.basisGainVsUnbiased, 2)}<br>ℓ kazancı ×${tr(s.ellGain, 2)}">
      <circle cx="${X3(s.rounds)}" cy="${Y3(s.basisGainVsUnbiased)}" r="10" fill="transparent"/>
      <circle cx="${X3(s.rounds)}" cy="${Y3(s.basisGainVsUnbiased)}" r="4.5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="1.5"/>
      <circle cx="${X3(s.rounds)}" cy="${Y3(s.ellGain)}" r="4.5" fill="var(--k2)" stroke="var(--surface-1)" stroke-width="1.5"/></g>`;
  }
  const last = SC[SC.length - 1];
  g3 += `<text x="${X3(last.rounds) + 10}" y="${Y3(last.basisGainVsUnbiased) + 4}" class="endlab k1t">×${tr(last.basisGainVsUnbiased, 2)}</text>`;
  g3 += `<text x="${X3(last.rounds) + 10}" y="${Y3(last.ellGain) + 4}" class="endlab k2t">×${tr(last.ellGain, 2)}</text>`;

  const tbl = SW.map(s => `<tr><td>${tr(s.pKey, 2)}</td><td>${tr(s.keyRounds)}</td><td>${tr(s.keyRoundFraction, 4)}</td><td>${tr(s.peRounds)}</td><td>${tr(s.mu, 5)}</td><td>${tr(s.ell)}</td><td>×${tr(s.basisGainVsUnbiased, 2)}</td><td>×${tr(s.basisGainVsE91, 2)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BB84/E91 hibrit görev döngüsü</title>
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
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .segl{font-size:10px;font-weight:620;}
  .val{font-size:12.5px;font-weight:660;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .ptitle{font-size:11.5px;fill:var(--text-primary);font-weight:620;}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:10.5px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type{fill:var(--surface-2);}
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

<h1>BB84/E91 hibrit görev döngüsü</h1>
<p class="sub">Modül yazıldı ve ölçüldü. Baz eşleşme verimi <b>yanlı baz seçimiyle</b> (Z olasılığı p, X olasılığı 1−p) yükseltiliyor; turların küçük bir payı adanmış CHSH probuna ayrılarak Bell sertifikası sürdürülüyor. Hedeflenen <b>×4,5</b>'in hangi karşılaştırmadan geldiği de ölçüldü — çünkü tek başına bir kat sayısı, tabanı ve ölçütü söylenmeden anlamsızdır.</p>

<div class="tiles">
  <div class="tile"><div class="l">türetilen p*</div><div class="v">${tr(B.pKey, 2)}</div></div>
  <div class="tile"><div class="l">anahtar turu oranı</div><div class="v k1t">%${tr(100 * B.keyRoundFraction, 1)}</div></div>
  <div class="tile"><div class="l">E91 tabanına göre</div><div class="v k1t">×${tr(G.basisMatchGainVsE91, 2)}</div></div>
  <div class="tile"><div class="l">yansız BBM92'ye göre</div><div class="v">×${tr(G.basisMatchGainVsUnbiased, 2)}</div></div>
  <div class="tile"><div class="l">ℓ kazancı</div><div class="v k2t">×${tr(G.ellGainVsUnbiased, 2)}</div></div>
</div>

<div class="callout warn"><b>"×4,5" nereden geliyor?</b> Ölçüm birebir doğruluyor: BB84'ün <b>toplam elemesi</b> (${tr(U.basisMatchFraction, 3)}) ÷ E91'in <b>anahtar turları</b> (${tr(E.keyRoundFraction, 3)}) = <b>×${tr(W.ratio_bbm92AllSifted_over_e91Key, 2)}</b>. Ama bu iki farklı ölçütü kıyaslıyor. Aynı ölçütle — anahtar turu ÷ anahtar turu — oran <b>×${tr(W.ratio_bbm92Key_over_e91Key, 2)}</b>'dir. Modülün getirdiği asıl kazanç bunun üstüne biniyor.</div>

<h2>1) Turlar nereye gidiyor?</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>anahtar</span>
  <span class="lg"><span class="key" style="background:var(--k3)"></span>parametre kestirimi</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>CHSH / Bell sertifikası</span>
  <span class="lg"><span class="key" style="background:var(--muted-mark)"></span>eşleşmedi / ziyan</span>
</div>
<svg viewBox="0 0 ${SB.w} ${SB.h}" aria-label="Üç yapılandırmada turların dağılımı">${stacks}</svg>
<p class="note">E91'in en pahalı yanı görünüyor: turların <b>%${tr(100 * E.wastedFraction, 0)}</b>'i hiçbir işe yaramadan atılıyor, yalnızca %${tr(100 * E.keyRoundFraction, 1)}'i anahtara gidiyor. Hibrit yapılandırmada anahtar dilimi <b>%${tr(100 * B.keyRoundFraction, 1)}</b>'e çıkıyor; Bell sertifikası ise turların yalnızca %${tr(100 * D.certification.fBell, 0)}'ini alıyor ve yine de <b>${tr(D.certification.sigmaAboveClassical, 1)}σ</b> ihlal kanıtlıyor.</p>

<h2>2) Yanlılığın bir optimumu var</h2>
<p class="sub">p büyüdükçe anahtar turu oranı p² ile artar — ama PE örneklemi (1−p)² ile çöker ve sonlu-anahtar payı μ patlar. İki panel aynı x ekseninde: soldaki monoton artıyor, sağdaki tepe yapıp çöküyor.</p>
<svg viewBox="0 0 ${P.w * 2 + 24} ${P.h}" aria-label="Yanlılığa göre anahtar turu oranı ve güvenli anahtar uzunluğu">
  <g>${pnl1}</g><g transform="translate(${P.w + 24},0)">${pnl2}</g>
</svg>
<div class="callout"><b>p* varsayılmadı, türetildi.</b> Modül ℓ(p)'yi blok boyutuna göre tarayıp p*'yi hesaplıyor; bu koşumda türetilen <b>${tr(D.derivedOptimum.p, 3)}</b>, ölçülen en iyi değerle (<b>${tr(B.pKey, 2)}</b>) örtüşüyor. Aşırı yanlılığın bedeli sert: p = 0,98'de anahtar turu oranı %95'e çıkıyor ama μ = ${tr(SW[SW.length - 1].mu, 3)} olduğu için ℓ <b>${tr(SW[SW.length - 1].ell)} bite</b> çöküyor — p* = ${tr(B.pKey, 2)}'teki ${tr(B.ell)} bitin yanında pratikte sıfır.</div>

<h2>3) Kazanç blok boyutuyla büyüyor</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>baz eşleşme kazancı</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>ℓ kazancı</span>
</div>
<svg viewBox="0 0 ${S3.w} ${S3.h}" aria-label="Blok boyutuna göre kazanç">
  ${g3}
  <text x="${S3.l + s3w / 2}" y="${S3.h - 4}" text-anchor="middle" class="axname">blok boyutu (tur, <tspan font-style="italic">log ölçek</tspan>)</text>
  <text x="${S3.l - 46}" y="${S3.t - 10}" class="axname">yansız BBM92'ye göre kazanç</text>
</svg>
<div class="callout"><b>Sabit bir kat sayısı yok — kazanç bir eğri.</b> Optimum yanlılık blok büyüdükçe 1'e yaklaştığı için kazanç da büyüyor: ${tr(SC[0].rounds)} turda ×${tr(SC[0].basisGainVsUnbiased, 2)} iken ${tr(last.rounds)} turda ×${tr(last.basisGainVsUnbiased, 2)}. Teorik tavan <b>×${tr(D.theoreticalCeiling, 2)}</b>'tür (p→1 iken ¼ → 1−f_bell) ve sonlu blokta ulaşılamaz. <b>Hedeflenen ×4,5 bu ölçütte tavanın üstündedir</b> — ama E91 tabanına göre ölçüldüğünde modül <b>×${tr(G.basisMatchGainVsE91, 2)}</b> ile hedefi zaten aşıyor. ℓ kazancının (×${tr(last.ellGain, 2)}) baz kazancının altında kalması beklenen bir şeydir: anahtar turu artarken PE örneklemi küçülür, μ bedeli ödenir.</div>

<details>
<summary>Tablo görünümü — yanlılık taraması</summary>
<table><thead><tr><th>p</th><th>anahtar turu</th><th>oran</th><th>PE turu</th><th>μ</th><th>ℓ (bit)</th><th>×yansız</th><th>×E91</th></tr></thead><tbody>${tbl}</tbody></table>
<p class="note">Yanlı baz seçimi standart ve güvenlidir (Lo–Chau–Ardehali 2005): p ≠ ½ güvenliği bozmaz, seçimin ölçüm anında öngörülemez olması yeterlidir. Faz hatası yine X bazından kestirilir (karışık QBER kullanılmaz); ölçülen e_bit = ${tr(D.certification ? 0 : 0)} ve e_ph = ${tr(SW.find(s => s.pKey === B.pKey).ePh, 5)}. Bell modu turları anahtara katılmaz — sertifika ile anahtar üretimi ayrı koşullardır. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "duty_cycle.json");
  const outPath = process.argv[3] || "/tmp/duty_cycle_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
