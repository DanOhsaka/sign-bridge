
param(
    [string]$DatasetPath = ".\training-data"
)

$root = (Resolve-Path $DatasetPath).Path

# Find folders containing JSON files
$folders = @($root) + @(
    Get-ChildItem -LiteralPath $root -Directory -Recurse |
    Select-Object -ExpandProperty FullName
)

foreach ($folder in $folders) {

    $files = @(
        Get-ChildItem -LiteralPath $folder -File -Filter "*.json" |
        Sort-Object Name
    )

    if ($files.Count -eq 0) {
        continue
    }

    Write-Host "`nProcessing: $folder"

    # Stage files using temporary unique names.
    # This avoids collisions with existing numbered files.
    $staged = @()

    foreach ($file in $files) {

        $tempName = [guid]::NewGuid().ToString() + ".json"

        Rename-Item -LiteralPath $file.FullName -NewName $tempName -ErrorAction Stop

        $staged += @{
            Path = Join-Path $folder $tempName
            OriginalName = $file.Name
        }
    }

    # Rename files sequentially.
    $number = 1

    foreach ($item in $staged) {

        # Use the sign folder name for the prefix.
        # For files directly inside the dataset root,
        # use the JSON's label instead.
        if ($folder -eq $root) {
            $json = Get-Content -LiteralPath $item.Path -Raw |
                    ConvertFrom-Json
            $sign = [string]$json.label
        }
        else {
            $sign = Split-Path $folder -Leaf
        }

        $sign = $sign.Trim().ToUpper() -replace '[^A-Z0-9_-]', '_'

        $newName = "{0}_{1:D3}.json" -f $sign, $number

        Rename-Item -LiteralPath $item.Path -NewName $newName -ErrorAction Stop

        Write-Host "$($item.OriginalName) -> $newName"

        $number++
    }
}
