#!/usr/bin/env node
"use strict";
/**
 * gen_timetag_acquisition_chart.js — Faz 1 acquisition köprüsü paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — QBER FİZİKTEN: QBER vs karanlık sayım. eDetect tabanı
 *     (kesikli) + %11 iptal eşiği (kesikli k2). QBER'in sabit değil,
 *     dedektör fiziğinin ölçülen sonucu olduğunu gösterir. Tek eksen.
 *   • Panel 2 — KOİNSİDANS FRONTIER: verim (x) ↔ QBER (y), pencereye göre
 *     etiketli noktalar. Dar pencere düşük QBER/düşük verim; geniş tersi.
 *     Gerçek uzlaşım eğrisi. (Dual eksen YOK — frontier tek panelde.)
 *   • Panel 3 — GÜVENLİK: temiz hat (güvenli, k3) vs casus (iptal, k2)
 *     QBER, %11 eşik çizgisiyle. Punchline.
 *   • Renk ENTİTEYE bağlı: k1 = ölçülen QBER (mavi), k2 = eşik/casus/tehlike
 *     (turuncu), k3 = güvenli/taban (yeşil).
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const ABORT = D.eve.thresholdPct;      // 11
  const eDet = D.clean.eDetectPct;       // 1

  // ══ 1) QBER vs KARANLIK SAYIM ══
  const ds = D.darkSweep;
  const L1 = { w: 790, h: 270, l: 62, r: 150, t: 26, b: 52 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const xs = ds.map(r => r.darkProb);
  const lx = v => Math.log10(v);
  const xMin = lx(1e-4), xMax = lx(1e-2);
  const X1 = v => L1.l + (lx(v) - xMin) / (xMax - xMin) * iw1;
  const yMax1 = 6;
  const Y1 = v => L1.t + ih1 - Math.min(v, yMax1) / yMax1 * ih1;
  let g1 = "";
  for (let q = 0; q <= yMax1; q += 1) {
    g1 += `<line x1="${L1.l}" y1="${Y1(q)}" x2="${L1.l + iw1}" y2="${Y1(q)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 8}" y="${Y1(q) + 4}" text-anchor="end" class="tick">%${tr(q)}</text>`;
  }
  for (const v of [1e-4, 1e-3, 1e-2]) {
    g1 += `<text x="${X1(v)}" y="${L1.t + ih1 + 17}" text-anchor="middle" class="tick">${v}</text>`;
  }
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">karanlık sayım olasılığı (kapı başına, log)</text>`;
  g1 += `<text x="${L1.l - 46}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 46} ${L1.t + ih1 / 2})">ölçülen QBER</text>`;
  // eDetect tabanı
  g1 += `<line x1="${L1.l}" y1="${Y1(eDet)}" x2="${L1.l + iw1}" y2="${Y1(eDet)}" stroke="var(--k3)" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(eDet) + 4}" class="anno k3t">hizasızlık tabanı %${tr(eDet, 0)}</text>`;
  // eğri
  g1 += `<polyline points="${ds.map(r => `${X1(r.darkProb)},${Y1(r.qber)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  for (const r of ds) {
    const tip = `karanlık ${r.darkProb}<br/>QBER <b>%${tr(r.qber, 2)}</b> · ${r.secure ? "güvenli" : "iptal"}`;
    g1 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.darkProb)}" cy="${Y1(r.qber)}" r="9" fill="transparent"/>` +
      `<circle cx="${X1(r.darkProb)}" cy="${Y1(r.qber)}" r="3.6" fill="var(--k1)"/></g>`;
  }
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(ds[ds.length - 1].qber) + 4}" class="endlab k1t">QBER</text>`;

  // ══ 2) KOİNSİDANS FRONTIER (verim ↔ QBER) ══
  const ws = D.windowSweep;
  const L2 = { w: 790, h: 250, l: 62, r: 150, t: 24, b: 50 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const yldMax = Math.max(...ws.map(r => r.siftYield)) * 1.12;
  const qMax2 = Math.max(...ws.map(r => r.qber)) * 1.15;
  const X2 = v => L2.l + v / yldMax * iw2;
  const Y2 = v => L2.t + ih2 - v / qMax2 * ih2;
  let g2 = "";
  for (let q = 0; q <= qMax2; q += 1.5) {
    g2 += `<line x1="${L2.l}" y1="${Y2(q)}" x2="${L2.l + iw2}" y2="${Y2(q)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 8}" y="${Y2(q) + 4}" text-anchor="end" class="tick">%${tr(q, 1)}</text>`;
  }
  for (let y = 0; y <= yldMax; y += 2) g2 += `<text x="${X2(y)}" y="${L2.t + ih2 + 17}" text-anchor="middle" class="tick">%${tr(y)}</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 38}" text-anchor="middle" class="axname">elenmiş anahtar verimi (sifted / darbe)</text>`;
  g2 += `<text x="${L2.l - 46}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 46} ${L2.t + ih2 / 2})">QBER</text>`;
  g2 += `<polyline points="${ws.map(r => `${X2(r.siftYield)},${Y2(r.qber)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.4"/>`;
  const last = ws.length - 1;
  ws.forEach((r, i) => {
    const tip = `pencere ${r.windowPs} ps<br/>verim %${tr(r.siftYield, 2)} · QBER %${tr(r.qber, 2)}`;
    g2 += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X2(r.siftYield)}" cy="${Y2(r.qber)}" r="9" fill="transparent"/>` +
      `<circle cx="${X2(r.siftYield)}" cy="${Y2(r.qber)}" r="3.6" fill="var(--k1)"/></g>`;
    // Son iki nokta üst-sağda kümelenir → sağa yasla ve dikey ayır; ötekiler altta ortalı.
    if (i >= last - 1) {
      g2 += `<text x="${X2(r.siftYield) + 9}" y="${Y2(r.qber) + (i === last ? -4 : 10)}" text-anchor="start" class="tick">${r.windowPs}ps</text>`;
    } else {
      g2 += `<text x="${X2(r.siftYield)}" y="${Y2(r.qber) + 17}" text-anchor="middle" class="tick">${r.windowPs}ps</text>`;
    }
  });
  g2 += `<text x="${X2(ws[0].siftYield) + 6}" y="${Y2(ws[0].qber) - 12}" text-anchor="middle" class="anno k3t">dar pencere</text>`;
  g2 += `<text x="${X2(ws[last].siftYield) - 4}" y="${Y2(ws[last].qber) - 16}" text-anchor="end" class="anno k2t">geniş pencere</text>`;

  // ══ 3) GÜVENLİK — temiz vs casus ══
  const L3 = { w: 790, h: 200, l: 130, r: 120, t: 24, b: 40 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const q3Max = 30;
  const X3 = v => L3.l + v / q3Max * iw3;
  const bars = [{ lab: "temiz hat", q: D.clean.qber, col: "k3", ok: true },
    { lab: "intercept-resend casusu", q: D.eve.qber, col: "k2", ok: false }];
  let g3 = "";
  for (let q = 0; q <= q3Max; q += 5) {
    g3 += `<line x1="${X3(q)}" y1="${L3.t}" x2="${X3(q)}" y2="${L3.t + ih3}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${X3(q)}" y="${L3.t + ih3 + 16}" text-anchor="middle" class="tick">%${tr(q)}</text>`;
  }
  const bh = 40, gap = 26;
  bars.forEach((b, i) => {
    const y = L3.t + 12 + i * (bh + gap);
    g3 += `<rect x="${L3.l}" y="${y}" width="${X3(b.q) - L3.l}" height="${bh}" rx="4" fill="var(--${b.col})" opacity="0.9"/>`;
    g3 += `<text x="${L3.l - 10}" y="${y + bh / 2 + 4}" text-anchor="end" class="anno">${b.lab}</text>`;
    g3 += `<text x="${X3(b.q) + 8}" y="${y + bh / 2 + 4}" class="endlab ${b.col}t">%${tr(b.q, 1)} · ${b.ok ? "güvenli ✓" : "İPTAL ✗"}</text>`;
  });
  // %11 eşik
  g3 += `<line x1="${X3(ABORT)}" y1="${L3.t}" x2="${X3(ABORT)}" y2="${L3.t + ih3}" stroke="var(--k2)" stroke-width="1.6" stroke-dasharray="6 4"/>`;
  g3 += `<text x="${X3(ABORT)}" y="${L3.t - 6}" text-anchor="middle" class="anno k2t">%${tr(ABORT, 0)} BB84 iptal eşiği</text>`;
  g3 += `<text x="${X3(25)}" y="${L3.t + ih3 + 33}" text-anchor="middle" class="anno">~%25 = BB84 intercept-resend teorik imzası</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Acquisition köprüsü</title>
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
  .endlab{font-size:12px;font-weight:640;}
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
<h1>Acquisition köprüsü — ham tıklamadan elenmiş anahtara</h1>
<p class="sub">Faz 1: bir time-tagger'ın ps zaman-etiketli dedektör tıklama akışını (gerçek dedektör kusurlarıyla — verim, karanlık sayım, jitter, ölü zaman) koinsidans pencereleme + sifting ile elenmiş anahtara çeviren köprü. Kritik: QBER sabit kodlu değil, dedektör fiziğinden türer — ve casus bu veriye yansır. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">temiz QBER</div><div class="v">%${tr(D.clean.qber, 2)}</div></div>
  <div class="tile"><div class="l">casus QBER</div><div class="v">%${tr(D.eve.qber, 0)}</div></div>
  <div class="tile"><div class="l">iptal eşiği</div><div class="v">%${tr(ABORT, 0)}</div></div>
  <div class="tile"><div class="l">QRNG yayılımı</div><div class="v">%${tr(D.qrngSeam.spread, 2)}</div></div>
</div>

<h2>1 · QBER fizikten gelir — karanlık sayımla yükselir</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="QBER vs karanlık sayım">${g1}</svg>
<p class="note">Temiz hatta QBER optik hizasızlık tabanına (~%${tr(eDet, 0)}) oturuyor; karanlık sayım oranı arttıkça öngörülebilir biçimde yükseliyor (%${tr(ds[0].qber, 1)}→%${tr(ds[ds.length - 1].qber, 1)}). QBER bir parametre değil, dedektör fiziğinin <b>ölçülen</b> sonucu — Faz 3'te gerçek dedektör verisiyle yeniden kalibre edilecek olan tam da bu.</p>

<h2>2 · Koinsidans penceresi — verim ↔ QBER uzlaşımı</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Koinsidans frontier">${g2}</svg>
<p class="note">Pencereyi daraltmak karanlık sayımları dışlar (QBER↓) ama jitter'lı gerçek koinsidansları da keser (verim↓); genişletmek tersi. İkisi bir frontier çiziyor — ODLS'deki kayıp bütçesi gibi, optimum ortada. Bu, tahminsel jitter/ODLS kontrol fikirlerinin donanım-döngüde sınandığı yer.</p>

<h2>3 · Güvenlik — casus veriye yansır ve yakalanır</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Güvenlik">${g3}</svg>
<p class="note">intercept-resend casusu, Alice/Bob bazları uyuştuğunda %25 hata enjekte eder (BB84 imzası) — ölçülen QBER %${tr(D.eve.qber, 1)}, %${tr(ABORT, 0)} eşiğini aşıyor → anahtar <b>iptal</b>. Köprü, gerçekçi gürültülü veri altında bile QKD'nin "ölçünce boz" güvencesini koruyor: güvenlik matematikte değil, ölçülen fizikte.</p>

<div class="callout"><b>Ne kanıtlandı:</b> ham time-tag akışından elenmiş anahtara giden "son mil" köprüsü (acquisition + koinsidans + sifting) çalışıyor, ve <b>QBER dedektör fiziğinden türüyor</b> — sabit bir sayı değil. QRNG seam yerinde: Alice'in anahtar seçimi crypto entropiden (üretimde donanım QRNG buraya takılır), <code>mulberry32</code> yalnız fiziksel gürültüde. Casus veriye yansıyıp eşikte yakalanıyor. Elenmiş bitler Faz 0 KME biçimine paketleniyor. <b>Dürüst sınır:</b> bu emülatörün gürültü modeli; Faz 3'te gerçek dedektör verisi (afterpulsing, ölü-zaman detayı, verim uyumsuzluğu) bu sayıları yeniden kalibre eder.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/timetag_acquisition_bridge.js</code> + <code>timetag_acquisition_test.js</code>. Çekirdek SHA-256 değişmedi.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "timetag_acquisition.json");
  const outPath = process.argv[3] || "/tmp/timetag_acquisition_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
