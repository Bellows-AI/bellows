import { parseArgs } from 'node:util';
import type { BoardClient } from './board.js';
import { preflightChecks } from './diagnostics.js';
import type { ConfigSummary } from './diagnostics.js';
import { parseOrUsage, UsageError } from './input.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { renderAuthStatus, renderPreflight } from './render.js';
import { SELECTION_OPTIONS, selectionOf } from './selection.js';
import { BoardError } from './transport.js';
import { USAGE } from './usage.js';

/**
 * The diagnostic commands, `job preflight` and `auth status`. Both only issue GETs the board
 * already serves: no create, sync or token write.
 */

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;
const PREFLIGHT_NOTE = 'preflight is advisory: the board rechecks at create and at claim\n';

/** A create's selection checked against the caller's reads, each read made only when the selection needs it. */
export async function preflightCommand(args: readonly string[], boardFor: () => BoardClient): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...SELECTION_OPTIONS } })
    );
    if (parsed.positionals.length > 0) throw new UsageError(`preflight takes no command\n\n${USAGE}`);
    const selection = selectionOf(parsed.values);
    const client = boardFor();
    const workspace = await client.workspace();
    // Advisory like the rest: a list that cannot be read leaves the repo unverified, the board decides at create.
    const repos = selection.repo === undefined ? null : await client.listRepos().catch(() => null);
    const skills = selection.skills ? await client.listSkills() : [];
    const connections = selection.jiraConnection === undefined ? [] : await client.listConnections();
    const preflight = preflightChecks(selection, { workspace, repos, skills, connections });
    const stdout = `${renderPreflight(preflight)}\n`;
    const blocked = preflight.checks.find((check) => check.status === 'blocked');
    if (!blocked) return { outcome: OUTCOME.ok, data: preflight, stdout, stderr: PREFLIGHT_NOTE };
    const message = `not ready to launch: ${blocked.detail}`;
    return {
        outcome: OUTCOME.refused,
        data: preflight,
        error: { message, code: null, status: null },
        stdout,
        stderr: `error: ${message}\n${PREFLIGHT_NOTE}`,
    };
}

const HTTP_UNAUTHORIZED = 401;
const NOT_SIGNED_IN =
    "not signed in — set FACTORY_TOKEN to a personal access token minted from the board's settings page";

/**
 * Where the CLI points and who it acts as, without a credential in the output: the configuration
 * with the token reduced to set/kind, the board's version, then `GET /api/auth/me` under the token.
 * A failure keeps what was learned before it in `data`, so a script can see which stage broke.
 */
export async function authStatusCommand(
    config: ConfigSummary,
    client: BoardClient,
    failureOf: (error: unknown) => CommandResult
): Promise<CommandResult> {
    let board: { version: string } | null = null;
    try {
        board = await client.version();
        const me = await client.me();
        if (!me.authenticated) {
            return {
                outcome: OUTCOME.refused,
                data: { config, board, identity: null },
                error: { message: NOT_SIGNED_IN, code: null, status: null },
                stderr: `error: ${NOT_SIGNED_IN}\n`,
            };
        }
        const identity = {
            login: me.user.login,
            name: me.user.name,
            userId: me.user.id,
            organization: me.organization,
            role: me.role,
            authMode: me.mode,
        };
        return {
            outcome: OUTCOME.ok,
            data: { config, board, identity },
            stdout: `${renderAuthStatus({ config, board, identity })}\n`,
        };
    } catch (error) {
        const failure =
            error instanceof BoardError && error.status === HTTP_UNAUTHORIZED
                ? new BoardError(
                      `${error.message} (the token was refused — mint a new personal token from the settings page)`,
                      error.status,
                      error.code
                  )
                : error;
        return { ...failureOf(failure), data: { config, board, identity: null } };
    }
}
