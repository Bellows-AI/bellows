if selected_phase workflows; then
begin_phase workflows
# --- Workflows -------------------------------------------------------------------------------
#
# Issue #94, end to end. A workflow definition lives on the board (created through the API, the
# way the composer's dropdown is fed), and the board walks the graph: fetch → implement →
# review(BLOCKERS-marker) → fix → review(publish-marker) → publish. The echo stub makes every
# run's output deterministic, which is what lets marker edges decide the walk on a real board.
# A second and a third task are then walked BY HAND through the claim API, where the claim body
# itself is the assertion: the publish flag is true on the publish node's claim and false on every
# other, and a bounded edge rests the thread instead of walking past its limit.

echo
echo '# workflows'

# The stub walk. The marker contract rides the templates: review ends with the fix node's output
# tail — empty on round one (the BLOCKERS-marker shape), the fix marker on round two (the publish
# shape) — so the SAME deterministic stub output walks a different edge the second time through.
cat >"$work/stub-walk.json" <<'JSON'
{
  "name": "stub-walk",
  "scope": "org",
  "definition": {
    "entry": "fetch",
    "nodes": [
      { "name": "fetch", "kind": "agent", "session": "resume", "prompt": "fetch the issue" },
      { "name": "implement", "kind": "agent", "session": "resume", "prompt": "implement it\n{{fetch.output}}" },
      { "name": "review", "kind": "agent", "session": "fresh", "gates": false, "prompt": "review the work\n{{fix.output}}" },
      { "name": "fix", "kind": "agent", "session": "resume", "prompt": "fix it\n{{review.output}}\nFIXED-ONE-ROUND" },
      { "name": "publish", "kind": "agent", "session": "resume", "publish": true, "prompt": "ship it" }
    ],
    "edges": [
      { "from": "fetch", "to": "implement", "when": "succeeded" },
      { "from": "implement", "to": "review", "when": "succeeded" },
      { "from": "review", "to": "fix", "when": { "marker": "review the work" }, "max": 1 },
      { "from": "review", "to": "publish", "when": { "marker": "FIXED-ONE-ROUND" } },
      { "from": "fix", "to": "review", "when": "succeeded" }
    ]
  }
}
JSON
expect_status 'creates the stub workflow' 201 POST /api/workflows "$(cat "$work/stub-walk.json")"
expect_status 'the stub workflow is listed' 200 GET /api/workflows
expect_status 'refuses a pasted foreign pipeline' 400 POST /api/workflows \
    '{"name":"foreign","scope":"org","definition":{"nodes":[],"edges":[],"trigger":"on-push"}}'
expect_status 'refuses an unknown workflow name' 404 POST /api/jobs "{\"command\":\"x\",\"workflow\":\"ghost\",\"repo\":\"$SMOKE_REPO\"}"

# Thread reads, in node, because the assertions below walk arrays — no jq in the harness.
thread_nodes() { # thread_nodes <root-id> -> the node labels, oldest first, space-separated
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(t.map((j)=>j.workflowNode??"-").join(" "))})'
}
thread_session() { # thread_session <root-id> <index> -> that row's sessionId
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.sessionId??""))})' "$2"
}
thread_command() { # thread_command <root-id> <index> -> that row's command
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.command??""))})' "$2"
}

start_driver "$IMAGE_OK"
walked="$(api POST /api/jobs "{\"command\":\"walk me end to end\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf_id="$(field "$(body "$walked")" id)"
printf '%s\n' "$wf_id" >>"$work/created-jobs"

# The board walks while the driver runs: wait until the thread holds all six nodes and the last is
# terminal — the walk is the BOARD's, so the row count is the assertion, not one job's verdict.
walk_done=""
for _ in $(seq 1 120); do
    nodes="$(thread_nodes "$wf_id")"
    last_status="$(api GET "/api/jobs/$wf_id/thread" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[t.length-1]?.status??""))})')"
    if [ "$nodes" = 'fetch implement review fix review publish' ] && [ "$last_status" != queued ] && [ "$last_status" != running ]; then
        walk_done=1
        break
    fi
    sleep 1
done
if [ -n "$walk_done" ]; then ok 'the board walked fetch→implement→review→fix→review→publish'; else
    bad 'the board walked fetch→implement→review→fix→review→publish' "nodes: '$(thread_nodes "$wf_id")' last: '$last_status'"; fi

# The interpolation proof: the implement row's command is the template FILLED with the fetch row's
# output tail — the prompt that reached the stub container, not the {{...}} skeleton.
expect_contains 'the implement prompt carries the fetch output' "$(thread_command "$wf_id" 1)" 'fetch the issue'
expect_contains 'the fix prompt carries the review output'       "$(thread_command "$wf_id" 3)" 'review the work'

# The session proof: resume nodes (fetch, implement, fix, publish) carry the primary session; the
# fresh review rows do not — one worktree, N sessions.
primary="$(thread_session "$wf_id" 0)"
case "$primary" in
????????-????-????-????-????????????) ok 'the entry run reported a session' ;;
*) bad 'the entry run reported a session' "got '$primary'" ;;
esac
[ "$(thread_session "$wf_id" 1)" = "$primary" ] && ok 'implement resumed the primary session' ||
    bad 'implement resumed the primary session' "got '$(thread_session "$wf_id" 1)'"
[ "$(thread_session "$wf_id" 3)" = "$primary" ] && ok 'fix resumed the primary session' ||
    bad 'fix resumed the primary session' "got '$(thread_session "$wf_id" 3)'"
review1="$(thread_session "$wf_id" 2)"
review2="$(thread_session "$wf_id" 4)"
if [ -n "$review1" ] && [ "$review1" != "$primary" ] && [ -n "$review2" ] && [ "$review2" != "$primary" ] && [ "$review1" != "$review2" ]; then
    ok 'the review rounds ran fresh'
else
    bad 'the review rounds ran fresh' "review sessions: '$review1' '$review2' primary: '$primary'"
fi
stop_driver

# The claim-level assertions, walked by hand with the driver parked. The stub's walk is
# deterministic, so each complete below decides the next edge exactly as a real run would.
claim_walk() { # claim_walk <output> -> "id<TAB>leaseToken<TAB>publish" of the claimed row
    claim="$(api POST /api/jobs/claim '{"worker":"walker","leaseSeconds":300}')"
    if [ "$(status "$claim")" = '204' ]; then
        printf ''
        return
    fi
    node -e 'const c=JSON.parse(process.argv[1]);process.stdout.write([c.id,c.leaseToken,c.publish===undefined?"absent":String(c.publish)].join("\t"))' \
        "$(body "$claim")"
    if [ -n "$1" ]; then
        api POST "/api/jobs/$(field "$(body "$claim")" id)/complete" \
            "{\"leaseToken\":\"$(field "$(body "$claim")" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"$1\"}" >/dev/null
    fi
}
walk_flag() { # walk_flag <name> <got> <want>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "publish wanted '$3', got '$2'"; fi
}

# Task two: the publish flag. Every node's claim says false until the graph's publish node — six
# claims to walk the whole graph: fetch, implement, review, fix, the second review, then publish.
wf2="$(api POST /api/jobs "{\"command\":\"flag walk\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf2_id="$(field "$(body "$wf2")" id)"
printf '%s\n' "$wf2_id" >>"$work/created-jobs"
walk_out="$(claim_walk 'fetch the issue')"
walk_flag 'the fetch claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'implement it')"
walk_flag 'the implement claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'review the work')"
walk_flag 'the review claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the fix claim may not publish'       "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the second review claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'ship it')"
walk_flag 'the publish node claim may publish'  "$(printf '%s' "$walk_out" | cut -f3)" true

# Task three: the loop bound. The second review names the fix marker AGAIN, but review→fix is
# bounded at one and the fix row already exists — the board rests the thread instead.
wf3="$(api POST /api/jobs "{\"command\":\"bound walk\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf3_id="$(field "$(body "$wf3")" id)"
printf '%s\n' "$wf3_id" >>"$work/created-jobs"
claim_walk 'fetch the issue' >/dev/null
claim_walk 'implement it' >/dev/null
claim_walk 'review the work' >/dev/null
claim_walk 'fixed' >/dev/null
claim_walk 'review the work' >/dev/null
if [ "$(acc_poll 'fetch implement review fix review' 10 thread_nodes "$wf3_id")" = 'fetch implement review fix review' ]; then
    ok 'the bounded edge rests the loop at its limit'
else
    bad 'the bounded edge rests the loop at its limit' "nodes: '$(thread_nodes "$wf3_id")'"
fi
expect_status 'a rested thread offers nothing more' 204 POST /api/jobs/claim '{"worker":"idle-walker"}'

fi
