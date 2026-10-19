[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    $ArgsList
)
& "$PSScriptRoot\deploy-cloudflare.ps1" @ArgsList
