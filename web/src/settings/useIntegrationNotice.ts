import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { integrationNotice, type IntegrationNotice } from './integration-providers.js';

/** The router-state key a disconnect leaves for the overview: the site's name, from which the sentence is built. */
export const DISCONNECTED_STATE = 'disconnected';

const disconnectedNotice = (state: unknown): IntegrationNotice | null => {
    const site = (state as Record<string, unknown> | null)?.[DISCONNECTED_STATE];
    return typeof site === 'string' ? { message: `Disconnected ${site}.`, tone: 'info' } : null;
};

/**
 * The sentence a page was arrived at with, consumed once: the callback's `?integration=&result=` or a disconnect's
 * router state. It is kept as state and taken off the URL and the history entry, so a reload or a bookmark does not
 * bring it back. `clear` drops the sentence when the member acts again.
 */
export function useIntegrationNotice(): { notice: IntegrationNotice | null; clear: () => void } {
    const [notice, setNotice] = useState<IntegrationNotice | null>(null);
    const [params, setParams] = useSearchParams();
    const { state } = useLocation();

    useEffect(() => {
        const found = disconnectedNotice(state) ?? integrationNotice(params.get('integration'), params.get('result'));
        if (!found) return;
        setNotice(found);
        const next = new URLSearchParams(params);
        next.delete('integration');
        next.delete('result');
        setParams(next, { replace: true, state: null });
    }, [params, setParams, state]);

    return { notice, clear: () => setNotice(null) };
}
