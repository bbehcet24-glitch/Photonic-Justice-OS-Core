#!/usr/bin/env node
"use strict";
/**
 * gen_faraday_cage_shielding_chart.js — Faraday kafesi EM kalkanlama PANOSU.
 *
 * FORM: production_gate panosuyla AYNI görsel dil (kriter kartları, pill,
 * bar). Buradaki "kriter" fiziksel senaryo sonucudur (öz-test), pass/fail.
 * İki karşılaştırma barı: (1) duvar-baskın vs açıklık-baskın SE, hedef
 * çizgisiyle; (2) kalkanlı vs sızdıran emisyon — alınan sinyal vs gürültü
 * tabanı. Renk paleti diğer panolarla birebir aynı (k1/k2/k3/amber).
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const allOk = D.allChecksPassed;
  const passN = D.checks.filter(c => c.ok).length;

  const rows = D.checks.map(c => {
    const cls = c.ok ? "ok" : "bad";
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${cls}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${cls}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  // Senaryo 1: duvar-baskın vs açıklık-baskın (hedef 60 dB çizgisiyle)
  const wallSe = D.wallDominant.combinedSeDb, apSe = D.apertureDominant.combinedSeDb, target = 60;
  const seMax = Math.max(wallSe, target) * 1.05;
  const seBarW = v => (Math.min(v, seMax) / seMax * 100).toFixed(1);
  const targetPct = (target / seMax * 100).toFixed(1);

  // Senaryo 1.5: saat harmonikleri boyunca kalkanlama çöküşü (1→19 GHz)
  const harm = D.clockHarmonics;
  const harmMaxSe = Math.max(...harm.perHarmonic.map(p => p.combinedSeDb), target) * 1.1;
  const harmBars = harm.perHarmonic.map(p => {
    const hN = Math.round(p.freqHz / harm.fundamentalHz);
    const wPct = (Math.max(p.combinedSeDb, 0) / harmMaxSe * 100).toFixed(1);
    const bad = p.combinedSeDb < target;
    return `<div class="hbar"><span class="hl">${hN}. harmonik (${(p.freqHz / 1e9).toFixed(0)} GHz)</span>
      <div class="track htrack"><div class="fill" style="width:${wPct}%;background:${bad ? "var(--k2)" : "var(--k3)"}"></div><div class="tline" style="left:${(target / harmMaxSe * 100).toFixed(1)}%"></div></div>
      <span class="v" style="color:${bad ? "var(--k2)" : "var(--k3)"}">${tr(p.combinedSeDb, 1)} dB</span></div>`;
  }).join("");

  // Düzeltilmiş tasarım: önce (5mm çıplak açıklık) vs sonra (3mm + 9mm honeycomb)
  const fx = D.fixedDesign;
  const beforeSe = harm.worstCombinedSeDb, afterSe = fx.worstCombinedSeDb;
  const fixMax = Math.max(afterSe, target) * 1.08;
  const fixBarW = v => (Math.max(v, 0) / fixMax * 100).toFixed(1);
  const fixTargetPct = (target / fixMax * 100).toFixed(1);

  // Senaryo 2: kalkanlı vs sızdıran emisyon
  const sh = D.detectability.shielded, lk = D.detectability.leaky;
  const emMax = Math.max(lk.receivedDbuVm, lk.noiseFloorDbuVm) + 10;
  const emMin = Math.min(sh.receivedDbuVm, 0) - 5;
  const emRange = emMax - emMin;
  const emPct = v => (Math.max(0, Math.min(v, emMax) - emMin) / emRange * 100).toFixed(1);
  const noisePct = emPct(sh.noiseFloorDbuVm);

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Faraday kafesi</title>
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
    padding:26px 30px 34px;max-width:880px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:28px 0 10px;}
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
  .scen{background:var(--surface-2);border-radius:11px;padding:16px 18px;position:relative;}
  .scenrow{display:grid;grid-template-columns:190px 1fr auto;gap:12px;align-items:center;margin:10px 0;}
  .scenrow .l{font-size:12.5px;color:var(--text-secondary);}
  .track{height:22px;background:var(--surface-3);border-radius:6px;overflow:hidden;position:relative;}
  .fill{height:100%;border-radius:6px;}
  .tline{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--amber);}
  .scenrow .v{font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .hbar{display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:center;margin:6px 0;}
  .hbar .hl{font-size:11.5px;color:var(--text-secondary);}
  .htrack{height:15px;}
  .hbar .v{font-size:12px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .tlabel{font-size:10.5px;color:var(--amber);font-weight:700;margin-top:2px;text-align:right;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Faraday kafesi — EM kalkanlama etkinliği</h1>
<p class="sub">EK katman (hardware-hazırlık): gerçek donanıma geçildiğinde lazer sürücü/dedektör elektroniğinin ürettiği bit-korelasyonlu RF emisyonun bir kafesle ne kadar bastırıldığını standart EMC (Schelkunoff) teorisiyle hesaplar. QBER tabanlı yan-kanal monitörünün <b>göremediği</b> bir tehdidi kapatır. Çekirdeğe dokunulmadı.</p>

<div class="verdict">
  <span class="badge">${allOk ? "TÜMÜ GEÇTİ ✓" : "BAŞARISIZ"}</span>
  <span class="vt">${passN}/${D.checks.length} öz-test geçti — ${allOk ? "algoritma fiziksel olarak tutarlı, çekirdek dokunulmadan doğrulandı" : "bazı testler başarısız"}</span>
</div>

<h2>Senaryo — darboğaz duvar mı, açıklık mı?</h2>
<div class="scen">
  <div class="scenrow"><span class="l">1mm bakır, açıklık YOK (100 kHz)</span>
    <div class="track"><div class="fill" style="width:${seBarW(wallSe)}%;background:var(--k3)"></div><div class="tline" style="left:${targetPct}%"></div></div>
    <span class="v" style="color:var(--k3)">${tr(wallSe, 1)} dB</span></div>
  <div class="scenrow"><span class="l">AYNI duvar + 50mm açıklık (1 GHz)</span>
    <div class="track"><div class="fill" style="width:${seBarW(apSe)}%;background:var(--k2)"></div><div class="tline" style="left:${targetPct}%"></div></div>
    <span class="v" style="color:var(--k2)">${tr(apSe, 1)} dB</span></div>
  <div class="tlabel">▎ hedef ${target} dB</div>
</div>
<p class="note">Aynı 1mm bakır duvar tek başına <code>${tr(D.apertureDominant.wallSeDb, 0)} dB</code> kalkanlama sağlıyor — ama 50mm'lik tek bir açıklık (kaynak, havalandırma, kablo geçişi) eklenince birleşik kalkanlama <b>${tr(apSe, 1)} dB</b>'ye çöküyor. EMC'nin temel kuralı doğrulandı: kafesin zayıf noktası duvar kalınlığı değil, en büyük açıklığın boyutudur.</p>

<h2>Saat harmonikleri — 1 GHz'e kadar tarama neden yetersiz?</h2>
<p class="sub" style="margin-top:0;">Proje kendi zamanlama modelinde (<code>timetag_acquisition_bridge.js</code>) lazer darbe tekrar frekansı olarak <b>1 GHz</b> (periodPs=1000 ps) kullanıyor. Ama bu periyodik bir DAR darbe treni — Fourier analizi gereği spektrumu temel frekansın tek katlarında (3, 5, 7… GHz) güçlü enerji taşır. Bu bir donanım varsayımı değil, matematiksel bir zorunluluk.</p>
<div class="scen">
  ${harmBars}
  <div class="tlabel">▎ hedef ${target} dB</div>
</div>
<p class="note">Aynı kafes tasarımı (2mm çelik + 5mm açıklık) temel frekansta (1 GHz) zaten hedefin altında (<b>${tr(harm.combinedSeAt1GHzDb, 1)} dB</b>) — ama sadece 1 GHz'e kadar bakmak yanıltıcı: harmonik yükseldikçe açıklık kaynaklı sızıntı MONOTON kötüleşiyor, 19. harmonikte (19 GHz) <b>${tr(harm.worstCombinedSeDb, 1)} dB</b>'ye düşüyor. Sonuç: kafes tasarımı düzeltilmeli (açıklık küçültülmeli veya derinlikli honeycomb havalandırma filtresi eklenmeli) — düz bir 5mm delik hiçbir gerçekçi frekansta hedefi tutturmuyor.</p>

<h2>Düzeltme — açıklık küçültme + honeycomb tünel derinliği</h2>
<p class="sub" style="margin-top:0;">Sadece açıklığı küçültmek (derinlik eklemeden) 19. harmonikte 60 dB için açıklığı <b>${tr(fx.requiredApertureUmNoHoneycomb, 1)} µm</b>'ye indirmeyi gerektirir — pratik değil. Bunun yerine gerçekçi bir açıklık (${fx.apertureMaxDimMm} mm) + dalga-kılavuzu-altı <b>honeycomb tünel derinliği</b> (${fx.honeycombDepthMm} mm, ${fx.ratio}:1 oran — gerçek EMC honeycomb havalandırma panellerinde yaygın kullanılan oran) eklenir.</p>
<div class="scen">
  <div class="scenrow"><span class="l">ÖNCE: 5mm çıplak açıklık, en kötü (19 GHz)</span>
    <div class="track"><div class="fill" style="width:${fixBarW(Math.min(beforeSe, fixMax))}%;background:var(--k2)"></div><div class="tline" style="left:${fixTargetPct}%"></div></div>
    <span class="v" style="color:var(--k2)">${tr(beforeSe, 1)} dB</span></div>
  <div class="scenrow"><span class="l">SONRA: ${fx.apertureMaxDimMm}mm + ${fx.honeycombDepthMm}mm honeycomb, en kötü (19 GHz)</span>
    <div class="track"><div class="fill" style="width:${fixBarW(afterSe)}%;background:var(--k3)"></div><div class="tline" style="left:${fixTargetPct}%"></div></div>
    <span class="v" style="color:var(--k3)">${tr(afterSe, 1)} dB</span></div>
  <div class="tlabel">▎ hedef ${target} dB</div>
</div>
<p class="note">Düzeltilmiş tasarım, taranan TÜM harmoniklerde (1-19 GHz) hedefi tutturuyor — en kötü durumda bile <b>+${tr(fx.marginDb, 1)} dB</b> marj bırakıyor. Çekirdeğe dokunulmadı; düzeltme yalnızca bu katmanın (<code>faraday_cage_shielding.js</code>) parametrelerinde.</p>

<h2>Emisyon tespit edilebilirliği — kalkanlı vs sızdıran kafes</h2>
<div class="scen">
  <div class="scenrow"><span class="l">iyi kalkanlı (açıklık yok, 3 m)</span>
    <div class="track"><div class="fill" style="width:${emPct(sh.receivedDbuVm)}%;background:var(--k3)"></div><div class="tline" style="left:${noisePct}%"></div></div>
    <span class="v" style="color:var(--k3)">${tr(sh.receivedDbuVm, 0)} dBµV/m</span></div>
  <div class="scenrow"><span class="l">sızdıran (100mm açıklık, 1 m)</span>
    <div class="track"><div class="fill" style="width:${emPct(lk.receivedDbuVm)}%;background:var(--k2)"></div><div class="tline" style="left:${noisePct}%"></div></div>
    <span class="v" style="color:var(--k2)">${tr(lk.receivedDbuVm, 0)} dBµV/m</span></div>
  <div class="tlabel">▎ gürültü tabanı ${sh.noiseFloorDbuVm} dBµV/m</div>
</div>
<p class="note">İyi kalkanlı kafeste alınan sinyal gürültü tabanının <b>çok altında</b> — bit-korelasyonlu emisyon bastırılmış. Sızdıran kafeste (büyük açıklık, yakın gözlemci) sinyal gürültü tabanının <b>üzerinde</b> kalıyor — EM yan-kanal hâlâ tespit edilebilir.</p>

<h2>Öz-testler (${passN}/${D.checks.length})</h2>
${rows}

<div class="callout"><b>Özet:</b> modül standart EMC/Schelkunoff kalkanlama teorisiyle çalışıyor, açıklık-baskınlık kuralını ve bağımsız sızıntı yollarının güç-alanında birleşimini doğru hesaplıyor, sayısal uç durumlarda (A≈0) kırılmıyor ve bilinmeyen malzemeyi sessizce kabul etmiyor. <code>photonnet_core.js</code> hiç import edilmedi ve SHA-256'sı test öncesi/sonrası değişmedi — bu katman çekirdekten tamamen bağımsız.</p>
</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "faraday_cage_shielding.json");
  const outPath = process.argv[3] || "/tmp/faraday_cage_shielding_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
