#!/usr/bin/env node
"use strict";
/**
 * mtls_failsafe_debounce.js — network_shielding_bridge.js'in SAF/durumsuz
 * mtlsHandshakePrecondition() fonksiyonunu, SÜREKLİ ÇALIŞAN bir dağıtımda
 * kullanılmak üzere İSTEĞE-BAĞLI, DURUMLU (stateful) bir zaman-histerezis
 * katmanıyla SARAR. Çekirdeğe dokunmaz; mtlsHandshakePrecondition()'ın
 * imzasını/davranışını da DEĞİŞTİRMEZ — mevcut tüm çağrı siteleri
 * (production_gate.js kriter-8/9, network_shielding_bridge_test.js,
 * hardware_aging_model_test.js) o saf fonksiyonu AYNEN kullanmaya devam
 * eder. Bu dosya YENİ, EK bir sınıf ihraç eder; hiçbir mevcut testi
 * etkilemez.
 * ═══════════════════════════════════════════════════════════════════
 * NEDEN GEREKLİ — "ERKEN ÖLÜM" (PREMATURE DEATH) PROBLEMİ (kullanıcı
 * geri bildirimi): EMERGENCY_SE_FLOOR_DB kontrolü (bkz. o dosyanın
 * başlığı) TEK BİR ÖLÇÜMe bakar. Sahada, cihazın yanından geçen bir
 * yüksek-gerilim hattı, bir anahtarlama transienti veya anlık bir EM
 * dalgası, kalkanlama ÖLÇÜMÜNÜ (kafesin FİZİKSEL durumu HİÇ bozulmadan)
 * bir örnekleme çevriminde tabanın altına düşürebilir. Saf fonksiyon bunu
 * "acil-durum ihlali" sayıp mTLS'i anında kilitler — YALANCI POZİTİF
 * (false positive): fiziksel katman sağlamken bağlantı gereksiz yere
 * kesilir. Fail-closed felsefesi burada TERS TEPER — sistem gereksiz
 * yere kendini durdurur (kullanılabilirlik kaybı), gerçek bir güvenlik
 * kazancı olmadan.
 *
 * ÇÖZÜM — İKİ KATMANLI ZAMAN-HİSTEREZİSİ (Schmitt-tetikleyici deseni),
 * BİLEREK ASİMETRİK ("şüphelenmede hızlı, iyileşmeye güvenmede yavaş"):
 *   1) DEBOUNCE (şüphe penceresi, debounceMs): OK durumundayken kötü bir
 *      okuma gelirse HEMEN bloklanmaz — "SUSPECT" durumuna geçilir ve
 *      etkin karar (effectiveAllowed) OK'te KALIR. Kötü durum debounceMs
 *      SÜREYLE KESİNTİSİZ sürerse ancak o zaman BLOCKED'a geçilir
 *      (gerçek, kalıcı bir arızanın kaçırılmadığından emin olmak için).
 *      Ara sırada tek bir iyi okuma gelirse SUSPECT sıfırlanır, OK'e
 *      dönülür — transient tamamen SÜZÜLÜR.
 *   2) KURTARMA HİSTEREZİSİ (recoveryHysteresisMs + recoveryMarginDb):
 *      BLOCKED durumundan çıkmak DAHA ZORDUR — kasıtlı olarak. Tek bir
 *      iyi okuma yetmez: SE, acil-durum tabanının recoveryMarginDb kadar
 *      ÜZERİNDE (Schmitt-tetikleyici marjı — tabana sürtünerek "iyileşti"
 *      denmesin) recoveryHysteresisMs SÜREYLE KESİNTİSİZ kalmalı. Bu süre
 *      döngüde KIRILIRSA (tekrar kötü/marjın altı okuma gelirse) kurtarma
 *      SAYACI SIFIRDAN başlar — "neredeyse iyileşti" kilidi açtırmaz.
 *
 * SOĞUK BAŞLANGIÇ İSTİSNASI (kritik güvenlik detayı): debounce SADECE
 * ÖNCEDEN DOĞRULANMIŞ bir OK durumunu korumak içindir. Bu sınıf henüz HİÇ
 * iyi okuma görmediyse (ilk ingest() çağrısı), kötü bir okuma HİÇBİR
 * gecikme OLMADAN anında BLOCKED üretir — yoksa arızalı bir sistem
 * başlatılırken debounceMs kadar "ücretsiz" bir mTLS penceresi açılırdı,
 * ki bu tam olarak fail-closed felsefesinin İHLALİDİR. Debounce bir
 * İYİMSERLİK ARACI DEĞİLDİR; SADECE zaten iyi bilinen bir durumu tek bir
 * gürültülü örneğe karşı korur.
 *
 * KALİBRASYON (GERÇEK EMC/ÖLÇÜM STANDARTLARINA DAYALI — kullanıcı talebiyle
 * GÜNCELLENDİ): önceki sürümde debounceMs/recoveryHysteresisMs/recoveryMarginDb
 * için "bu projede gerçek veri YOK" deniyordu. Bu artık YALNIZCA KISMEN doğru —
 * İKİ parametre şimdi YAYINLANMIŞ, saha-ölçümlü EMC/enstrümantasyon
 * standartlarından TÜRETİLİYOR (aşağıda), ÜÇÜNCÜSÜ (recoveryHysteresisMs'in
 * debounce'a ORANI) hâlâ dürüstçe bir MÜHENDİSLİK POLİTİKASI seçimidir:
 *
 *   (1) DEFAULT_DEBOUNCE_MS ← IEC 61000-4-4 (Elektriksel Hızlı Geçici Rejim/
 *       Burst bağışıklık testi — tam olarak kullanıcının tarif ettiği fiziği
 *       modeller: anahtarlama/kontak arklanması, yakın bir yüksek-gerilim
 *       hattındaki anahtarlama olayı). Standart, TEK bir "burst" epizodunu
 *       EFT_BURST_DURATION_MS=15 ms (onlarca ns'lik darbelerden oluşan bir
 *       trenin süresi) olarak, ve olası bir sonraki burst'e kadarki
 *       EFT_BURST_PERIOD_MS=300 ms'lik boşluğu tanımlar — yani belgelenmiş
 *       TEK bir hızlı-geçici-rejim döngüsü (burst+boşluk) en fazla 315 ms
 *       sürer. DEBOUNCE_SAFETY_FACTOR=2× uygulanarak (bir tam döngünün
 *       KESİNLİKLE bitmiş olmasını garanti etmek için) DEFAULT_DEBOUNCE_MS =
 *       630 ms elde edilir — belgelenmiş TEK bir standart olayın (315 ms)
 *       İKİ KATI. Karşılaştırma için: IEC 61000-4-5 (yıldırım-kaynaklı/
 *       anahtarlama sürgesi) 1.2/50 µs'lik gerilim dalga şeklini kullanır —
 *       TÜM olay ~50 µs'de biter, yani EFT/Burst'ten ~6000× KISADIR ve bu
 *       yüzden debounce boyutlandırmasında BAĞLAYICI OLAN EFT/Burst'tür.
 *       (Önceki sürümün 2000 ms'lik "illüstratif" tahmini, bu gerçek
 *       standart verilere göre GEREĞİNDEN FAZLA temkinliymiş — gerçek arıza
 *       tespiti artık ~3× daha hızlı, transient bağışıklığı KORUNARAK.)
 *   (2) DEFAULT_RECOVERY_MARGIN_DB ← IEEE Std 299 (kalkanlama etkinliği
 *       ölçüm standardı) KENDİ "dinamik aralık" tanımında bir sinyali ancak
 *       gürültü tabanının SE_DISCERNIBILITY_FLOOR_DB=3 dB veya daha
 *       ÜZERİNDEYKEN "ayırt edilebilir" sayar — bunun ALTINDAKİ bir
 *       "iyileşme" ölçüm gürültüsünden AYIRT EDİLEMEZ. Buna, yaygın bir
 *       ticari SE ölçüm cihazının (SEMS B) belgelenmiş doğruluğu olan
 *       TYPICAL_SE_INSTRUMENT_ACCURACY_DB=±1 dB'nin İKİ katı eklenerek
 *       (INSTRUMENT_ACCURACY_MARGIN_FACTOR=2 — cihaz belirsizliğine karşı
 *       ekstra tampon) DEFAULT_RECOVERY_MARGIN_DB = 3+2×1 = 5 dB elde
 *       edilir. SAYISAL DEĞER öncekiyle AYNI (5 dB) ama artık KEYFİ DEĞİL —
 *       IEEE 299'un kendi ayırt-edilebilirlik tanımından + gerçek bir
 *       enstrümanın doğruluğundan TÜRETİLİYOR.
 *   (3) DEFAULT_RECOVERY_HYSTERESIS_MS = DEFAULT_DEBOUNCE_MS × 10
 *       (RECOVERY_ASYMMETRY_FACTOR). Bu ORAN için bir EMC standardı YOK —
 *       "şüphelenmek hızlı, iyileşmeye güvenmek yavaş olmalı" ilkesi genel
 *       bir fail-safe/alarm mühendisliği pratiğidir (Schmitt-tetikleyici
 *       tasarımlarında yaygın), ama BELİRLİ ×10 katsayısı bu projenin
 *       DÜRÜSTÇE işaretlenmiş bir POLİTİKA seçimidir — 315 ms'lik EFT/Burst
 *       gibi ölçülmüş bir fiziksel olaya değil, "ne kadar temkinli olunsun"
 *       kararına dayanır.
 *
 * KALAN AÇIK VARSAYIM (dürüstlük notu): bu üç parametre de saniyenin
 * altı/civarı bir SE ÖRNEKLEME HIZI varsayar — ama bu projede gerçek bir SE
 * sensörünün ÖRNEKLEME ARALIĞI (ne kadar sıklıkla ölçüm alındığı) HİÇBİR
 * yerde belirtilmiyor. debounceMs'in "kaç ardışık örneğe" karşılık geldiği
 * bu nedenle dağıtıma özgü kalır — bkz. mtls_failsafe_debounce_test.js'teki
 * (I) kalibrasyon kontrolü ve (H) tatbikatındaki örnekleme-aralığı notu.
 */
const { mtlsHandshakePrecondition, EMERGENCY_SE_FLOOR_DB } = require("./network_shielding_bridge.js");

// ── (1) IEC 61000-4-4 — Elektriksel Hızlı Geçici Rejim/Burst ──
const EFT_BURST_DURATION_MS = 15;   // tek burst epizodunun süresi (onlarca ns'lik darbe treni)
const EFT_BURST_PERIOD_MS = 300;    // olası bir sonraki burst'e kadarki boşluk
const EFT_BURST_EPISODE_MS = EFT_BURST_DURATION_MS + EFT_BURST_PERIOD_MS; // = 315 ms — TEK belgelenmiş döngü
const DEBOUNCE_SAFETY_FACTOR = 2;   // bir tam döngünün KESİNLİKLE bittiğinden emin olmak için
// karşılaştırma/dürüstlük amaçlı: IEC 61000-4-5 sürge olayı ~50 µs sürer —
// EFT/Burst'ten (315 ms) ~6300× kısa, debounce boyutlandırmasında BAĞLAYICI DEĞİL.
const SURGE_EVENT_DURATION_US = 50;

// ── (2) IEEE Std 299 — kalkanlama etkinliği ölçüm ayırt-edilebilirliği ──
const SE_DISCERNIBILITY_FLOOR_DB = 3;          // IEEE 299 "dinamik aralık": bunun altı ayırt edilemez
const TYPICAL_SE_INSTRUMENT_ACCURACY_DB = 1;   // ör. SEMS B ölçüm cihazının belgelenmiş doğruluğu (±1 dB)
const INSTRUMENT_ACCURACY_MARGIN_FACTOR = 2;   // cihaz belirsizliğine karşı ekstra tampon (politika)

// ── (3) kurtarma/şüphe asimetrisi — POLİTİKA seçimi, standarttan DEĞİL ──
const RECOVERY_ASYMMETRY_FACTOR = 10;

const DEFAULT_DEBOUNCE_MS = EFT_BURST_EPISODE_MS * DEBOUNCE_SAFETY_FACTOR; // = 630 ms
const DEFAULT_RECOVERY_MARGIN_DB = SE_DISCERNIBILITY_FLOOR_DB + INSTRUMENT_ACCURACY_MARGIN_FACTOR * TYPICAL_SE_INSTRUMENT_ACCURACY_DB; // = 5 dB
const DEFAULT_RECOVERY_HYSTERESIS_MS = DEFAULT_DEBOUNCE_MS * RECOVERY_ASYMMETRY_FACTOR; // = 6300 ms

class SeFailsafeDebounce {
  constructor(opts = {}) {
    const {
      debounceMs = DEFAULT_DEBOUNCE_MS,
      recoveryHysteresisMs = DEFAULT_RECOVERY_HYSTERESIS_MS,
      recoveryMarginDb = DEFAULT_RECOVERY_MARGIN_DB,
      floorDb = EMERGENCY_SE_FLOOR_DB,
    } = opts;
    Object.assign(this, { debounceMs, recoveryHysteresisMs, recoveryMarginDb, floorDb });
    this.state = "OK";          // 'OK' | 'SUSPECT' | 'BLOCKED' | 'RECOVERING'
    this.hasSeenReading = false; // SOĞUK BAŞLANGIÇ ayrımı için
    this.sinceMs = null;         // mevcut geçici durumun (SUSPECT/RECOVERING) başladığı an
    this.transitions = [];       // teşhis/test için tam geçiş geçmişi
  }

  /**
   * cageEvaluation: evaluateFaradayCage()/applyFieldAging() çıktısı (veya
   * mtlsHandshakePrecondition'ın kabul ettiği herhangi bir şekil).
   * nowMs: test edilebilirlik için AÇIK zaman damgası (verilmezse Date.now()).
   * @returns {{effectiveAllowed, effectiveState, raw, reason, sinceMs, elapsedMs}}
   */
  ingest(cageEvaluation, nowMs = Date.now()) {
    const raw = mtlsHandshakePrecondition(cageEvaluation); // SAF fonksiyon — AYNEN, değiştirilmeden çağrılır
    const prevState = this.state;

    if (!this.hasSeenReading) {
      // SOĞUK BAŞLANGIÇ: korunacak bir "önceden doğrulanmış OK" durumu
      // henüz yok — debounce'a hak kazanılmamıştır. İlk okuma doğrudan
      // etkin durumu belirler (gecikme SIFIR).
      this.hasSeenReading = true;
      this.state = raw.allowed ? "OK" : "BLOCKED";
      this.sinceMs = null;
    } else if (this.state === "OK") {
      if (!raw.allowed) { this.state = "SUSPECT"; this.sinceMs = nowMs; }
      // raw.allowed === true → OK'te kal, sinceMs zaten null.
    } else if (this.state === "SUSPECT") {
      if (raw.allowed) {
        this.state = "OK"; this.sinceMs = null; // transient geçti — tamamen süzüldü
      } else if (nowMs - this.sinceMs >= this.debounceMs) {
        this.state = "BLOCKED"; this.sinceMs = null; // GERÇEK/kalıcı arıza doğrulandı
      }
      // aksi halde: hâlâ SUSPECT içinde, etkin karar OK olarak KALIR (aşağıda).
    } else if (this.state === "BLOCKED") {
      const recoveryGoodNow = raw.allowed && this._marginOk(raw);
      if (recoveryGoodNow) { this.state = "RECOVERING"; this.sinceMs = nowMs; }
      // aksi halde BLOCKED'ta kal.
    } else if (this.state === "RECOVERING") {
      const recoveryGoodNow = raw.allowed && this._marginOk(raw);
      if (!recoveryGoodNow) {
        this.state = "BLOCKED"; this.sinceMs = null; // kurtarma KIRILDI — sayaç SIFIRLANIR
      } else if (nowMs - this.sinceMs >= this.recoveryHysteresisMs) {
        this.state = "OK"; this.sinceMs = null; // sürdürülmüş, marjlı iyileşme doğrulandı
      }
      // aksi halde: hâlâ RECOVERING içinde, etkin karar BLOCKED olarak KALIR.
    }

    if (this.state !== prevState) this.transitions.push({ from: prevState, to: this.state, atMs: nowMs, seDb: raw.seDb });

    // Etkin karar: OK/SUSPECT → İZİN VERİLİR (SUSPECT hâlâ doğrulanmamış şüphe);
    // BLOCKED/RECOVERING → REDDEDİLİR (RECOVERING hâlâ doğrulanmamış iyileşme).
    const effectiveAllowed = this.state === "OK" || this.state === "SUSPECT";
    const elapsedMs = this.sinceMs != null ? nowMs - this.sinceMs : null;
    return {
      effectiveAllowed, effectiveState: this.state, raw,
      sinceMs: this.sinceMs, elapsedMs,
      reason: this._describe(raw, elapsedMs),
    };
  }

  _marginOk(raw) {
    // Schmitt-tetikleyici: tabana sürtünerek değil, rahat bir marjla üstünde.
    return raw.seDb == null ? false : raw.seDb >= this.floorDb + this.recoveryMarginDb;
  }

  _describe(raw, elapsedMs) {
    switch (this.state) {
      case "OK": return `OK — SAE↔KME mTLS el sıkışmasına İZİN VERİLİR (${raw.reason})`;
      case "SUSPECT": return `ŞÜPHELİ (debounce ${elapsedMs}/${this.debounceMs} ms) — önceden doğrulanmış OK durumu KORUNUYOR, henüz BLOKLANMADI (${raw.reason})`;
      case "BLOCKED": return `BLOKLU (fail-closed) — ${raw.reason}`;
      case "RECOVERING": return `İYİLEŞİYOR (kurtarma histerezisi ${elapsedMs}/${this.recoveryHysteresisMs} ms, marj eşiği SE ≥ ${this.floorDb + this.recoveryMarginDb} dB) — hâlâ BLOKLU, kilit AÇILMADI (${raw.reason})`;
      default: return raw.reason;
    }
  }

  /** Teşhis/gözlem amaçlı anlık durum görünümü (yan etkisiz). */
  snapshot() {
    return { state: this.state, sinceMs: this.sinceMs, hasSeenReading: this.hasSeenReading, transitions: this.transitions.slice() };
  }
}

module.exports = {
  SeFailsafeDebounce,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECOVERY_HYSTERESIS_MS,
  DEFAULT_RECOVERY_MARGIN_DB,
  // kalibrasyon gerekçelendirmesi — test/grafik tüketimi için ihraç edildi
  EFT_BURST_DURATION_MS, EFT_BURST_PERIOD_MS, EFT_BURST_EPISODE_MS, DEBOUNCE_SAFETY_FACTOR,
  SURGE_EVENT_DURATION_US,
  SE_DISCERNIBILITY_FLOOR_DB, TYPICAL_SE_INSTRUMENT_ACCURACY_DB, INSTRUMENT_ACCURACY_MARGIN_FACTOR,
  RECOVERY_ASYMMETRY_FACTOR,
};
