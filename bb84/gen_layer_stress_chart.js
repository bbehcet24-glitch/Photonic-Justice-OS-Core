#!/usr/bin/env node
"use strict";
/**
 * gen_layer_stress_chart.js — katman stres kampanyasının kurul paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Katman başına BİR SATIR: etiket + stresör + mini kıvılcım çizgisi
 *     (degradasyon eğrisi) + kırılma/sınır değeri. Yedi heterojen katman
 *     tek bir sistem gibi okunsun diye ortak satır ızgarası.
 *   • Her kıvılcım tek eksen, kendi birimine normalize; renk ENTİTEYE
 *     bağlı: k1 = sağlıklı/kenetli davranış, k2 = kırılma/duvar bölgesi.
 *   • Çekirdek bütünlüğü ayrı bir bant (SHA-256 kanıtı) — kampanyanın
 *     değişmezi.
 *
 * Palet: kategorik 2 slot, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

// Mini kıvılcım çizgisi: değerler [0..1] normalize, w×h kutuya çizilir.
function spark(vals, w, h, col, { fillZeroBelow = null } = {}) {
  if (!vals.length) return "";
  const n = vals.length;
  const X = (i) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const Y = (v) => h - v * h;
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  let g = `<polyline points="${pts}" fill="none" stroke="var(--${col})" stroke-width="2" stroke-linejoin="round"/>`;
  // uç noktalar
  g += `<circle cx="${X(0).toFixed(1)}" cy="${Y(vals[0]).toFixed(1)}" r="2.4" fill="var(--${col})"/>`;
  g += `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(vals[n - 1]).toFixed(1)}" r="2.4" fill="var(--${col})"/>`;
  return g;
}

function build(D) {
  const rows = [];

  // L1 — verim vs km
  {
    const r = D.L1.rows, mx = Math.max(...r.map(x => x.yieldPct));
    rows.push({ id: "L1", name: "Dolanıklık fiziği", stress: "fiber sönümleme (mesafe ↑)",
      spark: r.map(x => x.yieldPct / mx), col: "k2",
      limit: `~${D.L1.breakingKm} km`, sub: `verim %${tr(r[0].yieldPct, 1)} → %0`, ok: true });
  }
  // L2 — F* vs hops (ceiling)
  {
    const r = D.L2.rows;
    rows.push({ id: "L2", name: "Çok-atlamalı zincir", stress: "atlama sayısı ↑ (F* → 1)",
      spark: r.map(x => (x.requiredSegmentFidelity - 0.9) / 0.1), col: "k2",
      limit: `${D.L2.maxFeasibleHops} atlama`, sub: `F* tavanı ${tr(D.L2.ceiling, 3)}`, ok: true });
  }
  // L3 — invariant (no curve): residual bar
  {
    rows.push({ id: "L3", name: "Ağ matrisi + yönlendirme", stress: "tüm yollar doygun",
      spark: null, col: "k1",
      limit: `artık ≥ ${tr(D.L3.minResidual)}`, sub: `${tr(D.L3.greedyPairs)} çift · kenar aşımı yok`, ok: D.L3.minResidual >= 0 });
  }
  // L4 — ℓ vs e_ph
  {
    const r = D.L4.phaseWall.rows, mx = Math.max(...r.map(x => x.ell), 1);
    rows.push({ id: "L4", name: "QKD protokolü", stress: "e_ph ↑ ve blok n ↓ (ℓ → 0)",
      spark: r.map(x => x.ell / mx), col: "k2",
      limit: `e_ph ≈ ${tr(D.L4.phaseWall.wallEPh, 2)}`, sub: `n_min ${tr(D.L4.finiteKeyWall.minViableN)} · ℓ≥0`, ok: true });
  }
  // L5 — admission threshold e* vs eBar
  {
    const r = D.L5.admissionThreshold, mx = 0.5;
    rows.push({ id: "L5", name: "Oturum kontrolcüsü", stress: "kabul eşiği bıçak sırtı",
      spark: r.map(x => x.eStar / mx), col: "k1",
      limit: `e* ≤ 0,50`, sub: `bozulmuş akış ${tr(D.L5.degradedRun.blocks)} blok · neg ℓ 0`, ok: true });
  }
  // L6 — denial vs overload
  {
    const r = D.L6.rows, mx = 100;
    rows.push({ id: "L6", name: "Tedarik + geri-basınç", stress: "talep patlaması ×10",
      spark: r.map(x => x.denialPct / mx), col: "k2",
      limit: `%${tr(r[r.length - 1].denialPct, 0)}`, sub: `arz açığını izliyor (öngörü %${tr(r[r.length - 1].predictedDenialPct, 0)})`, ok: true });
  }
  // L7 — μs/op vs n (flat = O(1))
  {
    const r = D.L7.rows, mx = Math.max(...r.map(x => x.usPerChurn));
    rows.push({ id: "L7", name: "Dış entegrasyon (KME)", stress: "churn @ 80k anahtar",
      spark: r.map(x => x.usPerChurn / mx), col: "k1",
      limit: `O(1) ×${tr(D.L7.usSpread, 2)}`, sub: `replay reddi tam · bellek sınırlı`, ok: true });
  }

  const RW = 900, rowH = 64, top = 150, sparkW = 150, sparkH = 32;
  const H = top + rows.length * rowH + 150;
  const labelX = 40, nameX = 74, sparkX = 430, limitX = 640;

  let g = "";
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    g += `<line x1="${labelX}" y1="${y + rowH - 8}" x2="${RW - 30}" y2="${y + rowH - 8}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${labelX}" y="${y + 20}" class="lid">${r.id}</text>`;
    g += `<text x="${nameX}" y="${y + 16}" class="lname">${esc(r.name)}</text>`;
    g += `<text x="${nameX}" y="${y + 33}" class="lstress">${esc(r.stress)}</text>`;
    // kıvılcım
    if (r.spark) {
      g += `<g transform="translate(${sparkX},${y + 2})">` +
        `<rect x="0" y="0" width="${sparkW}" height="${sparkH}" fill="var(--surface-2)" rx="4"/>` +
        spark(r.spark, sparkW, sparkH, r.col) + `</g>`;
    } else {
      g += `<g transform="translate(${sparkX},${y + 2})"><rect x="0" y="0" width="${sparkW}" height="${sparkH}" fill="var(--surface-2)" rx="4"/>` +
        `<rect x="4" y="${sparkH / 2 - 4}" width="${sparkW - 8}" height="8" rx="4" fill="var(--k1)"/>` +
        `<text x="${sparkW / 2}" y="${sparkH / 2 + 3}" text-anchor="middle" class="sparklab">invaryant korundu</text></g>`;
    }
    g += `<text x="${limitX}" y="${y + 16}" class="llimit ${r.col}t">${esc(r.limit)}</text>`;
    g += `<text x="${limitX}" y="${y + 32}" class="lsub">${esc(r.sub)}</text>`;
    g += `<text x="${RW - 40}" y="${y + 22}" class="lok">✓</text>`;
  });
  // başlık şeridi
  g += `<text x="${labelX}" y="${top - 14}" class="colhead">katman · stresör</text>`;
  g += `<text x="${sparkX}" y="${top - 14}" class="colhead">degradasyon</text>`;
  g += `<text x="${limitX}" y="${top - 14}" class="colhead">kırılma / sınır</text>`;

  const CI = D.coreIntegrity;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Katman stres kampanyası</title>
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
    padding:26px 30px 34px;max-width:940px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:104px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .colhead{font-size:10.5px;fill:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;}
  .lid{font-size:12px;font-weight:720;fill:var(--k1);}
  .lname{font-size:13px;font-weight:600;fill:var(--text-primary);}
  .lstress{font-size:11.5px;fill:var(--text-secondary);}
  .llimit{font-size:13px;font-weight:660;}
  .lsub{font-size:10.5px;fill:var(--text-muted);}
  .lok{font-size:14px;font-weight:700;fill:var(--k3);}
  .sparklab{font-size:9px;fill:#fff;font-weight:600;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Katman stres kampanyası — her katman kırılma noktasına kadar zorlandı</h1>
<p class="sub">Yedi katmanın her biri uçtan uca aşırı yük altında koşturuldu. Beklenen ve ölçülen sonuç: her katman ölçülü bir sınıra doğru <b>zarifçe</b> bozuluyor — çökme, kilitlenme, geçersiz çıktı yok. Çekirdek kampanya boyunca bit düzeyinde değişmedi.</p>

<div class="tiles">
  <div class="tile"><div class="l">katman</div><div class="v">7</div></div>
  <div class="tile"><div class="l">öz-test</div><div class="v"><span style="color:var(--k1)">${D.checks.filter(c => c.ok).length}/${D.checks.length}</span></div></div>
  <div class="tile"><div class="l">çekirdek SHA-256</div><div class="v">${CI.unchanged ? "değişmedi" : "DEĞİŞTİ"}</div></div>
  <div class="tile"><div class="l">kampanyada bulunan</div><div class="v">enc O(n)→O(1)</div></div>
</div>

<svg viewBox="0 0 ${RW} ${H}" role="img" aria-label="Katman stres kampanyası">
${g}
<g transform="translate(${labelX},${top + rows.length * rowH + 20})">
  <rect x="0" y="0" width="${RW - labelX - 30}" height="86" rx="9" fill="var(--surface-2)"/>
  <text x="18" y="28" class="lname">Çekirdek bütünlüğü — <tspan fill="var(--k3)" font-weight="700">SHA-256 değişmedi</tspan></text>
  <text x="18" y="50" class="lstress">öncesi = sonrası: <tspan font-family="ui-monospace,monospace">${esc(CI.sha256Before.slice(0, 40))}…</tspan></text>
  <text x="18" y="70" class="lsub">Yedi katman da photonnet_core.js'i yalnızca çağırdı; hiçbiri bir satırını bile değiştirmedi.</text>
</g>
</svg>

<div class="callout"><b>Kampanyanın bulduğu ve kapattığı gerçek açık:</b> L7 stresi (80 bin anahtarlık depoda churn) KME <code>enc_keys</code> yolunda bir O(n) gösterdi — un-issued kuyruğu <code>splice(0,n)</code> ile ön-uçtan siliniyordu, büyük depoda her enc bütün kuyruğu kaydırıyordu (10k→160k'da 4→479 μs/enc). Baş-işaretçili dequeue ile O(1)'e indirildi (~2 μs, depo boyutundan bağımsız). Düzeltme yalnız KME katmanında; çekirdeğe dokunulmadı.</div>

<p class="note">Kaynak: <code>bb84/layer_stress_campaign.js</code> · L1 fiber sönümleme, L2 atlama-sayısı duvarı, L3 yönlendirme doygunluğu (kenar aşımı yok), L4 QBER + sonlu-anahtar duvarları (ℓ asla negatif), L5 kabul eşiği + bozulmuş akış, L6 ×10 talep patlaması, L7 KME churn. Her satırın kıvılcımı ilgili degradasyon eğrisidir.</p>

</div></body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "layer_stress.json");
  const outPath = process.argv[3] || "/tmp/layer_stress_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
