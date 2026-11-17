#!/usr/bin/env node
"use strict";
/**
 * protocol_fingerprint_test.js — protokol parmak izi (hakem bulgusu P1-2)
 * ═══════════════════════════════════════════════════════════════════
 *   F1 bb84/docs/protocol_fingerprint.json güncel (kayıtlı = hesaplanan)
 *   F2 Yalnız arayüz metni değişen bir çekirdek kopyası: dosya SHA-256'sı DEĞİŞİR, protokol parmak izi DEĞİŞMEZ
 *   F3 Fizik sabiti değişen bir kopya (e_d 0,015 → 0,016): parmak izi DEĞİŞİR
 *   F4 Parmak izi CORE_CHANGELOG.md'de kayıtlı
 *   F5 CORE_CHANGELOG.md'deki sürüm ↔ commit tablosu: her commit için dosya SHA-256'sı ve parmak izi git geçmişinden
 *      yeniden hesaplanıp tabloyla karşılaştırılır; commit'i olmayan (güncel) satır çalışma ağacındaki çekirdekle.
 *      Sığ klonda (CI fetch-depth 1) bulunmayan commit'ler 'erişilemedi' olarak sayılır, kaldı sayılmaz.
 * Kopyalar bb84/ altında geçici dosya olarak oluşturulur (config.json aynı yoldan okunsun) ve silinir.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { compute } = require("./tools/protocol_fingerprint.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const CORE = path.join(__dirname, "photonnet_core.js");
const fileSha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function fingerprintOf(file) {
  const core = require(file);
  const names = Object.keys(core).sort();
  const h = crypto.createHash("sha256");
  const rep = (_k, v) => (typeof v === "function" ? `fn:${v.toString()}` : v instanceof Map ? { map: [...v.entries()] } : v instanceof Set ? { set: [...v] } : v);
  for (const n of names) {
    const v = core[n]; let t;
    if (typeof v === "function") t = v.toString();
    else if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && !(v instanceof Map) && !(v instanceof Set)) continue;
    else { try { t = JSON.stringify(v, rep); } catch (_) { continue; } }
    h.update(`${n}\u0000${t}\u0000`);
  }
  return h.digest("hex");
}

const stored = JSON.parse(fs.readFileSync(path.join(__dirname, "docs", "protocol_fingerprint.json"), "utf8"));
const now = compute();
chk("F1 Kayıtlı protokol parmak izi güncel", stored.sha256 === now.sha256, `${now.sha256.slice(0, 16)}… (${now.symbols} sembol; atlanan sınıf örnekleri: ${now.skipped.length})`);

const src = fs.readFileSync(CORE, "utf8");
const UI_FROM = "CFAR α = 10⁻³", PHYS_FROM = "const QKD_MISALIGNMENT_E_D = 0.015;";
const tmpUi = path.join(__dirname, "_fp_test_ui.js"), tmpPh = path.join(__dirname, "_fp_test_phys.js");
try {
  if (!src.includes(UI_FROM) || !src.includes(PHYS_FROM)) throw new Error("örnek metinler çekirdekte bulunamadı");
  fs.writeFileSync(tmpUi, src.replace(UI_FROM, "CFAR alfa = 10⁻³"));
  fs.writeFileSync(tmpPh, src.replace(PHYS_FROM, "const QKD_MISALIGNMENT_E_D = 0.016;"));
  const base = fingerprintOf(CORE), ui = fingerprintOf(tmpUi), ph = fingerprintOf(tmpPh);
  chk("F2 Yalnız arayüz metni değişince dosya hash'i değişiyor, protokol parmak izi değişmiyor",
    fileSha(tmpUi) !== fileSha(CORE) && ui === base && base === now.sha256,
    `dosya ${fileSha(CORE).slice(0, 12)} → ${fileSha(tmpUi).slice(0, 12)}; parmak izi ${base.slice(0, 12)} → ${ui.slice(0, 12)}`);
  chk("F3 Fizik sabiti (e_d) değişince protokol parmak izi değişiyor", ph !== base, `${base.slice(0, 12)} → ${ph.slice(0, 12)}`);
} catch (e) {
  chk("F2/F3 kopya denemesi", false, String(e.message || e));
} finally {
  for (const f of [tmpUi, tmpPh]) try { fs.unlinkSync(f); } catch (_) { /* yok */ }
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
{
  const { execFileSync } = require("child_process");
  const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;
  const rows = [...changelog.matchAll(/^\| (v[\d.]+) \| ([0-9a-f]{7,40}|[^|]*?) \| [\d-]+ \| `([0-9a-f]{8}…[0-9a-f]{6})` \| `([0-9a-f]{8}…[0-9a-f]{6})` \|/gm)];
  const bad = [], unavailable = [];
  let checked = 0;
  for (const [, ver, commit, fileShort, fpShort] of rows) {
    let file = CORE, tmp = null;
    if (/^[0-9a-f]{7,40}$/.test(commit)) {
      let buf;
      try { buf = execFileSync("git", ["-C", path.join(__dirname, ".."), "show", `${commit}:bb84/photonnet_core.js`], { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }); }
      catch (_) { unavailable.push(`${ver} ${commit}`); continue; }
      tmp = path.join(__dirname, `_fp_test_hist_${commit}.js`); fs.writeFileSync(tmp, buf); file = tmp;
    }
    try {
      const fsh = short(fileSha(file)), fph = short(fingerprintOf(file));
      checked++;
      if (fsh !== fileShort || fph !== fpShort) bad.push(`${ver} ${commit}: dosya ${fsh} (tablo ${fileShort}), parmak izi ${fph} (tablo ${fpShort})`);
    } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (_) { /* yok */ } }
  }
  chk("F5 Sürüm ↔ commit tablosu git geçmişiyle tutarlı (dosya hash'i ve protokol parmak izi)",
    rows.length > 0 && bad.length === 0 && checked > 0,
    `${rows.length} satır, ${checked} denetlendi${unavailable.length ? `, ${unavailable.length} commit erişilemedi (sığ klon): ${unavailable.join(", ")}` : ""}${bad.length ? ` — UYUŞMAYAN: ${bad.join("; ")}` : ""}`);
}
chk("F4 Protokol parmak izi CORE_CHANGELOG.md'de kayıtlı", changelog.includes(now.sha256), now.sha256.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.writeFileSync(path.join(__dirname, "reports", "protocol_fingerprint.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
