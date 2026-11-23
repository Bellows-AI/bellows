if selected_phase publish-member; then
begin_phase publish-member
# --- The board opens the task's PR as the member (docs/connections.md) --------------------------------
#
# A board with member grants (AUTH_MODE=github, no App: the offline entry) whose GitHub is the lane's fake forge
# (scripts/fake-forge, GITHUB_WEB_URL and GITHUB_API_URL), the real driver, and the prompt-executing stub runner. The
# member signs in through the fake (scripts/publish-member-client.mjs), which stores their refreshable user grant;
# the task's publish then asks the board (POST /api/jobs/:id/pull-request) and the board opens the PR with that
# token. The fake records which kind of token made each call, and its `hold` file parks a create until the lane says go.
#   p1  a task publishes: one PR, created with the user token, the branch pushed once, the verdict carries its URL
#   p2  the driver dies while the board's create is parked: the next claim finds the PR by head, so one PR exists
#   p3  the member's grant breaks: the publish waits (forge requirement, never a failure), and signing in again
#       lets the task finish with one PR and no second push
#   p4  the member cannot write to the repository (the fake answers 404 to their create): the publish waits as a
#       `forge-access` requirement (the task is queued, never failed), and once access is back and the retry time is
#       due (the lane sets claim_deferred_until itself: the real wait is ten minutes) the task finishes with one PR
#       and no second push
# The member's runner holds no user token: the only credential the publish steps carry is the installation token
# the push reads, and this board has no App, so none. server/test-db/pr-as-member.test.ts runs the route on a real store.

echo
echo '# publish as the member (board with member grants, fake GitHub, real driver, stub runner)'

PM_BASE="http://127.0.0.1:$PM_PORT" # loopback: only the host's driver and this script reach it
PM_ORG=999001 # the installation the fake GitHub reports for its member (scripts/fake-forge/github.mjs)
PM_STATE="$work/fake-forge"
PM_ORIGIN="$SMOKE_REPO.git" # under /origins on the origins volume
PM_COMMIT='cd "$WORKDIR" && echo x >lane-change && git add lane-change && { git diff --cached --quiet || git -c user.name=lane -c user.email=lane@localhost commit -q -m lane-commit; }'

pm_forge() { # pm_forge <path> -> the fake forge's answer body (its own door: no credential)
    body "$(BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER='' api GET "$1")"
}
pm_pulls() { # pm_pulls -> "<count> <creators, comma-separated>" over the fake's PR list
    node -e '
const pulls = JSON.parse(process.argv[1] || "[]");
process.stdout.write(`${pulls.length} ${pulls.map((pull) => pull.createdBy).join(",")}`);' "$(pm_forge /_control/pulls)"
}
pm_creates() { # pm_creates <token kind> -> how many PR creates the fake saw under that kind of token
    node -e '
const calls = JSON.parse(process.argv[1] || "[]");
process.stdout.write(String(calls.filter((c) => c.method === "POST" && /\/pulls$/.test(c.path) && c.tokenKind === process.argv[2]).length));' \
        "$(pm_forge /_control/calls)" "$1"
}
pm_write_access() { # pm_write_access <true|false> -> whether the fake lets a member's token write PRs
    BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER='' api POST /_control/write-access "{\"user\": $1}" >/dev/null
}
pm_member_job() { # pm_member_job <command> -> the member's new task id
    BASE="$PM_BASE" AUTH_HEADER="Bearer $PM_MEMBER" create_job "$1"
}
pm_job() { # pm_job <id> -> the job as the member reads it
    body "$(BASE="$PM_BASE" AUTH_HEADER="Bearer $PM_MEMBER" api GET "/api/jobs/$1")"
}
pm_settled() { # pm_settled <id> [seconds] -> final status, empty on timeout
    BASE="$PM_BASE" AUTH_HEADER="Bearer $PM_MEMBER" await_settled "$1" "${2:-$ADOPT_S}"
}
pm_psql() { # pm_psql <sql> -> psql's rows
    compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 -c "$1" 2>&1
}
pm_kill_driver() {
    kill -9 "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}
pm_driver() { # pm_driver [VAR=value ...] -> a driver on the member's board
    disruption_driver JOB_BOARD_URL="$PM_BASE" DRIVER_CREDENTIAL="$PM_TOKEN" "$@"
}
pm_pushes() { # -> the ref updates the origin has received, ? when the read failed
    lane_origin lane_count "$PM_ORIGIN/lane-pushes.log"
}

# The origin's push log: its hook counts the ref updates the git daemon receives.
lane_origin lane_run 'printf "%s\n" "#!/bin/sh" "while read old new ref; do echo \"\$ref\" >>lane-pushes.log; done" >"$1/hooks/post-receive" &&
    chmod 0755 "$1/hooks/post-receive"' "$PM_ORIGIN" || {
    echo 'test-jobs: could not prepare the publish-member push log'
    exit 1
}

PM_TOKEN="drv_$(openssl rand -hex 32)" # the driver's credential; the board records only its SHA-256
compose exec -T postgres psql -U factory -d "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into organization (id, name) values ('$PM_ORG', '$PM_ORG') on conflict do nothing;
     insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
     values ('$PM_ORG', 'claude-code', 'test-jobs-publish-member', '$SMOKE_REPO', 'main', now(), now())
     on conflict do nothing" >/dev/null 2>&1 || {
    echo "test-jobs: could not select $SMOKE_REPO for the publish-member organization"
    exit 1
}
env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$PM_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" AUTH_MODE=github PUBLIC_URL="$PM_BASE" \
    GITHUB_APP_CLIENT_ID=lane-client GITHUB_APP_CLIENT_SECRET=lane-secret \
    GITHUB_WEB_URL="$LANE_FAKE_FORGE_URL" GITHUB_API_URL="$LANE_FAKE_FORGE_URL" \
    SESSION_SECRET=a-job-harness-session-secret-32-chars DRIVER_CREDENTIAL_SHA256="$(credential_sha256 "$PM_TOKEN")" \
    node server/dist/offline.js >>"$work/publish-member-server.log" 2>&1 &
pm_server_pid=$!
lane_extra_pids="$lane_extra_pids $pm_server_pid"
lane_extra_pids="${lane_extra_pids# }"

pm_up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="$PM_BASE" api GET /api/ready)")" = '200' ] && {
        pm_up=1
        break
    }
    sleep 1
done

if [ -z "$pm_up" ]; then
    bad 'publish-member: the board with member grants came up' "$(tail -5 "$work/publish-member-server.log")"
else
    ok 'publish-member: the board with member grants came up'
    PM_MEMBER="$(node scripts/publish-member-client.mjs "$PM_BASE" 2>"$work/publish-member-client.err")" || PM_MEMBER=''
    if [ -z "$PM_MEMBER" ]; then
        bad 'publish-member: the member signs in through the fake GitHub' "$(tail -3 "$work/publish-member-client.err")"
    else
        ok 'publish-member: the member signs in through the fake GitHub'
        pm_driver

        # P1. A task publishes: the board opens the PR with the member's token.
        pm1="$(pm_member_job "$PM_COMMIT && echo \"ran in \$HOSTNAME\"")"
        expect_contains 'p1: the task succeeds' "$(pm_settled "$pm1" 180)" succeeded
        [ "$(pm_pulls)" = '1 user' ] && ok 'p1: one PR exists, created with the user token' ||
            bad 'p1: one PR exists, created with the user token' "PRs: '$(pm_pulls)'"
        [ "$(pm_creates installation)" = 0 ] && ok 'p1: no PR was created with an installation token' ||
            bad 'p1: no PR was created with an installation token' "installation creates: $(pm_creates installation)"
        [ "$(pm_pushes)" = 1 ] && ok 'p1: the branch ref is updated once' ||
            bad 'p1: the branch ref is updated once' "ref updates: $(pm_pushes)"
        expect_contains 'p1: the verdict carries the fake PR' "$(field "$(pm_job "$pm1")" output)" "$SMOKE_REPO/pull/"

        # P2. The driver dies while the board's create is parked at the fake: the next claim finds the PR by head.
        : >"$PM_STATE/hold"
        pm2="$(pm_member_job "$PM_COMMIT && echo \"p2 ran in \$HOSTNAME\"")"
        pm_held=""
        for _ in $(seq 1 180); do
            [ -e "$PM_STATE/hold.ready" ] && {
                pm_held=1
                break
            }
            sleep 1
        done
        [ -n "$pm_held" ] && ok 'p2: the board'"'"'s create is parked at the fake GitHub' ||
            bad 'p2: the board'"'"'s create is parked at the fake GitHub' "job: $(field "$(pm_job "$pm2")" status)"
        pm_kill_driver
        pm_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
        : >"$PM_STATE/hold.go"
        expect_contains 'p2: the next claim finishes the task' "$(pm_settled "$pm2" "$ADOPT_S")" succeeded
        rm -f "$PM_STATE/hold" "$PM_STATE/hold.ready" "$PM_STATE/hold.go"
        [ "$(pm_pulls)" = '2 user,user' ] && ok 'p2: exactly one PR was opened for the task' ||
            bad 'p2: exactly one PR was opened for the task' "PRs after p1 and p2: '$(pm_pulls)'"
        expect_contains 'p2: the verdict carries the fake PR' "$(field "$(pm_job "$pm2")" output)" "$SMOKE_REPO/pull/"

        # P3. The member's grant breaks: the publish waits, and signing in again lets the task finish.
        PM_D="$LANE_DIR"
        pm3_pushes="$(pm_pushes)"
        pm3="$(pm_member_job "mkdir -p $PM_D; $PM_COMMIT; $(lane_wait "$PM_D/$RUN_ID-p3.go"); echo \"p3 ran in \$HOSTNAME\"")"
        lane_use "$pm3"
        for _ in $(seq 1 120); do
            [ "$(field "$(pm_job "$pm3")" status)" = running ] && break
            sleep 1
        done
        pm_psql "update integration_grant set status = 'reconnect_required' where org_id = '$PM_ORG' and provider = 'github'" >/dev/null
        lane_touch "$PM_D/$RUN_ID-p3.go" || bad 'p3: the agent is released' 'the touch failed'
        pm_wait=""
        for _ in $(seq 1 180); do
            pm_wait="$(pm_psql "select reason || ' ' || target from job_integration_requirement where root_job_id = '$pm3' and provider = 'forge' and satisfied_at is null")"
            [ -n "$pm_wait" ] && break
            sleep 1
        done
        [ "$pm_wait" = 'reconnect github' ] && ok 'p3: the publish waits on a forge requirement (reconnect, github)' ||
            bad 'p3: the publish waits on a forge requirement (reconnect, github)' "requirement: '$pm_wait', job: $(field "$(pm_job "$pm3")" status)"
        case "$(field "$(pm_job "$pm3")" status)" in
        failed | dead) bad 'p3: the wait is not a failure' "job: $(field "$(pm_job "$pm3")" status)" ;;
        *) ok 'p3: the wait is not a failure' ;;
        esac
        [ "$(pm_creates user)" = 2 ] && ok 'p3: no PR was created while the grant was broken' ||
            bad 'p3: no PR was created while the grant was broken' "user creates: $(pm_creates user)"
        PM_MEMBER="$(node scripts/publish-member-client.mjs "$PM_BASE" 2>"$work/publish-member-client.err")" || PM_MEMBER=''
        [ -n "$PM_MEMBER" ] && ok 'p3: the member signs in again' ||
            bad 'p3: the member signs in again' "$(tail -3 "$work/publish-member-client.err")"
        expect_contains 'p3: the task finishes once the member is reconnected' "$(pm_settled "$pm3" "$ADOPT_S")" succeeded
        [ "$(pm_pulls)" = '3 user,user,user' ] && ok 'p3: one more PR exists, created with the user token' ||
            bad 'p3: one more PR exists, created with the user token' "PRs: '$(pm_pulls)'"
        pm3_pushed=$(($(pm_pushes) - pm3_pushes))
        [ "$pm3_pushed" = 1 ] && ok 'p3: the branch was pushed once, not again after the wait' ||
            bad 'p3: the branch was pushed once, not again after the wait' "ref updates added: $pm3_pushed"
        expect_contains 'p3: the verdict carries the fake PR' "$(field "$(pm_job "$pm3")" output)" "$SMOKE_REPO/pull/"

        # P4. The member cannot write to the repository: the publish waits as forge-access, then lands once access is back.
        pm4_pushes="$(pm_pushes)"
        pm_write_access false
        pm4="$(pm_member_job "$PM_COMMIT && echo \"p4 ran in \$HOSTNAME\"")"
        pm_wait=""
        for _ in $(seq 1 180); do
            pm_wait="$(pm_psql "select reason from job_integration_requirement where root_job_id = '$pm4' and provider = 'forge' and satisfied_at is null")"
            [ -n "$pm_wait" ] && break
            sleep 1
        done
        [ "$pm_wait" = 'forge-access' ] && ok 'p4: the publish waits on a forge-access requirement' ||
            bad 'p4: the publish waits on a forge-access requirement' "requirement: '$pm_wait', job: $(field "$(pm_job "$pm4")" status)"
        pm4_status=""
        for _ in $(seq 1 60); do # the requirement opens before the driver hands the run back
            pm4_status="$(pm_psql "select status from job where id = '$pm4'")"
            [ "$pm4_status" = queued ] && break
            sleep 1
        done
        [ "$pm4_status" = queued ] && ok 'p4: the task is queued, not failed' ||
            bad 'p4: the task is queued, not failed' "job: $pm4_status"
        [ "$(pm_pulls)" = '3 user,user,user' ] && ok 'p4: no PR was created while access was off' ||
            bad 'p4: no PR was created while access was off' "PRs: '$(pm_pulls)'"
        pm_write_access true
        # The retry is the claim's clock (ten minutes): the lane makes it due instead of waiting.
        pm_psql "update job set claim_deferred_until = now() where id = '$pm4'" >/dev/null
        expect_contains 'p4: the task finishes once access is back' "$(pm_settled "$pm4" "$ADOPT_S")" succeeded
        [ "$(pm_pulls)" = '4 user,user,user,user' ] && ok 'p4: one more PR exists, created with the user token' ||
            bad 'p4: one more PR exists, created with the user token' "PRs: '$(pm_pulls)'"
        pm4_pushed=$(($(pm_pushes) - pm4_pushes))
        [ "$pm4_pushed" = 1 ] && ok 'p4: the branch was pushed once, not again after the wait' ||
            bad 'p4: the branch was pushed once, not again after the wait' "ref updates added: $pm4_pushed"
        pm4_open="$(pm_psql "select count(*) from job_integration_requirement where root_job_id = '$pm4' and provider = 'forge' and satisfied_at is null")"
        [ "$pm4_open" = 0 ] && ok 'p4: the forge-access requirement is closed' ||
            bad 'p4: the forge-access requirement is closed' "open requirements: $pm4_open"
    fi
    stop_driver
fi
kill "$pm_server_pid" 2>/dev/null
wait "$pm_server_pid" 2>/dev/null

fi
