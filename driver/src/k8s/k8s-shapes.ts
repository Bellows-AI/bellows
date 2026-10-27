import type { BoardJob } from '../board/board.js';
import { runnerJobName } from './k8s-podspec.js';
import { isRecord, JOB_ID } from './k8s-transport.js';
import { parseRfc3339 } from '../timestamps.js';

/**
 * The grammar of every field a destructive decision reads off an apiserver object (#869), one
 * function per field kind or object part, reused by every reader. A reader that gets a field outside
 * its grammar answers inconclusive; absence of evidence never matches. The fields each reader
 * validates, and who reads them, are listed in the table of the round's report, not here.
 */

/** A non-empty string: a name, a uid. */
export const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A lease token or a job id: the repo's uuid grammar. */
export const isLease = (value: unknown): value is string => typeof value === 'string' && JOB_ID.test(value);

/** A count the apiserver serializes: a non-negative safe integer. */
export const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Each field a string when present. */
export const optionalStrings = (...fields: unknown[]): boolean =>
    fields.every((field) => field === undefined || typeof field === 'string');

/** A timestamp the apiserver serializes, when set: RFC 3339 (`timestamps.ts`); null is unset, as the kubelet writes it for a container it lost. */
export const optionalTimestamp = (value: unknown): boolean =>
    value === undefined || value === null || (typeof value === 'string' && parseRfc3339(value) !== null);

/** A string map: a record whose every value is a string. */
export const stringsOnly = (value: unknown): boolean =>
    isRecord(value) && Object.values(value).every((v) => typeof v === 'string');

/** The path of the first of `checks` that `part` fails, `at` itself when it is no record; null when it is absent or passes. */
const partFault = (
    part: unknown,
    at: string,
    checks: readonly (readonly [string, (part: Record<string, unknown>) => boolean])[]
): string | null => {
    if (part === undefined) return null;
    if (!isRecord(part)) return at;
    const failed = checks.find(([, ok]) => !ok(part));
    return failed ? `${at}.${failed[0]}` : null;
};

/** The path, from `at`, of the first part of `state` outside the grammar of a container state; null when it is absent or readable. */
export const containerStateFault = (state: unknown, at = 'state'): string | null => {
    if (state === undefined) return null;
    if (!isRecord(state)) return at;
    return (
        partFault(state.terminated, `${at}.terminated`, [
            ['exitCode', (t) => Number.isSafeInteger(t.exitCode)],
            ['reason', (t) => optionalStrings(t.reason)],
            ['message', (t) => optionalStrings(t.message)],
            ['startedAt', (t) => optionalTimestamp(t.startedAt)],
        ]) ??
        partFault(state.running, `${at}.running`, [['startedAt', (r) => optionalTimestamp(r.startedAt)]]) ??
        partFault(state.waiting, `${at}.waiting`, [
            ['reason', (w) => optionalStrings(w.reason)],
            ['message', (w) => optionalStrings(w.message)],
        ])
    );
};

/**
 * The path, from the pod's `status`, of the first container status outside the grammar: each a record,
 * named, with a readable state and passing `extra` (a fault path from the status, or null). Null when
 * `statuses` is absent or readable.
 */
export const containerStatusesFault = (
    statuses: unknown,
    at: string,
    extra: (status: Record<string, unknown>) => string | null = () => null
): string | null => {
    if (statuses === undefined) return null;
    if (!Array.isArray(statuses)) return at;
    for (const [i, s] of statuses.entries()) {
        if (!isRecord(s)) return `${at}[${i}]`;
        if (!nonEmpty(s.name)) return `${at}[${i}].name`;
        const fault = containerStateFault(s.state) ?? extra(s);
        if (fault !== null) return `${at}[${s.name}].${fault}`;
    }
    return null;
};

/** A container status whose image, when named, is a string. */
export const imageFault = (status: Record<string, unknown>): string | null =>
    optionalStrings(status.image) ? null : 'image';

/** A sidecar's status: its image, a restart count that is a count, and a previous ending of the same typed shape as `state`. */
export const sidecarFault = (status: Record<string, unknown>): string | null => {
    if (imageFault(status) !== null) return 'image';
    if (status.restartCount !== undefined && !isCount(status.restartCount)) return 'restartCount';
    return containerStateFault(status.lastState, 'lastState');
};

/** A pod's `conditions`, when present: a list of records with a string type and string words. */
export const validPodConditions = (conditions: unknown): boolean =>
    conditions === undefined ||
    (Array.isArray(conditions) &&
        conditions.every(
            (c) => isRecord(c) && typeof c.type === 'string' && optionalStrings(c.status, c.reason, c.message)
        ));

/** A Job's containers, when it has a template: a non-empty list of records, each named — a pod runs at least one. */
const validContainers = (containers: unknown): boolean =>
    Array.isArray(containers) && containers.length > 0 && containers.every((c) => isRecord(c) && nonEmpty(c.name));

/**
 * A runner Job's `spec`, as far as "does it run an agent, and is it suspended" reads it: a record,
 * `suspend` a boolean when present, and the pod template's containers a list of named records. A Job
 * named as a runner whose spec is not this cannot say it runs no agent: its read is inconclusive.
 */
export const validRunnerSpec = (spec: unknown): boolean => {
    if (!isRecord(spec) || (spec.suspend !== undefined && typeof spec.suspend !== 'boolean')) return false;
    const template = spec.template;
    return isRecord(template) && isRecord(template.spec) && validContainers(template.spec.containers);
};

/** Whether `item`, a listed or read Job, is the runner Job of `pair` (the name the pair hashes to). */
const namedAsRunner = (item: { metadata: { name: string } }, pair: BoardJob): boolean =>
    item.metadata.name === runnerJobName(pair);

/**
 * `item` (a Job whose `metadata` is already a named record) answers for a runner of `pair` only with
 * a readable spec; any other Job is not decided on by its spec, and passes.
 */
export const runnerSpecReadable = (item: { metadata: { name: string }; spec?: unknown }, pair: BoardJob): boolean =>
    !namedAsRunner(item, pair) || validRunnerSpec(item.spec);
