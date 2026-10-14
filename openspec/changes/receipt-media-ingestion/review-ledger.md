# Review Ledger — Receipt Media Ingestion

## WU1A — Approved dependencies

**Lens:** reliability | **Verdict:** PASS | **Commit:** `bbb3f0f`

| ID     | Severity | Status   | Finding                                                                                                                                                 |
| ------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-001 | Info     | Accepted | `prom-client@15.1.3` is deprecated in favor of `@prometheus-io/client`; retain the approved v1 API and revisit during a deliberate migration.           |
| R3-002 | Info     | Accepted | The smoke spec reads `package.json` from Jest's repository-root working directory; supported commands run from that root.                               |
| R3-003 | Info     | Accepted | The direct-package guard focuses on runtime AWS dependencies and the forbidden ipaddr shim; package/lock review confirmed no accidental direct package. |
| R3-004 | Warning  | Deferred | The repository has no tracked CI workflow or `test.only` guard; this is pre-existing and outside WU1A.                                                  |

## WU1B — Typed disabled configuration

**Lens:** risk | **Verdict:** PASS | **Evidence:** `sha256:c2c26472842e9d8e0e871d2c590eb2dbfd38f54e49f17cdbba4611f2e9adab68`

| ID       | Severity | Status         | Finding                                                                                                                                               |
| -------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| RISK-001 | Info     | Scoped to WU1C | Factory numeric parsing may yield `NaN` for malformed values; WU1C owns fail-fast Joi validation while WU1B remains default-disabled.                 |
| RISK-002 | Info     | Accepted       | Default assertions assume receipt env values are absent on the supported test command; WU1C will centralize receipt environment fixtures and cleanup. |
