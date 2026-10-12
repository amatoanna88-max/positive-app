// suamotu-stripe: copies Stripe subscriptions into a Notion database every hour,
// so renewals, failed payments and cancellations are visible next to Clienti
// without anyone opening Stripe or reading Stripe emails.
//
// Archetype: sync (Stripe → Notion, one way). Stripe stays the system of record;
// the Notion database is read-only and rebuilt from Stripe on every cycle.

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import {
	listSubscriptionsPage,
	loadProductNames,
	NEXT_LABELS,
	shouldSync,
	STATUS_LABELS,
	toRow,
	type SubscriptionRow,
} from "./stripe.js"

const worker = new Worker()
export default worker

const NEXT_COLORS = {
	Renews: "green",
	"Trial ends": "blue",
	"Payment due": "red",
	Paused: "gray",
	Ends: "orange",
	Ended: "brown",
} as const satisfies Record<(typeof NEXT_LABELS)[number], string>

const subscriptions = worker.database("subscriptions", {
	type: "managed",
	initialTitle: "Stripe subscriptions",
	primaryKeyProperty: "Subscription ID",
	schema: {
		properties: {
			Subscription: Schema.title(),
			Status: Schema.select([
				{ name: STATUS_LABELS.active, color: "green" },
				{ name: STATUS_LABELS.trialing, color: "blue" },
				{ name: STATUS_LABELS.past_due, color: "orange" },
				{ name: STATUS_LABELS.unpaid, color: "red" },
				{ name: STATUS_LABELS.paused, color: "gray" },
				{ name: STATUS_LABELS.incomplete, color: "yellow" },
				{ name: STATUS_LABELS.canceled },
				{ name: STATUS_LABELS.incomplete_expired },
			]),
			Next: Schema.select(NEXT_LABELS.map((name) => ({ name, color: NEXT_COLORS[name] }))),
			"Next date": Schema.date(),
			Plan: Schema.richText(),
			"Price per period": Schema.number(),
			Billing: Schema.richText(),
			Currency: Schema.richText(),
			"Client email": Schema.email(),
			"Client name": Schema.richText(),
			"Cancels at period end": Schema.checkbox(),
			Started: Schema.date(),
			"Open in Stripe": Schema.url(),
			Mode: Schema.select([
				{ name: "Live", color: "green" },
				{ name: "Test", color: "yellow" },
			]),
			"Subscription ID": Schema.richText(),
		},
	},
})

// Stripe allows 100 read requests per second in live mode and 25 in test mode.
// Ten per second leaves plenty of room for everything else using the key.
const stripeApi = worker.pacer("stripeApi", { allowedRequests: 10, intervalMs: 1000 })

type CycleState = {
	startingAfter: string | null
	products: Record<string, string>
}

function properties(row: SubscriptionRow) {
	return {
		Subscription: Builder.title(row.title),
		Status: Builder.select(row.status),
		Next: Builder.select(row.next),
		"Next date": Builder.date(row.nextDate),
		Plan: Builder.richText(row.plan),
		Billing: Builder.richText(row.billing),
		Currency: Builder.richText(row.currency),
		"Client name": Builder.richText(row.customer),
		"Cancels at period end": Builder.checkbox(row.cancelsAtPeriodEnd),
		Started: Builder.date(row.startedOn),
		"Open in Stripe": Builder.url(row.stripeUrl),
		Mode: Builder.select(row.mode),
		"Subscription ID": Builder.richText(row.id),
		// Left out rather than blank when Stripe has no value (tiered price, no email).
		...(row.amount !== null ? { "Price per period": Builder.number(row.amount) } : {}),
		...(row.email ? { "Client email": Builder.email(row.email) } : {}),
	}
}

// Replace mode: each cycle reads every subscription (all statuses, including
// canceled), so anything no longer in Stripe is removed from Notion.
// Fewer than a thousand subscriptions, so no backfill + delta pair is needed.
worker.sync("stripeSubscriptionsSync", {
	database: subscriptions,
	mode: "replace",
	schedule: "1h",
	execute: async (state: CycleState | undefined) => {
		const apiKey = process.env.STRIPE_API_KEY

		// First call of a cycle: read product names once and carry them forward.
		const products =
			state?.products ?? (await loadProductNames(apiKey, undefined, () => stripeApi.wait()))

		await stripeApi.wait()
		const page = await listSubscriptionsPage(apiKey, state?.startingAfter ?? null)

		const changes = page.data.filter(shouldSync).map((sub) => {
			const row = toRow(sub, products)
			return { type: "upsert" as const, key: row.id, properties: properties(row) }
		})

		const last = page.data[page.data.length - 1]
		const hasMore = page.has_more && Boolean(last)

		return {
			changes,
			hasMore,
			nextState: hasMore ? { startingAfter: last.id, products } : undefined,
		}
	},
})
