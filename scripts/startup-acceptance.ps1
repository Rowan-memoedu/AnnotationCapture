#Requires -Version 7.0
param([string]$Evidence = 'D:\Artifacts\AnnotationCapture\release-0.8.3\acceptance\startup')
$ErrorActionPreference = 'Stop'
$root = Join-Path 'D:\Quarantine\AnnotationCapture' ('startup-' + [guid]::NewGuid().ToString())
$worker = Join-Path $PSScriptRoot '..\src\main\startup-worker.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$names = [Collections.Generic.List[string]]::new()
$checks = [Collections.Generic.List[string]]::new()
$folder = $null
$service = $null
New-Item -ItemType Directory -Path $root,$Evidence -Force | Out-Null
function Case([string]$label) {
    $name = 'AnnotationCapture-Test-' + [guid]::NewGuid().ToString()
    $names.Add($name)
    $data = Join-Path $root ($label + ' User''s 数据')
    $appRoot = Join-Path $root ($label + ' App 数学 & 练习')
    New-Item -ItemType Directory -Path $data,$appRoot -Force | Out-Null
    $exe = Join-Path $appRoot 'AnnotationCapture.exe'
    [IO.File]::WriteAllBytes($exe, [byte[]]@())
    return @{ name = $name; executable = $exe; dataRoot = $data; arguments = ('--background --userData "' + $data + '" --archiveRoot "' + $data + '\归档 & 公式"') }
}
function Apply($request) {
    $file = Join-Path $request.dataRoot 'request.json'
    $request | ConvertTo-Json | Set-Content -LiteralPath $file -Encoding utf8
    $output = & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -RequestPath $file
    if ($LASTEXITCODE -ne 0) { throw ('Worker failed: ' + ($output -join "`n")) }
    return ($output -join "`n") | ConvertFrom-Json
}
function Check([bool]$condition, [string]$label) {
    if (!$condition) { throw ('Failed: ' + $label) }
    $checks.Add($label)
    Write-Output ('PASS ' + $label)
}
try {
    $env:ANNOTATION_WORKER_PARSE = (Resolve-Path -LiteralPath $worker).Path
    $errors51 = & $powershell -NoProfile -Command '$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:ANNOTATION_WORKER_PARSE,[ref]$t,[ref]$e)|Out-Null;$e|ForEach-Object{$_.ToString()};if($e.Count){exit 1}'
    if ($LASTEXITCODE -ne 0) { throw ('PowerShell 5.1 parse: ' + ($errors51 -join "`n")) }
    $r = Case 'fresh'
    $state = Apply $r
    $taskName = $r.name + '-Logon-' + $sid
    $task = Get-ScheduledTask -TaskName $taskName
    Check ($state.method -eq 'task' -and $state.enabled) 'fresh-install-registers-current-user-task'
    Check ($task.Actions.Execute -eq $r.executable -and $task.Actions.Arguments -eq $r.arguments -and $task.Triggers.Delay -eq 'PT10S' -and $task.Principal.RunLevel -eq 'Limited') 'unicode-space-apostrophe-ampersand-paths-and-limited-rights'
    Check (!$task.Settings.DisallowStartIfOnBatteries -and !$task.Settings.StopIfGoingOnBatteries -and $task.Settings.ExecutionTimeLimit -eq 'PT0S') 'battery-and-unlimited-runtime'
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Check (!(Apply $r).enabled) 'preserves-task-manager-opt-out'
    $r.enabled = $true
    Check ((Apply $r).enabled) 'explicit-enable'
    $r.enabled = $false
    Check (!(Apply $r).enabled) 'explicit-disable'
    $r.Remove('enabled')
    Check (!(Apply $r).enabled) 'disabled-choice-survives-relaunch'
    $moved = Join-Path $root 'moved App & 数学\AnnotationCapture.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $moved) -Force | Out-Null
    [IO.File]::WriteAllBytes($moved, [byte[]]@())
    $r.executable = $moved
    $null = Apply $r
    Check ((Get-ScheduledTask -TaskName $taskName).Actions.Execute -eq $moved -and !(Get-ScheduledTask -TaskName $taskName).Settings.Enabled) 'relocation-repairs-path-without-enabling'
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Check (!(Apply $r).enabled) 'deleted-managed-task-is-not-silently-reenabled'

    foreach ($disabled in @($false,$true)) {
        $r = Case ('legacy-run-' + $disabled)
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        New-ItemProperty -LiteralPath $runKey -Name $r.name -Value ('"' + $r.executable + '" ' + $r.arguments) -PropertyType String -Force | Out-Null
        $approval = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
        $bytes = [byte[]]@(2,0,0,0,0,0,0,0,0,0,0,0)
        if ($disabled) { $bytes[0] = 3 }
        New-ItemProperty -LiteralPath $approval -Name $r.name -Value $bytes -PropertyType Binary -Force | Out-Null
        $state = Apply $r
        Check ($state.enabled -eq !$disabled -and (Get-ItemPropertyValue -LiteralPath $approval -Name $r.name)[0] -eq 3) ('legacy-run-migrated-preserving-choice-' + $disabled)
    }
    $r = Case 'legacy-shortcut'
    $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) ($r.name + '.lnk')
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    $link.TargetPath = $r.executable
    $link.Arguments = $r.arguments
    $link.Save()
    $approval = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
    New-ItemProperty -LiteralPath $approval -Name ($r.name + '.lnk') -Value ([byte[]]@(3,0,0,0,0,0,0,0,0,0,0,0)) -PropertyType Binary -Force | Out-Null
    $state = Apply $r
    Check (!$state.enabled -and !(Test-Path -LiteralPath $shortcut) -and @(Get-ChildItem -LiteralPath (Join-Path $r.dataRoot 'Startup') -Filter '*.lnk').Count -eq 1) 'disabled-shortcut-migration-is-recoverable'

    $r = Case 'legacy-task'
    $action = New-ScheduledTaskAction -Execute $r.executable -Argument $r.arguments
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName ($r.name + '-Logon') -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet) | Out-Null
    New-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $r.name -Value ('"' + $r.executable + '" ' + $r.arguments) -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name $r.name -Value ([byte[]]@(3,0,0,0,0,0,0,0,0,0,0,0)) -PropertyType Binary -Force | Out-Null
    $state = Apply $r
    Check ($state.enabled -and !(Get-ScheduledTask -TaskName ($r.name + '-Logon')).Settings.Enabled) 'adopts-owned-existing-repair-task'

    $r = Case 'registration-failure'
    $collision = $r.name + '-Logon-' + $sid
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder = $service.GetFolder('\').CreateFolder($collision)
    $state = Apply $r
    Check ($state.method -eq 'run' -and $state.enabled) 'registration-failure-falls-back-to-run'
    $r.enabled = $false
    Check (!(Apply $r).enabled) 'fallback-respects-explicit-disable'
    $report = @{ passed = $true; checks = @($checks); actualWindowsSignIn = $false; fixtureRoot = $root; namespaces = @($names) }
} finally {
    foreach ($name in $names) {
        foreach ($taskName in @(($name + '-Logon-' + $sid),($name + '-Logon'))) {
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($task -and $taskName.StartsWith('AnnotationCapture-Test-')) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        }
        foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run')) { Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue }
        Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' -Name ($name + '.lnk') -ErrorAction SilentlyContinue
        $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) ($name + '.lnk')
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    }
    if ($folder) {
        try { $service.GetFolder('\').DeleteFolder($folder.Name,0) }
        catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
    }
}
$report.cleanedUp = $true
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence 'report.json') -Encoding utf8
