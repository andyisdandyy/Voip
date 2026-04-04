[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('server', 'client', 'both')]
    [string]$Target,

    [Parameter(Mandatory = $true, Position = 1)]
    [string]$Version,

    [string]$CommitMessage,
    [switch]$AllowDirty,
    [switch]$DryRun,
    [string]$Remote = 'origin'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    throw $Message
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Args,
        [switch]$CaptureOutput
    )

    if ($DryRun) {
        Write-Host ("[dry-run] git " + ($Args -join ' '))
        if ($CaptureOutput) {
            return @()
        }
        return
    }

    if ($CaptureOutput) {
        $output = & git @Args 2>&1
        if ($LASTEXITCODE -ne 0) {
            Fail ("git " + ($Args -join ' ') + " failed`n" + ($output -join "`n"))
        }
        return $output
    }

    & git @Args
    if ($LASTEXITCODE -ne 0) {
        Fail ("git " + ($Args -join ' ') + " failed")
    }
}

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    Fail "Version must be in X.Y.Z format (example: 1.2.3)."
}

$repoCheck = & git rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $repoCheck -ne 'true') {
    Fail 'Run this script from inside a git repository.'
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to determine current branch.'
}
if ($branch -eq 'HEAD') {
    Fail 'Detached HEAD is not supported. Checkout a branch first.'
}

$statusLines = @(& git status --porcelain)
$dirty = $statusLines.Count -gt 0
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to read git status.'
}

if ($dirty -and -not $AllowDirty -and [string]::IsNullOrWhiteSpace($CommitMessage)) {
    Fail 'Working tree has changes. Commit first, or use -CommitMessage to auto-commit, or pass -AllowDirty.'
}

if (-not [string]::IsNullOrWhiteSpace($CommitMessage)) {
    if ($dirty) {
        Invoke-Git -Args @('add', '-A')
        Invoke-Git -Args @('commit', '-m', $CommitMessage)
        Write-Host "Committed changes: $CommitMessage"
    }
    else {
        Write-Host 'No uncommitted changes found; skipping commit step.'
    }
}

$tags = @("v$Version")

if ($Target -ne 'both') {
    Write-Host "Note: '$Target' currently maps to shared tag v$Version so client and server publish into one release."
}

foreach ($tag in $tags) {
    $localTags = @(& git tag --list $tag)
    $localExists = $localTags.Count -gt 0
    if ($LASTEXITCODE -ne 0) {
        Fail "Unable to check local tag '$tag'."
    }
    if ($localExists) {
        Fail "Local tag '$tag' already exists."
    }

    $remoteMatch = @(Invoke-Git -Args @('ls-remote', '--tags', $Remote, "refs/tags/$tag") -CaptureOutput)
    if ($remoteMatch.Count -gt 0) {
        Fail "Remote tag '$tag' already exists on '$Remote'."
    }
}

foreach ($tag in $tags) {
    Invoke-Git -Args @('tag', '-a', $tag, '-m', "Release $tag")
    Write-Host "Created tag: $tag"
}

Invoke-Git -Args @('push', $Remote, $branch)
Invoke-Git -Args (@('push', $Remote) + $tags)

Write-Host ''
Write-Host ('Done. Pushed branch {0} and tag(s): {1}' -f $branch, ($tags -join ', '))
