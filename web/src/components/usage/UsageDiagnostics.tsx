import type { ReactNode } from 'react';
import type { Tokens, UsageBlock } from '@factory-ai/core';
import { TokenFigures } from './TokenFigures.js';
import { UNASSIGNED_SENTENCES, UNLOCATED_SENTENCE, UNRESOLVED_TEMPORALITY_SENTENCE } from './usage-format.js';

const hasAmount = (tokens: Tokens): boolean => Object.values(tokens).some((value) => value !== null && value > 0);

/** "Not in the figures above": what the totals leave out, kept apart from them. Empty renders nothing. */
export function UsageDiagnostics({ usage, children }: { usage: UsageBlock; children?: ReactNode }) {
    const unassigned = usage.unassigned.filter((entry) => hasAmount(entry.tokens));
    const unlocated = hasAmount(usage.unlocated);
    const unresolved = usage.unresolvedTemporality.observations;
    if (!unlocated && unresolved === 0 && unassigned.length === 0 && children === undefined) return null;
    return (
        <section className="usage-diagnostics" aria-label="Not in the figures above">
            <p>Not in the figures above</p>
            <ul>
                {unlocated ? (
                    <li>
                        {UNLOCATED_SENTENCE}
                        <TokenFigures tokens={usage.unlocated} />
                    </li>
                ) : null}
                {unresolved > 0 ? (
                    <li>
                        {unresolved} {UNRESOLVED_TEMPORALITY_SENTENCE}
                    </li>
                ) : null}
                {unassigned.map((entry) => (
                    <li key={entry.reason} data-reason={entry.reason}>
                        {UNASSIGNED_SENTENCES[entry.reason]}
                        <TokenFigures tokens={entry.tokens} />
                    </li>
                ))}
            </ul>
            {children}
        </section>
    );
}
