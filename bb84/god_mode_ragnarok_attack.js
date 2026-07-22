const crypto = require('crypto');
const fs = require('fs');

// --- GOD MODE ATTACK: PROJECT RAGNAROK ---
console.log("\n==================================================");
console.log("   INITIATING GOD MODE ATTACK: PROJECT RAGNAROK   ");
console.log("==================================================\n");

const SECRET_KEY = "YOUR_HMAC_SECRET_HERE"; // Kendi HMAC gizli anahtarın

function generateSignedPayload(linkId, distance, qber, darkCount) {
    const data = {
        link_id: linkId,
        distance_km: distance,
        qber: qber,
        attenuation_db: 0.22 * distance,
        dark_count_rate: darkCount,
        timestamp: Date.now()
    };

    // HMAC İmzasını Yasal Olarak Üretiyoruz (İmza Geçerli!)
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(JSON.stringify(data));
    data.signature = hmac.digest('hex');

    return data;
}

// 1. PHASE 1: Eşik Altı Zehirleme (QBER = %10.8 - Sınırın Tam Altı)
const link1Payload = generateSignedPayload("Link-Prime-50km", 50, 0.108, 450);

// 2. PHASE 2: Zamanlama Sapması ve Sahte Mükemmel Hat
const link2Payload = generateSignedPayload("Link-Backup-30km", 30, 0.02, 120);

const ragnarokMatrix = {
    calibrations: [link1Payload, link2Payload],
    meta: {
        attack_type: "SUB_THRESHOLD_STALEMATE",
        generated_by: "EVE_GOD_MODE"
    }
};

fs.writeFileSync('/root/work/photonnet/hal/noise_matrix.json', JSON.stringify(ragnarokMatrix, null, 2));

console.log("[+] Ragnarok Saldırı Matrisi Üretildi ve Imzalandı.");
console.log("[+] HMAC: GEÇERLİ | Fiziksel Sınırlar: GEÇERLİ | Link ID: AYRILMIŞ");
console.log("[!] Çekirdek Simülasyonu Başlatılıyor...\n");
