# The tool tree release as a kubernetes reclaim's init container (issue #814): bounded like the
# docker release, by RELEASE_DEADLINE_SECONDS, and always 0 — a release that fails, is killed or
# runs past its deadline only leaves the reclaim to find what it finds. $1 is the release script.
timeout "$RELEASE_DEADLINE_SECONDS" node -e "$1"
exit 0
