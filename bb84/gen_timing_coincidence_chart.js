#!/usr/bin/env node
"use strict";
/**
 * gen_timing_coincidence_chart.js — Faz 2 zamanlama motoru paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — TANI: 4 koşulda QBER çubukları, %11 eşiğiyle. Drift casus
 *     gibi görünür (kırmızı), Kalman düzeltir (yeşil), casus hâlâ yakalanır
 *     (kırmızı). Ana punchline. Renk = güvenli(k3)/iptal(k2).
 *   • Panel 2 — SAAT KAYMASI & KURTARMA: gerçek offset (sıçramalı) vs
 *     Kalman tahmini, ±pencere bandı. "Model gerçekle yüzleşiyor". k1=gerçek,
 *     k3=tahmin.
 *   • Panel 3 — ODLS GEÇİŞ KÖPRÜSÜ: sıçrama geçişi ODLS'siz düşer vs bütçede
 *     köprülenir. Öncesi/sonrası. k2=düşen, k3=teslim.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const ABORT = D.params.abortPct;
  const S = D.summary, OT = D.offsetTrace, J = D.jump;

  // ══ 1) TANI — 4 koşulda QBER ══
  const L1 = { w: 790, h: 250, l: 200, r: 96, t: 22, b: 42 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const qMax = 30;
  const X1 = v => L1.l + v / qMax * iw1;
  let g1 = "";
  for (let q = 0; q <= qMax; q += 5) {
    g1 += `<line x1="${X1(q)}" y1="${L1.t}" x2="${X1(q)}" y2="${L1.t + ih1}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${X1(q)}" y="${L1.t + ih1 + 16}" text-anchor="middle" class="tick">%${tr(q)}</text>`;
  }
  const bh = 34, gap = 14;
  S.forEach((r, i) => {
    const y = L1.t + 8 + i * (bh + gap);
    const col = r.secure ? "k3" : "k2";
    g1 += `<rect x="${L1.l}" y="${y}" width="${X1(r.qber) - L1.l}" height="${bh}" rx="4" fill="var(--${col})" opacity="0.9"/>`;
    g1 += `<text x="${L1.l - 10}" y="${y + bh / 2 + 4}" text-anchor="end" class="anno">${esc(r.cond)}</text>`;
    g1 += `<text x="${X1(r.qber) + 7}" y="${y + bh / 2 + 4}" class="endlab ${col}t">%${tr(r.qber, 1)}${r.secure ? " ✓" : " ✗"}</text>`;
  });
  g1 += `<line x1="${X1(ABORT)}" y1="${L1.t}" x2="${X1(ABORT)}" y2="${L1.t + ih1}" stroke="var(--k2)" stroke-width="1.6" stroke-dasharray="6 4"/>`;
  g1 += `<text x="${X1(ABORT)}" y="${L1.t - 6}" text-anchor="middle" class="anno k2t">%${tr(ABORT)} iptal eşiği</text>`;

  // ══ 2) SAAT KAYMASI & KURTARMA ══
  const trueT = OT.trueJump, estT = OT.estJump, n = trueT.length;
  const L2 = { w: 790, h: 230, l: 62, r: 150, t: 26, b: 48 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const yMax2 = Math.max(...trueT, ...estT) * 1.15;
  const X2 = i => L2.l + i / (n - 1) * iw2;
  const Y2 = v => L2.t + ih2 - v / yMax2 * ih2;
  let g2 = "";
  for (let v = 0; v <= yMax2; v += 200) {
    g2 += `<line x1="${L2.l}" y1="${Y2(v)}" x2="${L2.l + iw2}" y2="${Y2(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 8}" y="${Y2(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 38}" text-anchor="middle" class="axname">acquisition boyunca (slot)</text>`;
  g2 += `<text x="${L2.l - 46}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 46} ${L2.t + ih2 / 2})">saat offseti (ps)</text>`;
  // jump çizgisi
  const jx = X2((OT.jumpAtSlot / OT.pulses) * (n - 1));
  g2 += `<line x1="${jx}" y1="${L2.t}" x2="${jx}" y2="${L2.t + ih2}" stroke="var(--muted-mark)" stroke-width="1" stroke-dasharray="3 3"/>`;
  g2 += `<text x="${jx}" y="${L2.t - 6}" text-anchor="middle" class="anno">ani sıçrama +${tr(J.holdUs != null ? 500 : 500)} ps</text>`;
  // gerçek offset (k1)
  g2 += `<polyline points="${trueT.map((v, i) => `${X2(i)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(trueT[n - 1]) - 2}" class="endlab k1t">gerçek offset</text>`;
  // Kalman tahmini (k3, dashed)
  g2 += `<polyline points="${estT.map((v, i) => `${X2(i)},${Y2(v)}`).join(" ")}" fill="none" stroke="var(--k3)" stroke-width="2" stroke-dasharray="5 3"/>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(estT[n - 1]) + 14}" class="endlab k3t">Kalman tahmini</text>`;
  g2 += `<text x="${L2.l + iw2 + 12}" y="${Y2(estT[n - 1]) + 29}" class="anno">pencere merkezini izliyor</text>`;

  // ══ 3) ODLS GEÇİŞ KÖPRÜSÜ ══
  const total = J.transientClicks;
  const L3 = { w: 790, h: 140, l: 150, r: 130, t: 20, b: 36 };
  const iw3 = L3.w - L3.l - L3.r, ih3 = L3.h - L3.t - L3.b;
  const X3 = v => L3.l + (total ? v / total : 0) * iw3;
  const bh3 = 32, gap3 = 26;
  let g3 = "";
  const y3a = L3.t + 8;
  g3 += `<rect x="${L3.l}" y="${y3a}" width="${iw3}" height="${bh3}" rx="4" fill="var(--k2)" opacity="0.9"/>`;
  g3 += `<text x="${L3.l + iw3 / 2}" y="${y3a + bh3 / 2 + 4}" text-anchor="middle" class="barlab">${tr(total)} tıklama düşer (%100)</text>`;
  g3 += `<text x="${L3.l - 10}" y="${y3a + bh3 / 2 + 4}" text-anchor="end" class="anno">ODLS'siz</text>`;
  const y3b = y3a + bh3 + gap3;
  g3 += `<rect x="${L3.l}" y="${y3b}" width="${X3(J.withOdlsDelivered) - L3.l}" height="${bh3}" rx="4" fill="var(--k3)" opacity="0.9"/>`;
  g3 += `<rect x="${X3(J.withOdlsDelivered)}" y="${y3b}" width="${L3.l + iw3 - X3(J.withOdlsDelivered)}" height="${bh3}" rx="4" fill="var(--k2)" opacity="0.28"/>`;
  g3 += `<text x="${(L3.l + X3(J.withOdlsDelivered)) / 2}" y="${y3b + bh3 / 2 + 4}" text-anchor="middle" class="barlab">${tr(J.withOdlsDelivered)} teslim</text>`;
  g3 += `<text x="${L3.l - 10}" y="${y3b + bh3 / 2 + 4}" text-anchor="end" class="anno k3t">ODLS + ayar</text>`;
  g3 += `<text x="${L3.l + iw3 + 12}" y="${y3b + bh3 / 2 - 2}" class="anno">zaman-aşımı</text>`;
  g3 += `<text x="${L3.l + iw3 + 12}" y="${y3b + bh3 / 2 + 13}" class="anno k3t">→ 0</text>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Zamanlama motoru</title>
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
  .barlab{font-size:12px;font-weight:640;fill:#fff;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Zamanlama motoru — saat kayması, casus taklidi ve gerçek casus</h1>
<p class="sub">Faz 2: Alice/Bob saatleri kayınca koinsidans penceresi gerçek tıklamalardan uzaklaşır, tıklamalar yanlış yuvaya düşer → QBER fırlar. Kritik: bu bir CASUS gibi görünür ama senkronizasyon sorunudur. L5.5 Kalman saat kurtarma driftı siler (casusu maskelemeden); L5.6 ODLS ani sıçrama geçişini köprüler. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">drift (düzeltmesiz)</div><div class="v">%${tr(S[1].qber, 0)}</div></div>
  <div class="tile"><div class="l">Kalman sonrası</div><div class="v">%${tr(S[2].qber, 1)}</div></div>
  <div class="tile"><div class="l">gerçek casus</div><div class="v">%${tr(S[3].qber, 0)}</div></div>
  <div class="tile"><div class="l">sıçrama toparlanma</div><div class="v">${tr(J.recoverySlots)} slot</div></div>
</div>

<h2>1 · Tanı — QBER dört koşulda</h2>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="QBER tanı">${g1}</svg>
<p class="note">Düzeltmesiz drift QBER'i %${tr(S[1].qber, 1)}'e fırlatıyor — eşiği aşıyor, bir casus <b>sanılabilir</b>. Ama Kalman saat kurtarma açılınca %${tr(S[2].qber, 1)}'e (fizik tabanı) iniyor: demek ki drift'ti, saldırı değil. Buna karşılık GERÇEK casus, kurtarma açıkken bile %${tr(S[3].qber, 0)}'de kalıyor — <b>maskelemiyor</b>. Kalman yalnız öngörülebilir zaman yapısını siler.</p>

<h2>2 · Saat kayması & Kalman kurtarma — model gerçekle yüzleşiyor</h2>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Saat kayması ve kurtarma">${g2}</svg>
<p class="note">Bob saati sürekli kayıyor (drift) ve ortada bir de ani sıçrama var (resync/reroute). Kalman saat kestiricisi (L5.5, async_sync'ten) offseti çevrimiçi öğrenip pencere merkezini ön-beslemeli kaydırıyor — gerçek offseti izliyor, böylece gerçek koinsidanslar pencere içinde kalıyor.</p>

<h2>3 · ODLS geçiş köprüsü — ani sıçrama kaybı sıfırlanıyor</h2>
<svg viewBox="0 0 ${L3.w} ${L3.h}" role="img" aria-label="ODLS geçiş köprüsü">${g3}</svg>
<p class="note">Ani saat sıçraması sonrası Kalman ${tr(J.recoverySlots)} slotta (${tr(J.holdUs, 2)} μs) toparlanıyor; o geçişte hizasız kalan ${tr(total)} tıklama ODLS'siz düşer. ${tr(J.holdUs, 2)} μs ≪ 73 μs fiber bütçesi olduğundan ODLS onları donduruyor (kayıp ${tr(J.odlsLossDb, 2)} dB, sağkalım %${tr(J.odlsSurvivalPct, 0)}) → ${tr(J.withOdlsDelivered)} teslim, zaman-aşımı 0.</p>

<div class="callout"><b>Ne kanıtlandı:</b> L5.5 ve L5.6 soyut olarak doğrulanmıştı; burada somut bir acquisition problemine (Alice/Bob saat kayması) uygulandı — "model ilk kez gerçekle yüzleşti". Üç dürüst sonuç: (1) düzeltilmemiş drift bir casus <i>taklidi</i> yapar (QBER fırlar) → yanlış-tanı tuzağı; (2) Kalman saat kurtarma bu artefaktı siler ve drift'i saldırıdan ayırır; (3) ama gerçek casusu <b>maskelemez</b> — güvenlik korunur. Ani sıçrama geçişi ODLS bütçesinde köprülenir. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/timing_coincidence_engine.js</code> + <code>timing_coincidence_test.js</code> · L5.5 <code>predictive_jitter_alignment.js</code> + L5.6 <code>optical_delay_line.js</code>. Çekirdek SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "timing_coincidence.json");
  const outPath = process.argv[3] || "/tmp/timing_coincidence_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
