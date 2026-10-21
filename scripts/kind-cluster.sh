#!/bin/sh
# A local kind cluster and the registry its nodes pull from, made and unmade in one place.
#
#   sh scripts/kind-cluster.sh create <name>   # make cluster: the cluster, the registry, the mirror
#   LAYOUT=drain sh scripts/kind-cluster.sh create <name>   # make cluster LAYOUT=drain: three workers
#   sh scripts/kind-cluster.sh check <name>    # scripts/test-k8s.sh: refuses a cluster without them
#   sh scripts/kind-cluster.sh delete <name>   # make cleanup: the cluster; the registry with the last one
#
# Images pushed to localhost:5001 on the host reach a node as only the layers it lacks. The registry
# is one container per host, shared by every kind cluster, bound to loopback; each node maps
# localhost:5001 to it through a hosts.toml under the config_path that scripts/kind-cluster.yaml
# sets at creation — the one step that cannot be added to a running cluster.
set -u

REGISTRY_NAME=kind-registry
REGISTRY_HOST=localhost:5001
REGISTRY_PORT=127.0.0.1:5001
CERTS_D=/etc/containerd/certs.d
MIRROR="[host.\"http://$REGISTRY_NAME:5000\"]"

verb="${1:-}"
name="${2:-}"
[ -n "$verb" ] && [ -n "$name" ] || {
    echo 'usage: kind-cluster.sh create|check|delete <name>'
    exit 2
}
here="$(cd "$(dirname "$0")" && pwd)"
# LAYOUT=drain selects scripts/kind-cluster-drain.yaml: three workers, for the lane's node drains.
config="$here/kind-cluster${LAYOUT:+-$LAYOUT}.yaml"
case "${LAYOUT:-}" in
'' | drain) ;;
*)
    echo "kind-cluster: unknown LAYOUT '$LAYOUT' (known: drain, or unset for the default single node)"
    exit 2
    ;;
esac
# The drain layout's nodes bind-mount one host directory per cluster, not one fixed path two clusters share.
shared="${FACTORY_KIND_SHARED:-$HOME/.cache/factory-kind/$name}"

# Fails unless the listing succeeds with at least one node: a silent empty list would skip every check.
nodes() {
    list="$(kind get nodes --name "$name" 2>/dev/null)" && [ -n "$list" ] && printf '%s\n' "$list"
}
mirror_capable() { # mirror_capable <node> — containerd was created reading $CERTS_D
    docker exec "$1" containerd config dump 2>/dev/null | grep -Eq "config_path = [\"']$CERTS_D[\"']"
}
mirrored() { # mirrored <node> — the node's hosts.toml sends $REGISTRY_HOST to the registry
    docker exec "$1" cat "$CERTS_D/$REGISTRY_HOST/hosts.toml" 2>/dev/null | grep -qF "$MIRROR"
}
running() { docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME" 2>/dev/null; }
on_kind_network() {
    [ "$(docker inspect -f '{{if index .NetworkSettings.Networks "kind"}}kind{{end}}' "$REGISTRY_NAME" 2>/dev/null)" = kind ]
}
# Every binding, not any: a registry also published beyond loopback is an open, unauthenticated one.
published() { [ "$(docker port "$REGISTRY_NAME" 5000/tcp 2>/dev/null)" = "$REGISTRY_PORT" ]; }
recreate() {
    echo "kind-cluster: the kind cluster $name was created without containerd's registry config_path,"
    echo "  so its nodes cannot mirror $REGISTRY_HOST. Re-create it: make cleanup CLUSTER=$name, then"
    echo "  make cluster CLUSTER=$name (cleanup deletes the cluster's volumes)."
    exit 1
}
rewire() {
    echo "kind-cluster: $1. Run make cluster CLUSTER=$name."
    exit 1
}
misbound() {
    echo "kind-cluster: the registry container $REGISTRY_NAME is not published on $REGISTRY_PORT."
    echo "  Remove it (docker rm -f $REGISTRY_NAME), then run make cluster CLUSTER=$name."
    exit 1
}

case "$verb" in
create)
    if ! kind get clusters 2>/dev/null | grep -qx "$name"; then
        if [ "${LAYOUT:-}" = drain ]; then
            mkdir -p "$shared" || exit 1
            rendered="$(mktemp)" || exit 1
            sed "s|@SHARED@|$shared|" "$config" >"$rendered" || exit 1
            kind create cluster --name "$name" --config "$rendered" || {
                rm -f "$rendered"
                exit 1
            }
            rm -f "$rendered"
        else
            kind create cluster --name "$name" --config "$config" || exit 1
        fi
    fi
    node_list="$(nodes)" || rewire "no nodes found for the kind cluster $name"
    for node in $node_list; do
        mirror_capable "$node" || recreate
    done
    case "$(running)" in
    true) ;;
    '') docker run -d --restart=always -p "$REGISTRY_PORT:5000" --name "$REGISTRY_NAME" registry:2 >/dev/null || exit 1 ;;
    *) docker start "$REGISTRY_NAME" >/dev/null || exit 1 ;;
    esac
    published || misbound
    on_kind_network || docker network connect kind "$REGISTRY_NAME" || exit 1
    for node in $node_list; do
        printf '%s\n' "$MIRROR" | docker exec -i "$node" sh -c \
            "mkdir -p '$CERTS_D/$REGISTRY_HOST' && cat >'$CERTS_D/$REGISTRY_HOST/hosts.toml'" || exit 1
    done
    ;;
check)
    node_list="$(nodes)" || rewire "no nodes found for the kind cluster $name"
    for node in $node_list; do
        mirror_capable "$node" || recreate
        mirrored "$node" || rewire "node $node does not mirror $REGISTRY_HOST to $REGISTRY_NAME"
    done
    [ "$(running)" = true ] || rewire "the registry container $REGISTRY_NAME is not running"
    on_kind_network || rewire "the registry container $REGISTRY_NAME is not on the kind network"
    published || misbound
    ;;
delete)
    kind delete cluster --name "$name" || exit 1
    # The per-cluster shared directory of the drain layout goes with it; a directory the caller chose stays.
    [ -n "${FACTORY_KIND_SHARED:-}" ] || rm -rf "$HOME/.cache/factory-kind/$name"
    # Only a listing that succeeded and came back empty means no cluster still uses the registry.
    clusters="$(kind get clusters 2>/dev/null)" || exit 1
    if [ -z "$clusters" ]; then
        # Absent is done; present and not removed is a failure, not a silent leftover on the port.
        present="$(docker ps -aq --filter "name=^$REGISTRY_NAME\$")" || exit 1
        if [ -n "$present" ]; then
            docker rm -f -v "$REGISTRY_NAME" >/dev/null || exit 1
        fi
    fi
    ;;
*)
    echo 'usage: kind-cluster.sh create|check|delete <name>'
    exit 2
    ;;
esac
