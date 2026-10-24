import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Finds Claude Code transcript files under one requested root and nothing else.
 *
 * Recognized layouts: `<root>/<project>/<session>.jsonl` and the nested
 * `<root>/<project>/<session>/subagents/<conversation>.jsonl`. Every path is resolved with
 * `realpath` and refused when it lands outside the root, so a symlink cannot widen the scan.
 * Whatever is skipped is reported with a reason; an unreadable or refused entry makes the
 * discovery `complete: false`, which a destructive caller must treat as "do not replace".
 */

export type SkipReason = 'unreadable-root' | 'unreadable-dir' | 'unreadable-entry' | 'symlink-escape';

export interface Skip {
    /** Root-relative path, '.' for the root itself. */
    rel: string;
    reason: SkipReason;
}

export interface DiscoveredFile {
    /** Real (symlink-resolved) absolute path. */
    path: string;
    /** Root-relative path as laid out, the physical file identity within this scan. */
    rel: string;
    project: string;
    layout: 'project' | 'subagent';
    /** File name without `.jsonl`: the child conversation identity. */
    conversation: string;
    /** Layout evidence only: the `<session>` directory a subagent file sits under. */
    layoutParent: string | null;
}

export interface Discovery {
    files: DiscoveredFile[];
    skipped: Skip[];
    complete: boolean;
}

const inside = (root: string, real: string): boolean => real === root || real.startsWith(root + sep);

interface Scan {
    realRoot: string;
    files: DiscoveredFile[];
    skipped: Skip[];
    seen: Set<string>;
}

type Kind = 'file' | 'dir' | 'other' | 'absent' | 'error';

/** 'absent' is only ENOENT/ENOTDIR; any other failure is 'error' (unconfirmed, never a negative verdict). */
const statKind = (abs: string): Kind => {
    try {
        const s = statSync(abs);
        return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'error';
    }
};

/**
 * The kind of an entry readdir listed. It exists, so a stat that cannot confirm it (an unenterable
 * directory, a dangling symlink) is recorded and makes the scan incomplete, never a silent skip.
 */
function listedKind(scan: Scan, abs: string, rel: string): Kind {
    const kind = statKind(abs);
    if (kind !== 'absent' && kind !== 'error') return kind;
    scan.skipped.push({ rel, reason: 'unreadable-entry' });
    return 'error';
}

/** The resolved path of an entry when it is inside the root, else null (the skip is recorded). */
function resolveInside(scan: Scan, abs: string, rel: string): string | null {
    let real: string;
    try {
        real = realpathSync(abs);
    } catch {
        scan.skipped.push({ rel, reason: 'unreadable-entry' });
        return null;
    }
    if (inside(scan.realRoot, real)) return real;
    scan.skipped.push({ rel, reason: 'symlink-escape' });
    return null;
}

function listDir(scan: Scan, dir: string, rel: string): string[] | null {
    try {
        return readdirSync(dir).sort();
    } catch {
        scan.skipped.push({ rel, reason: 'unreadable-dir' });
        return null;
    }
}

interface Where {
    dir: string;
    rel: string;
    project: string;
    layout: DiscoveredFile['layout'];
    layoutParent: string | null;
}

function addFiles(scan: Scan, names: string[], where: Where): void {
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
        const abs = join(where.dir, name);
        const rel = `${where.rel}/${name}`;
        if (listedKind(scan, abs, rel) !== 'file') continue;
        const real = resolveInside(scan, abs, rel);
        // Two names for one file (an in-root symlink) are one physical file.
        if (real === null || scan.seen.has(real)) continue;
        scan.seen.add(real);
        const { project, layout, layoutParent } = where;
        scan.files.push({
            path: real,
            rel,
            project,
            layout,
            conversation: name.slice(0, -'.jsonl'.length),
            layoutParent,
        });
    }
}

function scanSubagents(scan: Scan, projectAbs: string, project: string, session: string): void {
    const subAbs = join(projectAbs, session, 'subagents');
    const rel = `${project}/${session}/subagents`;
    // Probe on every project entry: a plain file name (ENOTDIR) or no subagents dir (ENOENT) is silent.
    const kind = statKind(subAbs);
    if (kind === 'error') scan.skipped.push({ rel, reason: 'unreadable-entry' });
    if (kind !== 'dir') return;
    if (resolveInside(scan, subAbs, rel) === null) return;
    const names = listDir(scan, subAbs, rel) ?? [];
    addFiles(scan, names, { dir: subAbs, rel, project, layout: 'subagent', layoutParent: session });
}

function scanProject(scan: Scan, project: string): void {
    const abs = join(scan.realRoot, project);
    if (listedKind(scan, abs, project) !== 'dir' || resolveInside(scan, abs, project) === null) return;
    const names = listDir(scan, abs, project);
    if (names === null) return;
    addFiles(scan, names, { dir: abs, rel: project, project, layout: 'project', layoutParent: null });
    // A transcript file has no subagents dir under it; probing one would double-report an unenterable project.
    for (const session of names.filter((n) => !n.endsWith('.jsonl'))) scanSubagents(scan, abs, project, session);
}

export function discoverTranscripts(root: string): Discovery {
    let realRoot: string;
    try {
        realRoot = realpathSync(root);
        if (!statSync(realRoot).isDirectory()) throw new Error('not a directory');
    } catch {
        return { files: [], skipped: [{ rel: '.', reason: 'unreadable-root' }], complete: false };
    }
    const scan: Scan = { realRoot, files: [], skipped: [], seen: new Set() };
    for (const project of listDir(scan, realRoot, '.') ?? []) scanProject(scan, project);
    scan.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { files: scan.files, skipped: scan.skipped, complete: scan.skipped.length === 0 };
}
