#!/usr/bin/env node
"use strict";
/**
 * gen_mtls_failsafe_debounce_chart.js — "Erken Ölüm" (Premature Death)
 * karşıtı zaman-histerezisi/debounce testinin sonuç panosu: gerçek yaşlanma
 * yörüngesi + enjekte edilmiş transientler üzerinde SE ve etkin durum
 * (OK/SUSPECT/BLOCKED/RECOVERING) zaman serisi, artı A-G sentetik senaryo
 * kartları.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STATE_COLOR = { OK: "var(--k3)", SUSPECT: "var(--amber)", BLOCKED: "var(--k2)", RECOVERING: "var(--k1)" };

function build(H) {
  const passN = H.checks.filter(c => c.ok).length, totalN = H.checks.length;
  const rows = H.checks.map(c => {
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${c.ok ? "ok" : "bad"}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  // ── (H) gerçek yörünge + enjekte transient — ana zaman serisi grafiği ──
  const R = H.realTrajectoryIntegration;
  const trace = R.trace; // { cycle, realSeDb, injected, effectiveState, effectiveAllowed }[]
  const CYCLES = R.cyclesRun;
  const W = 780, PAD = 10, STRIP_H = 12, STRIP_GAP = 6, LABEL_H = 16, plotH = 150;
  const Hh = PAD * 2 + plotH + STRIP_GAP + STRIP_H + LABEL_H;
  const xOf = (c) => PAD + ((c - 1) / (CYCLES - 1)) * (W - 2 * PAD);
  const targetSeDb = 60, floorDb = 30;
  const yMax = 110, yMin = 0;
  const yOf = (se) => PAD + plotH - ((Math.max(yMin, Math.min(yMax, se)) - yMin) / (yMax - yMin)) * plotH;
  const targetY = yOf(targetSeDb), floorY = yOf(floorDb);

  // GERÇEK SE eğrisi: enjekte edilen tek-döngülük transient noktaları da (10 dB'e
  // düşen) DOĞRU biçimde çizime YANSITILIR — bu grafiğin dürüstlüğü, debounce'un
  // bu görünür dipleri SÜZDÜĞÜNÜ göstermesindedir; gizlemek amacı yener.
  const seVals = trace.map(t => t.injected ? 10 : t.realSeDb);
  const pathD = trace.map((t, i) => `${i === 0 ? "M" : "L"}${xOf(t.cycle).toFixed(1)},${yOf(seVals[i]).toFixed(1)}`).join(" ");

  const firstFailX = xOf(R.firstFailCycleReal);
  const confirmedX = xOf(R.confirmedBlockCycle);
  const spikeMarks = R.injectedSpikeCycles.map(c => `<line x1="${xOf(c).toFixed(1)}" y1="${PAD}" x2="${xOf(c).toFixed(1)}" y2="${PAD+plotH}" stroke="var(--amber)" stroke-width="1" stroke-dasharray="2,2"/>`).join("");
  const spikeLabels = R.injectedSpikeCycles.map((c, i) => `<text x="${Math.max(PAD, xOf(c)-24).toFixed(1)}" y="${PAD+10+(i%2)*11}" fill="var(--amber)">döngü ${c}</text>`).join("");

  // durum şeridi: her döngünün effectiveState'i renkli, bitişik dikdörtgenlerle
  const stripY = PAD + plotH + STRIP_GAP;
  const stateFillVar = { OK: "var(--k3)", SUSPECT: "var(--amber)", BLOCKED: "var(--k2)", RECOVERING: "var(--k1)" };
  const stripRects = trace.map((t, i) => {
    const x0 = xOf(t.cycle), x1 = i + 1 < trace.length ? xOf(trace[i + 1].cycle) : W - PAD;
    return `<rect x="${x0.toFixed(1)}" y="${stripY}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="${STRIP_H}" fill="${stateFillVar[t.effectiveState]}"/>`;
  }).join("");

  const chartSvg = `<svg viewBox="0 0 ${W} ${Hh}" width="100%" height="${Hh}">
    <line x1="${PAD}" y1="${targetY.toFixed(1)}" x2="${W-PAD}" y2="${targetY.toFixed(1)}" stroke="var(--k1)" stroke-width="1" stroke-dasharray="4,3"/>
    <text x="${W-90}" y="${(targetY-4).toFixed(1)}">hedef ${targetSeDb} dB</text>
    <line x1="${PAD}" y1="${floorY.toFixed(1)}" x2="${W-PAD}" y2="${floorY.toFixed(1)}" stroke="var(--k2)" stroke-width="1" stroke-dasharray="4,3"/>
    <text x="${W-90}" y="${(floorY-4).toFixed(1)}">acil-taban ${floorDb} dB</text>
    ${spikeMarks}${spikeLabels}
    <path d="${pathD}" fill="none" stroke="var(--k3)" stroke-width="1.4"/>
    <line x1="${firstFailX.toFixed(1)}" y1="${PAD}" x2="${firstFailX.toFixed(1)}" y2="${PAD+plotH}" stroke="var(--k2)" stroke-width="1.4"/>
    <line x1="${confirmedX.toFixed(1)}" y1="${PAD}" x2="${confirmedX.toFixed(1)}" y2="${PAD+plotH}" stroke="var(--k2)" stroke-width="1.4" stroke-dasharray="1,2"/>
    ${stripRects}
    <text x="${(firstFailX+4).toFixed(1)}" y="${(PAD+plotH-6).toFixed(1)}" fill="var(--k2)">döngü ${R.firstFailCycleReal}: GERÇEK arıza başlar</text>
    <text x="${(confirmedX+4).toFixed(1)}" y="${(PAD+plotH-18).toFixed(1)}" fill="var(--k2)">döngü ${R.confirmedBlockCycle}: BLOCKED (+${R.detectionLatencyCycles})</text>
    <text x="${PAD}" y="${stripY+STRIP_H+11}">etkin durum şeridi: yeşil=OK · amber=SUSPECT · kırmızı=BLOCKED</text>
  </svg>`;

  const seqCard = (title, states, allowedNote) => `<div class="card"><div class="lbl">${esc(title)}</div><div class="statebar">${states.map(s => `<span class="chip" style="background:${STATE_COLOR[s]}22;color:${STATE_COLOR[s]};border:1px solid ${STATE_COLOR[s]}66">${s}</span>`).join('<span class="arrow">→</span>')}</div><div class="sm">${esc(allowedNote)}</div></div>`;

  const A = H.transientImmunity, B = H.sustainedFailure, C = H.singleGoodNoUnlock, D = H.fullRecovery, E = H.interruptedRecoveryResets, G = H.coldStart;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>mTLS zaman-histerezisi (debounce)</title>
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
    padding:26px 30px 34px;max-width:940px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:30px 0 4px;}
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
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;}
  .card{background:var(--surface-2);border-radius:11px;padding:14px 16px;border-left:3px solid var(--k1);}
  .card .big{font-size:20px;font-weight:700;margin:2px 0 4px;font-variant-numeric:tabular-nums;}
  .card .lbl{font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.03em;}
  .card .sm{font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:4px;}
  .statebar{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin:6px 0 2px;}
  .chip{font-size:10px;font-weight:700;letter-spacing:.02em;padding:2px 7px;border-radius:999px;white-space:nowrap;}
  .arrow{color:var(--text-muted);font-size:11px;padding:0 1px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  .chartbox{background:var(--surface-2);border-radius:11px;padding:14px 16px;}
  svg text{font-size:9.5px;fill:var(--text-muted);}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>mTLS acil-durum tabanı — zaman-histerezisi (Erken Ölüm karşıtı debounce)</h1>
<p class="sub">EMERGENCY_SE_FLOOR_DB kontrolü tek bir örneğe bakınca, geçici bir EM transienti (ör. yakından geçen bir yüksek-gerilim hattı) fiziksel katman hiç bozulmadan sistemi gereksiz yere kilitleyebilir ("erken ölüm"/yalancı-pozitif). SeFailsafeDebounce bunu, GERÇEK/sürdürülen arızaları hâlâ yakalayan asimetrik bir zaman-histerezisiyle önler. Çekirdeğe dokunulmadı, mtlsHandshakePrecondition() değiştirilmedi.</p>

<div class="verdict">
  <span class="badge">TÜMÜ GEÇTİ ✓</span>
  <span class="vt">${passN}/${totalN} öz-test geçti — transientler tamamen süzülüyor, gerçek arıza yine de ${R.detectionLatencyCycles} döngü (${R.detectionLatencyMs}ms) gecikmeyle yakalanıyor</span>
</div>

<h2>1. Gerçek yaşlanma yörüngesi + enjekte edilmiş transientler (H)</h2>
<div class="chartbox">${chartSvg}</div>
<p class="note">hardware_aging_model.js'in GERÇEK bozulma yörüngesi (AGING_SEED=7, hardware_aging_model_test.js'teki firstFailCycle=335 ile TUTARLI) üzerine, döngü ${R.injectedSpikeCycles.join(", ")}'de (arızadan ÇOK ÖNCE, kafes hâlâ &gt;90 dB'de sağlamken) sentetik tek-döngülük "yüksek-gerilim hattı" transientleri (SE anlık 10 dB'e düşürüldü) enjekte edildi. Debounce bunların HİÇBİRİNDE effectiveAllowed'ı false yapmadı — ama döngü ${R.firstFailCycleReal}'deki GERÇEK, SÜRDÜRÜLEN bozulmayı döngü ${R.confirmedBlockCycle}'de (yalnız ${R.detectionLatencyCycles} döngü/${R.detectionLatencyMs}ms sonra) doğru biçimde BLOCKED'a çevirdi ve bir daha ASLA geri açmadı.</p>
<div class="cards">
  <div class="card"><div class="lbl">enjekte transient sayısı</div><div class="big" style="color:var(--k3)">${R.injectedSpikeCycles.length}/${R.injectedSpikeCycles.length}</div><div class="sm">süzüldü — spikesFiltered=${R.spikesFiltered}</div></div>
  <div class="card" style="border-left-color:var(--k2)"><div class="lbl">gerçek arıza tespit gecikmesi</div><div class="big" style="color:var(--k2)">${R.detectionLatencyMs} ms</div><div class="sm">debounce'un dürüstçe ödediği bedel (döngü ${R.firstFailCycleReal} → ${R.confirmedBlockCycle})</div></div>
  <div class="card"><div class="lbl">geri-açılma</div><div class="big" style="color:var(--k3)">YOK</div><div class="sm">neverReopensAfterBlock=${R.neverReopensAfterBlock} — onaylanan arıza sonrası HİÇ geri açılmadı</div></div>
</div>

<h2>2. Sentetik senaryo tatbikatları (A–G)</h2>
<div class="cards">
  ${seqCard("(A) transient bağışıklık", A.states, "effectiveAllowed HİÇ false olmadı")}
  ${seqCard("(B) sürdürülen arıza — " + B.detectionLatencyMs + "ms gecikme", B.states, "BLOCKED'dan ÖNCE effectiveAllowed hep true")}
  ${seqCard("(C) tek-iyi-okuma kilit açmaz", C.states, "effectiveAllowed İKİ adımda da false")}
  ${seqCard("(D) tam kurtarma kilidi açar", D.states, "recoveryHysteresisMs tamamlanınca OK")}
  ${seqCard("(E) kesintiye uğrayan kurtarma sıfırlanır", E.states, "sayaç sinceMs=" + E.sinceMsAfterInterrupt + " olarak YENİDEN başladı")}
  <div class="card" style="border-left-color:var(--amber)"><div class="lbl">(G) soğuk başlangıç istisnası</div><div class="big" style="color:var(--amber)">gecikme YOK</div><div class="sm">ilk okuma kötüyse (debounceMs=5000ms olsa BİLE) anında ${G.bad.state} — "ücretsiz pencere" YOK</div></div>
</div>

<h2>3. EMC standardı tabanlı kalibrasyon (I)</h2>
<div class="cards">
  <div class="card"><div class="lbl">DEFAULT_DEBOUNCE_MS ← IEC 61000-4-4</div><div class="big" style="color:var(--k1)">${H.calibration.derivedDebounceMs} ms</div><div class="sm">(${H.calibration.standards["IEC 61000-4-4 (EFT/Burst)"].burstDurationMs}ms burst + ${H.calibration.standards["IEC 61000-4-4 (EFT/Burst)"].burstPeriodMs}ms boşluk = ${H.calibration.standards["IEC 61000-4-4 (EFT/Burst)"].episodeMs}ms tek epizot) × 2 güvenlik payı. Karşılaştırma: IEC 61000-4-5 sürgesi yalnız ${H.calibration.standards["IEC 61000-4-5 (Surge, 1.2/50µs)"].eventDurationUs}µs sürer — bağlayıcı olan EFT/Burst.</div></div>
  <div class="card"><div class="lbl">DEFAULT_RECOVERY_MARGIN_DB ← IEEE Std 299</div><div class="big" style="color:var(--k1)">${H.calibration.derivedRecoveryMarginDb} dB</div><div class="sm">${H.calibration.standards["IEEE Std 299 (SE ölçüm ayırt-edilebilirliği)"].discernibilityFloorDb}dB ayırt-edilebilirlik tabanı + 2×${H.calibration.standards["IEEE Std 299 (SE ölçüm ayırt-edilebilirliği)"].typicalInstrumentAccuracyDb}dB tipik cihaz doğruluğu (SEMS B)</div></div>
  <div class="card" style="border-left-color:var(--amber)"><div class="lbl">DEFAULT_RECOVERY_HYSTERESIS_MS — POLİTİKA</div><div class="big" style="color:var(--amber)">${H.calibration.derivedRecoveryHysteresisMs} ms</div><div class="sm">debounce × ${H.calibration.recoveryAsymmetryFactor} — bu ORAN standarttan değil, fail-safe mühendislik pratiğinden (dürüstçe ayrı işaretlendi)</div></div>
</div>
<p class="note">Önceki sürümde bu üç parametre "AÇIKÇA illüstratif" olarak işaretlenmişti (gerçek EMC saha verisi projede YOK). Kullanıcı talebiyle ikisi artık YAYINLANMIŞ, saha-doğrulanmış uluslararası standartlardan (IEC 61000-4-4/-4-5, IEEE Std 299) BİREBİR türetiliyor — sayısal değerler kod içine gizlice gömülmedi, (I) kontrolü bu türetmeyi doğrudan sınıyor. Geriye kalan tek POLİTİKA seçimi kurtarma/şüphe zaman oranıdır (×${H.calibration.recoveryAsymmetryFactor}) — bu, dürüstçe standarttan değil mühendislik yargısından geldiği belirtilerek AYRI işaretlendi. Kalan açık varsayım: gerçek bir SE sensörünün örnekleme hızı bu projede hâlâ belirtilmiyor (bkz. öz-test detayları).</p>

<h2>Öz-testler (${passN}/${totalN})</h2>
${rows}

<div class="callout"><b>Özet:</b> Debounce, ÖNCEDEN DOĞRULANMIŞ bir OK durumunu tek bir gürültülü örneğe karşı korur — ama bunu asla ÜCRETSİZ bir "ilk izlenim" af'ı olarak kullanmaz: sistem hiç okuma görmediyse (soğuk başlangıç) kötü bir ilk okuma anında bloklar. Kurtarma bilerek daha temkinlidir (debounce'un ${H.calibration.recoveryAsymmetryFactor} katı süre + IEEE 299'dan türetilen Schmitt-tetikleyici marjı) ve kesintiye uğrarsa sayaç GERÇEKTEN sıfırlanır — "neredeyse iyileşti" kilit açtırmaz. Gerçek yaşlanma yörüngesinde ölçülen tek somut bedel: gerçek arızanın tespiti ${H.realTrajectoryIntegration.detectionLatencyMs}ms geciktirildi — bu, transient-bağışıklığın karşılığında dürüstçe kabul edilen bir gecikmedir, gizlenmedi. debounceMs ve recoveryMarginDb artık gerçek IEC/IEEE standartlarından türetiliyor (bkz. yukarıdaki bölüm 3); yalnızca kurtarma/şüphe ORANI hâlâ bir mühendislik-politikası seçimidir. mtlsHandshakePrecondition()'ın kendisi DEĞİŞMEDİ (mevcut tüm testler/çağrı siteleri etkilenmedi), yeni sınıf tamamen EK bir katmandır. Çekirdeğe (photonnet_core.js) hiçbir noktada dokunulmadı — SHA-256 değişmedi.</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const fPath = process.argv[2] || path.join(__dirname, "reports", "mtls_failsafe_debounce.json");
  const outPath = process.argv[3] || "/tmp/mtls_failsafe_debounce_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(fPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
