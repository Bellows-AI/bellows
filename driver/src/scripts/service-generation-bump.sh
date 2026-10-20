# The supervisor's half of a declared service's kubernetes restart (issue #773): `acked` names, one
# per line, every service whose probe has not acknowledged its current generation ($ACKS/<name>/ack
# against $GENERATIONS/<name>, absent read as 0) and exits 3 when any has not; `bump` refuses the
# same way, and otherwise moves every named service's generation on by one, each written beside its
# file and renamed over it, so a probe never reads half a number. Exit 2 is a name that is no plain
# service name. Usage: <acked|bump> <generations dir> <acks dir> <name>...
mode=$1
generations=$2
acks=$3
shift 3
case $mode in
    acked | bump) ;;
    *) exit 2 ;;
esac
for service in "$@"; do
    case $service in
        '' | *[!a-z0-9-]*) exit 2 ;;
    esac
done
unacked=0
for service in "$@"; do
    current=$(cat "$generations/$service" 2>/dev/null) || current=0
    acked=$(cat "$acks/$service/ack" 2>/dev/null) || acked=
    if [ "$acked" != "${current:-0}" ]; then
        printf '%s\n' "$service"
        unacked=1
    fi
done
[ "$unacked" = 0 ] || exit 3
[ "$mode" = bump ] || exit 0
for service in "$@"; do
    current=$(cat "$generations/$service" 2>/dev/null) || current=0
    printf '%s\n' "$((${current:-0} + 1))" >"$generations/.$service.next" || exit 1
    mv -f "$generations/.$service.next" "$generations/$service" || exit 1
done
exit 0
