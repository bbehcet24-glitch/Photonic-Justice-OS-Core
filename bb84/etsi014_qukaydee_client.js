#!/usr/bin/env node
"use strict";
/**
 * etsi014_qukaydee_client.js — A1: Faz 0 istemcisini GERÇEK QuKayDee'ye bağla
 * ═══════════════════════════════════════════════════════════════════
 * Yol haritası A1: kendi KME'mizi başlatmak yerine, gerçek bir ETSI-014
 * bulut ucuna (QuKayDee) bağlanıp aynı iki-taraflı akışı koşturur ve
 * şemayı doğrular. Vendor-neutral etsi014_client_lib üzerinden.
 *
 * KULLANIM:
 *   1) QuKayDee'de ücretsiz hesap aç, e-postanı doğrula.
 *   2) kme-1(+sae-1) ve kme-2(+sae-2) + bir Key Stream oluştur.
 *   3) Sunucu CA'yı indir; istemci CA'nı üret+yükle; sae-1/sae-2
 *      sertifikalarını üret (bkz. brunorijsman/qukaydee-generate-client-certificates).
 *   4) qukaydee.config.json'u doldur (qukaydee.config.example.json'a bak).
 *   5) node etsi014_qukaydee_client.js [config-yolu]
 *
 * NOT: Bu istemcinin mantığı, yerel KME'mize karşı etsi014_client_lib_test.js
 * ile DOĞRULANMIŞTIR — QuKayDee'ye geçiş yalnızca config (URL + sertifika)
 * değişimidir. Sandbox'tan gerçek QuKayDee'ye ağ/kimlik erişimi olmadığından
 * canlı koşum kullanıcı tarafında yapılır. Çekirdeğe dokunulmadı.
 */
const fs = require("fs");
const path = require("path");
const LIB = require("./etsi014_client_lib.js");

async function main() {
  const cfgPath = process.argv[2] || path.join(__dirname, "qukaydee.config.json");
  if (!fs.existsSync(cfgPath)) {
    console.error(`\n[QuKayDee] Config bulunamadı: ${cfgPath}`);
    console.error(`Önce qukaydee.config.example.json'u kopyalayıp doldurun:`);
    console.error(`  cp qukaydee.config.example.json qukaydee.config.json\n`);
    return 2;
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  let cfg;
  try { cfg = LIB.loadCerts(raw); }
  catch (e) { console.error(`\n[QuKayDee] Sertifika okunamadı: ${e.message}\n(config'teki *Path alanlarını kontrol edin)\n`); return 2; }

  console.log(`\n══ A1 — Faz 0 istemcisi ↔ GERÇEK QuKayDee (ETSI-014) ══\n`);
  console.log(`  master: ${cfg.master.saeId} @ ${cfg.master.baseUrl}`);
  console.log(`  slave:  ${cfg.slave.saeId} @ ${cfg.slave.baseUrl}`);
  console.log(`  standart: ETSI GS QKD 014 V1.1.1 · mTLS\n`);

  let res;
  try { res = await LIB.runFlow(cfg); }
  catch (e) {
    console.error(`[QuKayDee] Bağlantı/istek hatası: ${e.message}`);
    console.error(`(URL erişilebilir mi? Sertifikalar sunucu CA'sıyla eşleşiyor mu? SAE'ler doğru KME'ye bağlı mı?)\n`);
    return 1;
  }

  if (res.status) console.log(`  Status: stored=${res.status.stored_key_count} · key_size=${res.status.key_size} bit · KME=${res.status.source_KME_ID}`);
  if (res.keyMatch) console.log(`  Anahtar eşleşmesi: ${res.keyMatch.delivered}/${res.keyMatch.requested} · master===slave: ${res.keyMatch.allMatch ? "EVET ✓" : "HAYIR ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of res.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${res.allPassed ? "TÜM ÖZ-TESTLER GEÇTİ — KME/QuKayDee gerçek bir ETSI-014 ucu olarak çalışıyor" : "BAZI ÖZ-TESTLER BAŞARISIZ"}\n`);
  return res.allPassed ? 0 : 1;
}

if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
