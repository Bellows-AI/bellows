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

acc_stored_short() { # acc_stored_short <board base> <id> <session> <first> <last> -> "short" only when the store is confirmed to hold fewer than records first..last
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-transcript.mjs" "$1/api/jobs/$2/artifacts" "$3" "$4" "$5" before-loss
}

acc_job_read() { # acc_job_read <board base> <id> <brief|session|cause> -> the validated value, or "unread: <why>"
    # "brief" is "status|attempts|interruptions|first claimSeq|first reason". A non-200, a body that is not a
    # job object or a field of the wrong shape says "unread"; it is never a value a check can pass on.
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-job.mjs" GET "$1/api/jobs/$2" "$3"
}

acc_post_id() { # acc_post_id <board base> <path> [json] -> the new job's id, empty unless the board answered 201 with one
    # Why not, in $work/acc-post.refusal. Callers read $work from their lane.
    local out
    out="$(node "$(dirname "${BASH_SOURCE[0]}")/acceptance-job.mjs" POST "$1$2" id "${3-}")"
    case "$out" in
    unread:* | refused:*) printf '%s' "$out" >"$work/acc-post.refusal" ;;
    *) printf '%s' "$out" ;;
    esac
}
