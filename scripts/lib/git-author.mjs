/**
 * Git author for a member's commits, so history says which member made each one.  The
 * committer stays whoever runs the runner.  TEAMOS_GIT_AUTHOR_EMAIL may give a per-member
 * address with `{member}` (lowercased name) in it; otherwise the runner's own email is kept,
 * so hosts that match commits to accounts by email still credit the human who runs the team.
 */
export function gitAuthorEnv(memberName, env = process.env) {
	if (!memberName) return {};
	const out = { GIT_AUTHOR_NAME: `${memberName} (teamos)` };
	const template = env.TEAMOS_GIT_AUTHOR_EMAIL;
	if (template) out.GIT_AUTHOR_EMAIL = template.replaceAll('{member}', memberName.toLowerCase());
	return out;
}

/**
 * Whether a commit's author is the member: the bare name or email, or the author
 * `gitAuthorEnv` gives the member's own cycles.  The runner's own email, which every member's
 * commits share when no per-member address is configured, never counts.
 */
export function isMemberAuthor(memberName, author, email, env = process.env) {
	if (!memberName) return false;
	if (author === memberName || email === memberName) return true;
	const own = gitAuthorEnv(memberName, env);
	return author === own.GIT_AUTHOR_NAME || (own.GIT_AUTHOR_EMAIL !== undefined && email === own.GIT_AUTHOR_EMAIL);
}
