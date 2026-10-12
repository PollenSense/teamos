<script lang="ts">
import { api } from '../lib/api.js';
import { identity } from '../lib/identity.svelte.js';
import { router } from '../lib/router.svelte.js';

/**
 * A link to a message (#/message/<id>) does not say whose mailbox to open: that depends on who is
 * looking. Open it in the viewer's mailbox if they were on the message, otherwise in the mailbox of
 * the first person who was, and replace this address so Back does not land here again.
 */
const { id }: { id: string } = $props();
let failed = $state(false);

$effect(() => {
	const wanted = id;
	if (!identity.resolved) return;
	failed = false;
	api
		.message(wanted)
		.then((m) => {
			const people = [...(m.to ?? []), ...(m.cc ?? []), m.from].filter(Boolean);
			const me = identity.name;
			const owner = me && people.includes(me) ? me : people[0];
			if (!owner) throw new Error('no participants');
			router.replace(`/member/${encodeURIComponent(owner)}?msg=${encodeURIComponent(wanted)}`);
		})
		.catch(() => (failed = true));
});
</script>

<div class="redirect">
	{#if failed}
		That message is no longer in the store. <a href="#/">Back to the dashboard</a>
	{:else}
		Opening the message...
	{/if}
</div>

<style>
	.redirect { padding: 2rem 0; color: var(--text-muted); font-size: 0.9rem; }
</style>
