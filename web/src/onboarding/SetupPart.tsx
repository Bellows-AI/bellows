import type { ReactNode } from 'react';

/** One numbered part of a step: its number and heading, then its fields. */
export function SetupPart({ number, title, children }: { number: number; title: string; children: ReactNode }) {
    return (
        <section className="setup-part">
            <div className="setup-part-head">
                <span className="num" aria-hidden="true">
                    {number}
                </span>
                <h2>{title}</h2>
            </div>
            {children}
        </section>
    );
}
