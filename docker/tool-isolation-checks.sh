# The agent's tool isolation, checked in a built executor image under the driver's own
# agent flags: root, every capability dropped but the launch pair, no-new-privileges. Sourced by
# docker/claude-executor/test.sh and docker/opencode-executor/test.sh after their build, with IMAGE
# set; counts into their `pass` and `fail`.

AGENT_FLAGS=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges)
TOOL_SHELL=/usr/local/libexec/factory-tool/bash

iso_check() { # iso_check <name> <expected output> <command...>: the whole output, whitespace squeezed
    local name="$1" want="$2" got
    shift 2
    got="$("$@" 2>&1 | tr -s '\t\n ' '   ' | sed 's/ *$//')"
    if [ "$got" = "$want" ]; then
        printf 'ok   %s\n' "$name"
        pass=$((pass + 1))
    else
        printf 'FAIL %s\n     want: %s\n     got:  %s\n' "$name" "$want" "${got:0:400}"
        fail=$((fail + 1))
    fi
}

# agent [docker args...] -- <command...>: the command as the CLI's uid, behind factory-launch. The tool
# script rides T, so each check's quoting stays one level deep.
agent() {
    local args=()
    while [ "$1" != -- ]; do args+=("$1"); shift; done
    shift
    docker run --rm "${AGENT_FLAGS[@]}" "${args[@]}" --entrypoint /usr/local/bin/factory-launch "$IMAGE" "$@"
}
ID='printf "%s " "$(id)"; grep -E "^(CapPrm|CapEff|CapAmb|NoNewPrivs)" /proc/self/status'
CAPS_NONE='CapPrm: 0000000000000000 CapEff: 0000000000000000 CapAmb: 0000000000000000 NoNewPrivs: 1'

iso_check 'the CLI runs as node with no capability' \
    "uid=1000(node) gid=1000(node) groups=1000(node),1002(factory-agent) $CAPS_NONE" \
    agent -e T="$ID" -- sh -c 'eval "$T"'
iso_check 'a tool runs as factory-tool in node'"'"'s group with no capability' \
    "uid=1001(factory-tool) gid=1000(node) groups=1000(node) $CAPS_NONE" \
    agent -e T="$ID" -- sh -c "$TOOL_SHELL"' -c "$T"'
iso_check 'a tool signalling everything it may leaves the CLI side running' 'tool-ran cli-side-alive' \
    agent -e T='kill -TERM 1 2>/dev/null; kill -KILL -1 2>/dev/null; echo tool-ran' -- \
    sh -c "sleep 60 & $TOOL_SHELL"' -c "$T"; kill -0 $! && echo cli-side-alive'
iso_check 'a tool reaches neither the broker, the mailboxes nor the CLI'"'"'s environment' 'closed closed closed closed' \
    agent -e T='for p in /run/factory-tool /factory/in /factory/out; do ls "$p" >/dev/null 2>&1 || echo closed; done
        cat /proc/1/environ >/dev/null 2>&1 || echo closed' -- sh -c "$TOOL_SHELL"' -c "$T"'
# The attempt's telemetry credential is in the CLI's environment for its OTLP exporter (and, for
# opencode, in a copy under the CLI's HOME only its uid can open): a tool sees neither.
iso_check 'a tool never sees the telemetry export credential' 'unset unset closed' \
    agent -e OTEL_EXPORTER_OTLP_HEADERS=x-factory-ingest-token=probe -e OTEL_EXPORTER_OTLP_LOGS_HEADERS=x=y \
    -e T='echo "${OTEL_EXPORTER_OTLP_HEADERS-unset}" "${OTEL_EXPORTER_OTLP_LOGS_HEADERS-unset}"
        ls /home/node/.factory-otel >/dev/null 2>&1 || echo closed' -- \
    sh -c 'mkdir -m 700 -p /home/node/.factory-otel && '"$TOOL_SHELL"' -c "$T"'
iso_check 'a root-owned shared out mailbox turns sticky, and a tool cannot move the agent'"'"'s own' '1777 kept' \
    agent --tmpfs /factory/out:mode=0777 -e T='mv /factory/out/agent /factory/out/x 2>/dev/null && echo moved
        rm -rf /factory/out/agent 2>/dev/null; [ -d /factory/out/agent ] && echo kept' -- \
    sh -c 'stat -c %a /factory/out; mkdir /factory/out/agent && chmod 0700 /factory/out/agent; '"$TOOL_SHELL"' -c "$T"'
iso_check 'a tool writes a tree the CLI made and git trusts it through the CLI'"'"'s config' '?? from-tool' \
    agent -e T='cd /tmp/ws && touch from-tool && git status --porcelain' -- \
    sh -c 'mkdir /tmp/ws && cd /tmp/ws && git init -q && git config --global --add safe.directory /tmp/ws &&
        chmod 0644 "$HOME/.gitconfig" && '"$TOOL_SHELL"' -c "$T"'
iso_check 'a tool starts in a directory the CLI shares with it but the broker may not enter' '/tmp/shared 1001' \
    agent -e T='printf "%s %s" "$(pwd)" "$(id -u)"' -- \
    sh -c 'mkdir -m 0770 /tmp/shared && cd /tmp/shared && '"$TOOL_SHELL"' -c "$T"'
iso_check 'a tool reaches the run-control proxy, which forwards to the supervisor'"'"'s relay and holds no token' 'relayed' \
    agent -e T='factory-control publish' -- \
    sh -c 'mkdir /tmp/relay && node -e "require(\"http\").createServer((q, s) => s.end(\"relayed\")).listen(\"/tmp/relay/control.sock\")" &
        sleep 1; FACTORY_CTL_OUT=/tmp/relay node /usr/local/bin/control-proxy.cjs &
        sleep 1; '"$TOOL_SHELL"' -c "$T"'

# reviewer [docker args...] -- <command...>: the command as the review sidecar's uid, behind
# factory-launch --reviewer, with the HOME the driver gives it.
reviewer() {
    local args=()
    while [ "$1" != -- ]; do args+=("$1"); shift; done
    shift
    docker run --rm "${AGENT_FLAGS[@]}" --tmpfs /home/reviewer:uid=1002,gid=1000,mode=2775 -e HOME=/home/reviewer \
        "${args[@]}" --entrypoint /usr/local/bin/factory-launch "$IMAGE" --reviewer "$@"
}

iso_check 'the reviewer runs as 1002 in node'"'"'s group and the broker'"'"'s, with no capability' \
    "uid=1002 gid=1000(node) groups=1000(node),1002(factory-agent) $CAPS_NONE" \
    reviewer -e T="$ID" -- sh -c 'eval "$T"'
# The review's CLI holds the attempt lease and the telemetry credential; its tools hold neither.
iso_check 'a reviewer tool runs as the tool uid and sees no lease token and no OTLP header' \
    'cli set set set 1001 unset unset unset' \
    reviewer -e RUNNER_LEASE_TOKEN=probe -e OTEL_EXPORTER_OTLP_HEADERS=x-factory-ingest-token=probe \
    -e OTEL_EXPORTER_OTLP_LOGS_HEADERS=x=y \
    -e T='printf "%s " "$(id -u)"
        echo "${RUNNER_LEASE_TOKEN-unset}" "${OTEL_EXPORTER_OTLP_HEADERS-unset}" "${OTEL_EXPORTER_OTLP_LOGS_HEADERS-unset}"' -- \
    sh -c 'echo cli ${RUNNER_LEASE_TOKEN:+set} ${OTEL_EXPORTER_OTLP_HEADERS:+set} ${OTEL_EXPORTER_OTLP_LOGS_HEADERS:+set}
        '"$TOOL_SHELL"' -c "$T"'
iso_check 'a reviewer tool reaches neither the reviewer'"'"'s private config nor its environment' 'closed closed' \
    reviewer -e T='ls "/home/reviewer/.private" >/dev/null 2>&1 || echo closed
        cat "/proc/$R/environ" >/dev/null 2>&1 || echo closed' -- \
    sh -c 'mkdir -m 700 "$HOME/.private" && R=$$ '"$TOOL_SHELL"' -c "$T"'
# What a review's tool left past its own group — a setsid child — the sweep after the review ends; the
# reviewer, another uid, is untouched. A killed child the container's pid 1 never reaped reads Z.
iso_check 'the sweep ends what a reviewer tool left behind, and leaves the reviewer running' 'left swept reviewer-alive' \
    reviewer -e T='setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $! > "$TMPDIR/left"' -- \
    sh -c "$TOOL_SHELL"' -c "$T"; pid=$(cat /tmp/factory-tmp/left)
        state() { sed -n "s/^State:[[:space:]]*\(.\).*/\1/p" "/proc/$pid/status" 2>/dev/null; }
        [ "$(state)" = S ] && echo left
        /usr/local/bin/node /usr/local/lib/factory-tool/factory-tool.cjs sweep
        case "$(state)" in "" | Z) echo swept ;; esac
        echo reviewer-alive'

# A review's request env is member-settable: one naming SHELL or CLAUDE_CODE_SHELL must not route
# the review's tools around the broker. The real loop (driver/src/scripts/review-loop.sh) serves one
# request carrying both, the lease and the OTLP header; the review runs a tool through each shell.
# The loop's `kill -1` reaches its own uid, so the request is staged and read by `docker exec`.
REVIEW_LOOP="$(cat "$(dirname "${BASH_SOURCE[0]}")/../driver/src/scripts/review-loop.sh")"
review_request_env() {
    local cid
    cid="$(docker run -d "${AGENT_FLAGS[@]}" --tmpfs /home/reviewer:uid=1002,gid=1000,mode=2775 \
        -e HOME=/home/reviewer -e FACTORY_REVIEW_DIR=/tmp/review \
        --entrypoint /usr/local/bin/factory-launch "$IMAGE" --reviewer sh -c "$REVIEW_LOOP" review-loop)"
    docker exec -i -u 1002:1000 "$cid" sh -s <<'SETUP'
cat > /tmp/probe.sh <<'PROBE'
exec "$1" -c 'printf "%s %s %s " "$(id -u)" "${RUNNER_LEASE_TOKEN-unset}" "${OTEL_EXPORTER_OTLP_HEADERS-unset}"
    ls /home/reviewer/.private >/dev/null 2>&1 && echo open || echo closed'
PROBE
mkdir -p /tmp/stage/r1
printf '%s\n' SHELL=/bin/bash CLAUDE_CODE_SHELL=/bin/bash RUNNER_LEASE_TOKEN=probe \
    OTEL_EXPORTER_OTLP_HEADERS=x-factory-ingest-token=probe > /tmp/stage/r1/env
echo / > /tmp/stage/r1/cwd
echo 'mkdir -m 700 /home/reviewer/.private; sh /tmp/probe.sh "$SHELL"; sh /tmp/probe.sh "$CLAUDE_CODE_SHELL"' \
    > /tmp/stage/r1/command
until [ -d /tmp/review/requests ]; do sleep 0.2; done
mv /tmp/stage/r1 /tmp/review/requests/r1
SETUP
    for _ in $(seq 1 150); do
        docker exec -u 1002:1000 "$cid" test -e /tmp/review/done/r1/exit 2>/dev/null && break
        sleep 0.2
    done
    docker exec -u 1002:1000 "$cid" cat /tmp/review/done/r1/output 2>&1
    docker rm -f "$cid" >/dev/null 2>&1
}
iso_check 'a review'"'"'s request env naming its own shells still runs its tools through the broker' \
    '1001 unset unset closed 1001 unset unset closed' review_request_env

# The broker is root with two capabilities: it starts under an empty environment, so a run's own
# variables never reach it. Read from outside, as root, since no uid inside may read its environ.
broker_env() {
    local cid seen
    cid="$(docker run -d "${AGENT_FLAGS[@]}" -e NODE_OPTIONS=--require=/tmp/evil.cjs -e EVIL_MARK=1 \
        --entrypoint /usr/local/bin/factory-launch "$IMAGE" sleep 30)"
    sleep 2
    seen="$(docker exec -u 0 "$cid" sh -c 'for p in /proc/[0-9]*; do
        case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in
        "/usr/local/bin/node /usr/local/lib/factory-tool/factory-tool.cjs serve ") tr "\0" "\n" < "$p/environ" ;;
        esac
    done')"
    docker rm -f "$cid" >/dev/null 2>&1
    printf '%s\n' "$seen" | sort
}
iso_check 'the broker starts under an empty environment' \
    'NODE_DISABLE_COMPILE_CACHE=1 PATH=/usr/local/bin:/usr/bin:/bin' broker_env

# Run by hand, as the image's own user, the launcher changes nothing.
iso_check 'an image run by hand runs as before' '1000 no-broker' \
    docker run --rm --entrypoint /usr/local/bin/factory-launch "$IMAGE" sh -c \
    'printf "%s " "$(id -u)"; [ -S /run/factory-tool/broker.sock ] || echo no-broker'
