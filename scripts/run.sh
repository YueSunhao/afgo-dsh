#!/usr/bin/env bash
# afg launcher — forwards every argument to scripts/afg.py with a working Python 3.
# Honours AFG_PYTHON when set. Exit code 2 means "no usable Python 3 found".
set -euo pipefail

src="${BASH_SOURCE[0]:-$0}"
dir="$(cd "$(dirname "$src")" && pwd -P)"

rc_test='import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'

works() {
    "$@" -c "$rc_test" >/dev/null 2>&1
}

py=""
if [ -n "${AFG_PYTHON:-}" ]; then
    if works "$AFG_PYTHON"; then
        py="$AFG_PYTHON"
    else
        echo "afg: AFG_PYTHON=$AFG_PYTHON is not a working Python 3." >&2
        exit 2
    fi
else
    # Order matters: python3 first on POSIX, but Windows ships a Store alias
    # stub named python3 that exists yet refuses to run, so prove each candidate.
    for candidate in python3 python py; do
        if ! command -v "$candidate" >/dev/null 2>&1; then
            continue
        fi
        case "$candidate" in
            py)
                if works "$candidate" -3; then py="$candidate -3"; break; fi
                ;;
            *)
                if works "$candidate"; then py="$candidate"; break; fi
                ;;
        esac
    done
fi

if [ -z "$py" ]; then
    echo "afg: no working Python 3 found. Install Python 3.8+ or set AFG_PYTHON." >&2
    exit 2
fi

exec $py -X utf8 "$dir/afg.py" "$@"
