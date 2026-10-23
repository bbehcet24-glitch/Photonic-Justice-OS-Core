#!/usr/bin/env node
"use strict";
/**
 * kme_half_open_gate_test.js — multinode_shielding_testbed L8 kararsızlığının DETERMİNİSTİK yeniden üretimi
 * ═══════════════════════════════════════════════════════════════════
 * Kök neden (bkz. docs/L8_FLAKE_ANALYSIS.md): ETSI-014 iki adımlıdır (master enc_keys → slave dec_keys).
 * Kalkan kapısı iki çağrının ARASINDA kapanırsa enc 200 döner, dec 503 döner → master'da "yarı-açık" anahtar.
 * Canlı testte bu, kapı geçişinin birkaç ms'lik enc→dec penceresine denk gelmesine bağlıydı (36 koşuda 1).
 * Burada kapı, iki çağrının arasında BİLEREK çevrilir — her koşuda aynı sonuç.
 *
 *   H1 enc_keys 200 → kapı slave için kapanır → dec_keys 503 (kalkan kapısı) — yarış penceresi zorlandı
 *   H2 Yarı-açık anahtarlar başka bir enc_keys'te TEKRAR verilmez (çift teslim yok), depo sayacı doğru
 *   H3 Kapı yeniden açılınca ERTELENMİŞ dec_keys aynı key_ID'lerle 200 döner ve baytlar gelen kutusuna
 *      enjekte edilenle birebir aynı (anahtar kaybolmaz, ETSI-014 akışı tamamlanır)
 *   H4 Aynı key_ID'lerle ikinci dec_keys → 400 (replay reddedilir; tamamlanan anahtar silinmiştir)
 *   H5 Düzeltilmiş L8 sınıflandırıcısı (key_provenance_audit.classifyL8): kanıtla eşleşen red (slave-kapalı, master-bayat,
 *      taşıma) + ertelenmiş tamamlama → GEÇER; kanıtsız red, uyumsuz bayt, sızıntılı köken, tekrar, kayıtsız anahtar,
 *      hiç tamamlanmayan yarı-açık → KALIR
 *   H6 Eski L8 kuralı canlı kayıtta yanlış alarm veriyordu
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const LIB = require("./etsi014_client_lib.js");
const { classifyL8 } = require("./key_provenance_audit.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, argv) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const writeAtomic = (fp, obj) => { const t = `${fp}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, fp); };

async function liveHalfOpen() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photonnet-halfopen-"));
  const pki = path.join(root, "pki"), reqs = path.join(pki, "reqs"), tools = path.join(__dirname, "pki_tools");
  let proc = null, gateTimer = null;
  try {
    sh("bash", [path.join(tools, "ca_init.sh"), pki]);
    sh("bash", [path.join(tools, "issue_cert.sh"), reqs, "server", "localhost"]);
    sh("bash", [path.join(tools, "sign_csr.sh"), pki, path.join(reqs, "localhost.csr"), "server", "1"]);
    const certs = {};
    for (const id of ["MSL", "KDK"]) {
      sh("bash", [path.join(tools, "issue_cert.sh"), reqs, "client", `SAE-${id}`]);
      sh("bash", [path.join(tools, "sign_csr.sh"), pki, path.join(reqs, `SAE-${id}.csr`), "client", "1"]);
      certs[id] = { cert: fs.readFileSync(path.join(reqs, `SAE-${id}-cert.pem`)), key: fs.readFileSync(path.join(reqs, `SAE-${id}-key.pem`)) };
    }
    const ca = fs.readFileSync(path.join(pki, "ca-cert.pem"));
    const gate = path.join(root, "gate-MSL.json"), inbox = path.join(root, "inbox-MSL");
    fs.mkdirSync(inbox);
    let kdkAllowed = true;
    const writeGate = () => writeAtomic(gate, { issuedAtMs: Date.now(), maxAgeMs: 1000, self: { node: "MSL", mtlsAllowed: true, level: "OK" },
      peers: { MSL: { deliveryAllowed: true, level: "OK" }, KDK: { deliveryAllowed: kdkAllowed, level: kdkAllowed ? "OK" : "HOLD_FLOOR" } } });
    writeGate(); gateTimer = setInterval(writeGate, 100);
    const port = 20900 + (process.pid % 50);
    proc = spawn(process.execPath, [path.join(__dirname, "etsi014_kme_server.js"), `--port=${port}`,
      `--cert=${path.join(reqs, "localhost-cert.pem")}`, `--key=${path.join(reqs, "localhost-key.pem")}`, `--ca=${path.join(pki, "ca-cert.pem")}`,
      `--shield-gate=${gate}`, `--keystore-inbox=${inbox}`], { stdio: "ignore" });
    const baseUrl = `https://localhost:${port}`;
    const call = (who, method, apiPath, body) => LIB.httpsCall({ baseUrl, method, apiPath, body, cert: certs[who].cert, key: certs[who].key, ca, timeoutMs: 3000 });
    const status = () => call("MSL", "GET", "/api/v1/keys/SAE-KDK/status");
    for (let i = 0; i < 50; i++) { try { if ((await status()).status === 200) break; } catch (_) { /* açılıyor */ } await sleep(100); }

    const injected = new Map();
    const entries = Array.from({ length: 8 }, (_, k) => { const id = crypto.randomUUID(), b64 = crypto.randomBytes(32).toString("base64"); injected.set(id, b64); return { key_ID: id, key: b64, sizeBits: 256, blockIndex: k }; });
    writeAtomic(path.join(inbox, "000000000000001-0.json"), { routes: { "KDK-MSL": entries } });
    for (let i = 0; i < 30; i++) { const s = await status(); if (s.status === 200 && s.json.stored_key_count === 8) break; await sleep(100); }

    // H1 — yarış penceresini zorla: enc 200, sonra kapı kapanır, sonra dec
    const enc = await call("MSL", "POST", "/api/v1/keys/SAE-KDK/enc_keys", { number: 4 });
    kdkAllowed = false; writeGate();
    const ids = enc.json.keys.map((k) => k.key_ID);
    const dec1 = await call("KDK", "POST", "/api/v1/keys/SAE-MSL/dec_keys", { key_IDs: ids.map((key_ID) => ({ key_ID })) });
    const r = { encStatus: enc.status, dec1Status: dec1.status, dec1Msg: dec1.json && dec1.json.message };

    // H2 — yarı-açık anahtarlar tekrar verilmez
    kdkAllowed = true; writeGate();
    const st = await status();
    const enc2 = await call("MSL", "POST", "/api/v1/keys/SAE-KDK/enc_keys", { number: 4 });
    const ids2 = enc2.status === 200 ? enc2.json.keys.map((k) => k.key_ID) : [];
    r.storedAfterHalfOpen = st.json && st.json.stored_key_count; r.enc2Status = enc2.status; r.overlap = ids2.filter((x) => ids.includes(x)).length;

    // H3 — ertelenmiş dec (kapı açık)
    const dec2 = await call("KDK", "POST", "/api/v1/keys/SAE-MSL/dec_keys", { key_IDs: ids.map((key_ID) => ({ key_ID })) });
    const got = dec2.status === 200 ? Object.fromEntries(dec2.json.keys.map((k) => [k.key_ID, k.key])) : {};
    r.dec2Status = dec2.status; r.deferredBytesMatch = ids.every((id) => got[id] === injected.get(id) && enc.json.keys.find((k) => k.key_ID === id).key === got[id]);

    // H4 — replay
    const dec3 = await call("KDK", "POST", "/api/v1/keys/SAE-MSL/dec_keys", { key_IDs: ids.map((key_ID) => ({ key_ID })) });
    r.dec3Status = dec3.status; r.dec3Msg = dec3.json && dec3.json.message;
    return r;
  } finally {
    if (gateTimer) clearInterval(gateTimer);
    if (proc) { try { proc.kill("SIGTERM"); } catch (_) { /* kapalı */ } }
    await sleep(150);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* önemli değil */ }
  }
}

function classifierCases() {
  const reg = (b64, leaky = false) => ({ b64, pair: "MSL↔KDK", leaky, atMs: 900 });
  const registry = new Map([["a", reg("A")], ["b", reg("B")], ["c", reg("C")], ["z", reg("Z", true)]]);
  const tl = [{ t: 0, nodes: { MSL: "OK", KDK: "OK", AVR: "OK" } }, { t: 6000, nodes: { MSL: "OK", KDK: "HOLD_FLOOR", AVR: "OK" } }, { t: 16300, nodes: { MSL: "OK", KDK: "OK", AVR: "OK" } }];
  // kapı yazım günlüğü: MSL/KDK her 50 ms; AVR 19000 ms'de duruyor (SE izleyicisi çöktü)
  const every = (from, to) => { const a = []; for (let t = from; t <= to; t += 50) a.push(t); return a; };
  const gateWrites = { MSL: every(0, 23000), KDK: every(0, 23000), AVR: every(0, 19000) };
  const base = { pair: "MSL↔KDK", master: "MSL", slave: "KDK", encStatus: 200 };
  const refused = (t, ids, o = {}) => ({ ...base, t, tEncDone: t + 2, decStatus: 503, decMsg: "Kalkan kapısı: 'SAE-KDK' düğümüne anahtar teslimi şu an izinli değil (HOLD_FLOOR)", tDecDone: t + 6, keys: ids.map((id) => ({ id, enc: registry.get(id).b64, dec: null })), ...o });
  const delivered = (t, ids, decOf = (id) => registry.get(id).b64) => ({ ...base, t, tEncDone: t + 2, decStatus: 200, tDecDone: t + 3, keys: ids.map((id) => ({ id, enc: registry.get(id).b64, dec: decOf(id) })) });
  const deferred = (t, ids, o = {}) => ({ ...base, t, deferred: true, decStatus: 200, tDecDone: t + 3, keys: ids.map((id) => ({ id, enc: null, dec: registry.get(id).b64 })), ...o });
  const avr = { pair: "AVR↔ASY", master: "AVR", slave: "ASY" };
  const cases = [
    ["temiz akış", { flows: [delivered(1000, ["a"])] }, true],
    ["slave-kapalı: KDK kapısı enc→dec arasında kapandı + ertelenmiş tamamlama (canlı kayıt #1)", { flows: [refused(6020, ["a", "b"]), deferred(16400, ["a", "b"])] }, true],
    ["slave-kapalı: koşu sonunda kapı hâlâ kapalı (açıklanır, bekler)", { flows: [refused(6020, ["a"])], endMs: 9000 }, true],
    ["master-bayat: AVR SE izleyicisi çöktü, dec ECONNRESET (canlı kayıt #2), koşu sonuna dek tazelenmedi", { flows: [refused(19265, ["a"], { ...avr, tEncDone: 19270, tDecDone: 20172, decStatus: null, decMsg: undefined, decError: "ECONNRESET" })] }, true],
    ["master-bayat: 503 'BAYAT' (canlı kayıt #3)", { flows: [refused(19900, ["a"], { ...avr, tEncDone: 19905, tDecDone: 20010, decMsg: "Kalkan kapısı: kalkan kapısı BAYAT (yaş 1010 ms, sınır 1000 ms)" })] }, true],
    ["taşıma hatası (kapı tazeyken ECONNRESET) + ertelenmiş tamamlama", { flows: [refused(3000, ["a"], { decStatus: null, decMsg: undefined, decError: "ECONNRESET", tDecDone: 3010 }), deferred(3700, ["a"])] }, true],
    ["red ama slave kapısı AÇIKKEN (açıklanamaz)", { flows: [refused(1000, ["a"])] }, false],
    ["'BAYAT' deniyor ama master kapısı tazeydi (açıklanamaz)", { flows: [refused(3000, ["a"], { decMsg: "Kalkan kapısı: kalkan kapısı BAYAT (yaş 1010 ms)" })] }, false],
    ["taşıma hatası, hiç tamamlanmadı", { flows: [refused(3000, ["a"], { decStatus: null, decMsg: undefined, decError: "ECONNRESET", tDecDone: 3010 })] }, false],
    ["slave-kapalı, kapı açıldıktan sonra da hiç tamamlanmadı", { flows: [refused(6020, ["a"])], endMs: 23000 }, false],
    ["dec 200 ama bayt uyuşmuyor", { flows: [delivered(1000, ["a"], () => "X")] }, false],
    ["sızıntılı kökenli anahtar teslim", { flows: [delivered(1000, ["z"])] }, false],
    ["aynı key_ID iki kez enc ile verildi", { flows: [delivered(1000, ["c"]), delivered(1700, ["c"])] }, false],
    ["kayıtta olmayan anahtar", { flows: [{ ...delivered(1000, ["a"]), keys: [{ id: "q", enc: "Q", dec: "Q" }] }] }, false],
  ];
  return cases.map(([label, c, expect]) => {
    const v = classifyL8({ flows: c.flows, registry, timeline: tl, endMs: c.endMs != null ? c.endMs : 23000, gateWrites, gateMaxAgeMs: 1000 });
    return { label, expect, got: v.ok, summary: v.summary };
  });
}

async function main() {
  const r = await liveHalfOpen();
  out.live = r;
  chk("H1 Yarış penceresi zorlandı: enc_keys 200 → kapı slave (KDK) için kapandı → dec_keys 503 (kalkan kapısı) — canlı testteki L8 kaydının birebir aynısı, her koşuda",
    r.encStatus === 200 && r.dec1Status === 503 && /Kalkan kapısı/.test(r.dec1Msg || ""), `enc ${r.encStatus} · dec ${r.dec1Status}: ${r.dec1Msg}`);
  chk("H2 Yarı-açık 4 anahtar depoda 'master'a verildi' olarak kalıyor, sonraki enc_keys onları TEKRAR vermiyor (çift teslim yok)",
    r.storedAfterHalfOpen === 4 && r.enc2Status === 200 && r.overlap === 0, `kullanılabilir stok ${r.storedAfterHalfOpen} (8 − 4 yarı-açık) · ikinci enc ${r.enc2Status}, çakışma ${r.overlap}`);
  chk("H3 Kapı yeniden açılınca ERTELENMİŞ dec_keys aynı key_ID'lerle 200 dönüyor; baytlar master'a verilenle ve gelen kutusuna enjekte edilenle birebir aynı — anahtar kaybolmuyor",
    r.dec2Status === 200 && r.deferredBytesMatch, `dec ${r.dec2Status} · bayt eşleşmesi ${r.deferredBytesMatch}`);
  chk("H4 Aynı key_ID'lerle üçüncü dec_keys reddediliyor (tamamlanan anahtar silindi, replay yok)",
    r.dec3Status === 400, `dec ${r.dec3Status}: ${(r.dec3Msg || "").slice(0, 90)}`);
  const cc = classifierCases(); out.classifier = cc;
  // Eski L8 kuralı (her alınan anahtar için reg && b64ok && match) canlı koşudaki kayıtta ne derdi?
  const oldRule = (keys) => keys.every((k) => k.reg && k.b64ok && k.match);
  const liveRecord = [1, 2, 3, 4].map(() => ({ reg: true, b64ok: true, match: false })); // dec 503 → slave yanıtı yok → match=false
  out.oldRuleOnLiveRecord = oldRule(liveRecord);
  chk(`H5 Düzeltilmiş L8 sınıflandırıcısı ${cc.length} durumda beklenen kararı veriyor: kanıtla eşleşen red (slave-kapalı / master-bayat / taşıma) + ertelenmiş tamamlama geçer; kanıtsız red, uyumsuz bayt, sızıntılı köken, tekrar, kayıtsız anahtar, hiç tamamlanmayan yarı-açık kalır`,
    cc.every((c) => c.got === c.expect), cc.map((c) => `${c.got === c.expect ? "✓" : "✗"} ${c.label} → ${c.got ? "geçer" : "kalır"}`).join(" · "));

  chk("H6 Eski L8 kuralı (alınan her anahtar reg ∧ bayt ∧ match) aynı kayıtta YANLIŞ ALARM veriyordu: köken temiz (kayıtta, bayt aynı, sızıntısız) ama dec reddedildiği için match=false — kararsızlığın tamamı bu",
    out.oldRuleOnLiveRecord === false && cc[1].got === true, `eski kural → ${out.oldRuleOnLiveRecord ? "geçer" : "KALIR"} · yeni sınıflandırıcı → ${cc[1].got ? "geçer" : "kalır"}`);
  out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "kme_half_open_gate.json"), JSON.stringify(out, null, 2));
  for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
