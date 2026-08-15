#!/usr/bin/env node
"use strict";
/**
 * gen_qkd_rate_chart.js
 * parallel_routing_qkd_rate_test.js çıktısından tek dosyalık görsel.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • R_key(T) → ZAMAN İÇİNDE DEĞİŞİM → ÇİZGİ. İki seri (tek yol /
 *     paralel birleşik) → KATEGORİK renk (kimlik). Crosshair + tooltip.
 *   • Strateji karşılaştırması → üç strateji 3. bölümde TEKRAR ettiği
 *     için VURGU (kazanan renkli / diğerleri gri) yerine KİMLİK rengi
 *     kullanıldı: k1=birleşik blok, k2=tek yol, k3=ayrı bloklar. Bir
 *     varlık bölümden bölüme renk DEĞİŞTİRMEZ; ilk taslakta "ayrı
 *     bloklar" 3. bölümde bir satırda yeşil, diğerinde griydi — hataydı.
 *   • Kazanç ayrıştırması → sıralı büyüklükler + ×1 referans çizgisi
 *     (×1'in ALTI kayıp demek, bu yüzden referans şart).
 *   • ÇİFT EKSEN YOK: ℓ (bit) ile R_key (bit/s) AYRI bölümlerde.
 *   • Açık modda yeşil slot kontrast WARN aldı → RAHATLAMA KURALI:
 *     her çubuk/uç doğrudan etiketli + tam tablo görünümü var.
 *
 * Palet: kategorik 3 slot, her iki modda da validate_palette.js PASS.
 */
const fs = require("fs");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const C = D.rKeyCurve, S = D.strategies, GN = D.gains, ST = D.ellStability;
  const peakP = C.reduce((a, b) => (b.parallelRKeyBps > a.parallelRKeyBps ? b : a));
  const peakS = C.reduce((a, b) => (b.singleRKeyBps > a.singleRKeyBps ? b : a));

  // ══ 1) R_key(T) ÇİZGİ GRAFİĞİ ══
  const L = { w: 780, h: 340, l: 62, r: 138, t: 22, b: 44 };
  const iw = L.w - L.l - L.r, ih = L.h - L.t - L.b;
  const tMax = C[C.length - 1].tMs;
  const yMax = 700;                                   // 10'un katı, veriyi kapsıyor
  const X = (t) => L.l + (t / tMax) * iw;
  const Y = (v) => L.t + ih - (v / yMax) * ih;
  const line = (f) => C.map((r, i) => `${i ? "L" : "M"}${X(r.tMs).toFixed(1)},${Y(r[f]).toFixed(1)}`).join("");

  let grid = "";
  for (let v = 0; v <= yMax; v += 100) {
    grid += `<line x1="${L.l}" y1="${Y(v)}" x2="${L.l + iw}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${L.l - 9}" y="${Y(v) + 4}" text-anchor="end" class="tick">${tr(v)}</text>`;
  }
  for (let t = 0; t <= tMax; t += 250) {
    grid += `<line x1="${X(t)}" y1="${L.t}" x2="${X(t)}" y2="${L.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${X(t)}" y="${L.t + ih + 20}" text-anchor="middle" class="tick">${tr(t)}</text>`;
  }

  // Eşik işaretleri: ilk güvenli anahtarın çıktığı an
  const be = D.breakEven;
  let marks = "";
  const mark = (t, slot, label) => {
    if (t == null) return "";
    return `<line x1="${X(t)}" y1="${L.t}" x2="${X(t)}" y2="${L.t + ih}" stroke="var(--k${slot})" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.75"/>` +
      `<text x="${X(t) + 5}" y="${L.t + 13}" class="anno k${slot}t">${label}</text>`;
  };
  marks += mark(be.parallelFirstKeyMs, 1, `ilk anahtar ${tr(be.parallelFirstKeyMs)} ms`);
  marks += mark(be.singleFirstKeyMs, 2, `${tr(be.singleFirstKeyMs)} ms`);

  // Uç etiketleri (kontrast WARN'ı için doğrudan etiket ZORUNLU)
  const last = C[C.length - 1];
  const endLab =
    `<circle cx="${X(peakP.tMs)}" cy="${Y(peakP.parallelRKeyBps)}" r="5" fill="var(--k1)" stroke="var(--surface-1)" stroke-width="2"/>` +
    `<text x="${X(peakP.tMs) + 10}" y="${Y(peakP.parallelRKeyBps) - 8}" class="pk">zirve ${tr(peakP.parallelRKeyBps, 0)} bit/s</text>` +
    `<text x="${L.l + iw + 8}" y="${Y(last.parallelRKeyBps) + 4}" class="endlab k1t">paralel<tspan x="${L.l + iw + 8}" dy="14">${tr(last.parallelRKeyBps, 0)} bit/s</tspan></text>` +
    `<text x="${L.l + iw + 8}" y="${Y(last.singleRKeyBps) + 4}" class="endlab k2t">tek yol<tspan x="${L.l + iw + 8}" dy="14">${tr(last.singleRKeyBps, 0)} bit/s</tspan></text>`;

  const hover = C.map((r) => `<g class="hv" data-x="${X(r.tMs).toFixed(1)}" data-tip="<b>T = ${tr(r.tMs)} ms</b><br>paralel: ${tr(r.parallelPairs)} çift · ℓ=${tr(r.parallelEll)} bit · <b>${tr(r.parallelRKeyBps, 0)} bit/s</b><br>tek yol: ${tr(r.singlePairs)} çift · ℓ=${tr(r.singleEll)} bit · <b>${tr(r.singleRKeyBps, 0)} bit/s</b>">
    <rect x="${(X(r.tMs) - iw / (C.length * 2)).toFixed(1)}" y="${L.t}" width="${(iw / C.length).toFixed(1)}" height="${ih}" fill="transparent"/></g>`).join("");

  // ══ 2) STRATEJİ ÇUBUKLARI (vurgu) ══
  // RENK = KİMLİK ve sayfa boyunca SABİT:
  //   k1 (mavi)   = paralel, tek birleşik blok
  //   k2 (turuncu)= tek yol
  //   k3 (yeşil)  = paralel, yol başına ayrı bloklar
  // Bu eşleme 1., 2. ve 3. bölümde AYNIDIR — bir varlık bölümden
  // bölüme renk değiştirmez.
  const rows = [
    { k: "single", name: "tek yol", sub: `${S.single.paths[0]} · 1 blok`, ell: ST.single.mean, sd: ST.single.sd, r: S.single.rKeyBps, slot: 2 },
    { k: "perPath", name: "paralel — yol başına AYRI blok", sub: "3 yol · 3 ayrı anahtar bloğu", ell: ST.perPath.mean, sd: ST.perPath.sd, r: S.perPath.rKeyBps, slot: 3 },
    { k: "pooled", name: "paralel — TEK birleşik blok", sub: "3 yol · tek anahtar bloğu", ell: ST.pooled.mean, sd: ST.pooled.sd, r: S.pooled.rKeyBps, slot: 1 },
  ];
  const SB = { w: 780, h: 3 * 74 + 16, l: 250, r: 132 };
  const sw = SB.w - SB.l - SB.r;
  const ellMax = Math.max(...rows.map(r => r.ell + r.sd));
  const stratBars = rows.map((r, i) => {
    const y = 12 + i * 74;
    const w = Math.max((r.ell / (ellMax * 1.04)) * sw, 3);
    // ±1sd GRAFİK olarak çizilmiyor: en küçük iki çubuk ~50px, çentikler
    // orada okunmuyordu. Belirsizlik SAYIYLA veriliyor (ve tabloda).
    return `<g class="row" data-tip="<b>${esc(r.name)}</b><br>ℓ = ${tr(r.ell, 1)} ± ${tr(r.sd, 1)} bit (20 tohum, ${tr(r.ell - r.sd, 0)}–${tr(r.ell + r.sd, 0)})<br>R_key = ${tr(r.r, 0)} bit/s">
      <rect x="0" y="${y}" width="${SB.w}" height="60" fill="transparent"/>
      <text x="${SB.l - 14}" y="${y + 25}" text-anchor="end" class="lab">${esc(r.name)}</text>
      <text x="${SB.l - 14}" y="${y + 41}" text-anchor="end" class="sublab">${esc(r.sub)}</text>
      <rect x="${SB.l}" y="${y + 14}" width="${w}" height="26" rx="4" fill="var(--k${r.slot})"/>
      <text x="${SB.l + w + 12}" y="${y + 25}" class="val">${tr(r.ell, 1)} ± ${tr(r.sd, 1)} bit</text>
      <text x="${SB.l + w + 12}" y="${y + 41}" class="sublab">${tr(r.r, 0)} bit/s</text>
    </g>`;
  }).join("");

  // ══ 3) KAZANÇ AYRIŞTIRMASI ══
  // Renk yine KİMLİĞE bağlı: birleşik = k1, ayrı bloklar = k3.
  // İlk iki satır strateji-bağımsız ham gerçeklerdir (hangi anahtarlama
  // seçilirse seçilsin aynı) → tarafsız gri. Aynı varlığın iki satırı
  // ASLA farklı renk almaz.
  const gains = [
    { n: "çift sayısı", v: GN.pairGain, why: "paralel yönlendirmenin ham kazancı", col: "var(--muted-mark)" },
    { n: "çift HIZI", v: GN.pairRateGain, why: "makespan uyuşmazlığı: 881 → 1.469 ms", col: "var(--muted-mark)" },
    { n: "ℓ — birleşik blok", v: GN.ellGainPooled, why: "sonlu-anahtar amortismanı (μ ∼ 1/√n)", col: "var(--k1)" },
    { n: "R_key — birleşik", v: GN.rKeyGainPooled, why: "ℓ kazancı × süre oranı", col: "var(--k1)" },
    { n: "ℓ — ayrı bloklar", v: GN.ellGainPerPath, why: "2. ve 3. yol tek başına abort ediyor", col: "var(--k3)" },
    { n: "R_key — ayrı blk", v: GN.rKeyGainPerPath, why: "tek yolun ALTINDA — kazanç tamamen harcandı", col: "var(--k3)" },
  ];
  const GB = { w: 780, h: gains.length * 46 + 40, l: 186, r: 210, t: 26 };
  const gw = GB.w - GB.l - GB.r;
  const gMax = Math.max(...gains.map(g => g.v)) * 1.05;
  const GX = (v) => GB.l + (v / gMax) * gw;
  let gainBars = `<line x1="${GX(1)}" y1="${GB.t - 8}" x2="${GX(1)}" y2="${GB.t + gains.length * 46 - 6}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="3 3"/>
    <text x="${GX(1)}" y="${GB.t - 13}" text-anchor="middle" class="anno">×1 — kazanç yok</text>
    <line x1="${GX(GN.pairGain)}" y1="${GB.t - 8}" x2="${GX(GN.pairGain)}" y2="${GB.t + gains.length * 46 - 6}" stroke="var(--grid)" stroke-width="1.5"/>
    <text x="${GX(GN.pairGain) + 5}" y="${GB.t - 13}" class="anno">×${tr(GN.pairGain, 2)} — ham çift kazancı</text>`;
  gains.forEach((g, i) => {
    const y = GB.t + i * 46;
    // Etiket ×1 kesikli çizgisinin ÜSTÜNE denk gelmesin (çizgi yazının
    // içinden geçiyordu) — çizginin sağına itilir.
    const lx = Math.max(GX(g.v) + 10, GX(1) + 10);
    gainBars += `<g class="row" data-tip="<b>${esc(g.n)}</b><br>×${tr(g.v, 3)}<br>${esc(g.why)}">
      <rect x="0" y="${y - 4}" width="${GB.w}" height="42" fill="transparent"/>
      <text x="${GB.l - 12}" y="${y + 19}" text-anchor="end" class="lab">${esc(g.n)}</text>
      <rect x="${GB.l}" y="${y + 4}" width="${Math.max(GX(g.v) - GB.l, 2)}" height="22" rx="4" fill="${g.col}"/>
      <text x="${lx}" y="${y + 14}" class="val">×${tr(g.v, 2)}</text>
      <text x="${lx}" y="${y + 28}" class="sublab">${esc(g.why)}</text>
    </g>`;
  });

  const rowsTable = C.map(r => `<tr><td>${tr(r.tMs)}</td><td>${tr(r.singlePairs)}</td><td>${tr(r.parallelPairs)}</td><td>${tr(r.singleEll)}</td><td>${tr(r.parallelEll)}</td><td>${tr(r.singleRKeyBps, 2)}</td><td>${tr(r.parallelRKeyBps, 2)}</td></tr>`).join("");
  const subsetRows = D.subsetScan.map(s => `<tr><td>${esc(s.paths.join(" + "))}</td><td>${tr(s.pairs)}</td><td>${tr(s.ePh, 5)}</td><td>${tr(s.ell)}</td><td>${tr(s.rKeyBps, 2)}</td></tr>`).join("");
  const ac = D.accountingComparison.pooled;
  const bell = D.e91.pooled.bell, req = D.e91.requiredBlock;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Paralel yönlendirme → QKD anahtar üretim hızı</title>
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
  h2{font-size:14px;margin:34px 0 4px;letter-spacing:0.01em;}
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
  .lab{font-size:12px;fill:var(--text-primary);font-weight:560;}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .pk{font-size:11px;fill:var(--text-primary);font-weight:640;}
  .endlab{font-size:11.5px;font-weight:620;}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);} .k3t{fill:var(--k3);}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .row:hover rect:first-of-type,.hv:hover rect{fill:var(--surface-2);}
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

<h1>Paralel yönlendirme → QKD anahtar üretim hızı</h1>
<p class="sub">×2,48'lik <b>çift</b> kazancı, anahtar hızına <b>×2,48 olarak yansımıyor</b>. Üç etken araya giriyor: sonlu-anahtar amortismanı (kazandırır, süper-doğrusal), QBER seyrelmesi ve makespan uyuşmazlığı (kaybettirir). Net sonuç, çiftleri <b>nasıl anahtarladığınıza</b> bağlı — ve yanlış seçim kazancın tamamını yiyor.</p>

<div class="tiles">
  <div class="tile"><div class="l">çift kazancı</div><div class="v">×${tr(GN.pairGain, 2)}</div></div>
  <div class="tile"><div class="l">R_key — birleşik blok</div><div class="v k1t">×${tr(GN.rKeyGainPooled, 2)}</div></div>
  <div class="tile"><div class="l">R_key — ayrı bloklar</div><div class="v k3t">×${tr(GN.rKeyGainPerPath, 2)}</div></div>
  <div class="tile"><div class="l">zirve R_key</div><div class="v">${tr(peakP.parallelRKeyBps, 0)} bit/s</div></div>
  <div class="tile"><div class="l">ilk anahtar</div><div class="v">${tr(be.parallelFirstKeyMs)} ms</div></div>
</div>

<h2>1) R_key(T) — anahtar hızı, oturum süresine göre</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>paralel — 3 yol, tek birleşik blok</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>tek yol — ${esc(S.single.paths[0])}</span>
</div>
<svg viewBox="0 0 ${L.w} ${L.h}" aria-label="Anahtar üretim hızının oturum süresine göre değişimi">
  ${grid}
  <text x="${L.l + iw / 2}" y="${L.h - 4}" text-anchor="middle" class="axname">oturum süresi T (ms)</text>
  <text x="${L.l - 46}" y="${L.t - 8}" class="axname">R_key (bit/s)</text>
  ${marks}
  <path d="${line("singleRKeyBps")}" fill="none" stroke="var(--k2)" stroke-width="2" stroke-linejoin="round"/>
  <path d="${line("parallelRKeyBps")}" fill="none" stroke="var(--k1)" stroke-width="2" stroke-linejoin="round"/>
  ${endLab}
  <line id="cross" x1="0" y1="${L.t}" x2="0" y2="${L.t + ih}" stroke="var(--text-secondary)" stroke-width="1" opacity="0"/>
  ${hover}
</svg>
<p class="note"><b>Neden sıfırdan başlıyor:</b> sonlu-anahtar sınırı yüzünden her iki strateji de bir eşik süresine kadar <b>hiç</b> güvenli anahtar vermez (ℓ ≤ 0 — bu bir hata değil, beklenen davranış). Paralel yönlendirme bu eşiğe <b>${tr(be.parallelFirstKeyMs)} ms</b>'de, tek yol ${tr(be.singleFirstKeyMs)} ms'de ulaşıyor. <b>Neden sonra düşüyor:</b> deneme bütçesi segment başına 20.000 ile sabit; çift üretimi bitince pay sabitlenir, payda (T) büyümeye devam eder. Bu bir fizik sınırı değil, <b>bütçe tükenmesidir</b> — sürekli çalışan bir bağlantıda eğri platoda kalır.</p>

<h2>2) Çiftleri nasıl anahtarladığınız, kaç çift ürettiğinizden önemli</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k1)"></span>paralel — tek birleşik blok</span>
  <span class="lg"><span class="key" style="background:var(--k2)"></span>tek yol</span>
  <span class="lg"><span class="key" style="background:var(--k3)"></span>paralel — yol başına ayrı bloklar</span>
</div>
<p class="sub">Paralel yönlendirmenin 10.277 çifti iki farklı şekilde anahtarlanıyor; tek yol (4.136 çift) referans. Değerler <b>20 tohumun ortalaması ±1 standart sapma</b>.</p>
<svg viewBox="0 0 ${SB.w} ${SB.h}" aria-label="Strateji karşılaştırması">${stratBars}</svg>
<div class="callout"><b>Asıl bulgu:</b> paralel yönlendirmenin çiftlerini <b>yol başına ayrı ayrı anahtarlamak</b>, tek yola göre hiçbir şey kazandırmıyor: ℓ ${tr(ST.perPath.mean, 1)} ± ${tr(ST.perPath.sd, 1)} vs ${tr(ST.single.mean, 1)} ± ${tr(ST.single.sd, 1)} bit — <b>istatistiksel olarak ayırt edilemiyor</b> — çünkü 2. ve 3. yol tek başlarına sonlu-anahtar sınırını geçemeyip <b>abort ediyor</b>. Süre de uzadığı için R_key <b>tek yolun altına</b> düşüyor (×${tr(GN.rKeyGainPerPath, 2)}). Aynı çiftler <b>tek blokta</b> birleştirilince ℓ ${tr(ST.pooled.mean, 1)} bite çıkıyor: μ ∼ 1/√n küçülüyor ve blok başına sabit ~115 bitlik vergi 3 kez değil 1 kez ödeniyor.</div>

<h2>3) Kazanç nereye gitti?</h2>
<svg viewBox="0 0 ${GB.w} ${GB.h}" aria-label="Kazanç ayrıştırması">${gainBars}</svg>
<p class="note">Gri çizgi ×${tr(GN.pairGain, 2)} (ham çift kazancı) hizasındadır. ℓ kazancı bunun <b>üstünde</b> (süper-doğrusal), çift hızı ise <b>altında</b> — çünkü üç yol aynı anda bitmiyor. Kazançlar 20 tohumun <b>ortalamalarının oranıdır</b>; tek tohumluk oran ×9,04 çıkmıştı, bu sahte hassasiyet olurdu. Tohumlar arası bant: <b>${esc(GN.ellGainRangeAcrossSeeds)}</b>.</p>

<h2>4) İki yan bulgu</h2>
<div class="callout warn"><b>Güvenlik — baz asimetrisi.</b> Motorun ürettiği çiftler saf faz gürültülüdür (X = Y = 0), dolayısıyla QBER<sub>Z</sub> = 0 ama QBER<sub>X</sub> = 1−F. Mevcut <code>runQkdFlow</code> elenmiş bitlerin tamamından <b>tek</b> bir QBER sayıyor: ${tr(ac.symmetricQber, 5)} — ölçülen gerçek faz hatasının (${tr(ac.resolvedEPh, 5)}) tam yarısı. Bu değer güvenlik kanıtına faz hatası üst sınırı olarak girdiği için, n=${tr(ac.symmetricN)} bitlik blokta faz terimi <b>${tr(ac.safetyGapBits)} bit fazla</b> kredilendiriliyor. Bu sayfadaki tüm ℓ değerleri, anahtarı Z bazından / faz kestirimini X bazından alan <b>baz-çözünürlü</b> muhasebeyle hesaplandı.</div>
<div class="callout"><b>E91 — Bell testi geçiyor, anahtar geçmiyor.</b> Aynı havuzda CHSH ihlali <b>S = ${tr(bell.S, 3)} ± ${tr(bell.standardError, 3)}</b> ile klasik sınırın <b>${tr(bell.sigmaAboveClassical, 1)}σ</b> üstünde kanıtlandı — ama E91'in anahtarı yalnızca eşleşen yönlerden gelir (turların 1/9'u; BBM92'de 1/2), bu yüzden ℓ = 0, yani <b>abort</b>. Bunlar iki ayrı koşuldur. Aynı çift kalitesiyle E91'in anahtar üretmesi için gereken blok <b>≈${tr(req.pairsNeeded)} çift</b> olarak türetildi ve ölçümle doğrulandı (0,7×'te abort, 1,6×'ta ${tr(D.e91.requiredBlockVerified.above)} bit).</div>

<details>
<summary>Tablo görünümü — alt küme taraması (havuza hangi yollar girsin?)</summary>
<table><thead><tr><th>Havuz</th><th>Çift</th><th>e_ph</th><th>ℓ (bit)</th><th>R_key (bit/s)</th></tr></thead><tbody>${subsetRows}</tbody></table>
<p class="note">7 alt kümenin hepsi ölçüldü — "en kötü yolu at" varsayılmadı. Havuzlama e_ph'i 0,0335'ten 0,0483'e <b>çekiyor</b> (seyrelme gerçek), ama sonlu-anahtar amortismanı bunu geçtiği için <b>üç yolu birden</b> havuzlamak kazanıyor.</p>
</details>

<details>
<summary>Tablo görünümü — R_key(T) eğrisi</summary>
<table><thead><tr><th>T (ms)</th><th>tek yol çift</th><th>paralel çift</th><th>tek yol ℓ</th><th>paralel ℓ</th><th>tek yol R_key</th><th>paralel R_key</th></tr></thead><tbody>${rowsTable}</tbody></table>
</details>

<p class="note"><b>Yöntem:</b> Çiftler gerçek çok-atlamalı DEJMPS simülatöründen gelir (yol başına 20.000 deneme/segment, hedef F ≥ 0,85) ve <b>üretim zaman damgalarıyla</b> tutulur; T anına kadar hazır olanlar anahtarlanır. ℓ = n·(1 − h₂(e_ph + μ)) − leak_EC − log₂(2/ε_cor) − 2log₂(1/2ε_PA); μ iki parametreli Serfling sınırı, leak_EC gerçekten çalıştırılan Cascade'in <b>ölçülen</b> sızıntısı. Tahsis, matris katmanının açgözlü su-doldurma çözümüdür (kaba kuvvete karşı fark %0,00).</p>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip'),cross=document.getElementById('cross');
  function place(ev){var x=ev.clientX+14,y=ev.clientY+14,r=tip.getBoundingClientRect();
    if(x+r.width>innerWidth-8)x=ev.clientX-r.width-14;
    if(y+r.height>innerHeight-8)y=ev.clientY-r.height-14;
    tip.style.left=x+'px';tip.style.top=y+'px';}
  document.querySelectorAll('.row,.hv').forEach(function(g){
    g.addEventListener('mousemove',function(ev){
      tip.innerHTML=g.dataset.tip;tip.style.opacity=1;place(ev);
      if(cross&&g.dataset.x){cross.setAttribute('x1',g.dataset.x);cross.setAttribute('x2',g.dataset.x);cross.setAttribute('opacity','0.45');}});
    g.addEventListener('mouseleave',function(){tip.style.opacity=0;if(cross)cross.setAttribute('opacity','0');});});
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || require("path").join(__dirname, "reports", "parallel_routing_qkd_rate.json");
  const outPath = process.argv[3] || "/tmp/qkd_rate_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
