# Store screenshot procedure

Store screenshots must be generated only from the isolated synthetic profile used by the packaged
Electron journey. Never use the owner database, workbook, exports, backups, or normal desktop
screenshots.

The repository privacy gate intentionally rejects committed PNG/JPG files. Generate the final
1366-by-768 images under ignored `out/store/listing/screenshots`, review every visible value and
window edge, and upload only that synthetic set directly to Partner Center. Record the reviewed
filenames and SHA-256 hashes in the local submission evidence; do not weaken the privacy gate to
version binary screenshots.

Required views:

1. Welcome and local-data consent
2. Overview with synthetic card runway and cash-account lows
3. Daily cash forecast with synthetic events
4. Credit cards with synthetic statements and scheduled payments
5. Loans and payoff progress with synthetic installment debt
6. Trends with synthetic historical and projected values
