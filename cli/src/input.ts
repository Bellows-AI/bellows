/**
 * The one resolver for a prompt's text: create, follow-up and the edit command all read it through
 * `resolveCommandInput`, so the source rules and the bounds cannot drift apart. Every refusal is a
 * `UsageError`, raised before the caller makes a request.
 */

/** An argument problem: the command line, not the board, is what refused. */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

/** Runs a parse step, turning whatever it throws into a usage error. */
export function parseOrUsage<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }
}

/** The board's command bound (`core/src/limits.ts`), copied because the CLI imports nothing. */
export const COMMAND_LIMIT = 16_384;

export const FILE_OPTION = 'file';
export const STDIN_OPTION = 'stdin';

/** The options every prompt-taking command declares. */
export const INPUT_OPTIONS = {
    [FILE_OPTION]: { type: 'string' },
    [STDIN_OPTION]: { type: 'boolean', default: false },
} as const;

export interface InputIo {
    readFile?: ((path: string) => Promise<string>) | undefined;
    readStdin?: (() => Promise<string>) | undefined;
}

export interface InputSelection {
    positionals: readonly string[];
    file?: string | undefined;
    stdin?: boolean | undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function readSource(selection: InputSelection, io: InputIo): Promise<string> {
    if (selection.file !== undefined) {
        if (!io.readFile) throw new UsageError(`--${FILE_OPTION} is not available here`);
        try {
            return await io.readFile(selection.file);
        } catch (error) {
            throw new UsageError(`cannot read --${FILE_OPTION} ${selection.file}: ${messageOf(error)}`);
        }
    }
    if (selection.stdin) {
        if (!io.readStdin) throw new UsageError(`--${STDIN_OPTION} is not available here`);
        try {
            return await io.readStdin();
        } catch (error) {
            throw new UsageError(`cannot read --${STDIN_OPTION}: ${messageOf(error)}`);
        }
    }
    return selection.positionals.join(' ').trim();
}

/**
 * Exactly one source: the positional words (joined with a space, as a shell would), `--file <path>`
 * or `--stdin`. File and stdin text is passed through untouched — newlines and Unicode survive —
 * and only a blank or oversized result is refused.
 */
export async function resolveCommandInput(selection: InputSelection, io: InputIo): Promise<string> {
    const sources = [
        selection.positionals.length > 0 ? 'the command words' : null,
        selection.file !== undefined ? `--${FILE_OPTION}` : null,
        selection.stdin ? `--${STDIN_OPTION}` : null,
    ].filter((source) => source !== null);
    if (sources.length > 1) {
        throw new UsageError(`give the command from one source, not ${sources.join(' and ')}`);
    }

    const text = await readSource(selection, io);
    if (!text.trim()) throw new UsageError('the command is empty');
    if (text.length > COMMAND_LIMIT) {
        throw new UsageError(`the command is ${text.length} characters; the limit is ${COMMAND_LIMIT}`);
    }
    return text;
}
