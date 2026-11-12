if selected_phase question-round-trip; then
begin_phase question-round-trip
# --- The question round trip: board + driver + the real claude-executor -------------
#
# The board and the driver are the real ones. The model is the scripted endpoint in `--ask` mode,
# reached through the org env a member would configure, so the real claude CLI inside the real
# claude-executor image asks, the bridge POSTs the question to the DRIVER's control endpoint, the
# driver relays it to the board, and a member's answer travels back on the heartbeat. First case:
# the job shows a pending question, a member answers, the job settles succeeded with ANSWER=Blue,
# and a second answer is refused. Second case: stopped while pending, the job settles stopped and
# the question reads closed.

echo
echo '# question round trip (board + driver + real claude-executor, scripted model)'

pending_question() { # pending_question <job-id> -> the pending question's id, empty when none
    node -e 'try { const j = JSON.parse(process.argv[1]); const q = (j.questions || []).find((x) => x.status === "pending"); process.stdout.write(q ? q.id : ""); } catch {}' \
        "$(body "$(api GET "/api/jobs/$1")")"
}

await_pending_question() { # await_pending_question <job-id> [seconds] -> the question id, empty on timeout
    local qid="" i=0
    while [ "$i" -lt "${2:-120}" ]; do
        qid="$(pending_question "$1")"
        [ -n "$qid" ] && break
        sleep 1
        i=$((i + 1))
    done
    printf '%s' "$qid"
}

start_ask_endpoint() { # start_ask_endpoint <name> -> sets ask_pid and ask_port
    node scripts/fake-model-endpoint.mjs --ask >"$work/fake-$1.port" &
    ask_pid=$!
    lane_endpoint_started "$ask_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$1.port" ] && break
        sleep 0.25
    done
    ask_port="$(cat "$work/fake-$1.port")"
}

point_runners_at() { # point_runners_at <port>: the org env a member would set, aimed at the scripted model
    api PUT /api/env/org "{\"vars\":[{\"name\":\"ANTHROPIC_API_KEY\",\"value\":\"fake-key\",\"isSecret\":true},{\"name\":\"ANTHROPIC_BASE_URL\",\"value\":\"http://host.docker.internal:$1\",\"isSecret\":false}]}" >/dev/null
}

ask_roundtrip_lane() {
    local image=claude-executor ask_pid ask_port id qid answer answered done_job
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad 'a member answers the agent through the board' "the $image image is missing — run make runners"
        return
    fi
    stop_driver
    start_driver "$image"

    start_ask_endpoint answer
    point_runners_at "$ask_port"
    id="$(create_job 'ask which colour')"
    qid="$(await_pending_question "$id")"
    if [ -n "$qid" ]; then
        ok 'the board shows the question as pending'
    else
        bad 'the board shows the question as pending' "$(tail -5 "$work/driver.log")"
    fi
    answer="{\"answers\":{\"Which colour should the report use?\":\"Blue\"}}"
    expect_status 'a member answers the question' 200 POST "/api/jobs/$id/questions/$qid/answer" "$answer"
    done_job="$(await_settled "$id" 180)"
    expect_contains 'the job settles succeeded' "$done_job" succeeded
    answered="$(body "$(api GET "/api/jobs/$id")")"
    expect_contains 'the answer reached the same run (ANSWER=Blue)' "$(field "$answered" output)" 'ANSWER=Blue'
    answered="$(api POST "/api/jobs/$id/questions/$qid/answer" "$answer")"
    expect_status 'a second answer is refused' 409 POST "/api/jobs/$id/questions/$qid/answer" "$answer"
    expect_contains 'the refusal names the answered question' "$answered" 'QUESTION_ANSWERED'
    lane_endpoint_stop "$ask_pid"

    # Stop while pending: the question is cancelled, the CLI interrupted, the job parked stopped.
    start_ask_endpoint stop
    point_runners_at "$ask_port"
    id="$(create_job 'ask which colour, then be stopped')"
    qid="$(await_pending_question "$id")"
    expect_status 'a pending job can be asked to stop' 202 POST "/api/jobs/$id/stop"
    expect_contains 'the job settles stopped' "$(await_settled "$id" 180)" stopped
    answered="$(body "$(api GET "/api/jobs/$id")")"
    case "$(node -e 'try { const q = (JSON.parse(process.argv[1]).questions || []).find((x) => x.id === process.argv[2]); process.stdout.write(q ? q.status : ""); } catch {}' "$answered" "$qid")" in
    closed) ok 'the stopped job'"'"'s question reads closed' ;;
    *) bad 'the stopped job'"'"'s question reads closed' "$answered" ;;
    esac
    lane_endpoint_stop "$ask_pid"
    stop_driver
}

# the runtime connection requirement, end to end. The real claude-executor runs the Jira helper
# (a scripted Bash step) for a task that has no Jira connection: the helper asks on the control socket, the
# driver relays it to the board, the board holds the task queued behind an open requirement, and the driver
# ends the run as a hand-back (not failed). Binding a connection through the API releases the claim: the next
# run resumes the SAME session and the scripted model ends it. The connection is seeded only after the task
# waits: a user with a lone Jira connection would have it bound by default.
connection_roundtrip_lane() {
    local image=claude-executor ask_pid ask_port id body_json waited org user conn rev i
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad 'a runtime connection requirement holds the task' "the $image image is missing — run make runners"
        return
    fi
    stop_driver
    # Auto mode asks the model to classify a Bash call; the scripted endpoint cannot, and the call is blocked.
    # The helper reaches the board from inside the container, where the driver's loopback URL is not the host's.
    RUNNER_SKIP_PERMISSIONS=1 RUNNER_STATS_URL="http://host.docker.internal:$PORT" start_driver "$image"

    node scripts/fake-model-endpoint.mjs --steps '[{"tool":"Bash","input":{"command":"node /usr/local/share/factory-skills/factory-jira/jira.cjs issue ABC-1 && node /usr/local/share/factory-skills/factory-task-title/task-title.cjs \"Lane Jira subject\"; echo helper-exit=$?"}}]' >"$work/fake-connect.port" &
    # the image's Jira skill carries the title hook (the scripted model cannot read prose, so the
    # chained command below stands for an agent that follows it: the title call runs only after a read exit 0).
    docker run --rm --entrypoint cat "$image" /usr/local/share/factory-skills/factory-jira/SKILL.md 2>/dev/null | grep 'Naming the task after a ticket' >/dev/null &&
        ok 'the image ships the Jira skill title hook' || bad 'the image ships the Jira skill title hook' 'SKILL.md in the image lacks the section; make runners'
    ask_pid=$!
    lane_endpoint_started "$ask_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-connect.port" ] && break
        sleep 0.25
    done
    ask_port="$(cat "$work/fake-connect.port")"
    point_runners_at "$ask_port"
    id="$(create_job 'use jira, which this task has no connection for')"

    waited=''
    for i in $(seq 1 150); do
        body_json="$(body "$(api GET "/api/jobs/$id")")"
        case "$(field "$body_json" status)" in
        failed | dead | succeeded | stopped) break ;;
        esac
        if [ "$(field "$body_json" status)" = queued ] && [ "$(node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).integrationRequirements.length)); } catch { process.stdout.write("0"); }' "$body_json")" = 1 ]; then
            waited=1
            break
        fi
        sleep 1
    done
    [ -n "$waited" ] && ok 'the asking task is queued behind one open requirement, not failed' ||
        bad 'the asking task is queued behind one open requirement, not failed' \
            "$(field "$body_json" status); the helper's result: $(curl -s --max-time 5 "http://127.0.0.1:$ask_port/steps" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).results[0].text).replace(/\n/g,"|").slice(-330))}catch{}})'); driver: $(grep -F "job $id" "$work/driver.log" | grep -i 'connect\|requirement' | tail -4 | cut -c1-300); board: $(grep -E 'requirements|credentials/connections|/attempt' "$work/server.log" | tail -6 | cut -c1-300)"
    expect_field 'the hand-back refunds the attempt' "$body_json" attempts 0
    # The failed read ended the chain before the title helper: no fabricated subject reached the board.
    expect_field 'a failed issue read leaves the title off the agent subject' "$(node -e 'const j = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify({ named: j.title === "Lane Jira subject" || j.titleOrigin === "agent" }))' "$body_json")" named false
    local session
    session="$(field "$body_json" sessionId)"
    [ -n "$session" ] && ok 'the waiting task kept its session' || bad 'the waiting task kept its session' "$body_json"

    org="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -c "select org_id from job where id = '$id'" | tr -d '\r')"
    user="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -c "select id from app_user where github_login = '__local__'" | tr -d '\r')"
    conn="$(DATABASE_URL="$DATABASE_URL" LANE_ORG="$org" LANE_USER="$user" node --input-type=module -e '
import postgres from "postgres";
import { createConnectionGrants } from "./server/dist/db/connection-grants.js";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const made = await createConnectionGrants({ sql, orgId: process.env.LANE_ORG }).attachGrantConnection({
    principal: { kind: "user", userId: process.env.LANE_USER },
    provider: "jira",
    externalAccountId: "lane-account",
    authority: { scopes: ["read:jira-work"] },
    resource: { id: "lane-cloud", label: "example.atlassian.net" },
    access: "read",
});
await sql.end();
process.stdout.write(made.ok ? made.connectionId : "");
')"
    [ -n "$conn" ] && ok 'a Jira connection is seeded for the task owner' || bad 'a Jira connection is seeded for the task owner' "org=$org user=$user"
    rev="$(field "$body_json" bindingRevision)"
    expect_status 'the owner binds the connection to the waiting task' 200 POST "/api/jobs/$id/connections" "{\"connectionId\":\"$conn\",\"bindingRevision\":${rev:-0}}"

    expect_contains 'the released task runs again and succeeds' "$(await_settled "$id" 180)" succeeded
    body_json="$(body "$(api GET "/api/jobs/$id")")"
    expect_field 'the resumed run is the same session' "$body_json" sessionId "$session"
    expect_field 'the requirement is closed' "$(node -e 'process.stdout.write(JSON.stringify({ open: JSON.parse(process.argv[1]).integrationRequirements.length }))' "$body_json")" open 0
    # The stub site has no issue to return, so the resumed read fails too and the chain stops again.
    expect_field 'a read the stub site cannot answer still leaves the title unset by the agent' "$(node -e 'const j = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify({ named: j.title === "Lane Jira subject" || j.titleOrigin === "agent" }))' "$body_json")" named false
    lane_endpoint_stop "$ask_pid"
    stop_driver
}

connection_roundtrip_lane

# The agent names its task, end to end for both CLIs. The real executor image runs the task-title
# helper (a scripted shell step) on the attempt pair its pod/container holds: the helper reaches the board's
# agent-title route and the task carries the title with origin `agent`. The refusals (a user's title, the
# change cap, a lapsed lease) are server/test-db/agent-title.test.ts's.
task_title_lane() { # task_title_lane <claude|opencode>
    local cli="$1" image="$1-executor" tool=Bash fake_pid fake_port id body_json
    [ "$cli" = opencode ] && tool=bash
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli: the agent names its task" "the $image image is missing — run make runners"
        return
    fi
    stop_driver
    RUNNER_SKIP_PERMISSIONS=1 RUNNER_STATS_URL="http://host.docker.internal:$PORT" start_driver "$image"

    node scripts/fake-model-endpoint.mjs --steps '[{"tool":"'"$tool"'","input":{"command":"node /usr/local/share/factory-skills/factory-task-title/task-title.cjs \"Lane agent title\"; echo helper-exit=$?"}}]' >"$work/fake-title-$cli.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-title-$cli.port" ] && break
        sleep 0.25
    done
    fake_port="$(cat "$work/fake-title-$cli.port")"
    if [ "$cli" = opencode ]; then
        # OPENCODE_CONFIG_CONTENT is reserved at /api/env; the claim synthesizes it from the executor row's
        # config (job-store-claim-executor.ts), so the scripted endpoint rides the row. The key is a plain env name.
        api PUT /api/env/org '{"vars":[{"name":"ANTHROPIC_API_KEY","value":"fake-key","isSecret":true}]}' >/dev/null
        api PUT /api/workspace/executors "$(node -e 'const config = JSON.parse(process.argv[1]);
            process.stdout.write(JSON.stringify({ executors: [{ name: "claude", type: "claude-code", config: {} }, { name: "opencode", type: "opencode", config }] }));' "$(lane_opencode_config "http://host.docker.internal:$fake_port/v1")")" >/dev/null
    else
        point_runners_at "$fake_port"
    fi
    id="$(create_job 'name this task' "$cli")"
    expect_contains "$cli: the task with a scripted title step succeeds" "$(await_settled "$id" 180)" succeeded
    body_json="$(body "$(api GET "/api/jobs/$id")")"
    expect_field "$cli: the agent's title is the task's title" "$body_json" title 'Lane agent title'
    expect_field "$cli: the title is marked as set by the agent" "$body_json" titleOrigin agent
    lane_endpoint_stop "$fake_pid"
    if [ "$cli" = opencode ]; then
        api PUT /api/workspace/executors '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}' >/dev/null
    fi
    stop_driver
}

task_title_lane claude

task_title_lane opencode

ask_roundtrip_lane

fi
