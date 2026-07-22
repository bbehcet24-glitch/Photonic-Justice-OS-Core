#!/usr/bin/env node
"use strict";
// YEDEKLİ ÇOKLU YOL / DISJOINT ROUTING doğrulaması (bkz. PhotonNet2.jsx'teki
// routeCalculationResilient/NetworkTopology.disjointPaths başlık notu) —
// kullanıcının "Yedekli Çoklu Yol (Multi-Path/Disjoint Routing)" isteğine
// karşılık gelen üçüncü sertleştirme mekanizması. Sentetik, küçük bir
// topolojide GERÇEK routeCalculationResilient() çağrılarıyla doğrular.
const core = require("./photonnet_core.js");
const { routeCalculation, routeCalculationResilient, routeIsSuspect, DOS_SUSPECT_RISK_THRESHOLD, NetworkTopology } = core;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const getNode = () => null; // koordinat yok — geoKm hesaplaması lk.km'ye düşer, testi etkilemez

console.log("=== 1) İKİ TAMAMEN BAĞIMSIZ (kenar-ayrık) KORİDOR: risk YOKKEN normal en-ucuz rota seçiliyor mu? ===");
{
  // Koridor 1 (A-B1-C1-D, 3×5km) AÇIKÇA daha ucuz — Koridor 2 (A-B2-C2-D, 3×8km).
  const nodes = ["A", "B1", "C1", "B2", "C2", "D"].map(id => ({ id, on: true }));
  const links = [
    { a: "A", b: "B1", km: 5, nm: 1550 }, { a: "B1", b: "C1", km: 5, nm: 1550 }, { a: "C1", b: "D", km: 5, nm: 1550 },
    { a: "A", b: "B2", km: 8, nm: 1550 }, { a: "B2", b: "C2", km: 8, nm: 1550 }, { a: "C2", b: "D", km: 8, nm: 1550 },
  ];
  const r = routeCalculationResilient(nodes, links, "A", "D", {}, getNode, {}, {}, {});
  check("risk verisi yokken normal (birincil, en-ucuz) rota dönüyor", r && !r.usedDisjointBackup && !r.primarySuspect);
  check("seçilen rota gerçekten Koridor 1 (ucuz olan)", r.route.segs.every(lk => lk.km === 5), JSON.stringify(r.route.segs.map(l=>`${l.a}-${l.b}`)));
}

console.log("\n=== 2) BİRİNCİL KORİDOR 'ucuz kalmaya devam etse BİLE' doğrulanmış yüksek risk içeriyorsa trafik BAĞIMSIZ yedeğe kayıyor mu? ===");
{
  const nodes = ["A", "B1", "C1", "B2", "C2", "D"].map(id => ({ id, on: true }));
  const links = [
    { a: "A", b: "B1", km: 5, nm: 1550 }, { a: "B1", b: "C1", km: 5, nm: 1550 }, { a: "C1", b: "D", km: 5, nm: 1550 },
    { a: "A", b: "B2", km: 8, nm: 1550 }, { a: "B2", b: "C2", km: 8, nm: 1550 }, { a: "C2", b: "D", km: 8, nm: 1550 },
  ];
  const measuredRisk = { "B1-C1": 1.0 }; // Koridor 1'in ORTA segmenti doğrulanmış ÇOK yüksek risk taşıyor
  // Önce ŞUNU kanıtlayalım: risk çarpanı (measuredRiskFactor=0.4 varsayılan)
  // TEK BAŞINA Koridor 1'i Koridor 2'den PAHALI hale GETİRMİYOR (yani sıradan
  // Dijkstra-maliyet-artışı BUNU çözemezdi, resilient sarmalayıcı GERÇEKTEN gerekli).
  const plainRoute = routeCalculation(nodes, links, "A", "D", {}, getNode, {}, {}, measuredRisk);
  check("[ön-koşul] sıradan routeCalculation (resilient OLMADAN) hâlâ riskli Koridor 1'i seçiyor (maliyet farkı riski YUTUYOR)",
    plainRoute.segs.some(lk => lk.a === "B1" && lk.b === "C1"), JSON.stringify(plainRoute.segs.map(l=>`${l.a}-${l.b}`)));

  const r = routeCalculationResilient(nodes, links, "A", "D", {}, getNode, {}, {}, measuredRisk);
  check("resilient sarmalayıcı birincili 'şüpheli' olarak işaretliyor", r.primarySuspect === true);
  check("bağımsız (kenar-ayrık) bir yedek BULUNDU ve KULLANILDI", r.usedDisjointBackup === true && r.backupAvailable === true);
  check("kullanılan rota artık B1-C1'i İÇERMİYOR (fiziksel olarak tamamen farklı koridora kaydı)",
    !r.route.segs.some(lk => (lk.a === "B1" && lk.b === "C1") || (lk.a === "C1" && lk.b === "B1")), JSON.stringify(r.route.segs.map(l=>`${l.a}-${l.b}`)));
  check("kullanılan rota gerçekten Koridor 2 (A-B2-C2-D)", r.route.segs.every(lk => lk.km === 8));
  check("nihai rota artık 'şüpheli' değil (yedek risk taşımıyor)", routeIsSuspect(r.route, measuredRisk) === false);
}

console.log("\n=== 3) BAĞIMSIZ YEDEK YOKSA (dar boğaz/tek koridor): sistem DÜRÜSTÇE birincilde kalıyor mu (sahte yol UYDURMUYOR mu)? ===");
{
  const nodes = ["A", "X", "D"].map(id => ({ id, on: true }));
  const links = [{ a: "A", b: "X", km: 10, nm: 1550 }, { a: "X", b: "D", km: 10, nm: 1550 }]; // TEK yol, dallanma yok
  const measuredRisk = { "A-X": 1.0 }; // doğrulanmış yüksek risk, ama kaçacak İKİNCİ bir koridor YOK
  const r = routeCalculationResilient(nodes, links, "A", "D", {}, getNode, {}, {}, measuredRisk);
  check("birincil 'şüpheli' olarak DOĞRU işaretleniyor", r.primarySuspect === true);
  check("bağımsız yedek YOK olarak DOĞRU raporlanıyor (topoloji buna izin vermiyor)", r.backupAvailable === false && r.usedDisjointBackup === false);
  check("YİNE DE bir rota DÖNÜYOR (dürüstçe birincilde kalınıyor — 'yedek yok' diye teslimat tamamen İPTAL edilmiyor)",
    r.route && r.route.segs.length === 2);
}

console.log("\n=== 4) NetworkTopology.disjointPaths — K=2 istenirse, İKİ path de birbirinden TAMAMEN ayrık mı (ortak kenar YOK)? ===");
{
  const topo = new NetworkTopology(
    ["A", "B1", "C1", "B2", "C2", "D"].map(id => ({ id })),
    [
      { a: "A", b: "B1", km: 5, nm: 1550 }, { a: "B1", b: "C1", km: 5, nm: 1550 }, { a: "C1", b: "D", km: 5, nm: 1550 },
      { a: "A", b: "B2", km: 8, nm: 1550 }, { a: "B2", b: "C2", km: 8, nm: 1550 }, { a: "C2", b: "D", km: 8, nm: 1550 },
    ]
  );
  const paths = topo.disjointPaths("A", "D", () => true, {}, undefined, 2);
  check("İKİ yol da bulundu", paths.length === 2, `bulunan=${paths.length}`);
  const keySet = (p) => new Set(p.filter(s => s.link).map(s => NetworkTopology.linkKey(s.link)));
  const k1 = keySet(paths[0]), k2 = keySet(paths[1]);
  const overlap = [...k1].filter(k => k2.has(k));
  check("iki yol arasında HİÇBİR ortak kenar YOK (gerçek edge-disjoint)", overlap.length === 0, `ortak=${JSON.stringify(overlap)}`);

  console.log("\n=== 5) NetworkTopology.disjointPaths — topoloji K=3 sunmuyorsa, dizide DÜRÜSTÇE 2 eleman dönüyor (3 UYDURULMUYOR) mu? ===");
  const paths3 = topo.disjointPaths("A", "D", () => true, {}, undefined, 3);
  check("K=3 istense de gerçek topoloji yalnızca 2 bağımsız yol sunuyor, dizi 2 elemanlı (sahte 3. yol yok)", paths3.length === 2, `bulunan=${paths3.length}`);
}

console.log(`\n════════════════════════════════════════`);
console.log(`SONUÇ: ${pass} geçti, ${fail} başarısız (${pass + fail} test)  [DOS_SUSPECT_RISK_THRESHOLD=${DOS_SUSPECT_RISK_THRESHOLD}]`);
console.log(`════════════════════════════════════════`);
process.exit(fail > 0 ? 1 : 0);
