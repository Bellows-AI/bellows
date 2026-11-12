if selected_phase pinned-skills; then
begin_phase pinned-skills
# --- Org and workspace skills reach the agent on both runtimes, pinned (BEL-273) ---------------------
#
# An authenticated board (one org, an admin and two members), the real driver and the real claude and
# opencode images against the scripted model. The admin publishes an org skill and member A a workspace
# skill with a helper file, through the real routes. `--skill-sentinel` reports which skill descriptions
# reached the model and `--probe-files` opens the helper files as the tool uid (the last probe, /etc/shadow,
# is the control: a probe that never sees a denial proves nothing). A's task must see both skills; member
# B's only the org one; and a new version of A's skill published after A's task was made, before it was
# claimed, must not change what that task sees (the pin is taken when the row is made). The kubernetes
# half is scripts/test-k8s.sh --cluster (the pinned-skills block).

echo
echo '# pinned skills (board with auth + driver + real claude and opencode, scripted model)'

PS_TOKEN="ps-$(openssl rand -hex 16)" # the board's and the driver's shared worker secret, 32+ characters
PS_ORG="ps-org-$(openssl rand -hex 4)"
PS_DIR=/task/.factory/skills-root/.claude/skills
PS_ORG_SENTINEL=LANE_PIN_ORG_SENTINEL_5d2c
PS_ORG_SKILL=lane-org-skill
PS_WS_SKILL=lane-ws-skill
ps_ws_n=0
ps_ws_id=''
ps_ws_sha=''
ps_pid=''
ps_port=''
ps_admin=''
ps_a=''
ps_b=''

# Text that appears only in one built-in's description, so the scripted model can tell whether the CLI offered it.
PS_CLASH_REPO="${SMOKE_REPO%%/*}/clash" # a second origin whose checkout ships a skill named like the pinned org skill
PS_REPO_SENTINEL=LANE_PIN_REPO_SENTINEL_5d2c
PS_WS_CLASH_REPO="${SMOKE_REPO%%/*}/ws-clash" # an origin whose checkout ships a skill named like the pinned WORKSPACE skill
PS_REPO_WS_SENTINEL=LANE_PIN_REPO_WS_SENTINEL_5d2c
PS_REPO_OTHER_SENTINEL=LANE_PIN_REPO_OTHER_5d2c # .agents/skills: opencode scans it, claude does not
PS_REPO_OTHER_CLAUDE_SENTINEL=LANE_PIN_REPO_OTHER_CLAUDE_5d2c
PS_JIRA_DESC='Jira work items through the jira helper' # no comma: --skill-sentinel splits its value on commas
PS_FIX_DESC='Optional playbook for fixing a backend bug'

ps_switch() { # ps_switch <built-in name> <true|false> -> the org admin's per-org switch for that built-in
    AUTH_HEADER="Bearer $ps_admin" expect_status "pinned skills: the admin sets $1 enabled=$2" 200 PUT "/api/org/skills/builtin/$1/enabled" "{\"enabled\":$2}"
}

ps_ws_sentinel() { printf 'LANE_PIN_WS_SENTINEL_%s_5d2c' "$1"; }

ps_mint() { # ps_mint <login> <admin|member> -> the member's personal token; non-zero with psql's answer
    local token hash out
    read -r token hash < <(node -e '
const c = require("node:crypto");
const t = "fat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
    out="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 \
        -v "org=$PS_ORG" -v "login=$1" -v "role=$2" -v "hash=$hash" -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" -f - 2>&1 <<'SQL'
insert into organization (id, name) values (:'org', :'org') on conflict do nothing;
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
select :'org', 'claude-code', 'test-jobs-pinned-skills', :'owner' || '/' || :'name', 'main', now(), now()
where not exists (select 1 from session_branch where org_id = :'org');
with u as (
    insert into app_user (github_user_id, github_login)
    values ((1000000000 + floor(random() * 1000000000000))::bigint, :'login') returning id
), m as (
    insert into org_membership (org_id, github_login, user_id, role, claimed_at)
    select :'org', :'login', u.id, :'role', now() from u
)
insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
select :'org', 'personal', u.id, u.id, 'test-jobs', decode(:'hash', 'hex') from u;
SQL
    )" || {
        printf '%s' "$out"
        return 1
    }
    printf '%s' "$token"
}

ps_publish() { # ps_publish <token> <route> <name> <sentinel> [skill id] -> {status,id,sha256}; the helper file carries the name
    node scripts/lane-skills.mjs "$BASE" "$1" "$2" "$3" "Lane fixture skill $4 - use it never." ${5:+--id "$5"} "ref/helper.txt=helper of $3"
}

ps_endpoint() { # ps_endpoint <name> <org skill, workspace skills, helper probes> -> ps_pid and ps_port of a scripted model that reports them
    node scripts/fake-model-endpoint.mjs --tool-steps 1 --skill-sentinel "$2" --probe-files "$3" >"$work/fake-$1.port" &
    ps_pid=$!
    lane_endpoint_started "$ps_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$1.port" ] && break
        sleep 0.25
    done
    ps_port="$(cat "$work/fake-$1.port")"
}

ps_point() { # ps_point <claude|opencode> <member token> <port> -> that member's runs reach the scripted model on <port>
    if [ "$1" = opencode ]; then
        AUTH_HEADER="Bearer $2" api PUT /api/workspace/executors "$(node -e 'const config = { model: "anthropic/claude-sonnet-4-5", provider: { anthropic: { options: { baseURL: `http://host.docker.internal:${process.argv[1]}/v1`, apiKey: "fake-key" } } } };
            process.stdout.write(JSON.stringify({ executors: [{ name: "claude", type: "claude-code", config: {} }, { name: "opencode", type: "opencode", config }] }));' "$3")" >/dev/null
    else
        AUTH_HEADER="Bearer $ps_admin" api PUT /api/env/org "{\"vars\":[{\"name\":\"ANTHROPIC_API_KEY\",\"value\":\"fake-key\",\"isSecret\":true},{\"name\":\"ANTHROPIC_BASE_URL\",\"value\":\"http://host.docker.internal:$3\",\"isSecret\":false}]}" >/dev/null
    fi
}

ps_job() { # ps_job <claude|opencode> <member token> [repo] -> the member's new task id
    local payload id
    payload="$(node -e 'process.stdout.write(JSON.stringify({ command: "list your skills", executor: process.argv[1], repo: process.argv[2] }))' "$1" "${3:-$SMOKE_REPO}")"
    id="$(field "$(body "$(AUTH_HEADER="Bearer $2" api POST /api/jobs "$payload")")" id)"
    printf '%s\n' "$id" >>"$work/created-jobs"
    printf '%s' "$id"
}

ps_jira_member() { # ps_jira_member <login> -> a member's token; the member holds one Jira connection, which binds to every task made
    local token user
    token="$(ps_mint "$1" member)" || {
        printf '%s' "$token"
        return 1
    }
    user="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -c "select id from app_user where github_login = '$1'" | tr -d '\r')"
    DATABASE_URL="$DATABASE_URL" LANE_ORG="$PS_ORG" LANE_USER="$user" node --input-type=module -e '
import postgres from "postgres";
import { createConnectionGrants } from "./server/dist/db/connection-grants.js";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const made = await createConnectionGrants({ sql, orgId: process.env.LANE_ORG }).attachGrantConnection({
    principal: { kind: "user", userId: process.env.LANE_USER },
    provider: "jira",
    externalAccountId: "lane-account-" + process.env.LANE_USER,
    authority: { scopes: ["read:jira-work"] },
    resource: { id: "lane-cloud", label: "example.atlassian.net" },
    access: "read",
});
await sql.end();
process.exit(made.ok ? 0 : 1);
' >&2 || return 1
    printf '%s' "$token"
}

ps_clash_repo() { # a bare origin <owner>/clash whose main ships .claude/skills/$PS_ORG_SKILL, and the org's row for it
    docker run --rm -v "$ORIGIN_VOLUME:/origins" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        git init -q --bare -b main "/origins/$1.git"
        git init -q -b main /tmp/seed
        mkdir -p "/tmp/seed/.claude/skills/$2"
        printf "%s\n" "---" "name: $2" "description: Lane fixture skill $3 - use it never." "---" "Nothing to do." >"/tmp/seed/.claude/skills/$2/SKILL.md"
        git -C /tmp/seed add -A
        git -C /tmp/seed -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q -m "repo skill"
        git -C /tmp/seed push -q "/origins/$1.git" main' sh "$PS_CLASH_REPO" "$PS_ORG_SKILL" "$PS_REPO_SENTINEL" || return 1
    compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 -v "org=$PS_ORG" -v "repo=$PS_CLASH_REPO" -f - >/dev/null <<'SQL'
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
values (:'org', 'claude-code', 'test-jobs-pinned-clash', :'repo', 'main', now(), now());
SQL
}

ps_ws_clash_repo() { # a bare origin <owner>/ws-clash: .claude/skills/$PS_WS_SKILL plus two other repo skills, and the org's row for it
    docker run --rm -v "$ORIGIN_VOLUME:/origins" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        git init -q --bare -b main "/origins/$1.git"
        git init -q -b main /tmp/seed
        skill() { # skill <dir> <name> <sentinel>
            mkdir -p "/tmp/seed/$1/$2"
            printf "%s\n" "---" "name: $2" "description: Lane fixture skill $3 - use it never." "---" "Nothing to do." >"/tmp/seed/$1/$2/SKILL.md"
        }
        skill .claude/skills "$2" "$3"
        skill .agents/skills lane-repo-other "$4"
        skill .claude/skills lane-repo-other-claude "$5"
        git -C /tmp/seed add -A
        git -C /tmp/seed -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q -m "repo skills"
        git -C /tmp/seed push -q "/origins/$1.git" main' sh "$PS_WS_CLASH_REPO" "$PS_WS_SKILL" "$PS_REPO_WS_SENTINEL" "$PS_REPO_OTHER_SENTINEL" "$PS_REPO_OTHER_CLAUDE_SENTINEL" || return 1
    compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 -v "org=$PS_ORG" -v "repo=$PS_WS_CLASH_REPO" -f - >/dev/null <<'SQL'
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
values (:'org', 'claude-code', 'test-jobs-pinned-ws-clash', :'repo', 'main', now(), now());
SQL
}

ps_get() { # ps_get <url> -> the body
    node -e 'fetch(process.argv[1]).then((r) => r.text()).then((t) => process.stdout.write(t))' "$1"
}

ps_expect() { # ps_expect <name> <got> <want>
    [ "$2" = "$3" ] && ok "$1" || bad "$1" "got '$2', want '$3'"
}

ps_probe() { # ps_probe <tool-results json> <n> -> that probe's outcome
    node -e 'const m = new RegExp("^PROBE " + process.argv[2] + " (.*)$", "m").exec(JSON.parse(process.argv[1]).text); console.log(m ? m[1] : "missing")' "$1" "$2"
}

ps_seen() { # ps_seen <skills-seen json> <sentinel> -> yes|no
    node -e 'console.log(JSON.parse(process.argv[1]).seenSentinels.includes(process.argv[2]) ? "yes" : "no")' "$1" "$2"
}

ps_count() { # ps_count <skills-seen json> <sentinel> -> how often the richest request carried it (0 when none)
    node -e 'console.log((JSON.parse(process.argv[1]).sentinelCounts ?? {})[process.argv[2]] ?? 0)' "$1" "$2"
}

ps_cli_lane() { # ps_cli_lane <claude|opencode>
    local cli="$1" image="$1-executor" v1 v2 id seen results edit sha_before
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli sees the pinned org and workspace skills" "the $image image is missing — run make runners"
        return
    fi
    v1="$(ps_ws_sentinel "$ps_ws_n")"
    v2="$(ps_ws_sentinel $((ps_ws_n + 1)))"
    stop_driver

    # A's task is made first, then A edits the skill, then the driver claims: the task keeps the version it was made with.
    ps_endpoint "pins-$cli-a" "$PS_ORG_SENTINEL,$v1,$v2" "$PS_DIR/$PS_ORG_SKILL/ref/helper.txt,$PS_DIR/$PS_WS_SKILL/ref/helper.txt,/etc/shadow"
    ps_point "$cli" "$ps_a" "$ps_port"
    id="$(ps_job "$cli" "$ps_a")"
    [ -n "$id" ] && ok "$cli: A's task is queued" || bad "$cli: A's task is queued" 'no id'
    sha_before="$ps_ws_sha"
    edit="$(ps_publish "$ps_a" /api/workspace/skills "$PS_WS_SKILL" "$v2" "$ps_ws_id")"
    ps_ws_n=$((ps_ws_n + 1))
    ps_ws_sha="$(field "$edit" sha256)"
    case "$(field "$edit" status)" in 200 | 201) ok "$cli: A publishes a new version of the workspace skill after the task was made" ;; *) bad "$cli: A publishes a new version of the workspace skill after the task was made" "$edit" ;; esac
    [ -n "$ps_ws_sha" ] && [ "$ps_ws_sha" != "$sha_before" ] && ok "$cli: the new version has other content" || bad "$cli: the new version has other content" "before $sha_before after $ps_ws_sha"

    JOB_BOARD_TOKEN="$PS_TOKEN" RUNNER_SKIP_PERMISSIONS=1 start_driver "$image"
    expect_contains "$cli: A's task succeeds" "$(AUTH_HEADER="Bearer $ps_a" await_settled "$id" 240)" succeeded
    seen="$(ps_get "http://127.0.0.1:$ps_port/skills-seen")"
    results="$(ps_get "http://127.0.0.1:$ps_port/tool-results")"
    ps_expect "$cli: A's task sees the org skill" "$(ps_seen "$seen" "$PS_ORG_SENTINEL")" yes
    ps_expect "$cli: A's task sees its workspace skill at the pinned version" "$(ps_seen "$seen" "$v1")" yes
    ps_expect "$cli: A's task does not see the version published after it was made" "$(ps_seen "$seen" "$v2")" no
    ps_expect "$cli: the org skill's helper file opens for the tool uid" "$(ps_probe "$results" 1)" open
    ps_expect "$cli: the workspace skill's helper file opens for the tool uid" "$(ps_probe "$results" 2)" open
    ps_expect "the control: $cli's tool uid is denied /etc/shadow" "$(ps_probe "$results" 3)" denied
    lane_endpoint_stop "$ps_pid"

    # B is a member of the same org: the org skill, never A's workspace skill (its helper path does not exist for B).
    ps_endpoint "pins-$cli-b" "$PS_ORG_SENTINEL,$v1,$v2,$PS_JIRA_DESC,$PS_FIX_DESC" "$PS_DIR/$PS_ORG_SKILL/ref/helper.txt,$PS_DIR/$PS_WS_SKILL/ref/helper.txt,/etc/shadow"
    ps_point "$cli" "$ps_b" "$ps_port"
    id="$(ps_job "$cli" "$ps_b")"
    expect_contains "$cli: B's task succeeds" "$(AUTH_HEADER="Bearer $ps_b" await_settled "$id" 240)" succeeded
    seen="$(ps_get "http://127.0.0.1:$ps_port/skills-seen")"
    results="$(ps_get "http://127.0.0.1:$ps_port/tool-results")"
    ps_expect "$cli: B's task sees the org skill" "$(ps_seen "$seen" "$PS_ORG_SENTINEL")" yes
    ps_expect "$cli: B's task does not see A's workspace skill" "$(ps_seen "$seen" "$v1")$(ps_seen "$seen" "$v2")" nono
    ps_expect "$cli: the org skill's helper file opens for B's tool uid" "$(ps_probe "$results" 1)" open
    case "$(ps_probe "$results" 2)" in open | missing) bad "$cli: A's workspace skill is not installed for B" "probe 2: $(ps_probe "$results" 2)" ;; *) ok "$cli: A's workspace skill is not installed for B" ;; esac
    # BEL-286: B's task has no Jira binding, so factory-jira is not in what the model is offered; a built-in with no
    # requirement is (the control: a probe that sees neither proves nothing).
    ps_expect "$cli: a task with no Jira binding is not offered factory-jira" "$(ps_seen "$seen" "$PS_JIRA_DESC")" no
    ps_expect "the control: $cli's task is offered an unrestricted built-in" "$(ps_seen "$seen" "$PS_FIX_DESC")" yes
    lane_endpoint_stop "$ps_pid"

    # BEL-286: a member who holds a Jira connection has it bound to the task when it is made, so factory-jira is listed.
    local ps_c
    ps_c="$(ps_jira_member "ps-member-c-$cli")" && ok "$cli: a member holding a Jira connection is minted" || bad "$cli: a member holding a Jira connection is minted" "$ps_c"
    AUTH_HEADER="Bearer $ps_c" expect_status "$cli: the Jira member stores the task executors" 200 PUT /api/workspace/executors \
        '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}'
    ps_endpoint "pins-$cli-jira" "$PS_JIRA_DESC,$PS_FIX_DESC" "/etc/shadow"
    ps_point "$cli" "$ps_c" "$ps_port"
    id="$(ps_job "$cli" "$ps_c")"
    expect_contains "$cli: the Jira member's task succeeds" "$(AUTH_HEADER="Bearer $ps_c" await_settled "$id" 240)" succeeded
    seen="$(ps_get "http://127.0.0.1:$ps_port/skills-seen")"
    ps_expect "$cli: a task that holds Jira is offered factory-jira" "$(ps_seen "$seen" "$PS_JIRA_DESC")" yes
    ps_expect "the control: $cli's Jira task is offered an unrestricted built-in" "$(ps_seen "$seen" "$PS_FIX_DESC")" yes
    lane_endpoint_stop "$ps_pid"

    # BEL-286: an org admin's switch hides a built-in from the next task of every member, and switching it back on
    # lists it again; the pin is taken when the task is made, so only a task made after the flip sees the change.
    ps_switch factory-fix false
    ps_endpoint "pins-$cli-off" "$PS_FIX_DESC" "/etc/shadow"
    ps_point "$cli" "$ps_b" "$ps_port"
    id="$(ps_job "$cli" "$ps_b")"
    expect_contains "$cli: a task made with a built-in switched off succeeds" "$(AUTH_HEADER="Bearer $ps_b" await_settled "$id" 240)" succeeded
    ps_expect "$cli: a switched-off built-in is not offered" "$(ps_seen "$(ps_get "http://127.0.0.1:$ps_port/skills-seen")" "$PS_FIX_DESC")" no
    lane_endpoint_stop "$ps_pid"
    ps_switch factory-fix true
    ps_endpoint "pins-$cli-on" "$PS_FIX_DESC" "/etc/shadow"
    ps_point "$cli" "$ps_b" "$ps_port"
    id="$(ps_job "$cli" "$ps_b")"
    expect_contains "$cli: a task made after the switch is back on succeeds" "$(AUTH_HEADER="Bearer $ps_b" await_settled "$id" 240)" succeeded
    ps_expect "$cli: the built-in is offered again after the switch is back on" "$(ps_seen "$(ps_get "http://127.0.0.1:$ps_port/skills-seen")" "$PS_FIX_DESC")" yes
    lane_endpoint_stop "$ps_pid"

    # BEL-286: a checkout that ships a skill named like a pinned org skill keeps its own copy, and the org copy is not
    # installed at all (the driver's install step reads the checkout).
    ps_endpoint "pins-$cli-clash" "$PS_ORG_SENTINEL,$PS_REPO_SENTINEL" "$PS_DIR/$PS_ORG_SKILL/ref/helper.txt"
    ps_point "$cli" "$ps_b" "$ps_port"
    id="$(ps_job "$cli" "$ps_b" "$PS_CLASH_REPO")"
    expect_contains "$cli: a task whose repo ships the org skill's name succeeds" "$(AUTH_HEADER="Bearer $ps_b" await_settled "$id" 240)" succeeded
    seen="$(ps_get "http://127.0.0.1:$ps_port/skills-seen")"
    ps_expect "$cli: the repo's own copy is offered" "$(ps_seen "$seen" "$PS_REPO_SENTINEL")" yes
    ps_expect "$cli: the pinned org copy is not offered beside it" "$(ps_seen "$seen" "$PS_ORG_SENTINEL")" no
    case "$(ps_probe "$(ps_get "http://127.0.0.1:$ps_port/tool-results")" 1)" in
        open) bad "$cli: the pinned org copy is not installed" "its helper file opens" ;;
        *) ok "$cli: the pinned org copy is not installed" ;;
    esac
    lane_endpoint_stop "$ps_pid"

    # A checkout that ships a skill named like a pinned WORKSPACE skill loses to it: one copy is listed, the
    # workspace one, and the repo's other skills still are. The org skill (no clash here) is the one-copy baseline.
    local ws_now ws_n_org ws_n_ws
    ws_now="$(ps_ws_sentinel "$ps_ws_n")"
    ps_endpoint "pins-$cli-wsclash" "$PS_ORG_SENTINEL,$ws_now,$PS_REPO_WS_SENTINEL,$PS_REPO_OTHER_SENTINEL,$PS_REPO_OTHER_CLAUDE_SENTINEL" "$PS_DIR/$PS_WS_SKILL/ref/helper.txt,/etc/shadow"
    ps_point "$cli" "$ps_a" "$ps_port"
    id="$(ps_job "$cli" "$ps_a" "$PS_WS_CLASH_REPO")"
    expect_contains "$cli: a task whose repo ships the workspace skill's name succeeds" "$(AUTH_HEADER="Bearer $ps_a" await_settled "$id" 240)" succeeded
    seen="$(ps_get "http://127.0.0.1:$ps_port/skills-seen")"
    results="$(ps_get "http://127.0.0.1:$ps_port/tool-results")"
    ps_expect "$cli: a workspace skill named like a repo skill is offered from the workspace" "$(ps_seen "$seen" "$ws_now")$(ps_seen "$seen" "$PS_REPO_WS_SENTINEL")" yesno
    ws_n_org="$(ps_count "$seen" "$PS_ORG_SENTINEL")"
    ws_n_ws="$(ps_count "$seen" "$ws_now")"
    [ "$ws_n_ws" -ge 1 ] && [ "$ws_n_ws" = "$ws_n_org" ] && ok "$cli: the workspace skill is listed exactly once" || bad "$cli: the workspace skill is listed exactly once" "workspace copy listed $ws_n_ws time(s), the org baseline $ws_n_org"
    ps_expect "$cli: the repo's other .claude skill is still offered" "$(ps_seen "$seen" "$PS_REPO_OTHER_CLAUDE_SENTINEL")" yes
    if [ "$cli" = opencode ]; then
        ps_expect "$cli: the repo's .agents skill is still offered through the view" "$(ps_seen "$seen" "$PS_REPO_OTHER_SENTINEL")" yes
    else
        ps_expect "the control: $cli does not scan .agents" "$(ps_seen "$seen" "$PS_REPO_OTHER_SENTINEL")" no
    fi
    ps_expect "$cli: the workspace skill's helper opens for the tool uid" "$(ps_probe "$results" 1)" open
    ps_expect "the control: $cli's tool uid is denied /etc/shadow beside the clash" "$(ps_probe "$results" 2)" denied
    lane_endpoint_stop "$ps_pid"
    stop_driver
}

pinned_skills_lane() {
    local out a_status
    kill "$server_pid" 2>/dev/null
    wait "$server_pid" 2>/dev/null
    server_pid=""
    env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
        REPO_CLONE_BASE="$PLAN_BASE" \
        AUTH_MODE=github \
        GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
        SESSION_SECRET=a-job-harness-session-secret-32-chars \
        JOB_BOARD_TOKEN="$PS_TOKEN" \
        node server/dist/offline.js >>"$work/pinned-skills-board.log" 2>&1 &
    server_pid=$!
    local up=''
    for _ in $(seq 1 40); do
        [ "$(status "$(api GET /api/ready)")" = '200' ] && {
            up=1
            break
        }
        sleep 1
    done
    [ -n "$up" ] && ok 'pinned skills: the authenticated board came up' || {
        bad 'pinned skills: the authenticated board came up' "$(tail -5 "$work/pinned-skills-board.log")"
        return
    }
    ps_admin="$(ps_mint ps-admin admin)" && ps_a="$(ps_mint ps-member-a member)" && ps_b="$(ps_mint ps-member-b member)" || {
        bad 'pinned skills: an admin and two members are minted' "$ps_admin $ps_a $ps_b"
        return
    }
    ok 'pinned skills: an admin and two members are minted'
    for tok in "$ps_a" "$ps_b"; do
        AUTH_HEADER="Bearer $tok" expect_status 'pinned skills: the member stores the task executors' 200 PUT /api/workspace/executors \
            '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}'
    done

    out="$(ps_publish "$ps_admin" /api/org/skills "$PS_ORG_SKILL" "$PS_ORG_SENTINEL")"
    expect_field 'pinned skills: the admin publishes an org skill' "$out" status 201
    out="$(ps_publish "$ps_a" /api/workspace/skills "$PS_WS_SKILL" "$(ps_ws_sentinel 0)")"
    expect_field 'pinned skills: member A publishes a workspace skill' "$out" status 201
    ps_ws_id="$(field "$out" id)"
    ps_ws_sha="$(field "$out" sha256)"
    out="$(ps_publish "$ps_a" /api/org/skills lane-member-org-skill LANE_PIN_NOPE_5d2c)"
    expect_field 'pinned skills: a member cannot publish an org skill' "$out" status 403
    AUTH_HEADER="Bearer $ps_b" expect_status "pinned skills: member B cannot read A's workspace skill" 404 GET "/api/workspace/skills/$ps_ws_id"

    ps_clash_repo && ok 'pinned skills: a second origin ships a repo skill named like the org skill' || bad 'pinned skills: a second origin ships a repo skill named like the org skill' 'could not seed it'
    ps_ws_clash_repo && ok 'pinned skills: a third origin ships a repo skill named like the workspace skill' || bad 'pinned skills: a third origin ships a repo skill named like the workspace skill' 'could not seed it'
    ps_cli_lane claude
    ps_cli_lane opencode
}

pinned_skills_lane

# The open board takes the port back for the phases after this one.
kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""
start_open_board

fi
