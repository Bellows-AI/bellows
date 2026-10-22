# The agent's tool isolation (issue #814), checked in a built executor image under the driver's own
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
    agent -e T='curl -s --unix-socket /run/factory-control/control.sock -X POST -d x http://control/publish' -- \
    sh -c 'mkdir /tmp/relay && node -e "require(\"http\").createServer((q, s) => s.end(\"relayed\")).listen(\"/tmp/relay/control.sock\")" &
        sleep 1; FACTORY_CTL_OUT=/tmp/relay node /usr/local/bin/control-proxy.cjs &
        sleep 1; '"$TOOL_SHELL"' -c "$T"'

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
