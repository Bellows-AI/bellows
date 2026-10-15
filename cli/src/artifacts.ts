import { type ParseArgsConfig, parseArgs } from 'node:util';
import type { ArtifactFilters, ArtifactPage, BoardClient } from './board.js';
import { parseOrUsage, UsageError } from './input.js';
import { OUTCOME } from './outcome.js';
import { renderActivity, renderArtifactSegments, renderArtifactStreams } from './render.js';

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;
const SELECTION_OPTIONS = {
    stream: { type: 'string' },
    attempt: { type: 'string' },
    session: { type: 'string' },
    executor: { type: 'string' },
} as const;
const READ_OPTIONS = {
    ...SELECTION_OPTIONS,
    cursor: { type: 'string' },
    limit: { type: 'string' },
    all: { type: 'boolean', default: false },
} as const;

type Values = Record<string, string | boolean | undefined>;

/** The command line of a job-scoped read: exactly one job id and the flags the command takes. */
function parseJobArgs(args: readonly string[], verb: string, usage: string, options: ParseArgsConfig['options']) {
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options }));
    if (parsed.positionals.length !== 1) throw new UsageError(`${verb} needs exactly one job id\n\n${usage}`);
    return { id: parsed.positionals[0]!, values: parsed.values as Values };
}

function integerFlag(name: string, raw: string | boolean | undefined): number | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer`);
    return Number(raw);
}

function filtersOf(values: Values): ArtifactFilters {
    return {
        stream: values.stream as string | undefined,
        attempt: integerFlag('attempt', values.attempt),
        session: values.session as string | undefined,
        executor: values.executor as string | undefined,
        cursor: values.cursor as string | undefined,
        limit: integerFlag('limit', values.limit),
    };
}

/** `job activity <id>`. */
export async function activityCommand(args: readonly string[], client: BoardClient, usage: string) {
    const { id } = parseJobArgs(args, 'activity', usage, JSON_OPTION);
    const activity = await client.activity(id);
    return { outcome: OUTCOME.ok, data: activity, stdout: `${renderActivity(activity)}\n` };
}

/** `job streams <id>`: every stream of the run across attempts and sessions, each with its state. */
export async function streamsCommand(args: readonly string[], client: BoardClient, usage: string) {
    const { id, values } = parseJobArgs(args, 'streams', usage, { ...JSON_OPTION, ...SELECTION_OPTIONS });
    const { streams } = await client.artifactStreams(id, filtersOf(values));
    return { outcome: OUTCOME.ok, data: { streams }, stdout: `${renderArtifactStreams(streams)}\n` };
}

/**
 * `job read <id>`: one page of the selected streams' text, or with `--all` every page until the end.
 * A page that is not the last prints the cursor that continues it.
 */
export async function readCommand(args: readonly string[], client: BoardClient, usage: string) {
    const { id, values } = parseJobArgs(args, 'read', usage, { ...JSON_OPTION, ...READ_OPTIONS });
    const filters = filtersOf(values);
    let page: ArtifactPage = await client.readArtifacts(id, filters);
    const segments = [...page.segments];
    while (values.all === true && page.nextCursor !== null) {
        page = await client.readArtifacts(id, { ...filters, cursor: page.nextCursor });
        segments.push(...page.segments);
    }
    const text = renderArtifactSegments(page.streams, segments);
    const next = page.nextCursor === null ? '' : `# more: --cursor ${page.nextCursor}\n`;
    return {
        outcome: OUTCOME.ok,
        data: { streams: page.streams, segments, nextCursor: page.nextCursor },
        stdout: `${text === '' ? '' : `${text}\n`}${next}`,
    };
}
