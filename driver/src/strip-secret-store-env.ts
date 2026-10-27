/**
 * The secret store's keys belong to the dashboard process alone (docs/secrets.md). A driver started
 * from a shell or an env file that carries them deletes them before anything reads `process.env`,
 * so no config, child process or runner environment can inherit one.
 */
export function stripSecretStoreEnv(env: Record<string, string | undefined>): void {
    for (const name of Object.keys(env)) {
        if (name.startsWith('SECRETS_')) {
            delete env[name];
        }
    }
}
