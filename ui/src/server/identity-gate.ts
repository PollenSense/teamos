/** What the gate needs to know about a request's identity (see resolveIdentity in api-plugin.ts). */
export interface GateIdentity {
	name: string | null;
	locked: boolean;
	email?: string;
}

/** The one route an unrecognized visitor needs: the dashboard reads it to show who they signed in as. */
const OPEN_ROUTES = new Set(['/api/me']);

/**
 * Why an API request must be refused, or null to let it through. The "Unrecognized identity" screen only hides the
 * dashboard, so the API has to refuse a proxy identity that matches no member too. A request with no identity is
 * left alone: that is localhost dev, and also the host machine's own requests through Tailscale Serve.
 */
export function refusalReason(identity: GateIdentity, path: string): string | null {
	if (OPEN_ROUTES.has(path)) return null;
	if (identity.locked && !identity.name) return `Unrecognized identity: ${identity.email ?? 'no email'} matches no member`;
	return null;
}
