// Reads the free-text Actions field of a meeting, one action per line:
//
//   Task · Piattaforma: finish the check-in form · 20/10 · epic: Check-in
//   Desk · Operazioni: buy a Canva Pro licence · 17/10 · P2
//
// "Task" lines become App Tasks, "Desk" lines become Service desk requests.
// Anything the parser cannot read is kept and flagged, never silently dropped.

import { addDays, isIsoDate } from "./dates.js"
import { type Priority, type RequestType, type Unit, UNITS } from "./rules.js"

export const SQUADS_BY_UNIT: Record<Unit, string[]> = {
	Fondatrice: [],
	Mercato: ["Launch and marketing", "Client care"],
	"Marca & Prodotto": ["Product", "Design", "Coaching content"],
	Operazioni: ["Privacy and legal"],
	Piattaforma: ["Engineering", "Quality"],
	Laboratorio: [],
}

export type ActionKind = "task" | "desk"

export type ParsedAction = {
	line: string
	kind: ActionKind
	unit: Unit | null
	team: string | null
	text: string
	due: string | null
	epic: string | null
	priority: Priority | null
	warnings: string[]
}

const normalise = (s: string) =>
	s
		.toLowerCase()
		.replace(/\s+e\s+/g, " & ")
		.replace(/\s*&\s*/g, " & ")
		.replace(/\s+/g, " ")
		.trim()

/** Accepts a unit ("Piattaforma") or an app squad ("Engineering"). */
export function resolveOwner(name: string): { unit: Unit; team: string | null } | null {
	const wanted = normalise(name)
	for (const unit of UNITS) {
		if (normalise(unit) === wanted) {
			const squads = SQUADS_BY_UNIT[unit]
			return { unit, team: squads.length === 1 ? squads[0] : null }
		}
		for (const squad of SQUADS_BY_UNIT[unit]) {
			if (normalise(squad) === wanted) return { unit, team: squad }
		}
	}
	return null
}

/** dd/mm, dd/mm/yy, dd/mm/yyyy, dd.mm or yyyy-mm-dd. A date without a year that falls before the meeting is taken as next year. */
export function parseDate(token: string, meetingDate: string): string | null {
	const t = token.replace(/^(by|entro|due|scadenza|entro il)\s+/i, "").trim()
	if (isIsoDate(t)) return t
	const m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/)
	if (!m) return null
	const day = m[1].padStart(2, "0")
	const month = m[2].padStart(2, "0")
	let year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : meetingDate.slice(0, 4)
	let iso = `${year}-${month}-${day}`
	if (!isIsoDate(iso)) return null
	if (!m[3] && iso < addDays(meetingDate, -7)) {
		year = String(Number(year) + 1)
		iso = `${year}-${month}-${day}`
	}
	return isIsoDate(iso) ? iso : null
}

const TYPE_KEYWORDS: [RequestType, RegExp][] = [
	["Purchase", /\b(buy|purchase|order|acquist\w*|compra\w*|ordina\w*|licen[cz]\w*|abbonament\w*|subscription)\b/i],
	["Access request", /\b(access|accesso|permess\w*|permission\w*|invit\w*|account|login)\b/i],
	["Bug", /\b(bug|broken|error|errore|crash\w*|fix|non funziona)\b/i],
	["Data request", /\b(data|dati|export|esport\w*|gdpr|consens\w*|consent|privacy)\b/i],
	["Feature idea", /\b(idea|feature|funzionalit\w*|propos\w*)\b/i],
	["Client request", /\b(client\w*)\b/i],
]

export function inferRequestType(text: string): RequestType | null {
	for (const [type, pattern] of TYPE_KEYWORDS) if (pattern.test(text)) return type
	return null
}

const KIND_WORDS: Record<string, ActionKind> = {
	task: "task",
	attività: "task",
	attivita: "task",
	desk: "desk",
	richiesta: "desk",
}

export function parseActionLine(raw: string, meetingDate: string): ParsedAction | null {
	const line = raw.replace(/^\s*(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s*/, "").trim()
	if (!line) return null

	const warnings: string[] = []
	const parts = line.split(/\s*[·|]\s*/).filter(Boolean)

	let kind: ActionKind | null = null
	const head = parts[0].match(/^(\p{L}+)\s*(?::\s*(.*)|\s+(.*))?$/u)
	if (head && KIND_WORDS[head[1].toLowerCase()]) {
		kind = KIND_WORDS[head[1].toLowerCase()]
		const rest = (head[2] ?? head[3] ?? "").trim()
		if (rest) parts[0] = rest
		else parts.shift()
	}
	if (!kind) {
		kind = "task"
		warnings.push("No Task/Desk prefix: created as a Task, check where this goes")
	}

	const main = parts.shift()
	if (!main) {
		return { line, kind, unit: null, team: null, text: "", due: null, epic: null, priority: null, warnings: ["Nothing to do on this line"] }
	}

	let unit: Unit | null = null
	let team: string | null = null
	let text = main
	const ownerMatch = main.match(/^([^:]{1,40}):\s*(.+)$/)
	if (ownerMatch) {
		const owner = resolveOwner(ownerMatch[1])
		if (owner) {
			unit = owner.unit
			team = owner.team
			text = ownerMatch[2].trim()
		} else {
			warnings.push(`Owner "${ownerMatch[1].trim()}" is not a unit or squad`)
		}
	} else {
		warnings.push("No owner: write it as 'Unit: action'")
	}

	let due: string | null = null
	let epic: string | null = null
	let priority: Priority | null = null
	const extra: string[] = []
	for (const part of parts) {
		const date = parseDate(part, meetingDate)
		const epicMatch = part.match(/^epic\s*[:=]\s*(.+)$/i)
		const p = part.match(/^p([123])$/i)
		if (date && !due) due = date
		else if (epicMatch) epic = epicMatch[1].trim()
		else if (p) priority = (["P1 today", "P2 this week", "P3 later"] as const)[Number(p[1]) - 1]
		else extra.push(part)
	}
	if (extra.length) text = [text, ...extra].join(" · ")

	if (kind === "task" && unit && !team) {
		const squads = SQUADS_BY_UNIT[unit]
		warnings.push(
			squads.length
				? `${unit} has several squads (${squads.join(", ")}): pick the Team`
				: `${unit} has no app squad: Team left empty`,
		)
	}
	if (kind === "desk" && !unit) warnings.push("A Desk request needs an owner unit")
	if (!due) warnings.push(kind === "desk" ? "No date: due set by the priority rule" : "No due date")

	return { line, kind, unit, team, text, due, epic, priority, warnings }
}

export function parseActions(actions: string, meetingDate: string): ParsedAction[] {
	return actions
		.split(/\r?\n/)
		.map((l) => parseActionLine(l, meetingDate))
		.filter((a): a is ParsedAction => a !== null)
}
