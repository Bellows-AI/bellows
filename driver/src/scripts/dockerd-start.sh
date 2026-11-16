# The docker daemon of a docker-class task group: the entrypoint of its `dockerd` native sidecar —
# the digest-pinned dind image, root inside the class's microVM (a Kata RuntimeClass: its own guest
# kernel, the VM the boundary) — passed by content as `sh -c <this> dockerd-start`
# (driver/src/k8s/k8s-dockerd.ts). The daemon owns the guest's network stack, its own iptables
# included. Every step before it is one the guest needs:
#
#   mtu          the bridge takes the pod interface's, never docker's 1500
#   chmod 1777   the temp dir the agent and the gate share with the daemon (TMPDIR), so a bind
#                mount of a client's temp file resolves on the daemon side
#   /dev/kmsg    kind's node containers read it (the kubelet's OOM watcher); the guest's /dev may
#                not hold it, so it is made when absent
#
# The daemon starts through the image's own entrypoint, first argument `dockerd`: that adds no
# --host and no TLS (DOCKER_TLS_CERTDIR is empty besides), and runs the daemon under docker-init
# and the `dind` script, which delegates cgroup v2 to nested kind nodes; every flag below passes
# through. It listens on two unix sockets, never TCP, both group 1000 (the executor images' `node`
# group, which the tool uid holds), mode 0660: the shared one only agent, gate and dockerd mount,
# and /var/run/docker.sock in this container's own filesystem, which no other container sees — it
# exists so a client's bind-mount source `/var/run/docker.sock` resolves here. A short shutdown
# timeout keeps the sidecar's SIGTERM from holding up the pod's end.
set -eu

mtu=$(cat /sys/class/net/eth0/mtu)

chmod 1777 /run/factory-tmp

[ -e /dev/kmsg ] || mknod /dev/kmsg c 1 11

# The registry mirrors (DOCKERD_MIRRORS, space-separated https:// URLs the driver validated), one
# --registry-mirror each; unset pulls directly. No globbing: an entry is a URL, never a pattern.
set -f
set --
for mirror in ${DOCKERD_MIRRORS:-}; do
    set -- "$@" --registry-mirror "$mirror"
done

exec dockerd-entrypoint.sh dockerd --mtu "$mtu" --data-root /var/lib/docker \
    -H unix:///run/factory-docker/docker.sock -H unix:///var/run/docker.sock --group 1000 \
    --shutdown-timeout 5 "$@"
