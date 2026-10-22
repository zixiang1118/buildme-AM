[CmdletBinding()]
param(
    [string]$Python,
    [switch]$WithRetrosynthesis,
    [string]$RetrosynthesisConfig
)

$ErrorActionPreference = 'Stop'

function Write-Diagnostic([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

function Invoke-Checked([string]$Executable, [string[]]$CommandArguments) {
    & $Executable @CommandArguments | ForEach-Object { [Console]::Error.WriteLine([string]$_) }
    if ($LASTEXITCODE -ne 0) { throw ('Command failed with exit code ' + $LASTEXITCODE) }
}

function Test-Python([string]$Candidate) {
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $null }
    $result = & $Candidate -c 'import json,sys; print(json.dumps(dict(path=sys.executable,version=list(sys.version_info[:3]))))' 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    try {
        $info = $result | ConvertFrom-Json
        if ($info.version[0] -eq 3 -and $info.version[1] -ge 11 -and $info.version[1] -le 12) { return $info }
    } catch { return $null }
    return $null
}

function Find-Python {
    if ($Python) {
        $requested = Test-Python $Python
        if (-not $requested) { throw 'The supplied Python must be an existing CPython 3.11 or 3.12 executable.' }
        return $requested
    }
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCommand) {
        foreach ($pythonVersion in @('3.12', '3.11')) {
            $located = & $uvCommand.Source python find $pythonVersion --no-python-downloads 2>$null
            if ($LASTEXITCODE -eq 0) {
                $found = Test-Python ($located | Select-Object -First 1)
                if ($found) { return $found }
            }
        }
    }
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($pythonVersion in @('-3.12', '-3.11')) {
            $located = & $launcher.Source $pythonVersion -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0) {
                $found = Test-Python ($located | Select-Object -First 1)
                if ($found) { return $found }
            }
        }
    }
    throw 'Install CPython 3.11 or 3.12, or pass -Python with its existing executable path.'
}

try {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
    $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'BuildMe\research-runtime'
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $configurationPath = Join-Path $runtimeDirectory 'config.json'
    $configuration = @{}
    if (Test-Path -LiteralPath $configurationPath) {
        $previous = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
        foreach ($property in $previous.PSObject.Properties) { $configuration[$property.Name] = $property.Value }
    }
    $basePython = Find-Python
    Write-Diagnostic ('Using existing Python ' + ($basePython.version -join '.') + ': ' + $basePython.path)
    $chemistryDirectory = Join-Path $runtimeDirectory 'chemistry-env'
    $chemistryPython = Join-Path $chemistryDirectory 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $chemistryPython -PathType Leaf)) {
        Invoke-Checked $basePython.path @('-m', 'venv', $chemistryDirectory)
    }
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    # The package list is fixed. No input is ever interpreted as a pip package or option.
    # datamol 0.12.5 meets medchem's >=0.12.5 requirement without forcing
    # unrelated cloud storage and Jupyter stacks into this local-only runtime.
    $basePackages = @('rdkit==2026.3.6', 'medchem==2.1.1', 'datamol==0.12.5')
    $env:UV_HTTP_TIMEOUT = '25'
    $env:UV_HTTP_RETRIES = '1'
    if ($uvCommand) {
        Invoke-Checked $uvCommand.Source (@('--system-certs', 'pip', 'install', '--python', $chemistryPython, '--index-url', 'https://pypi.org/simple') + $basePackages)
    } else {
        Invoke-Checked $chemistryPython (@('-m', 'pip', 'install', '--disable-pip-version-check', '--timeout', '25', '--retries', '1') + $basePackages)
    }
    Invoke-Checked $chemistryPython @('-c', 'import rdkit,medchem,datamol; print(1)')
    $configuration['python'] = $chemistryPython
    $configuration['basePython'] = $basePython.path
    $configuration['packages'] = $basePackages
    if (-not $configuration.ContainsKey('modelsDownloaded')) { $configuration['modelsDownloaded'] = $false }
    if (-not $configuration.ContainsKey('retrosynthesisPython')) { $configuration['retrosynthesisPython'] = $null }
    if (-not $configuration.ContainsKey('retrosynthesisConfig')) { $configuration['retrosynthesisConfig'] = $null }
    if ($WithRetrosynthesis) {
        $retroDirectory = Join-Path $runtimeDirectory 'retrosynthesis-env'
        $retroPython = Join-Path $retroDirectory 'Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $retroPython -PathType Leaf)) {
            Invoke-Checked $basePython.path @('-m', 'venv', $retroDirectory)
        }
        $retroPackages = @('aizynthfinder==4.4.1', 'numpy==1.26.4', 'pyarrow==21.0.0')
        if ($uvCommand) {
            Invoke-Checked $uvCommand.Source (@('--system-certs', 'pip', 'install', '--python', $retroPython, '--index-url', 'https://pypi.org/simple') + $retroPackages)
        } else {
            Invoke-Checked $retroPython (@('-m', 'pip', 'install', '--disable-pip-version-check', '--timeout', '25', '--retries', '1') + $retroPackages)
        }
        Invoke-Checked $retroPython @('-c', 'from aizynthfinder.interfaces.aizynthcli import main; print(main.__module__)')
        $configuration['retrosynthesisPython'] = $retroPython
        $configuration['retrosynthesisPackages'] = $retroPackages
    }
    if ($RetrosynthesisConfig) {
        $localConfig = Resolve-Path -LiteralPath $RetrosynthesisConfig
        if (-not (Test-Path -LiteralPath $localConfig.ProviderPath -PathType Leaf)) { throw 'RetrosynthesisConfig must be an existing local YAML file.' }
        $configuration['retrosynthesisConfig'] = $localConfig.ProviderPath
        $provenancePath = Join-Path (Split-Path -Parent $localConfig.ProviderPath) 'data-provenance.json'
        if (Test-Path -LiteralPath $provenancePath -PathType Leaf) {
            $modelProvenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
            if ($modelProvenance.complete -eq $true) {
                $configuration['modelsDownloaded'] = $true
                $configuration['sourceManifest'] = $provenancePath
            }
        }
    }
    $configuration['updatedAt'] = [DateTime]::UtcNow.ToString('o')
    $configuration['schemaVersion'] = 1
    $json = $configuration | ConvertTo-Json -Depth 8
    $temporaryConfig = $configurationPath + '.tmp'
    [IO.File]::WriteAllText($temporaryConfig, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryConfig -Destination $configurationPath -Force
    Write-Diagnostic ('Saved runtime configuration: ' + $configurationPath)
    [Console]::Out.WriteLine($json)
} catch {
    Write-Diagnostic $_.Exception.Message
    [Console]::Out.WriteLine((@{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
}
