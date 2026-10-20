# The stub executor base both lanes build (scripts/test-jobs.sh, scripts/test-k8s.sh), from a
# context holding the files the COPYs name. Like the executor images: node + git as the uid-1000
# `node` user — the driver runs the supervised git steps in the executor image — the supervisor's
# mailbox mount points, and the tool isolation (issue #814): the driver starts the agent container
# as root, and factory-launch drops it to node behind the tool broker. Each stub adds its own
# ENTRYPOINT through factory-launch and scripts/stub-agent.sh (driver/test/lane-stubs.test.ts).
FROM public.ecr.aws/docker/library/node:24-alpine
RUN apk add --no-cache git bash setpriv && ln -s /bin/setpriv /usr/bin/setpriv
RUN addgroup -g 1002 factory-agent && addgroup node factory-agent \
    && adduser -D -u 1001 -G node -h /home/factory-tool -s /bin/bash factory-tool \
    && mkdir -p /run/factory-tool && chown root:factory-agent /run/factory-tool && chmod 2750 /run/factory-tool
COPY ctl-agent.cjs stub-agent.sh /usr/local/bin/
COPY factory-launch.sh /usr/local/bin/factory-launch
COPY factory-tool.cjs /usr/local/lib/factory-tool/factory-tool.cjs
COPY tool-bash.sh /usr/local/libexec/factory-tool/bash
RUN chmod 0755 /usr/local/bin/factory-launch /usr/local/libexec/factory-tool/bash \
    && mkdir -p /factory/in /factory/out /factory/export /factory/supervisor /factory/gate && chown -R node:node /factory \
    && chmod 0700 /factory/in /factory/out
USER node
