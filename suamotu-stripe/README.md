# suamotu-stripe

Notion worker that copies **Stripe subscriptions** into a Notion database every
hour. Renewals, failed payments, pauses and cancellations become visible next to
Clienti, without opening Stripe or reading Stripe emails.

**Archetype: sync** (one way, Stripe → Notion). Stripe stays the system of record.
The Notion database is managed by the worker: its synced columns are read-only and
rebuilt from Stripe on every cycle.

## What lands in Notion

Database **Stripe subscriptions**, one row per subscription (every status, except
checkouts that never completed):

| Column | From Stripe |
|---|---|
| Subscription | Client name (or email) · plan |
| Status | Active, Trialing, Past due, Unpaid, Paused, Incomplete, Canceled |
| Next · Next date | Renews, Trial ends, Payment due, Paused, Ends or Ended, always with a date |
| Plan | Product name(s) |
| Price per period · Billing · Currency | e.g. 220 · Monthly · EUR |
| Client email · Client name | From the Stripe customer, to match with Clienti |
| Cancels at period end | Ticked when a cancellation is scheduled |
| Started | Subscription start date |
| Open in Stripe | Link to the subscription in the Stripe dashboard |
| Mode | Live or Test |
| Subscription ID | Stripe id (the key the sync matches on) |

**Never copied:** card, bank, billing address, invoices or payment methods. Payment
details stay in Stripe (workspace rule; data class *Prohibited*). The rows hold client
names and emails, so the database is **Confidential**: keep it in the Customer Care
teamspace.

Dates are calendar dates in Europe/Rome, like the other SuaMotu workers.

## How it syncs

- `stripeSubscriptionsSync`, replace mode, every hour (`1h`).
- Each cycle reads the product names once, then every subscription 100 at a time
  (`status=all`, customer included). Anything no longer in Stripe is removed from Notion.
- Fewer than a thousand subscriptions, so one replace sync is enough; no backfill +
  delta pair.
- Rate limit: 10 Stripe requests per second (Stripe allows 100 live, 25 in test mode).

## Set it up (once)

1. **Create a restricted Stripe key.** In Stripe: Developers → API keys → *Create
   restricted key*. Give it **Read** on Subscriptions, Customers and Products, and
   nothing else. Start in **test mode** (`rk_test_…`), then repeat in live mode.
2. **Deploy the worker**, from this folder:
   ```sh
   npm install
   npm run check
   npm test
   ntn workers deploy
   ```
3. **Give it the key.** Type this yourself; never paste a key into a chat:
   ```sh
   ntn workers env set STRIPE_API_KEY=<paste the restricted key>
   ```
4. **Run the first sync** instead of waiting an hour:
   ```sh
   ntn workers sync trigger stripeSubscriptionsSync
   ```
5. **Move the database** *Stripe subscriptions* into **Customer Care** (it is
   Confidential), and add it to the Tools register as In use.

## Day to day

```sh
ntn workers sync trigger stripeSubscriptionsSync   # sync now
ntn workers env set STRIPE_API_KEY=<new key>       # rotate the key
```

To rotate the key: create a new restricted key in Stripe, set it with the command
above, then delete the old key in Stripe.

## Develop

```sh
npm test    # 25 tests on the Stripe → row mapping and the requests (no network)
npm run check
```

The Stripe logic is in `src/stripe.ts` and has no SDK imports; `src/index.ts`
declares the database, the pacer and the sync.
