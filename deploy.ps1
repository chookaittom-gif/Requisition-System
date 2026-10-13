[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    $ArgsList
)
& "$PSScriptRoot\deploy-all.ps1" @ArgsList
