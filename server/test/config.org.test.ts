import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';

/** All required now, and none of these cases is about any of them. */
const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => ({
    DATABASE_URL: DB,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
    ...extra,
});

describe('the organization', () => {
    it('has no configured org at all: the orgs are the App installations (#99)', () => {
        const config = loadConfig(env());
        expect('orgId' in config).toBe(false);
        expect('orgName' in config).toBe(false);
        // The repo list is gone rather than empty. A configured list beside an installation would
        // be a second roster to keep in step, and the installation is also the credential.
        expect('repos' in config).toBe(false);
    });

    it('names the single local org AUTH_MODE=none lives in', () => {
        // Not config — a constant. There is nothing to configure it from: no sign-in, no
        // installation, so the offline tooling shares one literal partition.
        expect(LOCAL_ORG_ID).toBe('default');
    });
});

/** The three ways the original cases booted: App credentials, the bare database, and offline. */
const BOOTS = {
    app: (extra: NodeJS.ProcessEnv) => loadConfig(env(extra)),
    bare: (extra: NodeJS.ProcessEnv) => loadConfig({ DATABASE_URL: DB, ...extra }),
    offline: (extra: NodeJS.ProcessEnv) => loadConfig({ DATABASE_URL: DB, ...extra }, { mode: 'none' }),
};

describe('retired variables are fatal, not ignored', () => {
    /*
     * The deliberate exception to "an unknown environment variable is ignored". Each one used to
     * decide what the page was made of — the org, its repos, the PAT, the data source, the
     * pull-request pipeline — so a quietly dropped one boots a dashboard whose operator believes
     * it is reading something else. A variable that worked yesterday must not silently no-op.
     * The App credentials and AUTH_* retirements are pinned beside their own config.
     */
    it.each<[string, string, keyof typeof BOOTS, RegExp[]]>([
        ['ORG_ID', 'acme', 'app', []],
        ['ORG_NAME', 'Bellows AI', 'app', []],
        ['GITHUB_APP_INSTALLATION_ID', '4242', 'app', []],
        ['GITHUB_APP_INSTALLATION_ID', '42', 'app', []],
        ['ORG_REPOS', 'a,b', 'app', []],
        ['GITHUB_REPOS', 'a,b', 'app', []],
        ['GITHUB_OWNER', 'acme', 'app', []],
        ['GITHUB_TOKEN', 'ghp_x', 'bare', []],
        ['DATA_SOURCE', 'fixture', 'offline', []],
        ['DATA_SOURCE', 'github', 'offline', []],
        // A deployment that had raised it to protect its quota would otherwise silently drop to
        // the 60s-per-repo sync floor; it is re-pointed at the telemetry slot.
        ['CACHE_TTL_SECONDS', '1800', 'offline', []],
        ['CACHE_TTL_SECONDS', '300', 'offline', [/TELEMETRY_TTL_SECONDS/]],
        ['SYNC_TTL_SECONDS', '900', 'offline', [/TELEMETRY_TTL_SECONDS/]],
        ['BASE_BRANCH', 'main', 'offline', []],
        ['BOTS', 'claude', 'offline', []],
    ])('refuses %s=%s (%s boot)', (name, value, boot, hints) => {
        const load = () => BOOTS[boot]({ [name]: value });
        expect(load).toThrow(new RegExp(`${name} is no longer supported`));
        for (const hint of hints) expect(load).toThrow(hint);
    });

    // docker-compose passes several of these empty whenever the host has not set them, so a stale
    // .env line still boots: an empty value is not an override here any more than anywhere else.
    it.each<NodeJS.ProcessEnv>([
        { ORG_ID: '' },
        { ORG_ID: '  ' },
        { ORG_NAME: '' },
        { GITHUB_APP_INSTALLATION_ID: '' },
        { GITHUB_REPOS: '', ORG_REPOS: '', GITHUB_OWNER: '' },
        { GITHUB_TOKEN: '', ORG_REPOS: '', GITHUB_OWNER: '' },
    ])('treats an empty retired variable as unset: %j', (extra) => {
        expect(() => BOOTS.app(extra)).not.toThrow();
    });
});
