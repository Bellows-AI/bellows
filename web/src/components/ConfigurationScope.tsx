import type { ReactElement } from 'react';

/**
 * The readable scope context an environment editor renders before its controls (issue 180): what
 * the scope applies to, who may edit it, and where a value of the same name would win. Presenta-
 * tional by contract, like PageHeader — no hooks, no fetching, no route inspection — and plain
 * text on purpose: scope truth is never a tooltip, a disabled input, or a color-only badge.
 *
 * Deliberately NOT the analytics `ScopeToggle` (issue 166): that one switches the dashboard's data
 * cut and carries buttons; this one states facts and renders no control at all.
 *
 * The write rules below are the server's, not this component's wish: `PUT /api/env/org` and
 * `PUT /api/env/repo` accept any member of the installation (membership is the one trust level,
 * #99) and `PUT /api/env/workspace` writes the caller's own rows — server/test/routes.env.test.ts
 * pins all three. Precedence — organization < workspace < repository, most specific wins — is
 * `stackEnv`'s rule, exported from the store and pinned offline there.
 */

export type ConfigurationScopeId = 'organization' | 'workspace' | 'repository';

export type ConfigurationScopeProps =
    | { scope: 'organization' | 'workspace' }
    | { scope: 'repository'; repository: { owner: string; name: string } };

/** The one precedence summary every scope shows; the per-scope long form sits in a disclosure. */
const PRECEDENCE_SUMMARY =
    'Organization \u2192 My workspace \u2192 Repository. The rightmost scope wins for the same key.';

/** Per-scope copy, in one table so the three editors cannot drift apart. */
const COPY: Record<ConfigurationScopeId, { impact: string; editability: string; detail: string }> = {
    organization: {
        impact: 'Applies to every member\u2019s tasks in the organization.',
        editability: 'Any member can edit.',
        detail: 'Environment values resolve organization < workspace < repository: a workspace or repository value with the same name overrides this scope.',
    },
    workspace: {
        impact: 'Applies to tasks you start.',
        editability: 'Edited only by that member.',
        detail: 'Environment values resolve organization < workspace < repository: these values override the organization scope, and a repository value with the same name overrides them.',
    },
    repository: {
        impact: 'Applies to every task using {repo} in the organization.',
        editability: 'Any member can edit.',
        detail: 'Environment values resolve organization < workspace < repository: these values override the organization and workspace scopes, and nothing more specific remains.',
    },
};

/** The scope context an editor head renders under its title: impact, who edits, and precedence
 * stated once (the long form behind a disclosure). */
export function ConfigurationScope(props: ConfigurationScopeProps): ReactElement {
    const copy = COPY[props.scope];
    const fullName = props.scope === 'repository' ? `${props.repository.owner}/${props.repository.name}` : null;
    return (
        <div className="scope-context">
            <p>{fullName ? copy.impact.replace('{repo}', fullName) : copy.impact}</p>
            <p>{copy.editability}</p>
            <p className="muted">{PRECEDENCE_SUMMARY}</p>
            <details className="scope-detail">
                <summary>How precedence works</summary>
                <p className="muted">{copy.detail}</p>
            </details>
        </div>
    );
}
