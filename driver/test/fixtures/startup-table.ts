import { startupHaltOf } from '../../src/loop/loop-fence.js';
import { StartupRefused } from '../../src/startup-cause.js';

/**
 * How a group start that did not come up ends, one row per cause, with the decision the loop takes —
 * the conformance table both executors run (`docker/`, `k8s/`), each row through its own
 * harness and its own platform's words for the refusal. Typed as a `Record`, so neither suite can
 * leave a row out. `unclassified` is a refusal whose words prove no cause: the path keeps the
 * recovery it had (issue #824 D11).
 */
export const STARTUP_TABLE = {
    'the platform never brought the group up': 'interruption',
    'a registry that timed out': 'interruption',
    'a registry rate limit': 'interruption',
    'a TLS handshake that timed out': 'interruption',
    'a missing image': 'config',
    'an invalid image reference': 'config',
    'an unauthorized pull': 'config',
    'an untrusted registry certificate': 'config',
    'a container configuration the platform refuses': 'config',
    'a refusal whose words prove no cause': 'unclassified',
    'a run specced for another session than its group': 'unclassified',
    'a supervisor that started and never answered': 'unclassified',
} as const;

export type StartupRow = keyof typeof STARTUP_TABLE;

/** The loop's decision on what a refused group start threw, through the one mapping it uses. */
export function startupDecisionOf(thrown: unknown): string {
    if (!(thrown instanceof StartupRefused)) return 'unclassified';
    const halt = startupHaltOf(thrown);
    return halt.halt === 'interrupt' ? 'interruption' : halt.halt === 'fault' ? (halt.verdict.failureKind ?? '') : '';
}

export const STARTUP_ROWS = Object.entries(STARTUP_TABLE) as [StartupRow, string][];
