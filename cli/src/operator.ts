import { parseArgs } from 'node:util';
import type { BoardClient } from './board.js';
import { noArguments, parseOrUsage, UsageError } from './input.js';
import type { OperatorAction, OperatorOrg } from './operator-routes.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { USAGE } from './usage.js';

/**
 * `bellows operator …`: an HTTP client of the board operator's routes (docs/organizations.md) — list every
 * organization with its status, suspend, refuse or reactivate one, and queue a suspended or refused one's purge
 * (`operator delete … --yes`). The board decides who the operator is
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

export function operatorCommands<Io>(boardFor: (io: Io) => BoardClient) {
    const commands: Record<string, (args: readonly string[], io: Io) => Promise<CommandResult>> = {
        'operator list': (args, io) => list(args, () => boardFor(io)),
    };
    for (const action of ACTIONS) commands[`operator ${action}`] = (args, io) => act(action, args, () => boardFor(io));
    commands['operator delete'] = (args, io) => remove(args, () => boardFor(io));
    return commands;
}
