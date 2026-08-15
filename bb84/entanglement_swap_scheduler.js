#!/usr/bin/env node
"use strict";
/**
 * entanglement_swap_scheduler.js
 * ═══════════════════════════════════════════════════════════════════
 * entanglement_swap_concurrency_test.js'in (v1) ÜÇ SOMUT DARBOĞAZINI
 * gideren v2 motoru. v1 DOSYASI SİLİNMEDİ/DEĞİŞTİRİLMEDİ — karşılaştırma
 * tabanı olarak repoda duruyor, çünkü "iyileştirdim" iddiası ancak eski
 * hâl hâlâ çalıştırılabiliyorsa doğrulanabilir.
 *
 * v1'İN ÖLÇÜLEN DARBOĞAZLARI (65b460a koşumu):
 *   2000 ham denemeden yalnızca 5 nihai A-B çifti  →  verim %0.25
 *     • 747 kanalda kayboldu           (fizik — kaçınılmaz)
 *     • 653 BELLEK DOLU diye REDDEDİLDİ (algoritma — kaçınılabilir) ← 1
 *     • 154 arıtma başarısızlığı, 120 zaman aşımı (protokol+kapasite)  ← 2,3
 *
 * BU DOSYADAKİ ÜÇ İYİLEŞTİRME:
 *
 * 1) AKILLI DİNAMİK BELLEK KUYRUKLAMA (QuantumMemoryScheduler)
 *    v1: bellek doluysa gelen çift ANINDA REDDEDİLİR (naif FIFO).
 *    v2: dört mekanizma —
 *      (a) GERİ BASINÇ (backpressure): bellek doluyken foton ÜRETİLMEZ,
 *          deneme İLERİ ERTELENİR. Fiziksel olarak da doğrudur: boş
 *          bellek yuvası olmadığını ÖNCEDEN bilirsiniz, dolayısıyla o
 *          denemeyi harcamazsınız. Reddi ~0'a indirir, karşılığında
 *          toplam süreyi (makespan) uzatır — ikisi de raporlanır.
 *      (b) SADAKAT-FARKINDA YER DEĞİŞTİRME: bellek doluyken, en kötü
 *          sakinin GÜNCEL (dekoheransa uğramış) sadakati "artık hedefe
 *          ulaşamaz" seviyesindeyse, onu tahliye edip yeni/taze çifti
 *          alır. Ölü ağırlık taşımaz.
 *      (c) SON-TARİH ÖNCELİKLİ (EDF) SEÇİM: her çiftin "kullanılabilir
 *          sadakat tabanının altına düşmesine kalan süresi" hesaplanır;
 *          son tarihi yakın olanlar ÖNCE eşleştirilir.
 *      (d) SADAKAT-EŞLEŞTİRMELİ ÇİFTLEME: arıtma, girdi sadakatleri
 *          BİRBİRİNE YAKIN olduğunda en verimlidir. Sadakate göre
 *          sıralayıp komşu eşleştirir (en iyi-en iyiyle).
 *
 * 2) DEJMPS ARITMA (bellDejmpsStep)
 *    v1: BBPSSW — Werner durumu varsayar, tek bir F sayısı taşır.
 *    v2: TAM BELL-DİYAGONAL durum {I,X,Y,Z} (Pauli hata olasılıkları)
 *        taşınır ve DEJMPS özyinelemesi uygulanır. KRİTİK KAZANIM:
 *        buradaki gürültü SAF σ_z (faz) hatasıdır; BBPSSW bu yapıyı
 *        "twirl" ile Werner'e düzleştirip BİLGİ ATAR, DEJMPS ise yapıyı
 *        KULLANIR. Sayısal fark tek turda büyüktür:
 *          F=0.88 →  BBPSSW: 0.9100 (p=0.8528)
 *                    DEJMPS: 0.9818 (p=0.7888)
 *        DEJMPS'in başarı olasılığı daha DÜŞÜK ama tek turda hedefi
 *        aştığı için TOPLAM verim çok daha yüksektir (iki tur yerine bir).
 *    Ayrıca DOLANIKLIK TAKASI da artık Werner p1·p2 yaklaşımıyla değil,
 *    Pauli hata gruplarının GERÇEK KONVOLÜSYONUYLA hesaplanır.
 *
 * 3) GERÇEK FİBER FİZİĞİ (soyut "tur" ve "kapasite" kaldırıldı)
 *    v1: soyut turlar, tur başına elle konmuş 40'lık kapasite tavanı,
 *        birimi belirsiz T2.
 *    v2: her şey GERÇEK ZAMAN (ms) ve GERÇEK MESAFE (km):
 *      • Sönümleme:  η = 10^(−α·L/10),  α = 0.2 dB/km (SMF-28 @1550nm)
 *      • Fiberde ışık hızı: v = c/n,  n = 1.468  →  ~204.2 km/ms
 *      • Her klasik onay adımı L/v gecikmesi ÖDER (heralding, arıtma
 *        sonucu karşılaştırması, takas sonucunun uçlara bildirilmesi).
 *        "Kapasite" artık elle konmuş bir sayı DEĞİL, ışık hızının
 *        dayattığı DOĞAL bir sınırdır.
 *      • Bellek: T2 (faz dekoheransı) ve T1 (kübit kaybı) GERÇEK ms
 *        cinsinden, sürekli üstel yasalarla uygulanır.
 *      • Varsayılan mesafe, kullanıcının verdiği %35 kayıp
 *        spesifikasyonundan TÜRETİLİR: 10^(−0.02L)=0.65 → L=9.354 km.
 *        Böylece spesifikasyona sadık kalınır AMA mesafe artık taranabilir
 *        bir FİZİKSEL parametredir.
 * ═══════════════════════════════════════════════════════════════════
 */
const { mulberry32 } = require("./photonnet_core.js");

// ══════════════════════════════════════════════════════════
// BÖLÜM 1 — FİZİKSEL SABİTLER VE DENKLEMLER (gerçek birimler)
// ══════════════════════════════════════════════════════════
// Arıtmanın kurtarabildiği en düşük sadakat (0.5) üzerine eklenen pratik
// marj — tam eşikteki bir çift sonsuz yavaş yakınsar, bellekte yer işgal eder.
const FIDELITY_FLOOR_MARGIN = 0.01;

const C_VACUUM_KM_PER_MS = 299.792458;        // ışık hızı (km/ms)
const FIBER_REFRACTIVE_INDEX = 1.468;          // SMF-28 grup kırılma indisi @1550nm
const FIBER_V_KM_PER_MS = C_VACUUM_KM_PER_MS / FIBER_REFRACTIVE_INDEX; // ≈204.22 km/ms
const FIBER_ATTENUATION_DB_PER_KM = 0.2;       // SMF-28 @1550nm

/** Fiber geçirgenliği (Beer-Lambert, dB cinsinden sönümleme). */
function fiberTransmittance(km) {
  return Math.pow(10, -(FIBER_ATTENUATION_DB_PER_KM * km) / 10);
}
/** Verilen geçirgenliği üreten fiber uzunluğu (ters denklem). */
function kmForTransmittance(T) {
  return -10 * Math.log10(T) / FIBER_ATTENUATION_DB_PER_KM;
}
/** Tek yön fiber gecikmesi (ms) — ışık hızı sınırı. */
function fiberDelayMs(km) {
  return km / FIBER_V_KM_PER_MS;
}

// Kullanıcı spesifikasyonu %35 kayıp → bunu ÜRETEN gerçek fiber uzunluğu.
const SPEC_LOSS_RATE = 0.35;
const REFERENCE_KM = kmForTransmittance(1 - SPEC_LOSS_RATE); // ≈9.354 km

// Kullanıcı spesifikasyonu %12 faz hatası @referans mesafe → mesafeye
// bağlı, uzun mesafede 0.5'e DOYAN fiziksel bir yasaya kalibre edilir.
const SPEC_DEPHASE_RATE = 0.12;
const PHASE_LENGTH_KM = -REFERENCE_KM / Math.log(1 - 2 * SPEC_DEPHASE_RATE);
/** Fiberde biriken faz-hatası olasılığı (0.5'e doyar — tam rastgele faz). */
function phaseErrorForKm(km) {
  return 0.5 * (1 - Math.exp(-km / PHASE_LENGTH_KM));
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 2 — BELL-DİYAGONAL DURUM CEBRİ
// Durum, |Φ+> referansına göre Pauli hata olasılıklarıyla temsil edilir:
//   I = |Φ+> sadakati (hatasız),  X = bit çevirme (|Ψ+>),
//   Z = faz çevirme (|Φ->),       Y = her ikisi (|Ψ->)
// F ≡ I. Bu gösterim, Werner'in (tek sayı) AKSİNE gürültünün YAPISINI
// korur — DEJMPS'in BBPSSW'yi yenmesinin tek sebebi budur.
// ══════════════════════════════════════════════════════════
function bellState(I, X, Y, Z) { return { I, X, Y, Z }; }
function bellNormalize(s) {
  const t = s.I + s.X + s.Y + s.Z;
  return t > 0 ? bellState(s.I / t, s.X / t, s.Y / t, s.Z / t) : s;
}
function bellFidelity(s) { return s.I; }
/** Werner durumu (karşılaştırma/geriye uyum için). */
function wernerState(F) {
  const e = (1 - F) / 3;
  return bellState(F, e, e, e);
}

/** Süre t boyunca T2 faz dekoheransı: Z hatası olasılığı q ile karışım. */
function bellDephase(s, dtMs, t2Ms) {
  if (dtMs <= 0 || !(t2Ms > 0)) return s;
  const q = 0.5 * (1 - Math.exp(-dtMs / t2Ms)); // birikmiş faz-çevirme olasılığı
  return bellState(
    s.I * (1 - q) + s.Z * q,
    s.X * (1 - q) + s.Y * q,
    s.Y * (1 - q) + s.X * q,
    s.Z * (1 - q) + s.I * q,
  );
}

/**
 * DEJMPS arıtma adımı — İKİ YÖNELİM.
 * Çift-yönlü CNOT + hedef ölçümü, hataların BİR TÜRÜNÜ tespit eder:
 *   mode "X": bit-çevirme (X/Y) hatalarını tespit eder → Z hatalarını KÖTÜLEŞTİRİR
 *   mode "Z": faz-çevirme (Z/Y) hatalarını tespit eder → X hatalarını kötüleştirir
 * Gerçek DEJMPS, yerel Clifford dönüşleriyle bu iki yönelim arasında
 * geçiş yapar. Bizim gürültümüz SAF Z olduğu için "Z" yönelimi doğru
 * olandır; scheduler yine de her ikisini hesaplayıp SONUÇ SADAKATİ daha
 * yüksek olanı seçer (açgözlü yönelim seçimi — bu, ders kitabı DEJMPS'in
 * sabit dönüşüm sırasından farklı, BİLİNÇLİ bir mühendislik tercihidir
 * ve burada açıkça belirtilmektedir).
 */
function bellDejmpsStep(s, mode) {
  let p, out;
  if (mode === "X") {
    // X/Y (bit-çevirme) tespit edilir; I ile Z aynı "eşlik sınıfında".
    p = Math.pow(s.I + s.Z, 2) + Math.pow(s.X + s.Y, 2);
    if (p <= 0) return null;
    out = bellState(
      (s.I * s.I + s.Z * s.Z) / p,
      (s.X * s.X + s.Y * s.Y) / p,
      (2 * s.X * s.Y) / p,
      (2 * s.I * s.Z) / p,
    );
  } else {
    // Z/Y (faz-çevirme) tespit edilir; I ile X aynı eşlik sınıfında.
    p = Math.pow(s.I + s.X, 2) + Math.pow(s.Z + s.Y, 2);
    if (p <= 0) return null;
    out = bellState(
      (s.I * s.I + s.X * s.X) / p,
      (2 * s.I * s.X) / p,
      (2 * s.Z * s.Y) / p,
      (s.Z * s.Z + s.Y * s.Y) / p,
    );
  }
  return { state: bellNormalize(out), pSuccess: p, mode };
}

/**
 * ASİMETRİK DEJMPS — iki FARKLI durumun arıtılması.
 * ÖNEMLİ: girdiler ORTALANMAZ. (Bir ara sürümde ortalama alınıyordu; bu,
 * yüksek sadakatli bir çifti düşük sadakatli bir çiftle eşleştirdiğinde
 * iyi olanı BOZUYORDU ve 40 km üzerinde verimi sıfıra düşürüyordu.)
 * Doğru genelleme, iki durumun bileşenlerinin ÇAPRAZ ÇARPIMIDIR; özdeş
 * girdilerde simetrik formüle indirgenir (bkz. selfCheck).
 */
function dejmpsPurifyAsym(s1, s2, mode) {
  let p, out;
  if (mode === "X") {
    // X/Y (bit-çevirme) tespit edilir.
    p = (s1.I + s1.Z) * (s2.I + s2.Z) + (s1.X + s1.Y) * (s2.X + s2.Y);
    if (p <= 0) return null;
    out = bellState(
      (s1.I * s2.I + s1.Z * s2.Z) / p,
      (s1.X * s2.X + s1.Y * s2.Y) / p,
      (s1.X * s2.Y + s1.Y * s2.X) / p,
      (s1.I * s2.Z + s1.Z * s2.I) / p,
    );
  } else {
    // Z/Y (faz-çevirme) tespit edilir — bizim saf σ_z gürültümüz için doğru yönelim.
    p = (s1.I + s1.X) * (s2.I + s2.X) + (s1.Z + s1.Y) * (s2.Z + s2.Y);
    if (p <= 0) return null;
    out = bellState(
      (s1.I * s2.I + s1.X * s2.X) / p,
      (s1.I * s2.X + s1.X * s2.I) / p,
      (s1.Z * s2.Y + s1.Y * s2.Z) / p,
      (s1.Z * s2.Z + s1.Y * s2.Y) / p,
    );
  }
  return { state: bellNormalize(out), pSuccess: p, mode };
}

/** Açgözlü yönelim seçimiyle DEJMPS. */
function dejmpsPurify(sA, sB, orientation) {
  if (orientation) return dejmpsPurifyAsym(sA, sB, orientation);
  const candidates = [dejmpsPurifyAsym(sA, sB, "Z"), dejmpsPurifyAsym(sA, sB, "X")].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (c.state.I > best.state.I ? c : best));
}

/**
 * BBPSSW (v1 ile AYNI formül) — karşılaştırma tabanı.
 * Girdiyi ÖNCE Werner'e "twirl" eder (protokolün kendi varsayımı) —
 * yapısal bilgiyi burada kaybeder, DEJMPS'e karşı dezavantajı budur.
 */
function bbpsswPurify(sA, sB) {
  const Fin = (sA.I + sB.I) / 2;
  const t = (1 - Fin) / 3;
  const pSuccess = Fin * Fin + (2 * Fin * (1 - Fin)) / 3 + 5 * t * t;
  if (pSuccess <= 0) return null;
  const Fout = (Fin * Fin + t * t) / pSuccess;
  return { state: wernerState(Fout), pSuccess, mode: "werner-twirl" };
}

/**
 * DOLANIKLIK TAKASI — Pauli hata gruplarının GERÇEK konvolüsyonu.
 * v1'deki Werner p1·p2 yaklaşımının yerine geçer: iki bağın hataları
 * bağımsızca birleşir ve takas sonrası hata dağılımı, iki dağılımın
 * (Z2×Z2 Pauli grubu üzerinde) grup konvolüsyonudur. Werner girdilerde
 * bu, p1·p2 sonucuna İNDİRGENİR (bkz. selfCheck).
 */
function bellSwap(s1, s2) {
  return bellNormalize(bellState(
    s1.I * s2.I + s1.X * s2.X + s1.Y * s2.Y + s1.Z * s2.Z,
    s1.I * s2.X + s1.X * s2.I + s1.Y * s2.Z + s1.Z * s2.Y,
    s1.I * s2.Y + s1.Y * s2.I + s1.X * s2.Z + s1.Z * s2.X,
    s1.I * s2.Z + s1.Z * s2.I + s1.X * s2.Y + s1.Y * s2.X,
  ));
}

/** İki simetrik bağın hedef nihai sadakati için gereken BAĞ BAŞI sadakat. */
function requiredLinkFidelity(targetFinalF, linkState) {
  // Saf faz gürültüsü için: I'' = a² + z² (z=1−a) → 2a²−2a+1 = hedef
  // → a = (1 + sqrt(2·hedef − 1)) / 2
  if (linkState === "dephasing") return (1 + Math.sqrt(2 * targetFinalF - 1)) / 2;
  // Werner için: p_bağ = sqrt(p_nihai), F = (1+3p)/4
  const pFinal = (4 * targetFinalF - 1) / 3;
  const pLink = Math.sqrt(Math.max(0, pFinal));
  return (1 + 3 * pLink) / 4;
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 3 — AKILLI KUANTUM BELLEK ZAMANLAYICI
// ══════════════════════════════════════════════════════════
class QuantumMemoryScheduler {
  /**
   * @param {object} cfg
   *  slots           — bu bağ için düğümdeki kuantum bellek yuvası sayısı
   *  policy          — "naive" (v1 davranışı) | "smart" (bu dosyanın algoritması)
   *  t1Ms, t2Ms      — gerçek bellek ömrü sabitleri (ms)
   *  usableFidelityFloor — bunun altına düşen çift ARTIK hedefe ulaşamaz
   */
  constructor(cfg) {
    this.slots = cfg.slots;
    this.policy = cfg.policy;
    this.t1Ms = cfg.t1Ms;
    this.t2Ms = cfg.t2Ms;
    this.floor = cfg.usableFidelityFloor;
    // Takas için YETERLİ sadakat. Bu seviyeye ULAŞMIŞ bir çifti daha
    // fazla arıtmak SAF İSRAFTIR (2 çift tüketip 1 üretir), bu yüzden
    // arıtma seçiminden çıkarılır — ama BELLEKTE KALIR, yani dekoheransı
    // izlenmeye devam eder ve bu seviyenin altına düşerse KENDİLİĞİNDEN
    // yeniden arıtma havuzuna katılır.
    this.swapTargetF = cfg.swapTargetF;
    this.rng = cfg.rng;
    this.mem = [];           // {id, state, tStamp, reserved}
    this.stats = {
      admitted: 0, rejectedFull: 0, deferredBackpressure: 0,
      evictedForBetter: 0, evictedBelowFloor: 0, lostToT1: 0, released: 0,
      peakOccupancy: 0,
    };
  }

  /** Bir çiftin durumunu `now` anına ilerletir; T1 ile kaybolduysa null. */
  _advance(p, now) {
    const dt = now - p.tStamp;
    if (dt <= 0) return p;
    if (this.t1Ms > 0 && this.rng() < 1 - Math.exp(-dt / this.t1Ms)) return null; // T1 kaybı
    p.state = bellDephase(p.state, dt, this.t2Ms);
    p.tStamp = now;
    return p;
  }

  /** Çöp toplama: T1'de kaybolanlar + sadakat tabanının altına düşenler. */
  gc(now) {
    const kept = [];
    for (const p of this.mem) {
      if (p.reserved) { kept.push(p); continue; } // uçuşta olan işlem — dokunma
      const alive = this._advance(p, now);
      if (!alive) { this.stats.lostToT1++; this.stats.released++; continue; }
      if (alive.state.I < this.floor) { this.stats.evictedBelowFloor++; this.stats.released++; continue; }
      kept.push(alive);
    }
    this.mem = kept;
  }

  get occupancy() { return this.mem.length; }
  get isFull() { return this.mem.length >= this.slots; }

  /**
   * Yeni bir çift kabul edilsin mi?
   * @returns {"admitted"|"rejected"|"defer"}
   *  "defer" YALNIZCA smart politikada döner: çağıran, denemeyi HARCAMADAN
   *  ileri bir zamana ertelemelidir (geri basınç).
   */
  admit(pair, now) {
    this.gc(now);
    if (!this.isFull) {
      this.mem.push(pair);
      this.stats.admitted++;
      this.stats.peakOccupancy = Math.max(this.stats.peakOccupancy, this.mem.length);
      return "admitted";
    }
    if (this.policy === "naive") {
      // v1 DAVRANIŞI: bellek dolu → çift ANINDA DÜŞÜRÜLÜR.
      this.stats.rejectedFull++;
      return "rejected";
    }
    // SMART (b): en kötü sakin, yeni gelenden BELİRGİN şekilde kötüyse
    // onu tahliye et — ölü ağırlık taşımaktansa taze çifti al.
    const free = this.mem.filter(p => !p.reserved);
    if (free.length) {
      let worst = free[0];
      for (const p of free) if (p.state.I < worst.state.I) worst = p;
      if (worst.state.I < pair.state.I) {
        this.mem.splice(this.mem.indexOf(worst), 1);
        this.stats.evictedForBetter++;
        this.stats.released++;
        this.mem.push(pair);
        this.stats.admitted++;
        return "admitted";
      }
    }
    // SMART (a): GERİ BASINÇ — denemeyi harcama, ertele.
    this.stats.deferredBackpressure++;
    return "defer";
  }

  /**
   * Arıtma için bir çift-çifti (iki adet entangled pair) seç.
   * SMART (c)+(d): önce son-tarihi yaklaşanlar (EDF), sonra sadakat
   * sıralı komşu eşleştirme (benzer sadakatler birlikte).
   * @returns {[pair,pair]|null}
   */
  selectPurificationPair(now) {
    this.gc(now);
    // Hedefe ULAŞMIŞ çiftler arıtma havuzunun DIŞINDA tutulur (bkz.
    // swapTargetF notu) — onları arıtmak, zaten yeterli iki çiftten
    // birini yok etmek olurdu.
    const free = this.mem.filter(p => !p.reserved && !(this.swapTargetF != null && p.state.I >= this.swapTargetF));
    if (free.length < 2) return null;

    if (this.policy === "naive") {
      // v1 DAVRANIŞI: saf FIFO — ilk iki çift, sadakate BAKMADAN.
      return [free[0], free[1]];
    }

    // (c) Son tarih: sadakat tabanına ne kadar süre kaldı?
    //     I(t) tabana inene dek geçen süre — küçükse acil.
    const deadline = (p) => {
      const cur = p.state.I;
      if (cur <= this.floor) return 0;
      // Faz dekoheransında I(t) → 0.5 (uzun vadede); tabanın üstündeki
      // pay üstel olarak erir. Kaba ama monoton, sıralama için yeterli.
      const marginNow = cur - 0.5, marginFloor = this.floor - 0.5;
      if (marginNow <= 0) return 0;
      if (marginFloor <= 0) return Infinity;
      return this.t2Ms * Math.log(marginNow / marginFloor);
    };
    const urgent = free.filter(p => deadline(p) < this.t2Ms * 0.15);
    const pool = urgent.length >= 2 ? urgent : free;

    // (d) SEVİYE-EŞLEŞTİRMELİ (nested/iç içe) ÇİFTLEME.
    // Arıtma, girdiler AYNI arıtma seviyesindeyken (dolayısıyla benzer
    // sadakatte) en verimlidir. Aynı seviyeden iki çift varsa ONLAR
    // eşleştirilir; yoksa sadakat sıralı komşu eşleştirmeye düşülür.
    // (Bir ara sürümde yalnızca "en iyi ikili" seçiliyordu; bu, 3 tur
    //  arıtılmış bir çifti taze bir çiftle eşleştirip ilerlemeyi
    //  tersine çeviriyordu — 40 km'de verim sıfıra düşmüştü.)
    const byLevel = new Map();
    for (const p of pool) {
      const lvl = p.rounds ?? 0;
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(p);
    }
    // En YÜKSEK seviyeden başlayarak, en az iki üyesi olan ilk seviyeyi al
    // (yüksek seviye = hedefe en yakın = önce bitirilmeli).
    const levels = [...byLevel.keys()].sort((a, b) => b - a);
    for (const lvl of levels) {
      const group = byLevel.get(lvl);
      if (group.length >= 2) {
        const s = group.sort((x, y) => y.state.I - x.state.I);
        return [s[0], s[1]];
      }
    }
    const sorted = [...pool].sort((x, y) => y.state.I - x.state.I);
    return [sorted[0], sorted[1]];
  }

  /** Hedefe ulaşmış bir çift VAR MI? (bellekten ÇIKARMAZ — yalnızca bakar) */
  peekReady(targetF, now) {
    this.gc(now);
    return this.mem.some(p => !p.reserved && p.state.I >= targetF);
  }

  /** Hedefe ULAŞMIŞ (arıtmaya gerek kalmamış) bir çift varsa çıkar. */
  takeReady(targetF, now) {
    this.gc(now);
    const free = this.mem.filter(p => !p.reserved && p.state.I >= targetF);
    if (!free.length) return null;
    let best = free[0];
    for (const p of free) if (p.state.I > best.state.I) best = p;
    this.mem.splice(this.mem.indexOf(best), 1);
    this.stats.released++;
    return best;
  }

  reserve(pairs) { for (const p of pairs) p.reserved = true; }
  consume(pairs) {
    for (const p of pairs) {
      const i = this.mem.indexOf(p);
      if (i !== -1) this.mem.splice(i, 1);
      this.stats.released++;
    }
  }
  /** Arıtma ÇIKTISINI belleğe geri koyar (kanaldan gelen değil). */
  insert(pair, now) {
    this.gc(now);
    if (this.isFull) {
      const free = this.mem.filter(p => !p.reserved);
      let worst = null;
      for (const p of free) if (!worst || p.state.I < worst.state.I) worst = p;
      // Yeni çift, en kötü sakinden iyi DEĞİLSE reddedilir. Bu çift
      // BELLEĞE HİÇ GİRMEDİĞİ için `released` sayacına YAZILMAZ —
      // defter yalnızca gerçekten bellekte bulunanları izler.
      if (!worst || worst.state.I >= pair.state.I) { this.stats.rejectedFull++; return false; }
      this.mem.splice(this.mem.indexOf(worst), 1);
      this.stats.evictedForBetter++; this.stats.released++;
    }
    this.mem.push(pair);
    this.stats.admitted++;
    this.stats.peakOccupancy = Math.max(this.stats.peakOccupancy, this.mem.length);
    return true;
  }
  /** Simülasyon sonunda kalan her şeyi güvenle serbest bırak (GC doğruluğu). */
  drain() { const n = this.mem.length; this.stats.released += n; this.mem = []; return n; }
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 4 — OLAY-GÜDÜMLÜ SİMÜLASYON (gerçek ms zaman ekseni)
// Soyut "tur" YOK, elle konmuş kapasite tavanı YOK — işlem hızını
// yalnızca ışık hızı gecikmesi (L/v) sınırlar.
// ══════════════════════════════════════════════════════════
function simulate(cfg) {
  const {
    elementaryKm, attemptsPerLink, memorySlots, t1Ms, t2Ms,
    policy, protocol, targetFinalFidelity, seed,
    // Uzun mesafede taze sadakat 0.5'e yaklaşır ve hedefe ulaşmak daha
    // çok tur gerektirir; tavan buna göre yükseltildi (v1'de 6 idi).
    maxPurificationRoundsPerPair = 10,
    // ÇOKLAMA (multiplexing): gerçek tekrarlayıcı düğümleri tek modlu
    // DEĞİLDİR — frekans/zaman/uzamsal modlarda M paralel dolanıklık
    // denemesi aynı klasik onay penceresinde yapılır. Bu, üretim hızını
    // M kat artırır ve BELLEĞİ gerçek darboğaz hâline getirir; kuyruklama
    // algoritmasının ölçülebilir hâle geldiği rejim budur.
    multiplexing = 1,
  } = cfg;

  const rng = mulberry32(seed >>> 0);
  const eta = fiberTransmittance(elementaryKm);
  const qPhase = phaseErrorForKm(elementaryKm);
  const delayMs = fiberDelayMs(elementaryKm);   // her klasik onay adımının bedeli

  // Hedef bağ sadakati — protokolün durum modeline göre TÜRETİLİR.
  const linkTargetIdeal = requiredLinkFidelity(
    targetFinalFidelity, protocol === "dejmps" ? "dephasing" : "werner");

  // TAKAS ONAYI MARJI — sihirli sayı DEĞİL, denklemin tersi.
  // Bir çift "hazır" ilan edildikten sonra takas sonucunun uçlara
  // ulaşması L/v kadar sürer ve bu süre boyunca dekohere olur. Marjsız
  // bir eşik, ham sadakatin hedefe ÇOK YAKIN olduğu mesafelerde (~6 km)
  // çiftlerin takas anında eşiğin ALTINA düşüp atılmasına yol açıyordu.
  // Burada, "delayMs kadar dekohere olduktan SONRA takas edildiğinde
  // hâlâ hedefi tutan" en düşük bağ sadakatini ikili aramayla buluyoruz.
  const linkTarget = (() => {
    const survives = (F) => {
      const aged = bellDephase(bellState(F, 0, 0, 1 - F), delayMs, t2Ms);
      return bellSwap(aged, aged).I >= targetFinalFidelity;
    };
    if (protocol !== "dejmps") return linkTargetIdeal; // Werner yolu bu modeli kullanmıyor
    if (survives(linkTargetIdeal)) return linkTargetIdeal;
    let lo = linkTargetIdeal, hi = 0.999999;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (survives(mid)) hi = mid; else lo = mid;
    }
    return hi;
  })();
  // KULLANILABİLİRLİK TABANI — cebirsel olarak TÜRETİLİR, elle seçilmez.
  // Saf faz gürültüsünde DEJMPS(Z) bir çifti YUKARI çeker ancak ve ancak
  //   I' > I  ⟺  I²/(I²+Z²) > I  ⟺  2I² − 3I + 1 < 0  ⟺  0.5 < I < 1
  // olduğunda. Yani arıtmanın kurtarabildiği HER çift F > 0.5'tir; taban
  // bundan daha yukarıda olamaz.
  // (Bir ara sürümde taban 0.5 + (hedef−0.5)·0.25 = 0.6046 olarak elle
  //  seçilmişti. Bu, 52 km üzerinde TAZE çiftlerin bile tabanın altında
  //  kalmasına ve arıtmayla kurtarılabilecekken anında atılmasına yol
  //  açıyordu — 60 km'de deneme bütçesi 80 katına çıkarıldığında bile
  //  verim sıfır kalıyordu. Hata bu taramada bulundu.)
  // Pratik pay: tam 0.5'teki bir çift sonsuz yavaş yakınsar, bu yüzden
  // küçük bir marj eklenir.
  const floor = 0.5 + FIDELITY_FLOOR_MARGIN;

  // Tek bir zamanlama çağrısında başlatılabilecek paralel arıtma sayısı
  // için güvenlik tavanı — bir KAPASİTE MODELİ DEĞİL, sonsuz döngüye karşı
  // koruma. Bellek yuvası sayısının yarısından fazla eşzamanlı işlem
  // zaten fiziksel olarak imkânsızdır (her işlem 2 yuva tutar).
  const MAX_PARALLEL_OPS_PER_SCHEDULE = Math.max(1, Math.ceil(memorySlots / 2));

  const links = ["AR", "RB"];
  const sched = {};
  const pending = {};   // bağ başına kalan deneme sayısı
  const nextAttempt = {};
  for (const L of links) {
    sched[L] = new QuantumMemoryScheduler({
      slots: memorySlots, policy, t1Ms, t2Ms, usableFidelityFloor: floor,
      swapTargetF: linkTarget, rng,
    });
    pending[L] = attemptsPerLink;
    nextAttempt[L] = 0;
  }

  // ── Olay kuyruğu (zaman sıralı) ──
  const events = [];
  const push = (e) => {
    let i = events.length;
    while (i > 0 && events[i - 1].t > e.t) i--;
    events.splice(i, 0, e);
  };
  for (const L of links) push({ t: 0, type: "ATTEMPT", link: L });

  let pairId = 0;
  const finalPairs = [];
  const stats = {
    attemptsConsumed: 0, heraldFailedLoss: 0,
    purifyAttempts: 0, purifySuccess: 0, purifyFailed: 0,
    swaps: 0, swapsBelowTarget: 0, roundsHistogram: {},
    orientationUsed: {},
  };
  const readyForSwap = { AR: null, RB: null };
  let now = 0;
  let guard = 0;
  const GUARD_MAX = 20_000_000;

  const tryScheduleWork = (t) => {
    // (i) TAKAS EŞLEŞTİRMESİ — hazır bir çift, HER İKİ bağ da hazır olmadan
    // bellekten ALINMAZ. (Bir ara sürümde hazır çift hemen alınıp eşi
    // beklenirken bellekte tutuluyordu; bu bekleme sırasındaki dekoherans
    // onu hedefin altına düşürüyor ve takas atılıyordu. Ham sadakatin
    // hedefe ÇOK YAKIN olduğu mesafelerde — ~6 km — verim bu yüzden
    // %40'tan %2'ye çöküyordu. Artık çift, eşi hazır olana kadar
    // bellekte kalır ve orada arıtma havuzunun parçası olmayı sürdürür.)
    if (links.every(L => sched[L].peekReady(linkTarget, t))) {
      for (const L of links) {
        if (!readyForSwap[L]) readyForSwap[L] = sched[L].takeReady(linkTarget, t);
      }
    }
    for (const L of links) {
      const S = sched[L];
      // (ii) Arıtma başlat — ELDEKİ TÜM uygun çiftler için, PARALEL.
      //      Burada KASITLI OLARAK bir "tur başına N işlem" tavanı YOKTUR
      //      (v1'deki PURIFICATION_CAPACITY_PER_ROUND=40 gibi). Bir düğüm,
      //      belleğindeki tüm çiftler üzerinde eşzamanlı yerel işlem
      //      yapabilir; işleri gerçekten sınırlayan şey, her sonucun
      //      klasik olarak onaylanması için ödenen L/v ışık hızı
      //      gecikmesidir. Kapasite artık ELLE KONMUŞ bir sayı değil,
      //      fiziğin kendisidir.
      let started = 0;
      while (started < MAX_PARALLEL_OPS_PER_SCHEDULE) {
        const sel = S.selectPurificationPair(t);
        if (!sel || sel.length !== 2) break;
        const [a, b] = sel;
        if (a.reserved || b.reserved) break;
        if ((a.rounds ?? 0) >= maxPurificationRoundsPerPair || (b.rounds ?? 0) >= maxPurificationRoundsPerPair) break;
        S.reserve([a, b]);
        push({ t: t + delayMs, type: "PURIFY_DONE", link: L, a, b });
        started++;
      }
    }
    // (iii) Her iki bağ da hazırsa TAKAS.
    if (readyForSwap.AR && readyForSwap.RB) {
      const a = readyForSwap.AR, b = readyForSwap.RB;
      readyForSwap.AR = null; readyForSwap.RB = null;
      push({ t: t + delayMs, type: "SWAP_DONE", a, b });
    }
  };

  while (events.length && guard++ < GUARD_MAX) {
    const ev = events.shift();
    now = ev.t;

    if (ev.type === "ATTEMPT") {
      const L = ev.link, S = sched[L];
      if (pending[L] <= 0) { tryScheduleWork(now); continue; }

      // ── GERİ BASINÇ (SMART): bellek doluysa VE tahliye edilebilecek
      // ölü ağırlık da yoksa, denemeyi HİÇ YAPMA — ertele. Fiziksel
      // olarak doğrudur: boş yuva olmadığını önceden bilirsiniz, foton
      // üretmezsiniz. Bu dal, denemeyi TÜKETMEZ.
      S.gc(now);
      if (policy === "smart" && S.isFull) {
        const free = S.mem.filter(p => !p.reserved);
        const freshF = 1 - qPhase;
        const hasDeadWeight = free.some(p => p.state.I < freshF);
        if (!hasDeadWeight) {
          S.stats.deferredBackpressure++;
          push({ t: now + delayMs, type: "ATTEMPT", link: L });
          tryScheduleWork(now);
          continue;
        }
      }

      // Deneme HARCANIR — önce kanal fiziği, sonra bellek kabulü.
      // ÇOKLAMA: aynı klasik onay penceresinde M paralel mod denenir.
      const batch = Math.min(multiplexing, pending[L]);
      pending[L] -= batch; stats.attemptsConsumed += batch;
      for (let k = 0; k < batch; k++) {
        if (rng() >= eta) {
          stats.heraldFailedLoss++;             // foton fiberde sönümlendi
          continue;
        }
        S.admit({
          id: ++pairId,
          state: bellState(1 - qPhase, 0, 0, qPhase), // saf σ_z gürültüsü
          tStamp: now, reserved: false, rounds: 0,
        }, now);
      }
      // Bir sonraki deneme ancak heralding klasik sinyali döndükten sonra.
      push({ t: now + delayMs, type: "ATTEMPT", link: L });
      tryScheduleWork(now);

    } else if (ev.type === "PURIFY_DONE") {
      const S = sched[ev.link];
      const { a, b } = ev;
      a.reserved = false; b.reserved = false;
      // Girdiler `now` anına ilerletilir (bekleme sırasında dekoherans).
      const aa = S._advance(a, now), bb = S._advance(b, now);
      S.consume([a, b]);
      stats.purifyAttempts++;
      if (!aa || !bb) { stats.purifyFailed++; tryScheduleWork(now); continue; }

      const res = protocol === "dejmps" ? dejmpsPurify(aa.state, bb.state) : bbpsswPurify(aa.state, bb.state);
      if (!res) { stats.purifyFailed++; tryScheduleWork(now); continue; }
      stats.orientationUsed[res.mode] = (stats.orientationUsed[res.mode] ?? 0) + 1;
      if (rng() < res.pSuccess) {
        stats.purifySuccess++;
        const rounds = Math.max(aa.rounds ?? 0, bb.rounds ?? 0) + 1;
        stats.roundsHistogram[rounds] = (stats.roundsHistogram[rounds] ?? 0) + 1;
        S.insert({ id: ++pairId, state: res.state, tStamp: now, reserved: false, rounds }, now);
      } else {
        stats.purifyFailed++; // ölçüm sonuçları uyuşmadı → her iki çift de yok edildi
      }
      tryScheduleWork(now);

    } else if (ev.type === "SWAP_DONE") {
      // Takas sonucu uçlara ulaştı; BEKLEME SÜRESİNCE (eşini beklerken +
      // takas heraldingi sırasında) biriken dekoherans burada uygulanır.
      const sA = bellDephase(ev.a.state, now - ev.a.tStamp, t2Ms);
      const sB = bellDephase(ev.b.state, now - ev.b.tStamp, t2Ms);
      const swapped = bellSwap(sA, sB);
      stats.swaps++;
      // KABUL DENETİMİ: bekleme sırasındaki dekoherans, hedefin altına
      // düşmüş bir nihai çift üretebilir. Böyle bir çift TESLİM EDİLMİŞ
      // SAYILMAZ — atılır ve ayrıca raporlanır. (v1'de bu denetim YOKTU;
      // eşiğin altındaki çiftler sessizce başarı sayılıyordu.)
      if (swapped.I >= targetFinalFidelity) {
        finalPairs.push({ t: now, F: swapped.I, state: swapped });
      } else {
        stats.swapsBelowTarget++;
      }
      tryScheduleWork(now);
    }

    // Tüm denemeler bitti ve iş kalmadıysa döngü doğal olarak sonlanır.
    if (!events.length) {
      const anyPending = links.some(L => pending[L] > 0);
      const anyWork = links.some(L => sched[L].mem.some(p => !p.reserved));
      if (!anyPending && anyWork) tryScheduleWork(now);
    }
  }

  // ── Simülasyon sonu: kalan her şey GÜVENLE serbest bırakılır (GC) ──
  let drained = 0;
  for (const L of links) drained += sched[L].drain();
  for (const L of links) if (readyForSwap[L]) { drained++; }

  const F = finalPairs.map(p => p.F);
  const memStats = {};
  for (const L of links) memStats[L] = sched[L].stats;
  const totalAdmitted = links.reduce((s, L) => s + sched[L].stats.admitted, 0);
  const totalReleased = links.reduce((s, L) => s + sched[L].stats.released, 0);

  return {
    config: {
      elementaryKm, attemptsPerLink, memorySlots, t1Ms, t2Ms, policy, protocol,
      targetFinalFidelity, seed, multiplexing,
    },
    physics: {
      transmittance: +eta.toFixed(6),
      lossRate: +(1 - eta).toFixed(6),
      phaseErrorRate: +qPhase.toFixed(6),
      oneWayDelayMs: +delayMs.toFixed(6),
      fiberVelocityKmPerMs: +FIBER_V_KM_PER_MS.toFixed(3),
      requiredLinkFidelity: +linkTarget.toFixed(6),
      requiredLinkFidelityIdeal: +linkTargetIdeal.toFixed(6),
      usableFidelityFloor: +floor.toFixed(6),
    },
    totals: {
      rawAttempts: attemptsPerLink * 2,
      attemptsConsumed: stats.attemptsConsumed,
      heraldFailedLoss: stats.heraldFailedLoss,
      purifyAttempts: stats.purifyAttempts,
      purifySuccess: stats.purifySuccess,
      purifyFailed: stats.purifyFailed,
      swaps: stats.swaps,
      swapsBelowTarget: stats.swapsBelowTarget,
      finalPairs: finalPairs.length,
      yieldPct: +(100 * finalPairs.length / (attemptsPerLink * 2)).toFixed(4),
      makespanMs: +now.toFixed(3),
      drainedAtEnd: drained,
      roundsHistogram: stats.roundsHistogram,
      orientationUsed: stats.orientationUsed,
    },
    fidelity: F.length ? {
      n: F.length,
      mean: +(F.reduce((a, b) => a + b, 0) / F.length).toFixed(6),
      min: +Math.min(...F).toFixed(6),
      max: +Math.max(...F).toFixed(6),
      allAboveTarget: Math.min(...F) >= targetFinalFidelity,
    } : { n: 0, mean: null, min: null, max: null, allAboveTarget: false },
    memory: memStats,
    ledger: { admitted: totalAdmitted, released: totalReleased, balanced: totalAdmitted === totalReleased },
    guardHit: guard >= GUARD_MAX,
  };
}

// ══════════════════════════════════════════════════════════
// BÖLÜM 5 — İÇSEL TUTARLILIK DENETİMİ
// Cebirsel iddiaların GERÇEKTEN doğru olduğunu sayısal olarak kanıtlar.
// ══════════════════════════════════════════════════════════
function selfCheck() {
  const checks = [];
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

  // 1) Bell-diyagonal takas, Werner girdilerde p1·p2 kuralına İNDİRGENMELİ.
  const p1 = 0.9, p2 = 0.8;
  const F1 = (1 + 3 * p1) / 4, F2 = (1 + 3 * p2) / 4;
  const sw = bellSwap(wernerState(F1), wernerState(F2));
  const expectedF = (1 + 3 * (p1 * p2)) / 4;
  checks.push({ name: "Takas konvolüsyonu Werner p1·p2'ye indirgeniyor", ok: near(sw.I, expectedF, 1e-12), got: sw.I, want: expectedF });

  // 2) DEJMPS, Werner girdide BBPSSW ile AYNI sonucu vermeli
  //    (bilinen teorik sonuç — DEJMPS'in avantajı yalnızca Werner-DIŞI durumlarda).
  const Fw = 0.88;
  const dj = bellDejmpsStep(wernerState(Fw), "Z");
  const bb = bbpsswPurify(wernerState(Fw), wernerState(Fw));
  checks.push({ name: "Werner girdide DEJMPS ≡ BBPSSW (sadakat)", ok: near(dj.state.I, bb.state.I, 1e-12), got: dj.state.I, want: bb.state.I });
  checks.push({ name: "Werner girdide DEJMPS ≡ BBPSSW (başarı olasılığı)", ok: near(dj.pSuccess, bb.pSuccess, 1e-12), got: dj.pSuccess, want: bb.pSuccess });

  // 3) Saf faz gürültüsünde DEJMPS(Z), BBPSSW'yi BELİRGİN şekilde yenmeli.
  const pure = bellState(0.88, 0, 0, 0.12);
  const djP = bellDejmpsStep(pure, "Z");
  const bbP = bbpsswPurify(pure, pure);
  checks.push({ name: "Saf faz gürültüsünde DEJMPS > BBPSSW", ok: djP.state.I > bbP.state.I + 0.05, got: djP.state.I, want: `> ${(bbP.state.I + 0.05).toFixed(4)}` });

  // 4) Normalizasyon her adımda korunmalı.
  const sum = djP.state.I + djP.state.X + djP.state.Y + djP.state.Z;
  checks.push({ name: "DEJMPS çıktısı normalize", ok: near(sum, 1, 1e-12), got: sum, want: 1 });

  // 5) Gereken bağ sadakati denklemi, takas denklemiyle TUTARLI olmalı.
  const need = requiredLinkFidelity(0.85, "dephasing");
  const back = bellSwap(bellState(need, 0, 0, 1 - need), bellState(need, 0, 0, 1 - need));
  checks.push({ name: "requiredLinkFidelity ↔ bellSwap tutarlı", ok: near(back.I, 0.85, 1e-9), got: back.I, want: 0.85 });

  // 6) ASİMETRİK DEJMPS, özdeş girdilerde SİMETRİK formüle indirgenmeli.
  const st = bellState(0.82, 0.03, 0.02, 0.13);
  for (const mode of ["Z", "X"]) {
    const sym = bellDejmpsStep(st, mode);
    const asym = dejmpsPurifyAsym(st, st, mode);
    checks.push({ name: `Asimetrik DEJMPS(${mode}) özdeş girdide simetriğe indirgeniyor`,
      ok: near(sym.state.I, asym.state.I, 1e-12) && near(sym.pSuccess, asym.pSuccess, 1e-12),
      got: `I=${asym.state.I.toFixed(12)} p=${asym.pSuccess.toFixed(12)}`,
      want: `I=${sym.state.I.toFixed(12)} p=${sym.pSuccess.toFixed(12)}` });
  }

  // 7) Fiber denklemleri: %35 kayıp ↔ referans mesafe gidiş-dönüş tutarlı.
  checks.push({ name: "kmForTransmittance ↔ fiberTransmittance tersi", ok: near(fiberTransmittance(REFERENCE_KM), 0.65, 1e-12), got: fiberTransmittance(REFERENCE_KM), want: 0.65 });
  checks.push({ name: "phaseErrorForKm(referans) = spesifikasyondaki %12", ok: near(phaseErrorForKm(REFERENCE_KM), SPEC_DEPHASE_RATE, 1e-12), got: phaseErrorForKm(REFERENCE_KM), want: SPEC_DEPHASE_RATE });

  return checks;
}

module.exports = {
  // fizik
  fiberTransmittance, kmForTransmittance, fiberDelayMs, phaseErrorForKm,
  REFERENCE_KM, FIBER_V_KM_PER_MS, FIBER_ATTENUATION_DB_PER_KM, FIBER_REFRACTIVE_INDEX,
  // durum cebri
  bellState, bellNormalize, bellFidelity, wernerState, bellDephase,
  bellDejmpsStep, dejmpsPurify, dejmpsPurifyAsym, bbpsswPurify, bellSwap, requiredLinkFidelity,
  // zamanlayıcı + simülasyon
  QuantumMemoryScheduler, simulate, selfCheck,
};
