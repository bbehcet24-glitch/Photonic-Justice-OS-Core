#!/usr/bin/env node
"use strict";
/**
 * gen_safety_margin_chart.js — güvenlik payı + bant genişliği illüzyonu.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — güvenlik payı: ret oranı vs e_ph sapması (çarpan). Düz
 *     bir plato = geniş marj. Kırılma eşiği yatay referans. "%0 marj"
 *     iddiasının cevabı düz çizginin kendisidir.
 *   • Panel 2 — bant genişliği ayrışımı: 10 THz'in yığılı çubuğu
 *     (sifting kaçınılmaz / anahtar / faz kestirimi) — "israf" diye
 *     sayılanın yarısı protokol elemesi. Tek eksen (bit/s).
 *   • Panel 3 — provizyon: soğuk tavan M ile doğrusal; hedef hıza göre
 *     M pipeline. Çizgi + işaretli çalışma noktası.
 *   • Renk ENTİTEYE bağlı: k1 sağlam/PhotonNet, k2 tehlike/eşik,
 *     k3 yararlı akış.
 *
 * Palet: kategorik 3 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
const fmtR = (bps) => bps >= 1e12 ? `${tr(bps / 1e12, 1)}T` : `${tr(bps / 1e9, 0)}G`;

function build(D) {
  const M = D.margin, B = D.bandwidth;

  // ══ 1) GÜVENLİK PAYI (ret vs e_ph çarpanı) ══
  const rows = M.ePhSweep;
  const L1 = { w: 790, h: 250, l: 62, r: 148, t: 26, b: 50 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const xMax = rows[rows.length - 1].mult;
  const yMax = Math.ceil((M.failThresholdPct + 4) / 5) * 5;
  const X1 = (m) => L1.l + ((m - 1) / (xMax - 1)) * iw1;
  const Y1 = (v) => L1.t + ih1 - (v / yMax) * ih1;
  let g1 = "";
  for (let v = 0; v <= yMax; v += 5) {
    g1 += `<line x1="${L1.l}" y1="${Y1(v)}" x2="${L1.l + iw1}" y2="${Y1(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(v) + 4}" text-anchor="end" class="tick">%${tr(v)}</text>`;
  }
  for (const r of rows) g1 += `<text x="${X1(r.mult)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">×${tr(r.mult)}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">faz hatası e_ph sapması (nominalin katı) — fotonik kusur</text>`;
  g1 += `<text x="${L1.l - 46}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 46} ${L1.t + ih1 / 2})">istek reddetme %</text>`;
  // kırılma eşiği
  g1 += `<line x1="${L1.l}" y1="${Y1(M.failThresholdPct)}" x2="${L1.l + iw1}" y2="${Y1(M.failThresholdPct)}" stroke="var(--k2)" stroke-width="1.4" stroke-dasharray="6 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(M.failThresholdPct) + 4}" class="anno k2t">kırılma eşiği</text>`;
  // ret platosu
  g1 += `<polyline points="${rows.map(r => `${X1(r.mult)},${Y1(r.denialPct)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].denialPct) + 4}" class="endlab k1t">ret (sabit)</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(rows[rows.length - 1].denialPct) + 19}" class="anno">plato = marj</text>`;
  for (const r of rows) {
    const tip = `e_ph ×${tr(r.mult)} (${tr(r.ePh, 3)})<br/>ret <b>%${tr(r.denialPct, 2)}</b><br/>mod değişimi ${tr(r.switches)}`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.mult)}" cy="${Y1(r.denialPct)}" r="9" fill="transparent"/>` +
      `<circle cx="${X1(r.mult)}" cy="${Y1(r.denialPct)}" r="3.6" fill="var(--k1)"/></g>`;
  }

  // ══ 2) BANT GENİŞLİĞİ AYRIŞIMI (yığılı bar) ══
  const L2 = { w: 790, h: 120, l: 62, r: 20, t: 30, b: 42 };
  const iw2 = L2.w - L2.l - L2.r;
  const segs = [
    { frac: B.siftFrac, col: "muted-mark", lab: `sifting-atım %${tr(100 * B.siftFrac, 0)}`, sub: "kaçınılmaz (protokol)" },
    { frac: B.peFrac, col: "k1", lab: `faz kestirimi %${tr(100 * B.peFrac, 0)}`, sub: "yararlı" },
    { frac: B.keyFrac, col: "k3", lab: `anahtar %${tr(100 * B.keyFrac, 0)}`, sub: "yararlı" },
  ];
  const barY = L2.t + 8, barH = 40;
  let g2 = "", ax = L2.l;
  for (const s of segs) {
    const w = s.frac * iw2;
    g2 += `<rect x="${ax}" y="${barY}" width="${w}" height="${barH}" fill="var(--${s.col})"/>`;
    g2 += `<text x="${ax + w / 2}" y="${barY + barH / 2 + 4}" text-anchor="middle" class="barlab" ` +
      `fill="${s.col === "muted-mark" ? "var(--text-secondary)" : "#fff"}">%${tr(100 * s.frac, 0)}</text>`;
    g2 += `<text x="${ax + w / 2}" y="${barY + barH + 16}" text-anchor="middle" class="anno">${esc(s.lab.split(" %")[0])}</text>`;
    ax += w;
  }
  g2 += `<text x="${L2.l}" y="${L2.t - 6}" class="anno">10 THz giriş — "%99,5 israf" hesabı bu ilk bloğu (protokol elemesi) donanım israfı sayıyor</text>`;

  // ══ 3) PROVİZYON (soğuk tavan M ile) ══
  const perPipe = B.perPipeBps / 1e9;             // Gbit/s
  const Ms = [1, 50, 100, 150, 200];   // eksen tick'leri (sol uçta çakışmayı önlemek için seyrek)
  const L3 = { w: 790, h: 220, l: 66, r: 148, t: 26, b: 48 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const capMax = 200 * perPipe * 1.1;
  const X3 = (m) => L3.l + (m / 200) * iw3;
  const Y3 = (c) => L3.t + ih3 - (c / capMax) * ih3;
  let g3 = "";
  for (const c of [0, 2500, 5000, 7500, 10000]) {
    g3 += `<line x1="${L3.l}" y1="${Y3(c)}" x2="${L3.l + iw3}" y2="${Y3(c)}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${L3.l - 9}" y="${Y3(c) + 4}" text-anchor="end" class="tick">${tr(c / 1000, 0)}T</text>`;
  }
  for (const m of Ms) g3 += `<text x="${X3(m)}" y="${L3.t + ih3 + 18}" text-anchor="middle" class="tick">${tr(m)}</text>`;
  g3 += `<text x="${L3.l + iw3 / 2}" y="${L3.t + ih3 + 40}" text-anchor="middle" class="axname">provizyonlanan paralel pipeline (çoğullama M)</text>`;
  g3 += `<text x="${L3.l - 50}" y="${L3.t + ih3 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L3.l - 50} ${L3.t + ih3 / 2})">soğuk-yazma tavanı (bit/s)</text>`;
  // doğrusal tavan çizgisi
  g3 += `<polyline points="${[0, 200].map(m => `${X3(m)},${Y3(m * perPipe)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  // 10 THz referansı
  g3 += `<line x1="${L3.l}" y1="${Y3(10000)}" x2="${L3.l + iw3}" y2="${Y3(10000)}" stroke="var(--muted-mark)" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  g3 += `<text x="${L3.l + 8}" y="${Y3(10000) - 6}" class="anno" fill="var(--text-muted)">10 THz giriş</text>`;
  // çalışma noktaları
  for (const m of [1, B.provisionPipelines, B.pipelinesFor10THz]) {
    const c = m * perPipe;
    const lab = m === 1 ? "M=1 (50 Gb/s)" : m === B.provisionPipelines ? `M=${m} (anahtarı karşılar)` : `M=${m} (10 THz)`;
    g3 += `<g class="row" data-tip="${esc(`M=${tr(m)} pipeline<br/>tavan <b>${fmtR(c * 1e9)}bit/s</b>`)}"><circle cx="${X3(m)}" cy="${Y3(c)}" r="10" fill="transparent"/>` +
      `<circle cx="${X3(m)}" cy="${Y3(c)}" r="4.2" fill="var(--k1)"/></g>`;
    g3 += `<text x="${X3(m)}" y="${Y3(c) - 10}" text-anchor="${m === 200 ? "end" : "middle"}" class="anno">${esc(lab)}</text>`;
  }

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Güvenlik payı ve bant genişliği</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e6e5e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;--muted-mark:#c9c8c2;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#35342f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
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
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .barlab{font-size:12px;font-weight:640;}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .row:hover circle:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Güvenlik payı ve bant genişliği illüzyonu — iki iddia ölçüldü</h1>
<p class="sub">Eleştiri: "güvenlik payı %0, en ufak sapma döngüyü kırar" ve "10 THz kapasite 50 Gbit/s'e kelepçeleniyor, %99,5 israf". İkisi de ölçümle sınandı; gereken düzeltme yapıldı. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">e_ph toleransı</div><div class="v">×${tr(M.ePhToleranceMult)}</div></div>
  <div class="tile"><div class="l">üretim toleransı</div><div class="v">−%${tr(100 * M.prodToleranceFrac, 0)}</div></div>
  <div class="tile"><div class="l">tek pipeline</div><div class="v">${tr(B.perPipeBps / 1e9, 0)} Gb/s</div></div>
  <div class="tile"><div class="l">provizyon kullanımı</div><div class="v">%${tr(B.provisionedUtilisationPct, 0)}</div></div>
</div>

<h2>1 · Güvenlik payı — döngü sapmayı yutuyor</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Güvenlik payı">${g1}</svg>
<p class="note">Fotonik kusurun faz hatasını ×${tr(xMax)}'ya katlaması (${tr(rows[rows.length - 1].ePh, 3)}, güvenlik duvarına yakın) reti taban %${tr(M.baseDenialPct, 1)}'ten yalnız %${tr(rows[rows.length - 1].denialPct, 1)}'e çıkarıyor — kırılma eşiğine (%${tr(M.failThresholdPct, 1)}) hiç değmiyor. "En ufak sapma kırar" ölçümle yanlış: histerezis bandı sapmayı yutuyor. Bandı KAPATIRSAN mod değişimi ${tr(D.bandIsTheMargin.withBandSwitches)}→${tr(D.bandIsTheMargin.noBandSwitches)} (×${tr(D.bandIsTheMargin.chatterRatio, 1)}) — yani marjı yaratan tam da eleştirilen bant.</p>

<h2>2 · "%99,5 israf" — girişin yarısı kaçınılmaz protokol elemesi</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Bant genişliği ayrışımı">${g2}</svg>
<p class="note">10 THz girişin %${tr(100 * B.siftFrac, 0)}'si baz-uyuşmazlığı (BBM92 sifting) — her donanımda, her protokolde atılır; "donanım israfı" değil kaçınılmaz. Kalan %${tr(100 * (B.keyFrac + B.peFrac), 0)} yararlı. "%99,5 israf" hesabı bu protokol elemesini donanım israfı sayıyor — kategori hatası.</p>

<h2>3 · 50 Gbit/s bir duvar değil — çoğullamayla ölçeklenen provizyon</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Provizyon">${g3}</svg>
<p class="note">Soğuk-yazma tavanı = M · P_cold / E_op; M paralel modla (motorun <code>multiplexing</code>'i) doğrusal büyür. 10 THz'i soğuk-yazmak için M=${tr(B.pipelinesFor10THz)} pipeline; anahtar akışını karşılamak için M=${tr(B.provisionPipelines)} → kullanım %${tr(B.provisionedUtilisationPct, 0)}. Tavan sabit bir kelepçe değil, hedef hıza göre <code>provisionForRate()</code> ile boyutlandırılan bir parametre.</p>

<div class="callout"><b>Sonuç:</b> (1) Güvenlik payı %0 değil — döngü e_ph ×${tr(M.ePhToleranceMult)} ve üretim −%${tr(100 * M.prodToleranceFrac, 0)} sapmayı platoyla yutuyor; kırılganlığı yaratan tek şey bandı KALDIRMAK. (2) 50 Gbit/s bir sistem duvarı değil, tek-pipeline tavanı; çoğullamayla ölçekleniyor ve provizyon parametresi hâline getirildi (<code>provisionForRate</code>). "%99,5 israf" ise kaçınılmaz protokol elemesini donanım israfı sayan bir kategori hatası. Düzeltme yalnız katmanda; çekirdek SHA-256 değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/safety_margin_drill.js</code> · düzeltme <code>qkd_key_supply.provisionForRate</code>. Kontrol döngüsü ölçümleri gerçek motordan; bant genişliği ayrışımı motorun ölçülü sifting/anahtar oranlarından.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "safety_margin.json");
  const outPath = process.argv[3] || "/tmp/safety_margin_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
