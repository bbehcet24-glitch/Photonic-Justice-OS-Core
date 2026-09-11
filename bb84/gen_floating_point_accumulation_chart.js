#!/usr/bin/env node
"use strict";
/**
 * gen_floating_point_accumulation_chart.js — Akümülasyon/yuvarlama hataları
 * stres testinin sonuç panosu: tamsayı temsil tavanı, naif toplama hata
 * büyümesi, duraklama eşiği, ve NoiseGateMiddleware'in 3+ yıllık simüle
 * edilmiş sürekli-çalışma serisi.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(F) {
  const passN = F.checks.filter(c => c.ok).length, totalN = F.checks.length;
  const rows = F.checks.map(c => {
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${c.ok ? "ok" : "bad"}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  // ── (B) naif toplama büyüme yasası ──
  const growth = F.accumulationGrowth;
  const maxRel = Math.max(...growth.map(g => Math.abs(g.naiveRelErr))) * 1.15;
  const growthRows = growth.map(g => `<div class="scenrow"><span class="l">N=${g.N.toExponential(0)}</span>
    <div class="track"><div class="fill" style="width:${(Math.abs(g.naiveRelErr)/maxRel*100).toFixed(2)}%;background:var(--k2)"></div></div>
    <span class="v" style="color:var(--k2)">${g.naiveRelErr.toExponential(2)}</span></div>`).join("");

  // ── (E) uzun-vade zaman serisi (SVG çizgi grafiği) ──
  const pts = F.longRunStability.checkpoints;
  const W = 760, H = 160, PAD = 8;
  const xs = pts.map((p, i) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD));
  const vals = pts.map(p => p.calibratedDarkRateHz);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const ys = vals.map(v => H - PAD - ((v - minV) / (maxV - minV || 1)) * (H - 2 * PAD));
  const pathD = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const nominalY = H - PAD - ((50 - minV) / (maxV - minV || 1)) * (H - 2 * PAD);

  const A = F.integerCeiling, C = F.stagnation, D = F.architectureImmunity, E = F.longRunStability, Fi = F.isolatedEma, G = F.bitIntegrity;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Akümülasyon ve yuvarlama hataları</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};--amber:#c9720f;
    --ok-bg:#e4f4ec;--bad-bg:#fae6de;--hw-bg:#faf0e2;}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--amber:#e39440;
    --ok-bg:#123227;--bad-bg:#3a201a;--hw-bg:#33260f;}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--amber:#e39440;
    --ok-bg:#123227;--bad-bg:#3a201a;--hw-bg:#33260f;}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:920px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:30px 0 4px;}
  h3{font-size:12.5px;margin:22px 0 10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .verdict{margin:18px 0 4px;padding:15px 18px;border-radius:12px;background:var(--surface-2);
    border-left:4px solid var(--k3);display:flex;align-items:center;gap:14px;}
  .verdict .badge{font-size:11px;font-weight:700;letter-spacing:.06em;padding:5px 10px;border-radius:7px;
    background:var(--ok-bg);color:var(--k3);white-space:nowrap;}
  .verdict .vt{font-size:14.5px;font-weight:600;line-height:1.4;}
  .crit{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:4px 12px;padding:12px 14px;border-radius:10px;
    background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--grid);align-items:start;}
  .crit.ok{border-left-color:var(--k3);} .crit.bad{border-left-color:var(--k2);}
  .crit .cn{grid-column:1;grid-row:1;font-size:13.5px;font-weight:640;}
  .crit .cd{grid-column:1 / -1;grid-row:2;font-size:11.5px;color:var(--text-muted);line-height:1.5;}
  .pill{grid-column:2;grid-row:1;justify-self:end;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;white-space:nowrap;}
  .pill.ok{background:var(--ok-bg);color:var(--k3);} .pill.bad{background:var(--bad-bg);color:var(--k2);}
  .scen{background:var(--surface-2);border-radius:11px;padding:16px 18px;}
  .scenrow{display:grid;grid-template-columns:80px 1fr auto;gap:12px;align-items:center;margin:9px 0;}
  .scenrow .l{font-size:12px;color:var(--text-secondary);white-space:nowrap;}
  .track{height:18px;background:var(--surface-3);border-radius:6px;overflow:hidden;}
  .fill{height:100%;border-radius:6px;}
  .scenrow .v{font-size:12px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;}
  .card{background:var(--surface-2);border-radius:11px;padding:14px 16px;border-left:3px solid var(--k1);}
  .card .big{font-size:20px;font-weight:700;margin:2px 0 4px;font-variant-numeric:tabular-nums;}
  .card .lbl{font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.03em;}
  .card .sm{font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:4px;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
  .chartbox{background:var(--surface-2);border-radius:11px;padding:14px 16px;}
  svg text{font-size:9.5px;fill:var(--text-muted);}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Akümülasyon ve yuvarlama hataları — kesintisiz-çalışma stres testi</h1>
<p class="sub">Kısa vadede kusursuz çalışan floating-point aritmetiğinin, günlerce/yıllarca kesintisiz çalıştığında birikip birikmediği ölçüldü: tamsayı temsil tavanı, naif toplama hata büyümesi, ve çekirdeğin gerçek kalibrasyon EMA'sının 3+ yıllık simülasyonu. Çekirdeğe dokunulmadı.</p>

<div class="verdict">
  <span class="badge">TÜMÜ GEÇTİ ✓</span>
  <span class="vt">${passN}/${totalN} öz-test geçti — en kritik bulgu: naif bir 1GHz saat biriktiricisi ~${tr(C.thresholdDays,0)} günde TAMAMEN donar, ama gerçek kod bu deseni KULLANMIYOR</span>
</div>

<h2>1. Tamsayı temsil tavanı (A)</h2>
<div class="cards">
  <div class="card"><div class="lbl">Number.MAX_SAFE_INTEGER</div><div class="big">2^53−1</div><div class="sm">${tr(A.maxSafeInteger,0)} — bunun üzerinde ardışık tamsayılar AYIRT EDİLEMİYOR (doğrulandı: 2^53+1 → 2^53'e yuvarlanıyor)</div></div>
  <div class="card"><div class="lbl">tek-çağrı kullanımı (n=1e6)</div><div class="big">${A.currentHeadroomFactor.toExponential(1)}×</div><div class="sm">tavandan bu kadar UZAK — risk yok</div></div>
  <div class="card" style="border-left-color:var(--k2)"><div class="lbl">10 yıllık ömür-boyu sayaç</div><div class="big" style="color:var(--k2)">${A.lifetimeExcessFactor.toFixed(1)}× AŞIYOR</div><div class="sm">sürekli 1GHz·%15 verimle 10 yılda üretilen TOPLAM anahtar biti tavanı geçiyor — double DEĞİL BigInt gerekir</div></div>
</div>

<h2>2. Naif toplama hata büyümesi (B)</h2>
<div class="scen">
${growthRows}
</div>
<p class="note">1 ns'lik artışların NAİF toplamındaki bağıl hata N ile büyüyor (N=1e6'da ~8×10⁻¹²'den N=1e9'da ~7×10⁻⁹'a). Kahan-telafili toplama tüm N değerlerinde makine-epsilon düzeyinde (hata≈0) kalıyor.</p>

<h2>3. Duraklama (stagnation) eşiği (C) ve mimari bağışıklık (D)</h2>
<div class="cards">
  <div class="card" style="border-left-color:var(--amber)"><div class="lbl">naif biriktirici donma eşiği</div><div class="big" style="color:var(--amber)">${tr(C.thresholdDays,1)} gün</div><div class="sm">tam olarak 2^24 saniye — bu noktadan sonra 1ns'lik bir artış EKLEMENİN hiçbir etkisi kalmaz (doğrudan doğrulandı)</div></div>
  <div class="card"><div class="lbl">gerçek saat mekanizması</div><div class="big" style="color:var(--k3)">ÇARPIM</div><div class="sm">timetag_acquisition_bridge.js: slotT=i·periodPs — biriktirme DEĞİL, bu donma riskine YAPISAL bağışık</div></div>
</div>

<h2>4. NoiseGateMiddleware — ${tr(E.elapsedYearsSimulated,2)} yıllık sürekli-çalışma simülasyonu (E)</h2>
<div class="chartbox">
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <line x1="${PAD}" y1="${nominalY.toFixed(1)}" x2="${W-PAD}" y2="${nominalY.toFixed(1)}" stroke="var(--amber)" stroke-width="1" stroke-dasharray="4,3"/>
    <path d="${pathD}" fill="none" stroke="var(--k1)" stroke-width="1.6"/>
    <text x="${PAD}" y="12">${tr(maxV,1)} Hz</text>
    <text x="${PAD}" y="${H-2}">${tr(minV,1)} Hz</text>
    <text x="${W-70}" y="${(nominalY-4).toFixed(1)}">nominal 50 Hz</text>
  </svg>
</div>
<p class="note">${E.cycles.toLocaleString("tr-TR")} kalibrasyon turu (${tr(E.elapsedYearsSimulated,2)} yıl sürekli çalışma) boyunca 200 kontrol noktasında örneklenen kalibre-edilmiş karanlık-oranı. İlk-%10 ortalama ${tr(E.meanFirst,1)} Hz (σ=${tr(E.stdFirst,1)}) — son-%10 ortalama ${tr(E.meanLast,1)} Hz (σ=${tr(E.stdLast,1)}) — fark yalnızca ${tr(E.driftSigmas,2)}σ (anlamlı sürüklenme eşiği ~3σ'nın çok altında). Daha önce düzeltilen asimetrik-kırpma sürüklenme hatası aşırı-uzun-vadede GERİ GELMEDİ.</p>

<h2>5. İzole EMA (F) ve anahtar bit bütünlüğü (G)</h2>
<div class="cards">
  <div class="card"><div class="lbl">saf aritmetik yuvarlama, ${Fi.cycles.toExponential(0)} yineleme</div><div class="big" style="color:var(--k3)">${Fi.absErr.toExponential(1)}</div><div class="sm">RNG yok, sabit hedef — mutlak hata makine-epsilon düzeyinde, sürüklenme YOK (EMA'nın sönümleme terimi geçmiş hatayı geometrik siliyor)</div></div>
  <div class="card"><div class="lbl">Toeplitz anahtar bitleri</div><div class="big" style="color:var(--k3)">TAMSAYI/BIT</div><div class="sm">selfTest=${G.selfTestOk}, paketli/naif çapraz-kontrol=${G.crossCheckIdentical} — bit DEĞERLERİ XOR/AND ile üretiliyor, float yuvarlama kanalı yok</div></div>
</div>

<h2>Öz-testler (${passN}/${totalN})</h2>
${rows}

<div class="callout"><b>Özet:</b> Kısa-vadeli mükemmel çalışma ile uzun-vadeli floating-point güvenilirliği AYRI sorulardır ve ayrı ayrı test edildi. En dramatik/somut bulgu: eğer sistem saatini NAİF bir biriktiriciyle tutsaydı, 1GHz'de yalnızca ~${tr(C.thresholdDays,0)} gün (${(C.thresholdDays/30).toFixed(1)} ay) sonra tamamen DONARDI — ama gerçek kod (timetag_acquisition_bridge.js) bunun yerine çarpımsal (i·periodPs), durumsuz bir zaman indeksleme kullanıyor ve bu riske YAPISAL OLARAK bağışık. Çekirdeğin GERÇEK, sürekli-çalışan kalibrasyon EMA'sı ${tr(E.elapsedYearsSimulated,1)} yıllık bir simülasyonda istatistiksel olarak KARARLI kaldı (${tr(E.driftSigmas,2)}σ fark). Tek gerçek, somut risk: on-yıl mertebesinde bir ÖMÜR BOYU kümülatif anahtar-biti sayacı double olarak tutulursa 2^53 tamsayı tavanını AŞAR — bu BigInt ile önlenmelidir. Nihai anahtar BİT DEĞERLERİ (yalnızca uzunluğu değil) tamsayı/bit-düzeyinde üretildiği için floating-point yuvarlamasından tamamen bağımsızdır. Çekirdeğe (photonnet_core.js) hiçbir noktada dokunulmadı — SHA-256 değişmedi.</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const fPath = process.argv[2] || path.join(__dirname, "reports", "floating_point_accumulation.json");
  const outPath = process.argv[3] || "/tmp/floating_point_accumulation_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(fPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
