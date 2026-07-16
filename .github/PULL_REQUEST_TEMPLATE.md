## Summary

Describe the user problem, the behavior introduced, and why this approach was chosen.

## Risk and compatibility

- Financial semantics:
- Privacy and security:
- Stored-data or migration impact:
- Backup/import/export compatibility:
- Accessibility and responsive-layout impact:

## Verification

List focused checks and the result of `pnpm verify`. State any check that could not run.

## Checklist

- [ ] The change is focused and contains no unrelated generated files.
- [ ] Tests and fixtures use synthetic data only.
- [ ] I reviewed the complete diff for private data, credentials, local paths, databases, workbooks, backups, exports, and screenshots.
- [ ] `pnpm privacy:check` passes.
- [ ] Exact-cent, calendar-date, profile-isolation, and conservative-guidance invariants are preserved where applicable.
- [ ] New or changed stored data has migration and rollback consideration.
- [ ] User-facing behavior was checked for keyboard use, narrow screens, and both themes where applicable.
- [ ] Documentation reflects changes to behavior, security boundaries, backup compatibility, installation, or release procedures.
- [ ] I have not claimed signing, certification, publication, or external review without evidence.

Security vulnerabilities must be reported privately according to SECURITY.md, not submitted as a pull request before coordination with the maintainers.
