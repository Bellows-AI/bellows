import type { BoardJob } from '../board/board.js';
import { secretsPath } from './k8s-auxspec.js';
import { secretName } from './k8s-podspec.js';
import { boundedBy, is2xx, type K8sDeps, withSignal } from './k8s-transport.js';
import { REBIND_DEADLINE_MS } from '../runner.js';
import { SUPERVISOR_BINDING, type SupervisorBinding } from '../supervisor-contract.js';
import { bindingBody } from '../supervisor-plan.js';

/**
 * Writes `binding` into the attempt Secret's binding key (#829): the kubelet refreshes it into the
 * supervisor's optional read-only volume. A merge patch of that one key; the answer is discarded
 * unread and the errors are fixed text, since both would quote the token. Resolves only on a 2xx;
 * any rejection means "maybe written" — a 404 proves nothing about the group.
 */
export async function rebindGroup(
    deps: K8sDeps,
    group: BoardJob,
    binding: SupervisorBinding,
    signal: AbortSignal
): Promise<void> {
    const body = bindingBody(binding);
    const bounded = withSignal(boundedBy(deps, Date.now() + REBIND_DEADLINE_MS), signal);
    const failed = new Error(`rebinding the task group of job ${group.id} failed`);
    const res = await bounded
        .request('PATCH', `${secretsPath(deps.config.k8sNamespace)}/${secretName(group)}`, {
            data: { [SUPERVISOR_BINDING.file]: Buffer.from(body).toString('base64') },
        })
        .catch(() => {
            throw failed;
        });
    if (!is2xx(res.status)) throw new Error(`rebinding the task group of job ${group.id} answered ${res.status}`);
}
