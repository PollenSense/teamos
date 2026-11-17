/**
 * Links into the compose page, and reading them back.
 *
 * `#/compose?to=ivy` opens a new message with Ivy already in the To line; several names are separated by commas. It
 * is for the Compose buttons (the home screen and a member's page). A reply is a different link (`?re=`, see
 * Mailbox.svelte) and ignores `to`. Pure, so it can be tested without a browser.
 */

/** The compose link: with no name an empty message, otherwise the names in the To line. */
export function composeHref(to?: string | readonly string[]): string {
	const names = (typeof to === 'string' ? [to] : [...(to ?? [])]).map((n) => n.trim()).filter(Boolean);
	return names.length === 0 ? '#/compose' : `#/compose?to=${names.map((n) => encodeURIComponent(n)).join(',')}`;
}

/**
 * The To line a compose link asks for: the names in `query.to` that are active members, once each, in the order
 * given. A name matches a member exactly first; failing that, in any letter case, but only when exactly one member
 * matches (the same rule as the server's roster check, so `cy` and `Cy` as two members are never mixed up). A name
 * that matches no member (a mistyped link), or more than one, is dropped rather than sent to the server, which
 * would refuse the whole message.
 */
export function prefillRecipients(query: Record<string, string | undefined>, members: readonly { name: string; active?: boolean }[]): string[] {
	const wanted = (query.to ?? '').split(',').map((n) => n.trim()).filter(Boolean);
	const active = members.filter((m) => m.active !== false).map((m) => m.name);
	const out: string[] = [];
	for (const w of wanted) {
		let name = active.find((n) => n === w);
		if (!name) {
			const lower = w.toLowerCase();
			const loose = active.filter((n) => n.toLowerCase() === lower);
			if (loose.length === 1) name = loose[0];
		}
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}
