#!/usr/bin/env bash
# Build the image and exercise it against this repo as the mounted checkout.
#
#   docker/claude-executor/test.sh
#
# Offline by default: no token, no network beyond the build. With
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment it also runs one real prompt.
set -uo pipefail

IMAGE="${IMAGE:-claude-executor-test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

pass=0
fail=0

check() { # check <name> <expected substring> <docker args...>
    local name="$1" want="$2"
    shift 2
    local got
    got="$("$@" 2>&1)"
    if [[ "$got" == *"$want"* ]]; then
        printf 'ok   %s\n' "$name"
        pass=$((pass + 1))
    else
        printf 'FAIL %s\n     want substring: %s\n     got: %s\n' "$name" "$want" "${got:0:400}"
        fail=$((fail + 1))
    fi
}

echo "building $IMAGE"
docker build -q --build-context skills="$HERE/../skills" --build-context common="$HERE/../executor-common" -t "$IMAGE" "$HERE" >/dev/null || { echo "build failed"; exit 1; }

run() { docker run --rm -v "$REPO:/workspace" "$@"; }

check 'claude runs'            'Claude Code'      run --entrypoint claude "$IMAGE" --version
check 'acli installed'         'acli version'     run --entrypoint acli "$IMAGE" --version
check 'gh installed'           'gh version'       run --entrypoint gh "$IMAGE" --version
# No plugin (issue #841): context-mode's executions cannot run as the tool uid yet.
check 'no plugin installed'    'No plugins installed' run --entrypoint claude "$IMAGE" plugin list
check 'CLAUDE.md present'      'Agent guide'      run --entrypoint head "$IMAGE" -1 /home/node/.claude/CLAUDE.md
check 'skills present'         'factory-fix'      run --entrypoint ls "$IMAGE" /usr/local/share/factory-skills
check 'every built-in skill is under factory-' 'ok' run --entrypoint sh "$IMAGE" -c 'for s in /usr/local/share/factory-skills/*/; do case "$(basename "$s")" in factory-*) ;; *) echo "bad:$s"; exit 1;; esac; done; echo ok'

# The entrypoint's own contract: land in $WORKDIR, refuse a missing one.
check 'defaults to /workspace' '/workspace'       run --entrypoint sh "$IMAGE" -c 'pwd'
check 'honours WORKDIR'        '/workspace/server' run -e WORKDIR=/workspace/server --entrypoint sh "$IMAGE" -c \
    'cd "$WORKDIR" && pwd'
check 'rejects bad WORKDIR'    'does not exist'   run -e WORKDIR=/nope "$IMAGE" --version

# A prompt an unattended container cannot answer, settled at build time.
check 'onboarding done'   'true'  run --entrypoint node "$IMAGE" -e \
    'console.log(require(process.env.CLAUDE_CONFIG_DIR + "/.claude.json").hasCompletedOnboarding)'

# Managed settings outrank every scope the agent can reach, so the agent's uid must not be able to
# rewrite them (issue #452): baked root-owned, and replaced by the driver root-owned again. The
# driver's delivery is reproduced exactly — create, `docker cp -` of the archive
# driver/src/telemetry-config.ts renders (uid 0, mode 0444), start attached.
check 'managed settings are not writable by the runtime user' 'ok' run --entrypoint sh "$IMAGE" -c \
    'f=/etc/claude-code/managed-settings.json; [ ! -w "$f" ] && [ ! -w "${f%/*}" ] && [ "$(stat -c %u:%g "$f")" = 0:0 ] && echo ok'

managed_tar() { # managed_tar <endpoint>: the driver's own archive, rendered by its own code
    (cd "$REPO" && ENDPOINT="$1" npx --no-install tsx -e \
        "import { telemetryConfig, telemetryConfigTar } from './driver/src/telemetry-config.ts'; process.stdout.write(telemetryConfigTar(telemetryConfig('claude-code', process.env.ENDPOINT)));")
}
run_rendered() { # run_rendered <endpoint> <docker create args...>
    local endpoint="$1" id status
    shift
    id="$(docker create --cap-drop ALL --security-opt no-new-privileges "$@")" || return 1
    managed_tar "$endpoint" | docker cp - "$id:/etc" || { docker rm -f "$id" >/dev/null; return 1; }
    docker start -a "$id"
    status=$?
    docker rm -f "$id" >/dev/null
    return "$status"
}

check 'the driver-rendered managed settings carry its endpoint, root-owned and read-only' \
    'http://collector.example:4318 0:0 ro' run_rendered http://collector.example:4318 \
    -v "$REPO:/workspace" --entrypoint sh "$IMAGE" -c \
    'f=/etc/claude-code/managed-settings.json; node -p "require(\"$f\").env.OTEL_EXPORTER_OTLP_ENDPOINT" | tr "\n" " "; printf "%s " "$(stat -c %u:%g "$f")"; if (: >> "$f") 2>/dev/null; then echo rw; else echo ro; fi'

# The checkout's own .claude/settings.json must not steer telemetry. A target repo that points
# OTEL_EXPORTER_OTLP_ENDPOINT at 127.0.0.1:4318 for host development used to win over the runner's
# user-scope value, so every export went to the container's loopback and was lost without a word.
# Proved against the real CLI: two sinks inside the container, the checkout pointing at one, the
# driver's endpoint at the other. The CLI exports its startup metrics even unauthenticated, so no
# credential is needed; only the forwarded endpoint may receive anything.
CHECKOUT="$(mktemp -d)"
mkdir -p "$CHECKOUT/.claude"
printf '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"http://127.0.0.1:4318"}}\n' > "$CHECKOUT/.claude/settings.json"
chmod -R a+rwX "$CHECKOUT"
SINK='for (const p of [4318, 4999]) require("http").createServer((q, r) => { console.log("SINK:" + p); q.resume(); q.on("end", () => r.end("{}")); }).listen(p)'
sinks="$(run_rendered http://127.0.0.1:4999 \
    -v "$CHECKOUT:/workspace" \
    --entrypoint sh "$IMAGE" -c "node -e '$SINK' & sleep 1; timeout 30 claude-executor -p hello >/dev/null 2>&1; sleep 12" 2>&1)"
rm -rf "$CHECKOUT"
if [[ "$sinks" == *"SINK:4999"* && "$sinks" != *"SINK:4318"* ]]; then
    printf 'ok   %s\n' "the checkout's .claude/settings.json cannot redirect telemetry"
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     sinks: %s\n' "the checkout's .claude/settings.json cannot redirect telemetry" "${sinks:0:400}"
    fail=$((fail + 1))
fi

# An empty CLAUDE_CONFIG_DIR — the transcript store's per-thread directory, or a volume mounted over
# the baked configuration — hides everything baked. Seeding is therefore load-bearing, not a nicety.
# The seed source /opt/claude-home is a symlink to the baked home (#401), so a volume mounted OVER
# /home/node/.claude hides it; the supported shape points CLAUDE_CONFIG_DIR at the empty directory.
VOL="$(mktemp -d)"
chmod 777 "$VOL"
check 'seeds an empty volume' 'CLAUDE.md' docker run --rm -v "$VOL:/cfg" -e CLAUDE_CONFIG_DIR=/cfg \
    --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1; ls "$CLAUDE_CONFIG_DIR"'
# The listing view (BEL-286): the managed skills path links to /tmp/.factory-skills, which every start rebuilds from
# FACTORY_HIDDEN_SKILLS. A hidden skill has no entry there, so the CLI never lists it (a Skill() deny only refuses the call).
check 'the managed skills path lists every baked skill when nothing is hidden' 'factory-jira' docker run --rm --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null 2>&1; ls /etc/claude-code/.claude/skills'
check 'a hidden built-in has no entry in the view, the others keep theirs' 'ok' docker run --rm -e FACTORY_HIDDEN_SKILLS=factory-jira --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null 2>&1; ls /etc/claude-code/.claude/skills | grep factory-fix >/dev/null && ! ls /etc/claude-code/.claude/skills | grep factory-jira >/dev/null && echo ok'
check 'the view is not writable by the tool uid, nor movable' 'ok' docker run --rm --user 0:0 -e FACTORY_HIDDEN_SKILLS=factory-jira --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null 2>&1; as_tool() { setpriv --reuid=1001 --regid=1000 --clear-groups "$@"; }; ! as_tool touch /tmp/.factory-skills/x 2>/dev/null && ! as_tool mv /tmp/.factory-skills /tmp/.fs2 2>/dev/null && echo ok'
check 'a malformed hidden list ends the run before the CLI (exit 78)' 'exit 78' docker run --rm -e 'FACTORY_HIDDEN_SKILLS=bad name' --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null 2>&1; echo "exit $?"'
check 'a view that is a symlink is refused (exit 78)' 'exit 78' docker run --rm -e FACTORY_HIDDEN_SKILLS= --entrypoint sh "$IMAGE" -c \
    'ln -s /etc /tmp/.factory-skills; claude-executor --version >/dev/null 2>&1; echo "exit $?"'

# The skills are managed (issue #1024): read from the one path the tool uid can read, never copied
# into the seeded volume, where the CLI would load the private-dir copy first.
check 'the seeded volume carries no copy of the baked skills' 'ok' docker run --rm -v "$VOL:/cfg" -e CLAUDE_CONFIG_DIR=/cfg \
    --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1; test ! -e "$CLAUDE_CONFIG_DIR"/skills/factory-fix && ls /etc/claude-code/.claude/skills | grep factory-fix >/dev/null && echo ok'
check 'seeding is idempotent' 'ok' docker run --rm -v "$VOL:/cfg" -e CLAUDE_CONFIG_DIR=/cfg \
    --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1; echo marker > "$CLAUDE_CONFIG_DIR"/keep; claude-executor -p seed >/dev/null 2>&1; [ -f "$CLAUDE_CONFIG_DIR"/keep ] && echo ok'
# The seed runs once; the hooks block is re-laid on every start, so an agent that emptied it in the
# thread's settings.json cannot disarm the baked hooks for later runs, while an unrelated key
# the thread wrote survives. An unparseable file is replaced by the baked copy.
check 'a stripped hooks block is restored, other keys kept' 'ok' docker run --rm -v "$VOL:/cfg" -e CLAUDE_CONFIG_DIR=/cfg \
    --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1
        echo "{\"hooks\":{},\"model\":\"keep-me\"}" > "$CLAUDE_CONFIG_DIR"/settings.json
        claude-executor -p seed >/dev/null 2>&1
        grep -q stop-hook.cjs "$CLAUDE_CONFIG_DIR"/settings.json && grep -q keep-me "$CLAUDE_CONFIG_DIR"/settings.json && echo ok'
check 'an unparseable settings.json is replaced by the baked copy' 'ok' docker run --rm -v "$VOL:/cfg" -e CLAUDE_CONFIG_DIR=/cfg \
    --entrypoint sh "$IMAGE" -c 'echo "{broken" > "$CLAUDE_CONFIG_DIR"/settings.json
        claude-executor -p seed >/dev/null 2>&1
        grep -q stop-hook.cjs "$CLAUDE_CONFIG_DIR"/settings.json && echo ok'
rm -rf "$VOL"

# A bind mount carries the host uid, so without safe.directory git refuses the repository outright.
# Note the single line: a backslash continuation inside single quotes is a literal backslash, not a
# continuation, and the container would receive a broken script that fails silently.
# The mount is a scratch repository, not $REPO: in a git worktree $REPO/.git is a file pointing outside
# the mount, which no container could read.
GITMNT="$(mktemp -d)"
git -C "$GITMNT" init -q
check 'git reads the mount' 'true' docker run --rm -v "$GITMNT:/workspace" --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1; git rev-parse --is-inside-work-tree'
rm -rf "$GITMNT"

# The login refusal is an assertion in its own right, and the only one that proves no credential
# was baked into the image. It runs whether or not a token is available, with the token withheld.
check 'unauthenticated by design' 'Not logged in' run "$IMAGE" -p 'hello'

# Fall back to the repo's .env for the live prompt, reading only that one key.
token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [[ -z "$token" && -f "$REPO/.env" ]]; then
    token="$(grep -m1 -E '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=' "$REPO/.env" | cut -d= -f2- | tr -d '"'\''' | xargs)"
fi

if [[ -n "${token}${ANTHROPIC_API_KEY:-}" ]]; then
    check 'answers a prompt' 'EXECUTOR_OK' \
        run -e CLAUDE_CODE_OAUTH_TOKEN="$token" -e ANTHROPIC_API_KEY "$IMAGE" \
        -p 'Reply with exactly EXECUTOR_OK and nothing else.'
else
    echo 'note: no token in the environment or .env — skipped the live prompt'
fi

# The member's own executor config (CLAUDE_CODE_CONFIG_CONTENT, #212): model and env additions
# merge into the baked settings.json, but a member cannot use it to strip the runner's hooks/
# plugins fence. Telemetry keys a member sets land in user scope and lose to managed settings, so
# the merge never touches managed-settings.json.
CNF="$(mktemp -d)"
cp "$HERE/claude-home/settings.json" "$CNF/settings.json"
printf '{"hasCompletedOnboarding":true,"theme":"dark"}\n' > "$CNF/.claude.json"
chmod -R a+rwX "$CNF"
MEMBER_CONFIG='{"model":"claude-member-model","hooks":{"PreToolUse":[]},"enabledPlugins":["evil"],"extraKnownMarketplaces":["evil"],"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_LOG_USER_PROMPTS":"1","OTEL_EXPORTER_OTLP_ENDPOINT":"http://member-supplied:4318","ANTHROPIC_API_KEY":"member-token"}}'
docker run --rm \
    -e CLAUDE_CONFIG_DIR=/claude-member-test \
    -e CLAUDE_CODE_CONFIG_CONTENT="$MEMBER_CONFIG" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
    -v "$CNF:/claude-member-test" \
    -v "$REPO:/workspace" \
    --entrypoint sh "$IMAGE" -c 'claude-executor -p seed >/dev/null 2>&1; cp /etc/claude-code/managed-settings.json "$CLAUDE_CONFIG_DIR/managed.out"'
patched="$(cat "$CNF/settings.json")"
managed="$(cat "$CNF/managed.out")"
rm -rf "$CNF"
if node -e '
    const c = JSON.parse(process.argv[1]);
    const m = JSON.parse(process.argv[3]);
    const ok =
        c.model === "claude-member-model" &&
        c.env.ANTHROPIC_API_KEY === "member-token" &&
        c.enabledPlugins === undefined &&
        c.extraKnownMarketplaces === undefined &&
        JSON.stringify(c.hooks) ===
            JSON.stringify(require(process.argv[2]).hooks).replace("__FACTORY_RUN_MODEL__", "claude-member-model") &&
        m.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1" &&
        m.env.OTEL_LOG_USER_PROMPTS === "0" &&
        m.env.OTEL_EXPORTER_OTLP_ENDPOINT === "http://collector:4318";
    process.exit(ok ? 0 : 1);
' "$patched" "$HERE/claude-home/settings.json" "$managed" >/dev/null 2>&1; then
    printf 'ok   %s\n' 'CLAUDE_CODE_CONFIG_CONTENT merges member settings without touching managed telemetry, hooks or plugins'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     patched settings: %s\n     managed: %s\n' 'CLAUDE_CODE_CONFIG_CONTENT merges member settings without touching managed telemetry, hooks or plugins' "$patched" "$managed"
    fail=$((fail + 1))
fi

# Tools agents reach for in repo scripts (issue #1022).
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v python3 && command -v pgrep && command -v pkill && command -v ps' >/dev/null 2>&1; then
    printf 'ok   %s\n' 'python3, ps, pgrep and pkill are on PATH'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n' 'python3, ps, pgrep and pkill are on PATH'
    fail=$((fail + 1))
fi

# Repo skills (BEL-270), measured with the real CLI against the scripted model endpoint: the Skill tool's
# "Base directory" line says which file the CLI loaded. With the managed settings and
# CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 in place, a checkout's .claude/skills/<name> is loaded; on a name
# clash the MANAGED (baked) skill is the one that loads, so a repo cannot shadow a built-in at runtime.
skill_ws="$(mktemp -d)"
for s in probe-repo factory-fix probe-ws; do
    mkdir -p "$skill_ws/.claude/skills/$s"
    printf -- '---\nname: %s\ndescription: repo copy of %s\n---\nrepo body\n' "$s" "$s" >"$skill_ws/.claude/skills/$s/SKILL.md"
done
chmod -R a+rX "$skill_ws"
skill_env=()
skill_mounts=() # extra `docker run` args and CLI args of skill_base, set by the delivery check below
skill_args=()
skill_base() { # skill_base <skill>: where the CLI loaded <skill> from, with the checkout mounted at /workspace
    local out port pid base
    out="$(mktemp)"
    node "$REPO/scripts/fake-model-endpoint.mjs" --steps "[{\"tool\":\"Skill\",\"input\":{\"skill\":\"$1\"}}]" >"$out" &
    pid=$!
    for _ in $(seq 1 40); do [ -s "$out" ] && break; sleep 0.25; done
    port="$(cat "$out")"
    env -u CLAUDE_CODE_OAUTH_TOKEN docker run --rm --add-host host.docker.internal:host-gateway -v "$skill_ws:/workspace" \
        ${skill_mounts[@]+"${skill_mounts[@]}"} ${skill_env[@]+"${skill_env[@]}"} \
        -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key -e "ANTHROPIC_BASE_URL=http://host.docker.internal:$port" \
        "$IMAGE" --dangerously-skip-permissions --model fake-model ${skill_args[@]+"${skill_args[@]}"} -p probe >/dev/null 2>&1
    base="$(node -e 'fetch(process.argv[1] + "/steps").then((r) => r.json()).then((j) => console.log(j.skillBases.join(" ")))' "http://127.0.0.1:$port")"
    kill "$pid" 2>/dev/null
    rm -f "$out"
    printf '%s' "$base"
}
got="$(skill_base probe-repo)"
if [ "$got" = /workspace/.claude/skills/probe-repo ]; then
    printf 'ok   %s\n' "a checkout's .claude/skills skill is loaded with the managed settings in place"
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     got: %s\n' "a checkout's .claude/skills skill is loaded with the managed settings in place" "$got"
    fail=$((fail + 1))
fi
got="$(skill_base factory-fix)"
if [ "$got" = /etc/claude-code/.claude/skills/factory-fix ]; then
    printf 'ok   %s\n' 'a repo skill named like a built-in loses to the managed built-in'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     got: %s\n' 'a repo skill named like a built-in loses to the managed built-in' "$got"
    fail=$((fail + 1))
fi
# Pinned org and workspace skills (BEL-273): the driver installs them root-owned (0755/0644) under the task volume at
# /task/.factory/skills-root/.claude/skills and starts the CLI with `--add-dir /task/.factory/skills-root` (the plan
# in driver/src/runner-plan.ts). The CLI loads the skill from there, through the image's real entrypoint and bridge.
# `--add-dir` ranks below a checkout's own skill of the same name, so a WORKSPACE skill is also named in
# FACTORY_WORKSPACE_SKILLS (BEL-289): the entrypoint links it into the managed view, which outranks the checkout.
task_vol="$(mktemp -d)"
mkdir -p "$task_vol/.factory/skills-root/.claude/skills/probe-org"
printf -- '---\nname: probe-org\ndescription: pinned org skill\n---\norg body\n' >"$task_vol/.factory/skills-root/.claude/skills/probe-org/SKILL.md"
chmod -R a+rX "$task_vol"
skill_mounts=(-v "$task_vol:/task:ro")
skill_args=(--add-dir /task/.factory/skills-root)
got="$(skill_base probe-org)"
if [ "$got" = /task/.factory/skills-root/.claude/skills/probe-org ]; then
    printf 'ok   %s\n' 'a pinned skill installed under the task volume is loaded through --add-dir'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     got: %s\n' 'a pinned skill installed under the task volume is loaded through --add-dir' "$got"
    fail=$((fail + 1))
fi
skill_mounts=()
skill_args=()
# A workspace skill whose name a checkout skill also has: the workspace copy loads, from the managed path.
mkdir -p "$task_vol/.factory/skills-root/.claude/skills/probe-ws"
printf -- '---\nname: probe-ws\ndescription: pinned workspace skill\n---\nworkspace body\n' >"$task_vol/.factory/skills-root/.claude/skills/probe-ws/SKILL.md"
chmod -R a+rX "$task_vol"
skill_mounts=(-v "$task_vol:/task:ro")
skill_args=(--add-dir /task/.factory/skills-root)
skill_env=(-e FACTORY_WORKSPACE_SKILLS=probe-ws -e FACTORY_SKILLS_PATH=/task/.factory/skills-root/.claude/skills)
got="$(skill_base probe-ws)"
if [ "$got" = /etc/claude-code/.claude/skills/probe-ws ]; then
    printf 'ok   %s\n' 'a pinned workspace skill wins over a same-name checkout skill'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     got: %s\n' 'a pinned workspace skill wins over a same-name checkout skill' "$got"
    fail=$((fail + 1))
fi
skill_mounts=()
skill_args=()
skill_env=()
rm -rf "$task_vol"
rm -rf "$skill_ws"

# The agent's tool isolation (issue #814), the same checks in both images.
# shellcheck source=../tool-isolation-checks.sh
. "$HERE/../tool-isolation-checks.sh"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
