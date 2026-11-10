# Local Supabase migration builder

This workflow is for the isolated `unified-wms-dev` Supabase project only. It does not link to, reset, or push a hosted project. The historical `20261105000000_unified_wms.sql` migration is retained; `20261107100000_local_wms_operational.sql` is assembled from the reviewed root SQL patches in dependency order.

## Packing security work in progress

The development UI blocks finishing sorting and packing by default; direct outbound and history receipt reprints remain blocked. Manual validation controls are disabled. Client-side blocks are not a security boundary and direct RPC access remains unprotected until the database guard is applied. Do not use this workflow for live packing or receipt printing. [The server migration design](./snippets/packing-server-migration-design.sql) and [SQL candidate](./snippets/packing-server-candidate.sql) are review drafts outside the automatic migration directory. The user reported that the revised candidate passed isolated PostgreSQL sequential and concurrency stages. Supabase Auth/JWT, HTTP integration and deployment compatibility remain unverified. Sorting and Mabang and Bulk packing use scan and recovery RPCs behind an off-by-default flag. Review and separate approval are required before application.

The candidate returns server-owned counts, scan request IDs, session state and finish result for an authorized actor to resume after refresh or loss of response. Reusing the same scan/finish request must preserve its original body; a new request ID represents a new operation. Session cancellation discards progress for subsequent work, but leaves its historical events. Receipt proofs bind the completed order snapshot and document revisions; later edits invalidate the proof. Existing completed orders have no proof and are denied until an explicitly reviewed legacy policy exists. Direct outbound remains Administrator-only with a reason and audit; its response can be retrieved by the same actor and request ID.

`SERVER_SCAN_ENABLED` is derived from `VITE_SERVER_SCAN_ENABLED=true` and defaults to off. Mabang sorting and both Mabang and Bulk packing use it to access server sessions and are intended only for isolated integration testing after the candidate SQL is installed there with approval. It does not enable direct outbound or receipt printing. It is not server authorization. Select the destination basket before sorting; accepted scan counts come from the server. Packing session creation verifies the finished sorting proof and matching basket on the server. Sessions and pending request IDs are scoped to the authenticated user and branch in browser storage, while scan evidence remains server-side. The browser must support Web Locks and persistent local storage. After an uncertain response, use **Pulihkan sesi**; the client checks server status before retrying the same request ID. Both packing screens share the task marker, which permits recovery after the order leaves the pending list; completion requires a matching server receipt proof, but printing remains disabled. Sorting completion is per order, so a failure in a multi-basket batch can leave earlier orders completed; resume the remaining sessions rather than starting a new batch. Real Supabase HTTP/Auth/JWT and browser end-to-end testing is still required; do not enable this flag against the active development database.

### Disposable PostgreSQL harness for candidate review

Review [the PowerShell harness](../scripts/isolated-pg-test.ps1) and the SQL files in `scripts/isolated-pg/` before running them. The harness requires an existing locally trusted `postgres:16` image; it uses `--pull never`, and never starts or connects to Supabase. It refuses existing test resource names, creates a labeled test-only container, local volume and internal network with no published ports, verifies their identities and attachments, then connects only via a Unix socket inside that container. It stops on the first failure and retains the resources for investigation. Concurrent Docker administration could invalidate an inspection between checks; use only a trusted local Docker daemon and do not attach other containers or networks to the test resources.

The test bootstrap emulates `auth.users`, `auth.uid()`, `auth.jwt()` and SQL roles; it does not authenticate JWTs. The operational SQL is modified **in memory only** to omit `pg_cron` and its schedule, so it is not an exact reproduction of the Supabase deployment. Tests include synthetic order inserts and completion in the disposable database, never in the existing development database. Passing the harness does not validate Supabase Auth, PostgREST, API gateway, JWT verification, real Supabase grants, realtime, pg_cron, browser integration, or physical scanner provenance. Review failures and do not apply the candidate to any active database based solely on these tests.

From the project directory, after confirming the image provenance and approving temporary resource creation:

```powershell
.\scripts\isolated-pg-test.ps1 -Action Run
```

After review, explicitly delete only the matching labeled test resources with:

```powershell
.\scripts\isolated-pg-test.ps1 -Action Cleanup
```

Cleanup permanently destroys the test volume and refuses resources with unexpected labels, foreign network members, or other containers using the test volume. It does not delete the PostgreSQL image or other volumes. If cleanup refuses or a run fails, inspect the named resources before any further action.

After a failed run, the partially populated database and previously loaded candidate remain in the test volume. Review the named container, network and volume identities and attachments before cleanup; do not reuse that database to test an updated candidate. Once verified, run `Cleanup` and then `Run` to test from a fresh isolated database. If any identity or attachment is unexpected, stop and investigate rather than forcing removal.

## Migration assembly and static checks

From this workspace:

```sh
npm.cmd run supabase:local:migrations
npm.cmd run supabase:local:check
```

The builder copies the root SQL into one ordered versioned migration, removes the early HQ dashboard definition only when it exactly matches the final alignment, adds a missing terminator when a source ends with a dollar-quoted function, and applies the zero-admin-safe constraint to the local administrator guard. A missing terminator before another statement or a changed duplicate HQ definition is rejected. Its static checks cover function terminators, duplicate top-level functions by input signature and duplicate triggers, policies, tables and indexes across the ordered migrations. They also enforce source dependency order, final validator/import/OCC/transfer/dashboard behavior, and ensure the direct table write grant is revoked after the branch schema. The object check does not evaluate dynamic SQL or infer objects created implicitly by constraints. The check command also runs regression tests. Re-run the builder after changing any source SQL. Review the generated migration and `git diff` before using it. The original root SQL files remain source references; do not apply them individually.

Database migration or Supabase startup is deliberately not part of either command. Once a developer separately chooses to test, they may start the configured local project and apply the migrations locally with the Supabase CLI. Do not use `supabase link`, hosted targets, `db push`, or `db reset` as part of this workflow.

## Read-only local preflight

With the local stack already running, run from Windows PowerShell:

```powershell
Set-Location C:\WMS-GITHUB\amri\development\trueblue-wms
npm.cmd run supabase:local
if ($LASTEXITCODE -ne 0) { throw "Local preflight failed; do not bootstrap or seed." }
```

The preflight uses the same Docker, gateway and database-target guard as bootstrap and seed, checks the local Auth health endpoint, and verifies that `supabase/.branches/` is both ignored and not already tracked by Git. It does not write database data, start Supabase, run migrations, bootstrap, or seed, and does not print API keys or response bodies. CLI status failures report an exit code and fixed diagnostic categories without raw output. The exact stopped-imgproxy-only message is accepted only when the running project Storage container on the inspected network explicitly disables image transformation in both runtime flags; missing or conflicting evidence and all other stopped-service lists fail closed. Only the exact CLI 3.0.0 update-notice format is accepted, and only after a successful exit. Required status fields must be present and unambiguous. A failed or unavailable check is a stop, not permission to bypass the guard.

For an already running local stack, `npm.cmd run supabase:local:setup` verifies that `.env` is ignored and untracked, runs the same preflight, and writes the verified local API URL and anonymous key to its four Supabase variables without printing either key. It preserves unrelated settings and refuses ambiguous, duplicate, or unsupported multiline settings and linked `.env` files. It does not write database data. Run `npm.cmd run dev` only after setup succeeds; the development server binds `127.0.0.1` and uses port 3000 unless `PORT` is set. Shell variables override `.env`, so remove conflicting Supabase variables from the shell.

When gateway validation fails, diagnostics enumerate every inspected Kong service, its target category, and the reason it passed or failed. Only recognized standard service names are printed; other names are replaced by an index. Hostnames, IP addresses, URLs and credentials are withheld. A hostname must match the name or Docker network alias of a running project container on the inspected network; an IP must match that container's network IP. A DNS name not present in Docker's inspected aliases is not treated as verified merely because it looks local.

The `rest-admin-v1` service may target port 3001 only on the verified REST container when its Docker environment has exactly one `PGRST_ADMIN_SERVER_PORT=3001` setting. A separate REST API target on port 3000 is still required. This checks container configuration, not listener health. An enabled pooler route whose target container cannot be verified remains a preflight failure; an absent container does not establish that its route is inactive.

## Local pooler configuration

The local configuration enables `[db.pooler]` for Supabase CLI 3.0.0. Its source defines a `supabase_pooler_<project>` Supavisor container with an internal HTTP port 4000, matching the Kong pooler route. It also publishes a separate SQL port and initializes pooler metadata in the local database. This adds an image download, container, memory and CPU usage, and database connections.

Do not restart until you have a backup of any local data you need and have confirmed the Docker context and the custom network's default published-port binding. CLI 3.0.0 publishes the pooler's SQL port without an explicit host IP; an existing loopback binding on other containers does not prove that a new container will be loopback-only. Do not start it if the network does not enforce loopback binding. The commands below do not change Docker configuration. Inspect the network first from Windows PowerShell:

```powershell
docker network inspect trueblue-local-only --format '{{ index .Options "com.docker.network.bridge.host_binding_ipv4" }}'
```

Only proceed after the output is `127.0.0.1`, the context is the intended local Docker Desktop context, and the network configuration is trusted to enforce that binding. Preserve the existing custom network explicitly; do not use `--no-backup`, `--all`, `db reset`, or `db push`. Normal stop preserves volumes, but startup can initialize services and apply pending local migrations. Review those effects before proceeding:

```powershell
Set-Location C:\WMS-GITHUB\amri\development\trueblue-wms
$previousNetwork = $env:SUPABASE_NETWORK_ID
$env:SUPABASE_NETWORK_ID = 'trueblue-local-only'
try {
  node node_modules\supabase\dist\supabase.js stop --project-id unified-wms-dev *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Local stop failed; inspect safely before proceeding.' }
  node node_modules\supabase\dist\supabase.js start *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Local start failed; inspect safely before proceeding.' }
} finally {
  if ($null -eq $previousNetwork) {
    Remove-Item Env:\SUPABASE_NETWORK_ID -ErrorAction SilentlyContinue
  } else {
    $env:SUPABASE_NETWORK_ID = $previousNetwork
  }
}
$names = @(docker ps -a --format '{{.Names}}' | Where-Object { $_ -like 'supabase_*_unified-wms-dev' })
if ($LASTEXITCODE -ne 0 -or $names.Count -eq 0) { throw 'Cannot list local project containers.' }
$containers = @(docker inspect @names | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local project containers.' }
foreach ($container in $containers) {
  foreach ($port in $container.NetworkSettings.Ports.PSObject.Properties) {
    foreach ($binding in @($port.Value)) {
      if ($null -eq $binding) { continue }
      Write-Output "$($container.Name) $($port.Name) $($binding.HostIp):$($binding.HostPort)"
      if ($binding.HostIp -notin @('127.0.0.1', '::1')) { throw 'Non-loopback port binding detected; stop and investigate.' }
    }
  }
}
npm.cmd run supabase:local
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed; do not bootstrap or seed.' }
```

The CLI output is suppressed because it can contain credentials. If the pooler is absent, any published port is not loopback-only, or preflight fails, stop and investigate without bootstrapping or seeding. The guard accepts the observed `http` upstream for the enabled `pooler-v2-ws` service only when it targets the verified project Pooler at port 4000 on `trueblue-local-only`, and its Kong route and upstream path match the expected configuration. Other Pooler upstream protocols are rejected. Do not bypass the guard.

The local `.branches` selector is Supabase CLI metadata, not a versioned SQL migration. The migration builder reads `supabase/migrations/` and its listed SQL source files, not `.branches`. Do not delete or change the selector to fix this check; if it is non-default, review the CLI's selected branch and local stack before running any migration command. If metadata is already tracked, an ignore rule alone does not remove it from Git's index; review the situation before making any index changes.

## Local administrator bootstrap

The scripts require the exact API URL `http://127.0.0.1:54321`, a local Windows Docker named-pipe context, the expected project containers and network, loopback-only published project ports, and local Auth/REST database targets. They allow only the standard `supabase_network_unified-wms-dev` or `trueblue-local-only` network, require exactly one shared by the expected services, and verify network IDs and membership. They also query the Kong Admin API inside its container and reject gateway upstreams outside the project network. Gateway inspection uses `nc` to send a single raw HTTP request to the container's loopback interface; it does not follow redirects or use proxies. It requires HTTP 200, a complete content-length-framed UTF-8 JSON response, and rejects redirects, compression and transfer encoding. If `nc` or the expected response framing is unavailable, the check fails closed. API redirects and non-local requests are refused. Unset `DOCKER_HOST`, `DOCKER_CONTEXT`, `NODE_OPTIONS`, `NODE_USE_ENV_PROXY`, and proxy environment variables. The known nonfatal Docker warning about a non-default seccomp profile and the exact CLI update notice described above are accepted; unrecognized warnings, including inaccessible Docker configuration, fail closed. Inspection errors identify the stage without printing raw output. The project configuration must identify `unified-wms-dev`. These checks rely on trusted local Docker configuration and cannot prove that a compromised local daemon or gateway routes requests honestly.

The migration creates an inactive Viewer profile for a new Auth user. Bootstrap only attempts signup using a new dummy email under `example.invalid`, `example.com`, `example.net`, or `example.org`; it does not sign in to or promote an existing account. It verifies the returned identity and a freshly generated signup marker through Auth before creating a separate service-role client, then conditionally promotes only the matching inactive CENTER Viewer profile. It does not grant profile write access to authenticated users. Signup errors report only a recognized category and HTTP status, not raw server details. If signup returns no session, including when confirmation is required, it stops without promotion; inspect local Auth and profile state before choosing a new dummy email. A failed or interrupted signup may already have created an Auth user and Viewer profile; do not delete, promote, or retry it automatically.

From PowerShell in this workspace, with the intended local stack already running:

```powershell
Set-Location C:\WMS-GITHUB\amri\development\trueblue-wms
$admin = Get-Credential -Message "Local admin email and password"
$env:WMS_LOCAL_ADMIN_EMAIL = $admin.UserName
$env:WMS_LOCAL_ADMIN_PASSWORD = $admin.GetNetworkCredential().Password
try {
  npm.cmd run supabase:local:bootstrap-admin
  if ($LASTEXITCODE -ne 0) { throw "Bootstrap failed; inspect local state before proceeding." }
} finally {
  Remove-Item Env:\WMS_LOCAL_ADMIN_EMAIL, Env:\WMS_LOCAL_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $admin = $null
}
```

Use locally chosen credentials, never company credentials. The local Auth server may reject a particular reserved email domain; the signup error category identifies that condition without exposing credentials. Keys and passwords are not printed by these scripts; environment variables and process memory still contain sensitive values while the scripts run.

## Synthetic seed

Proceed only after bootstrap succeeds, the local environment is confirmed disposable, and no existing data may be modified. The seed requires an active `CENTER` administrator and checks all fixed document IDs, the branch ID, and both operator Auth/profile emails before writing. It refuses collisions rather than overwriting or rotating passwords. `CENTER` remains the migration's default branch; the seed adds `DEV_LOCAL`, two warehouses, 100 catalog SKUs, 200 stock positions, 100 pending orders, and two active Auth users with Picker/Packer profiles. No administrator is created by the seed.

Choose two different local passwords of at least 12 characters. The following prompts keep them out of command history; neither the script nor this procedure prints them:

```powershell
$picker = Get-Credential -UserName "picker.local@example.invalid" -Message "Choose local Picker password"
$packer = Get-Credential -UserName "packer.local@example.invalid" -Message "Choose local Packer password"
$env:WMS_LOCAL_PICKER_PASSWORD = $picker.GetNetworkCredential().Password
$env:WMS_LOCAL_PACKER_PASSWORD = $packer.GetNetworkCredential().Password
try {
  npm.cmd run supabase:local:seed
  if ($LASTEXITCODE -ne 0) { throw "Seed failed; inspect partial state before doing anything else." }
} finally {
  Remove-Item Env:\WMS_LOCAL_PICKER_PASSWORD, Env:\WMS_LOCAL_PACKER_PASSWORD -ErrorAction SilentlyContinue
  $picker = $null
  $packer = $null
}
```

Do not run the seed again after success or use it to restore changed simulations: a collision is a stop, not an update. Preflight and writes are separate requests, so concurrent writes can still cause partial completion; inserts and conditional profile updates prevent replacing conflicting existing records.

### Recovering a partial seed

Do not rerun or automatically delete anything. Save the error report, which lists confirmed operations and the operation whose outcome may be uncertain. In local Studio, check the exact `DEV_LOCAL` branch, the two fixture emails and their Auth IDs/profiles, and fixture document IDs; a timed-out operation may have committed even if not listed as confirmed. Review associated audit events and stock movements as well. If a fixture has been used or modified, preserve it and resolve the state with an authorized local administrator. The history guard can prohibit deleting orders, so do not bypass it or delete records by a broad prefix. If the partial fixture cannot be safely reconciled, use a separately provisioned isolated development environment after obtaining approval; do not reset or delete this project. Passwords are never included in the recovery report.

Seed database errors report an allowlisted SQLSTATE/PostgREST category and HTTP status. For SQLSTATE 42501, exact recognized PostgreSQL messages additionally report a fixed object or RLS category; unknown messages, raw details and hints remain withheld. PostgreSQL may omit the schema, and these names alone do not prove the failing execution context. This does not recover the cause of an earlier failure. Before preparing document-only recovery, confirm the prior error or read-only privilege evidence, recheck all fixture IDs and related history, and verify the existing branch and operator identities. Never rerun the original seed to recover only documents.

For the specific local incident where the revision sequence privilege was found missing, the minimum proposed grant is `GRANT USAGE ON SEQUENCE wms_private.document_revision_seq TO service_role;`. The revision default is an early-bound `regclass` sequence reference; do not grant access to all sequences or assume schema-wide access is needed. This statement changes database permissions: apply it only after explicit approval, confirming the SQL editor is the isolated `unified-wms-dev` instance, and recording the prior ACL. Do not execute it against hosted or production databases. If the original error was not captured, missing sequence privilege is a strong candidate, not conclusive proof that no other error exists.

After separate approval and the local permission change, the document-only recovery command can be run from PowerShell:

```powershell
Set-Location C:\WMS-GITHUB\amri\development\trueblue-wms
$env:WMS_LOCAL_DOCUMENT_RECOVERY = 'I_APPROVE_DOCUMENT_RECOVERY'
try {
  npm.cmd run supabase:local:recover-documents
  if ($LASTEXITCODE -ne 0) { throw 'Recovery failed; inspect local state before retrying.' }
} finally {
  Remove-Item Env:\WMS_LOCAL_DOCUMENT_RECOVERY -ErrorAction SilentlyContinue
}
```

Recovery repeats the local Docker/gateway/database guard, verifies the existing branch, administrator, and both Auth/profile identities, and refuses any existing branch documents, stock movements, or relevant activity history. It inserts only the 402 documents and verifies their IDs; it never creates or updates users, profiles, or branches. Do not use it if the fixture has already been used. Preflight and insert are separate requests, so stop concurrent writers and investigate any failure or uncertain result before retrying. Sequence numbers can advance even when PostgreSQL rolls back an insert. Once recovery is verified, review whether to revoke this narrowly scoped privilege; do not revoke access needed by other authorized local operations.

## Suggested local verification

1. Run the static check and review generated migration order; verify the historical migration remains unchanged.
2. On a disposable local Supabase project, apply migrations in timestamp order. Do not apply the root source SQL files separately.
3. Bootstrap the local administrator with a password-authenticated session, then run the synthetic seed.
4. Run each SQL test in `supabase/tests/` against that local database only. They use synthetic fixtures and roll back, but must never be run against hosted databases.
5. Add explicit two-warehouse scenarios: two operators, 100 SKUs, and 100 orders; verify branch RLS, warehouse identity, exact-once picking, sorting without stock changes, packing without a second deduction, duplicate import rejection, retry idempotency, and stale-revision rejection.

The seed creates all 100 SKUs in each warehouse (200 stock positions total). It is for shape and workflow tests, not load testing. No database or SQL test is run by the migration builder or static checker.
