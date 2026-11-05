import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';

/**
 * One collapsible tile of the task page's right column: a native `<details>` (it folds with no
 * JavaScript and renders whole to the render-to-string suite) whose head carries the title and a
 * short `aside` that still says something while the tile is shut. Nothing is remembered: every
 * load opens at `defaultOpen`. The aside is text and pills, never a control — a link inside a
 * `<summary>` would be a control inside a control.
 */
export function TaskSection({
    title,
    aside,
    defaultOpen = false,
    className,
    children,
}: {
    title: string;
    aside?: ReactNode;
    defaultOpen?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <details
            className={className === undefined ? 'panel task-section' : `panel task-section ${className}`}
            open={defaultOpen}
        >
            <summary className="task-section-head">
                <Icon name="chevron-right" size={14} />
                <h2>{title}</h2>
                {aside === undefined || aside === null ? null : <span className="task-section-aside">{aside}</span>}
            </summary>
            <div className="task-section-body">{children}</div>
        </details>
    );
}
