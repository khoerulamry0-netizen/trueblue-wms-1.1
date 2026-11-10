$ErrorActionPreference = 'Stop'
$project = 'trueblue-http-isolated-test'
$workdir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'isolated-supabase'))
$config = Join-Path $workdir 'supabase\config.toml'
$preflight = Join-Path $PSScriptRoot 'isolated-supabase-preflight.ps1'
$verify = Join-Path $PSScriptRoot 'isolated-supabase-verify.ps1'
$cliHome = Join-Path $workdir '.cli-home'
$cli = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\node_modules\.bin\supabase.cmd'))
$shell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { $shell = Join-Path $PSHOME 'pwsh.exe' }
if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { throw 'Cannot identify the PowerShell executable for preflight.' }

function Assert-LocalCliExists([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Project-local Supabase CLI is missing.' }
}
function Assert-CliVersion($Version, $ExitCode) {
  if ($ExitCode -ne 0 -or @($Version).Count -ne 1 -or ([string]@($Version)[0]).Trim() -cne '3.0.0') {
    throw 'Supabase CLI version must be exactly 3.0.0.'
  }
}
function Assert-AllowedEnvironment($Entries) {
  foreach ($entry in $Entries) {
    if ($entry.Name -match '^(SUPABASE|VITE_SUPABASE|PG|POSTGRES|DATABASE_URL|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)' -and $entry.Value) {
      throw "Remove environment variable $($entry.Name) from this PowerShell session before setup; value withheld."
    }
  }
}
function Invoke-RequiredPreflight($Shell, [string] $Path) {
  try {
    $global:LASTEXITCODE = $null
    & $Shell -NoProfile -NonInteractive -File $Path
    $code = $LASTEXITCODE
    if ($null -eq $code -or $code -ne 0) { throw 'Preflight exited unsuccessfully.' }
  } catch {
    throw 'Preflight failed; startup blocked.'
  }
}

throw 'Startup blocked: loopback-only publishing and CLI v3 custom network compatibility are not verified. Do not start the stack or apply WMS SQL.'

if ($workdir -eq [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))) {
  throw 'Unexpected isolated Supabase workdir.'
}
for ($ancestor = Get-Item -LiteralPath $workdir -Force; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
  if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Test workdir has a redirected ancestor; refusing startup.'
  }
}
foreach ($file in @($preflight, $verify, $config)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Required test script or configuration is missing.' }
}
$configText = Get-Content -LiteralPath $config -Raw
$projectMatches = [regex]::Matches($configText, '(?m)^\s*project_id\s*=\s*"([^"]+)"\s*$')
if ($projectMatches.Count -ne 1 -or $projectMatches[0].Groups[1].Value -cne $project) {
  throw 'Test project ID does not match the required isolated project.'
}
foreach ($section in @('db.migrations', 'db.seed')) {
  $pattern = '(?ms)^\[' + [regex]::Escape($section) + '\]\s*\r?\n\s*enabled\s*=\s*false\s*(?=\r?\n|\z)'
  if ([regex]::Matches($configText, $pattern).Count -ne 1) {
    throw "Automatic $section must be explicitly disabled."
  }
}
foreach ($path in @((Join-Path $workdir '.env'), (Join-Path $workdir 'supabase\.env'), $cliHome)) {
  if (Test-Path -LiteralPath $path) {
    throw 'Test workdir contains an environment file or prior CLI home; inspect it before proceeding.'
  }
}
Assert-AllowedEnvironment @(Get-ChildItem Env:)
Assert-LocalCliExists $cli

Invoke-RequiredPreflight $shell $preflight
$originalContext = @( & docker context inspect 2>$null | ConvertFrom-Json )
if ($LASTEXITCODE -ne 0 -or $originalContext.Count -ne 1) { throw 'Cannot identify original Docker context.' }
$originalEndpoint = $originalContext[0].Endpoints.docker.Host

$originalDockerConfig = Join-Path $env:USERPROFILE '.docker'
$keep = @{}
foreach ($name in @('PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'ProgramData')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($value) { $keep[$name] = $value }
}
Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
foreach ($name in $keep.Keys) { [Environment]::SetEnvironmentVariable($name, $keep[$name], 'Process') }
New-Item -ItemType Directory -Path $cliHome -ErrorAction Stop | Out-Null
$env:HOME = $cliHome
$env:USERPROFILE = $cliHome
$env:APPDATA = $cliHome
$env:LOCALAPPDATA = $cliHome
$env:DOCKER_CONFIG = $originalDockerConfig

$contextJson = & docker context inspect 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Docker context after environment isolation.' }
$contexts = @($contextJson | ConvertFrom-Json)
if ($contexts.Count -ne 1 -or $contexts[0].Endpoints.docker.Host -ne $originalEndpoint -or
    $contexts[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
  throw 'Docker context changed or is not a local Windows named pipe.'
}
$version = @(& $cli --version 2>$null)
Assert-CliVersion $version $LASTEXITCODE

# Preflight requires no DOCKER_CONFIG override; the isolated process uses the same
# original Docker configuration that was just checked above.
Remove-Item Env:\DOCKER_CONFIG
$contextJson = & docker context inspect 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Docker context for the final preflight.' }
$contexts = @($contextJson | ConvertFrom-Json)
if ($contexts.Count -ne 1 -or $contexts[0].Endpoints.docker.Host -ne $originalEndpoint) {
  throw 'Isolated CLI home selects a different Docker context; refusing startup.'
}
Invoke-RequiredPreflight $shell $preflight
$env:DOCKER_CONFIG = $originalDockerConfig
$contextJson = & docker context inspect 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Cannot recheck Docker context immediately before startup.' }
$contexts = @($contextJson | ConvertFrom-Json)
if ($contexts.Count -ne 1 -or $contexts[0].Endpoints.docker.Host -ne $originalEndpoint -or
    $contexts[0].Endpoints.docker.Host -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
  throw 'Docker context is not a local Windows named pipe.'
}

Write-Host "Starting only $project using its dedicated workdir. WMS migrations and seed are disabled."
Push-Location -LiteralPath $workdir
try {
  $output = @(& $cli start --workdir $workdir 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw 'Supabase startup failed; output withheld because it may contain credentials. No cleanup was attempted.'
  }
} finally {
  Pop-Location
  $output = $null
}

try {
  & $verify
} catch {
  Write-Host 'Post-start verification did not pass. Resources were retained; do not apply WMS SQL or create fixtures or accounts.'
  throw
}
throw 'Post-start verification unexpectedly completed without an explicit full isolation authorization. Stop for review.'
