if selected_phase finish-gate; then
begin_phase finish-gate
# --- A red gate is repaired inside one run: board + driver + both real executor images ---------
#
# The board and the driver are the real ones, the runner images are the real claude-executor and
# opencode-executor (the publish's PR is the board's: this lane's board holds no GitHub, so it answers the
# publish's PR ask with 409 GITHUB_UNAVAILABLE and the verdict carries the push with no PR), and the model is
# the scripted endpoint in `--finish-gate` mode. The checkout
# declares one gate that passes only once `.lane-finish` exists, with a 15-minute timeout (above the
# ad-hoc gate's 10-minute cap, which the finish pass must not apply). The agent's first turn changes
# the tree without that file and ends; its finish asks the driver for the gate pass, which fails, and
# the failure comes back into the same session — claude's Stop hook blocks the stop, opencode's
# entrypoint relaunches `opencode run --session <same id>` — so the scripted model touches the file
# and finishes again. One run, no follow-up job, one failed and one passed round, and the close-time
# pass serves the gate from the finish pass that passed.

echo
echo '# finish gate (board + driver + real claude-executor and opencode-executor, scripted model)'

FG_GATE=lane-finish

fg_db() { # fg_db <sql> -> the one value it selects from this run's database
    compose exec -T -e PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' postgres psql -U factory -d "$DB" -qtA \
        -c "$1" | tr -d '\r'
}

fg_driver_tail() { # fg_driver_tail <job-id> -> the driver's last finish and gate lines for the job, for a failure message
    grep -F "$1" "$work/driver.log" | grep -i -E 'finish|gate' | tail -5 | cut -c1-300
}

# The plan is restored at the end: the phases after this one run on the origin's own plan.
fg_plan_saved="$work/finish-gate.plan"
lane_origin lane_run '
    if git -C "$1" cat-file -e main:.bellows.yaml 2>/dev/null; then git -C "$1" show main:.bellows.yaml; fi' \
    "github.com/$SMOKE_REPO.git" >"$fg_plan_saved" || {
    echo 'test-jobs: could not read the origin plan to restore'
    exit 1
}
write_bellows "environment:
    image: $IMAGE_BASE
    gates:
        - name: $FG_GATE
          command: 'test -f .lane-finish'
          timeout: 15"

# The Stop hook's configured timeout, read in the image that ships it: the pass runs as long as the
# gates do, so a hook bounded at the CLI's 600-second default would cut a slow gate short.
fg_hook_timeout="$(docker run --rm --entrypoint node claude-executor -e '
    const settings = JSON.parse(require("fs").readFileSync("/home/node/.claude/settings.json", "utf8"));
    const hook = ((settings.hooks || {}).Stop || []).flatMap((group) => group.hooks || [])
        .find((entry) => entry.type === "command" && String(entry.command).includes("finish-hook.cjs"));
    process.stdout.write(String(hook ? hook.timeout : ""));' 2>&1)"
case "$fg_hook_timeout" in
'' | *[!0-9]*) bad 'claude: the shipped Stop gate hook has a timeout above 600 s' "read '$fg_hook_timeout'" ;;
*)
    if [ "$fg_hook_timeout" -gt 600 ]; then
        ok 'claude: the shipped Stop gate hook has a timeout above 600 s'
    else
        bad 'claude: the shipped Stop gate hook has a timeout above 600 s' "timeout $fg_hook_timeout"
    fi
    ;;
esac

finish_gate_lane() { # finish_gate_lane <claude|opencode>
    local cli="$1" image="$1-executor" fake_pid fake_port id body_json passed_exec seen
    if ! docker image inspect "$cli-executor" >/dev/null 2>&1; then
        bad "$cli: a red gate is repaired inside one run" "the $cli-executor image is missing — run make runners"
        return
    fi
    stop_driver
    # Auto mode asks the model to classify a Bash call; the scripted endpoint cannot, and the call is blocked.
    RUNNER_SKIP_PERMISSIONS=1 start_driver "$image"

    node scripts/fake-model-endpoint.mjs --finish-gate >"$work/fake-finish-$cli.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-finish-$cli.port" ] && break
        sleep 0.25
    done
    fake_port="$(cat "$work/fake-finish-$cli.port")"
    if [ "$cli" = opencode ]; then
        # OPENCODE_CONFIG_CONTENT is reserved at /api/env; the claim synthesizes it from the executor row's config.
        api PUT /api/env/org '{"vars":[{"name":"ANTHROPIC_API_KEY","value":"fake-key","isSecret":true}]}' >/dev/null
        api PUT /api/workspace/executors "$(node -e 'const config = JSON.parse(process.argv[1]);
            process.stdout.write(JSON.stringify({ executors: [{ name: "claude", type: "claude-code", config: {} }, { name: "opencode", type: "opencode", config }] }));' "$(lane_opencode_config "http://host.docker.internal:$fake_port/v1")")" >/dev/null
    else
        # The org env a member would set, aimed at the scripted model (question-round-trip's point_runners_at,
        # which exists only when that phase is selected).
        api PUT /api/env/org "{\"vars\":[{\"name\":\"ANTHROPIC_API_KEY\",\"value\":\"fake-key\",\"isSecret\":true},{\"name\":\"ANTHROPIC_BASE_URL\",\"value\":\"http://host.docker.internal:$fake_port\",\"isSecret\":false}]}" >/dev/null
    fi

    id="$(create_job 'make the change, then finish' "$cli")"
    expect_contains "$cli: the task whose gate is red at its first finish ends succeeded" "$(await_settled "$id" 300)" succeeded
    body_json="$(body "$(api GET "/api/jobs/$id")")"
    expect_field "$cli: the task took one attempt" "$body_json" attempts 1
    expect_field "$cli: the thread holds one job, no follow-up" \
        "$(node -e 'try { process.stdout.write(JSON.stringify({ jobs: JSON.parse(process.argv[1]).jobs.length })); } catch { process.stdout.write("{}"); }' "$(body "$(api GET "/api/jobs/$id/thread")")")" \
        jobs 1
    expect_field "$cli: the gate record holds a failed finish run, then a passed one" \
        "{\"runs\":\"$(fg_db "select coalesce(string_agg(outcome, ',' order by seq), '') from job_gate_run where job_id = '$id' and source = 'finish' and gate = '$FG_GATE'")\"}" \
        runs failed,passed
    expect_field "$cli: the finish rounds are one failed, then one passed" \
        "{\"rounds\":\"$(fg_db "select coalesce(string_agg(verdict, ',' order by created_at), '') from job_finish_pass where job_id = '$id'")\"}" \
        rounds failed,passed
    expect_field "$cli: every gate run and round belongs to the first claim" \
        "{\"claims\":\"$(fg_db "select coalesce(string_agg(distinct run_claim_seq::text, ','), '') from (select run_claim_seq from job_gate_run where job_id = '$id' union all select run_claim_seq from job_finish_pass where job_id = '$id') r")\"}" \
        claims 1
    passed_exec="$(fg_db "select coalesce(max(execution_id::text), '') from job_gate_run where job_id = '$id' and source = 'finish' and outcome = 'passed'")"
    expect_field "$cli: the close-time pass reuses the passed finish run of $FG_GATE" \
        "$(node -e 'try { const gate = (JSON.parse(process.argv[1]).gates || []).find((g) => g.name === process.argv[2]);
            process.stdout.write(JSON.stringify({ reused: Boolean(gate && gate.status === "passed" && gate.reused && gate.reused.executionId === process.argv[3]) })); } catch { process.stdout.write("{}"); }' \
            "$body_json" "$FG_GATE" "$passed_exec")" \
        reused true
    seen="$(curl -s --max-time 5 "http://127.0.0.1:$fake_port/finish-gate")"
    if node -e 'const r = JSON.parse(process.argv[1]); const [f] = r.failures;
        process.exit(r.failures.length === 1 && f.gate === process.argv[2] && f.round === 1 && f.sameSession ? 0 : 1)' "$seen" "$FG_GATE" 2>/dev/null; then
        ok "$cli: the gate failure reached the same session as its next turn, once"
    else
        bad "$cli: the gate failure reached the same session as its next turn, once" "endpoint: $seen; driver: $(fg_driver_tail "$id")"
    fi
    lane_endpoint_stop "$fake_pid"
    if [ "$cli" = opencode ]; then
        api PUT /api/workspace/executors '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}' >/dev/null
    fi
    stop_driver
    docker image rm -f "$image" >/dev/null 2>&1
}

# Serial, not lane_pair: both cases share this phase's one board, its org env and its driver.
finish_gate_lane claude

finish_gate_lane opencode

write_bellows "$(cat "$fg_plan_saved")"

fi
