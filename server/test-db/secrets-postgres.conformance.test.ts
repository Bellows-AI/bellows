import { describe } from 'vitest';
import { describeSecretStoreConformance } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { createPostgresHarness } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

describe.skipIf(!enabled)('the postgres secret store', () => {
    describeSecretStoreConformance('the postgres aes-gcm secret store', () => createPostgresHarness(db.sql));
});
