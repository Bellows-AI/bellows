#!/bin/sh
# Watch background agents without spending model turns: exit only when one of them stalls, every
# watched path is gone, or the run limit passes. Launch it with run_in_background; its exit is the
# one notification that wakes the conversation.
#
#   sh watchdog.sh [--interval S] [--stall S] [--no-commit S] [--max-run S] <agent>...
#
# Each <agent> is <path>[:<path>...]: its worktree first, then any log or transcript it writes.
# The agent progresses while any of its paths changes — a worktree's HEAD or content (diff
# against HEAD plus untracked files), a file's mtime. No change for --stall seconds (default
# 2700), or no new commit in a worktree for --no-commit seconds (default 5400), is stale: one
# line per stale agent on stdout, exit 3. Every path gone: exit 0. --max-run seconds (default
# 6600, under the host's two-hour background limit) without a stall: exit 0, re-arm it. A tick
# that comes long after the last one means the host slept: the clocks restart instead of firing.
set -u

interval=300
stall=2700
nocommit=5400
maxrun=6600
usage() {
    echo 'usage: watchdog.sh [--interval S] [--stall S] [--no-commit S] [--max-run S] <path>[:<path>...]...' >&2
    exit 2
}
number() { case "$1" in '' | *[!0-9]*) usage ;; esac; }
while [ $# -gt 0 ]; do
    case "$1" in
        --interval) number "${2:-}"; interval="$2"; shift 2 ;;
        --stall) number "${2:-}"; stall="$2"; shift 2 ;;
        --no-commit) number "${2:-}"; nocommit="$2"; shift 2 ;;
        --max-run) number "${2:-}"; maxrun="$2"; shift 2 ;;
        --) shift; break ;;
        -*) usage ;;
        *) break ;;
    esac
done
[ $# -gt 0 ] || usage

now() { date +%s; }
mtime() { date -r "$1" +%s 2>/dev/null; }
is_git() { [ -d "$1" ] && git -C "$1" rev-parse --git-dir >/dev/null 2>&1; }
head_of() { is_git "$1" && git -C "$1" rev-parse HEAD 2>/dev/null; }
# fingerprint <agent>: one line that changes whenever any of the agent's paths does; empty when
# every path is gone.
fingerprint() {
    out=''
    rest="$1"
    while [ -n "$rest" ]; do
        path="${rest%%:*}"
        case "$rest" in *:*) rest="${rest#*:}" ;; *) rest='' ;; esac
        [ -e "$path" ] || continue
        if is_git "$path"; then
            sum="$( (git -C "$path" rev-parse HEAD
                git -C "$path" diff HEAD
                git -C "$path" ls-files --others --exclude-standard -z |
                    (cd "$path" && xargs -0 cat 2>/dev/null)) | cksum)"
        else
            sum="$(mtime "$path")"
        fi
        out="$out $path=$sum"
    done
    printf '%s' "$out"
}

start="$(now)"
last="$start"
# Per-agent state lives in agent_<i>, fp_<i>, head_<i>, changed_<i>, commit_<i>, read through eval.
old='' oldh='' changed=0 commit=0
n=0
for agent in "$@"; do
    n=$((n + 1))
    eval "agent_$n=\$agent"
    eval "fp_$n=\$(fingerprint \"\$agent\")"
    eval "head_$n=\$(head_of \"\${agent%%:*}\")"
    eval "changed_$n=$start"
    eval "commit_$n=$start"
done

while :; do
    sleep "$interval"
    t="$(now)"
    if [ $((t - last)) -gt $((interval * 3)) ]; then
        i=0
        while [ $i -lt $n ]; do
            i=$((i + 1))
            eval "changed_$i=$t"
            eval "commit_$i=$t"
        done
    fi
    last="$t"
    stale=''
    alive=0
    i=0
    while [ $i -lt $n ]; do
        i=$((i + 1))
        eval "agent=\$agent_$i"
        fp="$(fingerprint "$agent")"
        [ -n "$fp" ] || continue
        alive=$((alive + 1))
        eval "old=\$fp_$i"
        if [ "$fp" != "$old" ]; then
            eval "fp_$i=\$fp"
            eval "changed_$i=$t"
        fi
        h="$(head_of "${agent%%:*}")"
        eval "oldh=\$head_$i"
        if [ "$h" != "$oldh" ]; then
            eval "head_$i=\$h"
            eval "commit_$i=$t"
        fi
        eval "changed=\$changed_$i commit=\$commit_$i"
        if [ $((t - changed)) -ge "$stall" ]; then
            stale="${stale}stale: ${agent%%:*} — no change for $(((t - changed) / 60)) min
"
        elif [ -n "$h" ] && [ $((t - commit)) -ge "$nocommit" ]; then
            stale="${stale}stale: ${agent%%:*} — no commit for $(((t - commit) / 60)) min
"
        fi
    done
    if [ -n "$stale" ]; then
        printf '%s' "$stale"
        exit 3
    fi
    if [ "$alive" -eq 0 ]; then
        echo 'watchdog: every watched path is gone'
        exit 0
    fi
    if [ $((t - start)) -ge "$maxrun" ]; then
        echo "watchdog: $alive agent(s) progressing after $(((t - start) / 60)) min — re-arm"
        exit 0
    fi
done
