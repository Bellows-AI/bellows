#!/bin/sh
# Re-resolves every pinned image digest to what its tag points at today, rewriting the pin in place:
# the external `FROM` lines of the four Dockerfiles and the chart's collector and dockerd images. The weekly
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

# repin_chart <repository> <source>: a chart image whose repository, tag and digest are three lines of
# one values block, re-resolved through <source> (the repository as a registry serves it).
repin_chart() {
    pin="$(awk -v want="$1" '$1 == "repository:" && $2 == want { repo = $2 }
        repo && $1 == "tag:" { tag = $2 }
        repo && $1 == "digest:" { print tag, $2; exit }' charts/factory/values.yaml | tr -d "'")"
    tag="${pin% *}"
    old="${pin#* }"
    [ -n "$pin" ] && [ "$tag" != "$pin" ] || {
        echo "pin-digests: the chart no longer pins $1 by tag and digest" >&2
        exit 1
    }
    new="$(resolve "$2:$tag")"
    [ "$new" = "$old" ] || repin charts/factory/values.yaml "digest: '$old'" "digest: '$new'"
}

# The collector, and a docker class's dockerd sidecar (runner.docker.image).
repin_chart otel/opentelemetry-collector-contrib otel/opentelemetry-collector-contrib
repin_chart docker mirror.gcr.io/library/docker
