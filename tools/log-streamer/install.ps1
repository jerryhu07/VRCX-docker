param(
    [string]$InstallDir = "$env:LOCALAPPDATA\VRCX-LogStreamer",
    [string]$ConfigSource = '',
    [string]$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    [string]$PreviousStateFile = '',
    [switch]$ReplaceExe,
    [switch]$ReplaceConfig,
    [switch]$ResetState,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
function Show-Message($Text, $Icon = 'Information') {
    [System.Windows.Forms.MessageBox]::Show($Text, 'VRCX Log Streamer', 'OK', $Icon) | Out-Null
}
function Ask($Text) {
    $answer = [System.Windows.Forms.MessageBox]::Show($Text, 'VRCX Log Streamer', 'YesNo', 'Question', 'Button2')
    return $answer -eq 'Yes'
}
function State-Path($Config, $ConfigPath) {
    if ($Config.stateFile) {
        return [Environment]::ExpandEnvironmentVariables(([string]$Config.stateFile).Replace('%CONFIG_DIR%', (Split-Path -Parent $ConfigPath)))
    }
    return Join-Path "$env:APPDATA\VRCX-LogStreamer" ($Config.machineId + '.json')
}
function Update-ClientFiles($ExeSource, $ExeTarget, $ConfigSource, $ConfigTarget, $PreviousStateFile, [bool]$ReplaceExe, [bool]$ReplaceConfig, [bool]$ResetState) {
    if ($ReplaceExe) {
        if (Test-Path -LiteralPath $ExeTarget) { Copy-Item -LiteralPath $ExeTarget -Destination ($ExeTarget + '.previous') -Force }
        Copy-Item -LiteralPath $ExeSource -Destination $ExeTarget -Force
    }
    if ($ReplaceConfig) {
        if (Test-Path -LiteralPath $ConfigTarget) { Copy-Item -LiteralPath $ConfigTarget -Destination ($ConfigTarget + '.previous') -Force }
        Copy-Item -LiteralPath $ConfigSource -Destination $ConfigTarget -Force
    }
    if ($ResetState) {
        $config = Get-Content -LiteralPath $ConfigTarget -Raw | ConvertFrom-Json
        $stateFiles = @($PreviousStateFile, (State-Path $config $ConfigTarget)) | Where-Object { $_ } | Select-Object -Unique
        foreach ($file in $stateFiles) {
            if (Test-Path -LiteralPath $file -PathType Leaf) { Move-Item -LiteralPath $file -Destination ($file + '.before-reset-' + [Guid]::NewGuid().ToString('N')) }
        }
    }
}
function Set-StartupWmiObject($Class, $Arguments) {
    $instances = @(Get-WmiObject -Namespace root\subscription -Class $Class -ErrorAction Stop)
    if ($Class -eq '__FilterToConsumerBinding') {
        $existing = $instances | Where-Object {
            [string]$_.Filter -like '*__EventFilter.Name="VRCXLogStreamerVRChatStartFilter"' -and
            [string]$_.Consumer -like '*CommandLineEventConsumer.Name="VRCXLogStreamerVRChatStartConsumer"'
        } | Select-Object -First 1
        if ($existing) { return $existing }
    } else {
        $existing = $instances | Where-Object { $_.Name -eq $Arguments.Name } | Select-Object -First 1
        if ($existing) { return Set-WmiInstance -InputObject $existing -Arguments $Arguments -PutType UpdateOnly }
    }
    # A class path only supports CreateOnly; updates must target an existing instance.
    return Set-WmiInstance -Namespace root\subscription -Class $Class -PutType CreateOnly -Arguments $Arguments
}
function Register-StartupTrigger($TaskName, $LauncherExe) {
    $filter = Set-StartupWmiObject '__EventFilter' @{
        Name = 'VRCXLogStreamerVRChatStartFilter'; EventNamespace = 'root\cimv2'; QueryLanguage = 'WQL'
        Query = "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'VRChat.exe'"
    }
    $consumer = Set-StartupWmiObject 'CommandLineEventConsumer' @{
        Name = 'VRCXLogStreamerVRChatStartConsumer'
        ExecutablePath = $LauncherExe
        CommandLineTemplate = '"' + $LauncherExe + '" /Run /TN "' + $TaskName + '"'
        RunInteractively = $false
    }
    Set-StartupWmiObject '__FilterToConsumerBinding' @{ Filter = $filter; Consumer = $consumer } | Out-Null
}
function Register-UserTask($TaskName, $ExePath, $ConfigPath, $WorkingDirectory, $UserSid) {
    if ($UserSid -notmatch '^S-1-\d+(?:-\d+)+$') { throw "Invalid initiating user SID: $UserSid" }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.NewTask(0)
    $task.RegistrationInfo.Description = 'VRCX log streamer, started on demand when VRChat starts.'
    $task.Principal.UserId = $UserSid
    $task.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
    $task.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA
    $task.Settings.Enabled = $true
    $task.Settings.AllowDemandStart = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries = $false
    $task.Settings.ExecutionTimeLimit = 'PT0S'
    $task.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
    $action = $task.Actions.Create(0)
    $action.Path = $ExePath
    $action.Arguments = '--config "' + $ConfigPath + '" --no-launch-vrchat'
    $action.WorkingDirectory = $WorkingDirectory
    $folder = $scheduler.GetFolder('\')
    $taskXml = $task.XmlText
    # Validate before touching the installed task; updating it can retain broken runtime state.
    [xml]$validatedXml = $taskXml
    if ($validatedXml.DocumentElement.LocalName -ne 'Task') { throw 'Invalid task XML.' }
    $existing = $null
    try { $existing = $folder.GetTask($TaskName) } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if ($cause.HResult -notin @(-2147024894, -2147024893)) { throw }
    }
    $previousXml = $null
    if ($existing) {
        $previousXml = $existing.Xml
        [IO.File]::WriteAllText((Join-Path $WorkingDirectory 'startup-task.before-rebuild.xml'), $previousXml, [Text.Encoding]::Unicode)
        $folder.DeleteTask($TaskName, 0)
    }
    try {
        return $folder.RegisterTask($TaskName, $taskXml, 2, $UserSid, $null, 3, $null)
    } catch {
        $registrationError = $_
        if ($previousXml) {
            try { $folder.RegisterTask($TaskName, $previousXml, 6, $null, $null, 3, $null) | Out-Null }
            catch { throw "New task registration failed: $($registrationError.Exception.Message). Previous task restore also failed: $($_.Exception.Message). XML backup is in the installation directory." }
        }
        throw $registrationError
    }
}
function Start-UserTask($TaskName, $LauncherExe) {
    $output = & $LauncherExe /Run /TN $TaskName 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Task launch failed (exit code $LASTEXITCODE): $output" }
}

try {
    $installationRegistered = $false
    $step = 'locate installation and configuration'
    $sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $exeSource = Join-Path $sourceDir 'vrcx-log-streamer-win-x64.exe'
    $exeTarget = Join-Path $InstallDir 'vrcx-log-streamer-win-x64.exe'
    $configTarget = Join-Path $InstallDir 'vrcx-log-streamer.config.json'
    if (-not (Test-Path -LiteralPath $exeSource -PathType Leaf)) { throw "Client executable is missing: $exeSource" }
    if (-not $Elevated) {
        $text = "Install VRCX Log Streamer to:`n$InstallDir`n`nIt will start when VRChat starts, and exit after VRChat closes. Windows will ask for administrator approval to register the startup trigger."
        if ([System.Windows.Forms.MessageBox]::Show($text, 'VRCX Log Streamer', 'YesNo', 'Question') -ne 'Yes') { exit 0 }
        $ReplaceExe = -not (Test-Path -LiteralPath $exeTarget)
        if (-not $ReplaceExe) { $ReplaceExe = Ask "Replace the existing executable?`n`nYes: install the new version and back up the old exe.`nNo: keep the existing exe." }
        $ReplaceConfig = -not (Test-Path -LiteralPath $configTarget)
        $oldConfig = $null
        if (-not $ReplaceConfig) {
            $oldConfig = Get-Content -LiteralPath $configTarget -Raw | ConvertFrom-Json
            $PreviousStateFile = State-Path $oldConfig $configTarget
            $ReplaceConfig = Ask "Replace the existing configuration?`n`nYes: import/download a new complete configuration, including its secret. The old config will be backed up.`nNo: keep the existing configuration unchanged."
        }
        $ResetState = Ask "Reset local log checkpoints?`n`nYes: archive the checkpoints. On next startup, Backfill re-reads eligible logs within historyMaxDays/historyMaxFiles; Skip does not upload old logs. Existing server records are deduplicated, not deleted.`nNo: continue from existing checkpoints (recommended)."
        if ($ReplaceConfig) {
            $step = 'prepare configuration'
            if ($ConfigSource -and (Test-Path -LiteralPath $ConfigSource -PathType Leaf)) {
                Copy-Item -LiteralPath $ConfigSource -Destination (Join-Path $sourceDir 'setup-config.json')
            } else {
                Add-Type -AssemblyName Microsoft.VisualBasic
                $server = [Microsoft.VisualBasic.Interaction]::InputBox('Enter your VRCX backend URL (the same address used in your browser):', 'VRCX backend', [string]$oldConfig.server)
                if (-not $server) { exit 0 }
                $uri = [Uri]$server
                if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'Enter a valid http:// or https:// backend URL without credentials or query parameters.' }
                $response = Invoke-WebRequest -UseBasicParsing -Uri ($server.TrimEnd('/') + '/headless/log-stream/config') -TimeoutSec 30
                [IO.File]::WriteAllText((Join-Path $sourceDir 'setup-config.json'), $response.Content, (New-Object Text.UTF8Encoding($false)))
            }
            $config = Get-Content -LiteralPath (Join-Path $sourceDir 'setup-config.json') -Raw | ConvertFrom-Json
            if (-not $config.server -or -not $config.token) { throw 'The downloaded configuration is incomplete. Log into the backend first.' }
            $config.launchVrchat = $false
            $statePath = Join-Path $InstallDir 'streamer-state.json'
            if ($PreviousStateFile) { $statePath = $PreviousStateFile }
            if ($config.stateFile -and $config.stateFile -ne '%CONFIG_DIR%\streamer-state.json') {
                $statePath = State-Path $config $configTarget
            }
            $config | Add-Member -NotePropertyName stateFile -NotePropertyValue $statePath -Force
            [IO.File]::WriteAllText((Join-Path $sourceDir 'setup-config.json'), ($config | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        }
        # Preserve the initiating user's path and SID even if UAC uses another administrator account.
        foreach ($value in @($InstallDir, $UserSid, $MyInvocation.MyCommand.Path, $PreviousStateFile)) {
            if ($value.Contains('"')) { throw 'Unsupported quote in installation path.' }
        }
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '" -Elevated -InstallDir "' + $InstallDir + '" -UserSid "' + $UserSid + '"'
        if ($ReplaceExe) { $arguments += ' -ReplaceExe' }
        if ($ReplaceConfig) { $arguments += ' -ReplaceConfig' }
        if ($ResetState) { $arguments += ' -ResetState' }
        if ($PreviousStateFile) { $arguments += ' -PreviousStateFile "' + $PreviousStateFile + '"' }
        $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -Wait -PassThru
        exit $process.ExitCode
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator approval is required to register the VRChat startup trigger.' }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $step = 'validate installation files before replacement'
    if ($ReplaceConfig -and -not (Test-Path -LiteralPath (Join-Path $sourceDir 'setup-config.json') -PathType Leaf)) { throw "Prepared configuration is missing: $sourceDir\setup-config.json" }
    if (-not $ReplaceConfig -and -not (Test-Path -LiteralPath $configTarget -PathType Leaf)) { throw "Existing configuration is missing: $configTarget" }
    $step = 'stop existing client'
    # Stop only this installation; never terminate VRChat or other streamer installations.
    Get-CimInstance Win32_Process -Filter "Name='vrcx-log-streamer-win-x64.exe'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exeTarget } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Wait-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    $step = 'update selected client files and checkpoints'
    Update-ClientFiles $exeSource $exeTarget (Join-Path $sourceDir 'setup-config.json') $configTarget $PreviousStateFile $ReplaceExe $ReplaceConfig $ResetState

    $taskName = 'VRCXLogStreamerVRChatStartV2'
    $step = 'register user-level scheduled task'
    Register-UserTask $taskName $exeTarget $configTarget $InstallDir $UserSid | Out-Null

    $step = 'create or update WMI startup trigger'
    Register-StartupTrigger $taskName (Join-Path $env:SystemRoot 'System32\schtasks.exe')
    $installationRegistered = $true
    $step = 'start client for active VRChat process'
    if (Get-Process -Name VRChat -ErrorAction SilentlyContinue) { Start-UserTask $taskName (Join-Path $env:SystemRoot 'System32\schtasks.exe') }
    Show-Message "Installation complete.`n$InstallDir`n`nThe client starts automatically with VRChat. Exe/config/checkpoints were handled according to your separate choices."
} catch {
    $details = "Step: $step`nLine: $($_.InvocationInfo.ScriptLineNumber)`n$($_.Exception.Message)`nHRESULT: $($_.Exception.HResult)`nError ID: $($_.FullyQualifiedErrorId)`nUser SID: $UserSid`nInstall directory: $InstallDir`nConfig: $configTarget"
    if ($_.Exception.InnerException) { $details += "`nInner error: $($_.Exception.InnerException.Message)`nInner HRESULT: $($_.Exception.InnerException.HResult)" }
    $log = Join-Path $InstallDir 'installer-error.log'
    try { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null; [IO.File]::WriteAllText($log, $details, (New-Object Text.UTF8Encoding($false))) } catch {}
    if ($installationRegistered) {
        Show-Message ($details + "`n`nFiles and startup registration are installed, but the client could not start immediately. Restart VRChat to retry the registered trigger.`nDetails: $log") 'Warning'
    } else {
        Show-Message ($details + "`n`nInstallation did not finish. Replaced files/checkpoints have backups.`nDetails: $log") 'Error'
    }
    exit 1
}
