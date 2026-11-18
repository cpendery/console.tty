$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Based on microsoft/tui-test's install/install.ps1 (MIT).
if ($env:OS -ne "Windows_NT") {
    throw "Use install.sh on Linux or macOS."
}
$architecture = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrWhiteSpace($architecture)) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
}
if ($architecture -notin @("AMD64", "x86_64")) {
    throw "Unsupported Windows architecture: $architecture"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is required."
}

$binDir = Join-Path $env:LOCALAPPDATA "Programs\console-tty\bin"
$dataDir = Join-Path $env:LOCALAPPDATA "console-tty"
$extensionDir = Join-Path $dataDir "extension"
$version = $env:CONSOLE_TTY_VERSION
$base = "https://github.com/cpendery/console.tty/releases"
if ([string]::IsNullOrWhiteSpace($version) -or $version -eq "latest") {
    $base = "$base/latest/download"
}
else {
    $base = "$base/download/$version"
}

function Get-ConsoleTtyReleaseAsset {
    param([string]$Name, [string]$Destination)
    try {
        Invoke-WebRequest "$base/$Name" -OutFile $Destination -UseBasicParsing
    }
    catch {
        $response = $_.Exception.PSObject.Properties["Response"]
        if ($null -eq $response -or [int]$response.Value.StatusCode -notin @(401, 404) -or
            -not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw
        }
        # Private repositories require an authenticated release download.
        $downloadArgs = @(
            "release", "download", "--repo", "cpendery/console.tty",
            "--pattern", $Name, "--output", $Destination, "--clobber"
        )
        if (-not [string]::IsNullOrWhiteSpace($version) -and $version -ne "latest") {
            $downloadArgs += $version
        }
        & gh @downloadArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Could not download $Name. Run 'gh auth login' with access to cpendery/console.tty."
        }
    }
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("console-tty-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $archive = Join-Path $tempDir "cli.zip"
    $extension = Join-Path $tempDir "console-tty-extension.zip"
    Get-ConsoleTtyReleaseAsset "console-tty-x86_64-pc-windows-msvc.zip" $archive
    Get-ConsoleTtyReleaseAsset "console-tty-extension.zip" $extension
    $extractDir = Join-Path $tempDir "extract"
    Expand-Archive -LiteralPath $archive -DestinationPath $extractDir
    $files = @(Get-ChildItem -LiteralPath $extractDir -Recurse -Force)
    if ($files.Count -ne 1 -or $files[0].Name -ne "console-tty.exe" -or $files[0].PSIsContainer) {
        throw "Unexpected CLI archive contents."
    }
    $extensionExtractDir = Join-Path $tempDir "extension"
    Expand-Archive -LiteralPath $extension -DestinationPath $extensionExtractDir
    if (-not (Test-Path -LiteralPath (Join-Path $extensionExtractDir "manifest.json") -PathType Leaf)) {
        throw "Unexpected extension archive contents."
    }

    New-Item -ItemType Directory -Path $binDir, $dataDir -Force | Out-Null
    $destination = Join-Path $binDir "console-tty.exe"
    Copy-Item -LiteralPath $files[0].FullName -Destination $destination -Force
    Unblock-File -LiteralPath $destination
    if (Test-Path -LiteralPath $extensionDir) {
        Remove-Item -LiteralPath $extensionDir -Recurse -Force
    }
    Move-Item -LiteralPath $extensionExtractDir -Destination $extensionDir

    # Preserve unexpanded registry entries such as %USERPROFILE%.
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try {
        $userPath = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($userPath.Split(";") | ForEach-Object { $_.Trim().TrimEnd("\") })
        if ($binDir.TrimEnd("\") -notin $entries) {
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($null -ne $key.GetValue("Path")) { $kind = $key.GetValueKind("Path") }
            $key.SetValue("Path", "$binDir;$userPath", $kind)
        }
    }
    finally {
        $key.Dispose()
    }
    if ($binDir.TrimEnd("\") -notin @($env:Path.Split(";") | ForEach-Object { $_.Trim().TrimEnd("\") })) {
        $env:Path = "$binDir;$env:Path"
    }

    if (-not ("ConsoleTtyInstaller.NativeMethods" -as [Type])) {
        Add-Type -Namespace ConsoleTtyInstaller -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [ConsoleTtyInstaller.NativeMethods]::SendMessageTimeout(
        [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result
    ) | Out-Null

    Write-Host "Installed console-tty; PATH updated (restart other terminals)."
    Write-Host "1. Load $extensionDir at chrome://extensions (Developer mode > Load unpacked)."
    Write-Host "2. Run: console-tty native-host install YOUR_EXTENSION_ID (Edge: add --browser edge)."
}
finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
