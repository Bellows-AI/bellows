if selected_phase gitlab; then
begin_phase gitlab
# --- The fake GitLab fixture boots and serves what later GitLab phases need ----------------------
#
# The lane's fake forge (scripts/fake-forge) serves GitLab beside GitHub on $LANE_FAKE_FORGE_URL; the first checks prove
# the fixture itself — a signed-in token, a project by its URL-encoded nested path, and git smart-HTTP that clones with
# oauth2:<token> and refuses any other. The rest runs real tasks against a second, TLS fake GitLab (docs/executor-testing.md):
# a board with member grants, the org's GitLab connection (its CA bundle is the lane's certificate) activated and linked by
# scripts/gitlab-member-client.mjs, the real driver and the prompt-executing stub runner.
#   m1  a task clones and pushes as the member: every authenticated git call carries the member's token, the pushed commit
#       is authored by the member's GitLab name and commit email and committed by the bot, the MR opens
#   m2  the token rotates inside the task (the fake's tokens live 75 s): the push carries a refreshed token, not the clone's
#   m3  the driver dies mid-task: the next driver adopts the runner, which asks again; one push, still the member's
#   m4  no token the fake issued is in the runner's env, its .git/config or the task volume while the task runs,
#       nor in the task volume after, the job output, the driver log or the board log
#   b1  the member starts a one-task automerge batch: the task publishes a merge request, a passing pipeline on its head
#       is the board's cue, and the merge is one PUT by the member; a passing pipeline on the target tip completes it
#   r1  the review loop: a diff discussion by another login is answered and resolved as the member through the board, and the thread
#       rests on REVIEW-CLEAN

echo
echo '# gitlab (fake forge fixture: OAuth, REST v4, git smart-HTTP)'

GITLAB_PROJECT='acme/group/proj'
gitlab_control() { # gitlab_control <path> <json> -> the answer's body
    body "$(BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER='' api POST "/_control/gitlab/$1" "$2")"
}
gitlab_api() { # gitlab_api <token> <path> -> status TAB body
    BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER="Bearer $1" api GET "$2"
}

gitlab_seed="$(gitlab_control projects "{\"path\":\"$GITLAB_PROJECT\",\"files\":{\"README.md\":\"hello\"}}")"
expect_contains 'the fixture seeds a project' "$gitlab_seed" "\"path_with_namespace\":\"$GITLAB_PROJECT\""
gitlab_token="$(field "$(gitlab_control sign-in '{"login":"lane-dev"}')" access_token)"
[ -n "$gitlab_token" ] && ok 'a member signs in' || bad 'a member signs in' 'no access_token'

gitlab_project="$(gitlab_api "$gitlab_token" '/api/v4/projects/acme%2Fgroup%2Fproj')"
if [ "$(status "$gitlab_project")" = 200 ]; then
    expect_contains 'the project is found by its encoded nested path' "$(body "$gitlab_project")" "\"path_with_namespace\":\"$GITLAB_PROJECT\""
else
    bad 'the project is found by its encoded nested path' "got $(status "$gitlab_project"): $(body "$gitlab_project")"
fi
[ "$(status "$(gitlab_api bogus-token /api/v4/user)")" = 401 ] && ok 'an unknown token is refused' || bad 'an unknown token is refused' 'not 401'

gitlab_host="${LANE_FAKE_FORGE_URL#http://}"
gitlab_clone="$work/gitlab-clone"
if GIT_TERMINAL_PROMPT=0 git clone -q "http://oauth2:$gitlab_token@$gitlab_host/$GITLAB_PROJECT.git" "$gitlab_clone" >"$work/gitlab-clone.log" 2>&1 &&
    [ "$(cat "$gitlab_clone/README.md")" = hello ]; then
    ok 'git clones with oauth2:<token>'
else
    bad 'git clones with oauth2:<token>' "$(tail -3 "$work/gitlab-clone.log")"
fi
if GIT_TERMINAL_PROMPT=0 git clone -q "http://oauth2:bogus-token@$gitlab_host/$GITLAB_PROJECT.git" "$work/gitlab-refused" >/dev/null 2>&1; then
    bad 'git refuses a token the fake never issued' 'the clone succeeded'
else
    ok 'git refuses a token the fake never issued'
fi

# --- A task runs against a TLS GitLab as the member -------------------------------------------------

GL_ORG=999001 # the installation the fake GitHub reports for its member (scripts/fake-forge/github.mjs): the board's org
GL_LOGIN='lane-member'
GL_GROUP='lane-group'
GL_PROJECT="$GL_GROUP/web"
GL_TTL_S=75 # a token lives 75 s: the board refreshes inside the last 60, so a task that waits 20 s is served a new one
GL_TLS="$work/gitlab-tls"
GL_STATE="$work/fake-gitlab"
GL_BASE="http://$LANE_HOST:$GL_PORT"
GL_PAT='gloas'"-fake"'\|glrt'"-fake" # the fake's token prefixes, split so this file never holds one

gl_control() { # gl_control <path> [json] -> the fake GitLab's answer body (its own door: no credential)
    local json="${2-}"
    [ -n "$json" ] || json='{}'
    NODE_EXTRA_CA_CERTS="$GL_TLS/cert.pem" node scripts/gitlab-member-client.mjs control "$GL_URL" "$1" "$json"
}
gl_summary() { # gl_summary [skip calls] -> the fake's view of the project's git traffic since then (scripts/gitlab-member-client.mjs summary)
    node scripts/gitlab-member-client.mjs summary "$GL_STATE/calls.jsonl" "$GL_PROJECT" "${1:-0}"
}
gl_line() { # gl_line <key> <summary> -> the value of the first "<key> <value>" line
    printf '%s\n' "$2" | sed -n "s/^$1 //p" | sed -n 1p
}
gl_job() { # gl_job <command> -> the member's new GitLab task id
    local payload
    payload="$(node -e 'process.stdout.write(JSON.stringify({ command: process.argv[1], executor: "claude", repo: { forge: "gitlab", host: process.argv[2], path: process.argv[3] } }))' "$1" "$GL_HOST" "$GL_PROJECT")"
    BASE="$GL_BASE" AUTH_HEADER="Bearer $GL_MEMBER" field "$(body "$(BASE="$GL_BASE" AUTH_HEADER="Bearer $GL_MEMBER" api POST /api/jobs "$payload")")" id
}
gl_read() { # gl_read <id> -> the job as the member reads it
    body "$(BASE="$GL_BASE" AUTH_HEADER="Bearer $GL_MEMBER" api GET "/api/jobs/$1")"
}
gl_settled() { # gl_settled <id> [seconds] -> final status, empty on timeout
    BASE="$GL_BASE" AUTH_HEADER="Bearer $GL_MEMBER" await_settled "$1" "${2:-$ADOPT_S}"
}
gl_running() { [ "$(field "$(gl_read "$1")" status)" = running ]; }
gl_driver() { # gl_driver [VAR=value ...] -> a driver on the GitLab board; the runner reaches the board's credential route at the lane host
    disruption_driver JOB_BOARD_URL="$GL_BASE" DRIVER_CREDENTIAL="$GL_DRIVER_TOKEN" RUNNER_STATS_URL="http://host.docker.internal:$GL_PORT" "$@"
}
gl_batch_plan() { # gl_batch_plan -> a one-task automerge plan on the lane's project; the task's text is a shell script the stub runs
    node -e 'process.stdout.write(JSON.stringify({ planVersion: 1, title: "lane batch", targets: [{ key: "web", repo: { forge: "gitlab", host: process.argv[1], path: process.argv[2] } }], defaultTarget: "web", stages: [{ key: "one", policy: "automerge", tasks: [{ key: "a", objective: process.argv[3], acceptance: ":", verification: "true", completion: { kind: "pr" } }] }] }))' "$GL_HOST" "$GL_PROJECT" "$1"
}
gl_member_api() { # gl_member_api <method> <path> [json] -> the member's answer, status TAB body
    BASE="$GL_BASE" AUTH_HEADER="Bearer $GL_MEMBER" api "$@"
}
gl_kill_driver() {
    kill -9 "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}
# What the runner reports of its own env, config and task volume: markers only, never a value.
gl_probe() {
    # The pattern is joined in the runner, so the command text the task keeps never holds a token prefix.
    printf '%s' 'a=gloas; b=-fake; c=glrt; p="$a$b\|$c$b"; if [ -n "$(env | grep -e "$p")" ]; then echo gl-env-token; else echo gl-no-env-token; fi; '
    printf '%s' 'if grep -q -e "$p" "$WORKDIR/.git/config"; then echo gl-config-token; else echo gl-no-config-token; fi; '
    printf '%s' 'if [ -n "$(grep -rIl -e "$p" /task 2>/dev/null)" ]; then echo gl-volume-token; else echo gl-no-volume-token; fi'
}
gl_volume_clean() { # gl_volume_clean <id> -> success when the job's volume is gone or holds no token
    lane_use "$1"
    [ "$(lane_vol_state)" = present ] || return 0
    [ -z "$(lane_run 'grep -rIl -e "$1" /task 2>/dev/null' "$GL_PAT")" ]
}
gl_psql() { # gl_psql <sql> -> psql's rows
    compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

mkdir -p "$GL_TLS" "$GL_STATE"
if openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=lane-gitlab' \
    -addext "subjectAltName=IP:$LANE_HOST,DNS:localhost,DNS:host.docker.internal" -keyout "$GL_TLS/key.pem" -out "$GL_TLS/cert.pem" >/dev/null 2>&1; then
    ok 'the lane makes a certificate for the TLS GitLab'
else
    bad 'the lane makes a certificate for the TLS GitLab' 'openssl failed'
fi
env FAKE_FORGE_HOST="$LANE_HOST" FAKE_FORGE_TLS_CERT="$GL_TLS/cert.pem" FAKE_FORGE_TLS_KEY="$GL_TLS/key.pem" \
    node scripts/fake-forge/server.mjs "$GL_STATE" >"$GL_TLS/port" 2>"$work/fake-gitlab.log" &
gl_fake_pid=$!
lane_extra_pids="$lane_extra_pids $gl_fake_pid"
lane_extra_pids="${lane_extra_pids# }"
for _ in $(seq 1 50); do
    [ -s "$GL_TLS/port" ] && break
    sleep 0.1
done
# The lane reaches the fake at the lane host; the board and the runners name it host.docker.internal (the one name every
# daemon gives a container, which the host's own board resolves through scripts/lane-hosts.cjs): on Docker Desktop the
# lane host is the loopback and a container reaches the host only by that name.
GL_URL="https://$LANE_HOST:$(cat "$GL_TLS/port")"
GL_HOST="host.docker.internal:${GL_URL##*:}"

gl_ready=''
if [ -s "$GL_TLS/port" ] && [ -s "$GL_TLS/cert.pem" ]; then
    gl_control gitlab/projects "{\"path\":\"$GL_PROJECT\",\"files\":{\"README.md\":\"hello\"}}" >/dev/null &&
        gl_control gitlab/token-ttl "{\"seconds\":$GL_TTL_S}" >/dev/null &&
        gl_control gitlab/user-profile "{\"login\":\"$GL_LOGIN\",\"fields\":{\"name\":\"Lane Member\",\"commit_email\":\"lane.member@example.test\",\"public_email\":\"\"}}" >/dev/null &&
        gl_ready=1
fi
[ -n "$gl_ready" ] && ok 'the TLS GitLab serves a project, short-lived tokens and the member profile' ||
    bad 'the TLS GitLab serves a project, short-lived tokens and the member profile' "$(tail -3 "$work/fake-gitlab.log")"

GL_DRIVER_TOKEN="drv_$(openssl rand -hex 32)" # the driver's credential; the board records only its SHA-256
if [ -n "$gl_ready" ]; then
    gl_psql "insert into organization (id, name) values ('$GL_ORG', '$GL_ORG') on conflict do nothing" >/dev/null
    env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$GL_PORT" "${LANE_BOARD_BIND[@]}" \
        REPO_CLONE_BASE="$PLAN_BASE" AUTH_MODE=github PUBLIC_URL="$GL_BASE" BATCHES_ENABLED=true \
        GITHUB_APP_CLIENT_ID=lane-client GITHUB_APP_CLIENT_SECRET=lane-secret \
        GITHUB_WEB_URL="$LANE_FAKE_FORGE_URL" GITHUB_API_URL="$LANE_FAKE_FORGE_URL" \
        SESSION_SECRET=a-job-harness-session-secret-32-chars DRIVER_CREDENTIAL_SHA256="$(credential_sha256 "$GL_DRIVER_TOKEN")" \
        NODE_OPTIONS="--require $REPO/scripts/lane-hosts.cjs" LANE_HOSTS="host.docker.internal=$LANE_HOST" \
        node server/dist/offline.js >>"$work/gitlab-server.log" 2>&1 &
    gl_server_pid=$!
    lane_extra_pids="$lane_extra_pids $gl_server_pid"
    lane_extra_pids="${lane_extra_pids# }"
    gl_board_ready() { [ "$(status "$(BASE="$GL_BASE" api GET /api/ready)")" = 200 ]; }
    gl_up=''
    acc_until 40 gl_board_ready && gl_up=1
    [ -n "$gl_up" ] && ok 'the GitLab board comes up' || bad 'the GitLab board comes up' "$(tail -5 "$work/gitlab-server.log")"
fi

GL_MEMBER=''
if [ -n "${gl_up:-}" ]; then
    GL_MEMBER="$(node scripts/publish-member-client.mjs "$GL_BASE" 2>"$work/gitlab-client.err")" || GL_MEMBER=''
    [ -n "$GL_MEMBER" ] && ok 'the member signs in to the board' || bad 'the member signs in to the board' "$(tail -3 "$work/gitlab-client.err")"
fi
GL_CONNECTION=''
if [ -n "$GL_MEMBER" ]; then
    GL_CONNECTION="$(GITLAB_FAKE_REACH_URL="$GL_URL" NODE_EXTRA_CA_CERTS="$GL_TLS/cert.pem" node scripts/gitlab-member-client.mjs connect "$GL_BASE" "$GL_MEMBER" "https://$GL_HOST" "$GL_TLS/cert.pem" "$GL_GROUP" "$GL_PROJECT" "$GL_LOGIN" 2>"$work/gitlab-connect.err")" || GL_CONNECTION=''
    [ -n "$GL_CONNECTION" ] && ok 'the org connects the TLS GitLab and the member links their account' ||
        bad 'the org connects the TLS GitLab and the member links their account' "$(tail -3 "$work/gitlab-connect.err")"
fi

if [ -n "$GL_CONNECTION" ]; then
    gl_driver
    GL_D="$LANE_DIR"
    GL_COMMIT='cd "$WORKDIR" && echo x >lane-change'

    # M1 + M2 + M4: the task clones, waits past a token's refresh window, then publishes. The agent probes its own env.
    gl_calls0="$(gl_line calls "$(gl_summary)")"
    m1="$(gl_job "mkdir -p $GL_D; $GL_COMMIT; $(gl_probe); : >$GL_D/$RUN_ID-m1.ready; $(lane_wait "$GL_D/$RUN_ID-m1.go"); echo \"m1 ran in \$HOSTNAME\"")"
    lane_use "$m1"
    acc_until 180 gl_running "$m1" && lane_await_file 120 "$GL_D/$RUN_ID-m1.ready" && ok 'm1: the agent is running on the checkout cloned from the TLS GitLab' ||
        bad 'm1: the agent is running on the checkout cloned from the TLS GitLab' "job: $(field "$(gl_read "$m1")" status)"
    sleep 20 # inside the 75 s life of the token the clone used, past the board's 60 s refresh window
    m4_mid="$(gl_volume_clean "$m1" && echo clean || echo holds-token)"
    lane_touch "$GL_D/$RUN_ID-m1.go" || bad 'm1: the agent is released' 'the touch failed'
    expect_contains 'm1: the task succeeds' "$(gl_settled "$m1" 240)" succeeded
    m1_out="$(field "$(gl_read "$m1")" output)"

    gl_sum="$(gl_summary "$gl_calls0")"
    # The board opens the MR as the member (no glab in the runner): the fake saw the create made by the member's own holder.
    # The job output's `/-/merge_requests/` is also git's push hint, so it proves nothing here.
    gl_mr="$(printf '%s\n' "$gl_sum" | sed -n 's/^mr //p')"
    case "$gl_mr" in
    "POST:201:$GL_LOGIN") ok "m1: the board opened the merge request as the member" ;;
    *) bad "m1: the board opened the merge request as the member" "mr writes (method:status:holder): $gl_mr" ;;
    esac
    gl_pr_url="$(gl_psql "select pr_url from job_pr where root_job_id = '$m1'")"
    case "$gl_pr_url" in
    */"$GL_PROJECT"/-/merge_requests/[0-9]*) ok 'm1: the recorded publication is that merge request' ;;
    *) bad 'm1: the recorded publication is that merge request' "pr_url: $gl_pr_url" ;;
    esac
    gl_tokens="$(printf '%s\n' "$gl_sum" | sed -n 's/^git //p')"
    gl_authed="$(printf '%s\n' "$gl_tokens" | grep ':200:' || true)"
    [ -n "$gl_authed" ] && ok 'm1: the git calls the GitLab answered carried a token' || bad 'm1: the git calls the GitLab answered carried a token' "git calls: $gl_tokens"
    case "$(printf '%s\n' "$gl_authed" | grep -v ":$GL_LOGIN\$" || true)" in
    '') ok "m1: every authenticated git call was the member's token" ;;
    *) bad "m1: every authenticated git call was the member's token" "$gl_authed" ;;
    esac
    gl_new="$(gl_line pushes "$gl_sum")"
    [ "$gl_new" = 1 ] && ok 'm1: the branch was pushed once' || bad 'm1: the branch was pushed once' "pushes: $gl_new"
    gl_push="$(gl_line push "$gl_sum")"
    case "$gl_push" in
    "$GL_LOGIN|user|Lane Member|lane.member@example.test|factory-ai") ok "m1: the commit is authored by the member's GitLab identity and committed by the bot, pushed with the member's token" ;;
    *) bad "m1: the commit is authored by the member's GitLab identity and committed by the bot, pushed with the member's token" "holder|kind|author|email|committer = $gl_push" ;;
    esac

    # M2: the clone and the push were served different tokens (the rotation).
    gl_distinct="$(printf '%s\n' "$gl_authed" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')"
    [ "$gl_distinct" -ge 2 ] && ok 'm2: the push carried a refreshed token, not the clone'"'"'s' ||
        bad 'm2: the push carried a refreshed token, not the clone'"'"'s' "distinct tokens: $gl_distinct in $gl_authed"

    # M4: nothing durable held a token.
    expect_contains 'm4: the agent env holds no token' "$m1_out" gl-no-env-token
    expect_contains 'm4: the checkout .git/config holds no token' "$m1_out" gl-no-config-token
    expect_contains 'm4: the task volume held no token while the task ran' "$m1_out" gl-no-volume-token
    [ "$m4_mid" = clean ] && ok 'm4: the task volume held no token from outside, mid-task' || bad 'm4: the task volume held no token from outside, mid-task' "$m4_mid"
    gl_volume_clean "$m1" && ok 'm4: the task volume holds no token after the task' || bad 'm4: the task volume holds no token after the task' 'a token is on the volume'
    gl_leaks=''
    for f in "$work/driver.log" "$work/gitlab-server.log" "$work/gitlab-connect.err"; do
        grep -q -e "$GL_PAT" "$f" 2>/dev/null && gl_leaks="$gl_leaks $f"
    done
    case "$m1_out" in *gloas*-fake* | *glrt*-fake*) gl_leaks="$gl_leaks job-output" ;; esac
    [ -z "$gl_leaks" ] && ok 'm4: no token is in the job output, the driver log or the board log' ||
        bad 'm4: no token is in the job output, the driver log or the board log' "found in:$gl_leaks"

    # M3: the driver dies while the agent runs; the next driver takes the runner over, which asks for the token again.
    gl_calls3="$(gl_line calls "$(gl_summary)")"
    m3="$(gl_job "mkdir -p $GL_D; $GL_COMMIT; : >$GL_D/$RUN_ID-m3.ready; $(lane_wait "$GL_D/$RUN_ID-m3.go"); echo \"m3 ran in \$HOSTNAME\"")"
    lane_use "$m3"
    acc_until 180 gl_running "$m3" && lane_await_file 120 "$GL_D/$RUN_ID-m3.ready" && ok 'm3: the agent is running' ||
        bad 'm3: the agent is running' "job: $(field "$(gl_read "$m3")" status)"
    gl_kill_driver
    gl_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
    gl_took() { [ -n "$(grep -F "job $m3:" "$work/driver.log" | grep -e 'took over' -e 'adopted')" ]; }
    acc_until "$ADOPT_S" gl_took && ok 'm3: the next driver takes the running agent over' ||
        bad 'm3: the next driver takes the running agent over' "$(grep -F "job $m3:" "$work/driver.log" | tail -5)"
    lane_touch "$GL_D/$RUN_ID-m3.go" || bad 'm3: the agent is released' 'the touch failed'
    expect_contains 'm3: the task finishes under the adopting driver' "$(gl_settled "$m3" "$ADOPT_S")" succeeded
    gl_sum3="$(gl_summary "$gl_calls3")"
    gl_new3="$(gl_line pushes "$gl_sum3")"
    [ "$gl_new3" = 1 ] && ok 'm3: the branch was pushed once, not again after the takeover' || bad 'm3: the branch was pushed once, not again after the takeover' "pushes: $gl_new3"
    gl_tokens3="$(printf '%s\n' "$gl_sum3" | sed -n 's/^git //p' | grep ':200:' || true)"
    case "$(printf '%s\n' "$gl_tokens3" | grep -v ":$GL_LOGIN\$" || true)" in
    '') ok "m3: the adopting runner's git calls were the member's too" ;;
    *) bad "m3: the adopting runner's git calls were the member's too" "$gl_tokens3" ;;
    esac
    case "$(gl_psql "select status from job where id = '$m3'")" in
    succeeded) ok 'm3: the interruption did not fail the task' ;;
    *) bad 'm3: the interruption did not fail the task' "$(gl_psql "select status from job where id = '$m3'")" ;;
    esac

    # B1: the member starts an automerge batch on the GitLab project. The task's text is a shell script for the stub
    # (`Acceptance:` and `Verification:` are commands it does not find, and the last line decides the exit); the board
    # publishes the merge request as the member, observes it once a passing pipeline is seeded on its head, and merges it
    # as the member with the observed sha. A passing pipeline on the target tip then completes the batch.
    gl_calls_b1="$(gl_line calls "$(gl_summary)")"
    b1_plan="$(gl_batch_plan 'cd "$WORKDIR" && echo x >lane-batch-change')"
    b1_batch="$(field "$(body "$(gl_member_api POST /api/batches "{\"plan\":$b1_plan}")")" id)"
    b1_start="$(status "$(gl_member_api POST "/api/batches/$b1_batch/start" '{"version":1}')")"
    [ "$b1_start" = 200 ] && ok 'b1: the member starts an automerge batch on the GitLab project' ||
        bad 'b1: the member starts an automerge batch on the GitLab project' "start answered $b1_start"
    b1_root=''
    b1_rooted() { b1_root="$(gl_psql "select root_job_id from batch_task where batch_id = '$b1_batch' and root_job_id is not null")"; [ -n "$b1_root" ]; }
    acc_until 120 b1_rooted && ok 'b1: the batch launched its task' || bad 'b1: the batch launched its task' 'no root job'
    [ -n "$b1_root" ] && expect_contains 'b1: the task succeeds' "$(gl_settled "$b1_root" 240)" succeeded
    b1_mr=''
    b1_published() { b1_mr="$(gl_psql "select pr_number || ' ' || head_branch from job_pr where root_job_id = '$b1_root'")"; [ -n "$b1_mr" ]; }
    acc_until 60 b1_published && ok 'b1: the task published a merge request' || bad 'b1: the task published a merge request' 'no job_pr row'
    b1_iid="${b1_mr%% *}"
    b1_branch="${b1_mr#* }"
    if [ -n "$b1_mr" ]; then
        gl_control gitlab/pipelines "{\"project\":\"$GL_PROJECT\",\"ref\":\"$b1_branch\",\"jobs\":[{\"name\":\"test\",\"status\":\"success\"}],\"headOf\":$b1_iid}" >/dev/null
    fi
    b1_merged() { [ "$(gl_psql "select state from batch_merge where batch_id = '$b1_batch' order by id desc limit 1")" = merged ]; }
    acc_until 300 b1_merged && ok 'b1: the board merged the merge request' ||
        bad 'b1: the board merged the merge request' "$(gl_psql "select state, detail from batch_merge where batch_id = '$b1_batch'")"
    b1_sum="$(gl_summary "$gl_calls_b1")"
    b1_puts="$(printf '%s\n' "$b1_sum" | sed -n 's/^mr //p' | grep -c '^PUT:' || true)"
    b1_holder="$(printf '%s\n' "$b1_sum" | sed -n 's/^mr //p' | grep '^PUT:200:' || true)"
    [ "$b1_puts" = 1 ] && [ "$b1_holder" = "PUT:200:$GL_LOGIN" ] && ok "b1: one merge PUT was made, by the member's own token" ||
        bad "b1: one merge PUT was made, by the member's own token" "mr writes: $(printf '%s\n' "$b1_sum" | sed -n 's/^mr //p' | tr '\n' ' ')"
    gl_control gitlab/pipelines "{\"project\":\"$GL_PROJECT\",\"ref\":\"main\",\"jobs\":[{\"name\":\"test\",\"status\":\"success\"}]}" >/dev/null
    b1_done() { [ "$(gl_psql "select completed_at is not null from batch where id = '$b1_batch'")" = t ]; }
    acc_until 300 b1_done && ok 'b1: a passing pipeline on the target tip completes the batch' ||
        bad 'b1: a passing pipeline on the target tip completes the batch' "$(gl_psql "select state, detail from batch_stage_verification where batch_id = '$b1_batch'")"

    # R1 (BEL-539): the review loop on the merge request's discussions. A workflow (the member's own) publishes a change,
    # holds at a barrier, then walks the `builtin/review-reconcile` block. While the barrier holds, another login opens
    # a diff discussion on the merge request, so the block's first collect finds it: the board reads the discussions as
    # the member, the stub's repair node declares a reply and a resolve for every digest key and changes the tree, the
    # push reuses the merge request, and the reply node answers through the board as the member. The next collect finds
    # nothing and the thread rests on REVIEW-CLEAN. The fake's own view is the assertion.
    r1_def="$(node -e 'process.stdout.write(JSON.stringify({ name: "lane-review", scope: "user", definition: { entry: "work", nodes: [
        { name: "work", kind: "agent", session: "resume", publish: true, prompt: "cd \"$WORKDIR\" && echo x >lane-review-base" },
        { name: "hold", kind: "agent", session: "resume", gates: false, prompt: process.argv[1] },
        { name: "review", kind: "block", uses: "builtin/review-reconcile" }],
        edges: [{ from: "work", to: "hold", when: "succeeded" }, { from: "hold", to: "review", when: "succeeded" }] } }))' \
        ": >$GL_D/$RUN_ID-r1.ready; $(lane_wait "$GL_D/$RUN_ID-r1.go")")"
    [ "$(status "$(gl_member_api POST /api/workflows "$r1_def")")" = 201 ] && ok 'r1: the member creates the review workflow' ||
        bad 'r1: the member creates the review workflow' 'POST /api/workflows did not answer 201'
    r1_payload="$(node -e 'process.stdout.write(JSON.stringify({ command: "review loop", executor: "claude", workflow: "lane-review", repo: { forge: "gitlab", host: process.argv[1], path: process.argv[2] } }))' "$GL_HOST" "$GL_PROJECT")"
    r1="$(field "$(body "$(gl_member_api POST /api/jobs "$r1_payload")")" id)"
    lane_use "$r1"
    r1_mr=''
    r1_published() { r1_mr="$(gl_psql "select pr_number from job_pr where root_job_id = '$r1'")"; [ -n "$r1_mr" ]; }
    acc_until 240 r1_published && lane_await_file 120 "$GL_D/$RUN_ID-r1.ready" && ok 'r1: the work node published the merge request and the thread holds' ||
        bad 'r1: the work node published the merge request and the thread holds' "no job_pr row for $r1"
    if [ -n "$r1_mr" ]; then
        r1_position='{"position_type":"text","new_path":"lane-review-base","old_path":"lane-review-base","new_line":1,"old_line":null,"head_sha":"0000000000000000000000000000000000000000"}'
        gl_control gitlab/discussion "{\"project\":\"$GL_PROJECT\",\"iid\":$r1_mr,\"login\":\"lane-reviewer\",\"body\":\"please rename this\",\"position\":$r1_position}" >/dev/null &&
            ok 'r1: another login opens a diff discussion on the merge request' || bad 'r1: another login opens a diff discussion on the merge request' 'the control refused'
        lane_touch "$GL_D/$RUN_ID-r1.go" || bad 'r1: the thread is released' 'the touch failed'
    fi
    r1_rested() { [ "$(gl_psql "select status || ' ' || coalesce(output, '') from job where root_job_id = '$r1' order by created_at desc, id desc limit 1" | grep -c 'succeeded .*REVIEW-CLEAN')" = 1 ]; }
    acc_until 300 r1_rested && ok 'r1: the thread rests on REVIEW-CLEAN after one repair round' ||
        bad 'r1: the thread rests on REVIEW-CLEAN after one repair round' "$(gl_psql "select workflow_node, status from job where root_job_id = '$r1' order by created_at, id" | tr '\n' ' ')"
    r1_token="$(field "$(gl_control gitlab/sign-in "{\"login\":\"$GL_LOGIN\"}")" access_token)"
    r1_view="$(NODE_EXTRA_CA_CERTS="$GL_TLS/cert.pem" node -e 'fetch(process.argv[1] + "/api/v4/projects/" + encodeURIComponent(process.argv[2]) + "/merge_requests/" + process.argv[3] + "/discussions", { headers: { authorization: "Bearer " + process.argv[4] } })
        .then((res) => res.json()).then((threads) => {
            const diff = threads.find((t) => !t.individual_note);
            const notes = diff ? diff.notes : [];
            const own = notes.filter((n) => n.author.username === process.argv[5] && n.body.includes("factory-review-reconcile addressed thread:" + diff.id));
            console.log("notes " + notes.length + " own " + own.length + " resolved " + notes.every((n) => !n.resolvable || n.resolved));
        })' "$GL_URL" "$GL_PROJECT" "${r1_mr:-0}" "$r1_token" "$GL_LOGIN" 2>&1)"
    [ "$r1_view" = 'notes 2 own 1 resolved true' ] && ok "r1: one marked reply by the member, and the discussion is resolved" ||
        bad "r1: one marked reply by the member, and the discussion is resolved" "$r1_view"
    stop_driver
fi
kill "${gl_server_pid:-}" "${gl_fake_pid:-}" 2>/dev/null
wait "${gl_server_pid:-}" "${gl_fake_pid:-}" 2>/dev/null

end_phase
fi
