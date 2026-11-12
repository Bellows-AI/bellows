if selected_phase board; then
begin_phase board
echo
echo '# board'

expect_status 'refuses a duplicate org name'         409 POST /api/org/executors \
    "{\"name\":\"$ORG_EXECUTOR\",\"type\":\"claude-code\",\"config\":{}}"
expect_status 'a scope outside the pair is refused' 400 POST /api/jobs \
    "{\"command\":\"x\",\"executor\":\"$ORG_EXECUTOR\",\"executorScope\":\"repo\",\"repo\":\"$SMOKE_REPO\"}"

expect_status 'health answers'            200 GET /api/health
expect_status 'refuses an empty command'  400 POST /api/jobs '{"command":""}'
expect_status 'refuses a malformed id'    400 GET '/api/jobs/not-a-uuid'
expect_status 'unknown job is 404'        404 GET '/api/jobs/00000000-0000-4000-8000-000000000000'
expect_status 'refuses an unknown status' 400 GET '/api/jobs?status=pending'

# The runner environment, configured the way the UI would: one plain variable and one secret on the
# org ("core") scope. AUTH_MODE=none resolves the stand-in admin, so the PUT is allowed.
expect_status 'refuses an env name that is not a name' 400 PUT /api/env/org \
    '{"vars":[{"name":"not a name","value":"x","isSecret":false}]}'
env_list="$(body "$(api GET /api/env)")"
expect_contains 'the env list names the plain variable' "$env_list" 'FACTORY_ENV_PROBE'
# The write-only contract, end to end: the secret travels by name, its value is withheld from
# every read.
expect_contains 'the core secret value is withheld' "$env_list" '"name":"SECRET_PROBE","value":null'

id="$(create_job 'board only')"
case "$id" in
*-*-*-*-*) ok 'queues a job' ;;
*) bad 'queues a job' "no id came back: '$id'" ;;
esac
claim="$(body "$(api POST /api/jobs/claim '{"worker":"probe","leaseSeconds":300}')")"
token="$(field "$claim" leaseToken)"
expect_field 'claim returns the command' "$claim" command 'board only'
expect_field 'first attempt is 1'        "$claim" attempts 1

# A live lease is the whole point: nothing else may take this job while probe holds it.
expect_status 'a held job is not offered again' 204 POST /api/jobs/claim '{"worker":"other"}'
expect_status 'heartbeat extends the lease'     200 POST "/api/jobs/$id/heartbeat" "{\"leaseToken\":\"$token\"}"
expect_status 'a wrong token is refused'        409 POST "/api/jobs/$id/complete" \
    '{"leaseToken":"00000000-0000-4000-8000-000000000000","status":"succeeded","exitCode":0,"output":"x"}'
expect_status 'the holder may complete'         200 POST "/api/jobs/$id/complete" \
    "{\"leaseToken\":\"$token\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"hello\"}"

done_body="$(body "$(api GET "/api/jobs/$id")")"
expect_field 'the result is recorded'   "$done_body" status succeeded
expect_field 'the exit code is kept'    "$done_body" exitCode 0
expect_field 'the output is kept'       "$done_body" output hello

# Reclaim, proven by ageing the lease rather than by waiting one out. The expiry is the lost
# attempt's interruption: the takeover keeps the attempt count and resumes the lost session.
RECLAIMED_SESSION='44444444-4444-4444-8444-444444444444'
reclaim_id="$(create_job 'reclaim me')"
stale="$(field "$(body "$(api POST /api/jobs/claim '{"worker":"dies","leaseSeconds":300}')")" leaseToken)"
api POST "/api/jobs/$reclaim_id/session" \
    "{\"leaseToken\":\"$stale\",\"sessionId\":\"$RECLAIMED_SESSION\"}" >/dev/null
compose exec -T postgres psql -U factory -d "$DB" \
    -c "update job set lease_expires_at = now() - interval '1 second' where id = '$reclaim_id'" >/dev/null 2>&1
again="$(body "$(api POST /api/jobs/claim '{"worker":"takes-over","leaseSeconds":300}')")"
expect_field 'an expired lease is reclaimed'     "$again" id "$reclaim_id"
expect_field 'the attempt count stays'           "$again" attempts 1
expect_field 'the claim sequence grows'          "$again" claimSeq 2
expect_field 'the takeover resumes the session'  "$again" resumeSessionId "$RECLAIMED_SESSION"
# The fencing token, end to end: the first worker is still alive and still wrong.
expect_status 'the superseded worker is refused' 409 POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$stale\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"zombie\"}"
api POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$(field "$again" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

PARKED_SESSION='55555555-5555-4555-8555-555555555555'

# Stop, end to end: a running job asked to stop is settled by its worker's park, lands stopped —
# terminal, the session kept — and continues as a follow-up (docs/jobs.md).
park_id="$(create_job 'park me')"
park_claim="$(body "$(api POST /api/jobs/claim '{"worker":"parks","leaseSeconds":300}')")"
park_token="$(field "$park_claim" leaseToken)"
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\"}" >/dev/null
# A live lease: the stop is stamped and rides the heartbeat to the worker, which parks the run.
expect_status 'a running job can be asked to stop' 202 POST "/api/jobs/$park_id/stop"
expect_status 'the worker parks the stopped run'   200 POST "/api/jobs/$park_id/suspend" \
    "{\"leaseToken\":\"$park_token\"}"
stopped="$(body "$(api GET "/api/jobs/$park_id")")"
expect_field  'it is stopped'                 "$stopped" status stopped
expect_field  'stopped keeps the session'     "$stopped" sessionId "$PARKED_SESSION"
# Parking handed the attempt back: the stopped row never burned a try.
# (suspend: attempts = greatest(attempts - 1, 0).)
expect_field  'parking did not burn a try'    "$stopped" attempts 0
# Stopped is terminal: an idle poll must not pick it back up.
expect_status 'a stopped job is not offered'  204 POST /api/jobs/claim '{"worker":"idle-poll"}'
# One api call, not expect_status plus a second request: every follow-up POST that passes the
# preconditions INSERTS a row, so a duplicate call would queue a second continuation.
follow_out="$(api POST "/api/jobs/$park_id/follow-up" '{"command":"continue this"}')"
if [ "$(status "$follow_out")" = '201' ]; then ok 'a stopped task can be continued'; else
    bad 'a stopped task can be continued' "wanted 201, got $(status "$follow_out"): $(body "$follow_out")"; fi
fu_id="$(field "$(body "$follow_out")" id)"
printf '%s\n' "$fu_id" >>"$work/created-jobs"
fu_claim="$(body "$(api POST /api/jobs/claim '{"worker":"follows","leaseSeconds":300}')")"
expect_field  'the follow-up claim comes back' "$fu_claim" id "$fu_id"
# The per-member workspace, ready-made by the board: `<org>/<user id>`. The driver refuses anything
# that is not exactly that before interpolating it into a `docker run`.
workspace_path="$(field "$fu_claim" workspacePath)"
case "$workspace_path" in
default/????????-????-????-????-????????????) ok 'the claim carries a workspace path' ;;
*) bad 'the claim carries a workspace path' "got '$workspace_path'" ;;
esac
expect_field  'the claim carries the session' "$fu_claim" resumeSessionId "$PARKED_SESSION"
expect_field  'the claim says it is a follow-up' "$fu_claim" followUp true
expect_field  'the follow-up starts at attempt 1' "$fu_claim" attempts 1
api POST "/api/jobs/$fu_id/complete" \
    "{\"leaseToken\":\"$(field "$fu_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

[ "$workspace_path" = "$member_path" ] && ok 'the claim names the provisioned member tree' ||
    bad 'the claim names the provisioned member tree' "claim '$workspace_path', provisioned '$member_path'"

# Retry (issue #326): a finished run whose driver died before reporting a session queues a fresh
# attempt of the thread head's command in the SAME thread: no session resumed, the command
# delivered fresh, the same worktree root.
retry_id="$(create_job 'retry me')"
expect_status 'a queued task cannot be retried' 409 POST "/api/jobs/$retry_id/retry"
retry_claim="$(body "$(api POST /api/jobs/claim '{"worker":"sessionless","leaseSeconds":300}')")"
api POST "/api/jobs/$retry_id/complete" \
    "{\"leaseToken\":\"$(field "$retry_claim" leaseToken)\",\"status\":\"failed\",\"exitCode\":1,\"output\":\"died\"}" >/dev/null
retry_out="$(api POST "/api/jobs/$retry_id/retry")"
if [ "$(status "$retry_out")" = '201' ]; then ok 'a sessionless finished task can be retried'; else
    bad 'a sessionless finished task can be retried' "wanted 201, got $(status "$retry_out"): $(body "$retry_out")"; fi
retry2_id="$(field "$(body "$retry_out")" id)"
printf '%s\n' "$retry2_id" >>"$work/created-jobs"
r2_claim="$(body "$(api POST /api/jobs/claim '{"worker":"retries","leaseSeconds":300}')")"
expect_field 'the retry claim comes back'         "$r2_claim" id "$retry2_id"
expect_field 'the retry re-runs the head command' "$r2_claim" command 'retry me'
expect_field 'the retry stays in the thread'      "$r2_claim" rootJobId "$retry_id"
expect_field 'the retry claims no session'        "$r2_claim" resumeSessionId ''
expect_field 'the retry is not a follow-up'       "$r2_claim" followUp false
expect_field 'the retry starts at attempt 1'      "$r2_claim" attempts 1
api POST "/api/jobs/$retry2_id/complete" \
    "{\"leaseToken\":\"$(field "$r2_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# Only done or removed closes a task: the sessionless retry still takes a follow-up, which starts a
# fresh session and is delivered behind a recap of the earlier turns.
fu_out="$(api POST "/api/jobs/$retry2_id/follow-up" '{"command":"continue this"}')"
if [ "$(status "$fu_out")" = '201' ]; then ok 'a sessionless finished task can be followed up'; else
    bad 'a sessionless finished task can be followed up' "wanted 201, got $(status "$fu_out"): $(body "$fu_out")"; fi
fu_id="$(field "$(body "$fu_out")" id)"
printf '%s\n' "$fu_id" >>"$work/created-jobs"
fu_claim="$(body "$(api POST /api/jobs/claim '{"worker":"sessionless-follow-up","leaseSeconds":300}')")"
expect_field 'the sessionless follow-up claim comes back' "$fu_claim" id "$fu_id"
expect_field 'the sessionless follow-up resumes nothing'  "$fu_claim" resumeSessionId ''
expect_field 'the sessionless follow-up is a follow-up'   "$fu_claim" followUp true
api POST "/api/jobs/$fu_id/complete" \
    "{\"leaseToken\":\"$(field "$fu_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

fi
