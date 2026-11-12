if selected_phase ask-user-question; then
begin_phase ask-user-question
# --- AskUserQuestion answered inside the same Claude run (issue #226) ----------------------------
#
# The real claude-executor image against the same scripted endpoint in `--ask` mode. The model's
# first reply is an AskUserQuestion tool call; the bridge POSTs it to the endpoint's /question,
# polls until it answers "Blue", and hands the answer back into the SAME CLI process, whose next
# model request carries it. The run ends 0 with `ANSWER=Blue` in the progress output and exactly
# one question POST recorded.

echo
echo '# AskUserQuestion (real claude CLI, answered through the bridge)'

#
# The prose mode (`--ask-prose`) starts from a plain-text question ending the turn: the baked Stop
# hook must turn it into the same AskUserQuestion, inside the same run.

ask_lane() {
    local mode="$1" flag="$2" image=claude-executor fake_pid port posts hooks
    local dir="$work/ask-claude-$mode" log="$work/ask-claude-$mode.log" portfile="$work/fake-ask-$mode.port"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "claude asks and receives an answer ($mode)" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs "$flag" >"$portfile" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$portfile" ] && break
        sleep 0.25
    done
    port="$(cat "$portfile")"
    local host="http://host.docker.internal:$port" agent_words=() word
    lane_timed "ask-$mode" setup lane_group_up "ask-$mode" "$image" "$host"
    while IFS= read -r word; do agent_words+=("$word"); done < <(lane_group_agent_args "ask-$mode")
    if lane_timed "ask-$mode" agent timeout 180 docker run --rm --name "lane-agent-$RUN_ID-ask-$mode" --add-host host.docker.internal:host-gateway -v "$dir:/workspace" -e WORKDIR=/workspace \
        -e ANTHROPIC_API_KEY=fake-key -e "ANTHROPIC_BASE_URL=$host" "${agent_words[@]}" \
        "$image" --dangerously-skip-permissions --model fake-model -p 'ask which colour' >"$log" 2>&1; then
        ok "claude exits 0 after the question is answered ($mode)"
    else
        bad "claude exits 0 after the question is answered ($mode)" "$(tail -5 "$log")"
    fi
    lane_group_down "ask-$mode"
    posts="$(node -e 'fetch(process.argv[1] + "/questions").then((r) => r.json()).then((j) => console.log(j.questionPosts))' "http://127.0.0.1:$port")"
    hooks="$(node -e 'fetch(process.argv[1] + "/hooks").then((r) => r.json()).then((j) => console.log(j.hookRequests))' "http://127.0.0.1:$port")"
    # The tail of every agent request, kept on every run (copied to artifacts/jobs/ at exit) so a rare miss shows what the CLI sent.
    node -e 'fetch(process.argv[1] + "/asks").then((r) => r.text()).then((t) => process.stdout.write(t))' "http://127.0.0.1:$port" >"$work/ask-$mode.requests.json" 2>/dev/null
    lane_endpoint_stop "$fake_pid"
    if grep 'ANSWER=Blue' "$log" >/dev/null; then
        ok "the answer reaches the same run (ANSWER=Blue in the progress output, $mode)"
    else
        bad "the answer reaches the same run (ANSWER=Blue in the progress output, $mode)" "$(tail -5 "$log"); request tails: ask-$mode.requests.json in the run's artifacts"
    fi
    if [ "$posts" = 1 ]; then
        ok "exactly one question was posted ($mode)"
    else
        bad "exactly one question was posted ($mode)" "question POSTs: $posts"
    fi
    if [ "$mode" = prose ]; then
        # The block, then the allowed stop after the answer (stop_hook_active): two evaluations.
        if [ "$hooks" = 2 ]; then
            ok 'the Stop hook turned the prose question into AskUserQuestion (prose)'
        else
            bad 'the Stop hook turned the prose question into AskUserQuestion (prose)' "Stop-hook evaluations: $hooks"
        fi
    fi
}

tool_ask_lane() { ask_lane tool --ask; }
prose_ask_lane() { ask_lane prose --ask-prose; }
lane_pair tool_ask_lane prose_ask_lane

fi
