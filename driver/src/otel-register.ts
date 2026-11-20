import { startOtel } from './otel.js';

/** Imported first by `index.ts`: instrumentation patches a module only if it is enabled before that module loads. */
export const otel = startOtel();
