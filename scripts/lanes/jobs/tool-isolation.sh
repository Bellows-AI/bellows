if selected_phase tool-isolation; then
begin_phase tool-isolation
# --- The agent's tool isolation ------------------------------------------------------
#
# The real CLIs again, now under the driver's own agent flags — root, every capability dropped but
# the launch pair, no-new-privileges — against the endpoint's `--kill-tools` mode: each of two tool
# calls runs `kill -TERM 1; kill -KILL -1` and then marks its step. The tools run as the tool uid, so
# the CLI survives both, sends its third request and exits 0 on its own. The control is the same run
# without the flags — the CLI and its tools one uid — and must die: an honest probe, so the lane can
# never pass on a tool that kills nothing.

echo
echo '# tool isolation (real agent CLIs whose tools signal everything they may)'

AGENT_FLAGS=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges)

kill_lane() { # kill_lane <claude|opencode> <isolated|control>
    local cli="$1" mode="$2" image="$1-executor" name="kill-$1-$2" fake_pid port counts status
    local dir="$work/$name"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli under the tool uid ($mode)" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs --kill-tools --tool-steps 2 >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    if [ "$mode" = isolated ]; then run+=("${AGENT_FLAGS[@]}"); fi
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$dir:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model
            -p 'touch the step markers')
    else
        run+=(-e "OPENCODE_CONFIG_CONTENT=$(lane_opencode_config "$host/v1")"
            "$image" --print-logs --log-level DEBUG run 'touch the step markers')
    fi
    lane_timed "$name" agent timeout 180 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    counts="$(node -e 'Promise.all(["/requests", "/tool-results"].map((p) => fetch(process.argv[1] + p).then((r) => r.json())))
        .then(([a, b]) => console.log(`${a.agentRequests} ${b.toolResults}`))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    if [ "$mode" = isolated ]; then
        if [ "$status" = 0 ] && [ "$counts" = '3 2' ] && [ -e "$dir/step-1" ] && [ -e "$dir/step-2" ]; then
            ok "$cli survives its tools signalling everything they may, and finishes"
        else
            bad "$cli survives its tools signalling everything they may, and finishes" \
                "exit $status, agent requests and tool results: $counts: $(tail -5 "$work/$name.log")"
        fi
    # The control dies by the tool's own signal (137 KILL, 143 TERM): a timeout's 124 is a hang.
    elif { [ "$status" = 137 ] || [ "$status" = 143 ]; } && [ "$counts" = '1 0' ] && [ ! -e "$dir/step-2" ]; then
        ok "the control: $cli and its tools as one uid, and the first tool kills it"
    else
        bad "the control: $cli and its tools as one uid, and the first tool kills it" \
            "exit $status, agent requests and tool results: $counts — a probe that kills nothing proves nothing"
    fi
}

claude_isolation_lanes() { kill_lane claude control; kill_lane claude isolated; }
opencode_isolation_lanes() { kill_lane opencode control; kill_lane opencode isolated; }
lane_pair claude_isolation_lanes opencode_isolation_lanes

# --- Skill helper scripts under the tool uid -----------------------------------------
#
# The endpoint's `--probe-files` mode: its one tool call opens every file given, as the tool uid, and
# marks `probe-<n>` open, denied or other. The files are every non-SKILL.md file under docker/skills/
# at /usr/local/share/factory-skills/ — they must open — and, last, the control: a file inside the
# CLI's private config directory (claude: the skill copy in CLAUDE_CONFIG_DIR; opencode: its data
# directory), which must be denied, so a probe that never sees a denial cannot pass. The directory is
# in its runner shape: FACTORY_TRANSCRIPT_DIR / XDG_DATA_HOME on the workspace volume, and the
# entrypoint's chmod 0700 applies.

skill_helper_lane() { # skill_helper_lane <claude|opencode>
    local cli="$1" image="$1-executor" name="skillhelper-$1" fake_pid port status counts n=0 rel
    local ws="lane-$RUN_ID-$name-ws" helpers=() probes=() control
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli runs skill helpers as the tool uid" "the $image image is missing — run make runners"
        return
    fi
    while IFS= read -r rel; do helpers+=("${rel#./}"); done < <(cd docker/skills && find . -type f ! -name SKILL.md | LC_ALL=C sort)
    [ "${#helpers[@]}" -gt 0 ] || { bad "$cli runs skill helpers as the tool uid" "no helper file under docker/skills"; return; }
    for rel in "${helpers[@]}"; do probes+=("/usr/local/share/factory-skills/$rel"); done
    if [ "$cli" = claude ]; then control="/workspace/.factory/t/skills/${helpers[0]}"; else control=/workspace/.factory/opencode/probe/opencode/opencode.db; fi
    probes+=("$control")
    # A docker volume, as the task volume is: a macOS bind mount maps every uid to the host user and
    # would never deny the control.
    docker volume create "$ws" >/dev/null
    node scripts/fake-model-endpoint.mjs --probe-files "$(IFS=,; echo "${probes[*]}")" --tool-steps 1 >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    run+=("${AGENT_FLAGS[@]}")
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$ws:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        run+=(-e FACTORY_TRANSCRIPT_DIR=/workspace/.factory/t -e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions
            --model fake-model -p 'probe the skill helpers')
    else
        run+=(-e XDG_DATA_HOME=/workspace/.factory/opencode/probe
            -e "OPENCODE_CONFIG_CONTENT=$(lane_opencode_config "$host/v1")"
            "$image" --print-logs --log-level DEBUG run 'probe the skill helpers')
    fi
    lane_timed "$name" agent timeout 180 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    local result
    result="$(node -e 'Promise.all(["/tool-results", "/requests"].map((p) => fetch(process.argv[1] + p).then((r) => r.json())))
        .then(([a, b]) => console.log(JSON.stringify({ ...a, agentRequests: b.agentRequests })))' "http://127.0.0.1:$port")"
    counts="$(node -e 'console.log(JSON.parse(process.argv[1]).toolResults)' "$result")"
    lane_endpoint_stop "$fake_pid"
    docker volume rm "$ws" >/dev/null
    local seen not_open=''
    probe_outcome() { node -e 'const m = new RegExp("^PROBE " + process.argv[2] + " (.*)$", "m").exec(JSON.parse(process.argv[1]).text); console.log(m ? m[1] : "missing")' "$result" "$1"; }
    for n in $(seq 1 "${#helpers[@]}"); do
        seen="$(probe_outcome "$n")"
        [ "$seen" = open ] || not_open="$not_open ${helpers[$((n - 1))]}=$seen"
    done
    seen="$(probe_outcome "$((${#helpers[@]} + 1))")"
    if [ "$status" = 0 ] && [ "$counts" = 1 ] && [ -z "$not_open" ]; then
        ok "$cli: every skill helper under docker/skills opens for the tool uid at its fixed path"
    else
        bad "$cli: every skill helper under docker/skills opens for the tool uid at its fixed path" \
            "exit $status, tool results $counts, not open:${not_open:- none}, result $result: $(tail -5 "$work/$name.log")"
    fi
    if [ "$seen" = denied ]; then
        ok "the control: $cli's private config directory is denied to the tool uid"
    else
        bad "the control: $cli's private config directory is denied to the tool uid" \
            "$control opened as '$seen' — a probe that never sees a denial proves nothing"
    fi
}

claude_skill_lanes() { skill_helper_lane claude; }
opencode_skill_lanes() { skill_helper_lane opencode; }
lane_pair claude_skill_lanes opencode_skill_lanes

# --- The seam between the CLI's uid and the tool uid (epic #1025: #1016) ----------
#
# The endpoint's `--steps` mode drives the real CLI through one scripted run: its own Read and Write
# tools and its Bash tool, which runs as the tool uid. What each step does and how the results are
# judged is scripts/tool-seam-lane.mjs, whose driver/test/tool-seam-lane.test.ts pins that every
# control can fail:
#   #1016  the CLI reads a 0600 mktemp file and a file in a 0700 directory the tool made in its TMPDIR;
#          control: private files in the tool's HOME and outside its TMPDIR stay closed to the CLI
#   #1021  the tool's node processes fill a compile cache of their own; control: the CLI's own cache
#          directory, which the tool cannot write, gives the same process none
#   #1023  the tool uses repositories the CLI's uid made, anywhere, and clones one; the stated
#          limit: the CLI's uid refuses every repository the tool wrote (core.fsmonitor would run as it)
#   #1024  a skill is loaded from one path with the runner's private config dir and without it, and
#          the tool reads it there; control: the CLI's private directory is closed to the tool
# The volume is a docker volume mounted twice, as the task volume is: a macOS bind mount maps every
# uid to the host user and would never refuse anything.

seam_run() { # seam_run <cli> <runner|plain> <steps json> <out json>: one scripted run on $seam_ws; its /steps answer to <out>
    local cli="$1" shape="$2" steps="$3" out="$4" image="$1-executor" name="seam-$1-$2" fake_pid port status
    node scripts/fake-model-endpoint.mjs --steps "$steps" >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    run+=("${AGENT_FLAGS[@]}")
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$seam_ws:/workspace" -v "$seam_ws:/elsewhere" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key -e "BELLOWS_GATE_URL=$(node scripts/tool-seam-lane.mjs gate-url "$cli")" -e BELLOWS_GATE_TOKEN=lane-gate-token)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        if [ "$shape" = runner ]; then run+=(-e FACTORY_TRANSCRIPT_DIR=/workspace/.factory/t); fi
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model -p 'cross the seam')
    else
        if [ "$shape" = runner ]; then run+=(-e XDG_DATA_HOME=/workspace/.factory/opencode/probe); fi
        run+=(-e "OPENCODE_CONFIG_CONTENT=$(lane_opencode_config "$host/v1")"
            "$image" --print-logs --log-level DEBUG run 'cross the seam')
    fi
    lane_timed "$name" agent timeout 240 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    node -e 'fetch(process.argv[1] + "/steps").then((r) => r.json()).then((j) => console.log(JSON.stringify(j)))' "http://127.0.0.1:$port" >"$out"
    lane_endpoint_stop "$fake_pid"
    return $status
}

seam_lane() { # seam_lane <claude|opencode>
    local cli="$1" image="$1-executor" name="seam-$1" status
    local full="$work/$name.full.json" plain="$work/$name.plain.json" git_out="$work/$name.git.txt" evidence="$work/$name.evidence.json"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli crosses the CLI/tool uid seam" "the $image image is missing — run make runners"
        return
    fi
    seam_ws="lane-$RUN_ID-$name-ws"
    docker volume create "$seam_ws" >/dev/null
    local mounts=(-v "$seam_ws:/workspace" -v "$seam_ws:/elsewhere")
    # The volume as the runner leaves it: the CLI's uid owns it, group-writable and setgid; the CLI's uid
    # makes a repository inside the trusted tree and one outside it.
    docker run --rm --user 0:0 "${mounts[@]}" -e SEAM_REPOS="$(node scripts/tool-seam-lane.mjs node-repos "$cli")" --entrypoint sh "$image" -c \
        'chown 1000:1000 /workspace && chmod 2775 /workspace && setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "$SEAM_REPOS"' \
        >"$work/$name.prep.log" 2>&1 || { bad "$cli crosses the CLI/tool uid seam" "preparing the volume failed: $(tail -3 "$work/$name.prep.log")"; docker volume rm "$seam_ws" >/dev/null; return; }
    seam_run "$cli" runner "$(node scripts/tool-seam-lane.mjs steps "$cli")" "$full"
    status=$?
    docker run --rm --user 1000:1000 "${mounts[@]}" --entrypoint sh "$image" -c "$(node scripts/tool-seam-lane.mjs node-git "$cli")" >"$git_out" 2>&1
    seam_run "$cli" plain "$(node scripts/tool-seam-lane.mjs skill-steps "$cli")" "$plain"
    docker volume rm "$seam_ws" >/dev/null
    node -e 'const fs = require("node:fs"); const [full, plain, git] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
        const a = JSON.parse(full), b = JSON.parse(plain);
        console.log(JSON.stringify({ results: a.results, skillBases: a.skillBases, plainSkillBases: b.skillBases, nodeGit: git }))' \
        "$full" "$plain" "$git_out" >"$evidence"
    if [ "$status" != 0 ]; then bad "$cli runs its scripted tools to the end" "exit $status: $(tail -5 "$work/seam-$cli-runner.log")"; fi
    local verdict_name detail mark
    while IFS=$'\t' read -r mark verdict_name detail; do
        if [ "$mark" = ok ]; then ok "$verdict_name"; else bad "$verdict_name" "$detail"; fi
    done < <(node scripts/tool-seam-lane.mjs verdict "$cli" "$evidence")
}

claude_seam_lanes() { seam_lane claude; }
opencode_seam_lanes() { seam_lane opencode; }
lane_pair claude_seam_lanes opencode_seam_lanes

fi
