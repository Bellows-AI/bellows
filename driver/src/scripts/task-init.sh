# Makes a directory of a fresh task volume group-writable for the task group, before any container
# mounts it as a subPath (the reviewer's home) or the supervisor creates the thread's directories in
# it: the kubelet and the daemon would otherwise leave it root-owned. Idempotent. $1 is the
# directory; $2, when given, the group it is handed to (the volume root, run as root, as fsGroup does).
mkdir -p "$1" && { [ -z "$2" ] || chgrp "$2" "$1"; } && chmod 2775 "$1"
