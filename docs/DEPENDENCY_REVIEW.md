# Production dependency review

Reviewed: 2026-07-16

This record covers Balance Book 1.1.2 at lock-file SHA-256 `C1A3FAB48411CA4766973B22F49722826C796F34A68020FFA997B0F5184917FC`.

## Advisory result

`pnpm audit --prod` completed against the package advisory service and reported **No known vulnerabilities found**.

## License inventory

`pnpm licenses list --prod --json` completed against the exact installed lock-file graph. It returned 245 package-name entries grouped as follows:

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
| `MIT`                                 |                  198 |
| `MIT AND ISC`                         |                    1 |
| `MIT/X11`                             |                    2 |
| `Unlicense`                           |                    1 |
| `Unknown`                             |                    1 |

The sole `Unknown` metadata result is transitive `buffers@0.1.1`, reached through ExcelJS. Its published package omits a license field and license file. The archived upstream copyright record identifies it as MIT; the complete permission text and source record are retained in [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt).

The distributable application must continue to retain the project license, `THIRD_PARTY_NOTICES.txt`, Electron's license, and Chromium's generated notices. This engineering review is release evidence, not third-party legal certification.
