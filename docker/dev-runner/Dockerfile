# The image this repository's own `.bellows.yaml` gates run in: node 24 plus what the suites beyond
# `npm test` reach for — a docker CLI with the compose and buildx plugins (the test:jobs lane and
# `make runners`, against a docker class's sidecar daemon through DOCKER_HOST), helm (the chart
# suites), jq, a psql client (the lane on a declared Postgres, TEST_JOBS_PG_URL), and Playwright's
# chromium system libraries. No daemon and no init: the daemon is the class's sidecar, and the
# suites reap their own children.
#
# The executors' base, by the same digest (scripts/pin-digests.sh re-pins both).
FROM mirror.gcr.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# git for the checkout, make for `make runners`, curl and the CA bundle for the downloads below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq make postgresql-client procps python3 \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# The npm node:24 pins carries the fixable findings the release scan gates on; the executors move
# them the same way (docker/claude-executor/Dockerfile).
ARG NPM_VERSION=11.21.1
RUN npm install -g npm@${NPM_VERSION} && npm cache clean --force
ARG NPM_UNDICI_VERSION=6.29.1
RUN cd /tmp \
    && npm pack --silent undici@${NPM_UNDICI_VERSION} \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
    && mkdir /usr/local/lib/node_modules/npm/node_modules/undici \
    && tar -xzf undici-${NPM_UNDICI_VERSION}.tgz --strip-components=1 \
        -C /usr/local/lib/node_modules/npm/node_modules/undici \
    && rm undici-${NPM_UNDICI_VERSION}.tgz \
    && npm cache clean --force \
    && npm --version

# Every download is pinned by version AND sha256 per architecture, never a moving tag: two builds of
# the same commit install the same bytes. TARGETARCH is amd64/arm64; docker and compose name the
# same arches x86_64/aarch64.
ARG TARGETARCH

# The docker CLI alone, from the static bundle (the daemon is the class's sidecar). A newer CLI
# negotiates the API version down to the sidecar's.
ARG DOCKER_VERSION=29.9.3
ARG DOCKER_SHA256_amd64=3fb5d1f13014c18cc54945bc177c58a9056a482dada031e17d12cf2e6922c973
ARG DOCKER_SHA256_arm64=1b27fd739378ef938401e81ce5afb73b7ad7432d4f598814a9ff5f826bb464d2
RUN case "$TARGETARCH" in amd64) sha="$DOCKER_SHA256_amd64" arch=x86_64 ;; arm64) sha="$DOCKER_SHA256_arm64" arch=aarch64 ;; *) echo "no docker for $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/docker.tgz \
        "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" \
    && echo "${sha}  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker.tgz /tmp/docker \
    && docker --version

# The two CLI plugins, where the docker CLI looks for system-wide plugins.
ARG COMPOSE_VERSION=5.7.1
ARG COMPOSE_SHA256_amd64=af426722a8af5de812fcee30cc1c39f0639f5f723cbadefb25e5d4db054064cf
ARG COMPOSE_SHA256_arm64=f2f49f903240895fa764c0dca3a14548b754ad9426f6b609ccaf55ec5a3aa2a5
RUN case "$TARGETARCH" in amd64) sha="$COMPOSE_SHA256_amd64" arch=x86_64 ;; arm64) sha="$COMPOSE_SHA256_arm64" arch=aarch64 ;; *) echo "no compose for $TARGETARCH" >&2; exit 1 ;; esac \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/lib/docker/cli-plugins/docker-compose \
        "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
    && echo "${sha}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
    && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose \
    && docker compose version
ARG BUILDX_VERSION=0.39.0
ARG BUILDX_SHA256_amd64=5fb31a097304fbf6dd4038649a0decf32c2b9510e4047acd7d68b9d700c46194
ARG BUILDX_SHA256_arm64=722cdcdfdd6f3fb943fa1ba75102d057feb18ba72aab93b1b0a8cf2b2b48a25f
RUN case "$TARGETARCH" in amd64) sha="$BUILDX_SHA256_amd64" ;; arm64) sha="$BUILDX_SHA256_arm64" ;; *) echo "no buildx for $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/lib/docker/cli-plugins/docker-buildx \
        "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${TARGETARCH}" \
    && echo "${sha}  /usr/local/lib/docker/cli-plugins/docker-buildx" | sha256sum -c - \
    && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-buildx \
    && docker buildx version

ARG HELM_VERSION=3.22.1
ARG HELM_SHA256_amd64=896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea
ARG HELM_SHA256_arm64=4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d
RUN case "$TARGETARCH" in amd64) sha="$HELM_SHA256_amd64" ;; arm64) sha="$HELM_SHA256_arm64" ;; *) echo "no helm for $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/helm.tar.gz \
        "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
    && echo "${sha}  /tmp/helm.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/helm.tar.gz -C /tmp "linux-${TARGETARCH}/helm" \
    && mv "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz "/tmp/linux-${TARGETARCH}" \
    && helm version --short

# Chromium's system libraries at the Playwright version package.json pins; the browser itself is
# a per-checkout `npx playwright install chromium`, which needs no root.
ARG PLAYWRIGHT_VERSION=1.62.1
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# The base's `node` user. A docker class's daemon socket is group 1000, this uid's primary group.
USER 1000:1000
WORKDIR /home/node
