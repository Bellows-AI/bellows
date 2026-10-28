import { describe } from 'vitest';
import { describeSecretStoreConformance } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { awsProviderReachable } from './secrets-aws-provider.js';
import { createExternalHarness } from './secrets-external-harness.js';

const enabled = Boolean(process.env.DATABASE_URL) && awsProviderReachable;
const db = useTestDb({ max: 8 });

describe.skipIf(!enabled)('the aws secret store', () => {
    describeSecretStoreConformance('the aws secrets manager store', () => createExternalHarness(db.sql));
});
