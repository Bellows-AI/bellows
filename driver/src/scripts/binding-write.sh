# Writes the holder binding a live supervisor follows (issue #829): stdin is the body, $2 its byte
# count, $1 the supervisor-only binding directory. The body goes to a temp file beside the target and
# is renamed over it only once all $2 bytes have arrived, so a supervisor never reads half a binding;
# a short stdin leaves the old file intact (exit 65). The body holds the token: it is never echoed.
# Usage: <binding dir> <byte count>, body on stdin
set -eu
dir=$1
size=$2
umask 077
tmp="$dir/.binding.$$"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
got=$(wc -c < "$tmp" | tr -d ' ')
if [ "$got" != "$size" ]; then
    echo 'binding-write: the binding arrived short' >&2
    exit 65
fi
mv -f "$tmp" "$dir/binding.json"
