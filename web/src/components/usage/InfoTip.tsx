import { type ReactNode, useId, useState } from 'react';

/**
 * A small "i" or "?" button whose popover holds detail the strip leaves out. Hover and focus
 * reveal it (CSS); a click or tap pins it open, Escape closes it. The popover stays in the DOM,
 * so its figures remain reachable to assistive tech through `aria-describedby`.
 */
export function InfoTip({ label, glyph = 'i', children }: { label: string; glyph?: 'i' | '?'; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <span className="info-tip" data-open={open ? 'true' : undefined}>
            <button
                type="button"
                className="info-tip-button"
                aria-label={label}
                aria-expanded={open}
                aria-describedby={id}
                onClick={() => setOpen((value) => !value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') setOpen(false);
                }}
            >
                <span aria-hidden="true">{glyph}</span>
            </button>
            <span id={id} className="info-tip-pop" role="tooltip">
                {children}
            </span>
        </span>
    );
}
