import { createHmac } from 'node:crypto';
import type { BoardJob, DeclaredGate } from './board/board.js';
import { envBodyRecord } from './gates.js';

/**
 * The identity of one gate run's configuration (issue #983): the command, its timeout, the image,
 * setup, cache, services and the env the run gets, as one HMAC-SHA256 hex digest. A gate run is reused
 * at completion only when this is equal, so a changed env VALUE must change it; the digest is keyed by
 * a secret every driver of the board shares (`JOB_BOARD_TOKEN`), so identities stay comparable across
 * a takeover and no raw value is ever stored or sent. The gate's name is not part of it: the record is
 * read per name. `envBody` is the gate's env WITHOUT the per-run GitHub token.
 */
export function gateIdentity(secret: string, job: BoardJob, gate: DeclaredGate, envBody: string): string {
    const key = createHmac('sha256', secret).update('factory-gate-identity-v1').digest();
    const env = envBodyRecord(envBody);
    const payload = canonical({
        command: gate.command,
        timeoutMinutes: gate.timeoutMinutes ?? null,
        image: job.gates?.image ?? null,
        setup: job.gates?.setup ?? null,
        cache: job.gates?.cache ?? null,
        services: job.services ?? null,
        env: Object.keys(env)
            .sort()
            .map((name) => [name, env[name]]),
    });
    return createHmac('sha256', key).update(payload).digest('hex');
}

/** JSON with every object's keys sorted: the same value always hashes the same. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
