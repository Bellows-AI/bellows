if selected_phase driver; then
begin_phase driver
# --- The driver ------------------------------------------------------------------------------

echo
echo '# driver'

start_driver "$IMAGE_OK"

first="$(create_job 'first prompt')"
second="$(create_job 'second prompt')"
third="$(create_job 'third prompt')"

expect_contains 'runs a queued job'        "$(await_settled "$first")"  succeeded
expect_contains 'runs the second'          "$(await_settled "$second")" succeeded
# Three jobs against a concurrency of two: this one only runs once a slot frees.
expect_contains 'queues past the slots'    "$(await_settled "$third")"  succeeded

ran="$(body "$(api GET "/api/jobs/$first")")"
expect_field    'the exit code comes back' "$ran" exitCode 0
# The stub image echoes its arguments, so the output is the proof the prompt reached the container.
expect_contains 'the prompt reached it'    "$(field "$ran" output)" 'first prompt'
expect_contains 'the driver names itself'  "$(field "$ran" claimedBy)" driver-
expect_field    'one attempt was enough'   "$ran" attempts 1

# A normal run's claim ends `observed` (the runner proved the agent started) with its end stamped:
# only observed|adopted claims count as run segments, so `unknown` here is a launch-proof bug.
exec_rows="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 \
    -c "select launch || '|' || (ended_at is not null) || '|' || (created_at <= ended_at) from job_execution where job_id = '$first'" 2>&1)"
if [ "$exec_rows" = 'observed|true|true' ]; then ok 'the finished claim ends observed'
else bad 'the finished claim ends observed' "job_execution rows (launch|ended|ordered): $exec_rows"; fi

# The driver mints the session id, passes it to the runner as --session-id and reports it to the
# board. The stub echoes its arguments, so finding the reported id inside the output is what proves
# the two are the same one — a link built from it opens the session the job actually ran as.
session="$(field "$ran" sessionId)"
case "$session" in
    ????????-????-????-????-????????????) ok 'the session id was reported' ;;
    *) bad 'the session id was reported' "got '$session'" ;;
esac
expect_contains 'the runner was given that id' "$(field "$ran" output)" "$session"

# The vertical proof for the runner environment: configured on the board in the board section,
# resolved onto the claim, forwarded into the container, printed by the stub. Today the whole
# chain is dark; with it, the markers come back in the job's output.
env_job="$(create_job 'env probe')"
expect_contains 'runs the env job' "$(await_settled "$env_job")" succeeded
env_ran="$(body "$(api GET "/api/jobs/$env_job")")"
expect_contains 'the core env reached the runner'     "$(field "$env_ran" output)" 'org-marker'
expect_contains 'the core secret reached the runner'  "$(field "$env_ran" output)" 'secret-marker'

stop_driver
start_driver "$IMAGE_FAIL"

failing="$(create_job 'this one fails')"
expect_contains 'a non-zero exit is a failure' "$(await_settled "$failing")" failed
failed_body="$(body "$(api GET "/api/jobs/$failing")")"
expect_field    'the exit code is reported'    "$failed_body" exitCode 3
expect_contains 'stderr is captured'           "$(field "$failed_body" output)" boom

# Issue #814, through the real driver's agent flags: the agent's tool runs as the tool uid, so its
# `kill -TERM 1; kill -KILL -1` reaches only its own processes and the run goes on to succeed.
stop_driver
start_driver "$IMAGE_KILL"

killing="$(create_job 'a tool that kills everything it may')"
expect_contains 'a run whose tool signals everything it may succeeds' "$(await_settled "$killing")" succeeded
kill_body="$(body "$(api GET "/api/jobs/$killing")")"
expect_contains 'the agent survived its tool'  "$(field "$kill_body" output)" 'agent survived'
expect_contains 'the tool ran as the tool uid' "$(field "$kill_body" output)" 'the tool ran as 1001'
expect_field    'one attempt was enough for it' "$kill_body" attempts 1

# Issue #824 D11: an executor image the daemon refuses on its own words (an invalid reference — no
# network asked) fails the job as a configuration fault on its first attempt, the daemon's reason in
# the output, instead of a lease burnt down to dead.
stop_driver
start_driver 'Factory-Lane-Invalid-Reference'

unstartable="$(create_job 'an image the daemon refuses')"
expect_contains 'a refused executor image is a failure' "$(await_settled "$unstartable")" failed
unstartable_body="$(body "$(api GET "/api/jobs/$unstartable")")"
expect_field    'it is a configuration fault'     "$unstartable_body" failureKind config
expect_field    'on its first attempt'            "$unstartable_body" attempts 1
expect_contains 'the daemon says why'             "$(field "$unstartable_body" output)" 'invalid reference format'

stop_driver
start_driver "$IMAGE_OK"

# The opencode switch, end to end: same stub image (its entrypoint echoes, so the output is the
# argv the container received), but the driver now speaks opencode's headless form — `run <prompt>`
# — and, because opencode cannot adopt a minted session id, reports no session at all.
oc="$(create_job 'opencode prompt' opencode)"
expect_contains 'an opencode driver runs its job' "$(await_settled "$oc")" succeeded
oc_body="$(body "$(api GET "/api/jobs/$oc")")"
# The reserved `factory` primary agent carries the board's master prompt (issue #244), so the
# headless form is `run --agent factory <message>`. The message is the turn context, then the prompt
# (#518, 87eaca1f): the stub re-echoes the last argument on its final line, so that line is the
# prompt's own.
expect_contains 'the opencode argv reached it' "$(field "$oc_body" output)" 'run --agent factory '
oc_last="$(node -e 'process.stdout.write(process.argv[1].trimEnd().split("\n").at(-1))' "$(field "$oc_body" output)")"
[ "$oc_last" = 'opencode prompt' ] && ok 'the opencode message ends with the prompt' ||
    bad 'the opencode message ends with the prompt' "last line: '$oc_last'"
expect_field    'no session was reported'      "$oc_body" sessionId ''

# The org scope, end to end: the task stamps `executorScope: 'org'`, the claim resolves the ORG
# row, and its configuration reaches the container — the marker in the output is the org profile's
# `model`, which no personal row carries (issue 391).
org_job="$(create_job 'org prompt' "$ORG_EXECUTOR" org)"
expect_contains 'an org-scoped task runs' "$(await_settled "$org_job")" succeeded
org_body="$(body "$(api GET "/api/jobs/$org_job")")"
expect_contains 'the org config reached the runner' "$(field "$org_body" output)" 'org-team-model'
expect_field    'the org scope is stamped'          "$org_body" executorScope org

stop_driver

fi
