#!/usr/bin/env node
"use strict";
/**
 * gen_collapse_drill_chart.js — sadakat çöküşü tatbikatının kurul paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — "bant sanık mı?": ret oranı h'ye karşı ÇİZGİ, yanında
 *     çöküşün yarattığı sıçrama aynı eksende referans bandı olarak.
 *     İki büyüklük de PUAN → tek eksen. Suçlamayı çürüten şey ölçeğin
 *     karşılaştırılmasıdır, o yüzden ikisi aynı eksende olmalı.
 *   • Panel 2 — müdahale sıralaması: yatay çubuk, tek eksen (ret %).
 *     Renk ENTİTEYE bağlı: k1 = kontrol katmanı kolu, k2 = yük atma
 *     (farklı TÜR bir müdahale), k3 = müdahale yok referansı. Sıraya
 *     göre renk YOK.
 *   • Panel 3 — eşik merdiveni: tek F ekseni üzerinde dört işaret.
 *     Çubuk değil, çünkü karşılaştırılan şey büyüklük değil KONUM.
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
  const S = D.setup, I = D.incident, T = D.thresholds, LS = D.loadShedding;
  if (!LS) throw new Error("loadShedding eksik — rapor eski");

  // ══ 1) BANT SANIK MI ══
  const L1 = { w: 790, h: 260, l: 62, r: 150, t: 26, b: 48 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const yMax = Math.ceil((I.incident.denialPct + 10) / 10) * 10;
  const hs = I.bandSweep.map(b => b.h);
  const X1 = (i) => L1.l + (hs.length === 1 ? iw1 / 2 : (i / (hs.length - 1)) * iw1);
  const Y1 = (v) => L1.t + ih1 - (v / yMax) * ih1;
  let g1 = "";
  for (let v = 0; v <= yMax; v += 10) {
    g1 += `<line x1="${L1.l}" y1="${Y1(v)}" x2="${L1.l + iw1}" y2="${Y1(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(v) + 4}" text-anchor="end" class="tick">%${tr(v, 0)}</text>`;
  }
  // Çöküş öncesi taban
  g1 += `<line x1="${L1.l}" y1="${Y1(I.baseline.denialPct)}" x2="${L1.l + iw1}" y2="${Y1(I.baseline.denialPct)}" stroke="var(--k3)" stroke-width="2" stroke-dasharray="6 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(I.baseline.denialPct) + 4}" class="endlab k3t">çöküş öncesi</text>`;
  const pts = I.bandSweep.map((b, i) => `${X1(i)},${Y1(b.denialPct)}`).join(" ");
  g1 += `<polyline points="${pts}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  I.bandSweep.forEach((b, i) => {
    const tip = `h = ${tr(b.h, 2)}<br/>ret <b>%${tr(b.denialPct, 2)}</b><br/>KISMA bloğu ${tr(b.kismaBlocks)}<br/>en düşük doluluk %${tr(100 * b.minFill, 1)}`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(i)}" cy="${Y1(b.denialPct)}" r="11" fill="transparent"/>` +
      `<circle cx="${X1(i)}" cy="${Y1(b.denialPct)}" r="4.4" fill="var(--k1)"/></g>`;
    g1 += `<text x="${X1(i)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${tr(b.h, 2)}</text>`;
  });
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(I.bandSweep[I.bandSweep.length - 1].denialPct) + 4}" class="endlab k1t">çöküş altında</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">histerezis bandı h</text>`;
  // Ölçek karşılaştırması
  const xArrow = L1.l + iw1 * 0.30;
  g1 += `<line x1="${xArrow}" y1="${Y1(I.baseline.denialPct)}" x2="${xArrow}" y2="${Y1(I.incident.denialPct)}" stroke="var(--text-secondary)" stroke-width="1.4"/>`;
  g1 += `<text x="${xArrow + 8}" y="${(Y1(I.baseline.denialPct) + Y1(I.incident.denialPct)) / 2}" class="anno">çöküşün etkisi ${tr(I.denialJumpFromCollapse, 1)} puan</text>`;
  g1 += `<text x="${xArrow + 8}" y="${(Y1(I.baseline.denialPct) + Y1(I.incident.denialPct)) / 2 + 14}" class="anno">bandın etkisi ${tr(I.denialSpreadOverBands, 2)} puan</text>`;

  // ══ 2) MÜDAHALE SIRALAMASI ══
  const arms = [
    ...D.interventions.ranked.map(r => ({ ...r, kind: r.key === "hiçbir şey" ? "ref" : "kontrol" })),
    ...LS.sweep.filter(x => x.frac < 1).map(x => ({
      label: `yük atma: talebin %${Math.round(100 * x.frac)}'i`, denialPct: x.denialPct, kind: "yük",
    })),
  ];
  const L2 = { w: 790, h: 30 + arms.length * 23 + 40, l: 258, r: 74, t: 20, b: 34 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const xMax = 100;
  const X2 = (v) => L2.l + (v / xMax) * iw2;
  const rh = ih2 / arms.length;
  let g2 = "";
  for (let v = 0; v <= 100; v += 25) {
    g2 += `<line x1="${X2(v)}" y1="${L2.t}" x2="${X2(v)}" y2="${L2.t + ih2}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${X2(v)}" y="${L2.t + ih2 + 16}" text-anchor="middle" class="tick">%${tr(v, 0)}</text>`;
  }
  arms.forEach((a, i) => {
    const y = L2.t + i * rh + rh * 0.18, bh = rh * 0.62;
    const col = a.kind === "yük" ? "k2" : a.kind === "ref" ? "k3" : "k1";
    const tip = `${esc(a.label)}<br/>ret <b>%${tr(a.denialPct, 2)}</b>`;
    g2 += `<g class="row" data-tip="${esc(tip)}">` +
      `<rect x="${L2.l}" y="${y}" width="${Math.max(1.5, X2(a.denialPct) - L2.l)}" height="${bh}" rx="2.5" fill="var(--${col})"/></g>`;
    g2 += `<text x="${L2.l - 9}" y="${y + bh * 0.78}" text-anchor="end" class="lab">${esc(a.label)}</text>`;
    g2 += `<text x="${X2(a.denialPct) + 6}" y="${y + bh * 0.78}" class="val">%${tr(a.denialPct, 1)}</text>`;
  });
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 32}" text-anchor="middle" class="axname">istek reddetme oranı</text>`;

  // ══ 3) EŞİK MERDİVENİ ══
  const L3 = { w: 790, h: 186, l: 62, r: 62, t: 34, b: 46 };
  const iw3 = L3.w - L3.l - L3.r;
  const fLo = 0.50, fHi = 1.00;
  const X3 = (f) => L3.l + ((f - fLo) / (fHi - fLo)) * iw3;
  const yAxis = L3.t + 46;   // üstte iki etiket satırı, altta rakam + iki satır
  let g3 = `<line x1="${L3.l}" y1="${yAxis}" x2="${L3.l + iw3}" y2="${yAxis}" stroke="var(--grid)" stroke-width="2"/>`;
  for (let f = 0.5; f <= 1.0001; f += 0.1)
    g3 += `<text x="${X3(f)}" y="${yAxis + 20}" text-anchor="middle" class="tick">%${tr(100 * f, 0)}</text>`;
  // Anahtarın öldüğü bölge
  g3 += `<rect x="${X3(fLo)}" y="${yAxis - 9}" width="${X3(T.keyDeathF) - X3(fLo)}" height="18" fill="var(--muted-mark)" opacity="0.45"/>`;
  const marks = [
    { f: T.keyDeathF, lab: "anahtar ölür", sub: `%${tr(100 * T.keyDeathF, 1)}`, up: false, col: "k2" },
    { f: T.bellCertificationF, lab: "Bell sertifikası biter", sub: `%${tr(100 * T.bellCertificationF, 2)} · S = 2`, up: true, col: "k2" },
    { f: T.reportedCliff, lab: "bildirilen \"kritik eşik\"", sub: `%80 · S = ${tr(T.sAt080, 2)} (ihlal sürüyor)`, up: false, col: "k3" },
    { f: 0.845, lab: "şu anki durum", sub: `%84,5 · S = ${tr(T.sAtCollapse, 2)}`, up: true, col: "k1" },
  ];
  // Satırlar AYRI: yukarı işaretler eksenin üstünde iki satır, aşağı
  // işaretler rakam satırının ALTINDA iki satır. İlk sürümde aşağı
  // etiketler eksen rakamlarıyla çakışıyordu.
  for (const m of marks) {
    const x = X3(m.f);
    g3 += `<line x1="${x}" y1="${yAxis - 9}" x2="${x}" y2="${yAxis + 9}" stroke="var(--${m.col})" stroke-width="2.6"/>`;
    const yLab = m.up ? yAxis - 40 : yAxis + 40;
    const ySub = m.up ? yAxis - 27 : yAxis + 53;
    g3 += `<text x="${x}" y="${yLab}" text-anchor="middle" class="lab ${m.col}t">${esc(m.lab)}</text>`;
    g3 += `<text x="${x}" y="${ySub}" text-anchor="middle" class="anno">${esc(m.sub)}</text>`;
  }
  g3 += `<text x="${L3.l + iw3 / 2}" y="${L3.h - 6}" text-anchor="middle" class="axname">dolaşıklık sadakati F</text>`;

  const checkRows = D.checks.map(c => `<tr><td>${c.ok ? "✓" : "✗"}</td><td>${esc(c.name)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sadakat çöküşü tatbikatı</title>
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
  .lab{font-size:11.5px;fill:var(--text-primary);font-weight:560;}
  .val{font-size:11.5px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover rect:first-of-type,.row:hover circle:first-of-type{opacity:.78;}
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
<h1>Sadakat çöküşü tatbikatı — olay tanısı</h1>
<p class="sub">F ${tr(100 * S.fNominal, 1)}% → ${tr(100 * S.fCollapsed, 1)}% rampası pik yük altında uçtan uca koşturuldu. Soru: histerezis bandı mı çöktü, fotonik katman mı?</p>

<div class="tiles">
  <div class="tile"><div class="l">arz oranı</div><div class="v">×${tr(S.supplyRatio, 3)}</div></div>
  <div class="tile"><div class="l">ret (çöküşte)</div><div class="v">%${tr(I.incident.denialPct, 1)}</div></div>
  <div class="tile"><div class="l">bandın etkisi</div><div class="v">${tr(I.denialSpreadOverBands, 2)} puan</div></div>
  <div class="tile"><div class="l">CHSH S</div><div class="v">${tr(T.sAtCollapse, 2)}</div></div>
</div>

<h2>1 · Histerezis bandı sanık mı?</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Ret oranı bant genişliğine karşı">${g1}</svg>
<p class="note">Ret oranı h boyunca düz. Bandı en dardan en genişe süpürmek ${tr(I.denialSpreadOverBands, 2)} puan oynatıyor; sadakat çöküşü ${tr(I.denialJumpFromCollapse, 1)} puan oynatıyor. Ayrıca çöküş altında hiç KISMA bloğu yok — depo boş, kısıcı zaten sürekli üretim kipinde.</p>

<div class="callout warn">
  <b>Kısma tetiklenemiyor çünkü depo boş — bu arıza değil.</b> Kısma yalnızca depo <i>dolu</i> iken üretilmiş anahtarın çöpe gitmesini engellemek için vardır. Boş depoda üretimi kısmak açlığı derinleştirirdi. Kontrolcü doğru davranıyor.
</div>

<h2>2 · Hangi müdahale işe yarıyor</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k3)"></span>müdahale yok (referans)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>kontrol katmanı ayarı</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>yük atma</span>
</div>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Müdahale sıralaması">${g2}</svg>
<p class="note">Kontrol katmanındaki hiçbir ayar — bant, φ_high, depo boyutu, blok tavanı, model kalibrasyonu, baz yanlılığı — arz açığını kapatmıyor. Ölçülen sürdürülebilir seviye: talebin %${Math.round(100 * LS.sustainable.frac)}'i (${tr(LS.sustainable.demandBps)} bit/s).</p>

<h2>3 · Gerçek eşikler nerede</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Sadakat eşik merdiveni">${g3}</svg>
<p class="note">Bildirilen %80 &quot;kritik eşik&quot; fiziksel bir uçurum değil: orada CHSH ihlali sürüyor (S = ${tr(T.sAt080, 2)}) ve anahtar hâlâ pozitif. Sertifikasyon %${tr(100 * T.bellCertificationF, 2)}'de, anahtar üretimi %${tr(100 * T.keyDeathF, 1)}'de biter.</p>

<div class="callout">
  <b>Tanı:</b> bu bir güvenlik olayı değil, bir <b>kapasite</b> olayıdır. Sadakat düşüşü e_ph'yi yükseltip anahtar verimini ×${tr(S.supplyRatio, 3)}'e indirdi; talep sabit kaldığı için depo boşaldı ve istekler reddedildi. Bant, kısma ve depo katmanları doğru çalışıyor — arz açığını kapatacak tutamakları yok.
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table><tbody>${checkRows}</tbody></table>
<p class="note">Kaynak: <code>bb84/fidelity_collapse_drill.js</code> · ${tr(S.totalPairs)} çift, ${tr(S.sessionMs / 1000, 1)} s akış, ${tr(S.paths.length)} yol.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "fidelity_collapse_drill.json");
  const outPath = process.argv[3] || "/tmp/collapse_drill_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
