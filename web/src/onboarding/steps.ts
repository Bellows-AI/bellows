/** A setup step the member records (`POST /api/onboarding/setup`); Repositories is the sign-in's own. */
export type RecordedStep = 'provider' | 'tools';

/** Where the setup walk can stand: the three numbered steps, then the closing page. */
export type SetupPlace = 'repositories' | RecordedStep | 'ready';

/** `/api/auth/me`'s `setup`: whether the walk is over, and what was finished or skipped. */
export interface SetupState {
    completed: boolean;
    done: readonly RecordedStep[];
    skipped: readonly RecordedStep[];
}

const RECORDED: readonly RecordedStep[] = ['provider', 'tools'];

/** The stepper's steps, in order. Ready closes the walk and is not numbered. */
export const NUMBERED_STEPS: readonly { place: Exclude<SetupPlace, 'ready'>; label: string }[] = [
    { place: 'repositories', label: 'Repositories' },
    { place: 'provider', label: 'Provider' },
    { place: 'tools', label: 'Tools' },
];

/** The first step neither finished nor skipped, Ready once both are answered, nothing once setup is complete. */
export function nextSetupStep(setup: SetupState): RecordedStep | 'ready' | null {
    if (setup.completed) return null;
    return RECORDED.find((step) => !(setup.done.includes(step) || setup.skipped.includes(step))) ?? 'ready';
}

/** The public header's context line for a place in the walk. */
export function setupContext(place: SetupPlace): string {
    const index = NUMBERED_STEPS.findIndex((step) => step.place === place);
    return index < 0 ? 'Ready' : `Setup · Step ${index + 1} of ${NUMBERED_STEPS.length}`;
}

/** A same-origin path (one leading `/`, not `//` or `/\`), else `/` — a query value is never trusted as a target. */
export function safeReturnTo(value: string | null | undefined): string {
    if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
    return value;
}

/** A step's address, carrying where the member was going. */
export function setupPath(step: RecordedStep | 'ready', returnTo: string): string {
    return `/onboarding/${step}?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Back to Repositories: the reselect round trip, which reopens the selection screen and returns to
 * `returnTo`. Bare `/onboarding` has no pending sign-in behind it once the session exists.
 */
export function reselectHref(returnTo: string): string {
    return `/api/auth/github?reselect=1&returnTo=${encodeURIComponent(returnTo)}`;
}
