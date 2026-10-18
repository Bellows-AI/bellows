// The tool uid's release of a task tree, run just before its terminal reclaim (issue #814). The
// agent's tools run as their own uid in group 1000, and a directory one of them made with an
// explicit mode (`mkdir -m 755`, a read-only module cache) is one the uid-1000 reclaim cannot empty:
// unlinking needs write on the directory, and under a sticky one (`mkdir -m 1777 tmp`) only what it
// made itself. Run as that tool uid, this gives every directory under WORKTREE that the uid owns
// group rwx and clears its sticky bit, and touches nothing else — never a symlink's target, never
// what another uid owns. One JSON line on stdout: {released, skipped}, the directories it changed and
// the ones it could not stat, change or read. It always exits 0 — a kubernetes reclaim runs it as an
// init container — and the reclaim's own verdict decides the outcome, never this.
//
// Environment (set by the driver; a path only): WORKTREE — the task's tree. No tree, nothing to do.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OWNER_GROUP_RWX = 0o770;
const STICKY = 0o1000;

function release(root, uid) {
    const tally = { released: 0, skipped: 0 };
    const visit = (dir) => {
        let entries;
        try {
            const stat = fs.lstatSync(dir);
            if (!stat.isDirectory()) return;
            const mode = stat.mode & 0o7777;
            if (stat.uid === uid && ((mode & OWNER_GROUP_RWX) !== OWNER_GROUP_RWX || mode & STICKY)) {
                // Before the read: an owner may chmod a directory it cannot list.
                fs.chmodSync(dir, (mode & ~STICKY) | OWNER_GROUP_RWX);
                tally.released += 1;
            }
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            // Listed but not searchable (another uid's 0744), or gone: what is under it stays as it is.
            tally.skipped += 1;
            return;
        }
        // A Dirent of a symlink is never a directory, so a link is never followed.
        for (const entry of entries) if (entry.isDirectory()) visit(path.join(dir, entry.name));
    };
    if (root && fs.existsSync(root)) visit(root);
    return tally;
}

process.stdout.write(`${JSON.stringify(release(process.env.WORKTREE ?? '', process.getuid()))}\n`);
