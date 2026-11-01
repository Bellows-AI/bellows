/** An account's avatar when it carries one, else its initial; decorative — the login is rendered beside it. */
export function Avatar({ author, size }: { author: { login: string; avatarUrl: string | null }; size: number }) {
    return author.avatarUrl !== null ? (
        <img className="avatar" src={author.avatarUrl} alt="" width={size} height={size} />
    ) : (
        <span className="avatar avatar-fallback" aria-hidden="true">
            {author.login.slice(0, 1).toUpperCase()}
        </span>
    );
}
