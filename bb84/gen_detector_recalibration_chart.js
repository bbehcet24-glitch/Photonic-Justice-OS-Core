#!/usr/bin/env node
"use strict";
/**
 * gen_detector_recalibration_chart.js — Faz 3 rekalibrasyon paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — QBER AYRIŞTIRMASI: waterfall — hizasızlık+karanlık (ideal, k1)
 *     üstüne afterpulsing (gerçek-dedektör adderı, k2) = gerçek QBER. İdeal
 *     çizgisi referans. Afterpulsing'in baskın gerçek katkı olduğunu gösterir.
 *   • Panel 2 — SONLU-ANAHTAR REKALİBRASYONU: ℓ/n vs n (log), ideal (k3) vs
 *     gerçek (k1). Güvenli oranın düştüğünü + uçurum marjını gösterir.
 *   • Panel 3 — VERİM UYUMSUZLUĞU YAN KANALI: eşit vs uyumsuz dedektör —
 *     bit yanlılığı + algılama asimetrisi. QBER-sınırının GÖRMEDİĞİ zarar.
 *   • Renk: k1=idealize/ölçülen, k2=gerçek-dedektör kusuru/yan-kanal, k3=güvenli/ideal.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const DEC = D.decomposition, FK = D.finiteKey, MM = D.mismatch, MG = D.margin;

  // ══ 1) QBER AYRIŞTIRMASI (waterfall) ══
  const steps = [
    { lab: "hizasızlık", v: DEC.misalignment, col: "k1" },
    { lab: "+ karanlık", v: DEC.dark, col: "k1" },
    { lab: "+ afterpulsing", v: DEC.afterpulse, col: "k2" },
  ];
  const L1 = { w: 790, h: 250, l: 62, r: 150, t: 26, b: 60 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const yMax1 = Math.ceil(DEC.realQber + 0.6);
  const Y1 = v => L1.t + ih1 - v / yMax1 * ih1;
  const cols = steps.length + 1;               // + gerçek toplam
  const slotW = iw1 / cols, bw = slotW * 0.56;
  let g1 = "", cum = 0;
  for (let q = 0; q <= yMax1; q += 0.5) {
    g1 += `<line x1="${L1.l}" y1="${Y1(q)}" x2="${L1.l + iw1}" y2="${Y1(q)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 8}" y="${Y1(q) + 4}" text-anchor="end" class="tick">%${tr(q, 1)}</text>`;
  }
  // ideal referans çizgisi
  g1 += `<line x1="${L1.l}" y1="${Y1(DEC.idealQber)}" x2="${L1.l + iw1}" y2="${Y1(DEC.idealQber)}" stroke="var(--k1)" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(DEC.idealQber) + 4}" class="anno k1t">idealize %${tr(DEC.idealQber, 2)}</text>`;
  steps.forEach((s, i) => {
    const cx = L1.l + (i + 0.5) * slotW;
    const yTop = Y1(cum + s.v), yBot = Y1(cum);
    g1 += `<rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${yBot - yTop}" rx="3" fill="var(--${s.col})" opacity="0.9"/>`;
    if (i > 0) g1 += `<line x1="${L1.l + (i - 0.5) * slotW + bw / 2}" y1="${Y1(cum)}" x2="${cx - bw / 2}" y2="${Y1(cum)}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="2 2"/>`;
    g1 += `<text x="${cx}" y="${yTop - 6}" text-anchor="middle" class="anno">+%${tr(s.v, 2)}</text>`;
    g1 += `<text x="${cx}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${esc(s.lab)}</text>`;
    cum += s.v;
  });
  // gerçek toplam çubuğu
  const cxT = L1.l + (steps.length + 0.5) * slotW;
  g1 += `<rect x="${cxT - bw / 2}" y="${Y1(DEC.realQber)}" width="${bw}" height="${L1.t + ih1 - Y1(DEC.realQber)}" rx="3" fill="var(--k2)" opacity="0.55"/>`;
  g1 += `<text x="${cxT}" y="${Y1(DEC.realQber) - 6}" text-anchor="middle" class="endlab k2t">%${tr(DEC.realQber, 2)}</text>`;
  g1 += `<text x="${cxT}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">= gerçek</text>`;
  g1 += `<text x="${L1.l - 46}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 46} ${L1.t + ih1 / 2})">QBER</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 44}" text-anchor="middle" class="axname">verim uyumsuzluğu QBER'e +%${tr(DEC.mismatch, 2)} ekler (≈0 — panel 3'e bakın)</text>`;

  // ══ 2) SONLU-ANAHTAR REKALİBRASYONU ══
  const L2 = { w: 790, h: 230, l: 62, r: 150, t: 24, b: 48 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const lx = v => Math.log10(v);
  const xMin = lx(1e4), xMax = lx(1e6);
  const X2 = v => L2.l + (lx(v) - xMin) / (xMax - xMin) * iw2;
  const Y2 = v => L2.t + ih2 - v / 100 * ih2;
  let g2 = "";
  for (let p = 0; p <= 100; p += 25) {
    g2 += `<line x1="${L2.l}" y1="${Y2(p)}" x2="${L2.l + iw2}" y2="${Y2(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 8}" y="${Y2(p) + 4}" text-anchor="end" class="tick">%${tr(p)}</text>`;
  }
  for (const n of [1e4, 1e5, 1e6]) g2 += `<text x="${X2(n)}" y="${L2.t + ih2 + 17}" text-anchor="middle" class="tick">10${["⁴", "⁵", "⁶"][Math.round(lx(n)) - 4]}</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 38}" text-anchor="middle" class="axname">elenmiş anahtar boyu n (log)</text>`;
  g2 += `<text x="${L2.l - 46}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 46} ${L2.t + ih2 / 2})">güvenli oran ℓ/n</text>`;
  g2 += `<polyline points="${FK.map(r => `${X2(r.n)},${Y2(r.idealCompR)}`).join(" ")}" fill="none" stroke="var(--k3)" stroke-width="2.4"/>`;
  g2 += `<polyline points="${FK.map(r => `${X2(r.n)},${Y2(r.realCompR)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.4"/>`;
  FK.forEach(r => {
    g2 += `<circle cx="${X2(r.n)}" cy="${Y2(r.idealCompR)}" r="3.4" fill="var(--k3)"/>`;
    g2 += `<circle cx="${X2(r.n)}" cy="${Y2(r.realCompR)}" r="3.4" fill="var(--k1)"/>`;
  });
  const lastF = FK[FK.length - 1];
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(lastF.idealCompR) + 4}" class="endlab k3t">ideal</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(lastF.realCompR) + 4}" class="endlab k1t">gerçek</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(lastF.realCompR) + 19}" class="anno">−${tr(lastF.lossPts, 1)} puan</text>`;

  // ══ 3) VERİM UYUMSUZLUĞU YAN KANALI ══
  const L3 = { w: 790, h: 190, l: 62, r: 120, t: 26, b: 46 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const groups = [
    { lab: "bit-1 oranı (0.5 ideal)", eq: MM.idealBiasPct, mm: MM.keyBiasPct, ref: 50 },
    { lab: "dedektör algılama asimetrisi", eq: MM.equalAsymmetryPct, mm: MM.asymmetryPct, ref: 0 },
  ];
  const gw = iw3 / groups.length, bw3 = gw * 0.22;
  const Y3 = v => L3.t + ih3 - v / 60 * ih3;
  let g3 = "";
  for (let p = 0; p <= 60; p += 20) {
    g3 += `<line x1="${L3.l}" y1="${Y3(p)}" x2="${L3.l + iw3}" y2="${Y3(p)}" stroke="var(--grid)" stroke-width="1"/>`;
    g3 += `<text x="${L3.l - 8}" y="${Y3(p) + 4}" text-anchor="end" class="tick">%${tr(p)}</text>`;
  }
  groups.forEach((g, i) => {
    const cx = L3.l + (i + 0.5) * gw;
    g3 += `<rect x="${cx - bw3 - 6}" y="${Y3(g.eq)}" width="${bw3}" height="${L3.t + ih3 - Y3(g.eq)}" rx="3" fill="var(--k3)" opacity="0.9"/>`;
    g3 += `<rect x="${cx + 6}" y="${Y3(g.mm)}" width="${bw3}" height="${L3.t + ih3 - Y3(g.mm)}" rx="3" fill="var(--k2)" opacity="0.9"/>`;
    g3 += `<text x="${cx - bw3 / 2 - 6}" y="${Y3(g.eq) - 5}" text-anchor="middle" class="tick k3t">%${tr(g.eq, 1)}</text>`;
    g3 += `<text x="${cx + bw3 / 2 + 6}" y="${Y3(g.mm) - 5}" text-anchor="middle" class="tick k2t">%${tr(g.mm, 1)}</text>`;
    g3 += `<text x="${cx}" y="${L3.t + ih3 + 18}" text-anchor="middle" class="tick">${esc(g.lab)}</text>`;
  });
  g3 += `<text x="${L3.l + iw3 + 10}" y="${L3.t + 8}" class="anno k3t">eşit dedektör</text>`;
  g3 += `<text x="${L3.l + iw3 + 10}" y="${L3.t + 24}" class="anno k2t">uyumsuz</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Gerçek-gürültü rekalibrasyonu</title>
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
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Gerçek-gürültü rekalibrasyonu — idealize model neyi kaçırdı</h1>
<p class="sub">Faz 3: emülatörün idealize gürültüsüne gerçek dedektör kusurları (afterpulsing + verim uyumsuzluğu) eklendi ve güvenlik kararı çekirdeğin sonlu-anahtar kanıtıyla yeniden oturtuldu. İdealize QBER iyimserdi; gerçek QBER daha yüksek → güvenli-anahtar oranı düşüyor, marj daralıyor. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">idealize QBER</div><div class="v">%${tr(DEC.idealQber, 2)}</div></div>
  <div class="tile"><div class="l">gerçek QBER</div><div class="v">%${tr(DEC.realQber, 2)}</div></div>
  <div class="tile"><div class="l">ℓ/n (n=10⁶)</div><div class="v">%${tr(lastF.realCompR, 0)}</div></div>
  <div class="tile"><div class="l">güvenlik marjı</div><div class="v">${tr(MG.realMarginPts, 1)} p</div></div>
</div>

<h2>1 · QBER ayrıştırması — afterpulsing baskın gerçek katkı</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="QBER ayrıştırması">${g1}</svg>
<p class="note">İdealize model yalnız hizasızlık (%${tr(DEC.misalignment, 2)}) + karanlık sayımı (%${tr(DEC.dark, 2)}) görüyordu. Gerçek dedektörlerin afterpulsing'i bunun üstüne %${tr(DEC.afterpulse, 2)} daha ekliyor — hizasızlık kadar (hatta daha) baskın. Gerçek QBER %${tr(DEC.realQber, 2)}, idealizenin ×${tr(DEC.realQber / DEC.idealQber, 1)}'i. Verim uyumsuzluğu QBER'e ~0 ekler (zararı başka türlü — panel 3).</p>

<h2>2 · Sonlu-anahtar rekalibrasyonu — güvenli oran düşüyor</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Sonlu-anahtar rekalibrasyonu">${g2}</svg>
<p class="note">Aynı QBER'ler çekirdeğin sonlu-anahtar kanıtına (QKDSecurityProof) beslendi: güvenli oran ℓ/n, n=10⁶'da %${tr(lastF.idealCompR, 1)}→%${tr(lastF.realCompR, 1)} (−${tr(lastF.lossPts, 1)} puan), küçük n'de fark daha büyük (sonlu-boyut cezası). Sistem hâlâ güvenli ama gerçek anahtar üretim oranı idealizenin tahmininden düşük.</p>

<h2>3 · Verim uyumsuzluğu yan kanalı — QBER'in görmediği zarar</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="Verim uyumsuzluğu yan kanalı">${g3}</svg>
<p class="note">Verim uyumsuzluğu QBER'e ~0 katkı yapar, o yüzden sonlu-anahtar sınırı onu <b>görmez</b> — ama elenmiş anahtarı yanlı yapar (bit-1 %${tr(MM.keyBiasPct, 1)}, ideal %${tr(MM.idealBiasPct, 1)}) ve dedektör algılama asimetrisini %${tr(MM.equalAsymmetryPct, 1)}→%${tr(MM.asymmetryPct, 1)} açar. Bu bir yan kanaldır (verim-uyumsuzluğu/time-shift saldırısı); rekalibrasyon bunu <b>ayrı bir gözlemlenebilir</b> olarak izlemeli.</p>

<div class="callout"><b>Rekalibrasyon özeti:</b> idealize kalibrasyon iyimserdi — afterpulsing QBER'i ×${tr(DEC.realQber / DEC.idealQber, 1)} yükseltiyor, bu da güvenli-anahtar oranını −${tr(lastF.lossPts, 1)} puan düşürüyor ve güvenlik uçurumuna (%${tr(MG.qberCliffPct, 1)}) marjı ${tr(MG.idealMarginPts, 1)}→${tr(MG.realMarginPts, 1)} puana daraltıyor. Verim uyumsuzluğu QBER'e görünmez ama bir yan kanal açar → ayrı izlenmeli. Dürüst çıkarım: gerçek donanım sayıları emülatörden farklıdır; bu tam da Faz 3'ün amacı — güvenlik kararını ölçülen gerçekliğe oturtmak. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/detector_recalibration.js</code> + <code>detector_recalibration_test.js</code>; sonlu-anahtar <code>QKDSecurityProof.secureKeyLength</code> (çekirdek). SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "detector_recalibration.json");
  const outPath = process.argv[3] || "/tmp/detector_recalibration_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
