#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$r = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$name = 'AnnotationCapture'
if ($r.name) {
    if ($r.name -notmatch '^AnnotationCapture-Test-[a-zA-Z0-9-]+$') { throw 'Invalid startup test namespace' }
    $name = $r.name
}
$exe = [IO.Path]::GetFullPath($r.executable)
$data = [IO.Path]::GetFullPath($r.dataRoot)
if (!(Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetFileName($exe) -ne 'AnnotationCapture.exe' -or $r.arguments -notlike '--background --userData * --archiveRoot *') { throw 'Invalid startup request' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "$name-Logon-$sid"
$legacyTaskName = "$name-Logon"
$marker = 'AnnotationCapture managed login startup v1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$folderApprovedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
if ($r.name) {
    $testRoot = 'HKCU:\Software\AnnotationCapture-Tests\' + $name
    $runKey = $testRoot + '\Run'
    $approvedKey = $testRoot + '\StartupApproved\Run'
    $folderApprovedKey = $testRoot + '\StartupApproved\StartupFolder'
}
$stateRoot = Join-Path $data 'Startup'
$statePath = Join-Path $stateRoot 'state.json'
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null
$saved = $null
if (Test-Path -LiteralPath $statePath) { try { $saved = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
$run = $null
$key = Get-Item -LiteralPath $runKey -ErrorAction SilentlyContinue
if ($key) { $run = $key.GetValue($name, $null) }
$approved = $null
$key = Get-Item -LiteralPath $approvedKey -ErrorAction SilentlyContinue
if ($key) { $approved = $key.GetValue($name, $null) }
$legacyEnabled = $true
if ($approved -and $approved.Length -ge 4 -and $approved[0] -in @(3,7)) { $legacyEnabled = $false }
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) ($name + '.lnk')
$ownedShortcut = $false
if (Test-Path -LiteralPath $shortcut) {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    $ownedShortcut = $link.TargetPath -eq $exe -and (!$link.Arguments -or $link.Arguments.Contains($data))
    if ($ownedShortcut -and !$run) {
        $folderApproval = Get-Item -LiteralPath $folderApprovedKey -ErrorAction SilentlyContinue
        if ($folderApproval) {
            $bytes = $folderApproval.GetValue(($name + '.lnk'), $null)
            if ($bytes -and $bytes[0] -in @(3,7)) { $legacyEnabled = $false }
        }
    }
}
$desired = if ($null -ne $r.enabled) { [bool]$r.enabled } elseif ($saved -and $null -ne $saved.enabled) { [bool]$saved.enabled } else { $legacyEnabled }
function Approved([bool]$enabled) {
    if (!(Test-Path -LiteralPath $approvedKey)) { New-Item -Path $approvedKey -Force | Out-Null }
    $bytes = New-Object byte[] 12
    $bytes[0] = if ($enabled) { 2 } else { 3 }
    New-ItemProperty -LiteralPath $approvedKey -Name $name -PropertyType Binary -Value $bytes -Force | Out-Null
}
function SaveState($state) {
    $json = $state | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText(($statePath + '.tmp'), $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath ($statePath + '.tmp') -Destination $statePath -Force
    [Console]::WriteLine($json)
}
function Owned($task) {
    if (!$task -or $task.Description -ne $marker) { return $false }
    $owner = $task.Principal.UserId
    if ($owner -ne $sid) {
        try { $owner = (New-Object Security.Principal.NTAccount($owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $false }
    }
    return $owner -eq $sid
}
$existing = $null
$legacyTask = $null
$verified = $false
$previousXml = $null
try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and !(Owned $existing)) { throw 'A different task occupies the managed startup name' }
    $legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
    if ($legacyTask) {
        $legacyOwner = $legacyTask.Principal.UserId
        if ($legacyOwner -ne $sid) {
            try { $legacyOwner = (New-Object Security.Principal.NTAccount($legacyOwner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $legacyOwner = '' }
        }
        if ($legacyOwner -ne $sid -or $legacyTask.Actions.Count -ne 1 -or $legacyTask.Actions.Execute -ne $exe -or $legacyTask.Actions.Arguments.IndexOf($data, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $legacyTask = $null }
    }
    if ($null -eq $r.enabled) {
        if ($existing) { $desired = [bool]$existing.Settings.Enabled }
        elseif ($legacyTask) { $desired = [bool]$legacyTask.Settings.Enabled }
        elseif ($saved -and $saved.method -eq 'task') { $desired = $false }
    }
    if ($existing) { $previousXml = Export-ScheduledTask -TaskName $taskName }
    $action = New-ScheduledTaskAction -Execute $exe -Argument $r.arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($exe))
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $trigger.Delay = 'PT10S'
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.Enabled = $desired
    $settings.IdleSettings.StopOnIdleEnd = $false
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $marker
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
    $check = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if (!(Owned $check) -or $check.Actions.Execute -ne $exe -or $check.Actions.Arguments -ne $r.arguments -or $check.Triggers.Delay -ne 'PT10S' -or [bool]$check.Settings.Enabled -ne $desired) { throw 'Scheduled startup readback failed' }
    $verified = $true
} catch {
    $failure = $_.Exception.Message
    if ($previousXml) {
        Register-ScheduledTask -TaskName $taskName -Xml $previousXml -Force | Out-Null
        throw $failure
    }
    if ($existing -or ($saved -and $saved.method -eq 'task')) { throw $failure }
    $partial = $null
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) { $partial = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    if ($partial -and (Owned $partial)) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    if (!(Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    New-ItemProperty -LiteralPath $runKey -Name $name -PropertyType String -Value ('"' + $exe + '" ' + $r.arguments) -Force | Out-Null
    Approved $desired
    SaveState @{ enabled = $desired; method = 'run'; message = ('Scheduled startup unavailable; using Windows startup: ' + $failure) }
    exit 0
}
if ($verified) {
    $warning = ''
    try {
        if ($run) { Approved $false }
        if ($legacyTask) { Disable-ScheduledTask -TaskName $legacyTaskName | Out-Null }
        if ($ownedShortcut) {
            $backup = Join-Path $stateRoot ('legacy-' + [guid]::NewGuid().ToString() + '.lnk')
            Move-Item -LiteralPath $shortcut -Destination $backup
        }
    } catch { $warning = $_.Exception.Message }
    SaveState @{ enabled = $desired; method = 'task'; taskName = $taskName; message = $warning }
}
