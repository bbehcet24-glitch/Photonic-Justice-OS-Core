#!/usr/bin/env node
"use strict";
/**
 * state_poisoning_drill.js — DURUM ŞİŞİRMESİ / BELLEK SIZINTISI TATBİKATI
 *
 * SALDIRI (kurul senaryosu): geçersiz veri değil, kurallara %100 uyan,
 * doğrulamadan sorunsuz geçen ama otonom bellek katmanında sürekli yeni
 * geçmiş kaydı oluşturan mikro-istekler. Görünürde her şey sağlıklı;
 * arka planda durum matrisi kümülatif şişer, temizlik yetişemez, sistem
 * kendi iç kapasitesini tüketip kilitlenir.
 *
 * KRİTİK EŞİK SORUSU: sistem durum yükünü sıkıştırıp kararlı bir çizgide
 * tutabiliyor mu, yoksa bellek sızıntısına benzer kümülatif şişmeyle
 * kilitleniyor mu?
 *
 * Bu dosya TARTIŞMAZ, ÖLÇER. İki gerçek biriktirici saldırı yüzeyi var,
 * ikisi de bu tatbikat tarafından bulundu ve düzeltildi:
 *
 *   A) KeyAllocator geçmiş sızıntısı — çekirdeğin KeyDeliveryStore.byRoute
 *      dizisi her mevduatta bir kayıt ekler, tüketilen kaydı ASLA silmez.
 *      levelBits/fifo sıfıra dönse bile (sağlık düz görünür) geçmiş
 *      SINIRSIZ büyür → tam olarak tarif edilen sızıntı.
 *      Düzeltme (qkd_key_supply.js, katman): tüketimde en eski kaydı at.
 *
 *   B) KME dec_keys O(n) taraması — depo düz dizi olduğu için her dec
 *      findIndex+splice (O(n)) yapıyordu. Yarı-açık el sıkışmalarla depo
 *      büyüdükçe GEÇERLİ her dec'in maliyeti doğrusal artar → "anlamlı
 *      trafiğe ayrılan bant genişliği" erir.
 *      Düzeltme (etsi014_kme_server.js, katman): Map indeksi → O(1).
 *
 * Ölçülen metrikler (kurulun istediği): durum nesnesi büyümesi, işlem
 * başına maliyet (GC/CPU yükü vekili), ve anlamlı trafiğe kalan kapasite.
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi.
 */
const fs = require("fs");
const path = require("path");
const K = require("./qkd_key_supply.js");
const KME = require("./etsi014_kme_server.js");
const { mulberry32 } = require("./photonnet_core.js");

// En küçük kareler eğim/kesişim — durum büyümesinin doğrusal hızı.
function linfit(xs, ys) {
  const n = xs.length, sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, x) => a + x * x, 0), sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const d = n * sxx - sx * sx;
  const slope = d ? (n * sxy - sx * sy) / d : 0;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  // ══════════════════════════════════════════════════════════
  // A) OTONOM BELLEK KATMANI — GEÇMİŞ SIZINTISI
  // ══════════════════════════════════════════════════════════
  // Geçerli mikro-istek dizisi: her adımda küçük mevduat + eşit istek.
  // Arz = talep, yani envanter (levelBits) hep ~0 → sağlık göstergesi DÜZ.
  // Sızıntı VARSA yalnız geçmiş kaydında görünür.
  const N = 120000, CHUNK = 300, CAP = 200000, SNAP = 6000;
  const runFlood = (pruneHistory) => {
    const alloc = new K.KeyAllocator("A-B", { capacityBits: CAP, pruneHistory });
    const xs = [], live = [], heap = [];
    for (let i = 0; i < N; i++) {
      alloc.deposit(CHUNK, i, i);
      alloc.request(CHUNK, i);
      if (i % SNAP === 0) {
        xs.push(i); live.push(alloc._liveHistory());
        heap.push(+(process.memoryUsage().heapUsed / 1048576).toFixed(1));
      }
    }
    const s = alloc.stats();
    // Isınmadan sonraki (ikinci yarı) eğim — başlangıç geçişini dışla.
    const half = Math.floor(xs.length / 2);
    const fit = linfit(xs.slice(half), live.slice(half));
    return { xs, live, heap, stats: s, slopePerDeposit: +fit.slope.toFixed(5),
      finalLive: live[live.length - 1], finalHeapMB: heap[heap.length - 1], heap0MB: heap[0] };
  };
  const leak = runFlood(false);
  const fixed = runFlood(true);
  out.historyLeak = {
    depositsProcessed: N, chunkBits: CHUNK, capacityBits: CAP,
    leak: { slopePerDeposit: leak.slopePerDeposit, finalLiveEntries: leak.finalLive,
      heapGrowthMB: +(leak.finalHeapMB - leak.heap0MB).toFixed(1), keyIdsIssued: leak.stats.keyIdsIssued,
      finalLevelBits: leak.stats.finalLevelBits },
    fixed: { slopePerDeposit: fixed.slopePerDeposit, finalLiveEntries: fixed.finalLive,
      highWaterEntries: fixed.stats.historyHighWaterEntries,
      heapGrowthMB: +(fixed.finalHeapMB - fixed.heap0MB).toFixed(1), keyIdsIssued: fixed.stats.keyIdsIssued },
    series: { xs: leak.xs, leakLive: leak.live, fixedLive: fixed.live, leakHeap: leak.heap, fixedHeap: fixed.heap },
  };

  chk("SIZINTI YENİDEN ÜRETİLDİ: geçmiş kaydı doğrusal, SINIRSIZ büyüyor",
    leak.slopePerDeposit > 0.9 && leak.finalLive > N * 0.9,
    `düzeltmesiz: mevduat başına +${leak.slopePerDeposit} kayıt (≈1, yani hiç temizlenmiyor), ` +
    `${N} mevduatta ${leak.finalLive} canlı kayıt, heap +${(leak.finalHeapMB - leak.heap0MB).toFixed(1)} MB. ` +
    `Oysa envanter DÜZ: son levelBits ${leak.stats.finalLevelBits} — sağlık göstergesi hiç kıpırdamıyor`);

  chk("SAĞLIK GÖSTERGESİ YANILTIYOR: levelBits düz ama geçmiş şişiyor",
    leak.stats.finalLevelBits < CHUNK && leak.finalLive > 1000,
    `arz = talep olduğu için levelBits ~0 (son ${leak.stats.finalLevelBits} bit) — klasik doluluk/QBER ` +
    `göstergeleri temiz. Sızıntı yalnız kayıt SAYISINDA (${leak.finalLive}) görünüyor; ` +
    `bu yüzden saldırı "geçersiz veri" alarmına yakalanmaz`);

  chk("DÜZELTME: geçmiş kaydı SINIRLI — eğim ≈ 0, kararlı çizgi",
    fixed.slopePerDeposit < 0.01 && fixed.stats.historyHighWaterEntries < CAP / CHUNK + 5,
    `düzeltmeli: mevduat başına +${fixed.slopePerDeposit} kayıt (≈0), en yüksek canlı kayıt ` +
    `${fixed.stats.historyHighWaterEntries} (kapasite sınırı ≈ ${Math.ceil(CAP / CHUNK)}), ` +
    `heap +${(fixed.finalHeapMB - fixed.heap0MB).toFixed(1)} MB. Aynı ${N} mevduat, aynı iş — ` +
    `durum yükü SIKIŞTIRILDI, kilitlenme yok`);

  chk("DENETİM İZİ KORUNDU: monoton sayaç kalıyor, silinen bellek",
    leak.stats.keyIdsIssued === fixed.stats.keyIdsIssued,
    `üretilen key_ID sayısı iki modda da ${fixed.stats.keyIdsIssued} (denetim için gereken monoton ` +
    `SAYAÇ — bir tamsayı, bellek değil). Silinen şey tüketilmiş kayıtların NESNELERİ. ` +
    `Yani sızıntı kapatılırken denetlenebilirlik kaybedilmedi`);

  // ══════════════════════════════════════════════════════════
  // B) KME dec_keys — İŞLEM BAŞINA MALİYET (O(n) → O(1))
  // ══════════════════════════════════════════════════════════
  // Yarı-açık el sıkışma saldırısı: enc var, dec yok → depo büyür.
  // ESKİ tasarım düz diziydi; GEÇERLİ her dec findIndex+splice = O(n).
  // Eski algoritmayı BİREBİR yeniden kurup yeni Map yolu ile kıyaslıyoruz.
  const oldArrayDec = (arr, id) => {                   // eski takeForSlave çekirdeği
    const idx = arr.findIndex(e => e.key_ID === id);   // O(n)
    if (idx === -1) return false;
    arr[idx].issuedToSlave = true;
    const j = arr.findIndex(e => e.key_ID === id);     // ikinci tarama (eski kod)
    arr.splice(j, 1);                                  // O(n)
    return true;
  };
  const sizes = [1000, 5000, 20000, 60000];
  const REP = 1500;
  const scan = sizes.map(n => {
    // eski: düz dizi
    const arr = [];
    for (let i = 0; i < n; i++) arr.push({ key_ID: "id" + i, issuedToMaster: true, issuedToSlave: false });
    // en kötü hâl: her seferinde SON eklenen kaydı ara (dizi sonu)
    let t0 = process.hrtime.bigint();
    for (let r = 0; r < REP; r++) {
      const arr2 = arr.slice();                         // tazele (splice bozuyor)
      oldArrayDec(arr2, "id" + (n - 1));
    }
    const oldUs = Number(process.hrtime.bigint() - t0) / 1000 / REP;
    // yeni: Map
    const map = new Map();
    for (let i = 0; i < n; i++) map.set("id" + i, { key_ID: "id" + i, issuedToMaster: true, issuedToSlave: false });
    t0 = process.hrtime.bigint();
    for (let r = 0; r < REP; r++) {
      const e = map.get("id" + (n - 1)); e.issuedToSlave = true; // O(1)
      // silmeyi ölçüyoruz ama geri koyuyoruz ki depo boyutu sabit kalsın
      map.delete("id" + (n - 1)); map.set("id" + (n - 1), e);
    }
    const newUs = Number(process.hrtime.bigint() - t0) / 1000 / REP;
    return { n, oldUsPerDec: +oldUs.toFixed(2), newUsPerDec: +newUs.toFixed(3) };
  });
  out.kmeScan = { sizes, repetitions: REP, rows: scan };

  // Eski maliyet doğrusal mı? (O(n) → boyut 4×'te süre ~4×)
  const oldRatio = scan[scan.length - 1].oldUsPerDec / scan[0].oldUsPerDec;
  const sizeRatio = sizes[sizes.length - 1] / sizes[0];
  const newSpread = Math.max(...scan.map(s => s.newUsPerDec)) / Math.max(1e-6, Math.min(...scan.map(s => s.newUsPerDec)));
  chk("ESKİ KME dec maliyeti O(n): depo büyüdükçe GEÇERLİ istek yavaşlıyor",
    oldRatio > sizeRatio * 0.4,
    scan.map(s => `n=${s.n}: ${s.oldUsPerDec} μs`).join(" · ") +
    ` — depo ${sizeRatio}× büyüyünce dec ${oldRatio.toFixed(1)}× yavaşlıyor (doğrusal). ` +
    `Saldırgan O(1) enc gönderip sunucuya O(n) iş yaptırıyor`);
  chk("YENİ KME dec maliyeti O(1): depo boyutundan bağımsız (Map indeksi)",
    newSpread < 6 && scan[scan.length - 1].newUsPerDec < scan[scan.length - 1].oldUsPerDec / 10,
    scan.map(s => `n=${s.n}: ${s.newUsPerDec} μs`).join(" · ") +
    ` — en büyük/en küçük oranı ×${newSpread.toFixed(1)} (düz). En büyük depoda ` +
    `${scan[scan.length - 1].oldUsPerDec} μs → ${scan[scan.length - 1].newUsPerDec} μs ` +
    `(×${(scan[scan.length - 1].oldUsPerDec / scan[scan.length - 1].newUsPerDec).toFixed(0)} hızlanma)`);

  // ══════════════════════════════════════════════════════════
  // SINIRLI vs SINIRSIZ AYRIMI — hangisi gerçek tehditti?
  // ══════════════════════════════════════════════════════════
  // Yarı-açık el sıkışma kayıtları bellekte kalır AMA saldırgan yeni kayıt
  // ÜRETEMEZ — enc yalnız MEVCUT envanteri tüketir. Yani pin'lenen kayıt
  // envanterle SINIRLIDIR. Gerçekten sınırsız olan geçmiş sızıntısıydı.
  const s2 = new KME.KMEKeyStore();
  s2.seedDemo("A-B", 500, 256);
  let enc = 0;
  try { while (true) { s2.takeForMaster("A-B", 1, 256); enc++; } } catch (e) { /* 503 */ }
  const pinned = s2.routes["A-B"].size;
  out.boundedness = { seededInventory: 500, encBeforeExhaustion: enc, pinnedEntries: pinned,
    note: "yarı-açık pin envanterle sınırlı; sınırsız olan geçmiş sızıntısıydı (A)" };
  chk("YARI-AÇIK EL SIKIŞMA SINIRLI: saldırgan kayıt üretemez, yalnız tüketir",
    enc === 500 && pinned <= 500,
    `500 anahtarlık envanter → ${enc} enc sonra 503 (stok bitti), pin'lenen kayıt ${pinned} ≤ 500. ` +
    `Bu vektör envanterle SINIRLI. Kurulun tarif ettiği SINIRSIZ şişme (A) idi — bu değil. ` +
    `İki tehdidi ayırt etmek müdahaleyi doğru yere koymak için şart`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "state_poisoning.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  const H = out.historyLeak;
  console.log("\n══ DURUM ŞİŞİRMESİ TATBİKATI ══\n");
  console.log("  A) OTONOM BELLEK KATMANI — GEÇMİŞ KAYDI");
  console.log(`     düzeltmesiz: mevduat başına +${t(H.leak.slopePerDeposit, 3)} kayıt · ` +
    `${t(H.leak.finalLiveEntries)} canlı · heap +${t(H.leak.heapGrowthMB, 1)} MB · levelBits ${t(H.leak.finalLevelBits)}`);
  console.log(`     düzeltmeli : mevduat başına +${t(H.fixed.slopePerDeposit, 3)} kayıt · ` +
    `en yüksek ${t(H.fixed.highWaterEntries)} canlı · heap +${t(H.fixed.heapGrowthMB, 1)} MB`);
  console.log(`     denetim sayacı iki modda da ${t(H.fixed.keyIdsIssued)} (korundu)\n`);
  console.log("  B) KME dec_keys — İŞLEM BAŞINA MALİYET");
  console.log("       depo boyutu     eski μs/dec (O(n))   yeni μs/dec (O(1))");
  for (const r of out.kmeScan.rows)
    console.log(`     ${pad(t(r.n), 12)} ${pad(t(r.oldUsPerDec, 2), 18)} ${pad(t(r.newUsPerDec, 3), 20)}`);
  console.log(`\n  SINIRLILIK: yarı-açık pin ${t(out.boundedness.pinnedEntries)} ≤ envanter ${t(out.boundedness.seededInventory)} (sınırlı)`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "state_poisoning.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, linfit };
