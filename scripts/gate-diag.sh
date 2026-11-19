#!/bin/sh
# The gate diagnostic pass: where a gate's time goes on this host. Run it from a checkout root with
# node_modules installed. It prints one `measure<TAB>value` line per measure, and `unmeasured` (never 0
# or blank) for a measure that failed, timed out or could not be parsed; after every measure has run it
# exits 1 if any required one is unmeasured. Host facts it cannot read print `absent`, for information.
#
#   sh scripts/gate-diag.sh [postgres-url]
#
# GATE_DIAG_TMP_COPY=<dir> also copies the checkout into <dir> (a tmpfs, say) and repeats the file,
# require and vitest measures there as `*_tmp`, so the workspace filesystem's share can be split out.
#
# With a URL it also measures postgres, durable first, then runs scripts/gate-pg-fast.sh (the gate's own
# tuning) and measures again, with psql alone. Never point it at a server holding data you keep: it
# drops and recreates the table gate_diag, and it turns durability off server-wide.
set -u

here=$(dirname "$0")
url=${1:-}
# One web suite under jsdom: it needs only core/dist (npm run build -w core) and exercises transform,
# collect and a DOM environment the way the test gate does.
VITEST_FILE=web/test/env-editor.dom.test.tsx
failed=0

emit() { printf '%s\t%s\n' "$1" "$2"; }
# A required measure that has no value fails the pass.
need() {
    if [ -n "$2" ]; then emit "$1" "$2"; else emit "$1" unmeasured; failed=1; fi
}
# A host fact: informational, `absent` when unreadable.
fact() {
    if [ -n "$2" ]; then emit "$1" "$2"; else emit "$1" absent; fi
}

# timed <seconds> <output file> <command>: runs <command> under sh with stdout and stderr in <output
# file>, prints the elapsed seconds and exits with the command's status, 124 when it timed out.
timed() {
    node -e '
const { spawnSync } = require("node:child_process");
const { openSync } = require("node:fs");
const [limit, out, cmd] = process.argv.slice(1);
const fd = openSync(out, "w");
const start = performance.now();
const run = spawnSync("sh", ["-c", cmd], { stdio: ["ignore", fd, fd], timeout: Number(limit) * 1000, killSignal: "SIGKILL" });
process.stdout.write(((performance.now() - start) / 1000).toFixed(3) + "\n");
process.exit(run.error || run.signal ? 124 : run.status);
' "$1" "$2" "$3"
}

out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT

# secs <seconds> <command>: the elapsed seconds when <command> succeeded, nothing otherwise.
secs() {
    s=$(timed "$1" "$out" "$2") || return 0
    printf '%s' "$s"
}

# --- host facts ---------------------------------------------------------------------------------
n=$(nproc 2>/dev/null) || n=
case $n in '' | *[!0-9]*) n= ;; esac
need nproc "$n"
n=$(node -p 'require("node:os").availableParallelism()' 2>/dev/null) || n=
case $n in '' | *[!0-9]*) n= ;; esac
need available_parallelism "$n"
fact mem_total "$(sed -n 's/^MemTotal:[[:space:]]*//p' /proc/meminfo 2>/dev/null)"
fact cgroup_cpu_max "$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"
fact cpu_model "$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n 1)"
if [ -r /proc/cpuinfo ]; then
    if grep -q '^flags.* hypervisor' /proc/cpuinfo; then emit hypervisor yes; else emit hypervisor no; fi
else
    emit hypervisor absent
fi
lines=$(mount 2>/dev/null | grep -E 'virtiofs|overlay|9p|tmpfs')
if [ -n "$lines" ]; then
    printf '%s\n' "$lines" | while IFS= read -r line; do emit mount "$line"; done
else
    emit mount absent
fi
fact fs_cwd "$(stat -f -c %T . 2>/dev/null)"
fact fs_root "$(stat -f -c %T / 2>/dev/null)"

# --- microbenchmarks ----------------------------------------------------------------------------
# files <suffix>: node_modules' file count and the time to walk it, then the time to load typescript.
files() {
    if ! err=$(ls -d node_modules 2>&1 >/dev/null); then
        case $err in
        *'No such file'* | *'not found'*) echo "no node_modules in $(pwd)" >&2 ;;
        *) echo "node_modules unreadable: $err" >&2 ;;
        esac
        need "files_count$1" ''
        need "files_seconds$1" ''
        need "require_typescript_seconds$1" ''
        return 0
    fi
    s=$(timed 900 "$out" 'find node_modules -type f | wc -l') || s=
    count=$(tr -d ' ' <"$out")
    case $count in '' | *[!0-9]*) s= count= ;; esac
    need "files_count$1" "$count"
    need "files_seconds$1" "$s"
    need "require_typescript_seconds$1" "$(secs 120 'node -e "require(\"typescript\")"')"
}

files ''
need node_baseline_seconds "$(secs 60 'node -e 0')"
# One fixed single-thread integer loop. GATE_DIAG_LOOP shrinks it for the script's own tests only: a
# sample taken with another count is not comparable.
loop=${GATE_DIAG_LOOP:-100000000}
case $loop in '' | *[!0-9]*) loop=100000000 ;; esac
for _ in 1 2 3; do
    need cpu_loop_seconds "$(secs 120 "node -e 'const f = () => { let x = 0; for (let i = 0; i < $loop; i++) x = (x + i) | 0; return x; }; if (f() === 1) console.log(1);'")"
done

# --- representative workload --------------------------------------------------------------------
# vitest <suffix>: one jsdom suite, its wall time and the phases of vitest's Duration summary. A
# failing suite still reports its timings; its exit status is a line of its own.
vitest() {
    s=$(timed 900 "$out" "NO_COLOR=1 npx vitest run --project dom $VITEST_FILE")
    status=$?
    summary=$(sed "s/$(printf '\033')\[[0-9;]*m//g" "$out" | grep -E '^[[:space:]]*Duration[[:space:]]' | tail -n 1)
    [ -n "$summary" ] || s=
    [ "$status" = 124 ] && s=
    need "vitest_seconds$1" "$s"
    for phase in transform setup collect tests environment prepare; do
        value=
        if [ -n "$s" ]; then
            value=$(printf '%s\n' "$summary" | sed -n "s/.*[(,] *$phase \([0-9.]*m\{0,1\}s\)[,)].*/\1/p")
        fi
        need "vitest_$phase$1" "$value"
    done
    if [ "$status" = 124 ]; then need "vitest_exit$1" ''; else emit "vitest_exit$1" "$status"; fi
}

need core_build_seconds "$(secs 900 'npm run build -w core')"
vitest ''

# --- the workspace filesystem's share: the same measures on a copy --------------------------------
if [ -n "${GATE_DIAG_TMP_COPY:-}" ]; then
    copy=$GATE_DIAG_TMP_COPY
    s=$(timed 900 "$out" "mkdir -p '$copy' && cp -a . '$copy'") || s=
    need copy_seconds "$s"
    if [ -n "$s" ] && cd "$copy"; then
        files _tmp
        vitest _tmp
        cd - >/dev/null || exit 1
    else
        echo "could not copy the checkout into $copy: $(cat "$out")" >&2
        for key in files_count files_seconds require_typescript_seconds vitest_seconds vitest_transform \
            vitest_setup vitest_collect vitest_tests vitest_environment vitest_prepare vitest_exit; do
            need "${key}_tmp" ''
        done
    fi
fi

# --- postgres -----------------------------------------------------------------------------------
# psql only, since the gate image ships no pgbench: one disposable table, ROWS single-row autocommit
# INSERTs from one session, ROWS primary-key SELECTs from one session, then ROWS more INSERTs split over
# four concurrent sessions. GATE_DIAG_PG_ROWS shrinks it for the script's own tests only: a sample taken
# with another count is not comparable.
PG_KEYS='pg_version pg_data_directory pg_mounts pg_settings_durable pg_durable_write_c1_tps pg_durable_read_c1_tps
pg_durable_write_c4_tps pg_settings_fast pg_fast_write_c1_tps pg_fast_read_c1_tps pg_fast_write_c4_tps'
if [ -z "$url" ]; then
    for key in $PG_KEYS; do emit "$key" unmeasured; done
    exit "$failed"
fi

export PGCONNECT_TIMEOUT=10
SETTINGS="select 'fsync=' || current_setting('fsync') || ' synchronous_commit=' || current_setting('synchronous_commit') || ' full_page_writes=' || current_setting('full_page_writes')"
FAST='fsync=off synchronous_commit=off full_page_writes=off'
q() { psql "$url" -XqAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }

need pg_version "$(q 'show server_version')"
need pg_data_directory "$(q 'show data_directory')"
lines=$(q "select pg_read_file('/proc/self/mountinfo')")
if [ -n "$lines" ]; then
    printf '%s\n' "$lines" | while IFS= read -r line; do emit pg_mounts "$line"; done
else
    need pg_mounts ''
fi

rows=${GATE_DIAG_PG_ROWS:-2000}
case $rows in '' | *[!0-9]*) rows=2000 ;; esac
quarter=$((rows / 4))
sql=$(mktemp -d) || exit 1
trap 'rm -f "$out"; rm -rf "$sql"' EXIT
# ids <first> <last> <statement with %d for the id>: one statement per id.
ids() { awk -v a="$1" -v b="$2" -v f="$3" 'BEGIN { for (i = a; i <= b; i++) printf f "\n", i }'; }
ids 1 "$rows" "insert into gate_diag values (%d, 'v');" >"$sql/write_c1.sql"
ids 1 "$rows" 'select v from gate_diag where id = %d;' >"$sql/read_c1.sql"
for k in 0 1 2 3; do
    ids $((rows + 1 + k * quarter)) $((rows + (k + 1) * quarter)) "insert into gate_diag values (%d, 'v');" >"$sql/write_c4_$k.sql"
done
PSQL="psql '$url' -Xq -v ON_ERROR_STOP=1"

# rate <statements> <seconds>: statements per second; nothing for an elapsed time that is not positive.
rate() { [ -n "$2" ] && awk -v n="$1" -v s="$2" 'BEGIN { if (s > 0) printf "%.1f", n / s }'; }
# bench <set>: the three workloads on a fresh table, dropped afterwards. A table that could not be
# created leaves the whole set unmeasured.
bench() {
    if ! q 'drop table if exists gate_diag; create table gate_diag (id int primary key, v text)' >/dev/null; then
        echo "could not create the gate_diag table: the $1 set is unmeasured" >&2
        for w in write_c1 read_c1 write_c4; do need "pg_$1_${w}_tps" ''; done
        return 0
    fi
    need "pg_$1_write_c1_tps" "$(rate "$rows" "$(secs 300 "$PSQL -f '$sql/write_c1.sql'")")"
    need "pg_$1_read_c1_tps" "$(rate "$rows" "$(secs 300 "$PSQL -f '$sql/read_c1.sql' -o /dev/null")")"
    # Four sessions at once; the clock stops when the last one ends, and any failed session fails it.
    c4=
    for k in 0 1 2 3; do c4="$c4$PSQL -f '$sql/write_c4_$k.sql' & p$k=\$!; "; done
    c4="${c4}r=0; wait \$p0 || r=1; wait \$p1 || r=1; wait \$p2 || r=1; wait \$p3 || r=1; exit \$r"
    need "pg_$1_write_c4_tps" "$(rate $((quarter * 4)) "$(secs 300 "$c4")")"
    q 'drop table if exists gate_diag' >/dev/null || echo 'could not drop the gate_diag table' >&2
}

DURABLE='fsync=on synchronous_commit=on full_page_writes=on'
settings=$(q "$SETTINGS")
need pg_settings_durable "$settings"
# A service a gate already tuned (a rerun on the same service) is not durable: never report it as such.
if [ "$settings" = "$DURABLE" ]; then
    bench durable
else
    echo "durability is not on ($settings): the durable set is unmeasured" >&2
    for key in pg_durable_write_c1_tps pg_durable_read_c1_tps pg_durable_write_c4_tps; do need "$key" ''; done
fi

sh "$here/gate-pg-fast.sh" "$url" || echo 'gate-pg-fast.sh failed' >&2
# The reload is asynchronous: trust the fast set only once a fresh read shows durability off.
settings=
for _ in 1 2 3; do
    settings=$(q "$SETTINGS")
    [ "$settings" = "$FAST" ] && break
    sleep 1
done
need pg_settings_fast "$settings"
if [ "$settings" = "$FAST" ]; then
    bench fast
else
    echo "durability is still on after gate-pg-fast.sh ($settings): the fast set is unmeasured" >&2
    for key in pg_fast_write_c1_tps pg_fast_read_c1_tps pg_fast_write_c4_tps; do need "$key" ''; done
fi
exit "$failed"
