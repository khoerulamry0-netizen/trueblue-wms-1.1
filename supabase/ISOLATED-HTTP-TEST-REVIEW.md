# Isolated Supabase HTTP/Auth test proposal

This is a review proposal, not an executable setup or a test result. Do not start
the proposed stack or apply SQL to any existing project. It does not authorize
using the active `unified-wms-dev` database.

## Proposed isolation

- Project ID: `trueblue-http-isolated-test`, in its own work directory with its
  own Supabase configuration and migrations. Never use the workspace's active
  Supabase directory as a work directory.
- Dedicated Supabase CLI-managed containers, network and volumes named from
  that project ID; verify actual names and labels against the installed CLI
  before using them. Existing project and PostgreSQL test resources are excluded.
- Proposed API `127.0.0.1:55421`, database `127.0.0.1:55422`, Studio `55423`,
  mail `55424`, SMTP `55425`, POP3 `55426`, shadow database `55420`,
  analytics `55427`, edge inspector `55428`, disabled pooler `55429`,
  vector `55430`, browser app `3300`.
  Disable unneeded services and verify every effective port, including pooler
  and any CLI-version-specific defaults, before starting. The read-only
  preflight checks the listed TCP ports, not unspecified or UDP ports; it
  cannot reserve them after it exits.
- The [review configuration](../scripts/isolated-supabase/supabase/config.toml)
  specifies these ports and disables migrations and seed. It has not been
  validated against the installed CLI and must not be used to start a stack.
  CLI defaults and omitted settings may introduce additional resources or ports.
  CLI 3.0.0 source defines optional SMTP, POP3 and vector ports, so explicit
  test-only values are supplied even while mail and analytics are disabled.
  The installed workspace npm package identifies itself as 3.0.0; the version
  of the separately invoked Windows `supabase` command must still be confirmed.
  Source references: [database settings](https://github.com/supabase/cli/blob/v3.0.0/packages/config/src/db.ts),
  [mail settings](https://github.com/supabase/cli/blob/v3.0.0/packages/config/src/inbucket.ts),
  [analytics settings](https://github.com/supabase/cli/blob/v3.0.0/packages/config/src/analytics.ts).
- The user verified that `supabase start --workdir` uses the supplied directory
  without ancestor search. Any future setup must use the absolute path of
  `scripts\isolated-supabase`, reject symlink/junction redirection, and confirm
  its project config and empty migrations/seed before startup. Do not use
  `--network-id` until its effects on all required service connections, image
  retrieval, and published-port isolation have been verified in a separate,
  user-approved run; `--internal` is not assumed to be compatible.
- Use only a local named-pipe Docker context. Before any mutation, inspect
  resource names, labels, network membership, mounts and port bindings; refuse
  unknown resources. Recheck identity before every SQL stage and cleanup.
  Remove only resources proven to belong exclusively to this test. Never use
  broad prune, reset, or cleanup commands.
- A disposable fixture must contain only synthetic branches `TEST_LOCAL` and
  `TEST_OTHER`, catalog barcode `TEST-CODE-A`, test stock and isolated order
  references. Create real Auth users through the new Auth service for admin,
  picker, packer, second packer, other-branch packer, and a denied user.
  Set profile roles and branch membership in the new database only. Generate
  passwords and keys at runtime; do not print or commit them.

## Required blockers before setup and execution

1. `server.ts` and `src/supabase.ts` hard-code the active development API port
   `54321`. The actual browser app cannot use the proposed API port without a
   separately reviewed, fail-closed test-only runtime configuration. Changing
   the active development guard or pointing the test to `54321` is not safe.
2. The CLI's exact version-specific project naming, optional service ports,
   startup flags, image availability and bind addresses have not been verified.
   Startup scripts must verify the live Docker network, database container,
   published API binding and upstream identity, not merely trust an environment
   variable or a successful HTTP response. Use a fresh project-specific
   database marker and validate it over the local container socket before any
   fixtures or requests. The preflight in this repository only checks *absence*
   before setup; it is not such an identity guard.
3. The old PostgreSQL harness creates mock `auth.users`, `auth.uid()` and roles;
   it is unsuitable for actual Auth/JWT tests. Existing SQL fixture inserts
   directly into this mock table and cannot be used unchanged for GoTrue login.
   A new fixture must create real users and independently guard the target.
4. No isolated Supabase setup, actual HTTP runner, browser runner, or safe
   cleanup script has yet been implemented or verified. Do not run migration or
   switch on the feature flag based on this document.
5. Real browser automation needs an installed browser runner and a test-only
   app startup with the same verified backend identity. Neither is prepared.
   The test must check fresh server state after UI actions, not UI labels alone.

## HTTP and browser test acceptance matrix

Only count a test as passed after it actually runs against the isolated stack.
All requests must reject redirects and proxy variables, use the exact verified
loopback origin, and avoid logging credentials or JWTs.

1. Create synthetic users via Auth and sign in; confirm genuine JWT and expired,
   missing and tampered JWT rejection. Verify role and branch via server.
2. With real JWTs test admin, picker, packer, denied and foreign-branch roles;
   direct SQL/RLS access and another operator's scan session must fail where
   unauthorized.
3. Test missing/stale sorting proof, wrong basket, invalid SKU, excessive qty,
   incomplete and duplicate finish. Re-read progress with status RPC.
4. Send identical scan and finish request IDs twice, and send conflicting
   bodies with the same ID. Validate one recorded event/transaction server-side.
   Simulate a lost HTTP response after confirmed server commit by discarding the
   response, then query status and retry the same ID. A client timeout alone
   does not establish that the transaction committed.
5. Confirm `Completed` and exact line quantities by an independently authorized
   server read. Reject missing/stale receipt proof and ensure print controls
   remain disabled for pending, legacy and completed orders.
6. Browser: real picking, sorting and both packing screens using synthetic
   barcodes; refresh, double-click, network interruption, wrong operator and
   cross-branch scenarios. Inspect the server after each action. Confirm that
   print and legacy direct outbound remain blocked throughout.

The current candidate proof is revision-bound, not time-expiring; “expired”
here means a proof made stale by changing the order revision. No time-based
expiry test is valid unless a separate policy is implemented and approved.

## Capacity and risk

Reserve approximately 4–8 GB RAM and 10–20 GB free disk for a second local
Supabase stack, images, database, and browser; actual consumption depends on
versions and images. Docker Desktop may share image cache but not project data.
Port probes race with other processes and CLI defaults may introduce additional
bindings. Docker bind addresses, network attachments, project ID collisions and
CLI cleanup behavior must be verified before an executable setup is approved.
