import { request } from './request.js';
/**
 * The one organization switch. The app bar's selector and the mobile drawer's both call this —
 * the switch is a server-side session change, and on success the reload makes every org-scoped
 * read re-probe from scratch. A refusal (403/400 — the membership moved under the selector)
 * leaves the page untouched: the select's value is bound to the payload, so the next poll
 * renders it back on the org the session still holds.
 */
export function switchOrg(orgId: string): void {
    void request('/api/auth/org', { method: 'POST', body: { orgId }, empty: true }).then((result) => {
        if (result.ok) window.location.reload();
    });
}
