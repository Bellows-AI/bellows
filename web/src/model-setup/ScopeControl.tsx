import type { SetupScope } from '../api/useModelSetup.js';

/**
 * Who a save is for: everyone in the organization (admins only) or only the member. A member gets "Only me" alone,
 * with the sentence that says why.
 */
export function ScopeControl({
    ids,
    legend,
    orgName,
    admin,
    value,
    onChange,
}: {
    ids: string;
    legend: string;
    orgName: string;
    admin: boolean;
    value: SetupScope;
    onChange: (scope: SetupScope) => void;
}) {
    const help = !admin
        ? `Only an admin can add a key for everyone in ${orgName}. This one is yours alone.`
        : value === 'org'
          ? 'Members start tasks without a key of their own. Usage is billed to this key.'
          : 'Only your tasks use this. Other members bring their own, or an admin adds one for everyone.';
    return (
        <fieldset className="picker-field" aria-describedby={`${ids}-scope-help`}>
            <legend>{legend}</legend>
            <div className="model-scope">
                {admin ? (
                    <label className="settings-toggle">
                        <input
                            type="radio"
                            name={`${ids}-scope`}
                            checked={value === 'org'}
                            onChange={() => onChange('org')}
                        />
                        Everyone in {orgName}
                    </label>
                ) : null}
                <label className="settings-toggle">
                    <input
                        type="radio"
                        name={`${ids}-scope`}
                        checked={value === 'personal'}
                        onChange={() => onChange('personal')}
                    />
                    Only me
                </label>
            </div>
            <p className="picker-help" id={`${ids}-scope-help`}>
                {help}
            </p>
        </fieldset>
    );
}
