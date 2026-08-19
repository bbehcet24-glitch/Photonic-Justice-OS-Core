#!/usr/bin/env node
/**
 * etsi014_kme_server.js
 * ═══════════════════════════════════════════════════════════════════
 * PhotonNet — ETSI GS QKD 014 (V1.1.1) UYUMLU KME (Key Management
 * Entity) REST SUNUCUSU — sıfır bağımlılık, saf Node.js `http`/`https`.
 *
 * AMAÇ: PhotonNet tarayıcı simülatörünün ürettiği (KeyPoolBuffer.
 * _finalizeBlock içinde Cascade uzlaşma + Toeplitz gizlilik yükseltmesi
 * ile üretilmiş, GERÇEKTEN güvenli/finite-key-kanıtlı) anahtarları,
 * IBM Quantum Network gibi harici uygulamaların veya VPN/TLS
 * tünellerinin ETSI'nin STANDART REST API'si üzerinden çekebilmesini
 * sağlamak. Bu dosya PhotonNet'in tarayıcı-içi React kodundan TAMAMEN
 * BAĞIMSIZ, gerçek bir HTTP(S) sunucusu olarak ÇALIŞTIRILABİLİR.
 *
 * NEDEN AYRI BİR SUNUCU DOSYASI (React uygulamasının İÇİNE DEĞİL)?
 * PhotonNet.html tek-dosyalık, sunucusuz (serverless), tarayıcıda
 * çalışan bir simülatördür — tarayıcı JS'i bir TCP/HTTP SUNUCUSU AÇAMAZ
 * (soket API'si yok). Gerçek bir KME, fiziksel/ağ-erişimli bir sunucu
 * SÜRECİDİR. Bu yüzden mimari: (1) tarayıcı, üretilen GÜVENLİ anahtarları
 * "🔐 KME Anahtar Deposu (JSON)" düğmesiyle dışa aktarır — bkz.
 * PhotonNet2.jsx KeyDeliveryStore.exportForKME(); (2) bu dosya o JSON'u
 * içe aktarıp GERÇEK bir REST sunucusu olarak servis eder. Bu, gerçek
 * QKD dağıtımlarında da BENZER bir ayrımdır: KME donanımı/yazılımı
 * QKD katmanından (fiber/uydu bağlantısı) ayrı bir süreçtir.
 *
 * STANDART: ETSI GS QKD 014 V1.1.1 (2019-02) "Quantum Key Distribution
 * (QKD); Protocol and data format of REST-based key delivery API".
 * Üç uç nokta:
 *   1) GET  /api/v1/keys/{slave_SAE_ID}/status
 *   2) POST /api/v1/keys/{slave_SAE_ID}/enc_keys      (GET de desteklenir)
 *   3) POST /api/v1/keys/{master_SAE_ID}/dec_keys     (GET de desteklenir)
 *
 * KAVRAMLAR (ETSI 014 terminolojisi):
 *   - KME (Key Management Entity): bu sunucu — QKD sisteminin yerel
 *     anahtar deposunu SAE'lere teslim eden bileşen.
 *   - SAE (Secure Application Entity): anahtarı TÜKETEN uygulama
 *     (VPN gateway, TLS terminator, IBM Quantum Network istemcisi, vb.)
 *   - "Master" SAE: anahtarı İLK isteyen taraf (enc_keys çağırır).
 *   - "Slave" SAE: master'ın ürettiği anahtarı, master'dan (uygulama
 *     seviyesinde, KME-DIŞI bir kanaldan — ör. TLS handshake mesajı
 *     içinde) aldığı key_ID ile SONRADAN çeken taraf (dec_keys çağırır).
 *   - ÖNEMLİ MİMARİ GERÇEK: ETSI 014, İKİ KME ARASINDAKİ senkronizasyonu
 *     (yani Alice'in KME'si ile Bob'un KME'sinin AYNI ham kuantum anahtar
 *     materyaline nasıl sahip olduğu) TANIMLAMAZ — bu, kuantum katmanının
 *     (QKD protokolü, bu simülatörde zaten transmit()/Cascade/Toeplitz)
 *     işidir. 014 SADECE yerel KME→SAE teslimatını standartlaştırır. Bu
 *     yüzden bu REFERANS sunucu, PhotonNet'in ÜRETTİĞİ (Alice ve Bob'un
 *     ZATEN aynı olduğu doğrulanmış — bkz. CascadeReconciliation
 *     residualErrors=0) finalKeyBits'i tek bir JSON deposunda tutar ve
 *     rotanın İKİ UCUNU DA (master ve slave SAE'ler) AYNI depodan
 *     besler — gerçek dağıtık bir sistemde bu, Alice-tarafı KME ve
 *     Bob-tarafı KME olarak İKİ AYRI sunucu örneği olurdu, ikisi de
 *     kendi yerel kuantum katmanından beslenir.
 *
 * GÜVENLİK/DÜRÜSTLÜK NOTU (mTLS): Gerçek ETSI 014 dağıtımları SAE↔KME
 * arasında KARŞILIKLI TLS (mutual TLS, istemci sertifikası ile SAE
 * kimliği doğrulama) ZORUNLU KILAR. Bu sürüm GERÇEK mTLS'İ UYGULAR:
 * `--cert`/`--key`/`--ca` ÜÇÜ BİRLİKTE verildiğinde, Node'un TLS katmanı
 * (requestCert:true + rejectUnauthorized:true + ca:[...]) yalnızca
 * verilen CA tarafından imzalanmış istemci sertifikalarını TLS HANDSHAKE
 * aşamasında kabul eder — sertifikasız/yanlış-CA'lı bağlantılar uygulama
 * kodu hiç çalışmadan reddedilir. SAE kimliği bu doğrulanmış sertifikanın
 * Subject CN alanından okunur (bkz. authenticate(), aşağıda) — HTTP
 * header'ından DEĞİL. Demo/test PKI'sını (kök CA + KME sunucu sertifikası
 * + her SAE için istemci sertifikası) üretmek için bkz.
 * generate_demo_pki.sh.
 * // PROD-STRIP-BEGIN: demo-auth-doc-fallback-explainer
 * `--ca` VERİLMEZSE (yalnızca `--cert`/`--key` veya hiçbiri), sistem
 * header-tabanlı bir demo kimlik doğrulama temsilcisine düşer — ÜRETİMDE
 * BU YETERLİ DEĞİLDİR, yalnızca --ca olmadan hızlı yerel test içindir.
 * // PROD-STRIP-END: demo-auth-doc-fallback-explainer
 * // PROD-REPLACE-TEXT-BEGIN: demo-auth-doc-fallback-explainer
 * Bu ÜRETİM DERLEMESİNDE header-tabanlı geri düşüş modu FİZİKSEL OLARAK
 * YOKTUR — `--ca` verilmezse sunucu hiç BAŞLAMAZ (mTLS zorunludur, bkz.
 * build_production_server.js).
 * // PROD-REPLACE-TEXT-END: demo-auth-doc-fallback-explainer
 *
 * ÜRETİM-SINIFI PKI (HSM/hava-boşluğu + KISA ÖMÜR + İPTAL): CA anahtarı
 * artık BU sunucu dosyasının/demo script'inin İÇİNDE ÜRETİLMİYOR. bb84/
 * pki_tools/ altındaki ayrı script takımı kullanılır:
 *   - ca_init.sh    → kök CA + openssl CA veritabanını BİR KEZ kurar
 *                      (TERCİHEN hava-boşluklu/HSM'de — --pkcs11-uri
 *                      ile gerçek HSM'e yönlendirme KANCASI mevcuttur).
 *   - issue_cert.sh → SAE/sunucu TARAFINDA anahtar+CSR üretir (özel
 *                      anahtar o makineden HİÇ ÇIKMAZ).
 *   - sign_csr.sh   → CA TARAFINDA CSR'ı KISA ÖMÜRLÜ (varsayılan 7 gün)
 *                      imzalar, CA veritabanına kaydeder.
 *   - rotate_cert.sh→ kısa ömür ZORUNLU KILDIĞI için düzenli YENİLEME.
 *   - revoke_cert.sh→ bir sertifikayı ANINDA iptal eder + CRL'yi yeniden üretir.
 *   - run_ocsp_responder.sh → CANLI (gerçek-zamanlı) iptal sorgusu için
 *                      openssl tabanlı bir OCSP yanıtlayıcısı başlatır.
 * Bu sunucu İKİ bağımsız iptal mekanizmasını da destekler:
 *   --crl=<ca-crl.pem>            → Node TLS katmanında (rejectUnauthorized
 *                                    ile birlikte) iptal edilen sertifikaları
 *                                    TLS HANDSHAKE'te reddeder. Dosya
 *                                    değişikliği izlenir (fs.watchFile) —
 *                                    revoke_cert.sh çalıştırıldığında sunucuyu
 *                                    YENİDEN BAŞLATMAYA GEREK YOKTUR.
 *   --ocsp-responder=<url>        → her mTLS isteğinde (kısa TTL'li önbellekle)
 *                                    openssl `ocsp` istemcisiyle CANLI durum
 *                                    sorgusu yapar — CRL'nin dağıtılmasını
 *                                    BEKLEMEDEN anlık iptal sağlar.
 *
 * KULLANIM (üretim-sınıfı, tam iptal desteğiyle):
 *   ./pki_tools/ca_init.sh ./pki
 *   ./pki_tools/issue_cert.sh ./pki server localhost   && ./pki_tools/sign_csr.sh ./pki ./pki/localhost.csr server 7
 *   ./pki_tools/issue_cert.sh ./pki client SAE-ANK     && ./pki_tools/sign_csr.sh ./pki ./pki/SAE-ANK.csr client 7
 *   ./pki_tools/issue_cert.sh ./pki client SAE-IST     && ./pki_tools/sign_csr.sh ./pki ./pki/SAE-IST.csr client 7
 *   node etsi014_kme_server.js --keystore=export.json --port=8443 \
 *        --cert=./pki/localhost-cert.pem --key=./pki/localhost-key.pem --ca=./pki/ca-cert.pem \
 *        --crl=./pki/crl/ca-crl.pem --ocsp-responder=http://localhost:8888
 *
 * KULLANIM (hızlı yerel demo, --seed-demo, düz HTTP, iptal YOK):
 *   node etsi014_kme_server.js --seed-demo
 *
 * ÖRNEK ÇAĞRILAR — GERÇEK mTLS modu (istemci kendi sertifikasını sunar,
 * hiçbir kimlik doğrulama header'ına GEREK YOKTUR — kimlik sertifikadan gelir):
 *   curl --cert ./pki/SAE-ANK-cert.pem --key ./pki/SAE-ANK-key.pem --cacert ./pki/ca-cert.pem \
 *        https://localhost:8443/api/v1/keys/SAE-IST/status
 *   curl -X POST --cert ./pki/SAE-ANK-cert.pem --key ./pki/SAE-ANK-key.pem --cacert ./pki/ca-cert.pem \
 *        -H "Content-Type: application/json" -d '{"number":1}' \
 *        https://localhost:8443/api/v1/keys/SAE-IST/enc_keys
 *   curl -X POST --cert ./pki/SAE-IST-cert.pem --key ./pki/SAE-IST-key.pem --cacert ./pki/ca-cert.pem \
 *        -H "Content-Type: application/json" -d '{"key_IDs":[{"key_ID":"<enc_keys_ten_gelen_id>"}]}' \
 *        https://localhost:8443/api/v1/keys/SAE-ANK/dec_keys
 *
 * // PROD-STRIP-BEGIN: demo-auth-doc-curl-example
 * ÖRNEK ÇAĞRILAR — geri düşüş demo modu (--ca verilmeden, header-tabanlı):
 *   curl -H "X-SAE-ID: SAE-IST" -H "Authorization: Bearer demo-token" \
 *        http://localhost:8443/api/v1/keys/SAE-ANK/status
 * // PROD-STRIP-END: demo-auth-doc-curl-example
 * ═══════════════════════════════════════════════════════════════════
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ── CLI argümanları ───────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || "8443", 10);
// PROD-STRIP-BEGIN: demo-auth-token
const AUTH_TOKEN = args["sae-token"] || "demo-token"; // İKAZ: gerçek üretimde mTLS kullanın, bu bir demo temsilcisidir
// PROD-STRIP-END: demo-auth-token
const DEFAULT_KEY_SIZE_BITS = 256; // ETSI 014 varsayılan anahtar boyutu alanı (status.key_size) — demo değeri
let MTLS_ENABLED = false; // --cert/--key/--ca üçü birlikte verildiğinde true olur (bkz. sunucu başlatma bloğu, aşağıda)

// ── Anahtar Deposu (KME'nin yerel belleği) ────────────────────────
// routeKey ("A-B", sıralı) -> [{key_ID, key(base64), sizeBits, blockIndex,
//                               issuedToMaster:bool, issuedToSlave:bool}]
class KMEKeyStore {
  constructor() {
    // DURUM ŞİŞİRMESİ DÜZELTMESİ (state_poisoning_drill.js buldu).
    // Önceki tasarım rota deposunu DÜZ DİZİ tutuyordu; her dec_keys iki
    // kez `findIndex` (O(n)) + `splice` (O(n)) yapıyordu. Yarı-açık el
    // sıkışmalarla (enc var, dec yok) depo büyüdükçe, GEÇERLİ her dec
    // isteğinin maliyeti doğrusal artıyordu: n=1k→80k'da 12→913 μs/dec
    // ölçüldü. Yani saldırgan O(1) iş yapıp sunucuya O(n) iş yaptırıyor —
    // "anlamlı trafiğe ayrılan bant genişliği" kayıt sayısıyla eriyor.
    //
    // Çözüm: rota deposu artık key_ID → entry MAP'i (ekleme sırası
    // korunur = FIFO). get/delete O(1). Ayrıca un-issued key_ID'ler için
    // ayrı bir FIFO kuyruğu tutulur ki takeForMaster ön-uçtan O(1)
    // ayırsın (yarı-açık kayıtlar ön-ucu tıkamasın).
    this.routes = {};           // routeKey -> Map<key_ID, entry>
    this.unissued = {};         // routeKey -> [key_ID, ...]  (issuedToMaster=false, FIFO)
    this.deliveredCount = 0;
    this.destroyedCount = 0; // her iki SAE'ye de teslim edilip bellekten SİLİNEN anahtar sayısı (denetim istatistiği)
  }

  _ensure(routeKey) {
    if (!this.routes[routeKey]) { this.routes[routeKey] = new Map(); this.unissued[routeKey] = []; }
    return this.routes[routeKey];
  }
  _add(routeKey, entry) {
    this._ensure(routeKey).set(entry.key_ID, entry);
    this.unissued[routeKey].push(entry.key_ID);
  }

  static routeKeyFromSAEPair(saeA, saeB) {
    // PhotonNet2.jsx KeyPoolBuffer.routeKey ile AYNI kural: alfabetik sıralama.
    // SAE ID'lerindeki "SAE-" ön ekini (varsa) soyarak asıl düğüm adına iner.
    const strip = s => String(s).replace(/^SAE-/i, "");
    return [strip(saeA), strip(saeB)].sort().join("-");
  }

  loadFromExport(exportObj) {
    // PhotonNet2.jsx KeyDeliveryStore.exportForKME() çıktısı: { routes: { routeKey: [entry,...] } }
    if (!exportObj || !exportObj.routes) throw new Error("Geçersiz KME içe aktarım biçimi: 'routes' alanı bulunamadı");
    for (const [routeKey, entries] of Object.entries(exportObj.routes)) {
      this.routes[routeKey] = new Map(); this.unissued[routeKey] = [];
      for (const e of entries || []) this._add(routeKey, {
        key_ID: e.key_ID, key: e.key, sizeBits: e.sizeBits, blockIndex: e.blockIndex,
        issuedToMaster: false, issuedToSlave: false,
      });
    }
  }

  seedDemo(routeKey = "ANK-IST", count = 5, sizeBits = DEFAULT_KEY_SIZE_BITS) {
    // Sentetik ama GERÇEK rastgele (crypto.randomBytes) anahtarlarla — yalnızca
    // sunucunun kendi kendini test etmesi için, PhotonNet'in ürettiği GERÇEK
    // finite-key-kanıtlı anahtarların YERİNE GEÇMEZ.
    for (let i = 0; i < count; i++) {
      const byteLen = Math.ceil(sizeBits / 8);
      const key = crypto.randomBytes(byteLen).toString("base64");
      this._add(routeKey, {
        key_ID: crypto.randomUUID(), key, sizeBits, blockIndex: i + 1,
        issuedToMaster: false, issuedToSlave: false,
      });
    }
  }

  availableCount(routeKey) {
    // Bakımlı sayaç — O(1). Eskiden O(n) filter idi.
    return (this.unissued[routeKey] || []).length;
  }

  // Master SAE çağırır (enc_keys) — henüz kimseye verilmemiş `n` anahtarı
  // FIFO sırayla ayırır ve issuedToMaster=true işaretler.
  takeForMaster(routeKey, n, sizeBits) {
    const map = this.routes[routeKey] || new Map();
    const queue = this.unissued[routeKey] || [];
    if (sizeBits != null && queue.length) {
      // Boyut homojen — ilk un-issued kaydı kontrol etmek yeterli.
      const first = map.get(queue[0]);
      if (first && first.sizeBits !== sizeBits) {
        throw new KMEError(400, `İstenen anahtar boyutu (${sizeBits} bit) depodaki anahtar boyutuyla (${first.sizeBits} bit) eşleşmiyor — bu referans KME, ZATEN ÜRETİLMİŞ sabit-boyutlu finite-key bloklarını dinamik olarak yeniden boyutlandırmaz (gerçek KME'ler XOR-birleştirme ile bunu destekleyebilir, bu basitleştirilmiş demo desteklemiyor)`);
      }
    }
    if (queue.length < n) {
      throw new KMEError(503, `Yetersiz anahtar stoku: istenen=${n}, mevcut=${queue.length} (rota=${routeKey}) — PhotonNet tarayıcısında daha fazla blok tamamlanmasını bekleyin ve KME deposunu yeniden dışa aktarın`);
    }
    const ids = queue.splice(0, n);             // FIFO ön-uçtan O(n_taken)
    const chosen = ids.map(id => map.get(id));
    for (const e of chosen) e.issuedToMaster = true;
    this.deliveredCount += chosen.length;
    return chosen;
  }

  // Slave SAE çağırır (dec_keys) — master'a ZATEN verilmiş ama slave'e
  // HENÜZ verilmemiş anahtarları key_ID'ye göre bulur. Her iki tarafa da
  // teslim edilen anahtar, GÜVENLİK GEREĞİ depodan SİLİNİR (bir daha asla
  // servis edilemez — replay/çift-kullanım engellenir).
  takeForSlave(routeKey, keyIds) {
    const map = this.routes[routeKey] || new Map();
    const results = [];
    for (const id of keyIds) {
      const entry = map.get(id);               // O(1) — eskiden O(n) findIndex
      if (!entry) throw new KMEError(400, `key_ID bulunamadı (rota=${routeKey}): ${id}`);
      if (!entry.issuedToMaster) throw new KMEError(400, `key_ID henüz master SAE'ye teslim edilmemiş, slave tarafından çekilemez: ${id}`);
      if (entry.issuedToSlave) throw new KMEError(400, `key_ID DAHA ÖNCE slave SAE'ye teslim edilmiş — TEKRAR KULLANIM (replay) reddedildi: ${id}`);
      entry.issuedToSlave = true;
      results.push(entry);
    }
    // Her iki tarafa da teslim edilenleri depodan kalıcı olarak sil (zeroize).
    for (const id of keyIds) {
      const entry = map.get(id);
      if (entry && entry.issuedToSlave) {
        map.delete(id);                        // O(1) — eskiden O(n) splice
        this.destroyedCount++;
      }
    }
    return results;
  }
}

class KMEError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

const store = new KMEKeyStore();

if (args["seed-demo"]) {
  store.seedDemo("ANK-IST", 5, DEFAULT_KEY_SIZE_BITS);
  console.log("[KME] Sentetik demo anahtarları yüklendi: rota=ANK-IST, 5 anahtar × 256bit (SAE-ANK <-> SAE-IST)");
} else if (args.keystore) {
  const raw = JSON.parse(fs.readFileSync(args.keystore, "utf8"));
  store.loadFromExport(raw);
  const routeCounts = Object.entries(store.routes).map(([k, v]) => `${k}:${v.size}`).join(", ");
  console.log(`[KME] '${args.keystore}' içe aktarıldı — rotalar: ${routeCounts || "(boş)"}`);
} else {
  console.log("[KME] UYARI: --keystore veya --seed-demo verilmedi, depo BOŞ başlıyor. Anahtar eklemek için PhotonNet'in '🔐 KME Anahtar Deposu' JSON'unu --keystore ile verin.");
}

// ── HTTP yardımcıları ──────────────────────────────────────────────
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── KİMLİK DOĞRULAMA — GERÇEK mTLS (--cert/--key/--ca hepsi verildiğinde)
// veya (yalnızca yerel demo için) header-tabanlı geri düşüş.
//
// GERÇEK mTLS MODU (MTLS_ENABLED=true): https.createServer'a requestCert:
// true + rejectUnauthorized:true + ca:[CA sertifikası] verildiğinde, Node.js
// TLS KATMANINDA (uygulama kodu ÇALIŞMADAN ÖNCE) istemcinin sunduğu
// sertifikayı CA'ya karşı doğrular — CA tarafından imzalanmamış/eksik bir
// sertifikayla gelen bağlantı TLS handshake AŞAMASINDA reddedilir (bu
// fonksiyon hiç çağrılmaz bile). Bu noktaya ulaşan her istek zaten
// KRİPTOGRAFİK OLARAK doğrulanmış bir istemci sertifikasına sahiptir — SAE
// kimliği bu sertifikanın Subject CN alanından okunur (ETSI GS QKD 014'ün
// öngördüğü GERÇEK model: HTTP header'ı DEĞİL, TLS istemci sertifikası SAE
// kimliğinin kaynağıdır).
//
// PROD-STRIP-BEGIN: demo-auth-doc-fallback-comment
// GERİ DÜŞÜŞ MODU (MTLS_ENABLED=false — --ca verilmediğinde): header-tabanlı
// bir demo temsilcisi mTLS'in YERİNE GEÇER — ÜRETİMDE KULLANILMAMALIDIR
// (bkz. dosya-üstü ve başlangıç log'undaki İKAZ).
// PROD-STRIP-END: demo-auth-doc-fallback-comment
// PROD-REPLACE-TEXT-BEGIN: demo-auth-doc-fallback-comment
// Bu ÜRETİM DERLEMESİNDE MTLS_ENABLED her zaman true'dur — header-tabanlı
// geri düşüş modu fiziksel olarak YOKTUR.
// PROD-REPLACE-TEXT-END: demo-auth-doc-fallback-comment
//
// ── OCSP (İKİNCİ, CANLI İPTAL KATMANI) ──────────────────────────────
// --ocsp-responder=<url> verildiğinde, mTLS ile doğrulanmış her istemci
// sertifikasının seri numarası için openssl'in `ocsp` istemci komutu bir
// alt-süreç olarak çalıştırılır ve yanıtlayıcıya (bkz. pki_tools/
// run_ocsp_responder.sh) "bu sertifika hâlâ geçerli mi?" diye SORULUR.
// CRL'nin aksine (periyodik/dosya-tabanlı), bu her istekte ANLIK bir
// sorgudur — iptal, CRL yeniden dağıtılmadan HEMEN etkili olur. Bedeli:
// gecikme (her isteğe bir alt-süreç çağrısı) — bu yüzden kısa TTL'li
// (varsayılan 30 saniye) bir bellek-içi önbellek kullanılır; TTL süresi
// boyunca AYNI sertifika için tekrar sorgu YAPILMAZ (performans/tazelik
// dengesi — İKAZ: bu, iptal edilen bir sertifikanın önbellek TTL'i kadar
// bir süre daha kabul edilebileceği anlamına gelir; TTL'i düşürerek bu
// pencereyi daraltabilirsiniz).
const OCSP_CACHE = new Map(); // "issuerHash:serial" -> { status, expiresAt }
const OCSP_CACHE_TTL_MS = 30_000;

function checkOcsp(cert, caCertPath) {
  return new Promise((resolve) => {
    if (!args["ocsp-responder"]) { resolve({ ok: true, skipped: true }); return; }
    const serial = cert.serialNumber;
    const cacheKey = serial;
    const cached = OCSP_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { resolve(cached.result); return; }

    // openssl'in kendi OCSP istemcisini alt-süreç olarak kullanıyoruz —
    // ASN.1 OCSP istek/yanıt kodlamasını sıfırdan YENİDEN YAZMAK yerine
    // (hataya çok açık bir alan) openssl'in olgun/denenmiş uygulamasına
    // güveniyoruz. Sertifika PEM'i geçici bir dosyaya yazılır (execFile
    // shell enjeksiyonuna KAPALIDIR, komut satırı argümanları olarak
    // geçirilir — bu güvenlik açısından ÖNEMLİDİR).
    const tmpCert = fs.mkdtempSync(require("os").tmpdir() + "/ocsp-") + "/peer.pem";
    fs.writeFileSync(tmpCert, cert.raw ? `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n` : "");
    execFile("openssl", [
      "ocsp", "-issuer", caCertPath, "-cert", tmpCert,
      "-url", args["ocsp-responder"], "-CAfile", caCertPath, "-timeout", "3",
    ], { timeout: 4000 }, (err, stdout, stderr) => {
      fs.rm(tmpCert, { force: true }, () => {});
      const out = `${stdout}\n${stderr}`;
      let result;
      if (/: revoked/i.test(out)) result = { ok: false, reason: "OCSP: sertifika İPTAL EDİLMİŞ" };
      else if (/: good/i.test(out)) result = { ok: true };
      else result = { ok: false, reason: `OCSP yanıtlayıcıya ulaşılamadı/anlaşılamadı (fail-CLOSED — İKAZ: yanıtlayıcı çökerse istekler REDDEDİLİR): ${err ? err.message : out.slice(0, 200)}` };
      OCSP_CACHE.set(cacheKey, { result, expiresAt: Date.now() + OCSP_CACHE_TTL_MS });
      resolve(result);
    });
  });
}

async function authenticate(req) {
  if (MTLS_ENABLED) {
    const sock = req.socket;
    if (!sock.authorized) {
      // rejectUnauthorized:true ile normalde BURAYA HİÇ ULAŞILMAZ (bağlantı
      // TLS seviyesinde zaten kesilir) — bu, savunma-derinliği (defense in
      // depth) amaçlı ikinci bir kontrol.
      throw new KMEError(401, `mTLS istemci sertifikası doğrulanamadı: ${sock.authorizationError || "bilinmeyen hata"}`);
    }
    const cert = sock.getPeerCertificate();
    const cn = cert && cert.subject && cert.subject.CN;
    if (!cn) throw new KMEError(401, "İstemci sertifikasında Subject CN (SAE kimliği) bulunamadı");
    if (args["ocsp-responder"]) {
      const ocsp = await checkOcsp(cert, args.ca);
      if (!ocsp.ok) throw new KMEError(401, ocsp.reason || "OCSP doğrulaması başarısız");
    }
    return cn;
  }
  // PROD-STRIP-BEGIN: demo-auth-fallback
  // ── Geri düşüş: header-tabanlı demo kimlik doğrulaması ──
  const auth = req.headers["authorization"] || "";
  const saeId = req.headers["x-sae-id"];
  if (!saeId) throw new KMEError(401, "X-SAE-ID header eksik — çağıran SAE kimliği belirtilmedi");
  if (auth !== `Bearer ${AUTH_TOKEN}`) throw new KMEError(401, "Authorization header geçersiz — bkz. --sae-token (İKAZ: bu demo kimlik doğrulaması mTLS'in YERİNE GEÇMEZ, yalnızca yerel test içindir — gerçek mTLS için --cert/--key/--ca üçünü birlikte verin, bkz. pki_tools/)");
  return saeId;
  // PROD-STRIP-END: demo-auth-fallback
  // PROD-REPLACE-BEGIN: demo-auth-fallback
  /*
  throw new KMEError(401, "Üretim derlemesi: mTLS ZORUNLUDUR — header-tabanlı kimlik doğrulama bu derlemede fiziksel olarak SÖKÜLMÜŞTÜR (bkz. bb84/build_production_server.js).");
  */
  // PROD-REPLACE-END: demo-auth-fallback
}

// ── ETSI 014 uç noktaları ──────────────────────────────────────────
const ROUTE_RE = {
  status: /^\/api\/v1\/keys\/([^/]+)\/status$/,
  enc_keys: /^\/api\/v1\/keys\/([^/]+)\/enc_keys$/,
  dec_keys: /^\/api\/v1\/keys\/([^/]+)\/dec_keys$/,
};

async function handleStatus(req, res, counterpartSaeId) {
  const callerSaeId = await authenticate(req); // bu çağrıda "master" rolündeki taraf
  const routeKey = KMEKeyStore.routeKeyFromSAEPair(callerSaeId, counterpartSaeId);
  const avail = store.availableCount(routeKey);
  // ETSI GS QKD 014 §6.1 "Status" JSON alanları:
  sendJson(res, 200, {
    source_KME_ID: "PhotonNet-KME-1",
    target_KME_ID: "PhotonNet-KME-1", // bu referans sunucuda tek KME örneği hem master hem slave'e hizmet eder (bkz. dosya-üstü mimari notu)
    master_SAE_ID: callerSaeId,
    slave_SAE_ID: counterpartSaeId,
    key_size: DEFAULT_KEY_SIZE_BITS,
    stored_key_count: avail,
    max_key_count: 100000,
    max_key_per_request: 128,
    max_key_size: 4096,
    min_key_size: 8,
    max_SAE_ID_count: 0, // çoklu-yayın (multicast) desteklenmiyor
    status_extension: {
      photonnet_note: "Bu KME yalnızca CascadeReconciliation.reconcile() ile residualErrors=0 doğrulanmış VE QKDSecurityProof.secureKeyLengthWithMu() ile ℓ>0 finite-key-kanıtlı bloklardan üretilmiş anahtarları servis eder.",
    },
  });
}

async function handleEncKeys(req, res, slaveSaeId) {
  const masterSaeId = await authenticate(req);
  const routeKey = KMEKeyStore.routeKeyFromSAEPair(masterSaeId, slaveSaeId);

  let params = {};
  if (req.method === "POST") {
    const raw = await readBody(req);
    if (raw) { try { params = JSON.parse(raw); } catch { throw new KMEError(400, "İstek gövdesi geçerli JSON değil"); } }
  } else {
    const u = new URL(req.url, "http://x");
    if (u.searchParams.has("number")) params.number = parseInt(u.searchParams.get("number"), 10);
    if (u.searchParams.has("size")) params.size = parseInt(u.searchParams.get("size"), 10);
  }
  const number = params.number ?? 1;
  if (!Number.isInteger(number) || number < 1 || number > 128) throw new KMEError(400, "'number' 1-128 aralığında bir tam sayı olmalı (max_key_per_request)");

  const chosen = store.takeForMaster(routeKey, number, params.size ?? null);
  sendJson(res, 200, { keys: chosen.map(e => ({ key_ID: e.key_ID, key: e.key })) });
}

async function handleDecKeys(req, res, masterSaeId) {
  const slaveSaeId = await authenticate(req);
  const routeKey = KMEKeyStore.routeKeyFromSAEPair(slaveSaeId, masterSaeId);

  let keyIds = [];
  if (req.method === "POST") {
    const raw = await readBody(req);
    let params = {};
    if (raw) { try { params = JSON.parse(raw); } catch { throw new KMEError(400, "İstek gövdesi geçerli JSON değil"); } }
    if (!Array.isArray(params.key_IDs) || !params.key_IDs.length) throw new KMEError(400, "'key_IDs' dizisi (en az 1 eleman) gerekli — biçim: [{\"key_ID\":\"<uuid>\"}]");
    keyIds = params.key_IDs.map(k => (typeof k === "string" ? k : k.key_ID));
  } else {
    const u = new URL(req.url, "http://x");
    const single = u.searchParams.get("key_ID");
    if (!single) throw new KMEError(400, "'key_ID' query parametresi gerekli (GET biçimi)");
    keyIds = [single];
  }

  const chosen = store.takeForSlave(routeKey, keyIds);
  sendJson(res, 200, { keys: chosen.map(e => ({ key_ID: e.key_ID, key: e.key })) });
}

const server_handler = async (req, res) => {
  try {
    const path = req.url.split("?")[0];
    let m;
    if ((m = path.match(ROUTE_RE.status)) && req.method === "GET") {
      await handleStatus(req, res, decodeURIComponent(m[1]));
    } else if ((m = path.match(ROUTE_RE.enc_keys)) && (req.method === "POST" || req.method === "GET")) {
      await handleEncKeys(req, res, decodeURIComponent(m[1]));
    } else if ((m = path.match(ROUTE_RE.dec_keys)) && (req.method === "POST" || req.method === "GET")) {
      await handleDecKeys(req, res, decodeURIComponent(m[1]));
    } else {
      sendJson(res, 404, { message: "Bilinmeyen ETSI 014 uç noktası", path, method: req.method });
    }
  } catch (e) {
    if (e instanceof KMEError) {
      sendJson(res, e.statusCode, { message: e.message });
    } else {
      console.error("[KME] Beklenmeyen hata:", e);
      sendJson(res, 500, { message: "Sunucu iç hatası" });
    }
  }
};

let server;
let modeDesc;
if (args.cert && args.key && args.ca) {
  // ── GERÇEK mTLS MODU — ETSI GS QKD 014 uyumlu ──
  // requestCert:true  → istemciden sertifika İSTENİR
  // rejectUnauthorized:true → CA'ya karşı doğrulanamayan/sunulmayan/İPTAL
  //   EDİLMİŞ (crl verilmişse) sertifikalar TLS HANDSHAKE aşamasında
  //   reddedilir — uygulama kodu (authenticate()) yalnızca ZATEN
  //   kriptografik olarak doğrulanmış istemcileri görür.
  // ca:[...] → yalnızca BU CA'nın imzaladığı istemci sertifikaları kabul edilir
  //   (bkz. pki_tools/ca_init.sh — SAE'lere dağıtılan sertifikaları imzalayan CA).
  // crl:[...] (opsiyonel) → CA'ya karşı GEÇERLİ olsa bile, BU listede
  //   (pki_tools/revoke_cert.sh'in ürettiği) seri numarası bulunan
  //   sertifikalar YİNE DE reddedilir — bkz. pki_tools/revoke_cert.sh.
  const secureOpts = {
    cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key),
    ca: [fs.readFileSync(args.ca)], requestCert: true, rejectUnauthorized: true,
  };
  if (args.crl) secureOpts.crl = [fs.readFileSync(args.crl)];
  server = https.createServer(secureOpts, server_handler);
  MTLS_ENABLED = true;
  modeDesc = `https (GERÇEK mTLS ETKİN — istemciler CA-imzalı sertifika SUNMAK ZORUNDA${args.crl ? "; CRL iptal kontrolü AKTİF" : ""}${args["ocsp-responder"] ? "; OCSP canlı iptal kontrolü AKTİF" : ""})`;
  // TLS handshake reddedilen bağlantıları (yanlış/eksik/CA-dışı/İPTAL
  // EDİLMİŞ sertifika) GÖZLEMLENEBİLİRLİK için logla — istemciye HİÇBİR
  // ek bilgi SIZDIRILMAZ (bağlantı zaten TLS seviyesinde kesildi),
  // yalnızca sunucu tarafında kayıt.
  server.on("tlsClientError", (err, tlsSocket) => {
    console.warn(`[KME] mTLS handshake reddedildi (${tlsSocket && tlsSocket.remoteAddress || "?"}): ${err.message}`);
  });

  // ── CRL HOT-RELOAD ── pki_tools/revoke_cert.sh çalıştırıldığında
  // sunucuyu YENİDEN BAŞLATMAYA GEREK KALMASIN diye CRL dosyasını izler
  // ve değiştiğinde https.Server.setSecureContext ile TLS bağlamını
  // CANLI günceller (yeni bağlantılar HEMEN yeni CRL'e göre değerlendirilir
  // — zaten açık bağlantılar etkilenmez, yalnızca TLS handshake seviyesinde
  // etkilidir, bu ETSI 014'ün "her istek yeni bir istemcinin bağlanması"
  // modeliyle uyumludur çünkü bu API'de kalıcı bağlantı tutulmaz).
  if (args.crl) {
    fs.watchFile(args.crl, { interval: 2000 }, () => {
      try {
        server.setSecureContext({ ...secureOpts, crl: [fs.readFileSync(args.crl)] });
        console.log(`[KME] CRL yeniden yüklendi (${args.crl}) — yeni bağlantılar güncel iptal listesine göre değerlendirilecek.`);
      } catch (e) {
        console.error(`[KME] CRL yeniden yükleme HATASI (eski CRL kullanılmaya devam ediliyor): ${e.message}`);
      }
    });
  }
}
// PROD-STRIP-BEGIN: demo-server-modes
else if (args.cert && args.key) {
  server = https.createServer({ cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) }, server_handler);
  modeDesc = "https (yalnızca SUNUCU kimliği doğrulanıyor — istemci mTLS'i KAPALI, --ca verilmedi)";
  console.log("[KME] İKAZ: --ca verilmedi — mTLS (istemci sertifikası doğrulaması) DEVRE DIŞI. SAE kimliği hâlâ X-SAE-ID header'ından okunuyor (demo). Gerçek mTLS için --ca=<CA sertifikası> da verin (bkz. pki_tools/).");
} else {
  server = http.createServer(server_handler);
  modeDesc = "http (İKAZ: TLS YOK — yalnızca yerel demo)";
  console.log("[KME] İKAZ: --cert/--key verilmedi — düz HTTP ile başlatılıyor. ETSI GS QKD 014 ÜRETİMDE (S)TLS + karşılıklı istemci sertifikası doğrulaması ZORUNLU KILAR. Bu mod SADECE yerel demo/entegrasyon testi içindir.");
}
// PROD-STRIP-END: demo-server-modes
// PROD-REPLACE-BEGIN: demo-server-modes
/*
else {
  throw new Error("Üretim derlemesi: --cert/--key/--ca üçü BİRLİKTE verilmelidir (mTLS zorunlu) — header-tabanlı/TLS'siz geri düşüş modları bu derlemede fiziksel olarak SÖKÜLMÜŞTÜR (bkz. bb84/build_production_server.js). Sunucu BAŞLATILMIYOR.");
}
*/
// PROD-REPLACE-END: demo-server-modes

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[KME] ETSI GS QKD 014 referans sunucusu dinliyor: ${args.cert ? "https" : "http"}://localhost:${PORT} — mod: ${modeDesc}`);
    // PROD-STRIP-BEGIN: demo-auth-token-log
    if (!MTLS_ENABLED) console.log(`[KME] Kimlik doğrulama token'ı (demo, yalnızca header-modunda kullanılır): ${AUTH_TOKEN}`);
    // PROD-STRIP-END: demo-auth-token-log
  });
}

module.exports = { KMEKeyStore, KMEError, store, server };
