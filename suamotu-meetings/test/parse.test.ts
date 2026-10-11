import assert from "node:assert/strict"
import { test } from "node:test"
import { inferRequestType, parseActionLine, parseActions, parseDate, resolveOwner } from "../src/parse.js"

const MEETING = "2026-10-12" // a Monday

test("a full Task line", () => {
	const a = parseActionLine("Task · Engineering: finish the check-in form · 20/10 · epic: Check-in", MEETING)!
	assert.equal(a.kind, "task")
	assert.equal(a.unit, "Piattaforma")
	assert.equal(a.team, "Engineering")
	assert.equal(a.text, "finish the check-in form")
	assert.equal(a.due, "2026-10-20")
	assert.equal(a.epic, "Check-in")
	assert.deepEqual(a.warnings, [])
})

test("a full Desk line with priority", () => {
	const a = parseActionLine("- Desk · Operazioni: buy a Canva Pro licence · 17/10 · P2", MEETING)!
	assert.equal(a.kind, "desk")
	assert.equal(a.unit, "Operazioni")
	assert.equal(a.text, "buy a Canva Pro licence")
	assert.equal(a.due, "2026-10-17")
	assert.equal(a.priority, "P2 this week")
})

test("a unit with one squad maps to that Team; several squads are flagged", () => {
	const one = parseActionLine("Task · Operazioni: update the privacy notice", MEETING)!
	assert.equal(one.team, "Privacy and legal")
	const many = parseActionLine("Task · Piattaforma: fix the login page", MEETING)!
	assert.equal(many.team, null)
	assert.ok(many.warnings.some((w) => w.includes("several squads")))
})

test("lines without prefix or owner are kept and flagged", () => {
	const a = parseActionLine("call the accountant about Q4", MEETING)!
	assert.equal(a.kind, "task")
	assert.equal(a.text, "call the accountant about Q4")
	assert.ok(a.warnings.some((w) => w.includes("No Task/Desk prefix")))
	assert.ok(a.warnings.some((w) => w.includes("No owner")))
})

test("Italian prefixes and 'Marca e Prodotto'", () => {
	const a = parseActionLine("Attività: Marca e Prodotto: nuova copertina Motu Base · 30/10/2026", MEETING)!
	assert.equal(a.kind, "task")
	assert.equal(a.unit, "Marca & Prodotto")
	assert.equal(a.due, "2026-10-30")
	const b = parseActionLine("Richiesta · Piattaforma: accesso a Stripe per Sofia", MEETING)!
	assert.equal(b.kind, "desk")
	assert.equal(b.unit, "Piattaforma")
})

test("unknown owner is flagged and the text kept whole", () => {
	const a = parseActionLine("Desk · Marketing: new banner", MEETING)!
	assert.equal(a.unit, null)
	assert.equal(a.text, "Marketing: new banner")
})

test("dates", () => {
	assert.equal(parseDate("20/10", MEETING), "2026-10-20")
	assert.equal(parseDate("entro 3/11", MEETING), "2026-11-03")
	assert.equal(parseDate("15/01", MEETING), "2027-01-15") // before the meeting → next year
	assert.equal(parseDate("2026-12-01", MEETING), "2026-12-01")
	assert.equal(parseDate("31/02", MEETING), null)
	assert.equal(parseDate("soon", MEETING), null)
})

test("owners and request types", () => {
	assert.deepEqual(resolveOwner("client care"), { unit: "Mercato", team: "Client care" })
	assert.equal(resolveOwner("Sales"), null)
	assert.equal(inferRequestType("buy a Canva Pro licence"), "Purchase")
	assert.equal(inferRequestType("accesso a Stripe per Sofia"), "Access request")
	assert.equal(inferRequestType("export consent data"), "Data request")
	assert.equal(inferRequestType("think about it"), null)
})

test("blank lines and bullets are skipped", () => {
	const all = parseActions("\n- Task · Quality: test the booking flow\n\n• Desk · Mercato: reply to the client request\n", MEETING)
	assert.equal(all.length, 2)
	assert.equal(all[0].team, "Quality")
	assert.equal(all[1].kind, "desk")
})
