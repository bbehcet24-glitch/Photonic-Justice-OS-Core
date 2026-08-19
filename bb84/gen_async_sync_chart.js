#!/usr/bin/env node
"use strict";
/**
 * gen_async_sync_chart.js — asimetrik senkronizasyon tatbikatının paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — kilitlenme uçurumu: son-çeyrek verim vs drift, iki çizgi
 *     (naif / durum-tabanlı). Aynı birim (%) → tek eksen. Canlı-kilit
 *     eşiği dikey işaretle. Asıl "deadlock riski" sorusunun cevabı budur.
 *   • Panel 2 — teslim zaman çizgisi: yüksek-drift naif akış (donma
 *     bantları görünür) vs durum-tabanlı (kesintisiz). Küçük çoklu
 *     şerit; renk entiteye bağlı.
 *   • Renk ENTİTEYE bağlı: k2 (turuncu) = naif zaman-penceresi (SORUN)
 *     her panelde; k1 (mavi) = durum-tabanlı mimari (SAĞLAM).
 *
 * Palet: kategorik 2 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const SW = D.skewSweep, DL = D.deadlock, R = D.resyncIdempotency;
  if (!DL || !DL.drifts) throw new Error("rapor eksik — async_sync.json eski");

  // ══ 1) KİLİTLENME UÇURUMU ══
  const rows = DL.drifts;
  const L1 = { w: 790, h: 300, l: 66, r: 150, t: 26, b: 52 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const dMax = rows[rows.length - 1].driftPerPkt;
  const X1 = (d) => L1.l + (d / dMax) * iw1;
  const Y1 = (p) => L1.t + ih1 - (p / 100) * ih1;
  let g1 = "";
  for (let p = 0; p <= 100; p += 25) {
    g1 += `<line x1="${L1.l}" y1="${Y1(p)}" x2="${L1.l + iw1}" y2="${Y1(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(p) + 4}" text-anchor="end" class="tick">%${tr(p)}</text>`;
  }
  for (const r of rows)
    g1 += `<text x="${X1(r.driftPerPkt)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${tr(r.driftPerPkt, 2)}</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">asimetrik sürüklenme (ms / paket)</text>`;
  g1 += `<text x="${L1.l - 50}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 50} ${L1.t + ih1 / 2})">son-çeyrek veri akışı</text>`;
  // canlı-kilit eşiği
  if (DL.livelockDrift != null) {
    g1 += `<line x1="${X1(DL.livelockDrift)}" y1="${L1.t}" x2="${X1(DL.livelockDrift)}" y2="${L1.t + ih1}" stroke="var(--muted-mark)" stroke-width="1.4" stroke-dasharray="4 4"/>`;
    g1 += `<text x="${X1(DL.livelockDrift)}" y="${L1.t - 4}" text-anchor="middle" class="anno">canlı-kilit eşiği ${tr(DL.livelockDrift, 2)}</text>`;
  }
  // %20 referans
  g1 += `<line x1="${L1.l}" y1="${Y1(20)}" x2="${L1.l + iw1}" y2="${Y1(20)}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="2 4"/>`;
  const lineP = (key, col, lab, sub, fmt) => {
    let g = `<polyline points="${rows.map(r => `${X1(r.driftPerPkt)},${Y1(r[key])}`).join(" ")}" fill="none" stroke="var(--${col})" stroke-width="2.6"/>`;
    for (const r of rows) {
      const tip = `drift ${tr(r.driftPerPkt, 2)} ms/paket<br/>${esc(lab)}: <b>%${tr(r[key], 1)}</b>` +
        (col === "k2" ? `<br/>resync ${tr(r.naiveResyncs)} · ek ${tr(r.naiveResyncOps)} işlem` : "");
      g += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X1(r.driftPerPkt)}" cy="${Y1(r[key])}" r="10" fill="transparent"/>` +
        `<circle cx="${X1(r.driftPerPkt)}" cy="${Y1(r[key])}" r="4" fill="var(--${col})"/></g>`;
    }
    const last = rows[rows.length - 1];
    g += `<text x="${L1.l + iw1 + 12}" y="${Y1(last[key]) + 4}" class="endlab ${col}t">${esc(lab)}</text>`;
    if (sub) g += `<text x="${L1.l + iw1 + 12}" y="${Y1(last[key]) + 19}" class="anno">${esc(sub)}</text>`;
    return g;
  };
  g1 += lineP("statefulTailPct", "k1", "durum-tabanlı", "sabit %100");
  g1 += lineP("naiveTailPct", "k2", "zaman-pencer.", "↓ donma");

  // ══ 2) TESLİM ZAMAN ÇİZGİSİ (yüksek drift) ══
  const TL = DL.timelines;
  const L2 = { w: 790, h: 168, l: 66, r: 150, t: 20, b: 30 };
  const iw2 = L2.w - L2.l - L2.r;
  // Zaman çizgileri raporda zaten 200 kutuya sıkıştırılmış geliyor.
  const bins = TL.stateful.length;
  const strips = [
    { tl: TL.stateful, col: "k1", lab: "durum-tabanlı" },
    { tl: TL.highDrift, col: "k2", lab: "zaman-pencer." },
  ];
  const sh = 34, gap = 16;
  let g2 = "";
  strips.forEach((st, si) => {
    const y = L2.t + si * (sh + gap);
    const bw = iw2 / bins;
    for (let i = 0; i < bins; i++) {
      const v = st.tl[i];               // 1 = akıyor, 0 = donuk
      const op = 0.15 + 0.85 * v;
      g2 += `<rect x="${L2.l + i * bw}" y="${y}" width="${bw + 0.5}" height="${sh}" fill="var(--${st.col})" opacity="${op.toFixed(3)}"/>`;
    }
    g2 += `<rect x="${L2.l}" y="${y}" width="${iw2}" height="${sh}" fill="none" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l + iw2 + 12}" y="${y + sh / 2 + 4}" class="lab ${st.col}t">${esc(st.lab)}</text>`;
  });
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + strips.length * (sh + gap) + 4}" text-anchor="middle" class="axname">zaman (oturum boyunca) — koyu = akıyor, açık = donuk</text>`;

  // Statik skew tablosu
  const skewTbl = SW.rows.map(r => `<tr><td>${tr(r.skewMs)}</td><td>%${tr(r.naiveDropPct, 2)}</td>` +
    `<td>%${tr(r.naiveThroughputPct, 1)}</td><td>${tr(r.naiveResyncs)}</td><td>%${tr(r.statefulDropPct, 2)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Asimetrik senkronizasyon tatbikatı</title>
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
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover circle:first-of-type{opacity:.7;}
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
<h1>Asimetrik senkronizasyon tatbikatı — durum kayması, replay, kilitlenme</h1>
<p class="sub">Düğümler arası el sıkışmaya milisaniyelik asimetrik gecikme (skew/jitter) enjekte edildi. Saldırının varsaydığı zaman-penceresi tasarımı ile mimarinin kullandığı durum-tabanlı (içerik-adresli) tasarım yarıştırıldı. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">canlı-kilit eşiği (naif)</div><div class="v">${DL.livelockDrift != null ? tr(DL.livelockDrift, 2) + " ms" : "—"}</div></div>
  <div class="tile"><div class="l">durum-tabanlı düşme</div><div class="v">%0</div></div>
  <div class="tile"><div class="l">resync uçuş ezmesi</div><div class="v">${R ? tr(R.clobber.doubleIssued) : "—"}→${R ? tr(R.fixed.doubleIssued) : "—"}</div></div>
  <div class="tile"><div class="l">öz-test</div><div class="v">${D.checks.filter(c => c.ok).length}/${D.checks.length}</div></div>
</div>

<h2>1 · Kilitlenme uçurumu — sürekli asimetrik sürüklenme altında</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>naif zaman-penceresi (resync + donma)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>durum-tabanlı mimari (içerik-adresli)</span>
</div>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Kilitlenme uçurumu">${g1}</svg>
<p class="note">Skew paket başına sürüklendikçe naif tasarım resync'e sığınıyor; ama her resync el sıkışması boyunca akış donuyor ve skew bu sırada da sürüklenmeye devam ediyor. Drift ${tr(DL.livelockDrift, 2)} ms/paket'i aşınca donma süresi baskın oluyor ve veri akışı %20'nin altına düşüyor — resync fırtınası + donma = <b>canlı-kilit</b>. Durum-tabanlı tasarımın böyle bir eşiği yok: her drift düzeyinde %100.</p>

<h2>2 · Veri akışı zaman çizgisi (drift ${tr(TL.highDriftVal, 2)} ms/paket)</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Teslim zaman çizgisi">${g2}</svg>
<p class="note">Aynı yüksek-drift koşulunda: durum-tabanlı akış kesintisiz (üst şerit koyu), naif akış giderek genişleyen donma bantlarına giriyor (alt şerit açılıyor) — oturumun sonuna doğru veri akışı tümüyle donuyor.</p>

<div class="callout warn">
  <b>Neden bağışık?</b> Saldırı zaman-penceresi senkronizasyonu VARSAYAR. Mimari ise el sıkışmayı ZAMAN'la değil KİMLİK'le (key_ID) doğrular: gecikmeli gelen geçerli bir paket, kimliği daha önce görülmediyse kabul edilir; replay yalnızca aynı kimlik iki kez gelirse reddedilir. Hizalanacak bir saat olmadığı için skew, jitter ve drift doğrulama sonucunu değiştirmez — resync gerekmez, donma olmaz.
</div>

<div class="callout">
  <b>Yine de bir açık bulundu ve kapatıldı — resync idempotensi.</b> Gerçek KME el sıkışmasında bir resync (deponun yeniden içe aktarılması) uçuştaki teslimi eziyordu: master'a enc edilmiş ama slave'in geç dec ettiği ${R ? tr(R.clobber.inflight) : ""} anahtar resync sonrası "henüz teslim edilmemiş" diye reddediliyor (${R ? tr(R.clobber.decDropped) : ""} düşme) ve TEKRAR enc edilebiliyordu (${R ? tr(R.clobber.doubleIssued) : ""} çift teslim → replay koruması kırık). Düzeltme: içe aktarım artık birleştirmeli (merge) — var olan key_ID'nin durumu korunuyor, çift teslim ${R ? tr(R.fixed.doubleIssued) : ""}.
</div>

<details><summary>Statik skew — resync bunu düzeltebiliyor (öz-testler ${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table><thead><tr><th>skew (ms)</th><th>naif düşme</th><th>naif verim</th><th>resync</th><th>durum-tabanlı düşme</th></tr></thead>
<tbody>${skewTbl}</tbody></table>
<p class="note">Statik (sürüklenmeyen) skew öldürücü değil: pencereyi aşınca düşme başlar, bir resync o anki skew'i öğrenip telafi eder ve akış toparlanır. Tek istisna pencere-altı bant (skew ${tr(SW.windowMs - 1)}ms): jitter kimi paketi düşürecek kadar taşırır ama ardışık düşme resync eşiğine ulaşmaz — düzeltilmeyen "kör nokta". Kaynak: <code>bb84/async_sync_drill.js</code>.</p>
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
  const inPath = process.argv[2] || path.join(__dirname, "reports", "async_sync.json");
  const outPath = process.argv[3] || "/tmp/async_sync_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
