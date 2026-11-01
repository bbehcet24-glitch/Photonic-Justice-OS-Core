#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * build_reports_snapshot.js — bb84/reports/*.json özetini (ve varsa son npm test koşusunun sonucunu,
 * ci-reports/npm_test_summary.json) PhotonNet.html'in 📈 SONUÇLAR sekmesinin okuduğu
 * bb84/reports/reports_snapshot.js dosyasına yazar.
 *
 * Her rapor kendi yapısında: checks[] / results[].verdict (PASS|FAIL) / overallPass / stillBrokenCount /
 * failures; hiçbiri yoksa "veri" (hüküm yok) olarak işaretlenir — hüküm uydurulmaz. Ayrıntı metinleri 220
 * karakterde kesilir. npm test (bb84/tools/run_all_tests.js) bu betiği sonunda otomatik çalıştırır.
 *
 * Kullanım: node bb84/tools/build_reports_snapshot.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REPORTS_DIR = path.join(REPO_ROOT, "bb84", "reports");
const OUT = path.join(REPORTS_DIR, "reports_snapshot.js");
const NPM_SUMMARY = path.join(REPO_ROOT, "ci-reports", "npm_test_summary.json");

function summarizeReport(file, d) {
  const cut = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, 220);
  const iso = d && typeof d.generatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(d.generatedAt) ? d.generatedAt : null;
  const base = { f: file.replace(/\.json$/, ""), t: iso };   // tarih olmayan generatedAt değerleri gösterilmez
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ...base, kind: "data", pass: null, checks: [] };
  if (Array.isArray(d.checks)) {
    const checks = d.checks.map((c) => ({ n: cut(c.name), ok: c.ok === true, d: cut(c.detail) }));
    return { ...base, kind: "checks", pass: checks.length > 0 && checks.every((c) => c.ok), checks };
  }
  if (typeof d.stillBrokenCount === "number") return { ...base, kind: "overall", pass: d.stillBrokenCount === 0, checks: [], note: `kalan bozuk: ${d.stillBrokenCount}` };
  if (Array.isArray(d.results) && d.results.length && d.results.every((r) => r && (r.verdict === "PASS" || r.verdict === "FAIL"))) {
    const checks = d.results.map((r) => ({ n: cut(`${r.id || ""} ${r.title || ""}`.trim()), ok: r.verdict === "PASS", d: cut(r.summary) }));
    return { ...base, kind: "checks", pass: checks.every((c) => c.ok), checks };
  }
  if (typeof d.overallPass === "boolean") {
    const checks = d.tests && typeof d.tests === "object"
      ? Object.entries(d.tests).map(([k, v]) => ({ n: cut(k), ok: !!(v && v.pass), d: "" }))
      : [];
    const nf = Array.isArray(d.findings) ? d.findings.length : 0;
    return { ...base, kind: "overall", pass: d.overallPass, checks, findings: nf };
  }
  if (typeof d.failures === "number" || Array.isArray(d.failures)) {
    const nf = Array.isArray(d.failures) ? d.failures.length : d.failures;
    return { ...base, kind: "overall", pass: nf === 0, checks: [], note: `başarısızlık: ${nf}` };
  }
  const nf = Array.isArray(d.findings) ? d.findings.length : null;
  return { ...base, kind: nf ? "findings" : "data", pass: null, checks: [], findings: nf || 0,
    sample: nf ? d.findings.slice(0, 5).map(cut) : [] };
}

function buildSnapshot() {
  const files = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  const reports = files.map((f) => {
    try { return summarizeReport(f, JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf-8"))); }
    catch (e) { return { f: f.replace(/\.json$/, ""), t: null, kind: "data", pass: null, checks: [], note: "ayrıştırılamadı" }; }
  });
  const latest = reports.map((r) => r.t).filter(Boolean).sort().pop() || null;
  let npmTest = null;
  try {
    const s = JSON.parse(fs.readFileSync(NPM_SUMMARY, "utf-8"));
    npmTest = { at: s.generatedAt, passed: s.passed, total: s.total,
      results: (s.results || []).map((r) => ({ n: r.name, ok: !!r.ok, ms: r.ms })) };
  } catch (_) { /* yerel koşu yok: sekme yalnız raporları gösterir */ }
  return { builtAt: new Date().toISOString(), latest, reports, npmTest };
}

function writeSnapshot() {
  const snap = buildSnapshot();
  const json = JSON.stringify(snap).replace(/</g, "\\u003c");
  fs.writeFileSync(OUT, `/* OTOMATİK ÜRETİLDİ — bb84/tools/build_reports_snapshot.js (${snap.reports.length} rapor). ELLE DÜZENLEMEYİN. */\n` +
    `window.__PHOTONNET_REPORTS__ = ${json};\n`);
  return snap;
}

module.exports = { summarizeReport, buildSnapshot, writeSnapshot };

if (require.main === module) {
  const snap = writeSnapshot();
  const v = snap.reports.filter((r) => r.pass !== null);
  console.log(`[build_reports_snapshot] ✓ ${path.relative(REPO_ROOT, OUT)}: ${snap.reports.length} rapor (${v.filter((r) => r.pass).length}/${v.length} hükümlü rapor geçti)` +
    (snap.npmTest ? `, son npm test ${snap.npmTest.passed}/${snap.npmTest.total} (${snap.npmTest.at})` : ", npm test özeti yok"));
}
