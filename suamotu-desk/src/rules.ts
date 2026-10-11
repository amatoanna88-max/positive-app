// The Service desk rules, taken from the skill "Triage a Service desk request"
// in Company OS › Skills and workers. If the skill changes, change this file.

import { addWorkingDays, fridayOf, minDate } from "./dates.js"

export const REQUEST_TYPES = [
	"Client request",
	"Bug",
	"Feature idea",
	"Access request",
	"Purchase",
	"Data request",
] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const PRIORITIES = ["P1 today", "P2 this week", "P3 later"] as const
export type Priority = (typeof PRIORITIES)[number]

export const UNITS = [
	"Fondatrice",
	"Mercato",
	"Marca & Prodotto",
	"Operazioni",
	"Piattaforma",
	"Laboratorio",
] as const
export type Unit = (typeof UNITS)[number]

export const OWNER_BY_TYPE: Record<RequestType, Unit> = {
	"Client request": "Mercato",
	Bug: "Piattaforma",
	"Access request": "Piattaforma",
	"Feature idea": "Marca & Prodotto",
	Purchase: "Operazioni",
	"Data request": "Operazioni", // it owns GDPR and consent
}

export const OPEN_STATUSES = ["New", "Triaged", "In progress"] as const

/**
 * P1 = the created date; P2 = the Friday of the created week (next Friday if
 * created on Saturday or Sunday); P3 = 20 working days after the created date.
 */
export function dueDateFor(priority: Priority, created: string): { due: string; rule: string } {
	switch (priority) {
		case "P1 today":
			return { due: created, rule: "P1: due the day it arrived" }
		case "P2 this week":
			return { due: fridayOf(created), rule: "P2: due the Friday of the week it arrived" }
		case "P3 later":
			return { due: addWorkingDays(created, 20), rule: "P3: due 20 working days after it arrived" }
	}
}

/** A needed-by date earlier than the rule's date wins. */
export function applyNeededBy(due: string, neededBy: string | null): { due: string; broughtForward: boolean } {
	if (!neededBy || neededBy >= due) return { due, broughtForward: false }
	return { due: minDate(due, neededBy), broughtForward: true }
}

// Health details must never be stored in Notion (workspace rule 5).
const HEALTH_TERMS =
	/\b(health|salute|injur\w*|infortun\w*|dolor\w*|pain|medic\w*|diagnos\w*|patolog\w*|pregnan\w*|gravidanz\w*|incint\w*|terap\w*|therap\w*|farmac\w*|symptom\w*|sintom\w*|body weight|weight loss|peso corporeo|dimagr\w*)\b/i

// Payments, contracts and personal data beyond a first name make a request Confidential.
const CONFIDENTIAL_TERMS =
	/\b(pay\w*|pagament\w*|paga\w*|refund\w*|rimbors\w*|card|carta|iban|invoice\w*|fattur\w*|contract\w*|contratt\w*|address|indirizzo|phone|telefono|cellulare|birth\w*|nascita|codice fiscale|password)\b/i
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE = /\+?\d[\d\s-]{7,}\d/

export function mentionsHealth(text: string): boolean {
	return HEALTH_TERMS.test(text)
}

export function classify(text: string): { classification: "Internal" | "Confidential"; reason: string } {
	if (HEALTH_TERMS.test(text)) return { classification: "Confidential", reason: "mentions health" }
	if (CONFIDENTIAL_TERMS.test(text)) return { classification: "Confidential", reason: "mentions payments, contracts or personal data" }
	if (EMAIL.test(text) || PHONE.test(text)) return { classification: "Confidential", reason: "contains contact details" }
	return { classification: "Internal", reason: "no sensitive terms found" }
}

export function isUnit(value: string): value is Unit {
	return (UNITS as readonly string[]).includes(value)
}
