import type { ConnectPrompt } from '../api/useJobs.js';

/** The link a refused start offers beside its sentence: the forge's sign-in, which replaces the member's grant. */
export function ConnectLink({ connect }: { connect: ConnectPrompt | null }) {
    if (connect === null) return null;
    return <a href={connect.url}>Connect {connect.label}</a>;
}
