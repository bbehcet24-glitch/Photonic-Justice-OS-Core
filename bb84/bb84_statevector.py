import numpy as np

rng = np.random.default_rng(12345)

H = (1/np.sqrt(2)) * np.array([[1,1],[1,-1]], dtype=complex)
ZERO = np.array([1,0], dtype=complex)
ONE  = np.array([0,1], dtype=complex)

def prepare(bit, basis):
    """basis: 0 = Z (hesaplama), 1 = X (Hadamard)"""
    state = ZERO.copy() if bit == 0 else ONE.copy()
    if basis == 1:
        state = H @ state
    return state

def measure(state, basis, rng):
    """Born kuralına göre ölçüm; basis=1 ise önce H uygulanır (kendi tersidir)."""
    s = H @ state if basis == 1 else state
    probs = np.abs(s)**2
    probs = probs / probs.sum()
    outcome = rng.choice([0,1], p=probs)
    return outcome

def run_bb84(n, eve_attack, rng):
    alice_bits  = rng.integers(0,2,n)
    alice_bases = rng.integers(0,2,n)
    bob_bases   = rng.integers(0,2,n)

    bob_results = np.empty(n, dtype=int)
    for i in range(n):
        state = prepare(alice_bits[i], alice_bases[i])
        if eve_attack:
            eve_basis = rng.integers(0,2)
            eve_bit = measure(state, eve_basis, rng)          # Eve ölçer -> çöküş
            state = prepare(eve_bit, eve_basis)                # Eve yeniden hazırlayıp yollar
        bob_results[i] = measure(state, bob_bases[i], rng)

    matched = alice_bases == bob_bases
    sifted_alice = alice_bits[matched]
    sifted_bob   = bob_results[matched]
    qber = np.mean(sifted_alice != sifted_bob) if len(sifted_alice) else float('nan')
    return {
        "n": n,
        "sifted_len": int(matched.sum()),
        "sift_rate": matched.mean(),
        "qber": qber,
    }

N = 200_000
print("=== Durum-vektörü BB84 simülasyonu (Qiskit'in yapacağı hesap, numpy ile) ===")
print(f"N = {N} kübit\n")

no_eve = run_bb84(N, eve_attack=False, rng=rng)
print("[Eve YOK - ideal kanal]")
print(f"  sifted key uzunluğu : {no_eve['sifted_len']} ({no_eve['sift_rate']*100:.2f}% - teorik %50)")
print(f"  QBER                : {no_eve['qber']*100:.4f}%  (teorik: 0%)")

print()
with_eve = run_bb84(N, eve_attack=True, rng=rng)
print("[Eve VAR - intercept-resend saldırısı]")
print(f"  sifted key uzunluğu : {with_eve['sifted_len']} ({with_eve['sift_rate']*100:.2f}% - teorik %50)")
print(f"  QBER                : {with_eve['qber']*100:.4f}%  (teorik: %25)")
