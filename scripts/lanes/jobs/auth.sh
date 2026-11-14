if selected_phase auth; then
begin_phase auth
# --- The same board, with auth on -------------------------------------------------------------
#
# Everything above runs against AUTH_MODE=none, which is what this script has always been and what
# it must keep exercising: that mode is what `npm run seed`, the route harness and `git clone && npm
# run dev` all depend on. This section is the other half — the only end-to-end proof that the two
# credentials really are disjoint, that a human cannot claim a lease and a worker cannot queue a job.

echo
echo '# auth'

kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""

AUTH_BASE="http://127.0.0.1:$AUTH_PORT"
# The lane driver's own credential: the board is started with its SHA-256 only.
AUTH_CREDENTIAL="drv_$(printf '%064d' 1)"

env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$AUTH_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" \
    AUTH_MODE=github \
    GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
    SESSION_SECRET=a-job-harness-session-secret-32-chars \
    DRIVER_CREDENTIAL_SHA256="$(credential_sha256 "$AUTH_CREDENTIAL")" \
    node server/dist/offline.js >"$work/auth-server.log" 2>&1 &
server_pid=$!

up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="$AUTH_BASE" api GET /api/health)")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done

if [ -z "$up" ]; then
    bad 'the authenticated board came up' "$(tail -5 "$work/auth-server.log")"
else
    ok 'the authenticated board came up'

    # Open, because the compose healthcheck carries no credential and this route has to answer
    # while the migrations are still retrying.
    expect_status_at "$AUTH_BASE" 'health stays open'           200 GET /api/health
    expect_status_at "$AUTH_BASE" 'the dashboard needs a login' 401 GET '/api/stats?range=all'
    # The route docs/security.md calls remote code execution. This is the assertion the whole
    # change exists for.
    expect_status_at "$AUTH_BASE" 'queueing a job needs a login' 401 POST /api/jobs '{"command":"rm -rf /"}'
    expect_status_at "$AUTH_BASE" 'claiming needs a worker token' 401 POST /api/jobs/claim '{"worker":"driver-1"}'

    # The credential whose SHA-256 the board recorded at boot: the board never held this value.
    token="$AUTH_CREDENTIAL"

    claim="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs/claim '{"worker":"harness-driver"}')"
    case "$(status "$claim")" in
    200 | 204) ok 'the driver credential claims' ;;
    *) bad 'the driver credential claims' "got $(status "$claim"): $(body "$claim")" ;;
    esac

    # The other direction, and the one that is easy to get wrong: a credential that may claim work
    # must not be able to create it, or the job it queues has no author.
    queued="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs '{"command":"echo hi"}')"
    if [ "$(status "$queued")" = '401' ]; then
        ok 'a worker token cannot queue a job'
    else
        bad 'a worker token cannot queue a job' "got $(status "$queued")"
    fi
fi

# The phases below drive the open board again (the question round trip queues jobs on $BASE), so
# the authenticated board hands the port pair back to it — same database, same stand-in member.
kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""
start_open_board

fi
