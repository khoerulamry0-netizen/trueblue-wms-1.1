[CmdletBinding()]
param(
  [ValidatePattern('^[0-9a-f]{32}$')]
  [string] $CleanupToken
)

$ErrorActionPreference = 'Stop'
$prefix = 'trueblue-loopback-smoke'
$label = 'com.trueblue.loopback-smoke'
$networkOption = 'com.docker.network.bridge.host_binding_ipv4'
$dataPath = '/var/lib/postgresql/data'

function Invoke-Docker([string[]] $Arguments) {
  $result = & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker command failed: $($Arguments[0]); resources, if any, were retained."
  }
  return $result
}

function Get-OneInspection([string[]] $Arguments) {
  $result = @(Invoke-Docker -Arguments $Arguments | ConvertFrom-Json)
  if ($result.Count -ne 1 -or -not $result[0].Id) {
    throw 'Resource inspection did not return one identifiable object.'
  }
  return $result[0]
}

if ($env:DOCKER_HOST -or $env:DOCKER_CONTEXT) {
  throw 'Unset DOCKER_HOST and DOCKER_CONTEXT before this smoke test.'
}
$context = @(Invoke-Docker -Arguments @('context', 'inspect') | ConvertFrom-Json)
if ($context.Count -ne 1 -or
    $context[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
  throw 'Docker context must use a local Windows named pipe.'
}

if ($CleanupToken) {
  $token = $CleanupToken
} else {
  $token = [guid]::NewGuid().ToString('N')
}
$networkName = "$prefix-net-$token"
$containerName = "$prefix-container-$token"

if ($CleanupToken) {
  $networks = @(Invoke-Docker -Arguments @('network', 'ls', '--format', '{{.Name}}'))
  $names = @(Invoke-Docker -Arguments @('ps', '-a', '--format', '{{.Names}}'))
  if (@($networks | Where-Object { $_ -eq $networkName }).Count -ne 1) {
    throw 'The exact smoke-test network was not found uniquely; no cleanup performed.'
  }
  $network = Get-OneInspection -Arguments @('network', 'inspect', $networkName)
  if ($network.Name -cne $networkName -or $network.Labels.$label -cne $token -or
      $network.Driver -ne 'bridge' -or $network.Scope -ne 'local' -or
      $network.Options.$networkOption -ne '127.0.0.1') {
    throw 'Network identity does not match the smoke test; no cleanup performed.'
  }
  $container = $null
  $matches = @($names | Where-Object { $_ -eq $containerName })
  if ($matches.Count -gt 1) { throw 'Container name is ambiguous; no cleanup performed.' }
  if ($matches.Count -eq 1) {
    $container = Get-OneInspection -Arguments @('inspect', $containerName)
    $attachments = @($container.NetworkSettings.Networks.PSObject.Properties)
    if ($container.Name -cne "/$containerName" -or $container.Config.Labels.$label -cne $token -or
        $attachments.Count -ne 1 -or $attachments[0].Name -cne $networkName -or
        $attachments[0].Value.NetworkID -ne $network.Id) {
      throw 'Container identity does not match the smoke test; no cleanup performed.'
    }
  }
  foreach ($member in @($network.Containers.PSObject.Properties)) {
    if ($null -eq $container -or $member.Name -cne $container.Id) {
      throw 'Network contains an unrelated container; no cleanup performed.'
    }
  }
  if ($null -ne $container) {
    $null = Invoke-Docker -Arguments @('rm', '--force', $container.Id)
  }
  $network = Get-OneInspection -Arguments @('network', 'inspect', $network.Id)
  if ($network.Name -cne $networkName -or $network.Labels.$label -cne $token -or
      @($network.Containers.PSObject.Properties).Count -ne 0) {
    throw 'Network identity or membership changed; network retained.'
  }
  $null = Invoke-Docker -Arguments @('network', 'rm', $network.Id)
  Write-Host 'Only the verified smoke-test container and network were removed.'
  return
}

$networks = @(Invoke-Docker -Arguments @('network', 'ls', '--format', '{{.Name}}'))
$names = @(Invoke-Docker -Arguments @('ps', '-a', '--format', '{{.Names}}'))
if ($networks -contains $networkName -or $names -contains $containerName) {
  throw 'Generated smoke-test resource name already exists; no resources were created.'
}
$image = Get-OneInspection -Arguments @('image', 'inspect', 'postgres:16')
foreach ($volume in @($image.Config.Volumes.PSObject.Properties)) {
  if ($volume.Name -cne $dataPath) {
    throw 'The local image declares an unexpected volume; no resources were created.'
  }
}

$port = 0
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $candidate = Get-Random -Minimum 49152 -Maximum 65536
  $v4 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $candidate)
  $v6 = $null
  $available = $false
  try {
    $v4.ExclusiveAddressUse = $true
    $v4.Start()
    if ([System.Net.Sockets.Socket]::OSSupportsIPv6) {
      $v6 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Any, $candidate)
      $v6.Server.DualMode = $false
      $v6.ExclusiveAddressUse = $true
      $v6.Start()
    }
    $available = $true
  } catch {
    $available = $false
  } finally {
    $v4.Stop()
    if ($null -ne $v6) { $v6.Stop() }
  }
  if ($available) { $port = $candidate; break }
}
if ($port -eq 0) { throw 'No available smoke-test port was found; no resources were created.' }

Write-Host "Smoke-test token: $token"
Write-Host "Network: $networkName; container: $containerName; candidate TCP port: $port"
Write-Host "Cleanup only after review: .\scripts\docker-loopback-smoke.ps1 -CleanupToken $token"
Write-Host 'The free-port check is time-limited; Docker may reject a concurrent port allocation.'

$networkId = @(Invoke-Docker -Arguments @('network', 'create', '--driver', 'bridge',
  '--label', "$label=$token", '--opt', "$networkOption=127.0.0.1", $networkName))
if ($networkId.Count -ne 1 -or -not $networkId[0]) { throw 'Network creation result is ambiguous; resources retained.' }
$network = Get-OneInspection -Arguments @('network', 'inspect', $networkId[0])
if ($network.Name -cne $networkName -or $network.Labels.$label -cne $token -or
    $network.Driver -ne 'bridge' -or $network.Scope -ne 'local' -or $network.EnableIPv6 -ne $false -or
    $network.Options.$networkOption -ne '127.0.0.1' -or @($network.Containers.PSObject.Properties).Count -ne 0) {
  throw 'Created network identity or options are unexpected; resources retained.'
}

$containerId = @(Invoke-Docker -Arguments @('run', '--detach', '--pull', 'never',
  '--name', $containerName, '--label', "$label=$token", '--network', $network.Id,
  '--publish', "${port}:12345/tcp", '--tmpfs', "${dataPath}:rw,noexec,nosuid",
  '--entrypoint', 'sleep', $image.Id, '600'))
if ($containerId.Count -ne 1 -or -not $containerId[0]) { throw 'Container creation result is ambiguous; resources retained.' }
$container = Get-OneInspection -Arguments @('inspect', $containerId[0])
$attachments = @($container.NetworkSettings.Networks.PSObject.Properties)
$unexpectedMounts = @($container.Mounts | Where-Object { $_.Type -ne 'tmpfs' -or $_.Destination -cne $dataPath })
if ($container.Name -cne "/$containerName" -or $container.Config.Labels.$label -cne $token -or
    $container.Image -ne $image.Id -or -not $container.State.Running -or
    $attachments.Count -ne 1 -or $attachments[0].Name -cne $networkName -or
    $attachments[0].Value.NetworkID -ne $network.Id -or $unexpectedMounts.Count -ne 0 -or
    -not $container.HostConfig.Tmpfs.$dataPath) {
  throw 'Created container identity, mounts, or network are unexpected; resources retained.'
}
$ports = @($container.NetworkSettings.Ports.PSObject.Properties | Where-Object { @($_.Value).Count -gt 0 -and $null -ne $_.Value })
$bindings = @($container.NetworkSettings.Ports.'12345/tcp')
if ($ports.Count -ne 1 -or $ports[0].Name -ne '12345/tcp' -or $bindings.Count -ne 1 -or
    $bindings[0].HostIp -cne '127.0.0.1' -or $bindings[0].HostPort -ne "$port") {
  Write-Host 'FAIL: inspect did not show exactly one 127.0.0.1 binding on the selected port.'
  foreach ($binding in $bindings) { Write-Host "Observed HostIp=$($binding.HostIp) HostPort=$($binding.HostPort)" }
  throw 'Loopback binding smoke test failed; resources retained.'
}
Write-Host "PASS: Docker inspect reports 127.0.0.1:$port for 12345/tcp on the test network."
Write-Host 'This proves only the observed smoke-test binding, not Supabase stack isolation.'
Write-Host 'Resources were retained. Run the printed cleanup command only after reviewing their identity.'
