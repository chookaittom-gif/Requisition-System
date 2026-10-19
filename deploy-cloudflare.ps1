[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Message = "",

    [Parameter()]
    [switch]$SkipTests,

    [Parameter()]
    [switch]$SkipPush,

    [Parameter()]
    [switch]$DeployDirect
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Text)
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Text)
    Write-Host "[SUCCESS] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "[WARNING] $Text" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Text)
    Write-Host "[ERROR] $Text" -ForegroundColor Red
}

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

if ([string]::IsNullOrWhiteSpace($Message)) {
    $NowStr = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $Message = "Update Cloudflare app: $NowStr"
}

Write-Host "`n=== Start Cloudflare Deploy Workflow ===" -ForegroundColor Magenta
Write-Host "Commit message: $Message" -ForegroundColor White

# STEP 0: Quality Checks
if (-not $SkipTests) {
    Write-Step "Step 0: Running Tests and Typecheck"
    Push-Location "$RootDir\cloudflare"
    try {
        Write-Host "Running TypeScript Typecheck..." -ForegroundColor Gray
        npm run typecheck
        if ($LASTEXITCODE -ne 0) {
            Write-Err "TypeScript Typecheck failed."
            exit 1
        }

        Write-Host "Running Unit Tests (Vitest)..." -ForegroundColor Gray
        npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Unit tests failed. Aborted."
            exit 1
        }
        Write-Success "All tests passed successfully."
    }
    finally {
        Pop-Location
    }
} else {
    Write-Warn "Skipping tests (-SkipTests specified)"
}

# STEP 1: Git & GitHub
if (-not $SkipPush) {
    Write-Step "Step 1: Git Add, Commit and Push"
    git add .
    if ($LASTEXITCODE -ne 0) {
        Write-Err "git add failed"
        exit 1
    }

    $GitStatus = git status --porcelain
    if ($GitStatus) {
        if ([string]::IsNullOrWhiteSpace((git config user.name))) {
            git config user.name "chookaittom-gif"
        }
        if ([string]::IsNullOrWhiteSpace((git config user.email))) {
            git config user.email "265235137+chookaittom-gif@users.noreply.github.com"
        }
        Write-Host "Committing changes: '$Message'..." -ForegroundColor Gray
        git commit -m "$Message"
        if ($LASTEXITCODE -ne 0) {
            Write-Err "git commit failed"
            exit 1
        }
        Write-Success "Git commit created."
    } else {
        Write-Host "No unstaged changes to commit (clean working tree)." -ForegroundColor Yellow
    }

    $CurrentBranch = (git branch --show-current).Trim()
    if ([string]::IsNullOrWhiteSpace($CurrentBranch)) { $CurrentBranch = "main" }
    Write-Host "Pushing to GitHub (origin $CurrentBranch)..." -ForegroundColor Gray
    git push origin $CurrentBranch
    if ($LASTEXITCODE -ne 0) {
        Write-Err "git push failed."
        exit 1
    }
    Write-Success "Pushed to GitHub. (GitHub Actions will deploy to Cloudflare)"
}

# Optional STEP 2: Direct Deploy from Local
if ($DeployDirect) {
    Write-Step "Step 2: Direct Deploy to Cloudflare Workers"
    Push-Location "$RootDir\cloudflare"
    $prevCi = $env:CI
    $env:CI = "true"
    try {
        Write-Host "Applying D1 remote migrations..." -ForegroundColor Gray
        npx wrangler d1 migrations apply DB --remote
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "wrangler d1 migrations apply remote returned non-zero code or no new migrations."
        }

        Write-Host "Deploying Worker to Cloudflare..." -ForegroundColor Gray
        npx wrangler deploy
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Cloudflare wrangler deploy failed."
            exit 1
        }
        Write-Success "Direct deploy to Cloudflare finished."
    }
    finally {
        $env:CI = $prevCi
        Pop-Location
    }
}

Write-Host "`n********************************************************" -ForegroundColor Green
Write-Host "  Done! Completed successfully!                         " -ForegroundColor Green
Write-Host "********************************************************`n" -ForegroundColor Green
