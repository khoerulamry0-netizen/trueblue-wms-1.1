param([string] $ScriptsPath = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
$file = Join-Path $ScriptsPath 'isolated-supabase-verify.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Verifier failed to parse.' }
foreach ($name in @('Read-Docker', 'Invoke-IsolatedVerification')) {
  $found = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true))
  if ($found.Count -ne 1) { throw "Expected one function: $name" }
  . ([scriptblock]::Create($found[0].Extent.Text))
}

$project = 'trueblue-http-isolated-test'
$networkName = "supabase_network_$project"
$config = Join-Path $ScriptsPath 'isolated-supabase\supabase\config.toml'
function Reset-Fixture {
  $script:fixtureNames = @()
  $script:fixtureContainers = @{}
  $members = @{}
  foreach ($service in @('kong', 'auth', 'rest', 'db')) {
    $name = "supabase_${service}_$project"
    $id = "id-$service"
    $script:fixtureNames += $name
    $members[$id] = @{Name = $name}
    $ports = @{}
    if ($service -eq 'kong') { $ports['8000/tcp'] = @(@{HostIp='127.0.0.1'; HostPort='55421'}) }
    if ($service -eq 'db') { $ports['5432/tcp'] = @(@{HostIp='127.0.0.1'; HostPort='55422'}) }
    $envEntries = @()
    if ($service -eq 'auth') { $envEntries = @('GOTRUE_DB_DATABASE_URL=postgres://user:dummy@db:5432/postgres') }
    if ($service -eq 'rest') { $envEntries = @('PGRST_DB_URI=postgres://user:dummy@db:5432/postgres') }
    $mounts = @()
    if ($service -eq 'db') { $mounts = @(@{Destination='/var/lib/postgresql/data'; Type='volume'; Name="data_$project"}) }
    $script:fixtureContainers[$name] = @{
      Name="/$name"; Id=$id; State=@{Running=$true}; Config=@{Env=$envEntries}; Mounts=$mounts
      NetworkSettings=@{Networks=@{$networkName=@{NetworkID='network-id'; Aliases=@($service)}}; Ports=$ports}
    }
  }
  $script:fixtureNetwork = @{Name=$networkName; Id='network-id'; Containers=$members}
  $script:fixtureVolume = @{Name="data_$project"; Driver='local'}
  $script:fixtureVolumeUsers = @("supabase_db_$project")
  $script:calls = @()
  $script:dockerFail = $false
}

function docker {
  $script:calls += ,@($args)
  $global:LASTEXITCODE = 0
  if ($script:dockerFail) { $global:LASTEXITCODE = 1; return }
  $command = $args -join '|'
  if ($command -eq 'context|inspect') {
    return ConvertTo-Json -InputObject @(@{Endpoints=@{docker=@{Host='npipe:////./pipe/docker_engine'}}}) -Depth 20 -Compress
  }
  if ($command -eq 'ps|-a|--format|{{.Names}}') { return $script:fixtureNames }
  if ($args.Count -eq 2 -and $args[0] -eq 'inspect' -and $script:fixtureContainers.ContainsKey($args[1])) {
    return ConvertTo-Json -InputObject @($script:fixtureContainers[$args[1]]) -Depth 20 -Compress
  }
  if ($command -eq "network|inspect|$networkName") { return ConvertTo-Json -InputObject @($script:fixtureNetwork) -Depth 20 -Compress }
  if ($command -eq "volume|inspect|data_$project") { return ConvertTo-Json -InputObject @($script:fixtureVolume) -Depth 20 -Compress }
  if ($command -eq "ps|-a|--filter|volume=data_$project|--format|{{.Names}}") { return $script:fixtureVolumeUsers }
  throw "Unexpected mock Docker arguments: $command"
}

function Assert-Result([string] $Case, [string] $Expected, [string] $ConfigPath = $config) {
  $message = ''
  try { Invoke-IsolatedVerification -Project $project -ConfigPath $ConfigPath }
  catch { $message = $_.Exception.Message }
  if (-not $message.Contains($Expected)) { throw "FAIL: $Case; expected '$Expected', got '$message'." }
  Write-Host "PASS: $Case"
}

$oldHost = $env:DOCKER_HOST
$oldContext = $env:DOCKER_CONTEXT
try {
  $env:DOCKER_HOST = $null
  $env:DOCKER_CONTEXT = $null
  Reset-Fixture
  Assert-Result 'valid mock remains INCOMPLETE' 'Verification INCOMPLETE'
  foreach ($expected in @('context|inspect', "network|inspect|$networkName", "volume|inspect|data_$project", "inspect|supabase_kong_$project", "inspect|supabase_db_$project")) {
    if (@($script:calls | Where-Object { ($_ -join '|') -eq $expected }).Count -ne 1) { throw "FAIL: Docker argument array: $expected" }
  }
  Write-Host 'PASS: full Docker argument arrays reach mock'

  Reset-Fixture; $script:fixtureNames += "supabase_storage_$project"
  Assert-Result 'unreviewed project service' 'Unexpected test project service'
  Reset-Fixture; $script:fixtureNetwork.Containers['foreign-id'] = @{Name='foreign'}
  Assert-Result 'foreign network member' 'foreign container'
  Reset-Fixture; $script:fixtureContainers["supabase_auth_$project"].NetworkSettings.Networks['foreign-network'] = @{NetworkID='foreign'}
  Assert-Result 'foreign network attachment' 'unexpected network attachments'
  Reset-Fixture; $script:fixtureContainers["supabase_kong_$project"].NetworkSettings.Ports['8000/tcp'][0].HostIp = '0.0.0.0'
  Assert-Result 'non-loopback binding' 'outside the reviewed loopback'
  Reset-Fixture; $script:fixtureContainers["supabase_db_$project"].NetworkSettings.Ports['5432/tcp'] += @{HostIp='::1'; HostPort='55422'}
  Assert-Result 'unreviewed IPv6 binding' 'outside the reviewed loopback'
  Reset-Fixture; $script:fixtureContainers["supabase_auth_$project"].NetworkSettings.Ports['9999/tcp'] = @(@{HostIp='127.0.0.1'; HostPort='55423'})
  Assert-Result 'unreviewed published port' 'unexpected port mapping'
  Reset-Fixture; $script:fixtureContainers["supabase_db_$project"].NetworkSettings.Ports['5432/tcp'] = @()
  Assert-Result 'missing database binding' 'binding is missing or ambiguous'
  Reset-Fixture; $script:fixtureContainers["supabase_db_$project"].Mounts[0].Name = 'foreign-volume'
  Assert-Result 'foreign database mount' 'not uniquely attributable'
  Reset-Fixture; $script:fixtureVolumeUsers += 'foreign-container'
  Assert-Result 'foreign volume user' 'volume is shared'
  Reset-Fixture; $script:fixtureVolume.Name = 'foreign-volume'
  Assert-Result 'foreign volume identity' 'volume identity is ambiguous'
  Reset-Fixture; $script:fixtureContainers["supabase_rest_$project"].Config.Env = @('PGRST_DB_URI=postgres://user:dummy@foreign:5432/postgres')
  Assert-Result 'foreign database target' 'not configured for the expected test database'
  Reset-Fixture; $script:dockerFail = $true
  Assert-Result 'Docker inspection failure' 'Read-only Docker inspection failed'
  Reset-Fixture
  Assert-Result 'unreviewed configuration' 'differs from the reviewed fingerprint' $file
  Write-Host 'Offline verifier mock tests PASS; no Docker command was invoked.'
} finally {
  $env:DOCKER_HOST = $oldHost
  $env:DOCKER_CONTEXT = $oldContext
}
