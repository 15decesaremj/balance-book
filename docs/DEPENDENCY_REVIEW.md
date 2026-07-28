# Production dependency review

Reviewed: 2026-07-27

This record covers Balance Book 2.0.9 at lock-file SHA-256 `C5BA10C1B36168C8D7DB96B866CE33B422AB28942E2CDB4B5F1479F1A23DDE02`.

## Advisory result

`pnpm audit --prod` completed against the package advisory service and reported **No known vulnerabilities found**.

The review advanced the exact React Router pin from 8.2.0 to patched 8.3.0 after
`GHSA-qwww-vcr4-c8h2` entered the advisory service. It also applies a project-level override from
affected transitive `brace-expansion` versions through 5.0.7 to patched 5.0.8 for
`GHSA-mh99-v99m-4gvg`. The resulting installed production graph contains one version of each
package. Because 5.0.8 changed its CommonJS export shape, the lock file applies the tracked
[`brace-expansion-5.0.8.patch`](../patches/brace-expansion-5.0.8.patch) compatibility shim: legacy
minimatch callers receive the callable function they require, while current callers retain the
named `expand` export and 5.0.8's bounded expansion implementation. A dedicated regression checks
both interfaces and the expansion-length guard. Strict type checking, workbook-import coverage,
Overview behavior, all committed tests, the packaged Electron journey, and production packaging
remain release gates for the changed graph.

## License inventory

`pnpm licenses list --prod --json` completed against the exact installed lock-file graph. It returned 244 package-name entries grouped as follows:

| Reported license expression           | Package-name entries |
| ------------------------------------- | -------------------: |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` |                    1 |
| `(MIT AND Zlib)`                      |                    1 |
| `(MIT OR GPL-3.0-or-later)`           |                    1 |
| `(MIT OR WTFPL)`                      |                    1 |
| `0BSD`                                |                    1 |
| `Apache-2.0`                          |                    7 |
| `BSD-3-Clause`                        |                    3 |
| `ISC`                                 |                   27 |
| `MIT`                                 |                  197 |
| `MIT AND ISC`                         |                    1 |
| `MIT/X11`                             |                    2 |
| `Unlicense`                           |                    1 |
| `Unknown`                             |                    1 |

The sole `Unknown` metadata result is transitive `buffers@0.1.1`, reached through ExcelJS. Its published package omits a license field and license file. The archived upstream copyright record identifies it as MIT; the complete permission text and source record are retained in [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt).

The distributable application must continue to retain the project license, `THIRD_PARTY_NOTICES.txt`, Electron's license, and Chromium's generated notices. This engineering review is release evidence, not third-party legal certification.
