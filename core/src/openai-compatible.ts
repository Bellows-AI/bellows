/** The OpenAI-compatible custom endpoint's OpenCode block: shared by the guided executor config and the connection provider. */

/** The one OpenCode provider id a connection's OpenAI-compatible endpoint is rendered under, whatever its host. */
export const CUSTOM_PROVIDER_ID = 'custom';

/** The npm package an OpenAI-compatible endpoint's block loads: the generic OpenAI-wire SDK. */
export const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

/** The opencode provider id a custom endpoint's block is keyed under: its host, slugified, else `custom`. */
export function customProviderId(baseUrl: string): string {
    let host = '';
    try {
        host = new URL(baseUrl).hostname;
    } catch {
        return 'custom';
    }
    const slug = host
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'custom';
}

/** The declared model entry opencode needs for an id no catalog carries (the lane's own shape). */
export const customModelEntry = {
    name: '',
    tool_call: true,
    limit: { context: 200_000, output: 8192 },
};
