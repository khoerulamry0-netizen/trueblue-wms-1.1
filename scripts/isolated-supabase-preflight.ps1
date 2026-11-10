$ErrorActionPreference = 'Stop'
$project = 'trueblue-http-isolated-test'
$ports = @(55420, 55421, 55422, 55423, 55424, 55425, 55426, 55427, 55428, 55429, 55430, 3300)
$workdir = Join-Path $PSScriptRoot 'isolated-supabase'
$config = Join-Path $workdir 'supabase\config.toml'
$expectedConfigHash = '5E5D62265182276EE739BAC0A7C5E12D29EF478153D57A075C8A26E15CC6F992'

foreach ($path in @($PSScriptRoot, $workdir, (Join-Path $workdir 'supabase'), $config)) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Test workdir contains a redirected path; refusing inspection.'
  }
}
if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $expectedConfigHash) {
  throw 'Test configuration differs from the reviewed fingerprint; inspect changes before proceeding.'
}
foreach ($path in @((Join-Path $workdir 'supabase\migrations'), (Join-Path $workdir 'supabase\seed.sql'), (Join-Path $workdir 'supabase\.temp'))) {
  if (Test-Path -LiteralPath $path) {
    throw 'Test workdir contains migrations, seed, or linked project metadata; inspect manually.'
  }
}

if ($env:DOCKER_HOST -or $env:DOCKER_CONTEXT) {
  throw 'Unset DOCKER_HOST and DOCKER_CONTEXT before inspecting the local Docker context.'
}
foreach ($name in @('NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
  if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
    throw "Unset $name before the isolated test."
  }
}

function Read-Docker([string[]] $Arguments) {
  $result = & docker @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Read-only Docker inspection failed: $($Arguments[0]); output withheld." }
  return $result
}

$contexts = @(Read-Docker -Arguments @('context','inspect') | ConvertFrom-Json)
if ($contexts.Count -ne 1 -or $contexts[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
  throw 'Docker must use a local Windows named-pipe context.'
}
$null = Read-Docker -Arguments @('info','--format','{{.ServerVersion}}')

foreach ($kind in @('container', 'network', 'volume')) {
  if ($kind -eq 'container') { $names = @(Read-Docker -Arguments @('ps','-a','--format','{{.Names}}')) }
  elseif ($kind -eq 'network') { $names = @(Read-Docker -Arguments @('network','ls','--format','{{.Name}}')) }
  else { $names = @(Read-Docker -Arguments @('volume','ls','--format','{{.Name}}')) }
  if (@($names | Where-Object { $_ -like "*$project*" }).Count -gt 0) {
    throw "A $kind with the proposed test project name already exists. Inspect it manually; no resources were changed."
  }
}

foreach ($port in $ports) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
  $listener.ExclusiveAddressUse = $true
  try { $listener.Start() }
  catch { throw "TCP port $port is unavailable. No resources were changed." }
  finally { $listener.Stop() }
}
Write-Host 'Read-only preflight passed at this instant. No Docker resources, SQL, HTTP requests, or services were created.'
Write-Host 'This is not authorization to start a stack; recheck ports and isolation immediately before any future setup.'
