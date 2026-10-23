# Helpers the kubernetes and docker acceptance phases share (scripts/test-k8s.sh, scripts/test-jobs.sh),
# sourced after each lane's own ok/bad. Pinned by driver/test/lane-stubs.test.ts.

acc_poll() { # acc_poll <want> <seconds> <function> [arg...] -> the function's last answer, once it equals <want> or the time is up
    # A read that failed on a loaded host answers "unread" or nothing and is asked again; only the last answer is judged.
    local want="$1" until=$(($(date +%s) + $2)) got=''
    shift 2
    while :; do
        got="$("$@")"
        [ "$got" = "$want" ] && break
        [ "$(date +%s)" -lt "$until" ] || break
        sleep 3
    done
    printf '%s' "$got"
}

acc_transcript() { # acc_transcript <board base> <id> <session> <first> <last> [lossy] -> "exact" when the job's artifact read is records first..last, whole
    # Every page of the read, followed by cursor; the streams must be complete, the chunks gapless from the
    # byte where record <first> starts, and the text exactly those records. Anything else says why;
    # a read that did not answer 200 with a well-formed body says "unread: ..." and is never "no transcript".
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-transcript.mjs" "$1/api/jobs/$2/artifacts" "$3" "$4" "$5" "${6-}"
}
