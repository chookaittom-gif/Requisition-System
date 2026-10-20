#!/usr/bin/env bash
# All-in-One Deployment Script for Bash / Git Bash
set -e

MSG="${1:-}"

# Check for PowerShell Core or Windows PowerShell
if command -v pwsh >/dev/null 2>&1; then
    PS_BIN="pwsh"
elif command -v powershell.exe >/dev/null 2>&1; then
    PS_BIN="powershell.exe"
else
    PS_BIN="powershell"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$MSG" ]; then
    "$PS_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/deploy-all.ps1"
else
    "$PS_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/deploy-all.ps1" "$MSG"
fi
