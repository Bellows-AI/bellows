if selected_phase repo-skills; then
begin_phase repo-skills
# --- A repo's own skill reaches the agent on both runtimes ---------------------------------
#
# The board accepts a skill the checkout ships (<checkout>/.claude/skills/<name>/SKILL.md); only the
# real CLIs can say whether they then offer it to the model. The endpoint's `--skill-sentinel` mode
# reports whether any agent request carried a sentinel that appears only in that skill's description.
# The control is the same run on a checkout without the skill: a probe that sees the sentinel anyway
# proves nothing. The image tests pin the same discovery (docker/<executor>/test.sh); kubernetes runs
# these images unchanged, so this phase is its proof too (docs/jobs.md).

echo
echo '# repo skills (real agent CLIs on a checkout that ships lane-repo-skill under .claude/skills or .opencode/skills)'

REPO_SKILL_SENTINEL=LANE_REPO_SKILL_SENTINEL_4c1d

repo_skill_lane() { # repo_skill_lane <claude|opencode> <with|without> [skills dir under the checkout] [seen|unseen]
    local cli="$1" mode="$2" dir="${3:-.claude/skills}" expect="${4:-seen}" image="$1-executor" name="reposkill-$1-$2" fake_pid port status seen
    local top="${dir%%/*}"
    [ "$dir" = .claude/skills ] || name="$name-${top#.}"
    local ws="lane-$RUN_ID-$name-ws"
    local flags=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli sees a repo skill ($mode)" "the $image image is missing — run make runners"
        return
    fi
    docker volume create "$ws" >/dev/null
    if [ "$mode" = with ]; then
        docker run --rm -v "$ws:/workspace" --entrypoint sh "$image" -c \
            "mkdir -p /workspace/$dir/lane-repo-skill && printf '%s\n' '---' 'name: lane-repo-skill' \
'description: Lane fixture skill $REPO_SKILL_SENTINEL — use it never.' '---' 'Nothing to do.' \
>/workspace/$dir/lane-repo-skill/SKILL.md && chmod -R a+rX /workspace/$top" >/dev/null
    fi
    node scripts/fake-model-endpoint.mjs --skill-sentinel "$REPO_SKILL_SENTINEL" --tool-steps 1 >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    run+=("${flags[@]}")
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$ws:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        run+=(-e FACTORY_TRANSCRIPT_DIR=/workspace/.factory/t -e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions
            --model fake-model -p 'list your skills')
    else
        run+=(-e XDG_DATA_HOME=/workspace/.factory/opencode/probe
            -e "OPENCODE_CONFIG_CONTENT=$(lane_opencode_config "$host/v1")"
            "$image" --print-logs --log-level DEBUG run 'list your skills')
    fi
    lane_timed "$name" agent timeout 180 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    seen="$(node -e 'fetch(process.argv[1] + "/skills-seen").then((r) => r.json()).then((a) => console.log(a.agentRequests > 0 ? a.seen : "no-requests"))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    docker volume rm "$ws" >/dev/null
    if [ "$mode" = with ] && [ "$expect" = unseen ]; then
        # The negative half of the catalog's per-executor dirs: a CLI that does not scan the folder never offers it.
        if [ "$status" = 0 ] && [ "$seen" = false ]; then
            ok "$cli: a skill only under the checkout's $dir never reaches the model"
        else
            bad "$cli: a skill only under the checkout's $dir never reaches the model" "exit $status, sentinel seen '$seen': $(tail -5 "$work/$name.log")"
        fi
    elif [ "$mode" = with ]; then
        if [ "$status" = 0 ] && [ "$seen" = true ]; then
            ok "$cli: a skill under the checkout's $dir reaches the model"
        else
            bad "$cli: a skill under the checkout's $dir reaches the model" "exit $status, sentinel seen '$seen': $(tail -5 "$work/$name.log")"
        fi
    elif [ "$status" = 0 ] && [ "$seen" = false ]; then
        ok "the control: $cli on a checkout without the skill never carries its sentinel"
    else
        bad "the control: $cli on a checkout without the skill never carries its sentinel" "exit $status, sentinel seen '$seen' — a probe that always sees it proves nothing"
    fi
}

# Each CLI scans its own folders (checkoutSkillDirsOf in core/src/executors.ts): opencode also reads
# .opencode/skills, claude does not. These two runs pass without the board fix; the server tests carry the red.
claude_repo_skill_lanes() { repo_skill_lane claude with; repo_skill_lane claude without; repo_skill_lane claude with .opencode/skills unseen; }
opencode_repo_skill_lanes() { repo_skill_lane opencode with; repo_skill_lane opencode without; repo_skill_lane opencode with .opencode/skills seen; }
lane_pair claude_repo_skill_lanes opencode_repo_skill_lanes

fi
