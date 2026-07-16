# Workbook import

Workbook import is optional local onboarding tooling. Balance Book does not require Excel or a workbook after import, and no workbook cell or formula becomes part of the runtime calculation engine.

## Source handling

The importer opens only a file selected by the user and treats it as read-only input. It records file size, modification time, and checksum before and after inspection so a changed source cannot be mistaken for a stable import. The source workbook, mappings, preview reports, populated databases, and comparison reports belong in ignored local directories and must never be committed or uploaded to an issue.

Parser support does not imply that every spreadsheet formula can be recalculated outside Excel. Unsupported or ambiguous formulas remain unresolved; cached results may be presented as source evidence but are never silently rewritten or treated as native application logic.

## Normalized interpretation

A workbook can combine distinct kinds of information that must remain separate:

- dated balances used as opening-position or reconciliation evidence;
- recurring transactions used to propose forecast assumptions;
- statement-period metrics used to propose card history;
- shared-expense rows used to propose receivables and settlements;
- card terms or rewards used as reference data.

Repeated totals and reference rows must not become duplicate cash events. Import separates raw source facts, user assumptions, normalized entities, and calculated application outputs. Forecasting, card settlement, transfer timing, net worth, and safe spending are recalculated by the native engine after review.

## Import contract

The importer produces a preview with create, update, skip, conflict, and unresolved decisions. Each proposed field can record its entity and field, source sheet and cell or range, raw and parsed values, transformation, confidence, warning, import batch, and source checksum.

Import is idempotent for the same source and mapping. A user-edited destination becomes a conflict rather than being silently overwritten. Credentials are never read from or written by workbook import. A blank profile remains isolated from records imported into another profile.

Any project-specific local adapter must remain outside public source and obey stricter safeguards:

- an explicit source and target directory;
- an additional opt-in before touching an active app-data directory;
- a transactionally consistent SQLite snapshot before changes;
- a version marker and true repeat-run no-op;
- refusal to replace a profile with native activity or edited lineage;
- no option that bypasses validation against live data.

Once a user begins maintaining imported records in Balance Book, the native editors and reconciliation flow are the update mechanism. A later workbook refresh requires field-level review rather than bulk replacement.

## Validation

Committed tests use synthetic workbooks only. They cover read-only handling, checksum stability, parsing, normalization, field lineage, conflict behavior, idempotence, blank-profile isolation, incomplete values, and duplicate-event prevention.

Teams may run additional ignored comparisons against their own workbooks. Such comparisons should reconcile account paths and card-cycle vectors at integer-cent precision, document every intentional difference, and leave no unexplained deviation before relying on the import. This local evidence does not belong in a public repository or release asset.

## Current limitations

- Import cannot infer a user's desired protected cash floor from a projected low.
- Missing statement history, timing terms, asset values, or policy choices remain unknown instead of becoming zero or invented defaults.
- A neutral parser may preserve but not recalculate unsupported formula regions.
- Import does not merge two independently maintained application profiles.
- Rollback depends on the pre-import database snapshot and verified encrypted portable backups.
