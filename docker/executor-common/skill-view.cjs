#!/usr/bin/env node
'use strict';
// The per-start skill view both executor entrypoints build when a task pins workspace skills (BEL-289).
//
//   skill-view.cjs claude   <view dir>
//   skill-view.cjs opencode <view dir> <workdir> <worktree root>
//
// A workspace skill must win over a checkout skill of the same name. Claude ranks the managed skills path above the
// project's, so each pinned name is linked into the managed view (<view>/<name> -> $FACTORY_SKILLS_PATH/<name>).
// opencode lists the checkout's own folders by a racy scan that the entrypoint switches off, so in opencode mode the
// view also holds a link to every other skill of the checkout's .claude/.agents folders, from the workdir up to the
// worktree root, and the workspace copy is the only one of its name.
//
// The view is rebuilt on every start from the environment and the checkout, so nothing is read back from an earlier
// run. Every refusal is one stderr line and exit 78, before the CLI starts. A checkout folder that cannot be read is a
// refusal, never "no skills": only ENOENT and ENOTDIR mean absent.

const fs = require('node:fs');
const path = require('node:path');

const REFUSED = 78;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDERS = [path.join('.claude', 'skills'), path.join('.agents', 'skills')];

const refuse = (why) => {
    process.stderr.write(`skill-view: ${why}\n`);
    process.exit(REFUSED);
};

const absent = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

/** lstat that reports only a missing entry as `null`; any other failure refuses. */
const lstatOrNull = (p) => {
    try {
        return fs.lstatSync(p);
    } catch (e) {
        if (absent(e)) return null;
        return refuse(`cannot read ${p}: ${e.code}`);
    }
};

const linked = [];

/** Link `<view>/<name>` to `to`: a free name only. The same link again is fine; anything else is never replaced. */
const link = (view, name, to, mustBeFree) => {
    const at = path.join(view, name);
    if (lstatOrNull(at)) {
        if (mustBeFree === false) return false;
        let same = false;
        try {
            same = fs.readlinkSync(at) === to;
        } catch {
            same = false;
        }
        if (!same) refuse(`${at} already exists`);
        if (!linked.includes(name)) linked.push(name);
        return true;
    }
    try {
        fs.symlinkSync(to, at);
    } catch (e) {
        refuse(`cannot link ${name}: ${e.code}`);
    }
    linked.push(name);
    return true;
};

const workspaceNames = () => {
    const list = process.env.FACTORY_WORKSPACE_SKILLS || '';
    if (list === '') return [];
    const names = list.split(',');
    for (const name of names) {
        if (!NAME.test(name) || name.startsWith('factory-')) refuse(`bad workspace skill name '${name}'`);
    }
    return names;
};

/** The skill directories of one `.claude/skills`-style folder, nearest first by caller. Absent folder = none. */
const skillDirs = (folder) => {
    let entries;
    try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (e) {
        if (absent(e)) return [];
        return refuse(`cannot read ${folder}: ${e.code}`);
    }
    const dirs = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const dir = path.join(folder, entry.name);
        let stat;
        try {
            stat = fs.statSync(dir);
        } catch (e) {
            if (absent(e)) continue; // a dangling link is not a skill
            return refuse(`cannot read ${dir}: ${e.code}`);
        }
        if (!stat.isDirectory()) continue;
        if (lstatOrNull(path.join(dir, 'SKILL.md')) === null) continue;
        dirs.push({ name: entry.name, dir });
    }
    return dirs;
};

const real = (p, what) => {
    try {
        return fs.realpathSync(p);
    } catch (e) {
        return refuse(`cannot resolve ${what} '${p}': ${e.code}`);
    }
};

const [mode, view, workdir, worktreeRoot] = process.argv.slice(2);
if (mode !== 'claude' && mode !== 'opencode') refuse(`unknown mode '${mode}'`);
if (!view) refuse('no view directory');
if (mode === 'opencode' && (!workdir || !worktreeRoot)) refuse('opencode mode needs a workdir and a worktree root');

const names = workspaceNames();
const skillsPath = process.env.FACTORY_SKILLS_PATH || '';
if (names.length > 0 && skillsPath === '') refuse('FACTORY_WORKSPACE_SKILLS is set but FACTORY_SKILLS_PATH is not');

// Validation is done: nothing below refuses a bad list halfway through linking.
for (const name of names) link(view, name, path.join(skillsPath, name), true);

if (mode === 'opencode') {
    const top = real(worktreeRoot, 'worktree root');
    let dir = real(workdir, 'workdir');
    for (;;) {
        for (const folder of FOLDERS) {
            for (const skill of skillDirs(path.join(dir, folder))) link(view, skill.name, skill.dir, false);
        }
        if (dir === top || path.dirname(dir) === dir) break;
        dir = path.dirname(dir);
    }
}

try {
    fs.chmodSync(view, 0o755);
} catch (e) {
    refuse(`cannot open ${view}: ${e.code}`);
}
process.stdout.write(`${JSON.stringify({ linked })}\n`);
