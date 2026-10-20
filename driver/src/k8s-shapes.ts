import type { BoardJob } from './board.js';
import { runnerJobName } from './k8s-podspec.js';
import { isRecord, JOB_ID } from './k8s-transport.js';
import { parseRfc3339 } from './timestamps.js';

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

/** A timestamp the apiserver serializes, when present: RFC 3339 (`timestamps.ts`). */
export const optionalTimestamp = (value: unknown): boolean =>
    value === undefined || (typeof value === 'string' && parseRfc3339(value) !== null);

/** A string map: a record whose every value is a string. */
export const stringsOnly = (value: unknown): boolean =>
    isRecord(value) && Object.values(value).every((v) => typeof v === 'string');

/** Whether `state` is absent or a record whose present parts are records with the typed fields a decision reads. */
const validContainerState = (state: unknown): boolean => {
    if (state === undefined) return true;
    if (!isRecord(state)) return false;
    const { terminated, running, waiting } = state;
    if (terminated !== undefined) {
        if (!isRecord(terminated) || !Number.isSafeInteger(terminated.exitCode)) return false;
        if (!optionalStrings(terminated.reason, terminated.message) || !optionalTimestamp(terminated.startedAt)) {
            return false;
        }
    }
    if (running !== undefined && (!isRecord(running) || !optionalTimestamp(running.startedAt))) return false;
    return waiting === undefined || (isRecord(waiting) && optionalStrings(waiting.reason, waiting.message));
};

/** A pod's `containerStatuses`, when present: a list of records, each named, each with a readable state. */
export const validContainerStatuses = (statuses: unknown): boolean =>
    statuses === undefined ||
    (Array.isArray(statuses) && statuses.every((s) => isRecord(s) && nonEmpty(s.name) && validContainerState(s.state)));

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
