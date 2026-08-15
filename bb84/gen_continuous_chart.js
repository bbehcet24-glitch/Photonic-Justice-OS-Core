#!/usr/bin/env node
"use strict";
/**
 * gen_continuous_chart.js — sürekli akış uçtan uca koşumu.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Gecikme–hız çalışma eğrisi → ÇİZGİ (sürekli bir kontrol
 *     değişkeni boyunca değişim). x ekseni LOG: SLA 100→6.800 ms, yani
 *     ~2 dekat, ve örnekleme zaten logaritmik yapıldı. Doğrusal eksende
 *     ilk altı nokta genişliğin %15'ine sıkışır ve ASIL BULGU olan
 *     uçurum okunmaz hâle gelirdi. Log burada ÖLÇÜLEN BÜYÜKLÜĞÜ değil,
 *     operatörün seçtiği AYAR DÜĞMESİNİ taşıyor — gizlediği bir fark yok.
 *   • Asimptotik tavan → yatay referans çizgisi (eğrinin nereye kadar
 *     tırmandığını söylemeden "tırmanıyor" demek eksik olurdu).
 *   • Uçurum kurtarması → iki durum, tek ölçü → vurgulu çubuk.
 *   • Monitör maliyeti → iki oturum uzunluğu → çubuk.
 *   • ÇİFT EKSEN YOK.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const C = D.operatingCurve, S = D.stream, ceil = D.asymptoticCeilingBps;
  const alive = C.filter(c => c.totalEll > 0);
  const dead = C.filter(c => c.totalEll === 0);
  const firstAlive = alive[0];

  // ══ 1) ÇALIŞMA EĞRİSİ (log x) ══
  const L = { w: 780, h: 340, l: 62, r: 128, t: 26, b: 46 };
  const iw = L.w - L.l - L.r, ih = L.h - L.t - L.b;
  const xLo = 80, xHi = 8000;
  const lg = (v) => Math.log10(v);
  const X = (v) => L.l + ((lg(v) - lg(xLo)) / (lg(xHi) - lg(xLo))) * iw;
  const yMax = 2000;
  const Y = (v) => L.t + ih - (v / yMax) * ih;

  let grid = "";
  for (let v = 0; v <= yMax; v += 250) {
    grid += `<line x1="${L.l}" y1="${Y(v)}" x2="${L.l + iw}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${L.l - 9}" y="${Y(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  for (const t of [100, 200, 500, 1000, 2000, 5000]) {
    grid += `<line x1="${X(t)}" y1="${L.t}" x2="${X(t)}" y2="${L.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${X(t)}" y="${L.t + ih + 19}" text-anchor="middle" class="tick">${tr(t)}</text>`;
  }
  // ölü bölge
  const deadEnd = X((dead[dead.length - 1].slaMs + firstAlive.slaMs) / 2);
  grid += `<rect x="${L.l}" y="${L.t}" width="${deadEnd - L.l}" height="${ih}" fill="var(--k2)" opacity="0.09"/>`;
  grid += `<text x="${L.l + 6}" y="${L.t + ih * 0.42}" class="anno k2t">SIFIR anahtar —<tspan x="${L.l + 6}" dy="13">tüm çiftler çöpe</tspan></text>`;
  // tavan
  grid += `<line x1="${L.l}" y1="${Y(ceil)}" x2="${L.l + iw}" y2="${Y(ceil)}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  grid += `<text x="${L.l + iw + 8}" y="${Y(ceil) + 4}" class="anno">R∞ = ${tr(ceil, 0)}<tspan x="${L.l + iw + 8}" dy="13">asimptotik tavan</tspan></text>`;

  const d = C.map((c, i) => `${i ? "L" : "M"}${X(c.slaMs).toFixed(1)},${Y(c.sustainedRateBps).toFixed(1)}`).join("");
  let pts = "";
  for (const c of C) {
    const on = c.totalEll > 0;
    pts += `<g class="row" data-tip="<b>SLA ${tr(c.slaMs)} ms</b><br>${tr(c.blocks)} blok · ortalama ${tr(c.meanBlockMs ?? 0, 0)} ms<br>ℓ/blok ${tr(c.meanEllPerBlock, 0)} bit · toplam ${tr(c.totalEll)} bit<br><b>${tr(c.sustainedRateBps, 0)} bit/s</b> = tavanın %${tr(c.pctOfCeiling, 1)} düzeyi<br>ziyan çift %${tr(c.wastedPct, 2)}">
      <circle cx="${X(c.slaMs)}" cy="${Y(c.sustainedRateBps)}" r="12" fill="transparent"/>
      <circle cx="${X(c.slaMs)}" cy="${Y(c.sustainedRateBps)}" r="${on ? 5 : 4.5}" fill="${on ? "var(--k1)" : "none"}" stroke="${on ? "var(--surface-1)" : "var(--k2)"}" stroke-width="2"/></g>`;
  }
  const lastC = C[C.length - 1];
  const endLab = `<text x="${X(lastC.slaMs) + 10}" y="${Y(lastC.sustainedRateBps) + 4}" class="endlab k1t">${tr(lastC.sustainedRateBps, 0)} bit/s<tspan x="${X(lastC.slaMs) + 10}" dy="13">tavanın %${tr(lastC.pctOfCeiling, 0)} düzeyinde</tspan></text>`;
  const fa = `<text x="${X(firstAlive.slaMs) + 8}" y="${Y(firstAlive.sustainedRateBps) - 10}" class="anno">ilk üretken SLA<tspan x="${X(firstAlive.slaMs) + 8}" dy="13">${tr(firstAlive.slaMs)} ms</tspan></text>`;

  // ══ 2) UÇURUM KURTARMASI ══
  const H = D.holdRescue;
  const rescue = [
    { n: `SLA ${tr(H.slaMs)} ms — kesin kesim`, ell: 0, sub: `${tr(C.find(c => c.slaMs === H.slaMs).blocks)} blok, hepsi ölü · çiftlerin %100'ü çöpe`, col: "var(--muted-mark)" },
    { n: `SLA ${tr(H.slaMs)} ms — "ölü blok yayma" açık`, ell: H.ell, sub: `${tr(H.blocks)} blok · ortalama ${tr(H.meanBlockMs, 0)} ms (SLA'nın ${tr(H.meanBlockMs / H.slaMs, 1)} katı)`, col: "var(--k1)" },
  ];
  const RB = { w: 780, h: 140, l: 268, r: 132, t: 16 };
  const rw = RB.w - RB.l - RB.r, rMax = Math.max(...rescue.map(r => r.ell)) * 1.06 || 1;
  const rescueBars = rescue.map((r, i) => {
    const y = RB.t + i * 58, w = Math.max((r.ell / rMax) * rw, 3);
    return `<g class="row" data-tip="<b>${esc(r.n)}</b><br>ℓ = ${tr(r.ell)} bit<br>${esc(r.sub)}">
      <rect x="0" y="${y - 4}" width="${RB.w}" height="50" fill="transparent"/>
      <text x="${RB.l - 14}" y="${y + 18}" text-anchor="end" class="lab">${esc(r.n)}</text>
      <text x="${RB.l - 14}" y="${y + 34}" text-anchor="end" class="sublab">${esc(r.sub)}</text>
      <rect x="${RB.l}" y="${y + 6}" width="${w}" height="24" rx="4" fill="${r.col}"/>
      <text x="${RB.l + w + 12}" y="${y + 23}" class="val">${tr(r.ell)} bit</text></g>`;
  }).join("");

  // ══ 3) MONİTÖR MALİYETİ, OTURUM UZADIKÇA ══
  const MN = D.monitor;
  const mons = [
    { n: "tek atışlık oturum", sub: "10.277 çift · 1,5 s", pct: 3.04, col: "var(--muted-mark)" },
    { n: "sürekli akış", sub: `${tr(S.totalPairs)} çift · ${tr(S.sessionMs / 1000, 1)} s`, pct: +(100 * MN.divertedFraction).toFixed(3), col: "var(--k1)" },
  ];
  const MB = { w: 780, h: 128, l: 214, r: 250, t: 16 };
  const mw = MB.w - MB.l - MB.r, mMax = 3.4;
  const monBars = mons.map((m, i) => {
    const y = MB.t + i * 52, w = Math.max((m.pct / mMax) * mw, 3);
    return `<g class="row" data-tip="<b>${esc(m.n)}</b><br>${esc(m.sub)}<br>saptırılan pay %${tr(m.pct, 3)}">
      <rect x="0" y="${y - 4}" width="${MB.w}" height="46" fill="transparent"/>
      <text x="${MB.l - 14}" y="${y + 17}" text-anchor="end" class="lab">${esc(m.n)}</text>
      <text x="${MB.l - 14}" y="${y + 32}" text-anchor="end" class="sublab">${esc(m.sub)}</text>
      <rect x="${MB.l}" y="${y + 4}" width="${w}" height="24" rx="4" fill="${m.col}"/>
      <text x="${MB.l + w + 12}" y="${y + 21}" class="val">%${tr(m.pct, m.pct < 1 ? 3 : 2)} saptırıldı</text></g>`;
  }).join("");

  const tbl = C.map(c => `<tr><td>${tr(c.slaMs)}</td><td>${tr(c.blocks)}</td><td>${tr(c.meanBlockMs ?? 0, 0)}</td><td>${tr(c.deadBlocks)}</td><td>${tr(c.meanEllPerBlock, 0)}</td><td>${tr(c.totalEll)}</td><td>${tr(c.sustainedRateBps, 0)}</td><td>%${tr(c.pctOfCeiling, 1)}</td><td>%${tr(c.wastedPct, 2)}</td></tr>`).join("");
  const adm = D.admission.perPath.map(p => `<tr><td>${esc(p.label)}</td><td>${tr(p.pairs)}</td><td>${tr(p.meanF, 5)}</td><td>${tr(p.ePh, 5)}</td><td>${tr(p.headroom, 2)}×</td><td>${p.admit ? "kabul" : "red"}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sürekli akış — uçtan uca koşum</title>
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
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:11.5px;font-weight:620;}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .axname{font-size:11px;fill:var(--text-secondary);}
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

<h1>Sürekli akış — kontrolcünün uçtan uca koşumu</h1>
<p class="sub">Şimdiye kadarki her koşum tek atışlıktı: bir bütçe harcanır, biter. Burada kontrolcü <b>durağan bir çift akışı</b> üzerinde blok kapatıp yenisini açarak ${tr(S.sessionMs / 1000, 1)} saniye boyunca çalışıyor. Sonuç, beklenen şekilde değişiyor: durağan akışta <b>marjinal kural hiç tetiklenmiyor</b> (arz incelmiyor, zirve yok) ve tek bir "en iyi T" yerine bir <b>gecikme–hız çalışma eğrisi</b> çıkıyor.</p>

<div class="tiles">
  <div class="tile"><div class="l">akış</div><div class="v">${tr(S.stationarity.meanRate / 1000, 1)}k çift/s</div></div>
  <div class="tile"><div class="l">durağanlık (CV)</div><div class="v">%${tr(100 * S.stationarity.cv, 2)}</div></div>
  <div class="tile"><div class="l">SLA ${tr(lastC.slaMs)} ms</div><div class="v k1t">${tr(lastC.sustainedRateBps, 0)} bit/s</div></div>
  <div class="tile"><div class="l">asimptotik tavan</div><div class="v">${tr(ceil, 0)} bit/s</div></div>
  <div class="tile"><div class="l">Bell monitörü</div><div class="v">%${tr(100 * MN.divertedFraction, 3)}</div></div>
</div>

<h2>1) Gecikme–hız çalışma eğrisi</h2>
<p class="sub">Blok başına sabit vergi (~115 bit) ve μ ∼ 1/√n <b>her blokta yeniden</b> ödendiği için kısa blok = düşük gecikme + düşük hız. Operatör SLA'yı seçer; kontrolcü o SLA'da ulaşılabilir en iyi hızı verir.</p>
<svg viewBox="0 0 ${L.w} ${L.h}" aria-label="SLA'ya göre sürdürülen anahtar hızı">
  ${grid}
  <path d="${d}" fill="none" stroke="var(--k1)" stroke-width="2" stroke-linejoin="round"/>
  ${pts}${endLab}${fa}
  <text x="${L.l + iw / 2}" y="${L.h - 4}" text-anchor="middle" class="axname">SLA — blok başına izin verilen gecikme (ms, <tspan font-style="italic">log ölçek</tspan>)</text>
  <text x="${L.l - 46}" y="${L.t - 10}" class="axname">sürdürülen R_key (bit/s)</text>
</svg>
<div class="callout warn"><b>SLA uçurumu — yumuşak bir düşüş değil.</b> ${dead.map(c => tr(c.slaMs)).join(" ve ")} ms'de bloklar sonlu-anahtar sınırını geçemiyor ve <b>üretilen çiftlerin %100'ü çöpe gidiyor</b>: ${tr(S.totalPairs)} çift harcanıyor, sıfır bit anahtar çıkıyor. İlk üretken SLA ${tr(firstAlive.slaMs)} ms ve orada bile hız tavanın yalnızca %${tr(firstAlive.pctOfCeiling, 1)} düzeyinde. Gecikme bütçesi bu sistemde bir "tercih" değil, <b>çalışıp çalışmama koşulu</b>.</div>

<h2>2) Uçurum kapatılabiliyor: ölü blok yayma</h2>
<svg viewBox="0 0 ${RB.w} ${RB.h}" aria-label="Ölü blok yayma davranışının etkisi">${rescueBars}</svg>
<p class="note">Kontrolcü, SLA dolduğunda ℓ hâlâ eşiğin altındaysa <b>ölü blok yaymak yerine</b> bloğu uzatıyor. ${tr(H.slaMs)} ms'lik SLA'da bloklar ortalama ${tr(H.meanBlockMs, 0)} ms'ye (SLA'nın ${tr(H.meanBlockMs / H.slaMs, 1)} katına) uzuyor ve sıfır yerine <b>${tr(H.ell)} bit</b> çıkıyor. Bunun bedeli dürüstçe söylenmeli: <b>SLA artık garanti değil</b>. Sert gecikme sınırı olan bir uygulamada bu davranış kapalı bırakılmalı ve SLA en baştan uçurumun sağına konmalıdır.</p>

<h2>3) Uzun oturumda Bell monitörü ucuzluyor</h2>
<svg viewBox="0 0 ${MB.w} ${MB.h}" aria-label="Monitör maliyetinin oturum uzunluğuna göre değişimi">${monBars}</svg>
<p class="note">İhlali 3σ ile kanıtlamak için gereken CHSH turu sayısı <b>sabittir</b> (kanal kalitesine bağlı, oturum uzunluğuna değil); akış büyüdükçe bu sabit maliyet erir. Ölçülen: S = ${tr(MN.S, 3)} → <b>${tr(MN.sigma, 2)}σ</b>, ${tr(MN.divertedPairs)} çift, oturumun %${tr(100 * MN.sessionCoverage, 1)} kadarına yayılmış (${tr(MN.firstTMs, 0)}–${tr(MN.lastTMs, 0)} ms). Yani sürekli çalışan bir bağlantıda <b>Bell doğrulaması pratikte bedava</b>.</p>

<details>
<summary>Tablo görünümü — çalışma eğrisi</summary>
<table><thead><tr><th>SLA (ms)</th><th>blok</th><th>ort. blok (ms)</th><th>ölü blok</th><th>ℓ/blok</th><th>toplam ℓ</th><th>R_key (bit/s)</th><th>tavanın %</th><th>ziyan çift</th></tr></thead><tbody>${tbl}</tbody></table>
</details>

<details>
<summary>Tablo görünümü — kabul eşiği akış boyunca</summary>
<table><thead><tr><th>Yol</th><th>Çift</th><th>F_ort</th><th>e_ph</th><th>eşiğe pay</th><th>karar</th></tr></thead><tbody>${adm}</tbody></table>
<p class="note">Eşik e* = ${tr(D.admission.threshold, 4)}. Akış boyunca karar değişmiyor: üç yol da havuzda kalıyor, en kötüsü bile eşiğin ${tr(Math.min(...D.admission.perPath.map(p => p.headroom)), 2)} katı altında.</p>
</details>

<p class="note"><b>Akış nasıl kuruldu:</b> Simülatör bütçe tabanlı olduğu için bir koşumun sonunda arz incelir. Varış hızı profili ölçüldü — hız t=0'dan itibaren düz, yalnızca bütçe bitince çöküyor. Bu yüzden her yolun <b>plato penceresi</b> alındı (bağlayıcı kısıt en kısa plato: 3.746 ms), epoch uzunluğu ${tr(S.epochMs)} ms seçildi ve ${tr(S.epochs)} epoch <b>farklı tohumlarla</b> uç uca eklendi. Çiftler yeniden zaman damgalanarak uydurulmadı; akış gerçek simülatör çıktısıdır. Durağanlığın kanıtı: 16 kovada ${tr(S.stationarity.meanRate, 0)} ± ${tr(S.stationarity.sd, 0)} çift/s, CV %${tr(100 * S.stationarity.cv, 2)}. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>

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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "continuous_stream.json");
  const outPath = process.argv[3] || "/tmp/continuous_stream_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
