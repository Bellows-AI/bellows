import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { integrationNotice, type IntegrationNotice } from './integration-providers.js';

/**
 * The callback's `?integration=&result=` consumed once: kept as state and taken off the URL, so a reload or a
 * bookmark does not bring the sentence back. `clear` drops the sentence when the member acts again.
 */
export function useIntegrationNotice(): { notice: IntegrationNotice | null; clear: () => void } {
    const [notice, setNotice] = useState<IntegrationNotice | null>(null);
    const [params, setParams] = useSearchParams();

    useEffect(() => {
        const found = integrationNotice(params.get('integration'), params.get('result'));
        if (!found) return;
        setNotice(found);
        const next = new URLSearchParams(params);
        next.delete('integration');
        next.delete('result');
        setParams(next, { replace: true });
    }, [params, setParams]);

    return { notice, clear: () => setNotice(null) };
}
