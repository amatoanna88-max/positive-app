import assert from "node:assert/strict"
import { test } from "node:test"
import {
	dateFromUnix,
	listSubscriptionsPage,
	loadProductNames,
	nextEvent,
	shouldSync,
	toRow,
	type Fetch,
	type StripeSubscription,
} from "../src/stripe.ts"

// 2026-11-12 00:30 in Rome is still 2026-11-11 23:30 UTC: the date must follow Rome.
const NOV_12_ROME_0030 = Date.UTC(2026, 10, 11, 23, 30) / 1000
const OCT_12 = Date.UTC(2026, 9, 12, 9, 0) / 1000
const NOV_12 = Date.UTC(2026, 10, 12, 9, 0) / 1000

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
	return {
		id: "sub_123",
		status: "active",
		livemode: true,
		customer: { id: "cus_1", name: "Marilena Scarabelli", email: "marilena@example.com" },
		start_date: OCT_12,
		created: OCT_12,
		cancel_at_period_end: false,
		items: {
			data: [
				{
					id: "si_1",
					quantity: 1,
					current_period_end: NOV_12,
					price: {
						id: "price_privato",
						unit_amount: 22000,
						currency: "eur",
						product: "prod_privato",
						recurring: { interval: "month", interval_count: 1 },
					},
				},
			],
		},
		...overrides,
	}
}

const PRODUCTS = { prod_privato: "Motu Privato", prod_base: "Motu Base" }

test("an active monthly subscription renews at the end of the period", () => {
	const row = toRow(sub(), PRODUCTS)
	assert.equal(row.title, "Marilena Scarabelli · Motu Privato")
	assert.equal(row.status, "Active")
	assert.equal(row.next, "Renews")
	assert.equal(row.nextDate, "2026-11-12")
	assert.equal(row.amount, 220)
	assert.equal(row.currency, "EUR")
	assert.equal(row.billing, "Monthly")
	assert.equal(row.email, "marilena@example.com")
	assert.equal(row.startedOn, "2026-10-12")
	assert.equal(row.stripeUrl, "https://dashboard.stripe.com/subscriptions/sub_123")
	assert.equal(row.mode, "Live")
	assert.equal(row.cancelsAtPeriodEnd, false)
})

test("dates follow Rome, not UTC", () => {
	assert.equal(dateFromUnix(NOV_12_ROME_0030), "2026-11-12")
})

test("older API versions keep the period end on the subscription", () => {
	const s = sub()
	delete s.items.data[0].current_period_end
	s.current_period_end = NOV_12
	assert.equal(toRow(s, PRODUCTS).nextDate, "2026-11-12")
})

test("cancel at period end: Ends on the period end, flag set", () => {
	const row = toRow(sub({ cancel_at_period_end: true }), PRODUCTS)
	assert.equal(row.next, "Ends")
	assert.equal(row.nextDate, "2026-11-12")
	assert.equal(row.cancelsAtPeriodEnd, true)
})

test("a scheduled cancel date wins over the period end", () => {
	const cancelAt = Date.UTC(2026, 9, 31, 12) / 1000
	const row = toRow(sub({ cancel_at: cancelAt }), PRODUCTS)
	assert.equal(row.next, "Ends")
	assert.equal(row.nextDate, "2026-10-31")
	assert.equal(row.cancelsAtPeriodEnd, true)
})

test("a canceled subscription shows when it ended", () => {
	const ended = Date.UTC(2026, 9, 20, 12) / 1000
	const row = toRow(sub({ status: "canceled", ended_at: ended }), PRODUCTS)
	assert.equal(row.status, "Canceled")
	assert.equal(row.next, "Ended")
	assert.equal(row.nextDate, "2026-10-20")
})

test("a failed renewal is a payment due, dated at the period end", () => {
	const e = nextEvent(sub({ status: "past_due" }))
	assert.equal(e.next, "Payment due")
	assert.equal(dateFromUnix(e.at), "2026-11-12")
})

test("trials show the trial end; paused collection shows when it resumes", () => {
	const trialEnd = Date.UTC(2026, 9, 26, 12) / 1000
	assert.equal(toRow(sub({ status: "trialing", trial_end: trialEnd })).nextDate, "2026-10-26")
	const resumes = Date.UTC(2026, 10, 2, 12) / 1000
	const paused = toRow(sub({ pause_collection: { behavior: "void", resumes_at: resumes } }))
	assert.equal(paused.next, "Paused")
	assert.equal(paused.nextDate, "2026-11-02")
})

test("every subscription gets a next date, even with no period on record", () => {
	const s = sub()
	delete s.items.data[0].current_period_end
	assert.equal(toRow(s).nextDate, "2026-10-12")
})

test("abandoned checkouts are not synced", () => {
	assert.equal(shouldSync(sub({ status: "incomplete_expired" })), false)
	assert.equal(shouldSync(sub({ status: "incomplete" })), true)
})

test("a deleted customer falls back to the customer id and no email", () => {
	const row = toRow(sub({ customer: { id: "cus_gone", deleted: true } }), PRODUCTS)
	assert.equal(row.title, "cus_gone · Motu Privato")
	assert.equal(row.email, null)
	assert.equal(row.customer, "")
})

test("a customer id string (not expanded) still produces a row", () => {
	assert.equal(toRow(sub({ customer: "cus_9" }), PRODUCTS).title, "cus_9 · Motu Privato")
})

test("no name: the email is used in the title", () => {
	const row = toRow(sub({ customer: { id: "cus_1", name: null, email: "anna@example.com" } }), PRODUCTS)
	assert.equal(row.title, "anna@example.com · Motu Privato")
})

test("two items on the same terms add up, quantity included", () => {
	const s = sub()
	s.items.data.push({
		id: "si_2",
		quantity: 2,
		current_period_end: NOV_12,
		price: {
			id: "price_extra",
			unit_amount: 1500,
			currency: "eur",
			product: "prod_base",
			recurring: { interval: "month", interval_count: 1 },
		},
	})
	const row = toRow(s, PRODUCTS)
	assert.equal(row.amount, 250)
	assert.equal(row.plan, "Motu Privato + Motu Base")
	assert.equal(row.billing, "Monthly")
})

test("items on different intervals give no single price", () => {
	const s = sub()
	s.items.data.push({
		id: "si_2",
		quantity: 1,
		price: {
			id: "price_year",
			unit_amount: 10000,
			currency: "eur",
			product: "prod_base",
			recurring: { interval: "year", interval_count: 1 },
		},
	})
	const row = toRow(s, PRODUCTS)
	assert.equal(row.amount, null)
	assert.equal(row.billing, "Mixed")
})

test("tiered prices (no unit amount) give no single price", () => {
	const s = sub()
	s.items.data[0].price.unit_amount = null
	assert.equal(toRow(s, PRODUCTS).amount, null)
})

test("zero-decimal currencies are not divided by 100", () => {
	const s = sub()
	s.items.data[0].price.currency = "jpy"
	s.items.data[0].price.unit_amount = 5000
	assert.equal(toRow(s, PRODUCTS).amount, 5000)
})

test("billing labels for other intervals", () => {
	const s = sub()
	s.items.data[0].price.recurring = { interval: "month", interval_count: 3 }
	assert.equal(toRow(s, PRODUCTS).billing, "Every 3 months")
	s.items.data[0].price.recurring = { interval: "year", interval_count: 1 }
	assert.equal(toRow(s, PRODUCTS).billing, "Yearly")
})

test("plan name falls back to the price nickname, then the price id", () => {
	const s = sub()
	s.items.data[0].price.nickname = "Privato mensile"
	assert.equal(toRow(s, {}).plan, "Privato mensile")
	s.items.data[0].price.nickname = null
	assert.equal(toRow(s, {}).plan, "price_privato")
})

test("test-mode subscriptions link to the test dashboard", () => {
	const row = toRow(sub({ livemode: false }), PRODUCTS)
	assert.equal(row.stripeUrl, "https://dashboard.stripe.com/test/subscriptions/sub_123")
	assert.equal(row.mode, "Test")
})

// --- Stripe requests -------------------------------------------------------

function fakeFetch(pages: any[]) {
	const calls: { url: string; auth?: string }[] = []
	const impl: Fetch = async (url, init) => {
		calls.push({ url, auth: init?.headers?.Authorization })
		const body = pages.shift()
		return { ok: !body?.error, status: body?.error ? 401 : 200, json: async () => body }
	}
	return { impl, calls }
}

test("the subscription request asks for every status, 100 at a time, with the customer", async () => {
	const { impl, calls } = fakeFetch([{ object: "list", data: [], has_more: false }])
	await listSubscriptionsPage("rk_test_x", null, impl)
	const url = new URL(calls[0].url)
	assert.equal(url.origin + url.pathname, "https://api.stripe.com/v1/subscriptions")
	assert.equal(url.searchParams.get("status"), "all")
	assert.equal(url.searchParams.get("limit"), "100")
	assert.deepEqual(url.searchParams.getAll("expand[]"), ["data.customer"])
	assert.equal(url.searchParams.get("starting_after"), null)
	assert.equal(calls[0].auth, "Bearer rk_test_x")
})

test("the next page starts after the last subscription seen", async () => {
	const { impl, calls } = fakeFetch([{ object: "list", data: [], has_more: false }])
	await listSubscriptionsPage("rk_test_x", "sub_100", impl)
	assert.equal(new URL(calls[0].url).searchParams.get("starting_after"), "sub_100")
})

test("a missing key stops with instructions, before any request", async () => {
	const { impl, calls } = fakeFetch([])
	await assert.rejects(() => listSubscriptionsPage(undefined, null, impl), /STRIPE_API_KEY is not set/)
	assert.equal(calls.length, 0)
})

test("a Stripe error is reported with its message and status", async () => {
	const { impl } = fakeFetch([{ error: { message: "Invalid API Key provided" } }])
	await assert.rejects(() => listSubscriptionsPage("rk_bad", null, impl), /HTTP 401: Invalid API Key provided/)
})

test("product names are read across pages, pacing every request", async () => {
	const { impl, calls } = fakeFetch([
		{ object: "list", data: [{ id: "prod_a", name: "A" }], has_more: true },
		{ object: "list", data: [{ id: "prod_b", name: "B" }], has_more: false },
	])
	let waits = 0
	const names = await loadProductNames("rk_test_x", impl, async () => {
		waits++
	})
	assert.deepEqual(names, { prod_a: "A", prod_b: "B" })
	assert.equal(calls.length, 2)
	assert.equal(waits, 2)
	assert.equal(new URL(calls[1].url).searchParams.get("starting_after"), "prod_a")
})
