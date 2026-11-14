import { ADMIN_ROLE } from '@factory-ai/core';
import { roleLabel } from '../api/useSession.js';
import { Icon } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { StateNote } from '../components/StateNote.js';
import { AuditLogSection } from '../panels/AuditLogSection.js';
import { EnvVarsSection } from '../panels/EnvVarsSection.js';
import { MembersSection } from '../panels/MembersSection.js';
import { NotificationSubscriptionsSection } from '../panels/NotificationSubscriptionsSection.js';
import { RetentionSection } from '../panels/RetentionSection.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Organization section of the settings tree (issue 180): who is signed in, what the org
 * environment scope is, and the one org-level editor. The old "not built yet" stub is gone.
 *
 * The editor follows the server's contract: `PUT /api/env/org` is an admin route (a member gets a
 * tested 403, server/test/routes.env.test.ts), so a member reads the rows with no write control
 * beside the sentence naming who manages them. Until the session lands the view is read-only too.
 */
export function SettingsOrganizationPage() {
    const { env, session } = useSettingsPage();
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Organization"
                description="Identity and the environment values injected into every runner in the organization."
            />

            {session ? (
                <div className="org-identity">
                    {/* Identity, not authority: the display name and the role title. No internal id,
                        no powers inferred beyond what the API grants. */}
                    <Icon name="building" size={20} />
                    <strong className="org-identity-name">{session.organization.name}</strong>
                    <span className="muted">Your role</span>
                    <span className="pill">{roleLabel(session.role)}</span>
                </div>
            ) : (
                <p className="muted">Checking your session…</p>
            )}

            {/* The roster and its role writes (issue 410): the section owns its state and CRUD,
                the way OrgExecutorsSection does — the page composes. */}
            <MembersSection session={session} />

            <NotificationSubscriptionsSection session={session} scope="org" />

            {/* How long finished tasks are kept (docs/retention.md): every member reads it. */}
            <RetentionSection />

            {/* Who did what in the organization, with its export: an admin read, like the roster. */}
            <AuditLogSection session={session} />

            {env.error ? <StateNote state="error">{env.error}</StateNote> : null}
            {/*
                The summary mounts only on DATA, not merely when the request settles: its draft is
                seeded from the stored rows once per mount, so opening it early would freeze
                empty rows over whatever is stored — after a failed read an enabled editor would
                be one save away from wiping the scope. The error line above is the read-only
                posture; a retry is the page's next full render.
            */}
            {env.loading && !env.data ? (
                <StateNote state="loading">Loading environment…</StateNote>
            ) : env.data ? (
                <EnvVarsSection
                    title="Organization variables"
                    vars={env.data.org}
                    onSave={env.saveOrg}
                    draftId="org"
                    draftLabel="Organization variables"
                    readOnly={session?.role !== ADMIN_ROLE}
                />
            ) : null}
        </>
    );
}
