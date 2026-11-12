import { Navigate, Outlet } from 'react-router-dom';
import { useShell } from './AppShell.js';

/**
 * The batch routes' gate: Batches is a deployment flag the session reports as `batches`.
 * Off, a direct visit to any `/batches*` address lands where a mistyped path does, on the
 * dashboard, so no batch page and no empty state renders and no batch read is issued. While the
 * session is still unknown nothing renders either — never a page on an unconfirmed flag, and never
 * a redirect that would bounce an enabled board's deep link.
 */
export function BatchesGate() {
    const { session, sessionLoading } = useShell();
    if (sessionLoading) return null;
    if (session?.batches !== true) return <Navigate to="/" replace />;
    return <Outlet />;
}
