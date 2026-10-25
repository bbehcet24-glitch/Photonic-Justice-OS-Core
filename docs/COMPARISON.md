# How PhotonNet compares with existing simulators

This note positions PhotonNet against the open tools a reviewer is most likely to know. It is written to
answer one question honestly: *what does PhotonNet do that these tools do not, and where are they clearly
stronger?* Facts about the other tools come from their own papers, repositories and package pages (see
[Sources](#sources)); where a fact could not be verified, it is marked as such. Tools change — check the
sources before relying on a detail.

## Summary

The established tools fall into two groups:

- **Quantum-network physics simulators** (NetSquid, SeQUeNCe, QuNetSim) model qubits, entanglement,
  memories and timing, and are aimed at research on quantum repeaters and network protocols.
- **QKD network / key-management simulators** (QKDNetSim) treat key generation abstractly and focus on the
  classical side: key management systems, key relay and the ETSI interfaces.

PhotonNet sits between the two and adds an integration layer that neither group targets. It runs a
photon-level BB84 pipeline with finite-key security on every hop of a trusted-node chain, and feeds the
resulting keys into a real ETSI GS QKD 014 KME server with mTLS, certificate revocation and an HSM path,
plus a hardware abstraction layer for real time-taggers and QRNGs. It is **not** a general-purpose
quantum-network simulator and should not be presented as a replacement for NetSquid or SeQUeNCe.

## Comparison table

| | NetSquid | SeQUeNCe | QuNetSim | QKDNetSim v2 | **PhotonNet** |
|---|---|---|---|---|---|
| Developer | QuTech (TU Delft) and TNO | Argonne National Laboratory and collaborators | academic open-source project | academic (ns-3 module; University of Sarajevo, VSB Ostrava and others) | single developer (photonicquantumcore) |
| Language / platform | Python package | Python (with a modified Quantum++ library) | Python | C++ module for ns-3 | JavaScript (Node + browser) and Python HAL |
| Distribution | free for non-commercial use after registration; no open-source licence named in the sources checked | open source on GitHub (see the repository's LICENSE) | MIT | GPL-2.0 | GPL-3.0-or-later or commercial (core); Apache-2.0 (integration interfaces) |
| Core method | discrete-event simulation with detailed timing, qubit decoherence and hardware models (e.g. NV centres) | discrete-event simulation; modules for hardware, entanglement, resource and network management, applications | protocol-level simulation of quantum network tasks (teleportation, superdense coding, EPR distribution) | packet-level network simulation; QKD key generation treated with "maximum simplification" | Monte Carlo photon-level BB84 per link + trusted-node relay; separate, simpler entanglement modules |
| QKD post-processing | BB84 use case in the paper uses the asymptotic secret-key rate | BB84 example notebook; no error correction / privacy amplification described in the sources checked | not described in the sources checked | not modelled (keys are produced as bit counts) | parameter estimation on a disclosed test subset, Cascade reconciliation with measured leakage, two-parameter Serfling/GLLP finite-key bound, Toeplitz privacy amplification — on every hop (core v4) |
| Key management / ETSI interfaces | — | — | — | full KMS with key relay; ETSI GS QKD 004 and 014 (plain HTTP; key validation not implemented) | standalone ETSI GS QKD 014 KME server with real mTLS, CRL + OCSP revocation, build-time removal of demo auth, SoftHSM2/PKCS#11 CA path; interoperability-tested against an independent reference KME |
| Real hardware path | hardware models, not drivers | hardware models, not drivers | — | — | HAL contracts and drivers for time-tagger/SPAD devices and QRNGs (TCP/serial), online RCT/APT health gate; no real device connected yet |
| Validation status | peer-reviewed (Communications Physics, 2021), used in follow-up research | peer-reviewed (Quantum Science and Technology, 2021); the repository lists papers that used or extended it | peer-reviewed (IEEE Transactions on Quantum Engineering, 2021) | peer-reviewed (SoftwareX, 2024) | ~100 internal self-tests in CI; **no peer-reviewed publication and no comparison with a published experiment yet** |

## What PhotonNet adds

1. **Finite-key security per hop, end to end.** On a trusted-node chain every hop runs its own parameter
   estimation, Cascade, finite-key length ℓ and Toeplitz hashing, and the end-to-end key is genuinely
   relayed with public XOR announcements; delivery requires ℓ ≥ message length on every hop. In the
   sources checked, the physics simulators report asymptotic or raw rates, and QKDNetSim does not model
   key generation at all.
2. **A production-style KME on top of simulated keys.** The ETSI GS QKD 014 server enforces client
   certificates in the TLS handshake, reads the SAE identity from the certificate, supports CRL and OCSP
   with measured revocation timings, and has a stripped production build. QKDNetSim's KMS is far more
   complete as a *network* model (key relay, ETSI 004), but by its own documentation uses plain HTTP and
   does not validate keys.
3. **A hardware abstraction layer meant for real devices.** Time-tag correlation with clock offset/drift
   estimation, detector profiles shared between the JS core and Python, and a QRNG interface with online
   health tests are written against small vendor-neutral contracts.
4. **Fail-closed engineering and measured claims.** Missing entropy, an unhealthy QRNG batch, a revoked
   certificate, an unknown detector profile or a stale shielding gate stop the operation rather than
   falling back. Every core change is versioned with its SHA-256 and recorded in a changelog.

These are integration strengths, not new physics.

## Where the other tools are clearly stronger

- **Physical fidelity of quantum networks.** NetSquid and SeQUeNCe model qubit states, memories, timing
  and hardware platforms with a depth PhotonNet does not attempt. PhotonNet's entanglement modules are
  simplified and separate from its main BB84 engine.
- **Network-scale simulation.** QKDNetSim inherits ns-3's mature packet-level networking; PhotonNet's
  network layer is a routing and allocation model, not a packet simulator.
- **Validation and community.** All four tools are published in peer-reviewed venues. PhotonNet has only internal tests and a single developer, and its physical parameters are
  literature values or assumptions, not measurements of a specific device.
- **Language and documentation.** Most PhotonNet source comments and design notes are in Turkish.

## Complementary use

PhotonNet already replays a real QKDNetSim ns-3 traffic profile against its own KME
(`bb84/qkdnetsim_traffic_bridge.js`) and exports an NS-3 QKDNetSim-v2–compatible scenario file
(`bb84/qkd_network_scale.js`). A realistic division of labour in a project is: NetSquid or SeQUeNCe for
repeater and entanglement physics, QKDNetSim for large network/KMS studies, and PhotonNet for the
link-level post-processing, the standard key-delivery interface and the path to real hardware.

## Next steps to make the comparison quantitative

1. Reproduce the secret-key-rate-versus-distance curve of a published BB84/decoy-state experiment with
   PhotonNet's parameters and report the deviation.
2. Run the same two-node BB84 scenario in PhotonNet and in one of the physics simulators and compare QBER
   and key rate.
3. Point the ETSI-014 client at a KME from another implementation (for example QKDNetSim's App014 or a
   vendor test endpoint) and publish the interoperability result.

## Sources

- NetSquid: T. Coopmans et al., "NetSquid, a NETwork Simulator for QUantum Information using Discrete
  events", Communications Physics (2021) — [arXiv:2010.12535](https://arxiv.org/pdf/2010.12535);
  distribution: [QuTech announcement](https://qutech.nl/new-software-brings-quantum-network-design-to-users-around-the-world/)
- SeQUeNCe: X. Wu et al., "SeQUeNCe: A Customizable Discrete-Event Simulator of Quantum Networks", Quantum Science and Technology 6 (2021) —
  [arXiv:2009.12000](https://arxiv.org/pdf/2009.12000); [repository](https://github.com/sequence-toolbox/SeQUeNCe/);
  [PyPI](https://pypi.org/project/sequence/0.6.4)
- QuNetSim: S. DiAdamo et al., "QuNetSim: A Software Framework for Quantum Networks" —
  IEEE Transactions on Quantum Engineering (2021) — [arXiv:2003.06397](https://arxiv.org/abs/2003.06397v3); [PyPI](https://pypi.org/project/qunetsim/0.1.1.post4/)
- QKDNetSim: [repository (v2.0)](https://github.com/QKDNetSim/qkdnetsim);
  [model library documentation](https://www.qkdnetsim.info/models/build/html/qkdnetsim.html);
  "QKDNetSim+: Improvement of the quantum network simulator for NS-3", SoftwareX (2024) —
  [arXiv:2402.10822](https://arxiv.org/abs/2402.10822v1)
- qkdsec (Apache-2.0 Python toolkit with an ETSI GS QKD 014 *client* and conformance probe):
  [PyPI](https://pypi.org/project/qkdsec/)
