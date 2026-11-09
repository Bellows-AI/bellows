import type { BoardJob } from './board.js';
import type { ServiceSpec } from '../services.js';
import { connectionOutcomesOf } from './board-connection.js';
import { skillHiddenFields, skillPinFields } from './board-skills.js';
import { isExecutorType } from '../executors.js';

/** The claim off the wire: every optional field read defensively, defaulted or dropped (issue #774 reviewer profiles, #769 plan, BEL-273 skill pin). */

/** A claim text field read defensively: the string the board sent, else null. */
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The claim's `turnContext` when it is a non-empty string, else absent. */
const knownTurnContext = (value: unknown): Pick<BoardJob, 'turnContext'> =>
    typeof value === 'string' && value.length > 0 ? { turnContext: value } : {};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A service entry of the claim's plan, as far as the driver's argv and pod specs rely on it. */
const isServiceSpec = (value: unknown): value is ServiceSpec =>
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.image === 'string' &&
    Array.isArray(value.environment) &&
    value.environment.every(
        (entry) => isRecord(entry) && typeof entry.key === 'string' && typeof entry.value === 'string'
    );

/**
 * The claim's resolved services, read defensively. A malformed list is the board breaking its own
 * contract, never something to start a container from: it refuses the plan like any other.
 */
const servicePlanOf = (value: unknown): Pick<BoardJob, 'services'> & { refusal: string | null } => {
    if (value === undefined || value === null) return { refusal: null };
    if (!Array.isArray(value) || !value.every(isServiceSpec)) {
        return { refusal: 'The board delivered a malformed service list in the execution plan.' };
    }
    return { refusal: null, services: value };
};

/** A claim off the wire, read into the shape the loop works with: every optional field defaulted or dropped. */
export function claimOf(wire: Partial<BoardJob>): BoardJob {
    // Destructured out rather than left in the base spread: an invalid (non-array) value
    // must not survive under exactOptionalPropertyTypes, which refuses assigning
    // `undefined` to this optional property directly — the conditional spread below is
    // the only way to represent "absent".
    const {
        helperPlans,
        turnContext,
        services,
        reviewerProfiles,
        connectionOutcomes,
        skillPin,
        skillHidden,
        ...claimed
    } = wire;
    const plan = servicePlanOf(services);
    return {
        ...(claimed as BoardJob),
        ...skillPinFields(skillPin),
        ...skillHiddenFields(skillHidden),
        ...(Array.isArray(helperPlans) ? { helperPlans } : {}),
        ...(plan.services ? { services: plan.services } : {}),
        ...reviewerProfilesOf(reviewerProfiles),
        ...connectionOutcomesOf(connectionOutcomes),
        ...knownTurnContext(turnContext),
        masterPrompt: textOrNull(claimed.masterPrompt),
        resumeSessionId: claimed.resumeSessionId ?? null,
        followUp: claimed.followUp ?? false,
        userId: claimed.userId ?? null,
        workspacePath: claimed.workspacePath ?? null,
        rootJobId: claimed.rootJobId ?? null,
        executorType: isExecutorType(claimed.executorType) ? claimed.executorType : null,
        executorRefusal: textOrNull(claimed.executorRefusal),
        skillRefusal: textOrNull(claimed.skillRefusal),
        planRefusal: plan.refusal ?? textOrNull(claimed.planRefusal),
        env: claimed.env ?? {},
    };
}

/** The claim's reviewer profile names, or nothing: an empty or malformed list reads as no reviewer (issue #774). */
function reviewerProfilesOf(value: unknown): { reviewerProfiles?: readonly string[] } {
    const names = Array.isArray(value) ? (value as unknown[]) : [];
    return names.length > 0 && names.every((name) => typeof name === 'string')
        ? { reviewerProfiles: names as string[] }
        : {};
}
