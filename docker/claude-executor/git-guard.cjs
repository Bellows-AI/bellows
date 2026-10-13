'use strict';

/*
 * The git guard: a PreToolUse hook that denies the Bash commands which would move HEAD or
 * rewrite refs in the task worktree, and `gh pr checkout`, which would move HEAD onto a PR
 * (issue #82). Opening and updating a PR is the agent's to do (issue #573). The tree standing on `factory/<root>` is the
 * driver's invariant (docs/jobs.md) — the restore-mode sync refuses a wrong checkout only after
 * the damage, and the damage strands the thread (job 43379d3a, 2026-09-13). This hook exists to
 * keep threads runnable; it is a guardrail, not a security boundary — the agent is root in
 * its container, and the driver-side sync refusal stays the last line of defense.
 *
 * Lives in /usr/local/bin, not the config home: the transcript store moves CLAUDE_CONFIG_DIR
 * off the baked home, and the hook command names an absolute path. Read-only git, `git add` and
 * `git commit` stay allowed — a commit endangers no checkout.
 */

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'ash']);
const MAX_DEPTH = 8;

const ALLOW = { deny: false };

const denyOf = (what) => ({
    deny: true,
    reason:
        `git guard: ${what} would move HEAD or rewrite refs in the task worktree, and the ` +
        "checkout must stay on its task branch. Commit your work instead — branches, rebases " +
        'and publishing are the driver\'s job.',
});

const DENY_PR_CHECKOUT = {
    deny: true,
    reason:
        "git guard: 'gh pr checkout' would move HEAD off the task branch, and the " +
        'checkout must stay on it. Read the PR with `gh pr view` / `gh pr diff` instead.',
};

// At i: a heredoc operator (`<<` or `<<-`, never the `<<<` here-string). Returns
// { delim, literal, strip, end } — end one past the delimiter word — or null. Any quoting in the
// word makes the body literal; an unquoted word leaves its substitutions live (issue #504).
function matchHeredoc(command, i) {
    if (!command.startsWith('<<', i) || command[i + 2] === '<' || command[i - 1] === '<') return null;
    let j = i + 2;
    const strip = command[j] === '-';
    if (strip) j += 1;
    while (command[j] === ' ' || command[j] === '\t') j += 1;
    const word = j;
    let delim = '';
    let literal = false;
    while (j < command.length && !/[\s;&|<>()]/.test(command[j])) {
        const c = command[j];
        if (c === "'" || c === '"') {
            const close = command.indexOf(c, j + 1);
            if (close === -1) return null;
            delim += command.slice(j + 1, close);
            literal = true;
            j = close + 1;
        } else if (c === '\\') {
            delim += command[j + 1] ?? '';
            literal = true;
            j += 2;
        } else {
            delim += c;
            j += 1;
        }
    }
    // A quoted empty word (`<<''`) is a delimiter, the empty line; no word at all is none.
    return j > word ? { delim, literal, strip, end: j } : null;
}

// At j: a `#` that starts a word opens a comment — after a blank or an operator that is not itself
// backslash-escaped. Returns the index of the newline that ends it, or -1 when this is no comment.
function commentEnd(command, j) {
    if (command[j] !== '#') return -1;
    if (j > 0) {
        if (!/[\s;&|()]/.test(command[j - 1])) return -1;
        let escapes = 0;
        for (let k = j - 2; k >= 0 && command[k] === '\\'; k--) escapes += 1;
        if (escapes % 2 === 1) return -1;
    }
    const nl = command.indexOf('\n', j);
    return nl === -1 ? command.length : nl;
}

// At j: a `((` arithmetic span, where `<<` is a shift and no heredoc. Returns the index one past
// its closing `))`, or -1 when this is no such span — a `((` closed by `) … )` is nested
// subshells, whose commands run. Quotes are not tracked: a `)` in one ends the span early, and
// what remains is read as command text, which errs toward a deny.
function arithmeticEnd(command, j) {
    if (!command.startsWith('((', j)) return -1;
    let depth = 2;
    for (let k = j + 2; k < command.length; k++) {
        if (command[k] === '(') depth += 1;
        else if (command[k] === ')') {
            depth -= 1;
            if (depth === 1) return command[k + 1] === ')' ? k + 2 : -1;
        }
    }
    return -1;
}

// From start (the line after the one that opened them), the bodies of the pending heredocs in
// order. Returns { bodies, end } — end past the last terminator line — or null when a terminator
// is missing: a body that never ends cannot be told apart from the commands after it.
function readHeredocs(command, start, docs) {
    let pos = start;
    const bodies = [];
    for (const doc of docs) {
        const lines = [];
        for (;;) {
            if (pos >= command.length) return null;
            let line = '';
            // An unquoted body joins a backslash-newline before the terminator check, as bash does.
            for (;;) {
                const nl = command.indexOf('\n', pos);
                const piece = command.slice(pos, nl === -1 ? command.length : nl);
                pos = nl === -1 ? command.length : nl + 1;
                const escapes = piece.length - piece.replace(/\\+$/, '').length;
                if (doc.literal || nl === -1 || escapes % 2 === 0) {
                    line += piece;
                    break;
                }
                line += piece.slice(0, -1);
            }
            if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
            lines.push(line);
        }
        bodies.push({ text: lines.join('\n'), literal: doc.literal });
    }
    return { bodies, end: pos };
}

// The substitutions an unquoted heredoc body still expands — its quotes are literal text.
// Null when one never closes.
function substitutionsIn(text) {
    const subs = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            i += 1;
            continue;
        }
        const sub = matchSubstitution(text, i);
        if (sub) {
            subs.push(sub.body);
            i = sub.end - 1;
        } else if (text[i] === '$' && text[i + 1] === '(') return null;
    }
    return subs;
}

// At i: a substitution opening ($( , <( or a backtick). Returns { body, end } — end one past
// the closing delimiter — or null when this is not a substitution. A `)` inside quotes, a nested
// substitution or a heredoc body closes nothing.
function matchSubstitution(command, i) {
    const c = command[i];
    if (c === '`') {
        const end = command.indexOf('`', i + 1);
        return end === -1 ? null : { body: command.slice(i + 1, end), end: end + 1 };
    }
    // `$((…))` is arithmetic: `<<` in it is a shift, and only its own substitutions can run.
    const arithmetic = c === '$' ? arithmeticEnd(command, i + 1) : -1;
    if (arithmetic !== -1) {
        const live = substitutionsIn(command.slice(i + 3, arithmetic - 2));
        return live ? { body: live.join('\n'), end: arithmetic } : null;
    }
    if ((c === '$' || c === '<') && command[i + 1] === '(') {
        let depth = 1;
        let inDouble = false;
        let pending = [];
        let j = i + 2;
        while (j < command.length) {
            const d = command[j];
            if (d === '\\') {
                j += 2;
                continue;
            }
            if (d === "'" && !inDouble) {
                const close = command.indexOf("'", j + 1);
                if (close === -1) return null;
                j = close + 1;
                continue;
            }
            if (d === '"') {
                inDouble = !inDouble;
                j += 1;
                continue;
            }
            const nested = d === '$' || d === '`' || (d === '<' && !inDouble) ? matchSubstitution(command, j) : null;
            if (nested) {
                j = nested.end;
                continue;
            }
            if (!inDouble) {
                const comment = commentEnd(command, j);
                if (comment !== -1) {
                    j = comment;
                    continue;
                }
                const arithmetic = arithmeticEnd(command, j);
                if (arithmetic !== -1) {
                    j = arithmetic;
                    continue;
                }
                if (command.startsWith('<<<', j)) {
                    j += 3;
                    continue;
                }
                const doc = matchHeredoc(command, j);
                if (doc) {
                    pending.push(doc);
                    j = doc.end;
                    continue;
                }
                if (d === '\n' && pending.length > 0) {
                    const read = readHeredocs(command, j + 1, pending);
                    if (!read) return null;
                    pending = [];
                    j = read.end;
                    continue;
                }
                if (d === '(') depth += 1;
                else if (d === ')') {
                    depth -= 1;
                    if (depth === 0) return { body: command.slice(i + 2, j), end: j + 1 };
                }
            }
            j += 1;
        }
    }
    return null;
}

// Split on operators at the top level, tracking quoting so `echo 'a && b'` stays one segment.
function splitOuter(text) {
    const segments = [];
    let buf = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\' && !inSingle) {
            buf += c + (text[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
            buf += c;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            buf += c;
            continue;
        }
        if (!inSingle && !inDouble) {
            if ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) {
                segments.push(buf);
                buf = '';
                i += 1;
                continue;
            }
            // The `&` of a redirection (`2>&1`, `<&0`, `&>file`) duplicates a descriptor; it
            // does not background anything, so it is no operator.
            if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
                buf += c;
                continue;
            }
            if (c === ';' || c === '|' || c === '&' || c === '\n') {
                segments.push(buf);
                buf = '';
                continue;
            }
        }
        buf += c;
    }
    if (inSingle || inDouble) return { ok: false };
    segments.push(buf);
    return { ok: true, segments };
}

// Split a command into its runnable segments. Operators bind only outside quotes; the
// contents of $(…), <(…) and `…` cannot run as part of the surrounding command, so each span
// is lifted out and recursed as segments of its own — inside double quotes too, where the shell
// still expands them but a `'` is a literal. A heredoc body is dropped from the command text: a
// literal one runs nothing, an expanding one contributes only its substitutions. Unbalanced
// quoting, an unclosed substitution or an unterminated heredoc means the command cannot be proven
// safe — { ok: false } and the caller denies.
function segmentsOf(command, depth) {
    const subs = [];
    let outer = '';
    let inDouble = false;
    let pending = [];
    let i = 0;
    while (i < command.length) {
        const c = command[i];
        if (c === '\\') {
            outer += c + (command[i + 1] ?? '');
            i += 2;
            continue;
        }
        if (c === '"') inDouble = !inDouble;
        if (c === "'" && !inDouble) {
            const end = command.indexOf("'", i + 1);
            if (end === -1) return { ok: false };
            outer += command.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        // Inside double quotes `<(` is literal text; only `$(` and a backtick still expand.
        const opens = c !== '<' || !inDouble;
        const sub = opens ? matchSubstitution(command, i) : null;
        if (sub) {
            subs.push(sub.body);
            outer += '""';
            i = sub.end;
            continue;
        }
        if (opens && (c === '$' || c === '<') && command[i + 1] === '(') return { ok: false };
        if (!inDouble) {
            const comment = commentEnd(command, i);
            if (comment !== -1) {
                i = comment;
                continue;
            }
            const arithmetic = arithmeticEnd(command, i);
            if (arithmetic !== -1) {
                const live = substitutionsIn(command.slice(i + 2, arithmetic - 2));
                if (!live) return { ok: false };
                subs.push(...live);
                outer += '""';
                i = arithmetic;
                continue;
            }
            if (command.startsWith('<<<', i)) {
                outer += '<<<';
                i += 3;
                continue;
            }
            const doc = matchHeredoc(command, i);
            if (doc) {
                pending.push(doc);
                outer += ' ';
                i = doc.end;
                continue;
            }
            if (c === '\n' && pending.length > 0) {
                const read = readHeredocs(command, i + 1, pending);
                if (!read) return { ok: false };
                for (const body of read.bodies) {
                    if (body.literal) continue;
                    const live = substitutionsIn(body.text);
                    if (!live) return { ok: false };
                    subs.push(...live);
                }
                pending = [];
                outer += '\n';
                i = read.end;
                continue;
            }
        }
        outer += c;
        i += 1;
    }
    const split = splitOuter(outer);
    if (!split.ok) return { ok: false };
    const segments = split.segments.map((s) => s.trim()).filter(Boolean);
    if (depth >= MAX_DEPTH) return subs.length ? { ok: false } : { ok: true, segments };
    for (const body of subs) {
        const nested = segmentsOf(body, depth + 1);
        if (!nested.ok) return { ok: false };
        segments.push(...nested.segments);
    }
    return { ok: true, segments };
}

// Whitespace tokens, quote-aware (a payload like 'git switch main' is one token) and each
// stripped of one layer of surrounding quotes.
function tokenize(segment) {
    const tokens = [];
    let buf = '';
    let has = false;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (c === '\\' && !inSingle) {
            buf += c + (segment[i + 1] ?? '');
            i += 1;
            has = true;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
            buf += c;
            has = true;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            buf += c;
            has = true;
            continue;
        }
        if (!inSingle && !inDouble && /\s/.test(c)) {
            if (has) tokens.push(buf);
            buf = '';
            has = false;
            continue;
        }
        buf += c;
        has = true;
    }
    if (has) tokens.push(buf);
    return tokens.map(unquote);
}

// One layer of surrounding quotes off a token; a `$'…'`/`$"…"` ANSI-C or locale string is
// the shell expands it — the payload inside is the command.
function unquote(token) {
    let t = token;
    if (t.length >= 2 && t[0] === '$' && (t[1] === "'" || t[1] === '"')) t = t.slice(1);
    if (
        t.length >= 2 &&
        ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))
    ) {
        return t.slice(1, -1);
    }
    return t;
}

// Redirections are the shell's, not the command's: `2>&1`, `>/tmp/log` and a bare `>` with
// its target token dropped, so an operand scan never mistakes one for an argument.
const REDIRECT_BARE = /^(\d*|&)(>>?|<)$/;
const REDIRECT_ATTACHED = /^(\d*|&)(>>?|<)./;

function withoutRedirections(tokens) {
    const kept = [];
    for (let t = 0; t < tokens.length; t++) {
        if (REDIRECT_BARE.test(tokens[t])) t += 1;
        else if (!REDIRECT_ATTACHED.test(tokens[t])) kept.push(tokens[t]);
    }
    return kept;
}

function analyze(segment, depth) {
    const tokens = withoutRedirections(tokenize(segment));
    let i = 0;
    // Leading environment assignments, `env`, and sh -c wrappers: strip and re-scan.
    for (;;) {
        if (i >= tokens.length) return ALLOW;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
            i += 1;
            continue;
        }
        if (tokens[i] === 'env') {
            i += 1;
            while (i < tokens.length && tokens[i].startsWith('-')) {
                i += tokens[i] === '-u' || tokens[i] === '--unset' ? 2 : 1;
            }
            continue;
        }
        if (SHELL_WRAPPERS.has(tokens[i]) && tokens[i + 1] && /^-\w*c\w*$/.test(tokens[i + 1])) {
            if (depth >= MAX_DEPTH) return denyOf('a command buried too deep in shell wrappers to read');
            const script = tokens[i + 2];
            if (!script) return ALLOW;
            return scan(unquote(script), depth + 1);
        }
        break;
    }
    // gh (issues #82, #573): the agent may open and update a PR, but not check one out — that
    // moves HEAD. Global flags taking a value are skipped; the pr subcommand decides.
    if (tokens[i] === 'gh') {
        let g = i + 1;
        while (g < tokens.length && tokens[g].startsWith('-') && tokens[g] !== '--') {
            const t = tokens[g];
            if (t === '-R' || t === '--repo' || t === '--hostname' || t === '--jq' || t === '--template') g += 2;
            else if (/^--(repo|hostname|jq|template)=/.test(t)) g += 1;
            else g += 1;
        }
        const verb = tokens[g + 1];
        if (tokens[g] === 'pr' && verb === 'checkout') return DENY_PR_CHECKOUT;
        return ALLOW;
    }
    if (tokens[i] !== 'git') return ALLOW;
    // Global options: -C/-c take a value (attached or next token), the --key=value / --key
    // value relocations follow, everything else is a bare flag.
    let k = i + 1;
    while (k < tokens.length && tokens[k].startsWith('-') && tokens[k] !== '--') {
        const t = tokens[k];
        if ((t === '-C' || t === '-c') && t.length === 2) {
            k += 2;
        } else if (/^--(git-dir|work-tree|namespace|super-prefix)=/.test(t)) {
            k += 1;
        } else if (t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--super-prefix') {
            k += 2;
        } else {
            k += 1;
        }
    }
    const verb = tokens[k];
    if (!verb || verb.startsWith('-')) return ALLOW;
    const rest = tokens.slice(k + 1);
    switch (verb) {
        case 'switch':
            return denyOf("'git switch'");
        case 'checkout': {
            if (rest.some((t) => t === '-b' || t === '-B' || t === '--orphan' || t === '-t' || t === '--track')) {
                return denyOf("'git checkout' with a branch-creating flag");
            }
            // `--` puts everything after it in pathspec land — HEAD cannot move. --ours,
            // --theirs and --stage are only valid in path mode; git refuses them with a
            // commit-ish.
            if (rest.includes('--') || rest.some((t) => t === '--ours' || t === '--theirs' || t === '--stage')) {
                return ALLOW;
            }
            return denyOf("'git checkout' of a branch or commit");
        }
        case 'worktree': {
            const sub = rest.find((t) => !t.startsWith('-'));
            return !sub || sub === 'list' ? ALLOW : denyOf(`'git worktree ${sub}'`);
        }
        case 'branch': {
            // Long forms exact; any short cluster (-dD, -avd, -M, …) carrying a mutating
            // letter. Read-only clusters (-a, -av, -vv, -qn) carry none.
            const mutating = rest.some(
                (t) =>
                    t === '--delete' ||
                    t === '--force' ||
                    t === '--move' ||
                    t === '--copy' ||
                    (/^-[^-]*$/.test(t) && /[dDmMcCf]/.test(t.slice(1))),
            );
            return mutating ? denyOf("'git branch' with a delete, rename, copy or force flag") : ALLOW;
        }
        case 'reset':
            return rest.includes('--hard') ? denyOf("'git reset --hard'") : ALLOW;
        case 'rebase':
            // Initiation is denied outright — rebasing onto the default branch is the driver
            // sync's job. The abort/quit/continue verbs only act on an in-progress rebase,
            // which the agent can no longer start; they are the repair path for a tree an
            // interrupted sync left mid-rebase.
            return rest.some((t) => t === '--abort' || t === '--quit' || t === '--continue')
                ? ALLOW
                : denyOf("'git rebase'");
        case 'merge': {
            // As with rebase: --abort/--quit unwind an in-progress merge, and --continue
            // completes one (git commit, also allowed, does the same). Initiation is allowed
            // ONLY for origin remote-tracking refs: merging origin/<ref> in is the one way a
            // thread resolves the conflicts the driver's sync rebase refused (job 3e85c499,
            // 2026-09-20 — the /fix skill's own up-to-date step was the command the guard
            // denied), and a merge can neither move HEAD off the task branch nor rewrite the
            // published commits, so the invariant survives it. A local branch, a sha or a
            // bare merge stays denied. -m/--message/-F/--file take a VALUE the operand scan
            // must not mistake for a merge target.
            if (rest.some((t) => t === '--abort' || t === '--quit' || t === '--continue')) return ALLOW;
            const operands = [];
            for (let r = 0; r < rest.length; r++) {
                if (rest[r] === '-m' || rest[r] === '--message' || rest[r] === '-F' || rest[r] === '--file') {
                    r += 1;
                } else if (!rest[r].startsWith('-')) operands.push(rest[r]);
            }
            if (operands.length > 0 && operands.every((t) => /^origin\/[A-Za-z0-9._/-]+$/.test(t))) return ALLOW;
            // The generic reason read as "merging is forbidden" and a thread asked to update from
            // main gave up (job 72d9fa14) — name the shape that IS allowed.
            return {
                deny: true,
                reason:
                    "git guard: 'git merge' is allowed only from an origin remote-tracking ref. To bring " +
                    'the default branch in, run `git fetch origin` then `git merge origin/<default>` ' +
                    '(`git symbolic-ref --short refs/remotes/origin/HEAD` names it), resolve the ' +
                    'conflicts, and commit. A local branch, a sha or FETCH_HEAD stays denied.',
            };
        }
        default:
            return ALLOW;
    }
}

function scan(command, depth) {
    const { ok, segments } = segmentsOf(command, depth);
    if (!ok) return denyOf('a command whose quoting cannot be resolved');
    for (const segment of segments) {
        const verdict = analyze(segment, depth);
        if (verdict.deny) return verdict;
    }
    return ALLOW;
}

function decide(command) {
    if (typeof command !== 'string' || command.trim() === '') return ALLOW;
    try {
        return scan(command, 0);
    } catch {
        // Fail open — a hook that breaks runs is worse than one that misses, and the
        // driver-side sync refusal is the backstop either way.
        return ALLOW;
    }
}

// The canonical case table: [want, command]. Pinned twice — driver/test/executor-images.test.ts
// runs decide() over it offline, and the image suite (docker/claude-executor/test.sh) runs
// --selftest against the baked copy, so the table tests the bytes that actually ship.
const CASES = [
    ['deny', 'git switch main'],
    ['deny', 'git switch -c wip'],
    ['deny', 'git switch --detach HEAD~1'],
    ['deny', 'git switch'],
    ['deny', 'git checkout main'],
    ['deny', 'git checkout HEAD~1'],
    ['deny', 'git checkout 62-remove-pr-stats'],
    ['deny', 'git checkout -b feature'],
    ['deny', 'git checkout -B feature main'],
    ['deny', 'git checkout --orphan feature'],
    ['deny', 'git checkout -t origin/main'],
    ['deny', 'git checkout --track origin/main'],
    ['deny', 'git checkout -b feature -- src/a.ts'],
    ['deny', 'npm test && git switch main'],
    ['deny', 'echo hi; git checkout main'],
    ['deny', 'git status | git switch main'],
    ['deny', 'git status\ngit switch main'],
    ['deny', 'git branch feature -d'],
    ['deny', "'git' switch main"],
    ['deny', "sh -c $'git switch main'"],
    ['deny', 'git checkout -- -b'],
    ['deny', 'FOO=bar git switch main'],
    ['deny', 'env git switch main'],
    ['deny', 'env -u FOO git switch main'],
    ['deny', 'env GIT_X=1 git switch main'],
    ['deny', 'GIT_DIR=/x git switch main'],
    ['deny', 'git -C /tmp/other switch main'],
    ['deny', 'git -C/tmp/other switch main'],
    ['deny', 'git --git-dir=/tmp/other/.git switch main'],
    ['deny', 'git --git-dir /tmp/other/.git switch main'],
    ['deny', 'git --work-tree /tmp/other switch main'],
    ['deny', 'git --no-pager switch main'],
    ['deny', 'echo $(git switch main)'],
    ['deny', 'echo `git checkout main`'],
    ['deny', 'echo "$(git switch main)"'],
    ['deny', "sh -c 'git switch main'"],
    ['deny', 'bash -c "git checkout main"'],
    ['deny', 'git worktree add ../sibling'],
    ['deny', 'git worktree prune'],
    ['deny', 'git worktree remove /tmp/x'],
    ['deny', 'git worktree move /tmp/x /tmp/y'],
    ['deny', 'git worktree lock /tmp/x'],
    ['deny', 'git branch -d feature'],
    ['deny', 'git branch -D feature'],
    ['deny', 'git branch -dD feature'],
    ['deny', 'git branch -avd'],
    ['deny', 'git branch -m feature renamed'],
    ['deny', 'git branch -M feature main'],
    ['deny', 'git branch -c a b'],
    ['deny', 'git branch -C a b'],
    ['deny', 'git branch -f feature main'],
    ['deny', 'git branch --delete feature'],
    ['deny', 'git branch --force feature main'],
    ['deny', 'git branch --move feature renamed'],
    ['deny', 'git branch --copy feature copy'],
    ['deny', 'git reset --hard'],
    ['deny', 'git reset --hard HEAD~1'],
    ['deny', 'git reset --hard origin/main'],
    ['deny', 'git reset -q --hard HEAD~1'],
    ['deny', 'git rebase'],
    ['deny', 'git rebase origin/main'],
    ['deny', 'git rebase -i HEAD~3'],
    ['deny', 'git rebase --autostash main'],
    ['deny', 'git rebase --onto main HEAD~2'],
    ['deny', 'git merge'],
    ['deny', 'git merge main'],
    ['deny', 'git merge --no-ff feature'],
    ['deny', 'git merge 62f9a1b'],
    ['deny', 'git merge FETCH_HEAD'],
    ['deny', 'git merge origin/main && git checkout main'],
    ['deny', 'git commit -m x && git rebase main'],
    // gh (issues #82, #573): `gh pr checkout` would move HEAD off the task branch, the same
    // damage as `git checkout`; opening a pull request is the agent's to do.
    ['deny', 'gh pr checkout 82'],
    ['deny', 'gh -R owner/repo pr checkout 82'],
    ['allow', 'gh pr create --title "x" --body "y"'],
    ['allow', 'gh pr create --fill'],
    ['allow', 'gh -R owner/repo pr create'],
    ['allow', "sh -c 'gh pr create --fill'"],
    ['allow', 'gh pr edit 82 --title x'],
    ['allow', 'gh pr ready 82'],
    // A `'` inside double quotes is a literal (job 2bfc0e63, 2026-10-11): the apostrophe in a PR
    // body read as an unclosed single quote, and the agent's own `gh pr create` was denied.
    ['allow', 'gh pr create --title "x" --body "the run\'s own failure"'],
    ['allow', 'git commit -m "don\'t move HEAD"'],
    ['deny', 'echo "it\'s" && git switch main'],
    ['deny', 'echo "it\'s $(git switch main)"'],
    // Heredocs (issue #504): a body is data, not command text — an apostrophe or a `)` in it is
    // no quote and no closer, so the commit forms agents type first are allowed. A quoted
    // delimiter makes the body literal; an unquoted one still expands its substitutions.
    ['allow', 'git add -A && git commit -q -m "fix: subject\n\nbody line"'],
    ['allow', 'git add a && git commit -q -m "subject\n\nthe runner\'s body"'],
    ['allow', "git commit -m \"$(cat <<'EOF'\nsubject\n\nit's the body (#504)\nEOF\n)\""],
    ['allow', "git commit -m \"$(cat <<'EOF'\nsubject\n\n1) a stray closer\nEOF\n)\""],
    ['allow', "git commit -F - <<'EOF'\nsubject\n\ndon't move HEAD\nEOF"],
    ['allow', 'git commit -F /tmp/msg.txt'],
    ['allow', "cat > notes.md <<'EOF'\nit's a doc\nEOF"],
    ['allow', "cat > notes.md <<'EOF'\nit's a doc\nEOF\ngit add notes.md && git commit -q -m \"docs: notes\""],
    ['allow', 'cat > notes.md <<"EOF"\nit\'s "quoted"\nEOF'],
    ['allow', "cat <<-'EOF' > notes.md\n\tit's tab-stripped\n\tEOF"],
    ['allow', "cat <<'EOF'\n$(git switch main)\nEOF"],
    ['allow', "cat <<'A' <<'B'\nit's\nA\ndon't\nB"],
    ['allow', 'cat <<EOF\nit\'s $HOME and $(date)\nEOF'],
    ['allow', 'grep x <<< "it is"'],
    ['allow', 'echo "a << b"'],
    ['allow', 'echo "$(echo ")")"'],
    ['deny', "cat <<'EOF'\nx\nEOF\ngit switch main"],
    ['deny', "cat > notes.md <<'EOF'\nit's\nEOF\ngit checkout main"],
    ['deny', 'cat <<EOF\n$(git switch main)\nEOF'],
    ['deny', 'cat <<EOF\n`git checkout main`\nEOF'],
    ['deny', "cat <<'EOF' && git switch main\nbody\nEOF"],
    ['deny', "git commit -F - <<'EOF'\nm\nEOF\ngit rebase main"],
    ['deny', "cat <<'EOF'\nx\nEOF\ngit reset --hard"],
    ['deny', "git commit -m \"$(cat <<'EOF'\nit's\nEOF\n)\" && git checkout -b other"],
    ['deny', "cat <<'A' <<'B'\nx\nA\ny\nB\ngit switch main"],
    ['deny', 'grep x <<< "$(git switch main)"'],
    ['deny', 'echo $(git switch main'],
    // A shift is no heredoc: what follows it runs, and is read.
    ['deny', '((x<<1))\ngit switch main\n1'],
    ['deny', '((x<<y))\ngit switch main\ny'],
    ['deny', 'echo $(( x << 1 ))\ngit switch main\n1'],
    ['deny', '(( $(git switch main) ))'],
    ['deny', '(( x = 1<<2 ))\ngit switch main\n2'],
    ['allow', '(( x << 1 ))'],
    ['allow', '(( (1+2) << 3 ))'],
    // `((` closed by `) … )` rather than `))` is nested subshells, whose commands run.
    ['deny', '((a) ; git switch main; (b))'],
    ['deny', '((true)\ngit switch main\n)'],
    ['deny', 'echo $((a) ; git switch main; (b))'],
    // ...but a `$((` closed by `))` is arithmetic to bash too, and runs nothing.
    ['allow', 'echo $(((a) ; git switch main; (b)))'],
    ['deny', 'echo $(( $(git switch main) ))'],
    ['allow', 'echo $(( x << 1 ))'],
    // Any word delimits a heredoc, digits and punctuation included; no word at all reads nothing.
    ['deny', 'cat <<1\n<<EOF\n1\ngit switch main\nEOF'],
    ['deny', 'cat <<.\n<<EOF\n.\ngit switch main\nEOF'],
    ['deny', 'cat <<\ngit switch main'],
    ['allow', "cat <<1\nit's\n1"],
    // An empty quoted word is a delimiter too: the body ends at the first empty line.
    ['allow', "git commit -F - <<''\nit's a message\n\n"],
    ['deny', "cat <<''\nit's\n\ngit switch main"],
    // An unquoted body joins a backslash-newline before the terminator check; a quoted one does not.
    ['deny', 'git commit -F - <<EOF\nE\\\nOF\ngit switch main\nEOF'],
    ['allow', "git commit -F - <<'EOF'\nE\\\nOF\ngit switch main\nEOF"],
    // `<(` inside double quotes is literal text, no process substitution.
    ['allow', 'git commit -m "<("'],
    ['allow', 'echo "<(git switch main)"'],
    ['deny', 'cat <(git switch main)'],
    // An escaped blank starts no word, so the `#` after it is text and what follows runs.
    ['deny', 'echo \\ #; git switch main'],
    ['deny', 'echo $(echo \\ #; git switch main)'],
    ['allow', 'echo \\\\ # git switch main'],
    // A comment is no command text either: a `<<` in one opens nothing, a `'` in one quotes nothing.
    ['deny', 'true # <<EOF\ngit switch main\nEOF'],
    ['deny', 'echo $(true # <<EOF\ngit switch main\nEOF\n)'],
    ['allow', "npm test # it's fine\ngit status"],
    ['allow', 'echo a#b <<EOF\nx\nEOF'],
    ['allow', 'echo ${#x}'],
    ['allow', 'git status'],
    ['allow', 'git status --short'],
    ['allow', 'git diff'],
    ['allow', 'git log --oneline -10'],
    ['allow', 'git show HEAD'],
    ['allow', 'git add -A'],
    ['allow', 'git commit -m "a message"'],
    ['allow', 'git restore src/a.ts'],
    ['allow', 'git stash'],
    ['allow', 'git fetch origin'],
    ['allow', 'git push origin HEAD'],
    ['allow', 'git checkout -- server/src/main.ts'],
    ['allow', 'git checkout -- .'],
    ['allow', 'git checkout main -- src/a.ts'],
    ['allow', 'git checkout --ours src/a.ts'],
    ['allow', 'git checkout --theirs src/a.ts'],
    ['allow', 'git worktree'],
    ['allow', 'git worktree list'],
    ['allow', 'git worktree list --porcelain'],
    ['allow', 'git branch'],
    ['allow', 'git branch -a'],
    ['allow', 'git branch -av'],
    ['allow', 'git branch -vv'],
    ['allow', 'git branch --list -a'],
    ['allow', 'git branch --show-current'],
    ['allow', 'git branch feature origin/main'],
    ['allow', 'git reset'],
    ['allow', 'git reset HEAD~1'],
    ['allow', 'git reset --soft HEAD~1'],
    ['allow', 'git merge --abort'],
    ['allow', 'git merge --quit'],
    ['allow', 'git merge --continue'],
    ['allow', 'git merge origin/main'],
    ['allow', 'git merge --no-edit origin/main'],
    ['allow', 'git merge origin/main --no-edit'],
    ['allow', 'git merge origin/hotfix'],
    ['allow', 'git merge origin/feature/nested'],
    ['allow', 'git merge -m "merge main" origin/main'],
    // Redirections are not operands (job 72d9fa14, 2026-09-23): `2>&1` once split on its `&`
    // and left `2>` as a merge target, so the one allowed merge was denied in the shape agents
    // actually type it.
    ['allow', 'git merge origin/main 2>&1'],
    ['allow', 'git merge origin/main 2>&1 | tail -50'],
    ['allow', 'git merge --no-ff origin/main 2>&1 | head -100'],
    ['allow', 'git merge origin/main > /tmp/merge.log 2>&1'],
    ['allow', 'git merge origin/main >/tmp/merge.log 2>/dev/null'],
    ['allow', 'git merge origin/main &> /tmp/merge.log'],
    ['allow', 'git fetch origin 2>&1 && git merge --no-edit origin/main 2>&1'],
    ['deny', 'git merge main 2>&1'],
    ['deny', 'git merge main > /tmp/merge.log'],
    ['deny', 'git switch main 2>&1'],
    ['deny', 'git checkout main 2>&1 | tail'],
    ['deny', 'git rebase origin/main 2>&1'],
    ['allow', 'git rebase --abort'],
    ['allow', 'git rebase --quit'],
    ['allow', 'git rebase --continue'],
    // Reading GitHub stays allowed (issue #82 is about opening PRs, not reading them) —
    // commenting on review feedback included.
    ['allow', 'gh pr view 82 --comments'],
    ['allow', 'gh pr checks 82'],
    ['allow', 'gh pr diff 82'],
    ['allow', 'gh pr status'],
    ['allow', 'gh pr comment 82 --body "fixed in abc"'],
    ['allow', 'gh issue view 82 --comments'],
    ['allow', 'gh api repos/o/r/pulls/82/comments'],
    ['allow', 'npm test'],
    ['allow', 'ls -la'],
    ['allow', "echo 'git switch main'"],
    ['allow', 'echo "git switch main"'],
    ['allow', 'grep "git switch" docs/*.md'],
    ['allow', 'git --no-pager diff'],
    ['allow', 'git --version'],
    ['allow', 'git -C /tmp/other status'],
];

module.exports = { decide, CASES };

if (require.main === module) {
    if (process.argv[2] === '--selftest') {
        let failures = 0;
        for (const [want, command] of CASES) {
            const got = decide(command).deny ? 'deny' : 'allow';
            if (got !== want) {
                failures += 1;
                console.error(`FAIL ${JSON.stringify(command)}: wanted ${want}, got ${got}`);
            }
        }
        if (failures > 0) process.exit(1);
        console.log('GUARD-TABLE-OK');
        process.exit(0);
    }
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        raw += chunk;
    });
    process.stdin.on('end', () => {
        try {
            const verdict = decide(JSON.parse(raw)?.tool_input?.command);
            if (verdict.deny) {
                process.stdout.write(
                    JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: verdict.reason,
                        },
                    }) + '\n',
                );
            }
        } catch {
            // Malformed input fails open, like decide().
        }
        process.exit(0);
    });
}
