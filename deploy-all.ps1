[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Message = "",

    [Parameter()]
    [switch]$SkipTests,

    [Parameter()]
    [switch]$UpdateActiveGas,

    [Parameter()]
    [string]$ActiveGasDeploymentId = "AKfycbwVmsrqKX3f8T9cKUqpEK4i0rGWYV0xdSLN5e_vI8lyxJjyN79xoeAfD8ECmZyU7tcF"
)

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
    $Message = "Auto deploy: $NowStr"
}

Write-Host "`n=== Start Deployment Process ===" -ForegroundColor Magenta
Write-Host "Commit & Deploy Message: $Message" -ForegroundColor White

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
            Write-Err "Unit tests failed. Deployment aborted."
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
Write-Step "Step 1: Git Add, Commit and Push"
Write-Host "Adding changed files..." -ForegroundColor Gray
git add .
if ($LASTEXITCODE -ne 0) {
    Write-Err "git add failed"
    exit 1
}

$GitStatus = git status --porcelain
if ($GitStatus) {
    Write-Host "Committing changes with message: '$Message'..." -ForegroundColor Gray
    git commit -m "$Message"
    if ($LASTEXITCODE -ne 0) {
        Write-Err "git commit failed"
        exit 1
    }
    Write-Success "Git commit created."
} else {
    Write-Host "No unstaged changes to commit (working tree clean)." -ForegroundColor Yellow
}

Write-Host "Pushing to GitHub (origin main)..." -ForegroundColor Gray
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Err "git push failed."
    exit 1
}
Write-Success "Pushed to GitHub successfully."

# STEP 2: Google Apps Script (clasp)
Write-Step "Step 2: Google Apps Script (clasp push & deploy)"
Write-Host "Running clasp push..." -ForegroundColor Gray
clasp push --force
if ($LASTEXITCODE -ne 0) {
    Write-Err "clasp push failed."
    exit 1
}
Write-Success "clasp push finished."

if ($UpdateActiveGas) {
    Write-Host "Updating active deployment ($ActiveGasDeploymentId)..." -ForegroundColor Gray
    clasp deploy -i $ActiveGasDeploymentId -d "$Message"
} else {
    Write-Host "Creating new deployment version..." -ForegroundColor Gray
    clasp deploy -d "$Message"
}

if ($LASTEXITCODE -ne 0) {
    Write-Err "clasp deploy failed."
    exit 1
}
Write-Success "Google Apps Script deployed successfully."

# STEP 3: Cloudflare Workers
Write-Step "Step 3: Cloudflare Workers Deploy (D1 & Worker)"
Push-Location "$RootDir\cloudflare"
try {
    Write-Host "Applying D1 remote migrations (ims_db)..." -ForegroundColor Gray
    "y" | npx wrangler d1 migrations apply ims_db --remote
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "wrangler d1 migrations apply remote returned non-zero code or no new migrations."
    } else {
        Write-Success "Remote D1 migrations applied successfully."
    }

    Write-Host "Deploying Worker to Cloudflare..." -ForegroundColor Gray
    npx wrangler deploy
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Cloudflare wrangler deploy failed."
        exit 1
    }
    Write-Success "Cloudflare Worker deployed successfully (Account ID: 17abb4914aa1cbfcf03edddedbaea672)."
}
finally {
    Pop-Location
}

Write-Host "`n********************************************************" -ForegroundColor Green
Write-Host "  Done! All deployments completed successfully!        " -ForegroundColor Green
Write-Host "  1. Git & GitHub: Pushed" -ForegroundColor White
Write-Host "  2. Google Apps Script: Pushed & Deployed" -ForegroundColor White
Write-Host "  3. Cloudflare Workers: D1 Migrated & Deployed" -ForegroundColor White
Write-Host "********************************************************`n" -ForegroundColor Green