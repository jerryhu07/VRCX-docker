$ErrorActionPreference = 'Stop'
$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'install.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('State-Path', 'Update-ClientFiles', 'Set-StartupWmiObject', 'Register-StartupTrigger', 'Register-UserTask', 'Start-UserTask')) {
    $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('vrcx-install-test-' + [Guid]::NewGuid().ToString('N'))
try {
    foreach ($exe in @($false, $true)) {
        foreach ($config in @($false, $true)) {
            foreach ($reset in @($false, $true)) {
                $dir = Join-Path $root "$exe-$config-$reset"
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $exeSource = Join-Path $dir 'new.exe'; $exeTarget = Join-Path $dir 'client.exe'
                $configSource = Join-Path $dir 'new.json'; $configTarget = Join-Path $dir 'config.json'
                $state = Join-Path $dir 'state.json'
                [IO.File]::WriteAllText($exeSource, 'new-exe'); [IO.File]::WriteAllText($exeTarget, 'old-exe')
                [IO.File]::WriteAllText($state, 'original-checkpoints')
                [IO.File]::WriteAllText($configSource, (@{ token='new-secret'; stateFile=$state } | ConvertTo-Json))
                [IO.File]::WriteAllText($configTarget, (@{ token='old-secret'; stateFile=$state } | ConvertTo-Json))
                Update-ClientFiles $exeSource $exeTarget $configSource $configTarget $state $exe $config $reset
                $expectedExe = if ($exe) { 'new-exe' } else { 'old-exe' }
                $expectedToken = if ($config) { 'new-secret' } else { 'old-secret' }
                if ((Get-Content -LiteralPath $exeTarget -Raw) -ne $expectedExe) { throw 'Exe choice was not respected' }
                if ((Get-Content -LiteralPath $configTarget -Raw | ConvertFrom-Json).token -ne $expectedToken) { throw 'Config choice was not respected' }
                if ((Test-Path -LiteralPath $state) -eq $reset) { throw 'Checkpoint choice was not respected' }
                if ($exe -and (Get-Content -LiteralPath ($exeTarget + '.previous') -Raw) -ne 'old-exe') { throw 'Missing exe backup' }
                if ($config -and (Get-Content -LiteralPath ($configTarget + '.previous') -Raw | ConvertFrom-Json).token -ne 'old-secret') { throw 'Missing config backup' }
                if ($reset) {
                    $backups = @(Get-ChildItem -LiteralPath $dir -Filter 'state.json.before-reset-*')
                    if ($backups.Count -ne 1 -or (Get-Content -LiteralPath $backups[0].FullName -Raw) -ne 'original-checkpoints') { throw 'Missing checkpoint backup' }
                }
            }
        }
    }
    'PASS: all 8 independent exe/config/checkpoint combinations preserve the required files and backups.'
    $script:wmi = @{}
    $script:wmiCreates = 0; $script:wmiUpdates = 0
    function Get-WmiObject($Namespace, $Class, $ErrorAction) {
        if ($Namespace -ne 'root\subscription') { throw 'Unexpected namespace' }
        return @($script:wmi.Values | Where-Object { $_.Class -eq $Class })
    }
    function Set-WmiInstance($Namespace, $Class, $PutType, $Arguments, $InputObject) {
        if ($InputObject) {
            if ($Class -or $PutType -ne 'UpdateOnly') { throw 'Update must target an instance, not a class path' }
            $script:wmiUpdates++
            $InputObject.Data = $Arguments
            return $InputObject
        }
        if ($PutType -ne 'CreateOnly') { throw 'CreateOnlyFlagNotSpecifiedWithClassPath' }
        if ($Namespace -ne 'root\subscription') { throw 'Unexpected namespace' }
        $key = $Class + '.Name="' + $Arguments.Name + '"'
        $filter = ''; $consumer = ''
        if ($Class -eq '__FilterToConsumerBinding') {
            $filter = $Arguments.Filter.Path; $consumer = $Arguments.Consumer.Path
            $key = $Class + ':' + $filter + ':' + $consumer
        }
        if ($script:wmi.ContainsKey($key)) { throw 'WMI entry already exists' }
        $script:wmiCreates++
        $entry = [PSCustomObject]@{ Path=$key; Class=$Class; Name=$Arguments.Name; Filter=$filter; Consumer=$consumer; Data=$Arguments }
        $script:wmi[$key] = $entry
        return $entry
    }
    Register-StartupTrigger 'FirstTask' 'C:\Windows\System32\schtasks.exe'
    Register-StartupTrigger 'UpdatedTask' 'C:\Windows\System32\schtasks.exe'
    if ($script:wmi.Count -ne 3) { throw 'Repeated installation created duplicate WMI entries' }
    if ($script:wmi['CommandLineEventConsumer.Name="VRCXLogStreamerVRChatStartConsumer"'].Data.CommandLineTemplate -notlike '*UpdatedTask*') { throw 'Existing startup consumer was not updated' }
    if ($script:wmiCreates -ne 3 -or $script:wmiUpdates -ne 2) { throw 'Wrong create/update calls; existing binding must be reused' }
    'PASS: repeated startup registration updates the same three WMI instances without duplicates.'
    foreach ($key in @($script:wmi.Keys)) {
        if ($script:wmi[$key].Class -ne '__EventFilter') { $script:wmi.Remove($key) }
    }
    Register-StartupTrigger 'RepairedTask' 'C:\Windows\System32\schtasks.exe'
    if ($script:wmi.Count -ne 3 -or $script:wmiCreates -ne 5 -or $script:wmiUpdates -ne 3) { throw 'Partially installed subscription was not repaired' }
    'PASS: a pre-existing filter with missing consumer/binding is repaired using valid parameter sets.'
    $script:tasks = @{ SystemControl = [PSCustomObject]@{ Xml='<SystemTask />' } }
    $script:taskEvents = [Collections.Generic.List[string]]::new()
    $script:failValidation = $false; $script:failCreation = $false
    $folder = [PSCustomObject]@{}
    $folder | Add-Member ScriptMethod RegisterTaskDefinition {
        param($name, $task, $flags, $user, $password, $logon, $sddl)
        if ($flags -notin @(1, 2) -or $logon -ne 3 -or $null -ne $password) { throw 'Incorrect registration flags or credentials' }
        if ($task.Principal.UserId -ne $user -or $task.Principal.LogonType -ne 3 -or $task.Principal.RunLevel -ne 0) { throw 'Wrong task security context' }
        if ($task.Settings.ExecutionTimeLimit -ne 'PT0S' -or $task.Settings.MultipleInstances -ne 2 -or -not $task.Settings.AllowDemandStart) { throw 'Wrong on-demand task settings' }
        if ($flags -eq 1) {
            $script:taskEvents.Add('validate')
            if ($script:failValidation) { throw 'Definition rejected' }
            return
        }
        $script:taskEvents.Add('create')
        if ($script:failCreation) { throw 'Creation failed' }
        if ($script:tasks.ContainsKey($name)) { throw 'Creation must not update a stale task' }
        $task | Add-Member NoteProperty Xml '<Task />'
        $script:tasks[$name] = $task
        return [PSCustomObject]@{ Name = $name }
    }
    $folder | Add-Member ScriptMethod GetTask {
        param($name)
        if (-not $script:tasks.ContainsKey($name)) { throw [IO.FileNotFoundException]::new() }
        return $script:tasks[$name]
    }
    $folder | Add-Member ScriptMethod DeleteTask {
        param($name, $flags)
        if ($name -ne 'VRCXTest' -or $flags -ne 0) { throw 'Must not delete unrelated tasks' }
        $script:taskEvents.Add('delete')
        $script:tasks.Remove($name)
    }
    $folder | Add-Member ScriptMethod RegisterTask {
        param($name, $xml, $flags, $user, $password, $logon, $sddl)
        if ($flags -in @(1, 2)) {
            if ($xml -ne '<Task />') { throw 'Wrong serialized task XML' }
            return $this.RegisterTaskDefinition($name, $script:serializedTask, $flags, $user, $password, $logon, $sddl)
        }
        if ($flags -ne 6 -or $xml -ne '<Task />') { throw 'Wrong task restore parameters' }
        $script:taskEvents.Add('restore')
        $script:tasks[$name] = $script:taskBeforeFailure
    }
    $script:scheduler = [PSCustomObject]@{ Folder = $folder }
    $script:scheduler | Add-Member ScriptMethod Connect {}
    $script:scheduler | Add-Member ScriptMethod GetFolder { param($path) if ($path -ne '\') { throw 'Wrong task folder' }; return $this.Folder }
    $script:scheduler | Add-Member ScriptMethod NewTask {
        param($flags)
        $actions = [PSCustomObject]@{ Action = [PSCustomObject]@{ Path=''; Arguments=''; WorkingDirectory='' } }
        $actions | Add-Member ScriptMethod Create { param($type) if ($type -ne 0) { throw 'Wrong action type' }; return $this.Action }
        $definition = [PSCustomObject]@{
            RegistrationInfo = [PSCustomObject]@{ Description='' }
            Principal = [PSCustomObject]@{ UserId=''; LogonType=0; RunLevel=0 }
            Settings = [PSCustomObject]@{ Enabled=$false; AllowDemandStart=$false; DisallowStartIfOnBatteries=$true; StopIfGoingOnBatteries=$true; ExecutionTimeLimit=''; MultipleInstances=0 }
            Actions = $actions
        }
        $definition | Add-Member ScriptProperty XmlText {
            $script:taskEvents.Add('validate')
            if ($script:failValidation) { return '<broken' }
            $script:serializedTask = $this
            return '<Task />'
        }
        return $definition
    }
    function New-Object($ComObject) { if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM class' }; return $script:scheduler }
    $working = Join-Path $root 'task-working'
    New-Item -ItemType Directory -Path $working | Out-Null
    Register-UserTask 'VRCXTest' 'C:\client\old.exe' 'C:\client\config.json' $working 'S-1-5-21-1-2-3-1001' | Out-Null
    Register-UserTask 'VRCXTest' 'C:\new path\client.exe' 'C:\new path\config.json' $working 'S-1-5-21-1-2-3-1001' | Out-Null
    if ($script:tasks.Count -ne 2 -or $script:tasks['VRCXTest'].Actions.Action.Path -ne 'C:\new path\client.exe') { throw 'Task rebuild did not replace the action' }
    if ($script:tasks['VRCXTest'].Actions.Action.Arguments -ne '--config "C:\new path\config.json" --no-launch-vrchat') { throw 'Configuration path was not quoted correctly' }
    if (($script:taskEvents -join ',') -ne 'validate,create,validate,delete,create') { throw 'Task must be validated before deletion and recreated, not updated' }
    if ((Get-Content -LiteralPath (Join-Path $working 'startup-task.before-rebuild.xml') -Raw) -ne '<Task />') { throw 'Missing task XML backup' }
    $script:taskBeforeFailure = $script:tasks['VRCXTest']
    $script:failValidation = $true
    try { Register-UserTask 'VRCXTest' 'C:\fail.exe' 'C:\config.json' $working 'S-1-5-21-1-2-3-1001' | Out-Null; throw 'Validation should fail' } catch {
        if ($_.Exception.Message -eq 'Validation should fail') { throw }
    }
    if ($script:tasks['VRCXTest'] -ne $script:taskBeforeFailure) { throw 'Validation failure removed the existing task' }
    $script:failValidation = $false; $script:failCreation = $true
    try { Register-UserTask 'VRCXTest' 'C:\fail.exe' 'C:\config.json' $working 'S-1-5-21-1-2-3-1001' | Out-Null; throw 'Creation should fail' } catch {
        if ($_.Exception.Message -notlike '*Creation failed*') { throw }
    }
    if ($script:tasks['VRCXTest'] -ne $script:taskBeforeFailure -or -not $script:tasks.ContainsKey('SystemControl')) { throw 'Task restore failed or unrelated task was removed' }
    'PASS: task rebuild validates first, preserves an XML backup, restores on failure, and leaves system tasks untouched.'
    function Test-TaskLauncher {
        if ($args.Count -ne 3 -or $args[0] -ne '/Run' -or $args[1] -ne '/TN' -or $args[2] -ne 'VRCXTest') { throw 'Incorrect task launch arguments' }
        $global:LASTEXITCODE = 0
        'Task start requested'
    }
    Start-UserTask 'VRCXTest' 'Test-TaskLauncher'
    function Test-FailedTaskLauncher { $global:LASTEXITCODE = 1; 'Launch denied' }
    $failed = $false
    try { Start-UserTask 'VRCXTest' 'Test-FailedTaskLauncher' } catch { $failed = $_.Exception.Message -like '*exit code 1*Launch denied*' }
    if (-not $failed) { throw 'Task launch errors must be reported' }
    'PASS: immediate startup uses schtasks arguments, not COM Run(null), and checks the exit code.'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
