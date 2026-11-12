if selected_phase cooperative-stop; then
begin_phase cooperative-stop
# --- A cooperative Stop at the model-step boundary --------------------------------
#
# The real `claude` and `opencode` binaries, in the real executor images (`make runners`), against
# scripts/fake-model-endpoint.mjs: offline, deterministic, no credential. The endpoint also plays
# the driver's control endpoint and raises the Stop the moment the first model request arrives —
# inside the first step. The supervisor relays it through the mailbox, the agent's helper turns it into the marker, and the baked hook / plugin
# must end the run after that step's tool call and before a second model request: the endpoint
# counts exactly one agent request, the first step's tool ran, the second never did, and the
# container exited on its own.

echo
echo '# cooperative stop (real agent CLIs against a scripted model endpoint)'

# The driver's container group in miniature (docker-group.ts): the task supervisor, holding the
# control pair and all four mailboxes, beside an agent that mounts `in` read-only and `out` and
# nothing else. The scripted endpoint plays the driver's control endpoint; the supervisor reads the
# Stop or the question from it, and the agent's mailbox helper and bridge read what it wrote.
stop_lane() { # stop_lane <claude|opencode>
    local cli="$1" image="$1-executor" dir="$work/stop-$1" fake_pid port requests
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli stops at the step boundary" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs --first-delay-ms 3000 --tool-steps 3 >"$work/fake-$cli.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$cli.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$cli.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-stop-$cli" --add-host host.docker.internal:host-gateway)
    lane_timed "stop-$cli" setup lane_group_up "stop-$cli" "$image" "$host"
    run+=(-v "$dir:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "stop-$cli")
    if [ "$cli" = claude ]; then
        # `-p <prompt>` last: the bridge the entrypoint execs refuses any other shape, and it
        # is the shape the driver passes.
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model
            -p 'touch the step markers')
    else
        run+=(-e "OPENCODE_CONFIG_CONTENT=$(lane_opencode_config "$host/v1")"
            "$image" --print-logs --log-level DEBUG run 'touch the step markers')
    fi
    # On its own, and 0 for both CLIs: opencode's `Error: Aborted` exit after the stop plugin's abort
    # is mapped to 0 by its entrypoint (docker/opencode-executor/entrypoint.sh).
    local status
    lane_timed "stop-$cli" agent timeout 180 "${run[@]}" >"$work/stop-$cli.log" 2>&1
    status=$?
    lane_group_down "stop-$cli"
    if [ "$status" = 0 ]; then
        ok "$cli exits on its own after the stop"
    else
        bad "$cli exits on its own after the stop" "exit $status: $(tail -5 "$work/stop-$cli.log")"
    fi
    requests="$(node -e 'fetch(process.argv[1] + "/requests").then((r) => r.json()).then((j) => console.log(j.agentRequests))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    if [ "$requests" = 1 ]; then
        ok "$cli makes no model request after the stop"
    else
        bad "$cli makes no model request after the stop" "agent model requests: $requests"
    fi
    if [ -e "$dir/step-1" ] && [ ! -e "$dir/step-2" ]; then
        ok "$cli finished the step it was in and started no other"
    else
        bad "$cli finished the step it was in and started no other" "$(ls "$dir")"
    fi
}

claude_stop_lane() { stop_lane claude; }
opencode_stop_lane() { stop_lane opencode; }
lane_pair claude_stop_lane opencode_stop_lane

fi
