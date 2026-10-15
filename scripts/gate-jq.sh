#!/bin/sh
# Puts a jq on the gate's PATH. driver/test/pr-land-status-script.test.ts applies each `--jq` filter
# with a real jq; CI's runner ships one, the gate image (`node:24`, run as a non-root user) does not.
# `.bellows.yaml`'s setup runs this after `npm ci`, which empties node_modules, and `npm test` puts
# node_modules/.bin on PATH.
set -eu
command -v jq >/dev/null 2>&1 && exit 0
case $(uname -m) in
    x86_64 | amd64) arch=amd64 sum=5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5 ;;
    aarch64 | arm64) arch=arm64 sum=4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5 ;;
    *) echo "gate-jq: no jq build for $(uname -m)" >&2; exit 1 ;;
esac
out=node_modules/.bin/jq
curl -fsSL --retry 3 -o "$out.part" "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-$arch"
echo "$sum  $out.part" | sha256sum -c - >/dev/null
chmod +x "$out.part"
mv "$out.part" "$out"
