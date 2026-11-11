import { describe } from 'vitest';
import { describeSecretStoreConformance } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { createGcpHarness } from './secrets-gcp-harness.js';

const db = useTestDb({ max: 8 });

describe.skipIf(!process.env.DATABASE_URL)('the gcp secret store', () => {
    describeSecretStoreConformance('the google cloud secret manager store', () => createGcpHarness(db.sql));
});
