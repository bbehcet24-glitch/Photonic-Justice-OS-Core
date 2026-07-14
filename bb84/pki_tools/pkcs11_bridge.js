#!/usr/bin/env node
// pkcs11_bridge.js — Node.js'ten DOĞRUDAN bir PKCS#11 modülüne (SoftHSM2
// veya gerçek donanım HSM) konuşan köprü.
// ═══════════════════════════════════════════════════════════════════
// ⚠ DÜRÜSTLÜK NOTU (ÖNEMLİ): Bu script'in bağımlılığı olan "pkcs11js"
// npm paketi, çalıştığı sandbox'ta ağ kısıtı (npm registry 403) yüzünden
// hiç KURULAMADI — bu yüzden bu dosya BURADA hiç ÇALIŞTIRILIP TEST
// EDİLEMEDİ (tıpkı bu oturumda daha önce gerçek Qiskit'in kurulamaması
// gibi, bkz. bb84/ibm_qiskit_equivalent.py'nin üstündeki not). Kod,
// pkcs11js'in iyi belgelenmiş, düşük seviyeli (ham PKCS#11 C API'sini
// birebir yansıtan) arayüzüne dayanır. İlk gerçek doğrulama, GitHub
// Actions'ın "software-hsm-pkcs11" işinde (gerçek npm/apt erişimiyle
// pkcs11js + SoftHSM2 kurup çalıştırır) olacaktır — bkz.
// production-pipeline.yml. Bu dosyayı ilk kez bir CI çalıştırmasında
// hata alırsanız, muhtemel sebep pkcs11js sürümleri arası küçük API
// farklarıdır (ör. sabit adları) — hatayı bana iletirseniz hızlıca
// düzeltebilirim.
//
// AMAÇ: CA/sertifika imzalama zaten openssl CLI üzerinden (ca_init.sh/
// sign_csr.sh, -engine pkcs11) token'a bağlı. Ama KME sunucusu Node.js'te
// çalışıyor — bu script, Node tarafının da AYNI token'a DOĞRUDAN
// konuşup imzalama yapabildiğini (özel anahtar Node'un belleğine/diskine
// HİÇ ÇIKMADAN) kanıtlar. Bu, gelecekte Node-taraflı operasyonel
// anahtarların (ör. KME'nin kısa ömürlü sunucu anahtarı) da aynı HSM
// altyapısına taşınabileceğinin somut, çalışan bir temelidir.
//
// KAPSAM DIŞI (dürüstlük): Bu script KME sunucusunun CANLI TLS dinleme
// soketini (https.createServer({key:...})) HSM'e BAĞLAMAZ — Node'un
// tls/https modülünün, OpenSSL CLI'nin -engine mekanizmasına eşdeğer
// birinci-sınıf bir "harici imzalayıcı" kancası YOKTUR. Bu, ayrı ve
// daha büyük bir mühendislik çalışmasıdır (bkz.
// bb84/PRODUCTION_READINESS_ROADMAP.md madde 2 — güncellenmiş kapsam
// notu). Bu script'in kanıtladığı şey daha dar ama sağlam bir temel:
// "Node, token içindeki bir özel anahtarla imzalama YAPABİLİR."
//
// KULLANIM:
//   node pkcs11_bridge.js --self-test --module=<yol> --pin=<pin> \
//     --label=<obje-etiketi> [--token-label=<etiket>] [--pubkey-pem=<yol>]
//   (--pubkey-pem verilmezse yalnızca imzalama yapılır, doğrulama atlanır)
// ═══════════════════════════════════════════════════════════════════
"use strict";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function requirePkcs11js() {
  try {
    return require("pkcs11js");
  } catch (e) {
    console.error(
      "[pkcs11_bridge] HATA: 'pkcs11js' paketi bulunamadı. Kurun:\n" +
        "  npm install --no-save pkcs11js\n" +
        "(CI'da bu adım production-pipeline.yml'in 'software-hsm-pkcs11' işinde OTOMATİK yapılır.)"
    );
    process.exit(3);
  }
}

// Token içindeki, label='label' olan ÖZEL anahtarla 'data'yı imzalar.
// Özel anahtarın KENDİSİ hiçbir zaman bu fonksiyonun dışına (Node
// belleğine bir Buffer/anahtar nesnesi olarak) ÇIKMAZ — yalnızca PKCS#11
// "handle"ı (bir referans/tamsayı) kullanılır, imzalama İŞLEMİ token
// içinde (C_Sign) gerçekleşir.
function signWithHsm({ modulePath, pin, label, data, tokenLabel }) {
  const pkcs11js = requirePkcs11js();
  const pkcs11 = new pkcs11js.PKCS11();
  pkcs11.load(modulePath);
  pkcs11.C_Initialize();
  let session = null;
  try {
    const slots = pkcs11.C_GetSlotList(true);
    if (!slots.length) {
      throw new Error("Hiçbir token'lı slot bulunamadı (C_GetSlotList boş döndü) — token başlatıldı mı? (bkz. hsm_init.sh)");
    }
    let slot = slots[0];
    if (tokenLabel) {
      const match = slots.find((s) => {
        try {
          const info = pkcs11.C_GetTokenInfo(s);
          return (info.label || "").trim() === tokenLabel;
        } catch (e) {
          return false;
        }
      });
      if (match !== undefined) slot = match;
    }

    session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_SERIAL_SESSION | pkcs11js.CKF_RW_SESSION);
    pkcs11.C_Login(session, pkcs11js.CKU_USER, pin);

    const template = [
      { type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_PRIVATE_KEY },
      { type: pkcs11js.CKA_LABEL, value: Buffer.from(label) },
    ];
    pkcs11.C_FindObjectsInit(session, template);
    const found = pkcs11.C_FindObjects(session, 1);
    pkcs11.C_FindObjectsFinal(session);
    if (!found || !found.length) {
      throw new Error(
        `Token'da label='${label}' olan bir ÖZEL anahtar bulunamadı — önce ca_init.sh --pkcs11-uri ile üretilmiş olmalı.`
      );
    }
    const privKeyHandle = found[0];

    pkcs11.C_SignInit(session, { mechanism: pkcs11js.CKM_SHA256_RSA_PKCS }, privKeyHandle);
    const signature = pkcs11.C_Sign(session, data);
    return signature;
  } finally {
    if (session !== null) {
      try {
        pkcs11.C_Logout(session);
      } catch (e) {
        /* zaten kapanmış olabilir, önemli değil */
      }
      try {
        pkcs11.C_CloseSession(session);
      } catch (e) {
        /* aynı şekilde */
      }
    }
    try {
      pkcs11.C_Finalize();
    } catch (e) {
      /* aynı şekilde */
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["self-test"]) {
    console.error(
      "Kullanım: node pkcs11_bridge.js --self-test --module=<yol> --pin=<pin> --label=<obje-etiketi> [--token-label=<etiket>] [--pubkey-pem=<yol>]"
    );
    process.exit(1);
  }
  const modulePath = args.module;
  const pin = args.pin;
  const label = args.label;
  if (!modulePath || !pin || !label) {
    console.error("HATA: --module, --pin ve --label ZORUNLUDUR.");
    process.exit(1);
  }

  const testData = Buffer.from(`photonnet-hsm-self-test-${label}`, "utf8");
  console.log(`[pkcs11_bridge] Token'a bağlanılıyor: module=${modulePath} label=${label}`);
  const signature = signWithHsm({ modulePath, pin, label, data: testData, tokenLabel: args["token-label"] });
  console.log(
    `[pkcs11_bridge] İmza üretildi (${signature.length} bayt) — ÖZEL ANAHTAR Node'un belleğine hiç ÇIKMADI, imzalama token İÇİNDE yapıldı.`
  );

  if (args["pubkey-pem"]) {
    const fs = require("fs");
    const crypto = require("crypto");
    const pubPem = fs.readFileSync(args["pubkey-pem"], "utf8");
    const pubKey = crypto.createPublicKey(pubPem);
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(testData);
    verifier.end();
    const ok = verifier.verify(pubKey, signature);
    if (!ok) {
      console.error("[pkcs11_bridge] ✗ DOĞRULAMA BAŞARISIZ — imza, sağlanan genel anahtarla EŞLEŞMİYOR.");
      process.exit(1);
    }
    console.log(
      "[pkcs11_bridge] ✓ DOĞRULAMA BAŞARILI — token içinde üretilen imza, aynı anahtarın genel yarısıyla (standart Node crypto ile) doğrulandı."
    );
  } else {
    console.log("[pkcs11_bridge] (--pubkey-pem verilmedi, doğrulama adımı atlandı — yalnızca imzalama test edildi.)");
  }
  console.log("[pkcs11_bridge] ✓ ÖZ-TEST BAŞARILI.");
}

main();
