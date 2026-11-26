/**
 * A self-managed GitLab behind a private CA (docs/connections.md): the claim's `forgeCa` is the connection's CA
 * chain — a public certificate chain, not a secret, but untrusted board input. It is kept only as PEM certificate
 * blocks, under a size cap, for a job whose repository is on GitLab; anything else is dropped with a log line that
 * names no PEM. Every consumer trusts it as a FILE for the forge host alone (`http.https://<host>/.sslCAInfo`):
 * the agent (`RUNNER_FORGE_CA`, both entrypoints), the supervisor's forge steps (`SUPERVISOR_FORGE_CA`) and a gate
 * (`FACTORY_FORGE_CA`, scripts/gate-shell.sh) — never by turning TLS verification off.
 */
import type { BoardJob } from './board/board.js';
import { FORGE_CA_ENV, forgeHostsOf } from './claim.js';
import { logger } from './log.js';

export { FORGE_CA_ENV };

/** The claim's CA field (`BoardJob` extends it). */
export interface ClaimForgeCa {
    /** A GitLab connection's private CA chain, PEM certificates only (`forgeCaField`); absent: the system bundle. */
    forgeCa?: string;
}
/** A gate step's env the chain rides in, as one line (`gateForgeCa`): the gate mailbox's env is one line per name. */
export const GATE_FORGE_CA_ENV = 'FACTORY_FORGE_CA';
/**
 * The most bytes of chain a claim may carry. Each consumer receives it as ONE env string (or one `docker -e` argv
 * string), which Linux caps at 128 KiB (MAX_ARG_STRLEN): a longer one would fail every exec of the container.
 */
export const FORGE_CA_MAX_BYTES = 122_880;

/** A PEM certificate block: its base64 body lines, CRLF or trailing blanks tolerated. */
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[ \t]*\r?\n((?:[A-Za-z0-9+/=]+[ \t]*\r?\n)+)-----END CERTIFICATE-----/g;
/** Any PEM header, to count the blocks a value holds whatever their type. */
const PEM_HEADER = /-----BEGIN [^-\n]*-----/g;

/**
 * The certificate blocks of `value`, re-emitted with LF line ends and a final newline, or the fault that leaves none
 * to keep: a fixed phrase, never quoting the value. Text between the blocks (a bundle file's comments) is not kept;
 * another PEM type (a key) or a malformed block drops the whole value.
 */
function certificateChain(value: unknown): { chain: string } | { fault: string } {
    if (typeof value !== 'string') return { fault: 'not a string' };
    if (Buffer.byteLength(value, 'utf8') > FORGE_CA_MAX_BYTES) return { fault: `over ${FORGE_CA_MAX_BYTES} bytes` };
    const blocks = [...value.matchAll(PEM_BLOCK)].map(([, body = '']) =>
        ['-----BEGIN CERTIFICATE-----', ...body.trim().split(/[ \t]*\r?\n/), '-----END CERTIFICATE-----'].join('\n')
    );
    const headers = value.match(PEM_HEADER)?.length ?? 0;
    if (blocks.length === 0 || blocks.length !== headers) return { fault: 'not PEM certificate blocks only' };
    return { chain: `${blocks.join('\n')}\n` };
}

/**
 * The claim's `forgeCa` as the job keeps it (`certificateChain`) — or nothing, with one log line, for a malformed
 * value or a job whose repository is not on a single GitLab host.
 */
export function forgeCaField(value: unknown, job: Partial<Pick<BoardJob, 'id' | 'repo'>>): Pick<BoardJob, 'forgeCa'> {
    if (value === undefined || value === null) return {};
    const kept =
        forgeHostsOf(job).length === 1 ? certificateChain(value) : { fault: 'the job’s repository is not on GitLab' };
    if ('fault' in kept) {
        logger('driver').warn(
            `the board delivered a forge CA for job ${job.id} that is not usable (${kept.fault}); dropped`
        );
        return {};
    }
    return { forgeCa: kept.chain };
}

/** The chain a job's consumers trust: a GitLab job's kept chain, else null. */
export const forgeCaOf = (job: Pick<BoardJob, 'repo' | 'forgeCa'>): string | null =>
    job.forgeCa && forgeHostsOf(job).length > 0 ? job.forgeCa : null;

/** `RUNNER_FORGE_CA` for the agent, only where the job has a chain to trust. */
export function forgeCaEnv(job: Pick<BoardJob, 'repo' | 'forgeCa'>): [string, string][] {
    const chain = forgeCaOf(job);
    return chain ? [[FORGE_CA_ENV, chain]] : [];
}

/** The chain as a gate's one-line env value: each PEM line a comma-separated field (no PEM line holds a comma). */
export function gateForgeCa(job: Pick<BoardJob, 'repo' | 'forgeCa'>): string | null {
    return forgeCaOf(job)?.trimEnd().split('\n').join(',') ?? null;
}
