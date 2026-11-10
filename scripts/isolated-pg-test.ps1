param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Run', 'Cleanup')]
  [string] $Action
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = Split-Path -Parent $PSScriptRoot
$container = 'trueblue-packing-test-pg'
$network = 'trueblue-packing-test-network'
$volume = 'trueblue-packing-test-volume'
$labelKey = 'org.trueblue.packing-isolated-test'
$labelValue = 'v1'
$image = 'postgres:16'

function Invoke-Docker([string[]] $DockerArgs) {
  $result = & docker @DockerArgs 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($DockerArgs[0]); output withheld." }
  return $result
}

function Assert-LocalDocker {
  if ($env:DOCKER_HOST -or $env:DOCKER_CONTEXT) {
    throw 'Unset DOCKER_HOST and DOCKER_CONTEXT before running this harness.'
  }
  $context = @(Invoke-Docker @('context','inspect') | ConvertFrom-Json)
  if ($context.Count -ne 1 -or $context[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
    throw 'Docker must use a local Windows named-pipe context.'
  }
  $null = Invoke-Docker @('info','--format','{{.ServerVersion}}')
}

function Get-Names([string] $Kind) {
  if ($Kind -eq 'container') { return @(Invoke-Docker @('ps','-a','--format','{{.Names}}')) }
  if ($Kind -eq 'network') { return @(Invoke-Docker @('network','ls','--format','{{.Name}}')) }
  return @(Invoke-Docker @('volume','ls','--format','{{.Name}}'))
}

function Assert-Label($Labels, [string] $Name) {
  if ($null -eq $Labels -or $Labels.$labelKey -ne $labelValue) {
    throw "Resource $Name does not have the expected test label; refusing to proceed."
  }
}

function Assert-IsolatedContainer {
  $c = @(Invoke-Docker @('inspect',$container) | ConvertFrom-Json)
  $n = @(Invoke-Docker @('network','inspect',$network) | ConvertFrom-Json)
  $v = @(Invoke-Docker @('volume','inspect',$volume) | ConvertFrom-Json)
  if ($c.Count -ne 1 -or $n.Count -ne 1 -or $v.Count -ne 1) { throw 'Unexpected resource inspection result.' }
  Assert-Label $c[0].Config.Labels $container
  Assert-Label $n[0].Labels $network
  Assert-Label $v[0].Labels $volume
  if ($c[0].Name -ne "/$container" -or $c[0].Config.Image -ne $image -or -not $c[0].State.Running -or
      -not $n[0].Internal -or $n[0].Name -ne $network -or $v[0].Driver -ne 'local') {
    throw 'Test resource identity or internal-network check failed.'
  }
  $networks = @($c[0].NetworkSettings.Networks.PSObject.Properties)
  $members = @($n[0].Containers.PSObject.Properties)
  if ($networks.Count -ne 1 -or $networks[0].Name -ne $network -or $networks[0].Value.NetworkID -ne $n[0].Id -or
      $members.Count -ne 1 -or $members[0].Name -ne $c[0].Id) {
    throw 'Unexpected network attachment; refusing SQL execution.'
  }
  if (@($c[0].Mounts).Count -ne 1 -or $c[0].Mounts[0].Type -ne 'volume' -or
      $c[0].Mounts[0].Name -ne $volume -or $c[0].Mounts[0].Destination -ne '/var/lib/postgresql/data') {
    throw 'Unexpected container mounts; refusing SQL execution.'
  }
  foreach ($port in @($c[0].NetworkSettings.Ports.PSObject.Properties)) {
    if ($null -ne $port.Value) { throw 'Published port detected; refusing SQL execution.' }
  }
  if ($null -ne $c[0].HostConfig.PortBindings -and @($c[0].HostConfig.PortBindings.PSObject.Properties).Count -ne 0) {
    throw 'Host port binding detected; refusing SQL execution.'
  }
}

function Invoke-TestSql([string] $Name, [string] $Sql) {
  Assert-IsolatedContainer
  Write-Host "Running isolated stage: $Name"
  $Sql | & docker exec -i $container psql -X -q -v ON_ERROR_STOP=1 -h /var/run/postgresql -U postgres -d wms_isolated_test
  if ($LASTEXITCODE -ne 0) { throw "Isolated SQL stage failed: $Name. Do not treat later stages as passed." }
}

Assert-LocalDocker
if ($Action -eq 'Cleanup') {
  $containers = @(Get-Names 'container')
  $networks = @(Get-Names 'network')
  $volumes = @(Get-Names 'volume')
  if ($containers -contains $container) {
    $c = @(Invoke-Docker @('inspect',$container) | ConvertFrom-Json)[0]
    Assert-Label $c.Config.Labels $container
    if ($c.Name -ne "/$container" -or $c.Config.Image -ne $image) { throw 'Container identity mismatch.' }
    if (@($c.Mounts).Count -ne 1 -or $c.Mounts[0].Type -ne 'volume' -or
        $c.Mounts[0].Name -ne $volume -or $c.Mounts[0].Destination -ne '/var/lib/postgresql/data') {
      throw 'Container has unexpected mounts; cleanup refused.'
    }
    $attachments = @($c.NetworkSettings.Networks.PSObject.Properties)
    if ($attachments.Count -ne 1 -or $attachments[0].Name -ne $network) {
      throw 'Container has unexpected network attachments; cleanup refused.'
    }
  }
  if ($networks -contains $network) {
    $n = @(Invoke-Docker @('network','inspect',$network) | ConvertFrom-Json)[0]
    Assert-Label $n.Labels $network
    foreach ($member in @($n.Containers.PSObject.Properties)) {
      if ($containers -notcontains $container -or $member.Name -ne $c.Id) { throw 'Network has a foreign container; cleanup refused.' }
    }
  }
  if ($volumes -contains $volume) {
    $v = @(Invoke-Docker @('volume','inspect',$volume) | ConvertFrom-Json)[0]
    Assert-Label $v.Labels $volume
    $users = @(Invoke-Docker @('ps','-a','--filter',"volume=$volume",'--format','{{.Names}}'))
    if (@($users | Where-Object { $_ -ne $container }).Count -gt 0) { throw 'Volume used by a foreign container; cleanup refused.' }
  }
  if ($containers -contains $container) { $null = Invoke-Docker @('rm','-f',$container) }
  if ($networks -contains $network) { $null = Invoke-Docker @('network','rm',$network) }
  if ($volumes -contains $volume) { $null = Invoke-Docker @('volume','rm',$volume) }
  Write-Host 'Only matching labeled test resources were removed; the image was retained.'
  return
}

if ((@(Get-Names 'container') -contains $container) -or (@(Get-Names 'network') -contains $network) -or (@(Get-Names 'volume') -contains $volume)) {
  throw 'A test resource name already exists. Inspect it; setup will not reuse or delete it.'
}
$null = Invoke-Docker @('image','inspect',$image)
$null = Invoke-Docker @('volume','create','--label',"$labelKey=$labelValue",$volume)
$null = Invoke-Docker @('network','create','--internal','--label',"$labelKey=$labelValue",$network)
$null = Invoke-Docker @('run','-d','--pull','never','--name',$container,'--network',$network,
  '--label',"$labelKey=$labelValue",'--mount',"type=volume,source=$volume,target=/var/lib/postgresql/data",
  '--memory','512m','--pids-limit','128','-e','POSTGRES_DB=wms_isolated_test',
  '-e','POSTGRES_PASSWORD=isolated-synthetic-only',$image)
Assert-IsolatedContainer
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  & docker exec $container pg_isready -q -h /var/run/postgresql -U postgres -d wms_isolated_test
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Isolated PostgreSQL did not become ready; inspect before cleanup.' }

$bootstrap = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'isolated-pg\bootstrap.sql')
$base = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'supabase\migrations\20261105000000_unified_wms.sql')
$operational = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'supabase\migrations\20261107100000_local_wms_operational.sql')
$cronExtension = 'create extension if not exists pg_cron;'
$cronSchedule = "select cron.schedule('blues-wms-daily-backup','0 20 * * *','select wms_private.backup_all_branches();');"
foreach ($needle in @($cronExtension,$cronSchedule)) {
  if ([regex]::Matches($operational,[regex]::Escape($needle)).Count -ne 1) { throw 'Unexpected pg_cron baseline; no replacement attempted.' }
}
$operational = $operational.Replace($cronExtension,'-- pg_cron omitted in isolated test')
$operational = $operational.Replace($cronSchedule,'-- cron schedule omitted in isolated test')
Invoke-TestSql 'Supabase emulation' $bootstrap
Invoke-TestSql 'base migration' $base
Invoke-TestSql 'operational migration with pg_cron omitted' $operational
Invoke-TestSql 'synthetic fixtures' (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'isolated-pg\fixtures.sql'))
Invoke-TestSql 'review candidate' (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'supabase\snippets\packing-server-candidate.sql'))
Invoke-TestSql 'sequential regression' (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'isolated-pg\sequential.sql'))
Invoke-TestSql 'concurrency regression' (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'isolated-pg\concurrency.sql'))
Write-Host 'Isolated SQL stages completed. Supabase HTTP/JWT/Auth/Realtime and deployment integration were NOT tested.'
