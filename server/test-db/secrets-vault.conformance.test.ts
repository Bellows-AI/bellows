import { describe } from 'vitest';
import { describeSecretStoreConformance } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { createVaultHarness } from './secrets-vault-harness.js';
import { vaultProviderReachable } from './secrets-vault-provider.js';

const enabled = Boolean(process.env.DATABASE_URL) && vaultProviderReachable;
const db = useTestDb({ max: 8 });

describe.skipIf(!enabled)('the vault secret store', () => {
    describeSecretStoreConformance('the vault kv v2 store', () => createVaultHarness(db.sql));
});
