if selected_phase mcp; then
begin_phase mcp
# --- A task settles through the MCP server ------------------------------------------
#
# The board (AUTH_MODE=github, MCP_ENABLED) and the driver are the real ones, the runner is the prompt-executing
# stub, and the member is signed in through e2e/stub-idp.mjs: the same stand-in the browser specs use, pointed at by
# the board's GITHUB_OAUTH_*_URL overrides. scripts/mcp-phase-client.mjs is a real SDK client: it signs the member in
# over plain HTTP, is sent through discovery, registration, PKCE and consent (approved with the member's session, the
# two calls the consent page makes), and then create_task -> wait_task -> get_task_result -> read_job_log run a task
# on the real driver to `succeeded`. No route exists for this phase: the board is configured, not patched.

echo
echo '# mcp (board + driver + MCP client, stub runner)'

MCP_BASE="http://127.0.0.1:$MCP_PORT"
MCP_ORG=999999 # the installation e2e/stub-idp.mjs reports; the board names the member's organization after it

kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""

STUB_IDP_PORT="$MCP_IDP_PORT" STUB_IDP_INSTALLATIONS="$MCP_ORG" node e2e/stub-idp.mjs >"$work/mcp-idp.log" 2>&1 &
mcp_idp_pid=$!
lane_extra_pids="$lane_extra_pids $mcp_idp_pid"
lane_extra_pids="${lane_extra_pids# }"

# The member's organization has the smoke repository tracked, as the board fixture does for the stand-in member.
compose exec -T postgres psql -U factory -d "$DB" -v ON_ERROR_STOP=1 -c \
    "insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
     values ('$MCP_ORG', 'claude-code', 'test-jobs-mcp', '$SMOKE_REPO', 'main', now(), now())
     on conflict do nothing" >/dev/null 2>&1 || {
    echo "test-jobs: could not select $SMOKE_REPO for the mcp organization"
    exit 1
}

MCP_TOKEN="mcp-$(openssl rand -hex 16)" # the board's and the driver's shared worker secret, 32+ characters
MCP_IDP="http://127.0.0.1:$MCP_IDP_PORT"
env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$MCP_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" AUTH_MODE=github MCP_ENABLED=true PUBLIC_URL="$MCP_BASE" \
    GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
    GITHUB_OAUTH_AUTHORIZE_URL="$MCP_IDP/login/oauth/authorize" GITHUB_OAUTH_USER_URL="$MCP_IDP/user" \
    GITHUB_OAUTH_TOKEN_URL="$MCP_IDP/login/oauth/access_token" \
    SESSION_SECRET=a-job-harness-session-secret-32-chars JOB_BOARD_TOKEN="$MCP_TOKEN" \
    node server/dist/offline.js >>"$work/mcp-server.log" 2>&1 &
server_pid=$!

mcp_up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="$MCP_BASE" api GET /api/ready)")" = '200' ] && {
        mcp_up=1
        break
    }
    sleep 1
done

if [ -z "$mcp_up" ]; then
    bad 'mcp: the board with MCP_ENABLED came up' "$(tail -5 "$work/mcp-server.log")"
else
    ok 'mcp: the board with MCP_ENABLED came up'
    disruption_driver JOB_BOARD_URL="$MCP_BASE" JOB_BOARD_TOKEN="$MCP_TOKEN"

    mcp_out="$work/mcp-client.out"
    MCP_BOARD="$MCP_BASE" MCP_RUN_ID="$RUN_ID" timeout 240 node scripts/mcp-phase-client.mjs >"$mcp_out" 2>"$work/mcp-client.err"
    mcp_exit=$?
    while IFS="$(printf '\t')" read -r kind name detail; do
        case "$kind" in
        ok) ok "$name" ;;
        bad) bad "$name" "$detail" ;;
        id) printf '%s\n' "$name" >>"$work/created-jobs" ;;
        esac
    done <"$mcp_out"
    [ "$mcp_exit" -eq 0 ] || bad 'mcp: the client exited cleanly' "exit $mcp_exit: $(tail -3 "$work/mcp-client.err")"
    stop_driver
fi

# The last phase: nothing after it needs the open board, so the board is just stopped.
kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""

fi
