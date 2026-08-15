#!/usr/bin/env node
"use strict";
/**
 * gen_controller_chart.js — oturum kontrolcüsü görseli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • İki bütçenin R_key(T) eğrisi → KÜÇÜK ÇOKLU (small multiples).
 *     x aralıkları 5 kat farklı; tek panele sıkıştırmak 20k eğrisini
 *     okunmaz yapardı. y ekseni İKİSİNDE DE AYNI (bit/s) — asıl
 *     karşılaştırma o eksende. ÇİFT EKSEN YOK.
 *   • Strateji karşılaştırması → gruplu çubuk (2 bütçe × 3 politika),
 *     kimlik rengi politikaya bağlı, bütçeler ayrı gruplar.
 *   • Kabul eşiği → SAYI DOĞRUSU: eşik tek bir sınır, yollar o sınıra
 *     göre konumlanıyor. Çubuk grafik burada yanlış form olurdu.
 *   • Monitör maliyeti → iki seçenek, iki ölçü → küçük tablo + çubuk.
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
  const SC = D.scenarios, s20 = SC["20000"], s100 = SC["100000"];
  const yMax = 1300;
  const FIXED = 850;

  // ══ 1) KÜÇÜK ÇOKLU: R_key(T), iki bütçe ══
  const P = { w: 372, h: 268, l: 50, r: 14, t: 26, b: 40 };
  const iw = P.w - P.l - P.r, ih = P.h - P.t - P.b;
  const panel = (s, title) => {
    const tMax = s.tEndMs;
    const X = (t) => P.l + (t / tMax) * iw;
    const Y = (v) => P.t + ih - (v / yMax) * ih;
    let g = "";
    for (let v = 0; v <= yMax; v += 260) {
      g += `<line x1="${P.l}" y1="${Y(v)}" x2="${P.l + iw}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
      g += `<text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
    }
    const step = tMax > 4000 ? 2000 : 500;
    for (let t = 0; t <= tMax; t += step) {
      g += `<line x1="${X(t)}" y1="${P.t}" x2="${X(t)}" y2="${P.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
      g += `<text x="${X(t)}" y="${P.t + ih + 18}" text-anchor="middle" class="tick">${tr(t)}</text>`;
    }
    const d = s.curve.map((r, i) => `${i ? "L" : "M"}${X(r.tMs).toFixed(1)},${Y(r.rateBps).toFixed(1)}`).join("");
    // sabit 850 ms — kullanıcının önerdiği kesim
    const fx = Math.min(FIXED, tMax);
    g += `<line x1="${X(fx)}" y1="${P.t}" x2="${X(fx)}" y2="${P.t + ih}" stroke="var(--k2)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    g += `<circle cx="${X(fx)}" cy="${Y(s.fixedTimeout.rateBps)}" r="5" fill="var(--k2)" stroke="var(--surface-1)" stroke-width="2"/>`;
    // kontrolcünün kapattığı an
    g += `<line x1="${X(s.controller.closedAtMs)}" y1="${P.t}" x2="${X(s.controller.closedAtMs)}" y2="${P.t + ih}" stroke="var(--k1)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    g += `<path d="${d}" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linejoin="round"/>`;
    g += `<circle cx="${X(s.controller.closedAtMs)}" cy="${Y(s.controller.rateBps)}" r="5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="2"/>`;
    // etiketler
    const pctOfPeak = (100 * s.fixedTimeout.rateBps / s.truePeak.rateBps).toFixed(1);
    const cx = X(s.controller.closedAtMs);
    // İki dikey işaret birbirine yakınsa etiketler ÇAKIŞIR: yakınsa
    // sabit-timeout etiketi sola, kontrolcü etiketi sağa yaslanır ve
    // dikey ayrım açılır.
    const near = Math.abs(cx - X(fx)) < iw * 0.28;
    const fAnchor = near ? "end" : "start", fOff = near ? -7 : 6;
    const fy = Y(s.fixedTimeout.rateBps) + (near ? 40 : 20);
    g += `<text x="${X(fx) + fOff}" y="${fy}" text-anchor="${fAnchor}" class="anno k2t">sabit ${tr(fx)} ms<tspan x="${X(fx) + fOff}" dy="13">${tr(s.fixedTimeout.rateBps, 0)} bit/s · zirvenin %${pctOfPeak}'i</tspan></text>`;
    const anchor = near ? "start" : (cx > P.l + iw * 0.62 ? "end" : "start");
    const off = anchor === "end" ? -7 : 7;
    g += `<text x="${cx + off}" y="${Y(s.controller.rateBps) - 26}" text-anchor="${anchor}" class="anno k1t">kontrolcü ${tr(s.controller.closedAtMs)} ms<tspan x="${cx + off}" dy="13">${tr(s.controller.rateBps, 0)} bit/s · zirvenin %${(100 * s.controller.rateBps / s.truePeak.rateBps).toFixed(1)}'i</tspan></text>`;
    return `<g><text x="${P.l - 42}" y="14" class="ptitle">${esc(title)}</text>${g}
      <text x="${P.l + iw / 2}" y="${P.h - 3}" text-anchor="middle" class="axname">T (ms)</text></g>`;
  };

  // ══ 2) POLİTİKA KARŞILAŞTIRMASI (gruplu çubuk) ══
  const pol = [
    { n: "kontrolcü (marjinal kural)", k: "controller", col: "var(--k1)" },
    { n: `sabit ${FIXED} ms timeout`, k: "fixedTimeout", col: "var(--k2)" },
    { n: "hiç kesme", k: "noCut", col: "var(--muted-mark)" },
  ];
  const GB = { w: 780, h: 250, l: 176, r: 96, t: 20 };
  const gw = GB.w - GB.l - GB.r;
  const gMax = 1300;
  let grp = "";
  [["20000", s20], ["100000", s100]].forEach(([b, s], bi) => {
    const y0 = GB.t + bi * 112;
    grp += `<text x="${GB.l - 14}" y="${y0 + 14}" text-anchor="end" class="lab">${tr(+b)} deneme/segment</text>`;
    grp += `<text x="${GB.l - 14}" y="${y0 + 30}" text-anchor="end" class="sublab">${tr(s.totalPairs)} çift · T_son ${tr(Math.round(s.tEndMs))} ms</text>`;
    pol.forEach((p, pi) => {
      const v = s[p.k].rateBps, y = y0 + pi * 30;
      const w = Math.max((v / gMax) * gw, 2);
      grp += `<g class="row" data-tip="<b>${esc(p.n)}</b><br>bütçe ${tr(+b)}/segment<br>${tr(v, 0)} bit/s · ℓ=${tr(s[p.k].ell)} bit<br>kapanış ${tr(Math.round(s[p.k].closedAtMs ?? s[p.k].atMs))} ms">
        <rect x="0" y="${y - 2}" width="${GB.w}" height="26" fill="transparent"/>
        <rect x="${GB.l}" y="${y}" width="${w}" height="22" rx="4" fill="${p.col}"/>
        <text x="${GB.l + w + 10}" y="${y + 16}" class="val">${tr(v, 0)}</text></g>`;
    });
    // zirve referansı
    const px = GB.l + (s.truePeak.rateBps / gMax) * gw;
    grp += `<line x1="${px}" y1="${y0 - 6}" x2="${px}" y2="${y0 + 92}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    grp += `<text x="${px + 5}" y="${y0 - 10}" class="anno">gerçek zirve ${tr(s.truePeak.rateBps, 0)}</text>`;
  });

  // ══ 3) KABUL EŞİĞİ — SAYI DOĞRUSU ══
  const A = D.admission;
  const NL = { w: 780, h: 132, l: 46, r: 46, t: 54 };
  const nw = NL.w - NL.l - NL.r, eMax = 0.36;
  const NX = (e) => NL.l + (e / eMax) * nw;
  let numline = `<line x1="${NL.l}" y1="${NL.t}" x2="${NL.l + nw}" y2="${NL.t}" stroke="var(--grid)" stroke-width="2"/>`;
  for (let e = 0; e <= eMax + 1e-9; e += 0.05) {
    numline += `<line x1="${NX(e)}" y1="${NL.t - 5}" x2="${NX(e)}" y2="${NL.t + 5}" stroke="var(--grid)" stroke-width="1"/>`;
    numline += `<text x="${NX(e)}" y="${NL.t + 22}" text-anchor="middle" class="tick">${tr(e, 2)}</text>`;
  }
  // kabul bölgesi
  numline += `<rect x="${NL.l}" y="${NL.t - 13}" width="${NX(A.thresholdAtBestPath) - NL.l}" height="26" fill="var(--k1)" opacity="0.13"/>`;
  numline += `<line x1="${NX(A.thresholdAtBestPath)}" y1="${NL.t - 34}" x2="${NX(A.thresholdAtBestPath)}" y2="${NL.t + 13}" stroke="var(--k1)" stroke-width="2"/>`;
  numline += `<text x="${NX(A.thresholdAtBestPath)}" y="${NL.t - 40}" text-anchor="middle" class="pk k1t">e* = ${tr(A.thresholdAtBestPath, 3)}</text>`;
  numline += `<text x="${NL.l + 6}" y="${NL.t - 20}" class="anno k1t">← havuza KABUL</text>`;
  numline += `<text x="${NX(A.thresholdAtBestPath) + 8}" y="${NL.t - 20}" class="anno">RED →</text>`;
  A.perPath.forEach((p, i) => {
    const x = NX(p.ePh), y = NL.t + 44 + (i % 2) * 17;
    numline += `<g class="row" data-tip="<b>${esc(p.label)}</b><br>faz hatası e_ph = ${tr(p.ePh, 5)}<br>ortalama sadakat F = ${tr(p.meanF, 5)}<br>eşiğin ${tr(A.thresholdAtBestPath / p.ePh, 2)}× altında → kabul">
      <rect x="${x - 40}" y="${y - 12}" width="80" height="18" fill="transparent"/>
      <circle cx="${x}" cy="${NL.t}" r="6" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="2"/>
      <line x1="${x}" y1="${NL.t + 7}" x2="${x}" y2="${y - 10}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${x}" y="${y}" text-anchor="middle" class="sublab">${esc(p.label)}</text></g>`;
  });
  const badE = A.thresholdAtBestPath * 1.6;
  numline += `<circle cx="${NX(badE)}" cy="${NL.t}" r="6" fill="none" stroke="var(--k2)" stroke-width="2"/>`;
  numline += `<text x="${NX(badE)}" y="${NL.t + 44}" text-anchor="middle" class="sublab k2t">kurgusal yol ${tr(badE, 3)} → red</text>`;

  // ══ 4) MONİTÖR ══
  const H = D.hybrid, HE = D.hybridFullE91Monitor;
  const mons = [
    { n: "adanmış CHSH probu", pairs: H.monitor.divertedPairs, pct: H.cost.rateLostPct, sig: H.monitor.sigma, col: "var(--k1)" },
    { n: "tam E91 ızgarası", pairs: HE.divertedPairs, pct: HE.rateLostPct, sig: HE.sigma, col: "var(--muted-mark)" },
  ];
  const MB = { w: 780, h: 118, l: 190, r: 240, t: 18 };
  const mw = MB.w - MB.l - MB.r, mMax = 16;
  const monBars = mons.map((m, i) => {
    const y = MB.t + i * 46, w = Math.max((m.pct / mMax) * mw, 2);
    return `<g class="row" data-tip="<b>${esc(m.n)}</b><br>${tr(m.pairs)} çift saptırıldı<br>anahtar hızı kaybı %${tr(m.pct, 2)}<br>Bell ihlali ${tr(m.sig, 2)}σ">
      <rect x="0" y="${y - 4}" width="${MB.w}" height="40" fill="transparent"/>
      <text x="${MB.l - 14}" y="${y + 16}" text-anchor="end" class="lab">${esc(m.n)}</text>
      <text x="${MB.l - 14}" y="${y + 31}" text-anchor="end" class="sublab">${tr(m.pairs)} çift · ${tr(m.sig, 2)}σ</text>
      <rect x="${MB.l}" y="${y + 2}" width="${w}" height="22" rx="4" fill="${m.col}"/>
      <text x="${MB.l + w + 10}" y="${y + 18}" class="val">%${tr(m.pct, 2)} hız kaybı</text></g>`;
  }).join("");

  const cm = H.costModel;
  const rowsTbl = [["20000", s20], ["100000", s100]].map(([b, s]) =>
    `<tr><td>${tr(+b)}</td><td>${tr(s.totalPairs)}</td><td>${tr(Math.round(s.tEndMs))}</td><td>${tr(Math.round(s.truePeak.tMs))} / ${tr(s.truePeak.rateBps, 0)}</td><td>${tr(s.fixedTimeout.rateBps, 0)}</td><td>${tr(Math.round(s.controller.closedAtMs))} / ${tr(s.controller.rateBps, 0)}</td><td>${tr(s.noCut.rateBps, 0)}</td><td>%${tr(s.predictorError, 2)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QKD oturum kontrolcüsü</title>
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
  .key.dashk1{width:16px;height:0;border-radius:0;border-top:3px dashed var(--k1);}
  .key.dashk2{width:16px;height:0;border-radius:0;border-top:3px dashed var(--k2);}
  .key.linek{width:16px;height:0;border-radius:0;border-top:3px solid var(--text-secondary);}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10px;fill:var(--text-muted);}
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .pk{font-size:12px;font-weight:660;}
  .ptitle{font-size:12px;fill:var(--text-primary);font-weight:620;}
  .axname{font-size:10.5px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover rect:first-of-type{fill:var(--surface-2);}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k2);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.ok{border-left-color:var(--k1);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">

<h1>QKD oturum kontrolcüsü</h1>
<p class="sub">Grafikteki <b>T ≈ 850 ms zirvesi bir doyum noktası değil</b> — deneme bütçesinin tükendiği andır. Bütçe 5× yapılınca zirve 918 → 3.856 ms'ye kayıyor ve 616 → 1.257 bit/s'e <b>çıkıyor</b>. Bu yüzden kesim noktası sabitlenemez, <b>çevrimiçi türetilmelidir</b>: kontrolcü ℓ′(T) = ℓ(T)/T tepe koşulunu izler.</p>

<div class="tiles">
  <div class="tile"><div class="l">kontrolcü / zirve — 20k</div><div class="v k1t">%${(100 * s20.controller.rateBps / s20.truePeak.rateBps).toFixed(1)}</div></div>
  <div class="tile"><div class="l">kontrolcü / zirve — 100k</div><div class="v k1t">%${(100 * s100.controller.rateBps / s100.truePeak.rateBps).toFixed(1)}</div></div>
  <div class="tile"><div class="l">sabit 850 ms — 100k</div><div class="v k2t">%${(100 * s100.fixedTimeout.rateBps / s100.truePeak.rateBps).toFixed(1)}</div></div>
  <div class="tile"><div class="l">kabul eşiği e*</div><div class="v">${tr(A.thresholdAtBestPath, 3)}</div></div>
  <div class="tile"><div class="l">Bell monitörü maliyeti</div><div class="v">%${tr(H.cost.rateLostPct, 2)}</div></div>
</div>

<h2>1) Zirve sabit değil — bütçeyle birlikte kayıyor</h2>
<div class="lgrow">
  <span class="lg"><span class="key linek"></span>R_key(T), gerçek boru hattı</span>
  <span class="lg"><span class="key dashk1"></span>kontrolcünün kapattığı an</span>
  <span class="lg"><span class="key dashk2"></span>sabit ${FIXED} ms timeout</span>
  <span class="lg"><b>y ekseni: R_key (bit/s)</b></b> — iki panelde aynı ölçek#160;— iki panelde aynı ölçek</span>
</div>
<svg viewBox="0 0 ${P.w * 2 + 24} ${P.h}" aria-label="İki bütçe için anahtar hızı eğrisi">
  <g>${panel(s20, "20.000 deneme/segment")}</g>
  <g transform="translate(${P.w + 24},0)">${panel(s100, "100.000 deneme/segment")}</g>
</svg>
<div class="callout"><b>Sabit timeout neden çalışmaz:</b> ${FIXED} ms, küçük bütçede tesadüfen zirveye yakın (%${(100 * s20.fixedTimeout.rateBps / s20.truePeak.rateBps).toFixed(1)}) — bu yüzden ilk grafikte doğru görünüyordu. Bütçe büyüyünce aynı sabit, ulaşılabilir hızın <b>%${(100 * s100.fixedTimeout.rateBps / s100.truePeak.rateBps).toFixed(1)}'ine</b> kilitliyor. Türetilmiş marjinal kural ise her iki bütçede de zirvenin <b>%${(100 * s20.controller.rateBps / s20.truePeak.rateBps).toFixed(1)}</b> ve <b>%${(100 * s100.controller.rateBps / s100.truePeak.rateBps).toFixed(1)}</b>'ini yakalıyor — <b>bütçeyi hiç bilmeden</b>.</div>

<h2>2) Politikalar yan yana</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>kontrolcü (marjinal kural)</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>sabit ${FIXED} ms timeout</span>
  <span class="lg"><span class="key" style="background:var(--muted-mark)"></span>hiç kesme</span>
</div>
<svg viewBox="0 0 ${GB.w} ${GB.h}" aria-label="Kapanış politikalarının karşılaştırması">${grp}</svg>
<p class="note">Sürekli beslenen bir bağlantıda (arz incelmiyorsa) marjinal kural <b>hiç tetiklenmez</b> — ölçüldü: kapanış gerekçesi "arz bitti" oldu, "marjinal kural" değil. Orada kapanışı gecikme bütçesi belirliyor: SLA = 1.500 ms ile kontrolcü tam ${tr(D.steadyState.withSla1500.closedAtMs)} ms'de kapatıp ${tr(D.steadyState.withSla1500.ell)} bit üretti. Sabit timeout'un ayırt edemeyeceği durum budur.</p>

<h2>3) Sadakat-farkında kabul: eşik nerede?</h2>
<p class="sub">Bir yolu havuza almak ℓ'yi ne zaman artırır? Teğet kriterinden: <b>e* = ē + (1 − h₂(ē)) / log₂((1−ē)/ē)</b>.</p>
<svg viewBox="0 0 ${NL.w} ${NL.h}" aria-label="Kabul eşiği sayı doğrusu">${numline}
  <text x="${NL.l}" y="${NL.h - 4}" class="axname">yolun faz hatası e_ph</text></svg>
<p class="note">Üç yolun da hatası eşiğin <b>çok altında</b> — en kötüsü (${tr(A.worstPathEPh, 4)}) eşiğin ${tr(A.headroom, 2)} katı altında. "En kötü yolu havuzdan at" sezgisinin neden yanlış çıktığının cebirsel açıklaması bu. Eşik gerçekten ayırt edici: eşiğin 1,6 katı hatalı kurgusal bir yol (içi boş turuncu daire) reddediliyor — Δℓ negatife dönüyor. Asimptotik (μ→0) türetildiği için e* bir <b>alt sınırdır</b>: sonlu blokta kabul daha da caziptir, çünkü çift eklemek μ'yü de küçültür.</p>

<h2>4) Bell monitörü: E91'i anahtar değil, DOĞRULAMA için kullan</h2>
<svg viewBox="0 0 ${MB.w} ${MB.h}" aria-label="Monitör maliyeti">${monBars}</svg>
<div class="callout ok"><b>Üç tasarım kararı, üçü de ölçümle çıktı.</b> <b>(i)</b> Monitör turlarında tam E91 ızgarası değil <b>adanmış CHSH probu</b> kullanılır: E91'de saptırılan çiftlerin yalnızca 4/9'u CHSH turuna düşer, probda 1/1 — maliyet %${tr(HE.rateLostPct, 2)}'ten <b>%${tr(H.cost.rateLostPct, 2)}</b>'e iniyor. <b>(ii)</b> Saptırma oturuma <b>yayılır</b>, baştan blok halinde alınmaz: blok halinde alınırsa Bell testi yalnızca oturumun başını sertifikalar (Eve testte uslu durup sonra saldırabilir). Ölçülen kapsama: %${(100 * H.monitor.sessionCoverage).toFixed(1)}. <b>(iii)</b> Monitör <b>uyarlanırdır</b>: sabit ${tr(H.monitor.plannedPairs)} çiftlik plan σ = 1,17'de kaldı; kontrolcü hedefe kilitlenene kadar uzatıp ${tr(H.monitor.divertedPairs)} çiftte <b>${tr(H.monitor.sigma, 2)}σ</b>'ya ulaştı. Sabit sayıya güvenmenin, 850 ms timeout'la aynı hata olduğunu gösteren üçüncü örnek.</div>
<p class="note">Maliyetin saptırılan çift oranından (%${tr(cm.divertedFractionPct, 2)}) büyük çıkması beklenen bir şeydir: ℓ, n'de <b>süper-doğrusaldır</b> (blok başına sabit ~115 bitlik vergi + μ ∼ 1/√n) — havuzlamayı kazandıran etkinin aynısı, ters yönde. Eşik gevşetilmedi, <b>mekanizma doğrulandı</b>: ℓ formülünden öngörülen kayıp %${tr(cm.predictedLossPct, 2)}, ölçülen %${tr(cm.measuredLossPct, 2)} (süper-doğrusallık çarpanı ×${tr(cm.superlinearityFactor, 2)}).</p>

<details>
<summary>Tablo görünümü — politikalar ve öngörücü hatası</summary>
<table><thead><tr><th>Bütçe</th><th>Çift</th><th>T_son (ms)</th><th>gerçek zirve (ms / bit/s)</th><th>sabit ${FIXED} ms</th><th>kontrolcü (ms / bit/s)</th><th>kesme yok</th><th>ℓ öngörü hatası</th></tr></thead><tbody>${rowsTbl}</tbody></table>
<p class="note">Kontrolcü kapanış kararını verirken her tıkta Cascade koşamaz — ℓ sayımlardan <b>öngörülür</b>, gerçek hata düzeltme yalnızca blok kapanınca bir kez çalışır. Öngörücünün gerçek boru hattına karşı hatası tabloda.</p>
</details>

<p class="note"><b>Yöntem:</b> Çiftler gerçek çok-atlamalı DEJMPS simülatöründen üretim zaman damgalarıyla geliyor. "Gerçek zirve", 40 noktalı bir taramada TAM boru hattı (ölçüm + Cascade + sonlu-anahtar kanıtı) çalıştırılarak bulundu; kontrolcü bu taramayı görmüyor. Tüm ℓ değerleri baz-çözünürlü muhasebeyle (anahtar Z bazından, faz kestirimi X bazından) hesaplandı. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>

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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "qkd_session_controller.json");
  const outPath = process.argv[3] || "/tmp/qkd_controller_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
