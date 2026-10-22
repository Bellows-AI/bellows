#!/bin/sh
# The lane's stand-in for `gh` (issue #829): the argv driver/src/publish-pr.ts sends, answered from
# state kept on the task's volume so it survives a killed driver and is counted from outside.
#   lane-gh-prs   one `<branch> <url>` line per created PR
#   lane-gh-bases one `<branch> <base>` line per `pr edit --base`
#   lane-gh-hold  while it exists, `pr create` touches lane-gh-hold.ready and waits for lane-gh-hold.go
set -eu
origin="${LANE_GH_STATE:-/task/.lane-gh}"
mkdir -p "$origin"
prs="$origin/lane-gh-prs"
bases="$origin/lane-gh-bases"
last() { # last <file> <branch> -> the second field of the branch's last line
    [ -f "$1" ] || return 0
    awk -v b="$2" '$1 == b { v = $2 } END { if (v != "") print v }' "$1"
}
case "${1:-} ${2:-}" in
'pr view')
    url="$(last "$prs" "$3")"
    [ -n "$url" ] || {
        echo 'no pull requests found' >&2
        exit 1
    }
    case "$*" in
    *state,baseRefName*) echo "OPEN $(last "$bases" "$3" | grep . || echo main)" ;;
    *) echo "$url" ;;
    esac
    ;;
'pr edit')
    [ "${4:-}" = --base ] || exit 2
    echo "$3 $5" >>"$bases"
    ;;
'pr create')
    [ "${3:-}" = --head ] || exit 2
    if [ -e "$origin/lane-gh-hold" ]; then
        : >"$origin/lane-gh-hold.ready"
        deadline=$(($(date +%s) + 600))
        while [ ! -e "$origin/lane-gh-hold.go" ]; do
            [ "$(date +%s)" -lt "$deadline" ] || {
                echo 'lane-gh: the hold was never released' >&2
                exit 1
            }
            sleep 0.2
        done
    fi
    n=$(($(grep -c . "$prs" 2>/dev/null || true) + 1))
    url="https://github.com/factory-smoke/demo/pull/$n"
    echo "$4 $url" >>"$prs"
    echo "$url"
    ;;
*)
    echo "lane-gh: unsupported: $*" >&2
    exit 2
    ;;
esac
