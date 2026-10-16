# SignBridge local setup (Windows).
# From the repo root:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Or double-click setup.cmd.

$ErrorActionPreference = "Stop"
# Native tools such as npm and py write warnings to stderr. Keep going
# unless the process exit code says the command failed.
$PSNativeCommandUseErrorActionPreference = $false
Set-Location -LiteralPath $PSScriptRoot

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Test-LocalPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $opened = $wait.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $opened) { return $false }
    $client.EndConnect($wait)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Invoke-Native {
  param(
    [scriptblock]$Command,
    [string]$FailureMessage
  )
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function Find-PythonExecutable {
  $launchers = @(
    @{ Exe = "py"; Args = @("-3.12") },
    @{ Exe = "py"; Args = @("-3.13") },
    @{ Exe = "py"; Args = @("-3.11") },
    @{ Exe = "py"; Args = @("-3.10") }
  )

  foreach ($launcher in $launchers) {
    if (-not (Get-Command $launcher.Exe -ErrorAction SilentlyContinue)) { continue }
    & $launcher.Exe @($launcher.Args) -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $path = & $launcher.Exe @($launcher.Args) -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $path) { return $path.Trim() }
    }
  }

  $named = @(
    "python3.12", "python3.13", "python3.11", "python3.10", "python"
  )
  foreach ($name in $named) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    & $cmd.Source -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)"
    if ($LASTEXITCODE -eq 0) { return $cmd.Source }
  }

  return $null
}

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int]((& node -v).TrimStart("v").Split(".")[0])
    if ($major -lt 18) {
      throw "Node.js $(& node -v) is installed. SignBridge needs Node.js 18 or newer: https://nodejs.org"
    }
    Write-Host "Node.js $(node -v) is already installed."
    return
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org and run this script again."
  }

  Write-Step "Installing Node.js LTS"
  & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was installed, but this terminal cannot see it yet. Close the terminal, open a new one, and run setup.ps1 again."
  }
  Write-Host "Node.js $(node -v) is ready."
}

function Ensure-Python {
  $python = Find-PythonExecutable
  if ($python) {
    $version = & $python -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"
    Write-Host "Python $version is already installed ($python)."
    return $python
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Python 3.10-3.13 was not found. TensorFlow has no Windows wheel for Python 3.14. Install Python 3.12 from https://www.python.org/downloads/ and run this script again."
  }

  Write-Step "Installing Python 3.12 (TensorFlow does not publish a Windows wheel for 3.14)"
  & winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  $python = Find-PythonExecutable
  if (-not $python) {
    throw "Python 3.12 was installed, but this terminal cannot see it yet. Close the terminal, open a new one, and run setup.ps1 again."
  }
  return $python
}

function New-JwtSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

Write-Host "SignBridge setup" -ForegroundColor Green
Write-Host "Repo: $PSScriptRoot"

Ensure-Node

Write-Step "Installing Node packages"
if (-not (Test-Path -LiteralPath "package-lock.json")) {
  throw "package-lock.json is missing. Clone the full repository and run this script from the repo root."
}
Invoke-Native { npm ci } "npm ci failed."

$python = Ensure-Python
$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (Test-Path -LiteralPath $venvPython) {
  & $venvPython -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)"
  if ($LASTEXITCODE -ne 0) {
    Write-Step "Replacing .venv because it was created with a Python version TensorFlow cannot use"
    Remove-Item -LiteralPath (Join-Path $PSScriptRoot ".venv") -Recurse -Force
  }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Step "Creating a Python virtual environment in .venv"
  Invoke-Native { & $python -m venv (Join-Path $PSScriptRoot ".venv") } "Could not create .venv."
}

Write-Step "Installing Python packages (TensorFlow is large; this can take several minutes)"
Invoke-Native { & $venvPython -m pip install --upgrade pip } "Could not upgrade pip."
Invoke-Native { & $venvPython -m pip install -r (Join-Path $PSScriptRoot "ml\requirements.txt") } "Could not install ml/requirements.txt."

$envExample = Join-Path $PSScriptRoot "server\.env.example"
$envFile = Join-Path $PSScriptRoot "server\.env"
if (-not (Test-Path -LiteralPath $envExample)) {
  throw "server/.env.example is missing."
}
if (Test-Path -LiteralPath $envFile) {
  Write-Host "server/.env already exists, so it was left unchanged."
} else {
  Write-Step "Creating server/.env"
  $contents = [System.IO.File]::ReadAllText($envExample)
  $contents = $contents.Replace(
    "JWT_SECRET=replace-with-a-long-random-string",
    ("JWT_SECRET=" + (New-JwtSecret))
  )
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($envFile, $contents, $utf8)
  Write-Host "Created server/.env with a new JWT_SECRET."
}

$model = Join-Path $PSScriptRoot "ml\models\signbridge_lstm.keras"
if (-not (Test-Path -LiteralPath $model) -or (Get-Item -LiteralPath $model).Length -lt 100000) {
  Write-Host "ml/models/signbridge_lstm.keras is missing or too small. Pull the latest repo before starting the model API." -ForegroundColor Yellow
} else {
  Write-Host "Sign model file is present."
}

Write-Step "Checking MongoDB"
if (Test-LocalPort 27017) {
  Write-Host "MongoDB is accepting connections on 127.0.0.1:27017."
} else {
  Write-Host "MongoDB is not running on 127.0.0.1:27017." -ForegroundColor Yellow
  Write-Host "The site still starts. Register and login need a database."
  Write-Host "Install and start MongoDB Community, then keep MONGODB_URI in server/.env:"
  Write-Host "  winget install --id MongoDB.Server -e --accept-package-agreements --accept-source-agreements"
  Write-Host "Or paste a MongoDB Atlas connection string into MONGODB_URI."
}

Write-Host ""
Write-Host "Setup finished." -ForegroundColor Green
Write-Host ""
Write-Host "Start the sign model in one terminal:"
Write-Host "  .\.venv\Scripts\python -m uvicorn ml.api:app --host 127.0.0.1 --port 9001"
Write-Host ""
Write-Host "Start the app in a second terminal:"
Write-Host "  node server/index.js"
Write-Host ""
Write-Host "Open http://localhost:3000"
Write-Host "Live hand tracking loads MediaPipe from the internet the first time you turn the camera on."
