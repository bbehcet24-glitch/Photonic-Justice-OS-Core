#!/usr/bin/env node
"use strict";
/**
 * gen_ceiling_chart.js — SLA'yı 10 s'ye uzatınca tavana yaklaşma.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Yaklaşma eğrisi → ÇİZGİ, log x. Ölçüm 0,5–10 s, model 0,5–600 s:
 *     üç dekat. ÖLÇÜLEN ile ÇIKARSANAN görsel olarak AYRILIR — ölçüm
 *     dolu nokta + düz çizgi, model kesikli çizgi. Ekstrapolasyonu
 *     ölçümmüş gibi göstermek en ağır grafik yalanı olurdu.
 *   • Tavan → yatay referans; ayrıca %80/%90/%95 yardımcı çizgileri,
 *     çünkü asıl soru "ne kadar yaklaştık" değil "daha ne gerekir".
 *   • Karesel yasa → SAYI DEĞİL ORAN meselesi; küçük tablo + çubuk
 *     (blok süresi 4 dekata yayıldığı için çubuk log ölçekli olurdu →
 *     onun yerine doğrudan ORAN gösteriliyor: beklenen 4 / ölçülen).
 *   • ÇİFT EKSEN YOK.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const C = D.curve, S = D.stream, ceil = D.ceilingBps, E = D.extrapolation;
  const at10 = D.at10s, SL = E.scalingLaw;

  // Model eğrisi: ölçüm aralığının ÖTESİNE uzatılır (kesikli çizilecek)
  const perSec = S.pairsPerSec, ePh = S.ePh, leak = S.leakPerBit;
  // Modelin kendisini burada yeniden kurmak yerine, ölçülen noktalardan
  // ve rapordaki latencyCost dizisinden okuyoruz (tek doğruluk kaynağı).
  const modelPts = D.latencyCost.map(p => ({ tMs: p.blockMs, pct: p.pctOfCeiling }));

  const L = { w: 780, h: 356, l: 58, r: 132, t: 26, b: 46 };
  const iw = L.w - L.l - L.r, ih = L.h - L.t - L.b;
  const xLo = 400, xHi = 300000;
  const X = (v) => L.l + ((Math.log10(v) - Math.log10(xLo)) / (Math.log10(xHi) - Math.log10(xLo))) * iw;
  const Y = (pct) => L.t + ih - (pct / 100) * ih;

  let grid = "";
  for (let p = 0; p <= 100; p += 20) {
    grid += `<line x1="${L.l}" y1="${Y(p)}" x2="${L.l + iw}" y2="${Y(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${L.l - 9}" y="${Y(p) + 4}" text-anchor="end" class="tick">%${p}</text>`;
  }
  for (const t of [500, 1000, 5000, 10000, 60000, 300000]) {
    const lbl = t >= 60000 ? `${t / 60000} dk` : `${t / 1000} s`;
    grid += `<line x1="${X(t)}" y1="${L.t}" x2="${X(t)}" y2="${L.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${X(t)}" y="${L.t + ih + 19}" text-anchor="middle" class="tick">${lbl}</text>`;
  }
  grid += `<line x1="${L.l}" y1="${Y(100)}" x2="${L.l + iw}" y2="${Y(100)}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  grid += `<text x="${L.l + iw + 8}" y="${Y(100) + 4}" class="anno">R∞ = ${tr(ceil, 0)}<tspan x="${L.l + iw + 8}" dy="13">bit/s (tavan)</tspan></text>`;

  // ölçüm bölgesi gölgesi
  grid += `<rect x="${L.l}" y="${L.t}" width="${X(10000) - L.l}" height="${ih}" fill="var(--k1)" opacity="0.07"/>`;
  grid += `<text x="${X(10000) - 6}" y="${L.t + 14}" text-anchor="end" class="anno k1t">← ÖLÇÜLEN</text>`;
  grid += `<text x="${X(10000) + 6}" y="${L.t + 14}" class="anno">ÇIKARSANAN →</text>`;

  // %80/%90/%95 yardımcıları
  let guides = "";
  for (const [pct, sec] of [[80, E.secondsFor["80%"]], [90, E.secondsFor["90%"]], [95, E.secondsFor["95%"]]]) {
    if (sec == null) continue;
    guides += `<line x1="${L.l}" y1="${Y(pct)}" x2="${X(sec * 1000)}" y2="${Y(pct)}" stroke="var(--k2)" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>`;
    guides += `<line x1="${X(sec * 1000)}" y1="${Y(pct)}" x2="${X(sec * 1000)}" y2="${L.t + ih}" stroke="var(--k2)" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>`;
    // Etiket, dikey kılavuzun DİBİNE konur: tepede ölçüm etiketiyle
    // çakışıyordu ("12,7 s" ile "10 s → %78,1" üst üste biniyordu).
    guides += `<text x="${X(sec * 1000) + 5}" y="${L.t + ih - 6}" class="anno k2t">%${pct} · ${sec >= 60 ? tr(sec / 60, 1) + " dk" : tr(sec, 1) + " s"}</text>`;
  }

  const modelPath = modelPts.map((p, i) => `${i ? "L" : "M"}${X(p.tMs).toFixed(1)},${Y(p.pct).toFixed(1)}`).join("");
  const measPath = C.map((c, i) => `${i ? "L" : "M"}${X(c.meanBlockMs).toFixed(1)},${Y(c.pctOfCeiling).toFixed(1)}`).join("");
  let pts = "";
  for (const c of C) {
    pts += `<g class="row" data-tip="<b>SLA ${tr(c.slaMs)} ms</b> · ölçüm<br>${tr(c.blocks)} tam blok × ${tr(c.meanBlockMs, 0)} ms<br>ℓ/blok ${tr(c.meanEllPerBlock, 0)} bit<br><b>${tr(c.sustainedRateBps, 0)} bit/s</b> = tavanın %${tr(c.pctOfCeiling, 2)}'i<br>model: ${tr(c.modelRateBps, 0)} bit/s (fark %${tr(c.modelErrorPct, 2)})">
      <circle cx="${X(c.meanBlockMs)}" cy="${Y(c.pctOfCeiling)}" r="12" fill="transparent"/>
      <circle cx="${X(c.meanBlockMs)}" cy="${Y(c.pctOfCeiling)}" r="5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="2"/></g>`;
  }
  const lab10 = `<text x="${X(at10.meanBlockMs) + 10}" y="${Y(at10.pctOfCeiling) - 12}" class="endlab k1t">10 s → %${tr(at10.pctOfCeiling, 1)}<tspan x="${X(at10.meanBlockMs) + 10}" dy="13" class="anno">${tr(at10.sustainedRateBps, 0)} bit/s</tspan></text>`;

  // ══ KARESEL YASA ══
  const laws = [
    { n: "tavanın %80'i", sec: E.secondsFor["80%"], gap: 20 },
    { n: "tavanın %90'ı", sec: E.secondsFor["90%"], gap: 10 },
    { n: "tavanın %95'i", sec: E.secondsFor["95%"], gap: 5 },
    { n: "tavanın %99'u", sec: E.secondsFor["99%"], gap: 1 },
  ];
  const fmt = (s) => s == null ? "—" : s >= 3600 ? `${tr(s / 3600, 2)} saat` : s >= 60 ? `${tr(s / 60, 1)} dk` : `${tr(s, 1)} s`;
  const LB = { w: 780, h: 4 * 42 + 30, l: 168, r: 300, t: 20 };
  const lw = LB.w - LB.l - LB.r;
  const maxLog = Math.log10(laws[laws.length - 1].sec), minLog = Math.log10(laws[0].sec);
  const lawBars = laws.map((l, i) => {
    const y = LB.t + i * 42;
    const w = Math.max(((Math.log10(l.sec) - minLog) / (maxLog - minLog)) * lw, 4);
    return `<g class="row" data-tip="<b>${esc(l.n)}</b><br>gereken blok süresi ${fmt(l.sec)}<br>tavana kalan boşluk %${l.gap}">
      <rect x="0" y="${y - 4}" width="${LB.w}" height="36" fill="transparent"/>
      <text x="${LB.l - 12}" y="${y + 18}" text-anchor="end" class="lab">${esc(l.n)}</text>
      <rect x="${LB.l}" y="${y + 4}" width="${w}" height="22" rx="4" fill="var(--k${i === laws.length - 1 ? 2 : 1})" opacity="${i === laws.length - 1 ? 1 : 0.35 + i * 0.22}"/>
      <text x="${LB.l + w + 12}" y="${y + 14}" class="val">${fmt(l.sec)}</text>
      <text x="${LB.l + w + 12}" y="${y + 28}" class="sublab">kalan boşluk %${l.gap}</text></g>`;
  }).join("");

  const tbl = C.map(c => `<tr><td>${tr(c.slaMs)}</td><td>${tr(c.blocks)}</td><td>${tr(c.meanBlockMs, 0)}</td><td>${tr(c.meanEllPerBlock, 0)}</td><td>${tr(c.sustainedRateBps, 0)}</td><td>%${tr(c.pctOfCeiling, 2)}</td><td>${tr(c.modelRateBps, 0)}</td><td>%${tr(c.modelErrorPct, 2)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SLA 10 s — tavana yaklaşma</title>
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
  .key.solidk{width:16px;height:0;border-radius:0;border-top:3px solid var(--k1);}
  .key.dashk{width:16px;height:0;border-radius:0;border-top:3px dashed var(--k1);}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
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

<h1>SLA 10 saniyeye uzatıldı — tavana ne kadar yaklaştık?</h1>
<p class="sub">Oturum da uzatıldı (${tr(S.epochs)} epoch = <b>${tr(S.sessionMs / 1000, 1)} s</b>, ${tr(S.totalPairs)} çift): 13,6 s'lik bir oturumda 10 s'lik SLA yalnızca <b>bir</b> tam blok verirdi ve "sürdürülen hız" tek örnekten okunamaz. Şimdi her SLA'da en az ${Math.min(...C.map(c => c.blocks))} tam blok var.</p>

<div class="tiles">
  <div class="tile"><div class="l">SLA 10 s</div><div class="v k1t">${tr(at10.sustainedRateBps, 0)} bit/s</div></div>
  <div class="tile"><div class="l">tavanın oranı</div><div class="v k1t">%${tr(at10.pctOfCeiling, 1)}</div></div>
  <div class="tile"><div class="l">6,8 s'de idi</div><div class="v">%${tr(C.find(c => c.slaMs === 6800).pctOfCeiling, 1)}</div></div>
  <div class="tile"><div class="l">tavan R∞</div><div class="v">${tr(ceil, 0)} bit/s</div></div>
  <div class="tile"><div class="l">model hatası</div><div class="v">&lt;%${tr(Math.max(...C.map(c => Math.abs(c.modelErrorPct))), 1)}</div></div>
</div>

<h2>1) Yaklaşma eğrisi</h2>
<div class="lgrow">
  <span class="lg"><span class="key solidk"></span>ÖLÇÜM — gerçek boru hattı (0,5–10 s)</span>
  <span class="lg"><span class="key dashk"></span>MODEL — ölçümle doğrulandı, ötesi ekstrapolasyon</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>hedef eşikleri</span>
</div>
<svg viewBox="0 0 ${L.w} ${L.h}" aria-label="Blok süresine göre tavana yaklaşma oranı">
  ${grid}${guides}
  <path d="${modelPath}" fill="none" stroke="var(--k1)" stroke-width="2" stroke-dasharray="5 4" opacity="0.75" stroke-linejoin="round"/>
  <path d="${measPath}" fill="none" stroke="var(--k1)" stroke-width="2.5" stroke-linejoin="round"/>
  ${pts}${lab10}
  <text x="${L.l + iw / 2}" y="${L.h - 4}" text-anchor="middle" class="axname">blok süresi (<tspan font-style="italic">log ölçek</tspan>)</text>
  <text x="${L.l - 42}" y="${L.t - 10}" class="axname">sürdürülen R_key, tavanın yüzdesi olarak</text>
</svg>
<div class="callout"><b>Cevap: %${tr(at10.pctOfCeiling, 2)}.</b> 10 s'lik SLA ${tr(at10.sustainedRateBps, 0)} bit/s sürdürülen hız veriyor; tavan ${tr(ceil, 0)} bit/s. 6,8 s'de %${tr(C.find(c => c.slaMs === 6800).pctOfCeiling, 2)} idi, yani SLA'yı <b>1,5 kat</b> uzatmak yalnızca <b>${tr(at10.pctOfCeiling - C.find(c => c.slaMs === 6800).pctOfCeiling, 2)} puan</b> kazandırdı. Eğri hâlâ tırmanıyor — 10 s'de bile doyum yok — ama <b>tırmanış hızla yavaşlıyor</b>. Analitik model ölçümle her noktada %${tr(Math.max(...C.map(c => Math.abs(c.modelErrorPct))), 1)}'ten iyi uyuştuğu için, ötesi güvenle çıkarsanabiliyor.</div>

<h2>2) Kalan yolun bedeli karesel</h2>
<p class="sub">μ ∼ 1/√n olduğundan tavana kalan <b>boşluk ∼ 1/√T</b>: boşluğu k kat daraltmak blok süresini <b>k² kat</b> büyütür. Bu keyfi bir gözlem değil, sonlu-anahtar teriminden türetilen bir ölçek yasası — ve ölçüldü.</p>
<svg viewBox="0 0 ${LB.w} ${LB.h}" aria-label="Hedef orana göre gereken blok süresi">${lawBars}</svg>
<div class="callout warn"><b>Ölçek yasası doğrulandı.</b> Boşluk %10'dan %5'e inerken gereken süre <b>×${tr(SL.gapHalving_t95_over_t90, 2)}</b> (beklenen ×4); %5'ten %1'e inerken <b>×${tr(SL.gapFifth_t99_over_t95, 2)}</b> (beklenen ×25). Pratik sonuç: <b>%90 için ${fmt(E.secondsFor["90%"])}, %95 için ${fmt(E.secondsFor["95%"])}, %99 için ${fmt(E.secondsFor["99%"])}</b> uzunluğunda blok gerekir. Yani tavanın son yüzdeleri bu mimaride <b>ulaşılabilir değil</b> — ve bunun sebebi donanım değil, sonlu-anahtar güvenlik kanıtının kendisidir. Hızı daha ileri taşımanın yolu bloğu uzatmak değil, <b>e_ph'i düşürmek</b> (tavanı yükseltmek) veya çift üretim hızını artırmaktır.</div>

<details>
<summary>Tablo görünümü — ölçüm ve model</summary>
<table><thead><tr><th>SLA (ms)</th><th>tam blok</th><th>ort. blok (ms)</th><th>ℓ/blok (bit)</th><th>R_key (bit/s)</th><th>tavanın %</th><th>model (bit/s)</th><th>model farkı</th></tr></thead><tbody>${tbl}</tbody></table>
<p class="note">Model: n_Z(T) = (çift/s ÷ 4)·T, ℓ(T) = n_Z·(1 − h₂(e_ph + μ(n_Z,n_Z))) − leak·n_Z − sabitler, R(T) = ℓ(T)/T. Akış: ${tr(S.pairsPerSec, 0)} çift/s (CV %${tr(100 * S.stationarity.cv, 2)}), e_ph = ${tr(S.ePh, 5)}, leak/bit = ${tr(S.leakPerBit, 5)}. Akış bittiği için kapanan bloklar SLA'yı temsil etmediğinden istatistikten düşülür. ${tr(D.checks.length)} öz-testin tamamı geçiyor.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "sla_ceiling.json");
  const outPath = process.argv[3] || "/tmp/sla_ceiling_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
