# A1 — Faz 0 istemcisini gerçek QuKayDee'ye bağlama

Yol haritasının A1 adımı: PhotonNet'in ETSI-014 istemcisini, gerçek bir
bulut QKD ucuna ([QuKayDee](https://qukaydee.com/)) bağlayıp iki-taraflı
anahtar teslim akışını (Get Status → enc_keys → dec_keys) uçtan uca
doğrulamak. Kuantum donanımı gerektirmez.

## Neyin hazır olduğu

- `etsi014_client_lib.js` — vendor-neutral ETSI GS QKD 014 V1.1.1 istemci
  kütüphanesi. Master ve slave SAE'ler **ayrı KME uçlarına** bağlanabilir
  (QuKayDee'de kme-1 ↔ sae-1, kme-2 ↔ sae-2).
- `etsi014_qukaydee_client.js` — config alıp gerçek uca bağlanan koşucu.
- `qukaydee.config.example.json` — doldurulacak şablon.
- `etsi014_client_lib_test.js` — kütüphaneyi **yerel KME'ye karşı loopback**
  ile doğrular (bu geçiyor → QuKayDee'ye geçiş yalnız config değişimidir).

## Adımlar

1. **Hesap.** [qukaydee.com](https://qukaydee.com/) → ücretsiz hesap, e-posta doğrula.
   Hesap numaranı (URL'lerdeki `acct-N`) not et.
2. **Altyapı.** İki KME (kme-1, kme-2), iki SAE (sae-1 → kme-1, sae-2 → kme-2)
   ve bir **Key Stream** (sae-1 ↔ sae-2) oluştur.
3. **Sertifikalar (mTLS).**
   - Sunucu CA'sını indir: `account-N-server-ca-qukaydee-com.crt`.
   - İstemci CA'nı üret + platforma yükle; onunla `sae-1` ve `sae-2`
     sertifikalarını imzala. Yardımcı script:
     [brunorijsman/qukaydee-generate-client-certificates](https://github.com/brunorijsman/qukaydee-generate-client-certificates).
   - `certs/` altına koy: `account-N-server-ca-qukaydee-com.crt`,
     `sae-1.crt`, `sae-1.key`, `sae-2.crt`, `sae-2.key`.
4. **Config.**
   ```bash
   cp qukaydee.config.example.json qukaydee.config.json
   # qukaydee.config.json içinde ACCOUNT_ID'yi (ve gerekirse cert yollarını) doldur
   ```
5. **Koş.**
   ```bash
   node etsi014_qukaydee_client.js
   ```
   Beklenen: Get Status §6.1 şeması, enc_keys §6.2 Key container, dec_keys'te
   `master.key === slave.key` — hepsi ✓.

## API yapısı (referans)

| İşlem | Uç |
|-------|-----|
| Get Status | `GET  https://kme-1.acct-N.etsi-qkd-api.qukaydee.com/api/v1/keys/sae-2/status` |
| enc_keys (master) | `POST https://kme-1.acct-N.etsi-qkd-api.qukaydee.com/api/v1/keys/sae-2/enc_keys` |
| dec_keys (slave) | `POST https://kme-2.acct-N.etsi-qkd-api.qukaydee.com/api/v1/keys/sae-1/dec_keys` |

- master (sae-1) kendi KME'sine (kme-1) bağlanır, yolda **slave** SAE ID (sae-2).
- slave (sae-2) kendi KME'sine (kme-2) bağlanır, yolda **master** SAE ID (sae-1).
- `size` config'te `null` bırakılır → QuKayDee'nin varsayılan `key_size`'ı kullanılır.

## Notlar

- Sandbox'tan gerçek QuKayDee'ye ağ + kimlik erişimi olmadığından canlı koşum
  **kullanıcı tarafında** yapılır; istemci mantığı yerel KME'ye karşı
  `etsi014_client_lib_test.js` ile doğrulanmıştır.
- `qukaydee.config.json` ve `certs/` gizli anahtar içerir — sürüm kontrolüne
  eklenmemelidir.
- Çekirdek `photonnet_core.js` değişmez.
