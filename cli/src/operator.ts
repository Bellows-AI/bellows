import { parseArgs } from 'node:util';
import type { BoardClient } from './board.js';
import { noArguments, parseOrUsage, UsageError } from './input.js';
import type { DriverCredential, OperatorAction, OperatorOrg } from './operator-routes.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { USAGE } from './usage.js';

/**
 * `bellows operator …`: an HTTP client of the board operator's routes (docs/organizations.md) — list every
 * organization with its status, suspend, refuse or reactivate one, and queue a suspended or refused one's purge
 * (`operator delete … --yes`); list, issue, revoke and rotate the per-driver credentials, whose token is printed only by
 * the issue or rotation that minted it. The board decides who the operator is
 * (`OPERATOR_GITHUB_IDS`); anyone else gets its 403.
 */

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;
const ACTIONS: readonly OperatorAction[] = ['suspend', 'refuse', 'activate'];

function positionals(args: readonly string[]): string[] {
    return parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options: JSON_OPTION })).positionals;
}

const ok = (data: unknown, text: string): CommandResult => ({ outcome: OUTCOME.ok, data, stdout: `${text}\n` });

const renderOrgs = (orgs: readonly OperatorOrg[]): string =>
    orgs.length === 0 ? 'no organizations' : orgs.map((org) => `${org.id}  ${org.name}  ${org.status}`).join('\n');

async function list(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    noArguments(args, 'operator list');
    const orgs = await board().operatorOrgs();
    return ok({ orgs }, renderOrgs(orgs));
}

async function remove(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    const { positionals: ids, values } = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, yes: { type: 'boolean' } } })
    );
    if (ids.length !== 1) throw new UsageError(`operator delete needs exactly one organization id\n\n${USAGE}`);
    // A purge removes every row, object and secret of the org and cannot be undone; there is no prompt to ask through.
    if (!values.yes) {
        throw new UsageError('operator delete purges the organization and cannot be undone — pass --yes to confirm');
    }
    const asked = await board().operatorDelete(ids[0]!);
    const { org } = asked;
    return ok(asked, `organization ${org.id} (${org.name}) is ${asked.requested ? '' : 'already '}queued for deletion`);
}

async function act(action: OperatorAction, args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    const ids = positionals(args);
    if (ids.length !== 1) throw new UsageError(`operator ${action} needs exactly one organization id\n\n${USAGE}`);
    const change = await board().operatorAction(ids[0]!, action);
    const { org } = change;
    return ok(change, `organization ${org.id} (${org.name}) is ${change.changed ? 'now' : 'already'} ${org.status}`);
}

const reachOf = (credential: DriverCredential): string =>
    credential.pool ? 'pool' : `orgs ${credential.orgs.join(',') || '(none left)'}`;

const stateOf = (credential: DriverCredential): string => {
    if (credential.revokedAt) return 'revoked';
    return credential.expiresAt ? `expires ${credential.expiresAt}` : 'active';
};

async function credentials(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    noArguments(args, 'operator credentials');
    const listed = await board().driverCredentials();
    const text =
        listed.length === 0
            ? 'no driver credentials'
            : listed.map((c) => `${c.id}  ${c.label}  ${reachOf(c)}  ${stateOf(c)}`).join('\n');
    return ok({ credentials: listed }, text);
}

const SHOWN_ONCE = 'the token is shown only this once:';

async function issueCredential(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    const { positionals: extra, values } = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                ...JSON_OPTION,
                label: { type: 'string' },
                org: { type: 'string', multiple: true },
                pool: { type: 'boolean', default: false },
            },
        })
    );
    const orgs = values.org ?? [];
    if (extra.length > 0 || !values.label || values.pool === orgs.length > 0) {
        throw new UsageError(`operator issue-credential needs --label and either --org <id> or --pool\n\n${USAGE}`);
    }
    const issued = await board().issueDriverCredential(values.label, values.pool ? null : orgs);
    const { credential } = issued;
    return ok(
        issued,
        `driver credential ${credential.id} (${credential.label}) issued for ${reachOf(credential)}; ${SHOWN_ONCE}\n${issued.token}`
    );
}

async function revokeCredential(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    const ids = positionals(args);
    if (ids.length !== 1) {
        throw new UsageError(`operator revoke-credential needs exactly one credential id\n\n${USAGE}`);
    }
    const revoked = await board().revokeDriverCredential(ids[0]!);
    const { credential } = revoked;
    return ok(
        revoked,
        `driver credential ${credential.id} (${credential.label}) is ${revoked.revoked ? 'now' : 'already'} revoked`
    );
}

async function rotateCredential(args: readonly string[], board: () => BoardClient): Promise<CommandResult> {
    const { positionals: ids, values } = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { ...JSON_OPTION, overlap: { type: 'string' } },
        })
    );
    if (ids.length !== 1) {
        throw new UsageError(`operator rotate-credential needs exactly one credential id\n\n${USAGE}`);
    }
    if (values.overlap !== undefined && !/^\d+$/.test(values.overlap)) {
        throw new UsageError('operator rotate-credential: --overlap must be a whole number of seconds');
    }
    const overlap = values.overlap === undefined ? undefined : Number(values.overlap);
    const rotated = await board().rotateDriverCredential(ids[0]!, overlap);
    const { credential, previous } = rotated;
    return ok(
        rotated,
        `driver credential ${credential.id} (${credential.label}) replaces ${previous.id}, which works until ` +
            `${previous.expiresAt ?? 'now'}; ${SHOWN_ONCE}\n${rotated.token}`
    );
}

export function operatorCommands<Io>(boardFor: (io: Io) => BoardClient) {
    const commands: Record<string, (args: readonly string[], io: Io) => Promise<CommandResult>> = {
        'operator list': (args, io) => list(args, () => boardFor(io)),
    };
    for (const action of ACTIONS) commands[`operator ${action}`] = (args, io) => act(action, args, () => boardFor(io));
    commands['operator delete'] = (args, io) => remove(args, () => boardFor(io));
    commands['operator credentials'] = (args, io) => credentials(args, () => boardFor(io));
    commands['operator issue-credential'] = (args, io) => issueCredential(args, () => boardFor(io));
    commands['operator revoke-credential'] = (args, io) => revokeCredential(args, () => boardFor(io));
    commands['operator rotate-credential'] = (args, io) => rotateCredential(args, () => boardFor(io));
    return commands;
}
