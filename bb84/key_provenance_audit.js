"use strict";
/**
 * key_provenance_audit.js — canlı ETSI-014 akışlarının anahtar KÖKENİ denetimi (testbed L8)
 * ═══════════════════════════════════════════════════════════════════
 * Neden ayrı modül: multinode_shielding_testbed.js'in L8 kontrolü ~%3 olasılıkla yanlış alarm veriyordu
 * (bkz. docs/L8_FLAKE_ANALYSIS.md). Sebep ağ gecikmesi değil, ETSI-014'ün İKİ ADIMLI olması: kalkan kapısı
 * enc_keys ile dec_keys ARASINDA kapanırsa KME doğru şekilde (fail-closed) slave'e teslimi reddeder ve
 * master'da "yarı-açık" anahtar kalır. Eski L8 bu anahtarları "alındı ama eşleşmedi" sayıyordu.
 *
 * Bu modül kökeni üç sınıfa ayırır ve YALNIZCA gerçek ihlali hata sayar:
 *   1) Master'a verilen HER anahtar: kayıtta var, bayt aynı, sızıntılı kökenli değil, iki kez verilmemiş
 *   2) Slave'e verilen HER anahtar (anında ya da ertelenmiş): bayt kayıtla (ve master'ın aldığıyla) aynı
 *   3) Yarı-açık anahtar (enc 200, dec ≠ 200) yalnız gerekçesi KANITLA eşleşiyorsa kabul edilir:
 *        • slave-kapalı : 503 "…teslimi şu an izinli değil" VE zaman çizelgesinde delivery[slave] = false
 *        • master-bayat : (503 "BAYAT" ya da bağlantı kesildi) VE master KME'nin kapı dosyası enc→dec
 *                         penceresinde gerçekten > maxAge tazelenmedi (kapı yazım günlüğünden)
 *        • master-blok  : (503 "düğüm kalkanı" ya da bağlantı kesildi) VE zaman çizelgesinde mtls[master] = false
 *        • taşıma       : HTTP yanıtı yok (zaman aşımı/ECONNRESET) ve kapı gerekçesi yok — kabul, ama koşul
 *                         hemen kalktığı için graceMs içinde tamamlanması ZORUNLU
 *      VE koşul kalktıktan sonra graceMs içinde ertelenmiş dec ile TAMAMLANDI — ya da koşu, koşul kalkıp
 *      graceMs geçmeden bitti (tamamlanamaz ama açıklanır; ör. SE izleyicisi koşu sonuna dek çökük)
 *
 * Girdi kayıt biçimi (testbed flowWorker üretir):
 *   { t, pair, slave, encStatus, decStatus, decMsg, tDecDone, deferred?, keys: [{ id, enc, dec }] }
 *   enc = master'a dönen base64 (ertelenmiş kayıtta null), dec = slave'e dönen base64 ya da null
 * registry: Map<key_ID, { b64, pair, leaky, atMs }>  ·  timeline: [{ t, nodes, delivery?: {id: bool}, mtls?: {id: bool} }]
 * gateWrites: { node: [rel ms, …] } (kapı dosyası yazım anları) · gateMaxAgeMs: KME'nin tazelik sınırı
 */

const SHIELD_REFUSAL_RE = /Kalkan kapısı/;

/** timeline'da bir bayrağın (delivery|mtls) node için t anındaki değeri; kayıt yoksa durum adından türetilir. */
function flagAt(timeline, field, node, t) {
  let last = null;
  for (const e of timeline) { if (e.t <= t) last = e; else break; }
  if (!last) return true;
  if (last[field] && typeof last[field][node] === "boolean") return last[field][node];
  return field === "mtls" ? last.nodes[node] !== "BLOCK" : last.nodes[node] === "OK";
}
function firstFlagTrueAfter(timeline, field, node, t) {
  for (const e of timeline) {
    if (e.t <= t) continue;
    const v = e[field] && typeof e[field][node] === "boolean" ? e[field][node] : (field === "mtls" ? e.nodes[node] !== "BLOCK" : e.nodes[node] === "OK");
    if (v) return e.t;
  }
  return null;
}
/** [t0, t1] penceresinde kapı dosyası > maxAge tazelenmeden kaldı mı? (yazım günlüğünden; tol = örnekleme payı) */
function gateStaleWithin(writes, t0, t1, maxAgeMs, tolMs = 50) {
  if (!Array.isArray(writes) || !writes.length) return false;
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i], next = i + 1 < writes.length ? writes[i + 1] : Infinity;
    if (next < t0 || w > t1) continue;            // pencereyle kesişmiyor
    if (Math.min(next, t1) - w > maxAgeMs - tolMs) return true;
  }
  return false;
}

/** Yarı-açık bir kaydın gerekçesini kanıtla eşleştirir: { reason, clearsAt } ya da null (açıklanamaz). */
function explainRefusal(f, { timeline, gateWrites, gateMaxAgeMs }) {
  const msg = f.decMsg || "", transport = f.decStatus == null; // HTTP yanıtı yok (TLS kesildi / zaman aşımı)
  const tEnc = Number.isFinite(f.tEncDone) ? f.tEncDone : f.t, tDec = f.tDecDone;
  if (f.decStatus === 503 && /teslimi şu an izinli değil/.test(msg) && !flagAt(timeline, "delivery", f.slave, tDec)) {
    return { reason: "slave-kapalı", clearsAt: firstFlagTrueAfter(timeline, "delivery", f.slave, tDec) };
  }
  if ((transport || (f.decStatus === 503 && /BAYAT/.test(msg))) && gateWrites && gateStaleWithin(gateWrites[f.master], tEnc, tDec, gateMaxAgeMs)) {
    const w = (gateWrites[f.master] || []).find((x) => x > tDec);
    return { reason: "master-bayat", clearsAt: w != null ? w : null };
  }
  if ((transport || (f.decStatus === 503 && /düğüm kalkanı/.test(msg))) && !flagAt(timeline, "mtls", f.master, tDec)) {
    return { reason: "master-blok", clearsAt: firstFlagTrueAfter(timeline, "mtls", f.master, tDec) };
  }
  if (transport) return { reason: "taşıma", clearsAt: tDec };
  return null;
}

function classifyL8({ flows, registry, timeline, endMs, gateWrites = null, gateMaxAgeMs = 1000, graceMs = 3000 }) {
  const v = { masterKeys: 0, slaveKeys: 0, halfOpen: 0, halfOpenCompleted: 0, halfOpenPendingExplained: 0, reasons: {}, violations: [] };
  const bad = (msg) => v.violations.push(msg);
  const seenMaster = new Set();
  const halfOpen = new Map(); // id → { t, slave, reopenAt }
  const sorted = [...flows].filter((f) => Array.isArray(f.keys) && f.keys.length).sort((a, b) => a.t - b.t);

  for (const f of sorted) {
    if (f.deferred) {
      for (const k of f.keys) {
        const h = halfOpen.get(k.id);
        if (!h) { bad(`ertelenmiş dec, yarı-açık olmayan anahtar için: ${k.id}`); continue; }
        if (f.decStatus !== 200) continue; // hâlâ reddediliyor — tamamlanmadı, sonra tekrar denenir
        const r = registry.get(k.id);
        if (!r || k.dec !== r.b64 || (h.enc != null && k.dec !== h.enc)) { bad(`ertelenmiş dec baytı uyuşmuyor: ${k.id}`); continue; }
        v.slaveKeys++; v.halfOpenCompleted++; halfOpen.delete(k.id);
      }
      continue;
    }
    // 1) master tarafı köken
    for (const k of f.keys) {
      v.masterKeys++;
      const r = registry.get(k.id);
      if (!r) { bad(`kayıtta olmayan anahtar master'a verildi: ${k.id}`); continue; }
      if (r.b64 !== k.enc) bad(`master'a verilen bayt kayıtla uyuşmuyor: ${k.id}`);
      if (r.leaky) bad(`sızıntılı kökenli anahtar master'a verildi: ${k.id}`);
      if (seenMaster.has(k.id)) bad(`aynı key_ID iki kez master'a verildi: ${k.id}`);
      seenMaster.add(k.id);
    }
    // 2) slave tarafı
    if (f.decStatus === 200) {
      for (const k of f.keys) {
        const r = registry.get(k.id);
        if (k.dec == null) { bad(`dec 200 ama anahtar yanıtta yok: ${k.id}`); continue; }
        if (!r || k.dec !== r.b64 || k.dec !== k.enc) bad(`slave'e verilen bayt uyuşmuyor: ${k.id}`);
        else v.slaveKeys++;
      }
      continue;
    }
    // 3) yarı-açık: gerekçe kanıtla eşleşiyor mu?
    const ex = explainRefusal(f, { timeline, gateWrites, gateMaxAgeMs });
    for (const k of f.keys) {
      v.halfOpen++;
      if (!ex) { bad(`dec reddi açıklanamıyor (durum ${f.decStatus}, "${String(f.decMsg || f.decError || "").slice(0, 60)}", master ${f.master}, slave ${f.slave}): ${k.id}`); continue; }
      v.reasons[ex.reason] = (v.reasons[ex.reason] || 0) + 1;
      halfOpen.set(k.id, { t: f.t, slave: f.slave, enc: k.enc, reason: ex.reason, reopenAt: ex.clearsAt });
    }
  }
  // tamamlanmamış yarı-açıklar
  for (const [id, h] of halfOpen) {
    if (h.reopenAt != null && h.reopenAt + graceMs <= endMs) bad(`yarı-açık anahtar (${h.reason}) koşul ${h.reopenAt} ms'de kalktıktan sonra ${graceMs} ms içinde tamamlanmadı: ${id}`);
    else v.halfOpenPendingExplained++;
  }
  v.ok = v.masterKeys > 0 && v.violations.length === 0;
  const rs = Object.entries(v.reasons).map(([k, n]) => `${k} ${n}`).join(", ");
  v.summary = `master ${v.masterKeys} · slave ${v.slaveKeys} · yarı-açık ${v.halfOpen}${rs ? ` [${rs}]` : ""} (ertelenmiş tamamlanan ${v.halfOpenCompleted}, koşu sonunda açıklanan bekleyen ${v.halfOpenPendingExplained}) · ihlal ${v.violations.length}${v.violations.length ? ": " + v.violations.slice(0, 3).join("; ") : ""}`;
  return v;
}

module.exports = { classifyL8, explainRefusal, gateStaleWithin, flagAt, SHIELD_REFUSAL_RE };
