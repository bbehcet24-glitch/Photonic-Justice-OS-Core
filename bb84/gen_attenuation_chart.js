#!/usr/bin/env node
"use strict";
/**
 * gen_attenuation_chart.js
 * attenuation_sweep_test.js'in ürettiği JSON'dan tek-dosya, etkileşimli
 * (hover + tablo + koyu mod) grafik üretir.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • α basamakları SIRALI bir büyüklüktür (kimlik değil) → kategorik
 *     palet DEĞİL, tek-hue SIRALI (ordinal) mavi rampa. 5 basamak,
 *     validate_palette.js --ordinal her iki modda PASS.
 *   • Tur sayısı ve kaynak maliyeti FARKLI ÖLÇEKLERDE → ÇİFT EKSEN
 *     KULLANILMADI (kılavuzdaki 1 numaralı anti-desen). İki AYRI grafik,
 *     maliyet grafiği logaritmik eksende.
 *   • Ölçülen vs analitik tur: biri asıl mesele, diğeri referans →
 *     VURGU (emphasis): ölçülen mavi, analitik gri.
 *   • Tek serili grafiklerde legend YOK (başlık zaten neyi çizdiğini söylüyor).
 *
 * Kullanım: node gen_attenuation_chart.js [girdi.json] [cikti.html]
 */
const fs = require("fs");

const RAMP_L = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_D = ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#184f95"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// DİKKAT: `d ? {...} : undefined` yazımı d=0 için ÇALIŞMAZ (0 falsy'dir) ve
// ondalık sınırı sessizce uygulanmaz — çift SAYILARI "123.810,197" gibi
// anlamsız ondalıklarla görünüyordu. Açıkça undefined kontrolü gerekiyor.
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { maximumFractionDigits: d } : undefined);

function build(D) {
  const A = D.alphaSweep;
  const AN = D.dejmpsRounds.analytic.filter(x => Number.isFinite(x.cost));
  const ME = D.dejmpsRounds.measured;
  const KM_MAX_PLOT = 60;

  // ══ GRAFİK 1: α → verim eğrileri ══
  const G1 = { w: 720, h: 292, l: 54, r: 112, t: 22, b: 46 };
  const w1 = G1.w - G1.l - G1.r, h1 = G1.h - G1.t - G1.b;
  const maxY1 = Math.ceil(Math.max(...A.flatMap(a => a.curve.map(c => c.meanYieldPct))) / 10) * 10;
  const x1 = (km) => G1.l + (km / KM_MAX_PLOT) * w1;
  const y1 = (v) => G1.t + h1 - (v / maxY1) * h1;
  let g1 = "";
  for (let i = 0; i <= 4; i++) {
    const v = maxY1 * (1 - i / 4), y = G1.t + (h1 / 4) * i;
    g1 += `<line x1="${G1.l}" y1="${y}" x2="${G1.l + w1}" y2="${y}" class="grid"/><text x="${G1.l - 9}" y="${y + 4}" text-anchor="end" class="tick">${v % 1 ? v.toFixed(1) : v}%</text>`;
  }
  for (let km = 0; km <= KM_MAX_PLOT; km += 10) g1 += `<text x="${x1(km)}" y="${G1.t + h1 + 20}" text-anchor="middle" class="tick">${km}</text>`;
  A.forEach((a, i) => {
    const pts = a.curve.filter(c => c.km <= KM_MAX_PLOT);
    g1 += `<path d="${pts.map((c, j) => `${j ? "L" : "M"} ${x1(c.km).toFixed(1)},${y1(c.meanYieldPct).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--s${i + 1})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (a.criticalKm != null && a.criticalKm <= KM_MAX_PLOT) {
      const p = pts.find(c => c.km === a.criticalKm);
      if (p) g1 += `<circle cx="${x1(p.km)}" cy="${y1(p.meanYieldPct)}" r="5.5" fill="var(--s${i + 1})" stroke="var(--surface-1)" stroke-width="2"/>`;
    }
  });
  const legend1 = A.map((a, i) => `<span class="lg"><span class="key" style="background:var(--s${i + 1})"></span>α = ${esc(a.label)} dB/km</span>`).join("");

  // ══ GRAFİK 2: gereken tur sayısı vs F_ham (basamak) ══
  const G2 = { w: 720, h: 232, l: 54, r: 24, t: 20, b: 46 };
  const w2 = G2.w - G2.l - G2.r, h2h = G2.h - G2.t - G2.b;
  const fMin = 0.50, fMax = 0.96;
  const maxR = Math.max(...AN.map(a => a.rounds));
  const x2 = (F) => G2.l + ((fMax - F) / (fMax - fMin)) * w2;   // sağdan sola: F azalır
  const y2 = (r) => G2.t + h2h - (r / (maxR + 1)) * h2h;
  let g2 = "";
  for (let r = 0; r <= maxR; r++) {
    const y = y2(r);
    g2 += `<line x1="${G2.l}" y1="${y}" x2="${G2.l + w2}" y2="${y}" class="grid"/><text x="${G2.l - 9}" y="${y + 4}" text-anchor="end" class="tick">${r}</text>`;
  }
  for (const F of [0.95, 0.90, 0.80, 0.70, 0.60, 0.55, 0.52, 0.50]) {
    g2 += `<text x="${x2(F)}" y="${G2.t + h2h + 20}" text-anchor="middle" class="tick">${F.toFixed(2)}</text>`;
  }
  const sorted = [...AN].sort((a, b) => b.F - a.F);
  g2 += `<path d="${sorted.map((a, j) => `${j ? "L" : "M"} ${x2(a.F).toFixed(1)},${y2(a.rounds).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  sorted.forEach(a => { g2 += `<circle cx="${x2(a.F)}" cy="${y2(a.rounds)}" r="4.5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/>`; });
  // F=0.5 duvarı
  g2 += `<line x1="${x2(0.5)}" y1="${G2.t}" x2="${x2(0.5)}" y2="${G2.t + h2h}" stroke="var(--wall)" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  g2 += `<text x="${x2(0.5) - 8}" y="${G2.t + 14}" text-anchor="end" class="wall">F = 0,5 — arıtma imkânsız</text>`;

  // ══ GRAFİK 3: kaynak maliyeti (log ölçek) ══
  const G3 = { w: 720, h: 250, l: 66, r: 24, t: 20, b: 46 };
  const w3 = G3.w - G3.l - G3.r, h3 = G3.h - G3.t - G3.b;
  const maxLog = Math.ceil(Math.log10(Math.max(...AN.map(a => a.cost))));
  const x3 = (F) => G3.l + ((fMax - F) / (fMax - fMin)) * w3;
  const y3 = (c) => G3.t + h3 - (Math.log10(Math.max(c, 1)) / maxLog) * h3;
  let g3 = "";
  for (let e = 0; e <= maxLog; e++) {
    const y = y3(Math.pow(10, e));
    g3 += `<line x1="${G3.l}" y1="${y}" x2="${G3.l + w3}" y2="${y}" class="grid"/><text x="${G3.l - 9}" y="${y + 4}" text-anchor="end" class="tick">${tr(Math.pow(10, e))}</text>`;
  }
  for (const F of [0.95, 0.90, 0.80, 0.70, 0.60, 0.55, 0.52, 0.50]) {
    g3 += `<text x="${x3(F)}" y="${G3.t + h3 + 20}" text-anchor="middle" class="tick">${F.toFixed(2)}</text>`;
  }
  g3 += `<path d="${sorted.map((a, j) => `${j ? "L" : "M"} ${x3(a.F).toFixed(1)},${y3(a.cost).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  sorted.forEach(a => { g3 += `<circle cx="${x3(a.F)}" cy="${y3(a.cost)}" r="4.5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/>`; });
  const last = sorted[sorted.length - 1];
  g3 += `<text x="${x3(last.F) - 6}" y="${y3(last.cost) - 12}" text-anchor="end" class="val">${tr(last.cost, 0)} çift</text>`;
  g3 += `<line x1="${x3(0.5)}" y1="${G3.t}" x2="${x3(0.5)}" y2="${G3.t + h3}" stroke="var(--wall)" stroke-width="1.5" stroke-dasharray="5,4"/>`;

  // ══ GRAFİK 4: ölçülen vs analitik tur (vurgu) ══
  const G4 = { w: 720, h: 236, l: 54, r: 118, t: 22, b: 46 };
  const w4 = G4.w - G4.l - G4.r, h4 = G4.h - G4.t - G4.b;
  const maxR4 = Math.ceil(Math.max(...ME.map(m => m.measuredRounds)) + 0.5);
  const kmMax4 = Math.max(...ME.map(m => m.km));
  const x4 = (km) => G4.l + (km / kmMax4) * w4;
  const y4 = (r) => G4.t + h4 - (r / maxR4) * h4;
  let g4 = "";
  for (let r = 0; r <= maxR4; r++) {
    const y = y4(r);
    g4 += `<line x1="${G4.l}" y1="${y}" x2="${G4.l + w4}" y2="${y}" class="grid"/><text x="${G4.l - 9}" y="${y + 4}" text-anchor="end" class="tick">${r}</text>`;
  }
  for (const m of ME) g4 += `<text x="${x4(m.km)}" y="${G4.t + h4 + 20}" text-anchor="middle" class="tick">${m.km}</text>`;
  g4 += `<path d="${ME.map((m, j) => `${j ? "L" : "M"} ${x4(m.km).toFixed(1)},${y4(m.analyticRounds).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--muted-mark)" stroke-width="2" stroke-dasharray="6,4"/>`;
  g4 += `<path d="${ME.map((m, j) => `${j ? "L" : "M"} ${x4(m.km).toFixed(1)},${y4(m.measuredRounds).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
  ME.forEach(m => { g4 += `<circle cx="${x4(m.km)}" cy="${y4(m.measuredRounds)}" r="4.5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/>`; });
  const lastM = ME[ME.length - 1];
  g4 += `<text x="${x4(lastM.km) + 10}" y="${y4(lastM.measuredRounds) + 4}" class="val">ölçülen ${lastM.measuredRounds}</text>`;
  g4 += `<text x="${x4(lastM.km) + 10}" y="${y4(lastM.analyticRounds) + 4}" class="valmuted">analitik ${lastM.analyticRounds}</text>`;

  const alphaTable = A.map((a, i) => `<tr><td><span class="key" style="background:var(--s${i + 1})"></span>${esc(a.label)}</td><td>${esc(a.tech)}</td><td>%${a.at94.lossPct}</td><td>%${a.at94.meanYieldPct}</td><td>${a.criticalKm} km</td><td>${a.workingKm} km</td></tr>`).join("");
  const roundTable = AN.map(a => `<tr><td>${a.F.toFixed(3)}</td><td>${a.rounds}</td><td>${tr(a.cost, 0)}</td><td>${a.p1 != null ? a.p1.toFixed(4) : "—"}</td></tr>`).join("");
  const measTable = ME.map(m => `<tr><td>${m.km} km</td><td>${m.Fraw.toFixed(4)}</td><td>${m.measuredRounds}</td><td>${m.analyticRounds}</td><td>+${m.roundOverhead}</td><td>%${m.yieldPct}</td></tr>`).join("");

  const lossless = A[0], std = A.find(a => a.a === 0.2), bad = A[A.length - 1];

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kanal zayıflaması ve DEJMPS tur maliyeti</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f5f4f1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#e3e2dd;
    --accent:#2a78d6;--muted-mark:#c9c8c2;--wall:#d03b3b;
    --s1:${RAMP_L[0]};--s2:${RAMP_L[1]};--s3:${RAMP_L[2]};--s4:${RAMP_L[3]};--s5:${RAMP_L[4]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --accent:#3987e5;--muted-mark:#4a4a46;--wall:#e66767;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --accent:#3987e5;--muted-mark:#4a4a46;--wall:#e66767;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--surface-1);
    color:var(--text-primary);max-width:860px;margin:0 auto;padding:28px 20px 56px;}
  h1{font-size:21px;line-height:1.3;margin:0 0 6px;font-weight:650;}
  h2{font-size:15px;margin:34px 0 4px;font-weight:600;}
  p.sub{color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:0 0 4px;}
  p.note{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0 0;}
  .kpi{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:11px 15px;min-width:112px;}
  .tile .l{font-size:11px;color:var(--text-secondary);}
  .tile .v{font-size:21px;font-weight:680;margin-top:3px;letter-spacing:-.01em;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle;margin-right:6px;}
  .lg{font-size:12px;color:var(--text-secondary);margin-right:13px;display:inline-flex;align-items:center;}
  .legend{margin:6px 0 2px;}
  svg{display:block;max-width:100%;height:auto;}
  .tick{font-size:11px;fill:var(--text-secondary);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .valmuted{font-size:12px;fill:var(--text-muted);}
  .wall{font-size:11px;fill:var(--wall);}
  .grid{stroke:var(--grid);stroke-width:1;}
  .callout{background:var(--surface-2);border-left:3px solid var(--accent);border-radius:6px;padding:11px 15px;margin-top:14px;font-size:13px;line-height:1.6;}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:10px;}
  th,td{border:1px solid var(--grid);padding:6px 10px;text-align:left;}
  th{background:var(--surface-2);font-weight:600;}
  .tip{position:fixed;pointer-events:none;background:var(--surface-2);color:var(--text-primary);border:1px solid var(--grid);
    border-radius:7px;padding:8px 11px;font-size:12px;line-height:1.5;max-width:320px;opacity:0;transition:opacity .1s;z-index:9;
    box-shadow:0 2px 10px rgba(0,0,0,.14);}
  details{margin-top:14px;} summary{cursor:pointer;font-size:13px;color:var(--text-secondary);}
</style></head>
<body><div class="viz-root">

<h1>Kanal zayıflaması (α) taraması ve DEJMPS tur maliyeti</h1>
<p class="sub">Farklı fiber kalitelerinin menzile etkisi, ve DEJMPS arıtmasının düşük-sadakat (F &gt; 0,5) rejiminde harcadığı tur sayısı ile kaynak bedeli. Her sayı ${D.method.seeds} tohumla gerçekten koşturularak ölçülmüştür.</p>

<div class="kpi">
  <div class="tile"><div class="l">Kayıpsız kanal (α=0)</div><div class="v">${lossless.criticalKm} km</div></div>
  <div class="tile"><div class="l">SMF-28 (α=0,20)</div><div class="v">${std.criticalKm} km</div></div>
  <div class="tile"><div class="l">Kötü fiber (α=0,40)</div><div class="v">${bad.criticalKm} km</div></div>
  <div class="tile"><div class="l">F=0,502'de tur</div><div class="v">${AN[AN.length - 1].rounds}</div></div>
  <div class="tile"><div class="l">F=0,502'de maliyet</div><div class="v">${tr(AN[AN.length - 1].cost, 0)}×</div></div>
</div>

<h2>1) Fiber kalitesi → verim (mesafeye göre)</h2>
<div class="legend">${legend1}</div>
<svg viewBox="0 0 ${G1.w} ${G1.h}" aria-label="Zayıflama katsayısına göre verim eğrileri">
  <rect width="${G1.w}" height="${G1.h}" fill="var(--surface-1)"/>${g1}
  <text x="${G1.l + w1 / 2}" y="${G1.h - 8}" text-anchor="middle" class="tick">Düğümler arası mesafe (km)</text>
</svg>
<p class="note">İçi dolu nokta = o fiber kalitesinin kritik eşiği.</p>

<div class="callout"><b>Asıl bulgu:</b> kaybı TAMAMEN sıfırlamak (α = 0) bile mesafe sınırını <b>kaldırmıyor</b> — kayıpsız kanalda dahi eşik ${lossless.criticalKm} km'de kalıyor. Demek ki bu rejimde menzili belirleyen şey fiberin zayıflaması değil, <b>faz gürültüsünün mesafeyle birikmesi ve bellek dekoheransı</b>. Daha iyi fiber almak yardımcı olur (${bad.criticalKm} → ${std.criticalKm} → ${lossless.criticalKm} km) ama problemi çözmez; çözüm arıtma ve bellek tarafındadır.</div>
<p class="note"><b>α = 0 hakkında dürüstlük notu:</b> ${esc(D.method.alphaZeroNote)}</p>

<h2>2) DEJMPS: hedefe ulaşmak için gereken tur sayısı</h2>
<p class="sub">Yatay eksen SAĞDAN SOLA azalan ham sadakat. Hedef bağ sadakati ${D.dejmpsRounds.linkTarget}. F = 0,5 kırmızı kesikli duvar: bu değerin altında DEJMPS bir çifti <b>hiç</b> yukarı çekemez (cebirsel sınır: I′ &gt; I ⟺ 2I²−3I+1 &lt; 0 ⟺ F &gt; 0,5).</p>
<svg viewBox="0 0 ${G2.w} ${G2.h}" aria-label="Gereken DEJMPS tur sayısı">
  <rect width="${G2.w}" height="${G2.h}" fill="var(--surface-1)"/>${g2}
  <text x="${G2.l + w2 / 2}" y="${G2.h - 8}" text-anchor="middle" class="tick">Ham sadakat F (sağdan sola azalıyor)</text>
</svg>

<h2>3) Kaynak bedeli — çıktı başına ham çift (logaritmik)</h2>
<p class="sub">Her tur 2 çift tüketip p olasılıkla 1 çift üretir, yani maliyet Π(2/pᵢ). F düştükçe hem tur sayısı artar hem p → 0,5'e iner: bedel <b>çifte-üstel</b> patlar.</p>
<svg viewBox="0 0 ${G3.w} ${G3.h}" aria-label="Çıktı başına ham çift maliyeti, logaritmik ölçek">
  <rect width="${G3.w}" height="${G3.h}" fill="var(--surface-1)"/>${g3}
  <text x="${G3.l + w3 / 2}" y="${G3.h - 8}" text-anchor="middle" class="tick">Ham sadakat F (sağdan sola azalıyor)</text>
</svg>
<p class="note">F = 0,90'da bir çıktı için ${tr(AN.find(a => Math.abs(a.F - 0.9) < 1e-9).cost, 1)} ham çift yeterken, F = 0,502'de <b>${tr(AN[AN.length - 1].cost, 0)}</b> ham çift gerekiyor — ${tr(AN[AN.length - 1].cost / AN.find(a => Math.abs(a.F - 0.9) < 1e-9).cost, 0)} kat. Eksen logaritmik olduğu için bu patlama düz bir çizgi gibi görünür; gerçek büyüme çok daha serttir.</p>

<h2>4) Ölçülen tur ≠ analitik tur — dekoheransın gizli bedeli</h2>
<p class="sub">Analitik hesap ideal arıtmayı varsayar (bekleme yok, dekoherans yok). Simülasyonda çiftler eşlerini beklerken dekohere olur, sadakatleri düşer ve hedefe ulaşmak <b>fazladan tur</b> gerektirir.</p>
<div class="legend"><span class="lg"><span class="key" style="background:var(--accent)"></span>simülasyonda ölçülen</span><span class="lg"><span class="key" style="background:var(--muted-mark)"></span>analitik (ideal)</span></div>
<svg viewBox="0 0 ${G4.w} ${G4.h}" aria-label="Ölçülen ve analitik tur sayısı karşılaştırması">
  <rect width="${G4.w}" height="${G4.h}" fill="var(--surface-1)"/>${g4}
  <text x="${G4.l + w4 / 2}" y="${G4.h - 8}" text-anchor="middle" class="tick">Düğümler arası mesafe (km)</text>
</svg>
<p class="note">Fark 4 km'de +${ME[0].roundOverhead} turken 35 km'de <b>+${lastM.roundOverhead} tur</b>a çıkıyor. Yani dekoherans yalnızca verimi düşürmüyor, arıtmanın <b>maliyetini de</b> artırıyor — ve bu iki etki birbirini besliyor.</p>

<details open>
<summary>Tablo görünümü</summary>
<h2 style="margin-top:14px">Fiber kaliteleri</h2>
<table><thead><tr><th>α (dB/km)</th><th>Temsil ettiği</th><th>9,4 km'de kayıp</th><th>9,4 km'de verim</th><th>Kritik eşik</th><th>Çalışma eşiği</th></tr></thead><tbody>${alphaTable}</tbody></table>
<h2>DEJMPS tur ve maliyet (analitik)</h2>
<table><thead><tr><th>F_ham</th><th>Gereken tur</th><th>Çıktı başına ham çift</th><th>1. tur p_başarı</th></tr></thead><tbody>${roundTable}</tbody></table>
<h2>Ölçülen vs analitik</h2>
<table><thead><tr><th>Mesafe</th><th>F_ham</th><th>Ölçülen tur</th><th>Analitik tur</th><th>Fazlalık</th><th>Verim</th></tr></thead><tbody>${measTable}</tbody></table>
</details>

<p class="note"><b>Yöntem:</b> ${D.method.seeds} tohum · mesafe ${D.method.kmRange[0]}–${D.method.kmRange[1]} km, ${D.method.kmStep} km adım · bağ başına ${tr(D.method.base.attemptsPerLink)} deneme · bellek ${D.method.base.memorySlots} yuva, T₂=${D.method.base.t2Ms} ms, T₁=${D.method.base.t1Ms} ms · hedef nihai sadakat F ≥ ${D.method.base.targetFinalFidelity} · DEJMPS + akıllı bellek zamanlayıcı. Kritik eşik: tohumların ≥%50'sinin ≥1 çift ürettiği en büyük mesafe. Çalışma eşiği: ortalama verimin ≥%0,5 kaldığı en büyük mesafe.</p>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip');
  document.querySelectorAll('svg').forEach(function(sv){
    sv.addEventListener('mouseleave',function(){tip.style.opacity=0;});
  });
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || "/tmp/attenuation_sweep.json";
  const outPath = process.argv[3] || "/tmp/attenuation_chart.html";
  const D = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  fs.writeFileSync(outPath, build(D));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
