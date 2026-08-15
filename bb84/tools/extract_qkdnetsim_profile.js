#!/usr/bin/env node
"use strict";
/**
 * extract_qkdnetsim_profile.js
 * ═══════════════════════════════════════════════════════════════════
 * QKDNetSim'in (Saraybosna Üni. + VSB Ostrava, ns-3.46 üzerinde,
 * /tmp içinde İZOLE tutulan) GERÇEK bir koşumundan, PhotonNet'in mTLS
 * köprü testlerinin (qkdnetsim_traffic_bridge.js, buffer_starvation_test.js)
 * kullandığı trafik profilini çıkarır.
 *
 * NEDEN AYRI/ARAÇ OLARAK REPODA: bu profil dosyası (bb84/qkdnetsim_traffic_profile.json)
 * daha önce bir kez üretilip commit edilmişti, ama onu ÜRETEN kod yalnızca
 * geçici bir /tmp script'iydi. Konteyner sıfırlanınca profil kaybolunca
 * yeniden üretilebilirliğinin OLMADIĞI ortaya çıktı. Artık üretici kod da
 * repoda — QKDNetSim yeniden derlenip koşulduğunda profil TEK KOMUTLA
 * yeniden üretilebilir.
 *
 * İKİ FARKLI METRİĞİN AÇIKÇA ETİKETLENMİŞ BİRLEŞİMİ (dürüstlük gereği):
 *   - EĞRİNİN ŞEKLİ (zaman içinde yoğunluk deseni, patlamaların ne zaman
 *     olduğu) → "QKD Total Graph_data.dat" dosyasından. Bu, KMS genelindeki
 *     KÜMÜLATİF HAM ANAHTAR-MALZEMESİ üretim eğrisidir (QKD/fizik katmanı).
 *   - OLAY SAYISI (kaç anahtar teslim edildi) → aynı koşumun log'undaki
 *     GERÇEK "Served (bits):" satır sayısından. Bu, UYGULAMA katmanına
 *     ETSI-014 ile fiilen teslim edilen anahtar sayısıdır.
 * Bu ikisi FARKLI metriklerdir ve karıştırılmamalıdır — burada bilinçli
 * olarak birleştirilirler (şekil birinden, ölçek diğerinden) ve bu durum
 * üretilen JSON'un `methodologyNote` alanında da açıkça yazılır.
 *
 * KULLANIM:
 *   node bb84/tools/extract_qkdnetsim_profile.js \
 *     [--dat="/tmp/qkdnetsim_build/ns-3-dev/QKD Total Graph_data.dat"] \
 *     [--log=/tmp/qkd_etsi014_full.log] \
 *     [--out=bb84/qkdnetsim_traffic_profile.json] [--bins=50] [--sim-duration=500]
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) out[m[1]] = m[2] ?? true; }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const DAT_PATH = args.dat || "/tmp/qkdnetsim_build/ns-3-dev/QKD Total Graph_data.dat";
const LOG_PATH = args.log || "/tmp/qkd_etsi014_full.log";
const OUT_PATH = args.out || path.join(__dirname, "..", "qkdnetsim_traffic_profile.json");
const N_BINS = args.bins ? parseInt(args.bins, 10) : 50;
const SIM_DURATION_S = args["sim-duration"] ? Number(args["sim-duration"]) : 500;

for (const [label, p] of [["--dat", DAT_PATH], ["--log", LOG_PATH]]) {
  if (!fs.existsSync(p)) {
    console.error(`HATA: ${label} dosyası bulunamadı: ${p}`);
    console.error("QKDNetSim'i önce derleyip çalıştırmanız gerekir (bkz. bb84/tools/QKDNETSIM_BUILD.md).");
    process.exit(2);
  }
}

// ── 1) Eğrinin ŞEKLİ: kümülatif ham anahtar-malzemesi üretim eğrisi ──
const points = fs.readFileSync(DAT_PATH, "utf-8").trim().split("\n")
  .map(l => { const [t, b] = l.trim().split(/\s+/).map(Number); return { t, b }; })
  .filter(p => Number.isFinite(p.t) && Number.isFinite(p.b));

// ── 2) Olay SAYISI: uygulama katmanına fiilen teslim edilen anahtarlar ──
const logText = fs.readFileSync(LOG_PATH, "utf-8");
const sizes = [...logText.matchAll(/Served \(bits\):\s*(\d+)/g)].map(m => Number(m[1]));
const totalKeyEvents = sizes.length;
if (totalKeyEvents === 0) {
  console.error(`HATA: ${LOG_PATH} içinde hiç "Served (bits):" satırı bulunamadı — koşum başarısız olmuş olabilir.`);
  process.exit(2);
}
const totalServedBits = sizes.reduce((a, b) => a + b, 0);
const avgKeySizeBits = totalServedBits / totalKeyEvents;

// ── 3) Zaman dilimlerine (bin) böl: her bin'deki kümülatif TEPE değeri ──
const binWidth = SIM_DURATION_S / N_BINS;
const binMax = new Array(N_BINS + 1).fill(0);
for (const p of points) {
  const idx = Math.min(N_BINS, Math.floor(p.t / binWidth));
  if (p.b > binMax[idx]) binMax[idx] = p.b;
}
// Kümülatif eğri monoton artan olmalı — boş/artmamış binleri öncekiyle doldur.
for (let i = 1; i <= N_BINS; i++) binMax[i] = Math.max(binMax[i], binMax[i - 1]);

// Bin-başı artış (şekil) → normalize → gerçek toplam olay sayısına ölçekle.
const deltas = [];
for (let i = 1; i <= N_BINS; i++) deltas.push(Math.max(0, binMax[i] - binMax[i - 1]));
const deltaSum = deltas.reduce((a, b) => a + b, 0);

let assigned = 0;
const bins = deltas.map((d, i) => {
  const frac = deltaSum > 0 ? d / deltaSum : 1 / N_BINS;
  const keyEvents = Math.round(frac * totalKeyEvents);
  assigned += keyEvents;
  return { tStart: +(i * binWidth).toFixed(3), tEnd: +((i + 1) * binWidth).toFixed(3), rawBitDelta: d, keyEvents };
});
// Yuvarlama farkını EN YOĞUN bin'e ekle — toplam TAM OLARAK totalKeyEvents olsun.
let maxIdx = 0;
for (let i = 1; i < bins.length; i++) if (bins[i].keyEvents > bins[maxIdx].keyEvents) maxIdx = i;
bins[maxIdx].keyEvents += (totalKeyEvents - assigned);

const out = {
  methodologyNote: "ŞEKİL 'QKD Total Graph_data.dat' (KMS-genelinde kümülatif ham anahtar-malzemesi büyüme eğrisi, ns-3.46 + QKDNetSim gerçek koşumu) kaynaklıdır; bu, uygulama katmanına (ETSI-014 enc_keys/dec_keys ile) TESLİM EDİLEN anahtarlardan FARKLI bir metriktir (KMS iç arabellek/QKD-katmanı üretimi). OLAY SAYISI ise, aynı koşumun log'undaki GERÇEK 'Served (bits)' satır sayısına (uygulama katmanına fiilen teslim edilen anahtar sayısı) göre normalize edilmiştir. Yani: eğrinin ŞEKLİ (yoğunluk deseni, ne zaman patlama olduğu) gerçek fizik-katmanı verisinden, olay SAYISI ise gerçek uygulama-katmanı teslim verisinden geliyor — ikisi karıştırılmadan, açıkça etiketlenerek birleştirildi.",
  sourceFiles: { dat: DAT_PATH, log: LOG_PATH },
  regeneratedBy: "bb84/tools/extract_qkdnetsim_profile.js",
  simDurationS: SIM_DURATION_S,
  nBins: N_BINS,
  totalKeyEvents,
  avgKeySizeBits: +avgKeySizeBits.toFixed(2),
  totalServedBits,
  bins,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

const sumCheck = bins.reduce((a, b) => a + b.keyEvents, 0);
console.log(`Profil yazıldı: ${OUT_PATH}`);
console.log(`  toplam olay: ${totalKeyEvents} (bin toplamı doğrulama: ${sumCheck} — ${sumCheck === totalKeyEvents ? "EŞLEŞTİ" : "UYUŞMAZLIK!"})`);
console.log(`  ortalama anahtar boyutu: ${avgKeySizeBits.toFixed(2)} bit, toplam ${totalServedBits} bit`);
console.log(`  ${N_BINS} zaman dilimi, ${SIM_DURATION_S}s simüle süre, kaynak eğri ${points.length} nokta`);
if (sumCheck !== totalKeyEvents) process.exit(1);
