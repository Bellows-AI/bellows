import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import {
    createModelSetupStore,
    ModelSetupNameConflict,
    ModelSetupRequestConflict,
    type SetupCommand,
} from '../src/db/model-setup-store.js';
import { ExecutorConnectionRefusedError } from '../src/db/executor-connection-selection.js';
import {
    createProviderConnectionStore,
    ProviderConnectionReferencedError,
} from '../src/db/provider-connection-store.js';
import { createUserExecutorStore, ExecutorDefaultProtectedError } from '../src/db/user-executor-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, spySecrets, testSecretStore } from './env-secrets-harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The model setup's atomic command against Postgres (docs/persistence.md): one sealed connection, one executor
 * referencing it and the default selection commit together or not at all, a retried request replays its receipt,
 * and no credential is copied into the environment or an agent default.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER, BOB_USER], max: 8 });

let sql: Sql;
let healthy: SecretStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    healthy = testSecretStore(sql);
});

function stores(secrets: SecretStore = healthy) {
    const deps = { sql, orgId: ORG, secrets, secretLog: () => {} };
    const executors = createUserExecutorStore(deps);
    const connections = createProviderConnectionStore(deps);
    const setup = createModelSetupStore(deps);
    const jobs = createJobStore({
        sql,
        orgId: ORG,
        env: createEnvVarStore(deps),
        executorConfig: executors,
        providerConnections: connections,
        deploymentMode: 'self-hosted',
    });
    return { executors, connections, setup, jobs };
}

let counter = 0;
const requestId = () => {
    counter += 1;
    return `req-${counter}-${Math.random().toString(36).slice(2, 10)}`;
};

const command = (over: Partial<SetupCommand> = {}): SetupCommand => ({
    scope: 'org',
    userId: ALICE,
    requestId: requestId(),
    connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-setup-A', baseUrl: null, name: 'Anthropic' },
    executor: { name: 'Claude', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
    ...over,
});

const count = async (table: string) =>
    (await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${ORG}'`))[0]!.n;
const selection = async (owner: string | null) =>
    (
        await sql<{ executor_id: string }[]>`
            select executor_id from executor_default_selection
            where org_id = ${ORG} and owner_id is not distinct from ${owner}
        `
    )[0]?.executor_id ?? null;

describe.skipIf(!enabled)('the model setup command', () => {
    it('organization setup publishes one sealed connection executor and default atomically', async () => {
        const { setup, connections, executors } = stores();

        const result = await setup.apply(command());

        expect(result.replayed).toBe(false);
        expect(await count('provider_connection')).toBe(1);
        expect(await count('executor_profile')).toBe(1);
        expect(await selection(null)).toBe(result.executorId);
        const [row] = await executors.listOrg();
        expect(row).toMatchObject({
            id: result.executorId,
            type: 'claude-code',
            providerConnectionId: result.connectionId,
        });
        expect(await connections.credentialFor(ALICE, result.connectionId!)).toMatchObject({ key: 'sk-ant-setup-A' });
        const stored = await sql`select config from executor_profile where org_id = ${ORG}`;
        expect(JSON.stringify(stored)).not.toContain('sk-ant-setup-A');
    });

    it('personal setup cannot use another members connection', async () => {
        const { setup, connections } = stores();
        const bobs = await connections.create({
            scope: 'personal',
            userId: BOB,
            provider: 'anthropic',
            name: 'bobs',
            baseUrl: null,
            key: 'sk-ant-bob',
        });

        await expect(
            setup.apply(command({ scope: 'personal', connection: { intent: 'reuse', id: bobs.id } }))
        ).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);

        expect(await count('executor_profile')).toBe(0);
        expect(await selection(ALICE)).toBeNull();
    });

    it('an organization setup refuses a personal connection and never reaches a personal one by reuse', async () => {
        const { setup, connections } = stores();
        const mine = await connections.create({
            scope: 'personal',
            userId: ALICE,
            provider: 'anthropic',
            name: 'mine',
            baseUrl: null,
            key: 'sk-ant-mine',
        });
        await expect(
            setup.apply(command({ scope: 'org', connection: { intent: 'reuse', id: mine.id } }))
        ).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);
        expect(await count('executor_profile')).toBe(0);
    });

    it('retry concurrent save and rename preserve stable identities', async () => {
        const { setup, executors } = stores();
        const first = command();

        const results = await Promise.all([setup.apply(first), setup.apply(first), setup.apply(first)]);

        expect(new Set(results.map((r) => r.executorId)).size).toBe(1);
        expect(new Set(results.map((r) => r.connectionId)).size).toBe(1);
        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(await count('provider_connection')).toBe(1);
        expect(await count('executor_profile')).toBe(1);

        // A rename through the stable id keeps identity, the default and the connection.
        const renamed = await setup.apply(
            command({
                connection: { intent: 'reuse', id: results[0]!.connectionId! },
                executor: {
                    id: results[0]!.executorId,
                    name: 'Renamed',
                    agentType: 'claude-code',
                    model: 'claude-sonnet-4-5',
                },
            })
        );
        expect(renamed.executorId).toBe(results[0]!.executorId);
        expect((await executors.listOrg()).map((r) => r.name)).toEqual(['Renamed']);
        expect(await selection(null)).toBe(results[0]!.executorId);
        expect(await count('provider_connection')).toBe(1);
    });

    it('the same request id with a different command is refused, not replayed', async () => {
        const { setup } = stores();
        const first = command();
        await setup.apply(first);
        await expect(
            setup.apply({ ...first, executor: { ...first.executor, model: 'claude-opus-4-5' } })
        ).rejects.toBeInstanceOf(ModelSetupRequestConflict);
    });

    it('same-provider name collision never overwrites another credential', async () => {
        const { setup, connections } = stores();
        const first = await setup.apply(command());

        await expect(
            setup.apply(
                command({
                    connection: {
                        intent: 'create',
                        provider: 'anthropic',
                        key: 'sk-ant-setup-B',
                        baseUrl: null,
                        name: 'Anthropic',
                    },
                    executor: { name: 'Other', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
                })
            )
        ).rejects.toBeInstanceOf(ModelSetupNameConflict);

        expect((await connections.credentialFor(ALICE, first.connectionId!))?.key).toBe('sk-ant-setup-A');
        expect(await count('provider_connection')).toBe(1);
        expect(await count('executor_profile')).toBe(1);
        expect(await selection(null)).toBe(first.executorId);
    });

    it('an executor name collision refuses and leaves the connection unwritten', async () => {
        const { setup } = stores();
        await setup.apply(command());
        await expect(
            setup.apply(
                command({
                    connection: {
                        intent: 'create',
                        provider: 'openai',
                        key: 'sk-openai-x',
                        baseUrl: null,
                        name: 'OpenAI',
                    },
                    executor: { name: 'Claude', agentType: 'opencode', model: 'gpt-5' },
                })
            )
        ).rejects.toBeInstanceOf(ModelSetupNameConflict);
        expect(await count('provider_connection')).toBe(1);
    });

    it('reuse and model-only changes do not rotate credentials', async () => {
        const { setup, connections, executors } = stores();
        const first = await setup.apply(command());
        const before = await sql`select secret_ref, secret_version from provider_connection where org_id = ${ORG}`;

        const second = await setup.apply(
            command({
                connection: { intent: 'reuse', id: first.connectionId! },
                executor: {
                    id: first.executorId,
                    name: 'Claude',
                    agentType: 'claude-code',
                    model: 'claude-opus-4-5',
                },
            })
        );
        // A second executor on the same shared connection.
        const third = await setup.apply(
            command({
                connection: { intent: 'reuse', id: first.connectionId! },
                executor: { name: 'Claude two', agentType: 'opencode', model: 'claude-sonnet-4-5' },
            })
        );

        expect(second.executorId).toBe(first.executorId);
        expect(third.connectionId).toBe(first.connectionId);
        expect(await sql`select secret_ref, secret_version from provider_connection where org_id = ${ORG}`).toEqual(
            before
        );
        expect((await connections.credentialFor(ALICE, first.connectionId!))?.key).toBe('sk-ant-setup-A');
        const models = await sql<{ id: string; model: string }[]>`
            select id, config->>'model' as model from executor_profile where org_id = ${ORG}
        `;
        expect(models.find((m) => m.id === first.executorId)?.model).toBe('claude-opus-4-5');
        expect((await executors.listOrg()).length).toBe(2);
    });

    it('explicit rotation changes subsequent claims only', async () => {
        const { setup, jobs } = stores();
        const first = await setup.apply(command());
        await mustCreate(jobs.create('echo one', ALICE, { repo: null, executor: 'Claude', executorScope: 'org' }));
        const running = await jobs.claim('w1', LEASE_SECONDS);
        expect(running?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-setup-A');

        await setup.apply(
            command({
                connection: { intent: 'rotate', id: first.connectionId!, key: 'sk-ant-setup-ROTATED' },
                executor: {
                    id: first.executorId,
                    name: 'Claude',
                    agentType: 'claude-code',
                    model: 'claude-sonnet-4-5',
                },
            })
        );
        await mustCreate(jobs.create('echo two', ALICE, { repo: null, executor: 'Claude', executorScope: 'org' }));
        const later = await jobs.claim('w2', LEASE_SECONDS);

        expect(running?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-setup-A');
        expect(later?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-setup-ROTATED');
        expect(await count('provider_connection')).toBe(1);
    });

    it('rotation reaches only a connection the scope owns', async () => {
        const { setup } = stores();
        const org = await setup.apply(command());
        await expect(
            setup.apply(
                command({
                    scope: 'personal',
                    connection: { intent: 'rotate', id: org.connectionId!, key: 'sk-ant-hijack' },
                })
            )
        ).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);
    });

    it('invalid provider runtime model combinations leave the prior setup intact', async () => {
        const { setup } = stores();
        const first = await setup.apply(command());

        await expect(
            setup.apply(
                command({
                    connection: { intent: 'reuse', id: first.connectionId! },
                    executor: { name: 'Bad', agentType: 'claude-code', model: 'openai/gpt-5' },
                })
            )
        ).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);

        const openai = await setup.apply(
            command({
                connection: {
                    intent: 'create',
                    provider: 'openai',
                    key: 'sk-openai-ok',
                    baseUrl: null,
                    name: 'OpenAI',
                },
                executor: { name: 'GPT', agentType: 'opencode', model: 'gpt-5' },
            })
        );
        await expect(
            setup.apply(
                command({
                    connection: { intent: 'reuse', id: openai.connectionId! },
                    executor: { name: 'Nope', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
                })
            )
        ).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);

        expect(await count('executor_profile')).toBe(2);
        expect(await selection(null)).toBe(openai.executorId);
    });

    it.each(['provider_connection', 'executor_profile', 'executor_default_selection', 'model_setup_operation'])(
        'failure at the %s publication step preserves the previous usable default',
        async (table) => {
            const spy = spySecrets(healthy);
            const { setup, connections } = stores(spy.store);
            const first = await setup.apply(command());
            const secretsBefore = spy.calls.creates.length;

            await sql.unsafe(`
                create or replace function fail_setup_step() returns trigger language plpgsql as
                $$ begin raise exception 'simulated publication failure'; end $$;
                create trigger fail_setup_step before insert or update on ${table}
                    for each row execute function fail_setup_step();
            `);
            try {
                await expect(
                    setup.apply(
                        command({
                            connection: {
                                intent: 'create',
                                provider: 'openai',
                                key: 'sk-openai-fail',
                                baseUrl: null,
                                name: 'Second',
                            },
                            executor: { name: 'Second', agentType: 'opencode', model: 'gpt-5' },
                        })
                    )
                ).rejects.toThrow();
            } finally {
                await sql.unsafe(`drop trigger fail_setup_step on ${table}`);
            }

            const minted = spy.calls.creates.slice(secretsBefore);
            expect(minted).toHaveLength(1);
            expect(spy.calls.deletes.filter((d) => d.ref === minted[0]!.ref)).toHaveLength(1);
            expect(await selection(null)).toBe(first.executorId);
            expect(await count('provider_connection')).toBe(1);
            expect(await count('executor_profile')).toBe(1);
            expect((await connections.credentialFor(ALICE, first.connectionId!))?.key).toBe('sk-ant-setup-A');
        }
    );

    it('a failing secret backend leaves the previous setup untouched and mints nothing referenced', async () => {
        const { setup } = stores();
        const first = await setup.apply(command());
        const failing = stores(
            faultySecrets(healthy, {
                create: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
            })
        );
        await expect(
            failing.setup.apply(
                command({
                    connection: { intent: 'create', provider: 'openai', key: 'sk-x', baseUrl: null, name: 'Second' },
                    executor: { name: 'Second', agentType: 'opencode', model: 'gpt-5' },
                })
            )
        ).rejects.toThrow();
        expect(await selection(null)).toBe(first.executorId);
        expect(await count('provider_connection')).toBe(1);
        expect(await count('executor_profile')).toBe(1);
    });

    it('unknown cleanup reads never delete a referenced secret', async () => {
        const spy = spySecrets(healthy);
        const first = await stores(spy.store).setup.apply(command());
        const deletesBefore = spy.calls.deletes.length;
        // The failed publication's compensation reads the references through a pool that fails: it deletes nothing.
        const trigger = async () =>
            sql.unsafe(`
                create or replace function fail_setup_step() returns trigger language plpgsql as
                $$ begin raise exception 'simulated publication failure'; end $$;
                create trigger fail_setup_step before insert on executor_profile
                    for each row execute function fail_setup_step();
            `);
        await trigger();
        const failingReads = new Proxy(sql, {
            apply(target, thisArg, args: unknown[]) {
                const strings = args[0];
                if (
                    Array.isArray(strings) &&
                    strings.join('?').includes('select secret_ref from provider_connection')
                ) {
                    return Promise.reject(new Error('simulated read failure'));
                }
                return Reflect.apply(target, thisArg, args);
            },
            get(target, prop) {
                const member = Reflect.get(target, prop);
                return typeof member === 'function' ? member.bind(target) : member;
            },
        }) as Sql;
        const deps = { sql: failingReads, orgId: ORG, secrets: spy.store, secretLog: () => {} };
        try {
            await expect(
                createModelSetupStore(deps).apply(
                    command({
                        connection: {
                            intent: 'create',
                            provider: 'openai',
                            key: 'sk-x',
                            baseUrl: null,
                            name: 'Second',
                        },
                        executor: { name: 'Second', agentType: 'opencode', model: 'gpt-5' },
                    })
                )
            ).rejects.toThrow();
        } finally {
            await sql.unsafe('drop trigger fail_setup_step on executor_profile');
        }
        expect(spy.calls.deletes.length).toBe(deletesBefore);
        const stored = await stores().connections.credentialFor(ALICE, first.connectionId!);
        expect(stored?.key).toBe('sk-ant-setup-A');
    });

    it('connection-backed setup creates no env credential rows or agent default', async () => {
        const { setup } = stores();
        await setup.apply(command());
        await setup.apply(
            command({
                scope: 'personal',
                connection: { intent: 'create', provider: 'openai', key: 'sk-openai-p', baseUrl: null, name: 'Mine' },
                executor: { name: 'Mine', agentType: 'opencode', model: 'gpt-5' },
            })
        );
        expect(await count('env_var')).toBe(0);
        expect(await count('agent_default')).toBe(0);
    });

    it('a none intent creates an executor on no connection and leaves ambient credentials alone', async () => {
        const { setup, executors } = stores();
        const result = await setup.apply(
            command({
                scope: 'personal',
                connection: { intent: 'none' },
                executor: { name: 'Platform', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
            })
        );
        expect(result.connectionId).toBeNull();
        expect((await executors.list(ALICE))[0]).toMatchObject({ id: result.executorId, providerConnectionId: null });
        expect(await selection(ALICE)).toBe(result.executorId);
        expect(await count('provider_connection')).toBe(0);
    });

    it('a stale expected revision is refused and writes nothing', async () => {
        const { setup, executors } = stores();
        const first = await setup.apply(command());
        const [row] = await executors.listOrg();
        const stale = new Date(Date.parse(row!.updatedAt) - 60_000).toISOString();
        await expect(
            setup.apply(
                command({
                    connection: { intent: 'reuse', id: first.connectionId! },
                    executor: {
                        id: first.executorId,
                        name: 'Claude',
                        agentType: 'claude-code',
                        model: 'claude-opus-4-5',
                        expectedUpdatedAt: stale,
                    },
                })
            )
        ).rejects.toThrow(/changed/);
        const [unchanged] = await sql`select config->>'model' as model from executor_profile where org_id = ${ORG}`;
        expect(unchanged!.model).toBe('claude-sonnet-4-5');
    });

    it('default replacement and protected deletion cannot leave dangling references', async () => {
        const { setup, executors, connections } = stores();
        const first = await setup.apply(command());
        const second = await setup.apply(
            command({
                connection: { intent: 'create', provider: 'openai', key: 'sk-openai-2', baseUrl: null, name: 'OpenAI' },
                executor: { name: 'GPT', agentType: 'opencode', model: 'gpt-5' },
            })
        );

        // The second executor is now the default; the first is unchanged and deletable.
        expect(await selection(null)).toBe(second.executorId);
        await expect(executors.deleteOrg(second.executorId)).rejects.toBeInstanceOf(ExecutorDefaultProtectedError);
        // A referenced connection cannot be deleted from either executor.
        await expect(connections.remove(null, first.connectionId!)).rejects.toBeInstanceOf(
            ProviderConnectionReferencedError
        );
        expect(await executors.deleteOrg(first.executorId)).toBe(true);
        expect(await connections.remove(null, first.connectionId!)).toBe(true);
        expect(await selection(null)).toBe(second.executorId);
        const refs = await sql`
            select 1 from executor_default_selection s
            left join executor_profile p on p.org_id = s.org_id and p.id = s.executor_id
            where s.org_id = ${ORG} and p.id is null
        `;
        expect(refs).toHaveLength(0);
    });

    it('selecting a second executor changes the default without touching the first', async () => {
        const { setup, executors } = stores();
        const first = await setup.apply(command());
        const [before] = await executors.listOrg();
        const second = await setup.apply(
            command({
                connection: { intent: 'create', provider: 'openai', key: 'sk-openai-3', baseUrl: null, name: 'OpenAI' },
                executor: { name: 'GPT', agentType: 'opencode', model: 'gpt-5' },
            })
        );
        expect(await selection(null)).toBe(second.executorId);
        const rows = await executors.listOrg();
        expect(rows.find((r) => r.id === first.executorId)).toEqual(before);
    });
});
