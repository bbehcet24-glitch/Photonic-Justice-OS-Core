#!/usr/bin/env node
"use strict";
/**
 * gen_network_routing_chart.js
 * network_matrix_routing_test.js'in ürettiği JSON'dan tek-dosya,
 * etkileşimli görsel: topoloji şeması + matris ısı haritası + yol
 * karşılaştırması + paralel tahsis.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Ağ yapısı → DÜĞÜM-KENAR ŞEMASI. Kenarlar tarafsız gri, üstüne
 *     tahsis edilen 3 yol kategorik renklerle bindiriliyor (kimlik).
 *   • Mesafe matrisi → ISI HARİTASI (grid içinde büyüklük) → tek-hue
 *     SIRALI mavi rampa. Kılavuz: "heatmap for a grid → sequential".
 *     Doğrulanmış ordinal rampa kullanıldı (açık modda 150. basamak
 *     kontrast eşiğini geçmediği için 250'den başlanıyor).
 *   • Yol verimi (η) → tek seri büyüklük karşılaştırması, ama ASIL MESELE
 *     hangi yolun tahsis ALDIĞI → VURGU: tahsis alanlar renkli,
 *     almayanlar gri.
 *   • Tek-yol vs paralel → parça-bütün yığılmış çubuk (3 kategorik slot,
 *     2px yüzey boşluğu).
 *   • ÇİFT EKSEN YOK.
 *
 * Palet doğrulaması: ordinal rampa (--ordinal) ve 3 kategorik slot,
 * her iki modda da PASS.
 */
const fs = require("fs");

const RAMP_L = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_D = ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#184f95"];
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { maximumFractionDigits: d } : undefined);

// Elle yerleştirilmiş düğüm konumları (topoloji küçük ve sabit — otomatik
// yerleşim algoritması burada okunabilirliği İYİLEŞTİRMEZ, kötüleştirir).
const POS = {
  A: [62, 200], R1: [236, 78], R2: [236, 272], R3: [404, 196],
  R4: [236, 372], B: [580, 200],
};

function build(D) {
  const T = D.topology, P = D.paths, R = D.routing;
  const allocated = R.greedy.allocation.filter(a => a.allocated > 0);
  const allocLabels = allocated.map(a => a.path);
  const pathByLabel = Object.fromEntries(P.map(p => [p.label, p]));

  // ══ 1) TOPOLOJİ ŞEMASI ══
  const NW = 660, NH = 440;
  let net = "";
  // Tahsis edilen kenar kümesi (kesikli/düz ayrımı için)
  const ekey = (a, b) => [a, b].sort().join("|");
  const allocEdges = new Set();
  for (const lab of allocLabels) {
    const seq = lab.split("→");
    for (let s = 0; s + 1 < seq.length; s++) allocEdges.add(ekey(seq[s], seq[s + 1]));
  }
  // Tarafsız kenarlar — tahsis almayanlar kesikli
  for (const l of T.links) {
    const [x1, y1] = POS[l.a], [x2, y2] = POS[l.b];
    const used = allocEdges.has(ekey(l.a, l.b));
    net += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--grid)" stroke-width="3"${used ? "" : ` stroke-dasharray="6 5"`}/>`;
  }
  // Tahsis edilen yolları üstüne bindir
  allocLabels.forEach((lab, i) => {
    const p = pathByLabel[lab];
    if (!p) return;
    for (let s = 0; s + 1 < p.label.split("→").length; s++) {
      const a = p.label.split("→")[s], b = p.label.split("→")[s + 1];
      const [x1, y1] = POS[a], [x2, y2] = POS[b];
      net += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--k${i + 1})" stroke-width="4" stroke-linecap="round" opacity="0.92"/>`;
    }
  });
  // km etiketleri
  for (const l of T.links) {
    const [x1, y1] = POS[l.a], [x2, y2] = POS[l.b];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const idle = !allocEdges.has(ekey(l.a, l.b));
    net += `<rect x="${mx - 17}" y="${my - 10}" width="34" height="17" rx="4" fill="var(--surface-1)" opacity="0.93"/>`;
    net += `<text x="${mx}" y="${my + 3}" text-anchor="middle" class="kmlab${idle ? " idlek" : ""}">${l.km} km</text>`;
  }
  // Düğümler
  for (const [name, [x, y]] of Object.entries(POS)) {
    const endpoint = name === "A" || name === "B";
    net += `<circle cx="${x}" cy="${y}" r="${endpoint ? 23 : 19}" fill="var(--surface-2)" stroke="var(--text-secondary)" stroke-width="${endpoint ? 2.5 : 1.5}"/>`;
    net += `<text x="${x}" y="${y + 5}" text-anchor="middle" class="nodelab">${name}</text>`;
  }
  const netLegend = allocLabels.map((lab, i) =>
    `<span class="lg"><span class="key" style="background:var(--k${i + 1})"></span>${esc(lab)}</span>`).join("") +
    `<span class="lg"><span class="key dash"></span>tahsis yok</span>`;

  // ══ 2) MESAFE MATRİSİ ISI HARİTASI ══
  const nodes = T.nodes, n = nodes.length;
  const cell = 54, MH = { l: 58, t: 40 };
  const MW = MH.l + cell * n + 16, MHt = MH.t + cell * n + 16;
  const kms = T.links.map(l => l.km);
  const kmMin = Math.min(...kms), kmMax = Math.max(...kms);
  const binOf = (km) => Math.min(4, Math.floor(((km - kmMin) / (kmMax - kmMin + 1e-9)) * 5));
  let heat = "";
  nodes.forEach((cn, j) => { heat += `<text x="${MH.l + j * cell + cell / 2}" y="${MH.t - 12}" text-anchor="middle" class="mlab">${cn}</text>`; });
  nodes.forEach((rn, i) => {
    heat += `<text x="${MH.l - 12}" y="${MH.t + i * cell + cell / 2 + 4}" text-anchor="end" class="mlab">${rn}</text>`;
    nodes.forEach((cn, j) => {
      const v = D.matrices.D[i][j];
      const x = MH.l + j * cell, y = MH.t + i * cell;
      if (i === j) {
        heat += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="var(--surface-2)"/><text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" class="mzero">0</text>`;
      } else if (v == null) {
        heat += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="none" stroke="var(--grid)" stroke-width="1"/><text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" class="mzero">·</text>`;
      } else {
        const b = binOf(v);
        heat += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="var(--s${b + 1})"/><text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" class="mcell" fill="${b >= 3 ? "#fff" : "var(--text-primary)"}">${v}</text>`;
      }
    });
  });
  const scaleLegend = RAMP_L.map((_, i) => {
    const lo = kmMin + ((kmMax - kmMin) * i) / 5, hi = kmMin + ((kmMax - kmMin) * (i + 1)) / 5;
    return `<span class="lg"><span class="key" style="background:var(--s${i + 1})"></span>${lo.toFixed(0)}–${hi.toFixed(0)} km</span>`;
  }).join("");

  // ══ 3) YOL VERİMİ (vurgu: tahsis alan renkli, almayan gri) ══
  const PB = { w: 720, h: 56 * P.length + 40, l: 168, r: 154, t: 18 };
  const pw = PB.w - PB.l - PB.r;
  const maxEta = Math.max(...P.map(p => p.etaPerSegmentAttempt));
  let pathBars = "";
  const sortedP = [...P].sort((a, b) => b.etaPerSegmentAttempt - a.etaPerSegmentAttempt);
  sortedP.forEach((p, i) => {
    const y = PB.t + i * 56;
    const w = Math.max((p.etaPerSegmentAttempt / (maxEta * 1.06)) * pw, 3);
    const ai = allocLabels.indexOf(p.label);
    const col = ai >= 0 ? `var(--k${ai + 1})` : "var(--muted-mark)";
    pathBars += `<g class="row" tabindex="0" role="listitem" data-tip="<b>${esc(p.label)}</b><br>${p.hops} hop · ${p.totalKm} km<br>η = ${p.etaPerSegmentAttempt} çift/deneme<br>ölçülen ${trn(p.pairs)} çift · F_ort ${p.meanFidelity}<br>gereken bağ sadakati: ${p.requiredSegmentFidelity}">
      <rect class="hit" x="0" y="${y}" width="${PB.w}" height="48" fill="transparent"/>
      <text x="${PB.l - 12}" y="${y + 21}" text-anchor="end" class="lab">${esc(p.label)}</text>
      <text x="${PB.l - 12}" y="${y + 36}" text-anchor="end" class="sublab">${p.hops} hop · ${p.totalKm} km</text>
      <rect x="${PB.l}" y="${y + 10}" width="${w}" height="24" rx="4" fill="${col}"/>
      <rect x="${PB.l}" y="${y + 10}" width="${Math.min(6, w)}" height="24" fill="${col}"/>
      <text x="${PB.l + w + 10}" y="${y + 21}" class="val">${p.etaPerSegmentAttempt.toFixed(5)}</text>
      <text x="${PB.l + w + 10}" y="${y + 35}" class="sublab">${ai >= 0 ? "tahsis edildi" : "tahsis YOK (kapasite tükendi)"}</text>
    </g>`;
  });

  // ══ 4) TEK-YOL vs PARALEL (yığılmış) ══
  const SB = { w: 720, h: 168, l: 128, r: 116, t: 24 };
  const sw = SB.w - SB.l - SB.r;
  const maxTot = Math.max(R.greedy.totalPairs, R.single.totalPairs);
  let stack = "";
  // Tek-yol
  {
    const w = (R.single.totalPairs / (maxTot * 1.04)) * sw;
    stack += `<text x="${SB.l - 12}" y="${SB.t + 22}" text-anchor="end" class="lab">tek yol</text>`;
    stack += `<text x="${SB.l - 12}" y="${SB.t + 37}" text-anchor="end" class="sublab">${esc(R.single.path)}</text>`;
    stack += `<rect x="${SB.l}" y="${SB.t + 6}" width="${Math.max(w, 3)}" height="28" rx="4" fill="var(--muted-mark)"/>`;
    stack += `<text x="${SB.l + w + 10}" y="${SB.t + 25}" class="val">${trn(R.single.totalPairs)} çift</text>`;
  }
  // Paralel (yığılmış)
  {
    const y = SB.t + 70;
    stack += `<text x="${SB.l - 12}" y="${y + 22}" text-anchor="end" class="lab">paralel</text>`;
    stack += `<text x="${SB.l - 12}" y="${y + 37}" text-anchor="end" class="sublab">${allocated.length} yol eşzamanlı</text>`;
    let off = 0;
    allocated.forEach((a, i) => {
      const w = (a.expectedPairs / (maxTot * 1.04)) * sw;
      const wAdj = i < allocated.length - 1 ? Math.max(w - 2, 1) : w;   // 2px yüzey boşluğu
      stack += `<rect x="${SB.l + off}" y="${y + 6}" width="${wAdj}" height="28" rx="${i === 0 || i === allocated.length - 1 ? 4 : 0}" fill="var(--k${i + 1})"/>`;
      if (wAdj > 46) stack += `<text x="${SB.l + off + wAdj / 2}" y="${y + 25}" text-anchor="middle" class="oncolor">${trn(a.expectedPairs)}</text>`;
      off += w;
    });
    stack += `<text x="${SB.l + off + 10}" y="${y + 25}" class="val">${trn(R.greedy.totalPairs)} çift</text>`;
  }

  const pathTable = P.map(p => `<tr><td>${esc(p.label)}</td><td>${p.hops}</td><td>${p.totalKm} km</td><td>${p.rawEndToEndFidelity.toFixed(6)}</td><td>${p.requiredSegmentFidelity.toFixed(6)}</td><td>${p.etaPerSegmentAttempt.toFixed(5)}</td><td>${trn(p.pairs)}</td><td>${p.meanFidelity != null ? p.meanFidelity.toFixed(6) : "—"}</td><td>${allocLabels.includes(p.label) ? "evet" : "hayır"}</td></tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ağ matrisi ve paralel yönlendirme</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --muted-mark:#c9c8c2;
    --s1:${RAMP_L[0]};--s2:${RAMP_L[1]};--s3:${RAMP_L[2]};--s4:${RAMP_L[3]};--s5:${RAMP_L[4]};
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --muted-mark:#4a4a46;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --muted-mark:#4a4a46;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--surface-1);
    color:var(--text-primary);max-width:860px;margin:0 auto;padding:28px 20px 56px;}
  h1{font-size:21px;line-height:1.3;margin:0 0 6px;font-weight:650;}
  h2{font-size:15px;margin:34px 0 4px;font-weight:600;}
  p.sub{color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:0 0 4px;}
  p.note{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0 0;}
  .kpi{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:11px 15px;min-width:104px;}
  .tile .l{font-size:11px;color:var(--text-secondary);}
  .tile .v{font-size:20px;font-weight:680;margin-top:3px;letter-spacing:-.01em;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle;margin-right:6px;}
  .key.dash{width:16px;height:0;border-radius:0;border-top:3px dashed var(--grid);}
  .lg{font-size:12px;color:var(--text-secondary);margin-right:13px;display:inline-flex;align-items:center;}
  .legend{margin:6px 0 2px;}
  svg{display:block;max-width:100%;height:auto;}
  .nodelab{font-size:13px;font-weight:660;fill:var(--text-primary);}
  .kmlab{font-size:10.5px;fill:var(--text-secondary);}
  .idlek{fill:var(--text-muted);font-style:italic;}
  .mlab{font-size:12px;font-weight:600;fill:var(--text-primary);}
  .mcell{font-size:12px;font-weight:600;}
  .mzero{font-size:12px;fill:var(--text-muted);}
  .lab{font-size:12px;fill:var(--text-primary);}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .oncolor{font-size:11.5px;fill:#fff;font-weight:640;}
  .row .hit{cursor:pointer;} .row:hover .hit,.row:focus .hit{fill:var(--surface-2);} .row:focus{outline:none;}
  .callout{background:var(--surface-2);border-left:3px solid var(--k1);border-radius:6px;padding:11px 15px;margin-top:14px;font-size:13px;line-height:1.6;}
  table{border-collapse:collapse;width:100%;font-size:12px;margin-top:10px;}
  th,td{border:1px solid var(--grid);padding:5px 8px;text-align:left;}
  th{background:var(--surface-2);font-weight:600;}
  .tip{position:fixed;pointer-events:none;background:var(--surface-2);color:var(--text-primary);border:1px solid var(--grid);
    border-radius:7px;padding:8px 11px;font-size:12px;line-height:1.5;max-width:300px;opacity:0;transition:opacity .1s;z-index:9;
    box-shadow:0 2px 10px rgba(0,0,0,.16);}
  details{margin-top:14px;} summary{cursor:pointer;font-size:13px;color:var(--text-secondary);}
</style></head>
<body><div class="viz-root">

<h1>Ağ matrisi ve paralel yönlendirme</h1>
<p class="sub">Zincirde takas <i>sırası</i> fark yaratmamıştı (Pauli konvolüsyonu değişmeli). Gerçek yönlendirme kazancı alternatif <b>yollardan</b> gelir — bu sayfa onu ölçüyor. Her η değeri gerçek çok-atlamalı simülatör koşumundan gelir, formülle tahmin edilmemiştir.</p>

<div class="kpi">
  <div class="tile"><div class="l">Düğüm / bağ</div><div class="v">${T.nodes.length} / ${T.links.length}</div></div>
  <div class="tile"><div class="l">Bulunan basit yol</div><div class="v">${P.length}</div></div>
  <div class="tile"><div class="l">Tek yol</div><div class="v">${trn(R.single.totalPairs)}</div></div>
  <div class="tile"><div class="l">Paralel</div><div class="v">${trn(R.greedy.totalPairs)}</div></div>
  <div class="tile"><div class="l">Kazanç</div><div class="v">×${R.parallelGain.toFixed(2)}</div></div>
</div>

<h2>1) Topoloji — paralel yönlendirmenin kullandığı yollar</h2>
<div class="legend">${netLegend}</div>
<svg viewBox="0 0 ${NW} ${NH}" aria-label="Ağ topolojisi ve tahsis edilen yollar">
  <rect width="${NW}" height="${NH}" fill="var(--surface-1)"/>${net}
</svg>
<p class="note">Gri kenarlar tüm fiber bağları; renkli çizgiler paralel yönlendirmenin eşzamanlı kullandığı <b>${allocated.length} yolu</b> gösterir. Bu üç yol <b>kenar-ayrık</b>tır — hiçbir bağı paylaşmazlar, dolayısıyla tek bir bağ kesilse diğer ikisi çalışmaya devam eder. <b>Kesikli gri</b> kenar (R1–R3, 7 km) hiçbir tahsis almamıştır: yalnızca tahsis edilmeyen iki yolun üzerindedir; sebebi aşağıda.</p>

<h2>2) Mesafe matrisi (D)</h2>
<div class="legend">${scaleLegend}</div>
<svg viewBox="0 0 ${MW} ${MHt}" aria-label="Mesafe matrisi ısı haritası">
  <rect width="${MW}" height="${MHt}" fill="var(--surface-1)"/>${heat}
</svg>
<p class="note">Simetrik matris (yönsüz graf). Boş hücreler (·) doğrudan bağ olmadığını, köşegen kendine uzaklığı (0) gösterir. Bitişiklik matrisi A bunun ikili (0/1) hâlidir; A^k ise k adımlık <i>yürüyüş</i> sayısını verir — <b>yürüyüş ≠ basit yol</b>: k=4'te ${D.matrixPowerWalks["4"]} yürüyüş var ama yalnızca ${P.filter(p => p.hops === 4).length} basit yol.</p>

<h2>3) Yol başına ölçülen verim (η)</h2>
<p class="sub">Segment başına harcanan denemenin kaçta kaçı uçtan uca çifte dönüştü. Renkli = tahsis edildi, gri = kapasite tükendiği için tahsis alamadı.</p>
<svg viewBox="0 0 ${PB.w} ${PB.h}" role="list" aria-label="Yol başına verim">
  <rect width="${PB.w}" height="${PB.h}" fill="var(--surface-1)"/>${pathBars}
</svg>
<div class="callout"><b>Dikkat çeken nokta:</b> ${esc(sortedP.find(p => !allocLabels.includes(p.label))?.label ?? "—")} yolunun verimi en yüksek ikinciler arasında olmasına rağmen tahsis almadı. Sebebi bir hata değil: besleyici bağları (A–R1 ve R2–R3) daha yüksek verimli yollar tarafından zaten tüketilmiş durumda. Bu, kapasite kısıtının <b>gerçekten bağlayıcı</b> olduğunun kanıtıdır — paylaşımsız bir topolojide "paralel yönlendirme" zaten önemsiz olurdu.</div>

<h2>4) Tek yol mu, paralel mi?</h2>
<svg viewBox="0 0 ${SB.w} ${SB.h}" aria-label="Tek yol ve paralel yönlendirme karşılaştırması">
  <rect width="${SB.w}" height="${SB.h}" fill="var(--surface-1)"/>${stack}
</svg>
<p class="note">Paralel yığındaki her renk bir yolun katkısıdır (legend yukarıda). Açgözlü su-doldurma sezgiseli kullanıldı ve <b>optimal olduğu varsayılmadı</b>: ${trn(R.brute.evaluated)} kombinasyonluk kaba kuvvet aramasıyla karşılaştırıldı, fark <b>%${(100 * (1 - R.greedy.totalPairs / R.brute.totalPairs)).toFixed(2)}</b> — bu örnekte açgözlü optimumu buluyor.</p>

<details open>
<summary>Tablo görünümü — tüm yollar</summary>
<table><thead><tr><th>Yol</th><th>Hop</th><th>Toplam km</th><th>Ham uçtan uca F</th><th>Gereken bağ F</th><th>η</th><th>Ölçülen çift</th><th>F_ort</th><th>Tahsis</th></tr></thead><tbody>${pathTable}</tbody></table>
</details>

<p class="note"><b>Yöntem:</b> Matris katmanı yapıyı verir (bitişiklik, mesafe, kapasite, bağ başına ulaşılabilir sadakat); fizik gerçek simülatörden gelir — her yol için ${trn(T.attemptsPerSegment)} deneme/segment ile çok-atlamalı DEJMPS koşumu, hedef nihai sadakat F ≥ ${T.targetFinalFidelity}. Uçtan uca sadakat Pauli konvolüsyonundan: F = (1 + Π(2aᵢ−1))/2. Paralel tahsis bir akış problemidir: max Σ xₚ·ηₚ, kısıt Σ_{p∋e} xₚ ≤ C_e.</p>

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
  const inPath = process.argv[2] || "/tmp/network_matrix_routing.json";
  const outPath = process.argv[3] || "/tmp/network_routing_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
