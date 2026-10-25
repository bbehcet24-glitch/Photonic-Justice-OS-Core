# Contributing to PhotonNet (photonicquantumcore)

Thank you for your interest. Because most of this repository is **dual licensed**
(GPL-3.0-or-later OR a commercial licence, see `LICENSE`), the copyright holder must
be able to offer every part of the code under both licences. Contributions are
therefore accepted only under the terms below.

## Contributor terms

By submitting a contribution (pull request, patch or any other form), you confirm that:

1. **Origin** — you wrote the contribution yourself or otherwise have the right to submit
   it, as described in the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
   Sign each commit with `git commit -s` (adds `Signed-off-by: Your Name <email>`).
2. **Inbound licence** — the contribution is licensed under the licence of the files it
   changes (see `REUSE.toml`): GPL-3.0-or-later for dual-licensed files, Apache-2.0 for
   the integration interfaces.
3. **Commercial relicensing grant** — for contributions to dual-licensed files, you
   additionally grant Behçet Büyükacar (photonicquantumcore) a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable licence to use, modify, sublicense and
   distribute your contribution under the commercial licence as well. You keep the
   copyright in your contribution.

If you cannot agree to point 3, please open an issue to discuss before contributing.

## Practical notes

- Run `npm test` before submitting (see README, section 9).
- New files: add an SPDX header, or make sure the path is covered by `REUSE.toml`.
- Do not change `bb84/photonnet_core.js` by hand; it is generated from `PhotonNet2.jsx`
  (`node bb84/tools/extract_core.js`) and every core version is recorded in
  `bb84/docs/CORE_CHANGELOG.md`.

---

**Türkçe özet:** Depo çift lisanslı olduğu için katkılar yalnız şu koşulla kabul edilir:
katkıyı kendiniz yazdınız (DCO, `git commit -s`), değiştirdiğiniz dosyanın lisansıyla
veriyorsunuz ve çift lisanslı dosyalarda telif sahibine katkınızı ticari lisansla da
dağıtma izni veriyorsunuz (telif hakkı sizde kalır).
