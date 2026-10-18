# One gate's shell, passed by content as `sh -c <this> gate <command>`. The agent's tools run as
# their own uid in group 1000 (issue #814), so a gate writes the tree they share group-writable.
# The declared command is $1, one argv element, run exactly as `sh -c <command>` would run it.
umask 002
exec sh -c "$1"
