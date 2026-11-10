$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'isolated-supabase-start.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Startup script failed to parse.' }
$functions = @('Assert-LocalCliExists', 'Assert-CliVersion', 'Assert-AllowedEnvironment', 'Invoke-RequiredPreflight')
foreach ($name in $functions) {
  $found = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true))
  if ($found.Count -ne 1) { throw "Expected one function: $name" }
  . ([scriptblock]::Create($found[0].Extent.Text))
}

function Assert-Rejected([scriptblock] $Action, [string] $Case) {
  $rejected = $false
  try { & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw "FAIL: $Case was accepted." }
  Write-Host "PASS: $Case"
}

$missing = Join-Path $PSScriptRoot 'missing-test-cli\supabase.cmd'
Assert-Rejected { Assert-LocalCliExists $missing } 'missing CLI'
Assert-Rejected { Assert-CliVersion @('3.0.1') 0 } 'wrong CLI version'
Assert-Rejected { Assert-CliVersion @('3.0.0') 1 } 'failed CLI version command'
Assert-CliVersion @('3.0.0') 0

Assert-Rejected { Invoke-RequiredPreflight { $global:LASTEXITCODE = 1 } 'unused' } 'preflight nonzero exit'
Assert-Rejected { Invoke-RequiredPreflight { throw 'synthetic failure' } 'unused' } 'preflight exception'
Assert-Rejected { Invoke-RequiredPreflight { } 'unused' } 'preflight missing exit code'
Invoke-RequiredPreflight { $global:LASTEXITCODE = 0 } 'unused'

foreach ($name in @('SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'PGHOST', 'DATABASE_URL', 'DOCKER_CONTEXT')) {
  $entry = [pscustomobject]@{Name = $name; Value = 'synthetic'}
  Assert-Rejected { Assert-AllowedEnvironment @($entry) } "forbidden environment $name"
}
Assert-AllowedEnvironment @([pscustomobject]@{Name='PATH'; Value='synthetic'})
Write-Host 'Offline startup guard tests PASS; no Docker or Supabase command was invoked.'
