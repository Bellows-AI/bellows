#!/bin/sh
# The agent CLI's shell, installed as /usr/local/libexec/factory-tool/bash (issue #814): Claude Code
# takes it through CLAUDE_CODE_SHELL, whose path must name bash, and OpenCode through SHELL. Every
# command runs as the tool uid through the broker factory-launch started (factory-tool.cjs). With
# no broker socket at all — the image run by hand, not as root — it is plain bash, as before. A
# socket that is there but does not answer refuses the command: it never runs as the CLI's uid.
[ -S /run/factory-tool/broker.sock ] || exec /bin/bash "$@"
exec /usr/local/bin/node /usr/local/lib/factory-tool/factory-tool.cjs run "$@"
