#!/bin/sh
# Tear down what a fix run left running for one issue: kind clusters, compose projects, containers,
# volumes and networks named fix<N> or fix<N>-<what>, host processes still running in or naming one
# of its worktrees (<repo>-fix-<N> or <repo>-fix-<N>-<suffix>), and test-leaked orphans. The
# worktrees and branches stay — they hold the PR. Prints each removal; exits 1 if any failed.
#
#   sh cleanup.sh <issue-number>
set -u

n="${1:-}"
case "$n" in '' | *[!0-9]*)
    echo 'usage: cleanup.sh <issue-number>' >&2
    exit 2
    ;;
esac
tag="fix$n"
named() { grep -E "^$tag(-|\$)"; }
root="$(cd "$(dirname "$0")/../../.." && pwd)"
failed=0
run() {
    echo "cleanup: $*"
    "$@" >/dev/null 2>&1 || {
        echo "cleanup: FAILED $*" >&2
        failed=1
    }
}

if command -v kind >/dev/null 2>&1; then
    for c in $(kind get clusters 2>/dev/null | named); do
        # kind-cluster.sh also removes the shared registry with the last cluster.
        if [ -f "$root/scripts/kind-cluster.sh" ]; then run sh "$root/scripts/kind-cluster.sh" delete "$c"; else run kind delete cluster --name "$c"; fi
    done
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    for p in $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | named); do
        run docker compose -p "$p" down --volumes --remove-orphans
    done
    for c in $(docker ps -a --format '{{.Names}}' | named); do run docker rm -f -v "$c"; done
    for v in $(docker volume ls -q | named); do run docker volume rm "$v"; done
    for w in $(docker network ls --format '{{.Name}}' | named); do run docker network rm "$w"; done
fi

# Never this script's own ancestry: the session running it may sit in the worktree.
self=''
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    self="$self $p "
    p="$(ps -o ppid= -p "$p" | tr -d ' ')"
done
mine() { case "$self" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# One snapshot, taken before any awk below runs: a matcher would otherwise match its own argv.
procs="$(ps -wwAo pid=,ppid=,command=)"
pids=''
for wt in $(git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | grep -E -- "-fix-$n(-[^/]*)?\$"); do
    # lsof reports resolved paths (/var is /private/var on macOS); a command line carries either.
    real="$(cd "$wt" 2>/dev/null && pwd -P)" || real="$wt"
    for path in "$wt" "$real"; do
        # The path must end where it appears: <repo>-fix-82 must not match <repo>-fix-821.
        pids="$pids $(echo "$procs" | awk -v wt="$path" '{
            s = $0
            while ((i = index(s, wt)) > 0) {
                c = substr(s, i + length(wt), 1)
                if (c == "" || c == "/" || c == " ") { print $1; next }
                s = substr(s, i + 1)
            }
        }')"
    done
    if command -v lsof >/dev/null 2>&1; then
        pids="$pids $(lsof -d cwd -Fpn 2>/dev/null | awk -v wt="$real" '/^p/ {pid = substr($0, 2)} /^n/ {d = substr($0, 2); if (d == wt || index(d, wt "/") == 1) print pid}')"
    elif [ -d /proc/self ]; then
        # No lsof (a slim Linux image): the kernel names each process's working directory.
        for d in /proc/[0-9]*; do
            c="$(readlink "$d/cwd" 2>/dev/null)" || continue
            case "$c" in "$real" | "$real"/*) pids="$pids ${d#/proc/}" ;; esac
        done
    fi
done
# Progress filters the driver tests spawn from any checkout outlive their parent and never exit.
pids="$pids $(echo "$procs" | awk -v under="$(dirname "$root")/" \
    '$2 == 1 && index($0, under) && /docker\/claude-executor\/claude-progress\.cjs/ {print $1}')"

victims=''
for pid in $(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un); do
    mine "$pid" || victims="$victims $pid"
done
if [ -n "$victims" ]; then
    echo "cleanup: kill -TERM$victims"
    # shellcheck disable=SC2086
    kill -TERM $victims 2>/dev/null
    sleep 5
    for pid in $victims; do
        kill -0 "$pid" 2>/dev/null && run kill -KILL "$pid"
    done
fi

[ "$failed" -eq 0 ] && echo "cleanup: $tag clean"
exit "$failed"
