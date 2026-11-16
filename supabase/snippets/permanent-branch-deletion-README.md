# Branch deletion draft — do not deploy

Production branch deletion remains disabled. The SQL in this directory is an
experimental candidate, not a migration and not ready for real data.

Run the synthetic PostgreSQL checks with
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/isolated-branch-deletion-test.ps1 -Action Run`.
Run the same command with `-Action Cleanup` afterwards. The harness creates
labeled, isolated Docker resources and refuses to remove resources with a
different identity. It does not connect to production.

The test covers recovery of synthetic stock and one completed order, a modified
file, stale snapshots, unverified local backups, authorization and recent-password
checks. It also checks that a deliberately introduced conflicting trigger causes
an atomic rollback and that two deletion plans for one branch do not deadlock.
The experimental restoration trigger preserves order payloads after normal
insertion triggers; it needs further security and realistic-history testing.

Remaining work includes full recovery tests for all record types and old local
backups, safe handling of transfers and existing user accounts, concurrent
writers and other request combinations, size/resource limits and expiration cleanup, compatibility
with the actual production schema, review of privilege boundaries, and a
usable export/verification/recovery interface. Technical write-request replay
records are retained in the export but intentionally not replayed on recovery;
restored documents receive new revisions. Local backup payloads stored outside
the database are not included, so the draft refuses deletion in that case. Other branch
history and audit requirements must be preserved.
