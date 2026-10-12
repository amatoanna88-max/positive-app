// Stripe side of the suamotu-stripe sync: read subscriptions and turn each one
// into a plain row for Notion. No SDK imports, so it can be tested on its own.
//
// What is copied into Notion is deliberately small: who, which plan, the price,
// the status and the next date. No card, bank, address or invoice details:
// payment details stay in Stripe (workspace rule, data class Prohibited).

export const STRIPE_API = "https://api.stripe.com/v1"
export const TIME_ZONE = "Europe/Rome"
export const PAGE_SIZE = 100

/** Stripe subscription statuses, in the order they are shown in Notion. */
export const STATUS_LABELS = {
	active: "Active",
	trialing: "Trialing",
	past_due: "Past due",
	unpaid: "Unpaid",
	paused: "Paused",
	incomplete: "Incomplete",
	canceled: "Canceled",
	incomplete_expired: "Incomplete expired",
} as const

export type StripeStatus = keyof typeof STATUS_LABELS

/** What happens next to the subscription, always paired with a date. */
export const NEXT_LABELS = ["Renews", "Trial ends", "Payment due", "Paused", "Ends", "Ended"] as const
export type NextLabel = (typeof NEXT_LABELS)[number]

// Only the fields this worker reads. Stripe returns many more.
export type StripePrice = {
	id: string
	unit_amount: number | null
	currency: string
	nickname?: string | null
	product: string | { id: string; name?: string }
	recurring?: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null
}

export type StripeItem = {
	id: string
	quantity?: number | null
	price: StripePrice
	current_period_end?: number | null // API versions from 2025-03-31 put the period here
}

export type StripeCustomer = { id: string; deleted?: boolean; name?: string | null; email?: string | null }

export type StripeSubscription = {
	id: string
	status: StripeStatus
	livemode: boolean
	customer: string | StripeCustomer
	start_date: number
	created: number
	current_period_end?: number | null // older API versions put the period here
	cancel_at_period_end: boolean
	cancel_at?: number | null
	canceled_at?: number | null
	ended_at?: number | null
	trial_end?: number | null
	pause_collection?: { behavior: string; resumes_at?: number | null } | null
	items: { data: StripeItem[] }
}

export type StripeList<T> = { object: "list"; data: T[]; has_more: boolean }

export type SubscriptionRow = {
	id: string
	title: string
	customer: string
	email: string | null
	plan: string
	status: string
	next: NextLabel
	nextDate: string
	amount: number | null
	currency: string
	billing: string
	cancelsAtPeriodEnd: boolean
	startedOn: string
	stripeUrl: string
	mode: "Live" | "Test"
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
	ok: boolean
	status: number
	json(): Promise<any>
}>

// Currencies Stripe counts in whole units (no cents).
const ZERO_DECIMAL = new Set([
	"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
])

/** A Unix timestamp (seconds) as a calendar date in Sua Motu's time zone. */
export function dateFromUnix(seconds: number, timeZone: string = TIME_ZONE): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(seconds * 1000),
	)
}

/** End of the current billing period, wherever this API version puts it. */
export function periodEnd(sub: StripeSubscription): number | null {
	const fromItems = sub.items.data.map((i) => i.current_period_end).filter((v): v is number => typeof v === "number")
	if (fromItems.length) return Math.max(...fromItems)
	return sub.current_period_end ?? null
}

export function billingLabel(recurring: StripePrice["recurring"]): string {
	if (!recurring) return "One-off"
	const { interval, interval_count: n } = recurring
	if (n === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[interval]
	return `Every ${n} ${interval}s`
}

export function productId(price: StripePrice): string {
	return typeof price.product === "string" ? price.product : price.product.id
}

/** Next event and its date. Every subscription gets both, so no field is left stale. */
export function nextEvent(sub: StripeSubscription): { next: NextLabel; at: number } {
	const end = periodEnd(sub) ?? sub.start_date
	if (sub.status === "canceled" || sub.status === "incomplete_expired") {
		return { next: "Ended", at: sub.ended_at ?? sub.canceled_at ?? end }
	}
	if (sub.cancel_at) return { next: "Ends", at: sub.cancel_at }
	if (sub.cancel_at_period_end) return { next: "Ends", at: end }
	if (sub.status === "paused" || sub.pause_collection) {
		return { next: "Paused", at: sub.pause_collection?.resumes_at ?? end }
	}
	if (sub.status === "trialing") return { next: "Trial ends", at: sub.trial_end ?? end }
	if (sub.status === "past_due" || sub.status === "unpaid" || sub.status === "incomplete") {
		return { next: "Payment due", at: end }
	}
	return { next: "Renews", at: end }
}

/** Abandoned checkouts: never became a subscription, not worth a row. */
export function shouldSync(sub: StripeSubscription): boolean {
	return sub.status !== "incomplete_expired"
}

export function toRow(sub: StripeSubscription, productNames: Record<string, string> = {}): SubscriptionRow {
	const customer = typeof sub.customer === "string" ? { id: sub.customer } : sub.customer
	const name = customer.deleted ? "" : ((customer as StripeCustomer).name ?? "").trim()
	const email = customer.deleted ? null : ((customer as StripeCustomer).email ?? null)

	const items = sub.items.data
	const plans = [
		...new Set(
			items.map((i) => {
				const p = i.price
				const fromProduct = typeof p.product === "object" ? p.product.name : undefined
				return productNames[productId(p)] ?? fromProduct ?? p.nickname ?? p.id
			}),
		),
	]
	const plan = plans.join(" + ")

	// One price only when every item bills in the same currency and interval.
	const first = items[0]?.price
	const sameTerms = items.every(
		(i) =>
			i.price.currency === first?.currency &&
			billingLabel(i.price.recurring) === billingLabel(first?.recurring) &&
			i.price.unit_amount !== null,
	)
	let amount: number | null = null
	if (first && sameTerms) {
		const minor = items.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0)
		amount = ZERO_DECIMAL.has(first.currency.toLowerCase()) ? minor : minor / 100
	}

	const { next, at } = nextEvent(sub)
	const who = name || email || customer.id

	return {
		id: sub.id,
		title: `${who} · ${plan || "Subscription"}`,
		customer: name,
		email,
		plan,
		status: STATUS_LABELS[sub.status] ?? sub.status,
		next,
		nextDate: dateFromUnix(at),
		amount,
		currency: (first?.currency ?? "").toUpperCase(),
		billing: first && sameTerms ? billingLabel(first.recurring) : "Mixed",
		cancelsAtPeriodEnd: sub.cancel_at_period_end || Boolean(sub.cancel_at),
		startedOn: dateFromUnix(sub.start_date ?? sub.created),
		stripeUrl: `https://dashboard.stripe.com/${sub.livemode ? "" : "test/"}subscriptions/${sub.id}`,
		mode: sub.livemode ? "Live" : "Test",
	}
}

async function stripeGet<T>(path: string, params: URLSearchParams, apiKey: string | undefined, fetchImpl: Fetch): Promise<T> {
	if (!apiKey) {
		throw new Error(
			"STRIPE_API_KEY is not set. Create a restricted Stripe key with read access to Subscriptions, Customers and Products, then run: ntn workers env set STRIPE_API_KEY=<paste key>",
		)
	}
	const response = await fetchImpl(`${STRIPE_API}${path}?${params}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	const body = await response.json()
	if (!response.ok) {
		const message = body?.error?.message ?? "no message"
		throw new Error(`Stripe ${path} failed with HTTP ${response.status}: ${message}`)
	}
	return body as T
}

/** One page of subscriptions, every status, with the customer included. */
export function listSubscriptionsPage(
	apiKey: string | undefined,
	startingAfter: string | null,
	fetchImpl: Fetch = fetch as unknown as Fetch,
): Promise<StripeList<StripeSubscription>> {
	const params = new URLSearchParams({ status: "all", limit: String(PAGE_SIZE) })
	params.append("expand[]", "data.customer")
	if (startingAfter) params.set("starting_after", startingAfter)
	return stripeGet("/subscriptions", params, apiKey, fetchImpl)
}

/**
 * Product id → name for the whole catalogue. Stripe cannot expand the product
 * inside a subscription list (too deep), so names are read once per cycle.
 */
export async function loadProductNames(
	apiKey: string | undefined,
	fetchImpl: Fetch = fetch as unknown as Fetch,
	beforeEachRequest: () => Promise<void> = async () => {},
): Promise<Record<string, string>> {
	const names: Record<string, string> = {}
	let startingAfter: string | null = null
	for (let page = 0; page < 20; page++) {
		const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
		if (startingAfter) params.set("starting_after", startingAfter)
		await beforeEachRequest()
		const list: StripeList<{ id: string; name: string }> = await stripeGet("/products", params, apiKey, fetchImpl)
		for (const p of list.data) names[p.id] = p.name
		if (!list.has_more || list.data.length === 0) break
		startingAfter = list.data[list.data.length - 1].id
	}
	return names
}
