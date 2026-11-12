#!/bin/sh
# Re-resolves every pinned image digest to what its tag points at today, rewriting the pin in place:
# the external `FROM` lines of the four Dockerfiles and the chart's collector image. The weekly
# .github/workflows/mirror-images.yml runs it and opens a pull request when it changed anything;
# run by hand it leaves the diff for you to review. Needs a docker with buildx and registry access.
# POSIX sh: the runner images and CI shells differ.
set -eu
cd "$(dirname "$0")/.."

# The digest of the manifest list (the multi-arch index) a reference names, never one platform's.
resolve() {
    digest="$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}')"
    case "$digest" in
    sha256:????????????????????????????????????????????????????????????????) printf '%s' "$digest" ;;
    *) echo "pin-digests: no digest for $1 (got '$digest')" >&2; return 1 ;;
    esac
}

# repin <file> <old> <new>: a literal replacement, through a temp file so the mode is kept.
repin() {
    sed "s|$2|$3|" "$1" >"$1.pin"
    cat "$1.pin" >"$1"
    rm -f "$1.pin"
    echo "pin-digests: $1: $2 -> $3"
}

for file in docker/Dockerfile docker/driver.Dockerfile docker/claude-executor/Dockerfile docker/opencode-executor/Dockerfile; do
    for ref in $(grep -oE '^FROM [^ ]+@sha256:[0-9a-f]{64}' "$file" | cut -d' ' -f2 | sort -u); do
        base="${ref%@*}"
        new="$(resolve "$base")"
        [ "$new" = "${ref#*@}" ] || repin "$file" "$ref" "$base@$new"
    done
done

# The collector: repository, tag and digest are three lines of one values block.
pin="$(awk '/repository: otel\/opentelemetry-collector-contrib/ { repo = $2 }
    repo && $1 == "tag:" { tag = $2 }
    repo && $1 == "digest:" { print repo, tag, $2; exit }' charts/factory/values.yaml | tr -d "'")"
# shellcheck disable=SC2086
set -- $pin
[ "$#" -eq 3 ] || { echo 'pin-digests: the chart no longer pins a collector image and digest' >&2; exit 1; }
new="$(resolve "$1:$2")"
[ "$new" = "$3" ] || repin charts/factory/values.yaml "digest: '$3'" "digest: '$new'"
