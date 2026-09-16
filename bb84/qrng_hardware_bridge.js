#!/usr/bin/env node
"use strict";
/**
 * qrng_hardware_bridge.js — GERÇEK/harici bir entropi kaynağını (donanım
 * QRNG dongle'ı veya en azından işletim sistemi CSPRNG'i) `hal/bridge_server.py`
 * üzerinden çekip, `timetag_acquisition_bridge.js`'in ZATEN var olan
 * `opts.qrng` "seam"iyle (B2, bkz. o dosyanın baş yorumu) BİREBİR UYUMLU
 * `{ bit(): 0|1 }` sözleşmesini uygulayan Node.js istemcisi.
 * ═══════════════════════════════════════════════════════════════════
 * NEDEN BU DOSYA VAR (bkz. `hal/qrng_interface.py`'nin baş yorumu — AYNI
 * gerekçe): `bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md`'nin bulduğu sorun,
 * mulberry32'nin 32-bit tohum uzayının kaba-kuvvetle kırılabilir
 * olmasıdır. "mulberry32'ye daha rastgele bir tohum vermek" bunu ÇÖZMEZ
 * — çıktı hâlâ o 32-bit tohumdan DETERMİNİSTİK türer. Doğru çözüm,
 * güvenlik-kritik baz/bit seçimini mulberry32'yi TAMAMEN BY-PASS EDEREK
 * doğrudan (gerçek donanım destekli) bir entropi akışından okumaktır —
 * bu dosya TAM OLARAK BUNU yapar, ve zaten var olan `opts.qrng` seam'ine
 * hiçbir DEĞİŞİKLİK YAPMADAN takılır (bkz. aşağıdaki KULLANIM).
 *
 * FAIL-CLOSED TASARIM (kritik): bu istemci, HAL köprüsü ULAŞILAMAZ veya
 * UNHEALTHY (RCT/APT başarısız) olduğunda `Math.random()`/mulberry32'ye
 * SESSİZCE düşmez — bunun yerine AÇIKÇA fırlatır (throw). Bir güvenlik-
 * kritik entropi kaynağının "bozulunca sessizce daha kötü bir kaynağa
 * geçmesi", projenin fail-closed felsefesiyle (bkz. production_gate.js,
 * network_shielding_bridge.js) DOĞRUDAN ÇELİŞİR — asıl mulberry32
 * sorununu ÇÖZERKEN AYNI SINIF bir yeni sorunu yeniden AÇMAK olurdu.
 *
 * TAMPON MİMARİSİ: `qrngHealth(factory,label)` (production_gate.js) senkron
 * çalışır — `factory()` çağrılıp dönen nesnenin `.bit()`'i SENKRON, ağ
 * beklemeden okunabilmelidir. Bu yüzden istemci önce `warmUp()` ile
 * ASENKRON bir tampon doldurur, `.bit()` SONRA bu tampondan senkron
 * tüketir; tampon eşiğin altına düşünce arka planda bir YENİLEME (refill)
 * başlatılır (fire-and-forget DEĞİL — bkz. qkdnetsim_traffic_bridge.js'in
 * Kaos Müh. #9 düzeltmesi — burada `_pendingRefill` ile TAKİP edilir).
 * Tampon TAMAMEN tükenirse `.bit()` throw eder (kısmi/bayat veri KULLANMAZ).
 *
 * KULLANIM (mevcut hiçbir dosya DEĞİŞMEDEN):
 *   const { HardwareQrngClient } = require("./qrng_hardware_bridge.js");
 *   const client = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:8765" });
 *   await client.warmUp(4096);   // en az 4096 bit'lik tampon doldur
 *   const { TimeTagEmulator } = require("./timetag_acquisition_bridge.js");
 *   const emu = new TimeTagEmulator({ ...opts, qrng: client });  // seam'e tak
 */
const http = require("http");
const https = require("https");

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    let settled = false;
    const req = lib.get(url, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ham bırak */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on("error", (e) => { if (settled) return; settled = true; reject(e); });
    req.setTimeout(timeoutMs, () => {
      if (settled) return; settled = true;
      req.destroy();
      reject(new Error(`QRNG köprüsü ${timeoutMs}ms içinde yanıt vermedi: ${url}`));
    });
  });
}

class QrngBridgeError extends Error {}

/**
 * `opts.baseUrl`         — hal/bridge_server.py'nin adresi (varsayılan http://127.0.0.1:8765)
 * `opts.batchBytes`      — her HTTP çağrısında istenecek bayt sayısı (varsayılan 1024)
 * `opts.refillThresholdBits` — tampon bu değerin ALTINA düşünce arka plan yenilemesi tetiklenir
 * `opts.timeoutMs`       — tek bir HTTP çağrısının bütçesi (varsayılan 5000)
 */
class HardwareQrngClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || "http://127.0.0.1:8765";
    this.batchBytes = opts.batchBytes || 1024;
    this.refillThresholdBits = opts.refillThresholdBits ?? this.batchBytes * 8 * 0.25;
    this.timeoutMs = opts.timeoutMs || 5000;
    this._bitBuffer = [];      // her eleman 0|1 — LIFO/FIFO farketmez, pop() ile tüketilir
    this._pendingRefill = null; // TAKİP EDİLEN arka-plan yenileme Promise'i (Kaos Müh. #9 dersi)
    this._lastRefillError = null;
  }

  /** Tek bir HTTP GET ile bir parti bayt çeker; sunucu sağlık testini
   * BAŞARISIZ raporlarsa (503) veya erişilemezse throw eder — SESSİZCE
   * boş tampon/eski veri döndürmez. */
  async _fetchBatch() {
    const url = `${this.baseUrl}/api/qrng/bytes?n=${this.batchBytes}`;
    let res;
    try {
      res = await httpGetJson(url, this.timeoutMs);
    } catch (e) {
      throw new QrngBridgeError(`HAL QRNG köprüsüne erişilemedi (${this.baseUrl}) — mulberry32/Math.random'a SESSİZCE düşülmüyor: ${e.message}`);
    }
    if (!res.json || res.json.ok !== true) {
      const detail = res.json && res.json.error ? res.json.error : `HTTP ${res.status}`;
      throw new QrngBridgeError(`HAL QRNG köprüsü sağlıksız/reddetti (fail-closed): ${detail}`);
    }
    const bytes = Buffer.from(res.json.bytesBase64, "base64");
    const bits = [];
    for (const byte of bytes) for (let k = 0; k < 8; k++) bits.push((byte >> k) & 1);
    return { bits, health: res.json.health };
  }

  /** Tamponu en az `minBits` bit'e ulaşana kadar doldurur (senkron `.bit()`
   * çağrılarından ÖNCE bir kez çağrılmalı — bkz. modül başlığındaki
   * "TAMPON MİMARİSİ"). */
  async warmUp(minBits = this.batchBytes * 8) {
    while (this._bitBuffer.length < minBits) {
      const { bits } = await this._fetchBatch();
      this._bitBuffer.push(...bits);
    }
    return this._bitBuffer.length;
  }

  /** Tampon eşiğin altındaysa, TAKİP EDİLEN (fire-and-forget DEĞİL) bir
   * arka-plan yenilemesi başlatır. Zaten bir yenileme sürüyorsa yeni bir
   * istek AÇMAZ (aynı isteğin tekrar tekrar tetiklenmesini önler). */
  _maybeTriggerRefill() {
    if (this._pendingRefill) return;
    if (this._bitBuffer.length >= this.refillThresholdBits) return;
    this._pendingRefill = this._fetchBatch()
      .then(({ bits }) => { this._bitBuffer.push(...bits); this._lastRefillError = null; })
      .catch((e) => { this._lastRefillError = e; })  // AÇIKÇA saklanır — bit() bunu kontrol eder
      .finally(() => { this._pendingRefill = null; });
  }

  /** Sözleşme: `{ bit(): 0|1 }` — `timetag_acquisition_bridge.js`'in
   * `cryptoQrng()`/`seededQrng()` ile BİREBİR AYNI şekil. SENKRON çalışır
   * (tampon boşsa THROW eder — asenkron bir "bekle" YAPMAZ, çünkü bu
   * metodun çağrıldığı yerler, örn. TimeTagEmulator.run(), senkron bir
   * sıcak döngüdür). */
  bit() {
    if (this._bitBuffer.length === 0) {
      const reason = this._lastRefillError ? ` (son yenileme hatası: ${this._lastRefillError.message})` : "";
      throw new QrngBridgeError(
        `QRNG tamponu TÜKENDİ ve senkron bit() daha fazla ağ beklemesi yapamaz — ` +
        `warmUp() ile daha büyük bir tampon önceden doldurulmalı${reason}. ` +
        `FAIL-CLOSED: burada Math.random()/mulberry32'ye SESSİZCE düşülmüyor.`
      );
    }
    const b = this._bitBuffer.shift();
    this._maybeTriggerRefill();
    return b;
  }

  /** `production_gate.js`'in `qrngHealth(factory,label)`'ının beklediği
   * `factory()` biçimi — AYNI istemcinin (dolayısıyla AYNI, SÜREKLİ AKAN
   * gerçek entropi tamponunun) `{bit()}` görünümünü döner. `qrngHealth`
   * bunu İKİ KEZ çağırıp art arda 256 bit okur; ikisi de AYNI SÜREKLİ
   * akıştan geldiği için (mulberry32'nin AKSİNE, iki çağrı ARASINDA state
   * SIFIRLANMAZ) doğal olarak farklı bit dizileri üretirler — bu TAM
   * OLARAK `qrngHealth`'in "reproducible=false → fit=true" beklediği
   * davranıştır. */
  toQrngHealthFactory() {
    return () => ({ bit: () => this.bit() });
  }
}

module.exports = { HardwareQrngClient, QrngBridgeError };
