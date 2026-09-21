# Installs (or updates) the extension from the newest GitHub Release.
#
# The extension is not on the VS Code Marketplace, so Settings Sync cannot
# restore it: Settings Sync stores Marketplace IDs and re-downloads them from
# there. On a new machine, run this once.
#
#   irm https://raw.githubusercontent.com/hiepbk/pdf-translate-vscode/main/install.ps1 | iex
#
# Re-running it updates to the newest release, so the same command serves both.

$ErrorActionPreference = 'Stop'

$Repo = 'hiepbk/pdf-translate-vscode'

function Find-CodeCommand {
    # `code` is on PATH for most installs, but the User-scope installer does not
    # always add it, so the default location is worth checking before giving up.
    #
    # Select-Object -First 1 is load-bearing: VS Code ships both `code.cmd` and
    # the extensionless `code` shell script in the same directory, so
    # Get-Command returns two matches and `.Source` on that is an array. Calling
    # it would splice both paths into one command name.
    $onPath = Get-Command code -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($onPath) { return $onPath.Source }

    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
        "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
        "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }

    throw "Could not find the 'code' command. Open VS Code, run 'Shell Command: Install code command in PATH' from the Command Palette, then try again."
}

Write-Host "Looking up the newest release of $Repo..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'pdf-translate-installer' }

$asset = $release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $asset) {
    throw "Release $($release.tag_name) has no .vsix attached to it."
}

$code = Find-CodeCommand
$target = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name

Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 2)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -UseBasicParsing

try {
    Write-Host "Installing into VS Code..."
    & $code --install-extension $target --force
    if ($LASTEXITCODE -ne 0) {
        throw "'code --install-extension' exited with code $LASTEXITCODE."
    }
    Write-Host ""
    Write-Host "Installed $($release.tag_name). Reload VS Code to start using it:" -ForegroundColor Green
    Write-Host "  Ctrl+Shift+P -> Developer: Reload Window"
} finally {
    # The VSIX is only a delivery vehicle; VS Code has copied what it needs.
    Remove-Item $target -ErrorAction SilentlyContinue
}
