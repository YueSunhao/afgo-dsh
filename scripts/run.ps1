# afg launcher -- forwards every argument to scripts\afg.py with a working Python 3.
# Honours AFG_PYTHON when set. Exit code 2 means "no usable Python 3 found".
# ASCII only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8 script files.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Python3 {
    param([string]$exe, [string[]]$prefix)
    & $exe @prefix -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

$py = $null
$pyPrefix = @()

if ($env:AFG_PYTHON) {
    if (Test-Python3 -exe $env:AFG_PYTHON -prefix @()) {
        $py = $env:AFG_PYTHON
    } else {
        [Console]::Error.WriteLine("afg: AFG_PYTHON=$($env:AFG_PYTHON) is not a working Python 3.")
        exit 2
    }
} else {
    # Windows sometimes exposes a Store alias stub named python/python3 that
    # exists but refuses to run, so prove every candidate before using it.
    foreach ($candidate in @('python3', 'python', 'py')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $exe = $cmd.Source
        $prefix = @()
        if ([System.IO.Path]::GetFileNameWithoutExtension($exe) -eq 'py') { $prefix = @('-3') }
        if (Test-Python3 -exe $exe -prefix $prefix) {
            $py = $exe
            $pyPrefix = $prefix
            break
        }
    }
}

if (-not $py) {
    [Console]::Error.WriteLine('afg: no working Python 3 found. Install Python 3.8+ or set AFG_PYTHON.')
    exit 2
}

& $py @pyPrefix -X utf8 "$dir\afg.py" @args
exit $LASTEXITCODE
