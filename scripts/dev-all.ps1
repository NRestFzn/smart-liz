param(
  [switch]$NoChroma,
  [switch]$NoTts,
  [switch]$NoBackend
)

$ErrorActionPreference = "Stop"

$BackendDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$ProjectDir = Resolve-Path (Join-Path $BackendDir "..")
$TtsDir = Join-Path $ProjectDir "TTS-Engine"
$ChromaDir = Join-Path $BackendDir "data\chroma"
$ChromaExe = Join-Path $BackendDir "chroma-env\Scripts\chroma.exe"
$ChromaSetupHint = "Run from backend: npm run setup:chroma"
$TtsPython = if ($env:TTS_PYTHON) { $env:TTS_PYTHON } else { "python" }
$script:Processes = @()
$script:Subscriptions = @()

function Join-CommandArgs {
  param([string[]]$Arguments)

  return ($Arguments | ForEach-Object {
    if ($_ -match '^[A-Za-z0-9_./:=\\-]+$') {
      $_
    } else {
      '"' + ($_ -replace '"', '\"') + '"'
    }
  }) -join " "
}

function Resolve-CommandPath {
  param(
    [string]$Preferred,
    [string]$Fallback
  )

  if ($Preferred -and (Test-Path $Preferred)) {
    return $Preferred
  }

  $command = Get-Command $Fallback -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw "Command not found: $Fallback"
}

function Test-CommandStarts {
  param(
    [string]$FileName,
    [string[]]$Arguments
  )

  try {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FileName
    $psi.Arguments = Join-CommandArgs $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()
    $exited = $process.WaitForExit(5000)
    if (-not $exited) {
      try { $process.Kill() } catch {}
      return $false
    }

    return $process.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Resolve-ChromaCommand {
  if ($env:CHROMA_CMD) {
    return $env:CHROMA_CMD
  }

  $pathCommand = Get-Command "chroma" -ErrorAction SilentlyContinue
  if ($pathCommand -and (Test-CommandStarts -FileName $pathCommand.Source -Arguments @("run", "--help"))) {
    return $pathCommand.Source
  }

  if ((Test-Path $ChromaExe) -and (Test-CommandStarts -FileName $ChromaExe -Arguments @("run", "--help"))) {
    return $ChromaExe
  }

  throw "Chroma CLI is not available or backend/chroma-env is broken. $ChromaSetupHint"
}

function Start-DevProcess {
  param(
    [string]$Name,
    [string]$FileName,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$Color = "Gray"
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FileName
  $psi.Arguments = Join-CommandArgs $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.Environment["PYTHONUNBUFFERED"] = "1"

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true

  [void]$process.Start()

  $messageData = @{ Name = $Name; Color = $Color }
  $script:Subscriptions += Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $messageData -Action {
    if ($EventArgs.Data) {
      Write-Host ("[{0}] {1}" -f $Event.MessageData.Name, $EventArgs.Data) -ForegroundColor $Event.MessageData.Color
    }
  }
  $script:Subscriptions += Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $messageData -Action {
    if ($EventArgs.Data) {
      Write-Host ("[{0}] {1}" -f $Event.MessageData.Name, $EventArgs.Data) -ForegroundColor $Event.MessageData.Color
    }
  }

  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  $script:Processes += @{ Name = $Name; Process = $process }
  Write-Host ("Started {0} (PID {1})" -f $Name, $process.Id) -ForegroundColor $Color
}

function Stop-DevProcesses {
  foreach ($entry in $script:Processes) {
    $process = $entry.Process
    if ($process -and -not $process.HasExited) {
      Write-Host ("Stopping {0}..." -f $entry.Name) -ForegroundColor DarkGray
      try {
        $process.Kill($true)
      } catch {
        try { $process.Kill() } catch {}
      }
    }
  }

  foreach ($subscription in $script:Subscriptions) {
    try {
      Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    } catch {}
  }
}

try {
  if (-not $NoChroma) {
    if (-not (Test-Path $ChromaDir)) {
      New-Item -ItemType Directory -Path $ChromaDir | Out-Null
    }

    $chromaCommand = Resolve-ChromaCommand
    Start-DevProcess `
      -Name "chroma" `
      -FileName $chromaCommand `
      -Arguments @("run", "--path", $ChromaDir, "--host", "127.0.0.1", "--port", "8001") `
      -WorkingDirectory $BackendDir `
      -Color "Cyan"
  }

  if (-not $NoTts) {
    if (-not (Test-Path $TtsDir)) {
      throw "TTS-Engine folder not found: $TtsDir"
    }

    Start-DevProcess `
      -Name "tts" `
      -FileName $TtsPython `
      -Arguments @("main.py") `
      -WorkingDirectory $TtsDir `
      -Color "Magenta"
  }

  if (-not $NoBackend) {
    $npmCommand = Resolve-CommandPath -Preferred "" -Fallback "npm.cmd"
    Start-DevProcess `
      -Name "backend" `
      -FileName $npmCommand `
      -Arguments @("run", "dev") `
      -WorkingDirectory $BackendDir `
      -Color "Green"
  }

  Write-Host ""
  Write-Host "dev:all is running. Press Ctrl+C to stop Chroma, TTS, and backend." -ForegroundColor Yellow

  while ($true) {
    foreach ($entry in $script:Processes) {
      $process = $entry.Process
      if ($process.HasExited) {
        throw ("{0} exited with code {1}" -f $entry.Name, $process.ExitCode)
      }
    }
    Start-Sleep -Milliseconds 500
  }
} finally {
  Stop-DevProcesses
}
