import assert from "node:assert/strict"
import { test } from "node:test"
import { addWorkingDays, fridayOf, isIsoDate, todayIn } from "../src/dates.js"
import { applyNeededBy, classify, dueDateFor, mentionsHealth, OWNER_BY_TYPE } from "../src/rules.js"

// 2026-10-12 is a Monday
test("P1 is due the day it arrived", () => {
	assert.equal(dueDateFor("P1 today", "2026-10-14").due, "2026-10-14")
})

test("P2 is due the Friday of the week, weekends roll to next Friday", () => {
	assert.equal(dueDateFor("P2 this week", "2026-10-12").due, "2026-10-16")
	assert.equal(dueDateFor("P2 this week", "2026-10-16").due, "2026-10-16")
	assert.equal(dueDateFor("P2 this week", "2026-10-17").due, "2026-10-23")
	assert.equal(dueDateFor("P2 this week", "2026-10-18").due, "2026-10-23")
})

test("P3 is due 20 working days later", () => {
	assert.equal(dueDateFor("P3 later", "2026-10-12").due, "2026-11-09")
	assert.equal(dueDateFor("P3 later", "2026-10-17").due, "2026-11-13")
	assert.equal(addWorkingDays("2026-12-31", 1), "2027-01-01")
})

test("fridayOf handles month boundaries", () => {
	assert.equal(fridayOf("2026-10-31"), "2026-11-06")
})

test("an earlier needed-by date wins, a later one is ignored", () => {
	assert.deepEqual(applyNeededBy("2026-10-16", "2026-10-14"), { due: "2026-10-14", broughtForward: true })
	assert.deepEqual(applyNeededBy("2026-10-16", "2026-10-20"), { due: "2026-10-16", broughtForward: false })
	assert.deepEqual(applyNeededBy("2026-10-16", null), { due: "2026-10-16", broughtForward: false })
})

test("routing table matches the triage skill", () => {
	assert.equal(OWNER_BY_TYPE["Client request"], "Mercato")
	assert.equal(OWNER_BY_TYPE.Bug, "Piattaforma")
	assert.equal(OWNER_BY_TYPE["Access request"], "Piattaforma")
	assert.equal(OWNER_BY_TYPE["Feature idea"], "Marca & Prodotto")
	assert.equal(OWNER_BY_TYPE.Purchase, "Operazioni")
	assert.equal(OWNER_BY_TYPE["Data request"], "Operazioni")
})

test("classification", () => {
	assert.equal(classify("Need access to Canva").classification, "Internal")
	assert.equal(classify("Refund for Il Collettivo payment").classification, "Confidential")
	assert.equal(classify("Rinnovo contratto fornitore").classification, "Confidential")
	assert.equal(classify("Send to martina@example.com").classification, "Confidential")
	assert.equal(classify("Call +39 333 123 4567").classification, "Confidential")
	assert.equal(classify("Buy 10 kg kettlebells").classification, "Internal")
})

test("health details are detected in Italian and English", () => {
	assert.ok(mentionsHealth("Cliente con infortunio al ginocchio"))
	assert.ok(mentionsHealth("knee injury"))
	assert.ok(!mentionsHealth("Buy new resistance bands"))
	assert.ok(!mentionsHealth("Order 2 x 8 kg dumbbells"))
})

test("date helpers", () => {
	assert.ok(isIsoDate("2026-02-28"))
	assert.ok(!isIsoDate("2026-02-30"))
	assert.equal(todayIn("Europe/Rome", new Date("2026-10-11T22:30:00Z")), "2026-10-12")
})
