if selected_phase services || selected_phase orphan-reaper || selected_phase node-disruption ||
    selected_phase driver-kill || selected_phase run-deadline || selected_phase capacity || selected_phase mcp; then
begin_phase service-fixture
mkdir -p "$work/svc"
printf '%s\n' \
    '#!/bin/sh' \
    'while true; do' \
    "    printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\n\\r\\nservice-is-up' | nc -l -p 8000" \
    'done' >"$work/svc/serve.sh"
printf 'FROM alpine:3\nCOPY serve.sh /serve.sh\nCMD ["sh","/serve.sh"]\n' >"$work/svc/Dockerfile"
docker build -q -t "$IMAGE_SVC" "$work/svc" >/dev/null || {
    echo 'test-jobs: could not build the service stub image'
    exit 1
}
mkdir -p "$work/run"
printf '#!/bin/sh\nfor last in "$@"; do :; done\nexec sh -c "$last"\n' >"$work/run/run.sh"
# `sh /run.sh` rather than exec-ing it: a file written by this script has no exec bit to copy in.
printf 'FROM %s\nCOPY run.sh /run.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/run.sh"]\n' "$IMAGE_BASE" >"$work/run/Dockerfile"
docker build -q -t "$IMAGE_RUN" "$work/run" >/dev/null || {
    echo 'test-jobs: could not build the runner-exec stub image'
    exit 1
}

fi
