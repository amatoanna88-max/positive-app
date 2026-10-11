// suamotu-desk: files Service desk requests by the triage rules and shows each
// unit its queue. Usable on its own (`ntn workers exec`) or by Custom Agents.

import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { isIsoDate, todayIn } from "./dates.js"
import { dateStart, loadUnits, plainText, queryAll, selectName, SERVICE_DESK_DS, text } from "./notion.js"
import {
	applyNeededBy,
	classify,
	dueDateFor,
	mentionsHealth,
	OPEN_STATUSES,
	OWNER_BY_TYPE,
	PRIORITIES,
	REQUEST_TYPES,
	UNITS,
} from "./rules.js"

const worker = new Worker()
export default worker

worker.tool("serviceDeskDueDate", {
	title: "Service desk due date",
	description:
		"Returns the due date for a Service desk request from its priority and the date it arrived, using the Sua Motu triage rule: P1 = the day it arrived; P2 = the Friday of that week (next Friday if it arrived on a weekend); P3 = 20 working days later. Use this instead of working dates out yourself.",
	schema: j.object({
		priority: j.enum(...PRIORITIES).describe("The request's priority."),
		created: j.date().describe("The date the request arrived, YYYY-MM-DD. Leave empty for today.").nullable(),
		neededBy: j.date().describe("A date the requester said they need it by, if any. An earlier needed-by date wins.").nullable(),
	}),
	hints: { readOnlyHint: true },
	execute: ({ priority, created, neededBy }) => {
		const arrived = created ?? todayIn()
		const rule = dueDateFor(priority, arrived)
		const final = applyNeededBy(rule.due, neededBy ?? null)
		return {
			due: final.due,
			rule: final.broughtForward ? `${rule.rule}; brought forward to the needed-by date` : rule.rule,
		}
	},
})

worker.tool("fileRequest", {
	title: "File a Service desk request",
	description:
		"Creates a request in the Company OS Service desk, already triaged: the owner unit comes from the type (routing table), the due date from the priority, and the classification from the content. Use it when someone asks for something another unit must do (a bug, access, a purchase, data, a feature idea, a client request). Choose the type and priority yourself from the request; the worker does the rest. It refuses requests that contain health details, because those must not be stored in Notion.",
	schema: j.object({
		request: j.string().describe("Short title of what is needed, without personal or health details."),
		type: j.enum(...REQUEST_TYPES).describe("Pick the one that decides who must act."),
		priority: j
			.enum(...PRIORITIES)
			.describe(
				"P1 today: a paying client cannot use what she paid for, or a possible data/privacy incident. P2 this week: someone is waiting, a bug has a workaround, or someone needs access to start work. P3 later: ideas, purchases without a deadline, improvements.",
			),
		notes: j.string().describe("Context for whoever picks it up. No health, payment or contact details.").nullable(),
		neededBy: j.date().describe("Date the requester needs it by, YYYY-MM-DD, if they said one.").nullable(),
		channel: j.enum("Form", "Email", "WhatsApp", "App").describe("Where the request came from. Defaults to Form.").nullable(),
	}),
	execute: async ({ request, type, priority, notes, neededBy, channel }, { notion }): Promise<Record<string, string | boolean | null>> => {
		const content = `${request}\n${notes ?? ""}`
		if (mentionsHealth(content)) {
			return {
				created: false,
				reason:
					"The request mentions health details, which must not be stored in Notion (workspace rule 5). Rephrase it without them, e.g. 'Client needs a programme change: details in the app'.",
			}
		}
		if (neededBy && !isIsoDate(neededBy)) throw new Error(`neededBy is not a valid date: ${neededBy}`)

		const today = todayIn()
		const owner = OWNER_BY_TYPE[type]
		const rule = dueDateFor(priority, today)
		const final = applyNeededBy(rule.due, neededBy ?? null)
		const { classification, reason } = classify(content)
		const units = await loadUnits(notion)

		const triageNote = [
			`Triage: filed by suamotu-desk. ${type} → ${owner} (routing table). ${rule.rule}.`,
			final.broughtForward ? "Due brought forward to the needed-by date." : null,
			`Classification ${classification}: ${reason}.`,
		]
			.filter(Boolean)
			.join(" ")

		const page: any = await notion.pages.create({
			parent: { type: "data_source_id", data_source_id: SERVICE_DESK_DS },
			properties: {
				Request: { title: text(request) },
				Type: { select: { name: type } },
				"Owner unit": { relation: [{ id: units.get(owner)! }] },
				Priority: { select: { name: priority } },
				Classification: { select: { name: classification } },
				Due: { date: { start: final.due } },
				Status: { select: { name: "Triaged" } },
				Channel: { select: { name: channel ?? "Form" } },
				Notes: { rich_text: text(notes ? `${notes}\n\n${triageNote}` : triageNote) },
			},
		})

		return {
			created: true,
			url: page.url,
			request,
			type,
			ownerUnit: owner,
			priority,
			due: final.due,
			classification,
			status: "Triaged",
		}
	},
})

worker.tool("myQueue", {
	title: "Unit request queue",
	description:
		"Lists the open Service desk requests (New, Triaged, In progress) owned by one operating unit, overdue and P1 first, then by due date. Use it to answer 'what should this unit work on today?'.",
	schema: j.object({
		unit: j.enum(...UNITS).describe("The operating unit whose queue to show."),
		limit: j.integer().describe("Maximum requests to return. Defaults to 20.").nullable(),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ unit, limit }, { notion }) => {
		const units = await loadUnits(notion)
		const today = todayIn()
		const pages = await queryAll(notion, {
			data_source_id: SERVICE_DESK_DS,
			filter: {
				and: [
					{ property: "Owner unit", relation: { contains: units.get(unit)! } },
					{ or: OPEN_STATUSES.map((s) => ({ property: "Status", select: { equals: s } })) },
				],
			},
		})

		const rows = pages.map((p) => {
			const due = dateStart(p.properties.Due)
			const priority = selectName(p.properties.Priority)
			return {
				request: plainText(p.properties.Request),
				url: p.url ?? null,
				status: selectName(p.properties.Status),
				type: selectName(p.properties.Type),
				priority,
				due,
				overdue: due !== null && due < today,
				dueToday: due === today,
			}
		})

		const rank = (r: (typeof rows)[number]) => (r.overdue ? 0 : r.priority === "P1 today" ? 1 : 2)
		rows.sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999"))

		const shown = rows.slice(0, limit ?? 20)
		return {
			unit,
			today,
			open: rows.length,
			overdue: rows.filter((r) => r.overdue).length,
			dueToday: rows.filter((r) => r.dueToday).length,
			requests: shown,
		}
	},
})
