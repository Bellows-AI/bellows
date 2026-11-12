if selected_phase services; then
begin_phase services
# --- Auxiliary services (.bellows.yaml) -------------------------------------------------------
#
# Issue #6, end to end: a checkout declares a service, the driver starts it in the network
# namespace of the task's group supervisor, whose hosts file names it on loopback (issue #773), and
# the runner and the gate container reach it by name. The stub runner is the one image here whose
# entrypoint EXECUTES the prompt (the driver always puts it last in the argv), so the job's output
# is the hosts entry and an HTTP fetch of `http://stub-svc:8000/probe` — the assertion fails unless
# the name resolves to 127.0.0.1 and the service answers there.

echo
echo '# services'

# The author and their tree, learned the way the board phase learns one: a probe claim, completed
# immediately so the FIFO below is not holding a live lease.
wp_id="$(create_job 'services probe')"
wp_claim="$(body "$(api POST /api/jobs/claim '{"worker":"svc-probe","leaseSeconds":300}')")"
wp="$(field "$wp_claim" workspacePath)"
case "$wp" in
default/????????-????-????-????-????????????) ;;
*) bad 'the services probe claim carries a workspace path' "got '$wp'" ;;
esac
api POST "/api/jobs/$wp_id/complete" \
    "{\"leaseToken\":\"$(field "$wp_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# The service: a one-file HTTP responder on busybox nc — current alpine:3 ships no httpd applet,
# and the answer is deliberately static so the assertion reads the alias, not the server. The
# runner-exec image: a script that runs the prompt, which the echo stubs cannot do.
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"

start_driver "$IMAGE_RUN" 1

svc="$(create_job 'grep -E "^127\.0\.0\.1[[:space:]]+stub-svc$" /etc/hosts && wget -qO- http://stub-svc:8000/probe')"
expect_contains 'a declared service is reachable by name' "$(await_settled "$svc")" succeeded
svc_out="$(field "$(body "$(api GET "/api/jobs/$svc")")" output)"
expect_contains 'the service answered the runner'           "$svc_out" service-is-up
expect_contains 'the name resolves to 127.0.0.1 for the agent' "$svc_out" '127.0.0.1'

# The gate container shares the same namespace: a declared gate that passes only when the name is
# on its loopback and the service answers there. The gate image is the service stub's alpine.
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC
environment:
    image: $IMAGE_SVC
    gates:
        - name: reach
          command: 'grep -Eq \"^127\\.0\\.0\\.1[[:space:]]+stub-svc\$\" /etc/hosts && wget -qO- http://stub-svc:8000/probe'"
gated="$(create_job 'echo the agent ran')"
expect_contains 'the gate reaches the service by name on 127.0.0.1' "$(await_settled "$gated" 120)" succeeded

# The refusal path, end to end: a file the parser refuses fails the job with the reason, and the
# runner never spawns — the output is the parse error alone.
write_bellows 'services:
  - name: db
    image: postgres
    ports: ["5432:5432"]'
broken="$(create_job 'echo must not run')"
expect_contains 'a malformed file fails the job' "$(await_settled "$broken")" failed
expect_contains 'the parse reason comes back'    "$(field "$(body "$(api GET "/api/jobs/$broken")")" output)" '.bellows.yaml'

stop_driver

# Nothing of THIS RUN's jobs may survive the driver, and no job made a network of its own: the
# services share their group supervisor's namespace (issue #773). Scoped to the ids this script
# created — the daemon may be serving a live deployment whose factory.job containers and
# factory-job-* networks are none of this suite's business.
svc_networks=0
leftover=0
leftover_names=''
for job in $(cat "$work/created-jobs" 2>/dev/null); do
    n="$(docker network ls --filter "name=factory-job-$job-" --format '{{.Name}}' | wc -l | tr -d ' ')"
    svc_networks=$((svc_networks + n))
    # Each survivor is named with its image and state, so a failure says what was left, not just how many.
    left="$(docker ps -a --filter "label=factory.job=$job" --format '{{.Names}} ({{.Image}}, {{.Status}})')"
    if [ -n "$left" ]; then
        leftover=$((leftover + $(printf '%s\n' "$left" | wc -l | tr -d ' ')))
        leftover_names="$leftover_names $(printf '%s' "$left" | tr '\n' ';')"
    fi
done
if [ "$svc_networks" = '0' ]; then ok 'no job made a network of its own'; else bad 'no job made a network of its own' "$svc_networks found"; fi
if [ "$leftover" = '0' ]; then ok 'no containers left behind'; else bad 'no containers left behind' "$leftover remain:$leftover_names"; fi

fi
