if selected_phase gitlab; then
begin_phase gitlab
# --- A GitLab task as the member, on a real apiserver -----------------------------------------------
#
# A TLS fake GitLab (scripts/fake-forge, its own pod and Service named for the release; the certificate is the lane's and
# is the connection's CA bundle) and an admin member minted into the database. scripts/gitlab-member-client.mjs connects
# the org to the fake, activates it and links the member through the board's own routes: the board is reached through the
# lane's port-forward, the fake through a second one for the lane's own calls. The tokens live 75 s, so a task that waits
# past the board's refresh window is served a new one.
#   g1  a task clones and pushes as the member: every authenticated git call is the member's, the pushed commit is authored
#       by the member's GitLab name and commit email and committed by the bot; the agent, the checkout's .git/config and
#       the task volume hold no token, nor do the pod specs, the job output or the driver and board logs
#   g2  the token rotates inside the task: the push carries a refreshed token, not the clone's
#   g3  the runner pod is deleted mid-task: the replacement restores the checkout and asks again; the task finishes with one
#       push, still the member's, after exactly one interruption
#   g4  the driver is deleted mid-task: the replacement takes the running agent over, which asks again; one push
#   g5  the board, not the runner, opens the merge request as the member (the driver asks the board; no driver change)
# Not exercised in the sandbox this lane was written in (no docker, no cluster): it runs with the project's end-of-run lanes.

echo
echo '# gitlab: member-authenticated git against a TLS fake GitLab'

GLK_NAME="$RELEASE-fake-gitlab"
GLK_PORT=8443
GLK_FWD=18443
GLK_HOST="$GLK_NAME:$GLK_PORT"
GLK_LOGIN='lane-member'
GLK_GROUP='lane-group'
GLK_PROJECT="$GLK_GROUP/web"
GLK_TTL_S=75
GLK_TLS="$work/gitlab-tls"
GLK_D=/task/.lane-gitlab- # flat files under /task, as every other phase's barriers: the stub makes no directory
GLK_PAT='gloas'"-fake"'\|glrt'"-fake" # the fake's token prefixes, split so this file never holds one
glk_saved_token="${FACTORY_TOKEN:-}"
glk_pf_pid=''

glk_control() { # glk_control <path> [json] -> the fake's answer body, through the lane's port-forward
    local json="${2-}"
    [ -n "$json" ] || json='{}'
    NODE_EXTRA_CA_CERTS="$GLK_TLS/cert.pem" node scripts/gitlab-member-client.mjs control "https://localhost:$GLK_FWD" "$1" "$json"
}
glk_calls() { # glk_calls -> the fake's call log copied to $work/glk-calls.jsonl; non-zero when the read failed
    bounded 30 kubectl exec "pod/$GLK_NAME" -n "$NAMESPACE" --request-timeout=20s -- cat /tmp/forge-state/calls.jsonl >"$work/glk-calls.jsonl" 2>/dev/null
}
glk_summary() { # glk_summary [skip calls] -> scripts/gitlab-member-client.mjs summary of a fresh copy of the log
    glk_calls || return 1
    node scripts/gitlab-member-client.mjs summary "$work/glk-calls.jsonl" "$GLK_PROJECT" "${1:-0}"
}
glk_line() { # glk_line <key> <summary> -> the value of the first "<key> <value>" line
    printf '%s\n' "$2" | sed -n "s/^$1 //p" | sed -n 1p
}
glk_queue() { # glk_queue <command> -> the member's new GitLab task id, empty when the board refused it
    local id
    id="$(ACC_AUTH="Bearer $FACTORY_TOKEN" node "$REPO/scripts/acceptance-job.mjs" POST "$BASE/api/jobs" id \
        "$(node -e 'process.stdout.write(JSON.stringify({ command: process.argv[1], executor: "claude", repo: { forge: "gitlab", host: process.argv[2], path: process.argv[3] } }))' "$1" "$GLK_HOST" "$GLK_PROJECT")")"
    case "$id" in unread:* | refused:*) ;; *) printf '%s' "$id" ;; esac
}
glk_holds() { # glk_holds -> success when the token pattern is on stdin (reads it all)
    [ -n "$(grep -e "$GLK_PAT" || true)" ]
}
glk_leaks() { # glk_leaks <job id> -> where a token was found outside the task volume: pod specs, job output, driver and board logs
    local found=''
    kubectl get pods -n "$NAMESPACE" -o yaml --request-timeout=30s 2>/dev/null | glk_holds && found="$found pod-specs"
    job_output "$1" | glk_holds && found="$found job-output"
    driver_logs | glk_holds && found="$found driver-log"
    kubectl logs -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=dashboard" -n "$NAMESPACE" --tail=-1 --request-timeout=30s 2>/dev/null | glk_holds && found="$found board-log"
    printf '%s' "${found# }"
}
glk_volume_leak() { # glk_volume_leak <runner pod> -> files on the task volume that hold a token, read from the supervisor container
    bounded 30 kubectl exec "$1" -c supervisor -n "$NAMESPACE" --request-timeout=20s -- sh -c 'grep -rIl -e "$1" /task 2>/dev/null' sh "$GLK_PAT"
}
glk_cleanup() {
    [ -z "$glk_pf_pid" ] || { kill "$glk_pf_pid" 2>/dev/null; wait "$glk_pf_pid" 2>/dev/null; glk_pf_pid=''; }
    FACTORY_TOKEN="$glk_saved_token"
    export FACTORY_TOKEN
}

glk_ready=''
mkdir -p "$GLK_TLS"
fake_gitlab_created=1 # set first: cleanup() deletes what a partial setup left
if openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=lane-gitlab' \
    -addext "subjectAltName=DNS:$GLK_NAME,DNS:localhost" -keyout "$GLK_TLS/key.pem" -out "$GLK_TLS/cert.pem" >/dev/null 2>&1 &&
    kubectl create configmap "$GLK_NAME" -n "$NAMESPACE" --from-file=scripts/fake-forge >/dev/null &&
    kubectl create secret generic "$GLK_NAME" -n "$NAMESPACE" --from-file="$GLK_TLS/cert.pem" --from-file="$GLK_TLS/key.pem" >/dev/null &&
    kubectl apply -n "$NAMESPACE" -f - >/dev/null <<GLKPOD; then
apiVersion: v1
kind: Pod
metadata:
    name: $GLK_NAME
    labels:
        app.kubernetes.io/name: $GLK_NAME
spec:
    containers:
        - name: forge
          image: $STUB_REF
          command: ["node", "/forge/server.mjs", "/tmp/forge-state", "$GLK_PORT"]
          env:
              - { name: FAKE_FORGE_HOST, value: "0.0.0.0" }
              - { name: FAKE_FORGE_TLS_CERT, value: /tls/cert.pem }
              - { name: FAKE_FORGE_TLS_KEY, value: /tls/key.pem }
          ports:
              - containerPort: $GLK_PORT
          readinessProbe:
              httpGet: { path: /_control/calls, port: $GLK_PORT, scheme: HTTPS }
              periodSeconds: 2
          volumeMounts:
              - { name: forge, mountPath: /forge }
              - { name: tls, mountPath: /tls }
    volumes:
        - name: forge
          configMap: { name: $GLK_NAME }
        - name: tls
          secret: { secretName: $GLK_NAME }
---
apiVersion: v1
kind: Service
metadata:
    name: $GLK_NAME
spec:
    selector:
        app.kubernetes.io/name: $GLK_NAME
    ports:
        - port: $GLK_PORT
GLKPOD
    kubectl wait --for=condition=Ready --timeout=120s "pod/$GLK_NAME" -n "$NAMESPACE" >/dev/null 2>&1 && glk_ready=1
fi
[ -n "$glk_ready" ] && ok 'the TLS fake GitLab is up' || bad 'the TLS fake GitLab is up' "$(kubectl describe pod "$GLK_NAME" -n "$NAMESPACE" 2>&1 | tail -5)"

if [ -n "$glk_ready" ]; then
    # The runner's own git (and the supervised steps') need the instance's smart-HTTP: the stub image's `git http-backend`.
    case "$(kubectl exec "pod/$GLK_NAME" -n "$NAMESPACE" --request-timeout=20s -- git http-backend </dev/null 2>&1)" in
    *'is not a git command'*)
        bad 'the stub image serves git smart-HTTP for the fake GitLab' 'git http-backend is missing from the image'
        glk_ready=''
        ;;
    *) ok 'the stub image serves git smart-HTTP for the fake GitLab' ;;
    esac
fi
if [ -n "$glk_ready" ]; then
    kubectl port-forward "pod/$GLK_NAME" "$GLK_FWD:$GLK_PORT" -n "$NAMESPACE" >>"$work/glk-port-forward.log" 2>&1 &
    glk_pf_pid=$!
    glk_forwarded() { glk_control gitlab/token-ttl "{\"seconds\":$GLK_TTL_S}" >/dev/null 2>&1; }
    acc_until 30 glk_forwarded && ok 'the lane reaches the fake GitLab through its port-forward' ||
        { bad 'the lane reaches the fake GitLab through its port-forward' "$(tail -3 "$work/glk-port-forward.log")"; glk_ready=''; }
fi
if [ -n "$glk_ready" ]; then
    glk_control gitlab/projects "{\"path\":\"$GLK_PROJECT\",\"files\":{\"README.md\":\"hello\"}}" >/dev/null &&
        glk_control gitlab/user-profile "{\"login\":\"$GLK_LOGIN\",\"fields\":{\"name\":\"Lane Member\",\"commit_email\":\"lane.member@example.test\",\"public_email\":\"\"}}" >/dev/null &&
        ok 'the fake GitLab holds a project and the member profile' ||
        { bad 'the fake GitLab holds a project and the member profile' 'a control call failed'; glk_ready=''; }
fi

glk_connected=''
if [ -n "$glk_ready" ]; then
    # An admin member: the first to sign in to a new org, through the fake GitHub like the smoke member.
    glk_login="glk-$(openssl rand -hex 4)"
    if lane_member "$glk_login" >"$work/glk-member.out" 2>&1; then
        ok 'an admin member signs in and holds a personal access token'
    else
        bad 'an admin member signs in and holds a personal access token' "$(cat "$work/glk-member.out")"
    fi
    glk_token="$MINTED_TOKEN"
    glk_org="$MINTED_ORG"
    FACTORY_TOKEN="$glk_token"
    export FACTORY_TOKEN
    store_executor && ok 'the member stores the task executor' || bad 'the member stores the task executor' 'the PUT never answered 200'
    if GLK_CONNECTION="$(GITLAB_FAKE_REACH_URL="https://localhost:$GLK_FWD" NODE_EXTRA_CA_CERTS="$GLK_TLS/cert.pem" \
        node scripts/gitlab-member-client.mjs connect "$BASE" "$glk_token" "https://$GLK_HOST" "$GLK_TLS/cert.pem" "$GLK_GROUP" "$GLK_PROJECT" "$GLK_LOGIN" 2>"$work/glk-connect.err")"; then
        ok 'the org connects the TLS GitLab and the member links their account'
        glk_connected=1
    else
        bad 'the org connects the TLS GitLab and the member links their account' "$(tail -3 "$work/glk-connect.err")"
    fi
fi

if [ -n "$glk_connected" ]; then
    # G1 + G2: clone, probe, wait past the refresh window, publish.
    glk_calls0="$(glk_line calls "$(glk_summary)")"
    g1="$(glk_queue "factory-stub-change factory-stub-tokenless factory-stub-wait-${GLK_D}g1")"
    if [ -z "$g1" ]; then
        bad 'g1: the board queues the GitLab task' 'it refused the create'
    else
        g1_pod="$(await_runner_pod "$g1")"
        [ -n "$g1_pod" ] && await_blocked "$g1_pod" "${GLK_D}g1" && ok 'g1: the agent is running on the checkout cloned from the TLS GitLab' ||
            bad 'g1: the agent is running on the checkout cloned from the TLS GitLab' "runner pod '$g1_pod'"
        sleep 20 # inside the 75 s life of the token the clone used, past the board's 60 s refresh window
        glk_held="$(glk_volume_leak "$g1_pod")"
        [ -z "$glk_held" ] && ok 'g1: the task volume held no token from outside, mid-task' || bad 'g1: the task volume held no token from outside, mid-task' "files: $glk_held"
        release_stub "${GLK_D}g1"
        await_brief "$g1" 'succeeded|*' 240 >/dev/null && ok 'g1: the task succeeds' || bad 'g1: the task succeeds' "$(job_brief "$g1")"
        g1_out="$(job_output "$g1")"
        expect_contains 'g1: the agent env holds no token' "$g1_out" gl-no-env-token
        expect_contains 'g1: the checkout .git/config holds no token' "$g1_out" gl-no-config-token
        expect_contains 'g1: the task volume held no token while the agent ran' "$g1_out" gl-no-volume-token
        glk_sum="$(glk_summary "$glk_calls0")"
        glk_authed="$(printf '%s\n' "$glk_sum" | sed -n 's/^git //p' | grep ':200:' || true)"
        [ -n "$glk_authed" ] && ok 'g1: the git calls the GitLab answered carried a token' || bad 'g1: the git calls the GitLab answered carried a token' "$glk_sum"
        case "$(printf '%s\n' "$glk_authed" | grep -v ":$GLK_LOGIN\$" || true)" in
        '') ok "g1: every authenticated git call was the member's token" ;;
        *) bad "g1: every authenticated git call was the member's token" "$glk_authed" ;;
        esac
        [ "$(glk_line pushes "$glk_sum")" = 1 ] && ok 'g1: the branch was pushed once' || bad 'g1: the branch was pushed once' "$(glk_line pushes "$glk_sum")"
        case "$(glk_line push "$glk_sum")" in
        "$GLK_LOGIN|user|Lane Member|lane.member@example.test|factory-ai") ok "g1: the commit is authored by the member's GitLab identity and committed by the bot, pushed with the member's token" ;;
        *) bad "g1: the commit is authored by the member's GitLab identity and committed by the bot, pushed with the member's token" "holder|kind|author|email|committer = $(glk_line push "$glk_sum")" ;;
        esac
        glk_distinct="$(printf '%s\n' "$glk_authed" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')"
        [ "$glk_distinct" -ge 2 ] && ok 'g2: the push carried a refreshed token, not the clone'"'"'s' ||
            bad 'g2: the push carried a refreshed token, not the clone'"'"'s' "distinct tokens: $glk_distinct in $glk_authed"
        glk_where="$(glk_leaks "$g1")"
        [ -z "$glk_where" ] && ok 'g1: no token is in the pod specs, the job output or the driver and board logs' ||
            bad 'g1: no token is in the pod specs, the job output or the driver and board logs' "found in: $glk_where"
    fi

    # G3: the runner pod is lost mid-task; the replacement restores the checkout and asks the board again.
    glk_calls3="$(glk_line calls "$(glk_summary)")"
    g3="$(glk_queue "factory-stub-change factory-stub-wait-${GLK_D}g3")"
    if [ -z "$g3" ]; then
        bad 'g3: the board queues the GitLab task' 'it refused the create'
    else
        g3_pod="$(await_runner_pod "$g3")"
        [ -n "$g3_pod" ] && await_blocked "$g3_pod" "${GLK_D}g3" && ok 'g3: the agent is running' || bad 'g3: the agent is running' "runner pod '$g3_pod'"
        kubectl delete pod "$g3_pod" -n "$NAMESPACE" --grace-period=0 --force --request-timeout=30s >/dev/null 2>&1
        release_stub "${GLK_D}g3"
        await_brief "$g3" 'succeeded|*' "$ORPHANED_S" >/dev/null && ok 'g3: the task finishes after the runner was lost' || bad 'g3: the task finishes after the runner was lost' "$(job_brief "$g3")"
        g3_brief="$(job_brief "$g3")"
        case "$g3_brief" in
        'succeeded|'*'|1|'*) ok 'g3: the loss is one interruption, not a failure' ;;
        *) bad 'g3: the loss is one interruption, not a failure' "$g3_brief" ;;
        esac
        glk_sum3="$(glk_summary "$glk_calls3")"
        [ "$(glk_line pushes "$glk_sum3")" = 1 ] && ok 'g3: the branch was pushed once' || bad 'g3: the branch was pushed once' "$(glk_line pushes "$glk_sum3")"
        case "$(printf '%s\n' "$glk_sum3" | sed -n 's/^git //p' | grep ':200:' | grep -v ":$GLK_LOGIN\$" || true)" in
        '') ok "g3: the replacement's git calls were the member's too" ;;
        *) bad "g3: the replacement's git calls were the member's too" "$glk_sum3" ;;
        esac
    fi

    # G4: the driver is lost mid-task; its replacement takes the running agent over, which asks again.
    glk_calls4="$(glk_line calls "$(glk_summary)")"
    g4="$(glk_queue "factory-stub-change factory-stub-patient factory-stub-wait-${GLK_D}g4")"
    if [ -z "$g4" ]; then
        bad 'g4: the board queues the GitLab task' 'it refused the create'
    else
        g4_pod="$(await_runner_pod "$g4")"
        [ -n "$g4_pod" ] && await_blocked "$g4_pod" "${GLK_D}g4" && ok 'g4: the agent is running' || bad 'g4: the agent is running' "runner pod '$g4_pod'"
        kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force --request-timeout=30s >/dev/null 2>&1
        await_brief "$g4" "*|*|1|*|$EXPIRED*" "$ORPHANED_S" >/dev/null && ok 'g4: the replacement driver records the lost one as an interruption' ||
            bad 'g4: the replacement driver records the lost one as an interruption' "$(job_brief "$g4")"
        release_stub "${GLK_D}g4"
        await_brief "$g4" 'succeeded|*' "$ORPHANED_S" >/dev/null && ok 'g4: the task finishes under the replacement driver' || bad 'g4: the task finishes under the replacement driver' "$(job_brief "$g4")"
        glk_sum4="$(glk_summary "$glk_calls4")"
        [ "$(glk_line pushes "$glk_sum4")" = 1 ] && ok 'g4: the branch was pushed once' || bad 'g4: the branch was pushed once' "$(glk_line pushes "$glk_sum4")"
        case "$(printf '%s\n' "$glk_sum4" | sed -n 's/^git //p' | grep ':200:' | grep -v ":$GLK_LOGIN\$" || true)" in
        '') ok "g4: every authenticated git call was the member's" ;;
        *) bad "g4: every authenticated git call was the member's" "$glk_sum4" ;;
        esac
    fi

    # G5: the board, not the runner, opens the merge request, as the member; the driver is unchanged on Kubernetes.
    glk_calls5="$(glk_line calls "$(glk_summary)")"
    g5="$(glk_queue "factory-stub-change")"
    if [ -z "$g5" ]; then
        bad 'g5: the board queues the GitLab task' 'it refused the create'
    else
        await_brief "$g5" 'succeeded|*' "$ORPHANED_S" >/dev/null && ok 'g5: the task finishes' || bad 'g5: the task finishes' "$(job_brief "$g5")"
        glk_mr="$(printf '%s\n' "$(glk_summary "$glk_calls5")" | sed -n 's/^mr //p')"
        case "$glk_mr" in
        "POST:201:$GLK_LOGIN") ok 'g5: the board opened the MR as the member' ;;
        *) bad 'g5: the board opened the MR as the member' "mr writes (method:status:holder): $glk_mr" ;;
        esac
    fi
fi

glk_cleanup
end_phase
fi
