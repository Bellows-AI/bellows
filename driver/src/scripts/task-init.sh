# Makes the directory of a fresh task volume that a container mounts as a subPath (the reviewer's
# home), group-writable for the task group, before any container mounts it: the kubelet and the
# daemon would otherwise create it root-owned. Idempotent. $1 is the directory.
mkdir -p "$1" && chmod 2775 "$1"
