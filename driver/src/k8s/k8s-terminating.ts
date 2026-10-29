import { isRecord } from './k8s-transport.js';
import { nonEmpty, optionalTimestamp } from './k8s-shapes.js';

/** A listed object already deleting: since when (its `deletionTimestamp`), and a pod's node. */
export interface Terminating {
    since: string;
    node?: string;
}

/** The deletion-related fields of a listed leftover, as far as the sweep reads them. */
interface Deleting {
    metadata: { deletionTimestamp?: string | null };
    spec?: unknown;
}

/**
 * `item` unless it is no leftover or its `deletionTimestamp` is not a time (or unset) or a pod's
 * `spec.nodeName` not a name (absent: an unscheduled pod has none). A malformed value makes the whole
 * list inconclusive — it is never read as "deleting" or as "not".
 */
export const wellFormedDeleting = <T extends Deleting>(item: T | null, kind: string): T | null =>
    item !== null &&
    optionalTimestamp(item.metadata.deletionTimestamp) &&
    (kind !== 'pod' || !isRecord(item.spec) || item.spec.nodeName === undefined || nonEmpty(item.spec.nodeName))
        ? item
        : null;

/** Notes a well-formed leftover that carries a deletion time (and a pod's node) in `into`, by name. */
export function noteTerminating(
    into: Map<string, Terminating>,
    item: Deleting & { metadata: { name: string } },
    kind: string
): void {
    const since = item.metadata.deletionTimestamp;
    if (!since) return;
    const node = kind === 'pod' && isRecord(item.spec) ? item.spec.nodeName : undefined;
    into.set(item.metadata.name, typeof node === 'string' ? { since, node } : { since });
}

/** Names the leftovers still deleting when EVERY listed leftover is; undefined when any is not. */
export function stuckAmong(
    fleets: { kind: string; uids: Map<string, string>; terminating: Map<string, Terminating> }[]
): string | undefined {
    const stuck: string[] = [];
    for (const fleet of fleets) {
        for (const name of fleet.uids.keys()) {
            const t = fleet.terminating.get(name);
            if (t === undefined) return undefined;
            const on = t.node === undefined ? '' : ` on node ${t.node}`;
            stuck.push(
                `the leftover ${fleet.kind} ${name}${on} is still terminating after its delete (since ${t.since})`
            );
        }
    }
    return stuck.length > 0 ? stuck.join('; ') : undefined;
}
