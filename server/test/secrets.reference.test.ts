import { describeSecretStoreConformance } from './secrets-conformance.js';
import { createReferenceHarness } from './secrets-reference-store.js';

describeSecretStoreConformance('the reference secret store', () => createReferenceHarness());
