# The liveness probe of a declared service's sidecar (issue #773): the kubernetes restart. The
# supervisor bumps the service's generation file ($1/$2); this probe, on its first run in a fresh
# writable layer, records the generation it reads in $4 (default /tmp/.factory-generation) and fails
# from then on once the file says otherwise, so the kubelet restarts the container with a new layer.
# Every run acknowledges the recorded generation in $3/ack, the driver's proof the restart landed.
# Only sh builtins and cat: the image needs sh, cat and a writable /tmp.
generations=$1
service=$2
ack=$3
record=${4:-/tmp/.factory-generation}
current=$(cat "$generations/$service" 2>/dev/null) || current=0
[ -n "$current" ] || current=0
if [ -f "$record" ]; then
    recorded=$(cat "$record") || exit 1
    [ "$recorded" = "$current" ] || exit 1
else
    printf '%s\n' "$current" >"$record" || exit 1
    recorded=$current
fi
printf '%s\n' "$recorded" >"$ack/ack" 2>/dev/null
exit 0
