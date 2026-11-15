import { NUMBERED_STEPS, reselectHref, type SetupPlace, type SetupState } from '../onboarding/steps.js';

type Mark = 'current' | 'done' | 'skipped' | 'open';

const MARK_CLASS: Record<Mark, string | undefined> = {
    current: undefined,
    done: 'setup-step-done',
    skipped: 'setup-step-skipped',
    open: undefined,
};

/** What a screen reader hears after the label; the ✓ and – glyphs are decoration. */
const MARK_WORD: Record<Mark, string | null> = { current: null, done: 'done', skipped: 'skipped', open: null };

function markOf(place: SetupPlace, current: SetupPlace, setup: Pick<SetupState, 'done' | 'skipped'> | undefined): Mark {
    if (place === current) return 'current';
    // Past the selection screen, Repositories is answered: the session exists because of it.
    if (place === 'repositories') return 'done';
    if (place === 'model' || place === 'tools') {
        if (setup?.done.includes(place)) return 'done';
        if (setup?.skipped.includes(place)) return 'skipped';
    }
    return 'open';
}

/**
 * The setup walk's progress: an ordered list, the current step `aria-current="step"`, a
 * finished step ✓ and a skipped one –. Off the selection screen, Repositories is a plain anchor to
 * the reselect round trip back to `here` — a `fetch` cannot follow the GitHub 302, and bare
 * `/onboarding` has no pending sign-in behind it once the session exists.
 */
export function SetupStepper({
    current,
    setup,
    here = '/',
}: {
    current: Exclude<SetupPlace, 'ready'>;
    setup?: Pick<SetupState, 'done' | 'skipped'> | undefined;
    /** The current step's own address, the reselect's return path. */
    here?: string;
}) {
    return (
        <ol className="setup-steps" aria-label="Setup progress">
            {NUMBERED_STEPS.map((step, index) => {
                const mark = markOf(step.place, current, setup);
                const glyph = mark === 'done' ? '✓' : mark === 'skipped' ? '–' : String(index + 1);
                const word = MARK_WORD[mark];
                const label =
                    step.place === 'repositories' && mark !== 'current' ? (
                        <a href={reselectHref(here)}>{step.label}</a>
                    ) : (
                        step.label
                    );
                return (
                    <li
                        key={step.place}
                        className={MARK_CLASS[mark]}
                        aria-current={mark === 'current' ? 'step' : undefined}
                    >
                        <span className="setup-step-mark" aria-hidden="true">
                            {glyph}
                        </span>
                        {label}
                        {word ? <span className="visually-hidden"> ({word})</span> : null}
                    </li>
                );
            })}
        </ol>
    );
}
