# Pushes the local D:\Collecting working tree to the existing GitHub repository.
# Uses the logged-in Git credentials (HTTPS PAT via credential manager, or SSH).
# Run from any directory: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-to-github.ps1

$ErrorActionPreference = 'Stop'
$repo       = 'D:\Collecting'
$remoteUrl  = 'https://github.com/wbdao/collections-management.git'
$branch     = 'main'
$message    = 'Phase 1: Sheets backend, edge API, customer master, CLASP deployment'

# Git is installed on this machine but NOT on PATH in some sessions.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  $candidates = @(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\Program Files\Git\bin\git.exe',
    'C:\Program Files (x86)\Git\cmd\git.exe',
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) {
      $env:Path = "$(Split-Path $c -Parent);$env:Path"
      $gitCmd = Get-Command git -ErrorAction SilentlyContinue
      break
    }
  }
}
if (-not $gitCmd) {
  throw 'Git is not installed. Install it with: winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements'
}
Write-Output "Using git: $($gitCmd.Source)"

Set-Location $repo

# Initialize only if this folder is not already a repository.
if (-not (Test-Path (Join-Path $repo '.git'))) {
  Write-Output 'Initializing repository...'
  git init -b $branch
} else {
  Write-Output 'Existing repository detected; keeping history.'
}

# Remote setup: keep an existing correct remote, replace a wrong one.
$existing = (git remote get-url origin 2>$null)
if (-not $existing) {
  git remote add origin $remoteUrl
  Write-Output "Added origin: $remoteUrl"
} elseif ($existing.Trim() -ne $remoteUrl) {
  Write-Output "Replacing wrong origin ($existing) with $remoteUrl"
  git remote set-url origin $remoteUrl
} else {
  Write-Output "Origin already correct: $remoteUrl"
}

# Ensure we commit from the intended branch.
git checkout -B $branch

git add -A
$staged = (git diff --cached --name-only).Count
Write-Output "Staged files: $staged"
if ($staged -eq 0) { throw 'Nothing to commit.' }

git commit -m $message

Write-Output 'Pushing to GitHub...'
git push --set-upstream origin $branch

Write-Output 'DONE. Verify at https://github.com/wbdao/collections-management'
