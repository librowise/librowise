<#
.SYNOPSIS
    Librowise evaluation installer for Windows 10/11 (SQLite, no reverse proxy).

.DESCRIPTION
    Creates a Python virtual environment under %LOCALAPPDATA%\Librowise, installs Librowise,
    creates a SQLite instance with `librowise instance create --db sqlite --no-proxy`, starts it
    and opens the browser. For production use a Linux server (install/install.sh or the .deb).

    irm https://raw.githubusercontent.com/librowise/librowise/main/install/install.ps1 | iex

    With options, download first:
    irm https://raw.githubusercontent.com/librowise/librowise/main/install/install.ps1 -OutFile install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Instance demo -DemoData

.PARAMETER Instance
    Instance name (default: demo).
.PARAMETER Version
    Release tag to install (default: the pinned release below).
.PARAMETER Source
    Install from a local source checkout instead of a release.
.PARAMETER Port
    Web port (default: first free from 8100).
.PARAMETER Bind
    Address to listen on (default 127.0.0.1).
.PARAMETER DemoData
    Load the demo catalogue and accounts.
.PARAMETER NoStart
    Do not start the instance or open the browser.
.PARAMETER NoBrowser
    Start the instance but do not open the browser.
.PARAMETER Yes
    Do not ask questions (installs Python with winget if it is missing).
.PARAMETER InstallDir
    Installation directory (default: %LOCALAPPDATA%\Librowise).
.PARAMETER Uninstall
    Stop and remove the instances and the application. Data is kept unless -Purge is given.
.PARAMETER Purge
    With -Uninstall: delete all instance data and backups as well.
#>
[CmdletBinding()]
param(
    [string]$Instance = "demo",
    [string]$Version = "v1.1.0",
    [string]$Source = "",
    [int]$Port = 0,
    [string]$Bind = "127.0.0.1",
    [switch]$DemoData,
    [switch]$NoStart,
    [switch]$NoBrowser,
    [switch]$Yes,
    [string]$InstallDir = "",
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# Names that change with the project rename live here.
$PyModule = "librowise"     # Python package (python -m ...)
$DistName = "librowise"     # pip distribution
$RepoUrl = "https://github.com/librowise/librowise"

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "Librowise" }
$Venv = Join-Path $InstallDir "venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$Cli = Join-Path $Venv "Scripts\librowise.exe"
$Shim = Join-Path $InstallDir "librowise.cmd"
$env:LIBROWISE_HOME = $InstallDir   # instances live next to the application

function Write-Step([string]$Message) { Write-Host ""; Write-Host "==> $Message" -ForegroundColor Cyan }
# throw, not exit: `irm ... | iex` runs in the caller's session, which exit would close.
function Fail([string]$Message) { Write-Host ""; Write-Host "ERROR: $Message" -ForegroundColor Red; throw "Librowise installer: $Message" }

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    Write-Host ("  > " + $Exe + " " + ($Arguments -join " ")) -ForegroundColor DarkGray
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "command failed with exit code ${LASTEXITCODE}: $Exe $($Arguments -join ' ')" }
}

function Confirm-Action([string]$Question) {
    if ($Yes) { return $true }
    $answer = Read-Host "$Question [y/N]"
    return ($answer -match '^(y|yes)$')
}

function Get-PythonVersion([string]$Exe, [string[]]$Prefix) {
    try {
        $out = & $Exe @Prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -match '^\d+\.\d+$') { return [version]$out }
    } catch { }
    return $null
}

function Find-Python {
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in @("3.13", "3.12", "3.11")) { $candidates += , @("py", @("-$v")) }
    }
    foreach ($name in @("python", "python3")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -notlike "*WindowsApps*") { $candidates += , @($cmd.Source, @()) }
    }
    foreach ($c in $candidates) {
        $ver = Get-PythonVersion $c[0] $c[1]
        if ($ver -and $ver -ge [version]"3.11") { return @{ Exe = $c[0]; Prefix = $c[1]; Version = $ver } }
    }
    return $null
}

function Install-PythonWithWinget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "Python 3.11 or newer is required. Install it from https://www.python.org/downloads/ and re-run."
    }
    if (-not (Confirm-Action "Python 3.11+ was not found. Install Python 3.12 with winget now?")) {
        Fail "Python 3.11 or newer is required."
    }
    Invoke-Native "winget" @("install", "--id", "Python.Python.3.12", "--exact", "--source", "winget",
        "--scope", "user", "--accept-package-agreements", "--accept-source-agreements")
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
}

function Get-Instances {
    if (-not (Test-Path $Cli)) { return @() }
    try { $json = & $Cli instance list --json } catch { return @() }
    if ($LASTEXITCODE -ne 0 -or -not $json) { return @() }
    $data = ($json -join "`n") | ConvertFrom-Json
    return @($data.PSObject.Properties | ForEach-Object { $_.Name })
}

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
    Write-Step "Uninstalling Librowise from $InstallDir"
    foreach ($name in Get-Instances) {
        if ($Purge) {
            Invoke-Native $Cli @("instance", "remove", $name, "--purge-data", "--purge-backups", "--yes")
        } else {
            Invoke-Native $Cli @("instance", "remove", $name)
        }
    }
    if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv }
    if (Test-Path $Shim) { Remove-Item -Force $Shim }
    if ($Purge -and (Test-Path $InstallDir)) { Remove-Item -Recurse -Force $InstallDir }
    if ($Purge) {
        Write-Host "Librowise and all its data were removed."
    } else {
        Write-Host "Librowise was removed. Instance data and backups were kept in $InstallDir (use -Uninstall -Purge to delete them)."
    }
    return
}

# ------------------------------------------------------------------ install
$os = [Environment]::OSVersion.Version
if ($os.Major -lt 10) { Fail "Windows 10 or 11 is required." }
if ($Instance -notmatch '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' -or $Instance.Length -gt 30) {
    Fail "Invalid -Instance '$Instance': lowercase letters, digits and single hyphens."
}
if ($Source -and -not (Test-Path (Join-Path $Source "pyproject.toml"))) { Fail "-Source $Source is not a source checkout." }

Write-Step "Checking Python"
$python = Find-Python
if (-not $python) {
    Install-PythonWithWinget
    $python = Find-Python
    if (-not $python) { Fail "Python was installed but is not on PATH yet. Open a new PowerShell window and re-run." }
}
Write-Host "  Python $($python.Version) ($($python.Exe) $($python.Prefix -join ' '))"

Write-Step "Installing Librowise into $Venv"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (-not (Test-Path $VenvPython)) {
    Invoke-Native $python.Exe ($python.Prefix + @("-m", "venv", $Venv))
}
Invoke-Native $VenvPython @("-m", "pip", "install", "--quiet", "--upgrade", "--disable-pip-version-check", "pip")
if ($Source) {
    $spec = (Resolve-Path $Source).Path
} else {
    # A source archive needs no git on the machine.
    $spec = "$DistName @ $RepoUrl/archive/refs/tags/$Version.zip"
}
Invoke-Native $VenvPython @("-m", "pip", "install", "--upgrade", "--disable-pip-version-check", $spec)
Set-Content -Path $Shim -Encoding ASCII -Value @(
    "@echo off",
    "set LIBROWISE_HOME=$InstallDir",
    "`"$Cli`" %*"
)

Write-Step "Creating instance '$Instance'"
$createArgs = @("instance", "create", $Instance, "--db", "sqlite", "--no-proxy", "--bind", $Bind)
if ($Port -gt 0) { $createArgs += @("--port", "$Port") }
if ($DemoData) { $createArgs += "--demo-data" }
if ($NoStart) { $createArgs += "--no-start" }
Invoke-Native $Cli $createArgs

$url = ""
try { $info = & $Cli instance info $Instance --json } catch { $info = $null }
if ($LASTEXITCODE -eq 0 -and $info) { $url = (($info -join "`n") | ConvertFrom-Json).url }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Librowise is installed (evaluation mode: SQLite, this computer only)."
Write-Host "   Catalogue:  $url"
Write-Host "   Command:    $Shim instance --help"
Write-Host "   Start/stop: $Shim instance start $Instance   /   ... instance stop $Instance"
Write-Host "   Uninstall:  powershell -File install.ps1 -Uninstall"
Write-Host "============================================================" -ForegroundColor Green
if ($url -and -not $NoStart -and -not $NoBrowser) { Start-Process $url }
