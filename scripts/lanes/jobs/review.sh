if selected_phase review; then
begin_phase review
# --- The in-band reviewer ---------------------------------------------------------
#
# A task asks for a named review and waits on it, with ONE driver slot: the review is a step of the
# caller's own task group, run in the group's `reviewer` container (uid 1002, the shared clone
# read-only), never a queued job, never a container of its own. The stub image answers the reviewer
# as a scripted reviewer (scripts/stub-agent.sh, review mode): it names its executor and uid, tries
# a write into the clone and reports whether it failed, and ends on the verdict line. The first
# review holds for a while (a marker in the profile's instructions), long enough for a second key
# to meet it and for the containers to be counted.

echo
echo '# review'

mkdir -p "$work/review"
cat >"$work/review/review-caller.cjs" <<'CALLER'
const http = require('node:http');
const socketPath = `${process.env.FACTORY_CTL_OUT}/control.sock`;
const call = (method, path, body) =>
    new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
const ask = (key) => call('POST', '/review', JSON.stringify({ key, profile: 'audit' }));
(async () => {
    console.log('first=' + (await ask('rv-a')).status);
    if (process.argv.slice(2).join(' ').includes('REVIEW-SECOND')) {
        const second = await ask('rv-b');
        console.log('second=' + second.status + ' ' + second.text);
    }
    let last;
    for (let i = 0; i < 150; i++) {
        last = await call('GET', '/review/rv-a');
        if (JSON.parse(last.text).done) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('final=' + last.text);
    const reread = await call('GET', '/review/rv-a');
    console.log('reread=' + reread.status + ' ' + reread.text);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
CALLER
printf 'FROM %s\nCOPY review-caller.cjs /review-caller.cjs\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","node","/review-caller.cjs"]\n' "$IMAGE_BASE" >"$work/review/Dockerfile"
docker build -q -t "$IMAGE_REVIEW" "$work/review" >/dev/null || {
    echo 'test-jobs: could not build the review caller image'
    exit 1
}

write_bellows 'reviewers:
  - name: audit
    instructions: "Audit the tree. STUB-REVIEW-HOLD-20"
    timeout: 5'
start_driver "$IMAGE_REVIEW" 0 1

jobs_seen() { docker ps -a --filter 'label=factory.job' --filter "label=factory.board=$(board_id)" --format '{{.ID}} {{.Label "factory.job"}} {{.Label "factory.role"}}'; }
jobs_seen | cut -d' ' -f1 | sort -u >"$work/review-before"

rv="$(create_job 'review REVIEW-SECOND')"
: >"$work/review-seen"
: >"$work/review-user"
rv_until=$(($(date +%s) + 180))
while [ -z "$(settled "$rv")" ] && [ "$(date +%s)" -lt "$rv_until" ]; do
    jobs_seen | grep -v -F -f "$work/review-before" >>"$work/review-seen"
    for c in $(grep ' reviewer$' "$work/review-seen" | cut -d' ' -f1 | sort -u); do
        [ -s "$work/review-user" ] || docker inspect -f '{{.Config.User}}' "$c" >"$work/review-user" 2>/dev/null
    done
    sleep 1
done
expect_contains 'a caller that requests a review and waits on it completes with one driver slot' "$(await_settled "$rv" 120)" succeeded
rv_out="$(field "$(body "$(api GET "/api/jobs/$rv")")" output)"
expect_contains 'the first request starts the review'            "$rv_out" 'first=201'
expect_contains 'a second concurrent key is refused 409'          "$rv_out" 'second=409'
expect_contains 'the refusal says the first review is running'    "$rv_out" 'is running'
expect_contains 'the review ends clean'                           "$rv_out" 'verdict":"clean'
expect_contains 'the review ran as uid 1002'                      "$rv_out" 'uid=1002'
expect_contains 'the review could not write the shared tree'      "$rv_out" 'tree-write=denied'
expect_contains 'the stored key reads back after the review'      "$rv_out" 'reread=200'
rv_reviewers="$(grep -c ' reviewer$' <(sort -u "$work/review-seen"))"
rv_foreign="$(sort -u "$work/review-seen" | awk -v job="$rv" '$2 != job' | wc -l | tr -d ' ')"
[ "$rv_reviewers" = 1 ] && ok 'the group has exactly one reviewer container' ||
    bad 'the group has exactly one reviewer container' "$rv_reviewers seen: $(sort -u "$work/review-seen" | tr '\n' ';')"
[ "$rv_foreign" = 0 ] && ok 'no container besides the group'"'"'s was created for the review' ||
    bad 'no container besides the group'"'"'s was created for the review' "$(sort -u "$work/review-seen" | tr '\n' ';')"
case "$(cat "$work/review-user")" in
1002:*) ok 'the reviewer container is created as uid 1002' ;;
*) bad 'the reviewer container is created as uid 1002' "user: '$(cat "$work/review-user")'" ;;
esac

# The opencode executor reaches the same reviewer container through its own entrypoint.
rvo="$(create_job 'review' opencode)"
expect_contains 'an opencode caller completes its review' "$(await_settled "$rvo" 180)" succeeded
rvo_out="$(field "$(body "$(api GET "/api/jobs/$rvo")")" output)"
expect_contains 'the opencode review ran through opencode-executor' "$rvo_out" 'executor=opencode-executor'
expect_contains 'the opencode review ends clean'                   "$rvo_out" 'verdict":"clean'

# Clear the reviewer plan before later phases reuse the smoke repository.
write_bellows ''
stop_driver
fi
