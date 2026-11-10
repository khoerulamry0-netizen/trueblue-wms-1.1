$ErrorActionPreference = 'Stop'
$project = 'trueblue-http-isolated-test'
$config = Join-Path $PSScriptRoot 'isolated-supabase\supabase\config.toml'

function Read-Docker([string[]] $Arguments) {
  $result = & docker @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Read-only Docker inspection failed: $($Arguments[0]); output withheld." }
  return $result
}

function Invoke-IsolatedVerification([string] $Project, [string] $ConfigPath) {
  $expectedConfigHash = '5E5D62265182276EE739BAC0A7C5E12D29EF478153D57A075C8A26E15CC6F992'
  if ((Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash -ne $expectedConfigHash) {
    throw 'Test configuration differs from the reviewed fingerprint.'
  }
  if ($env:DOCKER_HOST -or $env:DOCKER_CONTEXT) {
    throw 'Unset DOCKER_HOST and DOCKER_CONTEXT before inspecting the local Docker context.'
  }

  $services = @('kong', 'auth', 'rest', 'db')
  $contexts = @(Read-Docker -Arguments @('context', 'inspect') | ConvertFrom-Json)
  if ($contexts.Count -ne 1 -or $contexts[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
    throw 'Docker must use a local Windows named-pipe context.'
  }

  $names = @(Read-Docker -Arguments @('ps', '-a', '--format', '{{.Names}}'))
  $expectedNames = @($services | ForEach-Object { "supabase_${_}_$Project" })
  $projectNames = @($names | Where-Object { $_ -like "supabase_*_$Project" })
  foreach ($name in $projectNames) {
    if ($expectedNames -notcontains $name) { throw "Unexpected test project service: $name." }
  }
  $containers = @()
  foreach ($name in $expectedNames) {
    if (@($names | Where-Object { $_ -eq $name }).Count -ne 1) { throw "Expected test container is missing or ambiguous: $name." }
    $inspection = @(Read-Docker -Arguments @('inspect', $name) | ConvertFrom-Json)
    if ($inspection.Count -ne 1 -or $inspection[0].Name -ne "/$name" -or
        -not $inspection[0].Id -or -not $inspection[0].State.Running) {
      throw "Test container is not uniquely identified and running: $name."
    }
    $containers += $inspection[0]
  }
  $ids = @($containers | ForEach-Object { $_.Id })
  if (@($ids | Select-Object -Unique).Count -ne $containers.Count) { throw 'Test container IDs are ambiguous.' }

  $networkName = "supabase_network_$Project"
  $networkResult = @(Read-Docker -Arguments @('network', 'inspect', $networkName) | ConvertFrom-Json)
  if ($networkResult.Count -ne 1 -or $networkResult[0].Name -ne $networkName -or -not $networkResult[0].Id) {
    throw 'Expected test network was not uniquely identified.'
  }
  $network = $networkResult[0]
  foreach ($member in @($network.Containers.PSObject.Properties)) {
    if ($ids -notcontains $member.Name) { throw 'Test network contains a foreign container.' }
  }

  $apiBindings = 0
  $dbBindings = 0
  foreach ($container in $containers) {
    $attachments = @($container.NetworkSettings.Networks.PSObject.Properties)
    if ($attachments.Count -ne 1 -or $attachments[0].Name -ne $networkName -or
        $attachments[0].Value.NetworkID -ne $network.Id -or -not $network.Containers.($container.Id)) {
      throw 'A test project container has unexpected network attachments.'
    }
    foreach ($port in @($container.NetworkSettings.Ports.PSObject.Properties)) {
      foreach ($binding in @($port.Value)) {
        if ($null -eq $binding) { continue }
        if ($binding.HostIp -ne '127.0.0.1') { throw 'A project container publishes a port outside the reviewed loopback address.' }
        if ($container.Name -eq "/supabase_kong_$Project" -and $port.Name -eq '8000/tcp' -and $binding.HostPort -eq '55421') {
          $apiBindings++
        } elseif ($container.Name -eq "/supabase_db_$Project" -and $port.Name -eq '5432/tcp' -and $binding.HostPort -eq '55422') {
          $dbBindings++
        } else {
          throw 'A project container publishes an unexpected port mapping.'
        }
      }
    }
  }
  if ($apiBindings -ne 1 -or $dbBindings -ne 1) { throw 'Expected API or database loopback binding is missing or ambiguous.' }

  $dbMounts = @($containers[3].Mounts | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })
  if ($dbMounts.Count -ne 1 -or $dbMounts[0].Type -ne 'volume' -or
      $dbMounts[0].Name -notlike "*$Project*") {
    throw 'Database data volume is not uniquely attributable to the test project.'
  }
  $volumeName = $dbMounts[0].Name
  $volume = @(Read-Docker -Arguments @('volume', 'inspect', $volumeName) | ConvertFrom-Json)
  if ($volume.Count -ne 1 -or $volume[0].Name -ne $volumeName -or $volume[0].Driver -ne 'local') {
    throw 'Database volume identity is ambiguous.'
  }
  $volumeUsers = @(Read-Docker -Arguments @('ps', '-a', '--filter', "volume=$volumeName", '--format', '{{.Names}}'))
  if ($volumeUsers.Count -ne 1 -or $volumeUsers[0] -ne "supabase_db_$Project") {
    throw 'Database volume is shared with another container.'
  }

  foreach ($pair in @(@(1, 'GOTRUE_DB_DATABASE_URL'), @(2, 'PGRST_DB_URI'))) {
    $entries = @($containers[$pair[0]].Config.Env | Where-Object { $_.StartsWith("$($pair[1])=") })
    if ($entries.Count -ne 1) { throw 'Required database target could not be uniquely inspected.' }
    try { $uri = [Uri]($entries[0].Substring($pair[1].Length + 1)) }
    catch { throw 'Required database target is invalid; details withheld.' }
    $dbNetwork = $containers[3].NetworkSettings.Networks.$networkName
    $aliases = @($dbNetwork.Aliases) + @("supabase_db_$Project")
    if ($uri.Scheme -notin @('postgres', 'postgresql') -or $aliases -notcontains $uri.Host -or
        ($uri.Port -ne -1 -and $uri.Port -ne 5432) -or $uri.AbsolutePath -ne '/postgres') {
      throw 'Auth or PostgREST is not configured for the expected test database; details withheld.'
    }
  }

  Write-Host 'Partial read-only checks passed: reviewed service list, network membership, volume use, port mappings, and database target configuration.'
  throw 'Verification INCOMPLETE: gateway upstream/routes, provenance of the named database volume, and database marker are not verified. Do not apply SQL, create users, or clean up.'
}

Invoke-IsolatedVerification -Project $project -ConfigPath $config
