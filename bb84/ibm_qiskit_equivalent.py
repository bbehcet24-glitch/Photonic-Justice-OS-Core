"""
IBM Qiskit-eşdeğeri BB84 simülasyonu — PhotonNet'in QBER hesaplamasını
bağımsız bir kuantum-mekaniksel referansla doğrulamak için.

DÜRÜST TEKNİK NOT: Bu sandbox'ta pip ile YENİ hiçbir paket kurulamıyor
(yalnızca qiskit değil — test edildi, cowsay gibi trivial bir paket bile
kurulamıyor; ağ altyapısı PyPI'a paket indirmeyi engelliyor). Bu yüzden
gerçek `qiskit` kütüphanesi çalıştırılamıyor. Bunun yerine, bir Qiskit
devresinin YAPACAĞI HESABIN MATEMATİKSEL OLARAK BİREBİR AYNISI kullanılıyor:
tek-kübitlik BB84 durumları dolaşık DEĞİLDİR (her foton bağımsız bir ürün
durumu), bu yüzden Hadamard-kapı + Born-kuralı hesaplaması, tam karmaşık
genlik cebiri kullanılarak DOĞRULANDIKTAN SONRA (aşağıdaki
cross_check_against_full_statevector fonksiyonu) matematiksel olarak
eşdeğer, vektörleştirilmiş bir forma indirgeniyor — sonuç, gerçek bir
Qiskit/Aer simülasyonuyla istatistiksel olarak ayırt edilemez olurdu
(ikisi de aynı üniter matrisler + aynı Born kuralını hesaplar).

İki senaryo:
  1) İDEAL KANAL — yalnızca protokol matematiği (teorik: %0 / %25)
  2) EŞLEŞTİRİLMİŞ GÜRÜLTÜ — PhotonNet'in propPhoton()'daki BİREBİR AYNI
     faz-kayması formülü (phaseProb = 0.012 + km/4000) Bob'un ölçüm
     SONUCUNA (klasik bit) uygulanır — PhotonNet'in kendisi de gürültüyü
     tam olarak bu şekilde (kuantum operatörü değil, klasik bit-flip
     olasılığı) modelliyor, yani bu adil bir karşılaştırmadır.
"""
import numpy as np
import json

H = (1/np.sqrt(2)) * np.array([[1,1],[1,-1]], dtype=complex)
ZERO = np.array([1,0], dtype=complex)
ONE  = np.array([0,1], dtype=complex)

def prepare(bit, basis):
    state = ZERO.copy() if bit == 0 else ONE.copy()
    if basis == 1:
        state = H @ state
    return state

def measure(state, basis, rng):
    s = H @ state if basis == 1 else state
    probs = np.abs(s)**2
    probs = probs / probs.sum()
    return rng.choice([0,1], p=probs)

def full_statevector_bb84(n, eve_attack, rng):
    """YAVAŞ ama TAM kuantum referans — küçük N için çapraz-doğrulama amaçlı."""
    alice_bits  = rng.integers(0,2,n)
    alice_bases = rng.integers(0,2,n)
    bob_bases   = rng.integers(0,2,n)
    bob_results = np.empty(n, dtype=int)
    for i in range(n):
        state = prepare(alice_bits[i], alice_bases[i])
        if eve_attack:
            eb = rng.integers(0,2)
            eve_bit = measure(state, eb, rng)
            state = prepare(eve_bit, eb)
        bob_results[i] = measure(state, bob_bases[i], rng)
    matched = alice_bases == bob_bases
    sa, sb = alice_bits[matched], bob_results[matched]
    return float(np.mean(sa != sb)) if matched.sum() else float('nan'), int(matched.sum())

def vectorized_bb84(n, eve_attack, km, apply_matched_noise, rng):
    """HIZLI, matematiksel olarak tam-durum-vektörü hesabına eşdeğer versiyon
    (tek-kübit ürün durumları için Born kuralının kapalı-form sonucu)."""
    alice_bits  = rng.integers(0,2,n)
    alice_bases = rng.integers(0,2,n)
    bob_bases   = rng.integers(0,2,n)

    if not eve_attack:
        # bbasis==abasis olduğunda (sifted küme) kuantum ölçüm sonucu KESİN
        # olarak alice_bits'tir (Born kuralı: aynı bazda ölçüm olasılığı 1).
        bob_results = alice_bits.copy()
    else:
        eve_bases = rng.integers(0,2,n)
        eve_correct = eve_bases == alice_bases
        # Eve doğru bazı seçtiyse: ölçümü KESİN olarak alice_bits'tir (Born
        # kuralı, p=1). Yanlış bazdaysa: ölçüm sonucu KESİN olarak %50/50
        # rastgeledir (Born kuralı, tamamlayıcı bazda p=0.5/0.5).
        eve_bits = np.where(eve_correct, alice_bits, rng.integers(0,2,n))
        # Bob, Eve'in yeniden hazırladığı durumu KENDİ bazında ölçer: eğer
        # bob_bases==eve_bases ise kesin=eve_bits, değilse kesin %50/50.
        bob_bases_match_eve = bob_bases == eve_bases
        bob_results = np.where(bob_bases_match_eve, eve_bits, rng.integers(0,2,n))

    if apply_matched_noise:
        p_phase = 0.012 + km/4000.0  # PhotonNet propPhoton(): phaseProb = .012 + km/4000
        flips = rng.random(n) < p_phase
        bob_results = bob_results ^ flips.astype(int)

    matched = alice_bases == bob_bases
    sa, sb = alice_bits[matched], bob_results[matched]
    qber = float(np.mean(sa != sb)) if matched.sum() else float('nan')
    return {"qber": qber, "sifted_len": int(matched.sum()), "sift_rate": float(matched.mean())}

def cross_check():
    """Vektörleştirilmiş hızlı yöntemi, YAVAŞ tam-durum-vektörü referansına
    karşı çapraz doğrular — ikisinin istatistiksel olarak örtüştüğünü kanıtlar."""
    N = 20_000
    rng_full = np.random.default_rng(777)
    rng_vec  = np.random.default_rng(777)
    full_no_eve, n1 = full_statevector_bb84(N, False, rng_full)
    vec_no_eve = vectorized_bb84(N, False, 0, False, rng_vec)
    rng_full2 = np.random.default_rng(888)
    rng_vec2  = np.random.default_rng(888)
    full_eve, n2 = full_statevector_bb84(N, True, rng_full2)
    vec_eve = vectorized_bb84(N, True, 0, False, rng_vec2)
    print("=== ÇAPRAZ DOĞRULAMA: tam durum-vektörü vs vektörleştirilmiş kapalı-form ===")
    print(f"  Eve YOK — tam: {full_no_eve*100:.3f}%  vektörleştirilmiş: {vec_no_eve['qber']*100:.3f}%  (N={N})")
    print(f"  Eve VAR — tam: {full_eve*100:.3f}%  vektörleştirilmiş: {vec_eve['qber']*100:.3f}%  (N={N})")
    print("  -> iki yöntem istatistiksel olarak örtüşüyorsa (örnekleme gürültüsü içinde),")
    print("     vektörleştirilmiş versiyon büyük N için güvenle kullanılabilir.\n")

def main():
    cross_check()

    N = 2_000_000
    seed = 20260712
    distances = [1, 5, 10, 20, 50, 100, 300, 550]

    results = {"ideal": {}, "matched_noise": {}}

    print("=== 1) İDEAL KANAL (gürültüsüz) — yalnızca protokol matematiği, N=%d ===" % N)
    rng = np.random.default_rng(seed)
    no_eve = vectorized_bb84(N, False, 0, False, rng)
    with_eve = vectorized_bb84(N, True, 0, False, rng)
    print(f"  Eve YOK: QBER={no_eve['qber']*100:.4f}% (teorik: 0%)")
    print(f"  Eve VAR: QBER={with_eve['qber']*100:.4f}% (teorik: %25)")
    results["ideal"] = {"no_eve_qber": no_eve['qber']*100, "eve_qber": with_eve['qber']*100}

    print("\n=== 2) EŞLEŞTİRİLMİŞ GÜRÜLTÜ (PhotonNet phaseProb formülüyle), N=%d ===" % N)
    print(f"{'km':>5} {'Qiskit-eşd. QBER (Eve yok)':>28} {'Qiskit-eşd. QBER (Eve var)':>28}")
    for km in distances:
        rng = np.random.default_rng(seed + km)
        no_eve = vectorized_bb84(N, False, km, True, rng)
        with_eve = vectorized_bb84(N, True, km, True, rng)
        results["matched_noise"][km] = {
            "no_eve_qber": no_eve['qber']*100,
            "eve_qber": with_eve['qber']*100,
            "sifted_len": no_eve['sifted_len'],
        }
        print(f"{km:>5} {no_eve['qber']*100:>27.3f}% {with_eve['qber']*100:>27.3f}%")

    with open("ibm_qiskit_equivalent_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nSonuçlar kaydedildi: ibm_qiskit_equivalent_results.json")

if __name__ == "__main__":
    main()
