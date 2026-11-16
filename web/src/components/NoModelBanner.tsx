import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useModelSetup } from '../api/useModelSetup.js';
import { Icon } from './Icon.js';

/**
 * The shell's "No model yet" warning, above every app page while `GET /api/model-setup` confirms
 * `effective: null`. A read in flight or a failed one shows nothing: an unconfirmed answer never
 * warns. It re-reads when the window regains focus (a key saved in another tab), never on a timer,
 * and a save through `useModelSetup` anywhere re-reads it.
 */
export function NoModelBanner() {
    const { data, error, refresh } = useModelSetup();
    useEffect(() => {
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [refresh]);
    if (error !== null || data?.effective !== null) return null;
    return (
        <div className="banner-warn no-model-banner" role="status">
            <Icon name="alert-triangle" size={24} />
            <p>
                No model yet — tasks will wait until one is connected. <Link to="/settings/model">Connect a model</Link>
            </p>
        </div>
    );
}
