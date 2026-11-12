if selected_phase mcp; then
begin_phase mcp
# --- The board-hosted MCP server behind the chart (BEL-108) ---------------------------------------
#
# The chart renders MCP off and https-only (phase one asserts that and the ingress routing); this phase turns it on
# in the running dashboard and makes one client pass through the port-forward, as a client behind the ingress would
# reach it: the discovery documents, the host and credential gates, then the SDK client (scripts/mcp-kind-client.mjs).
# No identity provider runs on kind, so the OAuth access token is minted into the database where the code exchange
# would have put it, as the member's personal access token is above; the OAuth flow itself runs on the docker lane
# (`test:jobs --phase mcp`). The dashboard is returned to its MCP-off state at the end, so the phases after this one
# (bench) see the board they always saw.

echo
echo '# mcp'

MCP_PUBLIC_HOST=board.kind.example
mcp_kubectl() { # mcp_kubectl <seconds> <what> <kubectl args...> -> the call, bounded; a failure is reported and returned
    local secs="$1" what="$2" out
    shift 2
    out="$(bounded "$secs" kubectl --request-timeout=20s "$@" 2>&1)" || {
        bad "mcp: $what" "${out:0:300}"
        return 1
    }
}
mcp_restart_board() { # mcp_restart_board <what> -> the dashboard rolled out and answering through a fresh port-forward
    local until
    bounded 210 kubectl rollout status "deployment/$RELEASE-factory" -n "$NAMESPACE" --timeout=180s >/dev/null 2>&1 || {
        bad "mcp: $1: the dashboard rolls out" "$(bounded 20 kubectl get pods -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s 2>&1 | tail -4)"
        return 1
    }
    kill "$pf_pid" 2>/dev/null
    wait "$pf_pid" 2>/dev/null
    kubectl port-forward "svc/$RELEASE-factory" "$PORT:8080" -n "$NAMESPACE" >>"$PF_LOG" 2>&1 &
    pf_pid=$!
    until=$(($(date +%s) + 120))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(http_status GET "$BASE/api/ready")" = '200' ] && return 0
        sleep 1
    done
    bad "mcp: $1: the board answers through the port-forward" "$(tail -3 "$PF_LOG")"
    return 1
}

mcp_ready=''
if mcp_kubectl 40 'MCP is enabled under an https origin' set env "deployment/$RELEASE-factory" -n "$NAMESPACE" \
    "PUBLIC_URL=https://$MCP_PUBLIC_HOST" MCP_ENABLED=true && mcp_restart_board 'enabled'; then
    read -r MCP_TOKEN mcp_hash < <(node -e '
const c = require("node:crypto");
const t = "mat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
    mcp_minted="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -q -v ON_ERROR_STOP=1 -v "org=$member" -v "user=$member_user" -v "hash=$mcp_hash" \
        -v "resource=https://$MCP_PUBLIC_HOST/api/mcp" \
        postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into oauth_client (client_id, kind, client_name, redirect_uris)
values ('test-k8s-mcp', 'dcr', 'test-k8s', array['http://127.0.0.1:59174/callback'])
on conflict do nothing;
with f as (
    insert into oauth_grant_family (client_id, user_id, org_id, resource, scopes, expires_at)
    values ('test-k8s-mcp', :'user'::uuid, :'org', :'resource', array['factory:read', 'factory:write'], now() + interval '1 hour')
    returning id
)
insert into oauth_token (token_hash, kind, family_id, scopes, expires_at)
select decode(:'hash', 'hex'), 'access', f.id, array['factory:read', 'factory:write'], now() + interval '1 hour' from f;
SQL
    )" && { ok 'mcp: an access token is minted for the member'; mcp_ready=1; } ||
        bad 'mcp: an access token is minted for the member' "$mcp_minted"
fi
[ -n "$mcp_ready" ] || bad 'mcp: the client pass runs' 'MCP was not enabled or no token was minted, so the client was skipped'
if [ -n "$mcp_ready" ]; then
    mcp_out="$(MCP_BOARD="$BASE" MCP_PUBLIC_HOST="$MCP_PUBLIC_HOST" MCP_TOKEN="$MCP_TOKEN" bounded 120 node scripts/mcp-kind-client.mjs 2>&1)"
    mcp_rc=$?
    saw_check=''
    while IFS=$'\t' read -r kind name detail; do
        case "$kind" in
        ok) ok "$name"; saw_check=1 ;;
        bad) bad "$name" "$detail"; saw_check=1 ;;
        esac
    done <<<"$mcp_out"
    { [ -n "$saw_check" ] && [ "$mcp_rc" -ne 143 ]; } || bad 'mcp: the client pass finishes' "rc $mcp_rc: ${mcp_out:0:300}"
fi

mcp_kubectl 40 'MCP is switched off again' set env "deployment/$RELEASE-factory" -n "$NAMESPACE" \
    "PUBLIC_URL=$BASE" MCP_ENABLED=false && mcp_restart_board 'restored' || true
fi
