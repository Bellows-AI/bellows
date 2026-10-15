import { parseArgs } from 'node:util';
import type { BoardClient } from './board.js';
import { parseOrUsage, UsageError } from './input.js';
import { OUTCOME } from './outcome.js';
import { renderActivity } from './render.js';

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;

/** The command line of a job-scoped read: exactly one job id and the flags the command takes. */
function parseJobArgs(args: readonly string[], verb: string, usage: string) {
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options: JSON_OPTION }));
    if (parsed.positionals.length !== 1) throw new UsageError(`${verb} needs exactly one job id\n\n${usage}`);
    return { id: parsed.positionals[0]! };
}

/** `job activity <id>`. */
export async function activityCommand(args: readonly string[], client: BoardClient, usage: string) {
    const { id } = parseJobArgs(args, 'activity', usage);
    const activity = await client.activity(id);
    return { outcome: OUTCOME.ok, data: activity, stdout: `${renderActivity(activity)}\n` };
}
