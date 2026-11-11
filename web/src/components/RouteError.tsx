import { useRouteError } from 'react-router-dom';
import { StateNote } from './StateNote.js';

/**
 * The router's `errorElement`: what a render error anywhere under the route shows instead of a
 * blank page. Reloading is the recovery — the thrown state is gone with the tree.
 */
export function RouteError() {
    const error = useRouteError();
    console.error(error);
    return (
        <main className="panel">
            <h1>Something went wrong</h1>
            <StateNote state="error">{error instanceof Error ? error.message : 'The page failed to render.'}</StateNote>
            <button type="button" onClick={() => window.location.reload()}>
                Reload
            </button>
        </main>
    );
}
