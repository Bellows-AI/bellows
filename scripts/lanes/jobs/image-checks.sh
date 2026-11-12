if selected_phase image-checks; then
begin_phase image-checks
# --- The executor images' own check scripts -----------------------------------------------------
#
# docker/<executor>/test.sh pins what the image bakes (entrypoint contract, managed settings, seeding,
# skills paths, tool uid). Nothing else ran them, so claude-executor's drifted from the entrypoint
# unnoticed. They run offline against the images `make runners` builds.

echo
echo '# executor image checks (docker/<executor>/test.sh against the built images)'

for cli in claude opencode; do
    if ! docker image inspect "$cli-executor" >/dev/null 2>&1; then
        bad "$cli-executor image checks" "the $cli-executor image is missing — run make runners"
        continue
    fi
    if IMAGE="$cli-executor" bash "docker/$cli-executor/test.sh" >"$work/image-checks-$cli.log" 2>&1; then
        ok "$cli-executor image checks ($(tail -n 1 "$work/image-checks-$cli.log" | tr -d '\n'))"
    else
        failed_checks="$(grep -A3 '^FAIL' "$work/image-checks-$cli.log")"
        bad "$cli-executor image checks" "${failed_checks:0:380}"
    fi
done

fi
