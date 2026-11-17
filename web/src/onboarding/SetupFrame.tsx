import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../api/useSession.js';
import { PublicPageHeader } from '../components/PublicPageHeader.js';
import { SetupStepper } from '../components/SetupStepper.js';
import { ThemeSelector } from '../components/ThemeSelector.js';
import { setupContext, type SetupPlace } from './steps.js';

/**
 * The chrome every step after Repositories renders inside: the public header with the
 * step's context and the appearance control, the `.onboarding` column, the stepper on a numbered
 * step, and the page's one `h1`. The stepper's marks come from this mount's own `/api/auth/me`
 * read, so a step entered after a recorded skip shows it.
 */
export function SetupFrame({
    place,
    title,
    purpose,
    children,
}: {
    place: Exclude<SetupPlace, 'repositories'>;
    title: string;
    purpose: string;
    children: ReactNode;
}) {
    const { session } = useSession();
    const { pathname, search } = useLocation();
    return (
        <>
            <PublicPageHeader context={setupContext(place)} actions={<ThemeSelector />} />
            {/* Ready holds the task composer and its control bar, so it takes the wide measure. */}
            <main className={place === 'ready' ? 'onboarding onboarding-wide' : 'onboarding'}>
                {place === 'ready' ? null : (
                    <SetupStepper current={place} setup={session?.setup} here={`${pathname}${search}`} />
                )}
                <h1>{title}</h1>
                <p className="onboarding-purpose">{purpose}</p>
                {children}
            </main>
        </>
    );
}
