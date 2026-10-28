param([ValidateSet('Prepare','Apply')][string]$Mode,[Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
Import-Module Microsoft.PowerShell.Utility,Microsoft.PowerShell.Management
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Full([string]$p) { [IO.Path]::GetFullPath($p).TrimEnd('\') }
function Within([string]$p,[string]$root) { (Full $p).StartsWith((Full $root)+'\',[StringComparison]::OrdinalIgnoreCase) }
function Hash([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function JsonWrite([string]$p,$value) { [IO.File]::WriteAllText($p,($value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false)) }
function AssertNoLinks([string]$p,[string]$root) {
    $current=Full $p
    while((Within $current $root)-or $current -eq (Full $root)) {
        if(Test-Path -LiteralPath $current) { if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked update path refused' } }
        if($current -eq (Full $root)){break};$current=[IO.Path]::GetDirectoryName($current)
    }
}
function SafeRelative([string]$name) {
    if(!$name -or $name.Length -gt 220 -or $name -match '[^a-zA-Z0-9_./-]' -or $name -match '(^/|//|(^|/)\.{1,2}(/|$)|[. ](/|$))') { throw 'Unsafe package path' }
    foreach($part in $name.Split('/')) { if($part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw 'Reserved package path'} }
    if($name -match '^(AnnotationCapture-data|Archive|Updates)(/|$)' -or $name -match '(^|/)(config.json|annotation-settings.json|preferences.json|\.env[^/]*)$'){throw 'User data in package'}
}
function Manifest([string]$file) {
    $m=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
    if($m.version -notmatch '^\d+\.\d+\.\d+$' -or $m.files.Count -lt 3 -or $m.files.Count -gt 2000){throw 'Invalid program manifest'}
    $seen=@{};$total=[long]0
    foreach($entry in $m.files){
        SafeRelative $entry.path
        if($entry.path -eq 'program-manifest.json' -or $seen.ContainsKey($entry.path.ToLowerInvariant()) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0){throw 'Invalid manifest file'}
        $seen[$entry.path.ToLowerInvariant()]=$true;$total+=[long]$entry.size
    }
    if($total -gt 2GB -or !$seen.ContainsKey('annotationcapture.exe') -or !$seen.ContainsKey('resources/app.asar')){throw 'Incomplete program manifest'}
    return $m
}
function ValidateFiles($m,[string]$root) {
    foreach($e in $m.files){$p=Join-Path $root $e.path;AssertNoLinks $p $root;if(!(Test-Path -LiteralPath $p -PathType Leaf) -or (Get-Item -LiteralPath $p).Length -ne $e.size -or (Hash $p) -ne $e.sha256){throw ('Program verification failed: '+$e.path)}}
}
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8|ConvertFrom-Json
$transaction=Full $request.transaction;$appRoot=Full $request.appRoot;$dataRoot=Full $request.dataRoot
$updates=Join-Path $dataRoot 'Updates';$payload=Join-Path $transaction 'payload';$rollback=Join-Path $transaction 'rollback'
$receipt=Join-Path $transaction 'receipt.json';$exe=Join-Path $appRoot 'AnnotationCapture.exe'
if(!(Within $transaction $updates) -or (Full $RequestPath) -ne (Join-Path $transaction 'request.json') -or $appRoot -eq [IO.Path]::GetPathRoot($appRoot).TrimEnd('\')){throw 'Invalid update root'}
foreach($p in @($appRoot,$transaction)){AssertNoLinks $p $p}
if($request.version -notmatch '^\d+\.\d+\.\d+$' -or $request.sha256 -notmatch '^[a-f0-9]{64}$' -or (Full $request.zip) -ne (Join-Path $transaction 'update.zip')){throw 'Invalid update request'}
if(!(Test-Path -LiteralPath $request.zip) -or (Hash $request.zip) -ne $request.sha256){throw 'ZIP hash mismatch'}
if($Mode -eq 'Prepare') {
    if(Test-Path -LiteralPath $payload){throw 'Payload already exists'}
    $zip=[IO.Compression.ZipFile]::OpenRead($request.zip)
    try {
        if($zip.Entries.Count -gt 3000){throw 'Too many ZIP entries'}
        $manifestEntry=$zip.GetEntry('program-manifest.json');if(!$manifestEntry -or $manifestEntry.Length -gt 1MB){throw 'No program manifest'}
        [IO.Directory]::CreateDirectory($payload)|Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($manifestEntry,(Join-Path $payload 'program-manifest.json'))
        $manifest=Manifest (Join-Path $payload 'program-manifest.json')
        if($manifest.version -ne $request.version){throw 'Version mismatch'}
        $expected=@{};foreach($e in $manifest.files){$expected[$e.path]=$e};$seen=@{}
        foreach($e in $zip.Entries){
            if($e.FullName.EndsWith('/')){continue}
            SafeRelative $e.FullName
            if($seen.ContainsKey($e.FullName.ToLowerInvariant())){throw 'Duplicate ZIP entry'};$seen[$e.FullName.ToLowerInvariant()]=$true
            if($e.FullName -eq 'program-manifest.json'){continue}
            if(!$expected.ContainsKey($e.FullName) -or $e.Length -ne $expected[$e.FullName].size){throw 'Unexpected ZIP entry'}
            $target=Join-Path $payload $e.FullName;if(!(Within $target $payload)){throw 'ZIP path escaped'}
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$target)
        }
        if($seen.Count -ne $manifest.files.Count+1){throw 'ZIP entries incomplete'}
        ValidateFiles $manifest $payload
        JsonWrite (Join-Path $transaction 'prepared.json') @{version=$manifest.version;files=$manifest.files.Count}
    } finally {$zip.Dispose()}
    exit 0
}
$new=Manifest (Join-Path $payload 'program-manifest.json');ValidateFiles $new $payload
$old=Manifest (Join-Path $appRoot 'program-manifest.json')
if($old.version -ne $request.currentVersion -or $new.version -ne $request.version -or [version]$new.version -le [version]$old.version){throw 'Update version mismatch'}
ValidateFiles $old $appRoot
$oldFiles=@{};foreach($e in $old.files){$oldFiles[$e.path]=$e}
foreach($e in $new.files){
    $target=Join-Path $appRoot $e.path;AssertNoLinks $target $appRoot
    if((Within $target $dataRoot) -or (Within $target $request.archiveRoot)){throw 'Program overlaps user data'}
    if((Test-Path -LiteralPath $target) -and !$oldFiles.ContainsKey($e.path)){throw 'Update would overwrite an unmanaged file'}
}
$parent=Get-Process -Id $request.parentPid -ErrorAction SilentlyContinue
if($parent -and (Full $parent.Path) -ne (Full $exe)){throw 'Parent process changed'}
JsonWrite (Join-Path $transaction 'worker-ready.json') @{pid=$PID}
if($parent -and !$parent.WaitForExit(30000)){throw 'Application did not exit; no files changed'}
$exitDeadline=[DateTime]::UtcNow.AddSeconds(30)
do {
    $remaining=@(Get-Process -Name AnnotationCapture -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Full $_.Path) -eq (Full $exe) })
    if(!$remaining.Count){break}
    if([DateTime]::UtcNow -gt $exitDeadline){throw 'Application processes still running; no files changed'}
    Start-Sleep -Milliseconds 200
} while($true)
Remove-Item -LiteralPath (Join-Path $transaction 'healthy.json') -Force -ErrorAction SilentlyContinue
$changes=@();$newProcess=$null
try {
    [IO.Directory]::CreateDirectory($rollback)|Out-Null
    foreach($e in @($new.files)+@(@{path='program-manifest.json';sha256=(Hash (Join-Path $payload 'program-manifest.json'))})){
        $target=Join-Path $appRoot $e.path;$source=Join-Path $payload $e.path
        if((Test-Path -LiteralPath $target) -and (Hash $target) -eq $e.sha256){continue}
        $backup=Join-Path $rollback $e.path;$existed=Test-Path -LiteralPath $target
        if($existed){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))|Out-Null;Copy-Item -LiteralPath $target -Destination $backup}
        $changes+=@{path=$e.path;existed=$existed}
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    ValidateFiles $new $appRoot
    $launchArgs=@('--userData',('"'+$dataRoot+'"'),'--archiveRoot',('"'+$request.archiveRoot+'"'),'--updateReceipt',('"'+$RequestPath+'"'))
    if($request.testMode){$launchArgs+='--testMode'}
    $newProcess=Start-Process -FilePath $exe -ArgumentList $launchArgs -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru
    $healthy=Join-Path $transaction 'healthy.json';$deadline=[DateTime]::UtcNow.AddSeconds(45)
    while(!(Test-Path -LiteralPath $healthy)){
        Start-Sleep -Milliseconds 200
        if($newProcess.HasExited -or [DateTime]::UtcNow -gt $deadline){throw 'New application startup did not pass health check'}
    }
    $health=Get-Content -LiteralPath $healthy -Raw -Encoding UTF8|ConvertFrom-Json
    if($health.version -ne $new.version -or $health.pid -ne $newProcess.Id){throw 'Health acknowledgement mismatch'}
    JsonWrite $receipt @{status='installed';version=$new.version;previousVersion=$old.version;changed=$changes.Count;rollback=$rollback;retainUntil=[DateTime]::UtcNow.AddDays(14).ToString('o')}
    # Only generated files in this verified transaction are removed; rollback remains.
    try { if((Within $payload $transaction) -and (Within $transaction $updates)){AssertNoLinks $payload $transaction;Remove-Item -LiteralPath $payload -Recurse -Force;Remove-Item -LiteralPath $request.zip -Force} } catch { }
} catch {
    $failure=$_.Exception.Message
    if($newProcess -and !$newProcess.HasExited){Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue}
    foreach($e in $changes){$target=Join-Path $appRoot $e.path;$backup=Join-Path $rollback $e.path;AssertNoLinks $target $appRoot;if($e.existed){Copy-Item -LiteralPath $backup -Destination $target -Force}else{if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Force}}}
    ValidateFiles $old $appRoot
    JsonWrite $receipt @{status='rolled-back';version=$old.version;failedVersion=$new.version;error=$failure}
    Start-Process -FilePath $exe -ArgumentList @('--userData',('"'+$dataRoot+'"'),'--archiveRoot',('"'+$request.archiveRoot+'"'),'--background') -WorkingDirectory $appRoot -WindowStyle Hidden
    exit 1
}
