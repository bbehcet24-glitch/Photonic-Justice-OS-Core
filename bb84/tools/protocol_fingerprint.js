#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * protocol_fingerprint.js — protokol parmak izi (hakem bulgusu P1-2).
 *
 * bb84/photonnet_core.js PhotonNet2.jsx'ten çıkarılır ve dışa aktarılmayan arayüz bileşenlerini de içerir; dosyanın
 * SHA-256'sı bu yüzden yalnız arayüz değişikliğinde de değişir. Protokol parmak izi yalnız DIŞA AKTARILAN sembollerin
 * (EXPORT_MANIFEST: algoritma sınıfları, fonksiyonlar, sabitler) kaynağından hesaplanır:
 *   fonksiyon/sınıf → Function.prototype.toString(); düz veri → JSON; sınıf örnekleri (çalışma anı durumu) ve döngüsel
 *   yapılar atlanır ve listelenir — örneklerin davranışı sınıflarının kaynağıyla girer.
 * Arayüz bileşenleri dışa aktarılmadığı için parmak izine girmez.
 *
 * Kullanım:  node bb84/tools/protocol_fingerprint.js          → bb84/docs/protocol_fingerprint.json yazar
 *            node bb84/tools/protocol_fingerprint.js --check  → dosya güncel değilse çıkış 1 (npm test bunu koşturur)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "bb84", "docs", "protocol_fingerprint.json");

function compute() {
  const core = require(path.join(ROOT, "bb84", "photonnet_core.js"));
  const names = Object.keys(core).sort();
  const h = crypto.createHash("sha256"), skipped = [];
  const replacer = (_k, v) => (typeof v === "function" ? `fn:${v.toString()}` : v instanceof Map ? { map: [...v.entries()] } : v instanceof Set ? { set: [...v] } : v);
  for (const name of names) {
    const v = core[name];
    let text;
    if (typeof v === "function") text = v.toString();
    else if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && !(v instanceof Map) && !(v instanceof Set)) {
      // sınıf örneği (ör. noiseGateMiddleware, keyDeliveryStore): çalışma anı DURUMU taşır ve yapılandırmaya göre değişir;
      // davranışı sınıfının kaynağıyla zaten parmak izine girer
      skipped.push(name); continue;
    } else { try { text = JSON.stringify(v, replacer); } catch (_) { skipped.push(name); continue; } }
    h.update(`${name}\u0000${text}\u0000`);
  }
  return { sha256: h.digest("hex"), symbols: names.length - skipped.length, skipped };
}

if (require.main === module) {
  const fp = compute();
  if (process.argv.includes("--check")) {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) { /* yok */ }
    const ok = cur && cur.sha256 === fp.sha256;
    console.log(ok ? `[protocol_fingerprint] ✓ güncel: ${fp.sha256.slice(0, 8)}…${fp.sha256.slice(-6)} (${fp.symbols} sembol)`
      : `[protocol_fingerprint] ✗ bb84/docs/protocol_fingerprint.json güncel değil: kayıtlı ${cur ? cur.sha256.slice(0, 12) : "yok"}, hesaplanan ${fp.sha256.slice(0, 12)} — node bb84/tools/protocol_fingerprint.js`);
    process.exit(ok ? 0 : 1);
  }
  fs.writeFileSync(OUT, JSON.stringify({ sha256: fp.sha256, symbols: fp.symbols, skipped: fp.skipped,
    note: "SHA-256 over the source of the symbols exported by bb84/photonnet_core.js (functions/classes by source text, data as JSON). UI components are not exported and do not enter it." }, null, 2) + "\n");
  console.log(`[protocol_fingerprint] yazıldı: ${fp.sha256} (${fp.symbols} sembol${fp.skipped.length ? `, atlanan: ${fp.skipped.join(", ")}` : ""})`);
}
module.exports = { compute };
