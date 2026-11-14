# The docker daemon of a docker-class task group: the entrypoint of its `dockerd` native sidecar —
# the digest-pinned dind image, root inside a user-space-kernel sandbox, with NET_ADMIN, SYS_ADMIN
# and NET_RAW added — passed by content as `sh -c <this> dockerd-start`
# (driver/src/k8s/k8s-dockerd.ts). Every step before the daemon is one the sandbox needs:
#
#   maxkeys      the sandbox's key quota is 200, and runc never reclaims a container's session
#                keyring: after about 200 starts no container starts at all
#   ip_forward   the bridge's containers reach the network only through this namespace
#   SNAT         the daemon runs without its own iptables, so the bridge's traffic leaves eth0 as
#                the pod's own address
#   mtu          the bridge takes the pod interface's, never docker's 1500
#   chmod 1777   the temp dir the agent and the gate share with the daemon (TMPDIR), so a bind
#                mount of a client's temp file resolves on the daemon side
#
# The daemon listens on two unix sockets, never TCP, both group 1000 (the executor images' `node`
# group, which the tool uid holds), mode 0660: the shared one only agent, gate and dockerd mount,
# and /var/run/docker.sock in this container's own filesystem, which no other container sees — it
# exists so a client's bind-mount source `/var/run/docker.sock` resolves here. A short shutdown
# timeout keeps the sidecar's SIGTERM from holding up the pod's end.
set -eu

echo 100000 >/proc/sys/kernel/keys/maxkeys
echo 1 >/proc/sys/net/ipv4/ip_forward

mtu=$(cat /sys/class/net/eth0/mtu)
addr=$(ip -4 -o addr show dev eth0 | awk '{ split($4, a, "/"); print a[1]; exit }')
# The sandbox's netstack implements the legacy tables; the dind image ships both front ends.
ipt=iptables
if command -v iptables-legacy >/dev/null 2>&1; then ipt=iptables-legacy; fi
"$ipt" -t nat -A POSTROUTING -o eth0 ! -s "$addr" -j SNAT --to-source "$addr"

chmod 1777 /run/factory-tmp

# The registry mirrors (DOCKERD_MIRRORS, space-separated https:// URLs the driver validated), one
# --registry-mirror each; unset pulls directly. No globbing: an entry is a URL, never a pattern.
set -f
set --
for mirror in ${DOCKERD_MIRRORS:-}; do
    set -- "$@" --registry-mirror "$mirror"
done

exec dockerd --iptables=false --ip6tables=false --mtu "$mtu" --data-root /var/lib/docker \
    -H unix:///run/factory-docker/docker.sock -H unix:///var/run/docker.sock --group 1000 \
    --shutdown-timeout 5 "$@"
