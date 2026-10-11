// suamotu-meetings: turns the Actions written in a meeting into tracked work
// (App Tasks or Service desk requests) and lists what is still open.
// Usable on its own (`ntn workers exec`) or by Custom Agents.

import type { Client } from "@notionhq/client"
import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { fridayOf, todayIn } from "./dates.js"
import {
	dateStart,
	EPICS_DS,
	loadUnits,
	MEETINGS_DS,
	normaliseId,
	pageIdFrom,
	plainText,
	queryAll,
	selectName,
	SERVICE_DESK_DS,
	TASKS_DS,
	text,
} from "./notion.js"
import { inferRequestType, type ParsedAction, parseActions, SQUADS_BY_UNIT } from "./parse.js"
import { classify, dueDateFor, mentionsHealth, OPEN_STATUSES, type Priority, UNITS } from "./rules.js"

const worker = new Worker()
export default worker

const FROM_MEETING = "From meeting:"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

type Planned = ParsedAction & {
	requestType: string | null
	finalPriority: Priority | null
	finalDue: string | null
	epicId: string | null
	skip: string | null
}

function priorityFromDue(due: string, meetingDate: string): Priority {
	if (due <= meetingDate) return "P1 today"
	if (due <= fridayOf(meetingDate)) return "P2 this week"
	return "P3 later"
}

async function findEpic(notion: Client, name: string): Promise<{ id: string | null; warning: string | null }> {
	const response = await notion.dataSources.query({
		data_source_id: EPICS_DS,
		filter: { property: "Epic", title: { contains: name } },
		page_size: 10,
	})
	const pages = response.results as { id: string; properties: Record<string, any> }[]
	const exact = pages.filter((p) => plainText(p.properties.Epic).toLowerCase() === name.toLowerCase())
	const pick = exact.length === 1 ? exact : pages
	if (pick.length === 1) return { id: pick[0].id, warning: null }
	if (pick.length === 0) return { id: null, warning: `No epic matches "${name}": link it by hand` }
	return { id: null, warning: `${pick.length} epics match "${name}": link the right one by hand` }
}

async function plan(notion: Client, actions: ParsedAction[], meetingDate: string, today: string): Promise<Planned[]> {
	const planned: Planned[] = []
	for (const a of actions) {
		const p: Planned = { ...a, warnings: [...a.warnings], requestType: null, finalPriority: null, finalDue: a.due, epicId: null, skip: null }
		if (!a.text) p.skip = "Nothing to do on this line"
		else if (mentionsHealth(a.line)) p.skip = "Contains health details, which must not be stored in Notion: rewrite the line without them"
		else if (a.kind === "desk" && !a.unit) p.skip = "A Desk request needs an owner unit (e.g. 'Desk · Operazioni: …')"

		if (!p.skip && a.kind === "desk") {
			p.requestType = inferRequestType(a.text)
			if (!p.requestType) p.warnings.push("Type not recognised: left empty, status New for triage")
			p.finalPriority = a.priority ?? (a.due ? priorityFromDue(a.due, meetingDate) : "P2 this week")
			p.finalDue = a.due ?? dueDateFor(p.finalPriority, today).due
		}
		if (!p.skip && a.kind === "task" && a.epic) {
			const epic = await findEpic(notion, a.epic)
			p.epicId = epic.id
			if (epic.warning) p.warnings.push(epic.warning)
		}
		planned.push(p)
	}
	return planned
}

function fromMeetingNote(meetingId: string, extra: string[]) {
	return [
		{ type: "text" as const, text: { content: `${FROM_MEETING} ` } },
		{ type: "mention" as const, mention: { page: { id: meetingId } } },
		...(extra.length ? text(`\n${extra.join("\n")}`) : []),
	]
}

async function createTask(notion: Client, p: Planned, meetingId: string) {
	const properties: Record<string, any> = {
		Task: { title: text(p.text) },
		Status: { select: { name: "Backlog" } },
		Notes: { rich_text: fromMeetingNote(meetingId, p.warnings.map((w) => `Check: ${w}`)) },
	}
	if (p.team) properties.Team = { select: { name: p.team } }
	if (p.finalDue) properties.Due = { date: { start: p.finalDue } }
	if (p.epicId) properties.Epic = { relation: [{ id: p.epicId }] }
	return (await notion.pages.create({ parent: { type: "data_source_id", data_source_id: TASKS_DS }, properties })) as any
}

async function createRequest(notion: Client, p: Planned, meetingId: string, unitIds: Map<string, string>) {
	const { classification, reason } = classify(p.text)
	const triage = `Triage: filed by suamotu-meetings. ${p.requestType ?? "Type not recognised"} → ${p.unit}. Classification ${classification}: ${reason}.`
	const properties: Record<string, any> = {
		Request: { title: text(p.text) },
		"Owner unit": { relation: [{ id: unitIds.get(p.unit!)! }] },
		Priority: { select: { name: p.finalPriority } },
		Classification: { select: { name: classification } },
		Due: { date: { start: p.finalDue } },
		Status: { select: { name: p.requestType ? "Triaged" : "New" } },
		Notes: { rich_text: fromMeetingNote(meetingId, [triage, ...p.warnings.map((w) => `Check: ${w}`)]) },
	}
	if (p.requestType) properties.Type = { select: { name: p.requestType } }
	return (await notion.pages.create({ parent: { type: "data_source_id", data_source_id: SERVICE_DESK_DS }, properties })) as any
}

function summarise(p: Planned) {
	return {
		line: p.line,
		goesTo: p.skip ? "not created" : p.kind === "task" ? "App Tasks" : "Service desk",
		title: p.text,
		unit: p.unit,
		team: p.team,
		type: p.requestType,
		priority: p.finalPriority,
		due: p.finalDue,
		epicLinked: Boolean(p.epicId),
		warnings: p.skip ? [p.skip] : p.warnings,
	}
}

worker.tool("meetingToActions", {
	title: "Turn meeting actions into tasks and requests",
	description:
		"Reads the Actions field of a page in Meetings and rituals (one action per line, e.g. 'Task · Piattaforma: finish the check-in form · 20/10' or 'Desk · Operazioni: buy a Canva licence · 17/10') and creates one App Task or Service desk request per line, each linked back to the meeting. Then lists what was created on the meeting page and sets its Status to 'Actions assigned'. Lines it cannot fully read are still created and flagged 'Check:'. Run with dryRun true first to preview without writing.",
	schema: j.object({
		meeting: j.string().describe("Link or id of the meeting page in Meetings and rituals."),
		dryRun: j.boolean().describe("true = only show what would be created. Defaults to false.").nullable(),
		force: j.boolean().describe("Process again even if the meeting is already 'Actions assigned' (creates duplicates). Defaults to false.").nullable(),
	}),
	execute: async ({ meeting, dryRun, force }, { notion }): Promise<{ [key: string]: Json }> => {
		const meetingId = pageIdFrom(meeting)
		const page: any = await notion.pages.retrieve({ page_id: meetingId })
		const parentDs = page.parent?.data_source_id
		if (!parentDs || normaliseId(parentDs) !== normaliseId(MEETINGS_DS)) {
			throw new Error("That page is not in the Meetings and rituals database.")
		}

		const title = plainText(page.properties.Meeting) || "Untitled meeting"
		const status = selectName(page.properties.Status)
		const meetingDate = dateStart(page.properties.Date) ?? page.created_time.slice(0, 10)
		if (status === "Actions assigned" && !force && !dryRun) {
			return { meeting: title, created: 0, message: "Actions were already assigned for this meeting. Pass force: true to process them again (this creates duplicates)." }
		}

		const actions = parseActions(plainText(page.properties.Actions), meetingDate)
		if (actions.length === 0) {
			return { meeting: title, created: 0, message: "The Actions field is empty: write one action per line, e.g. 'Task · Piattaforma: finish the check-in form · 20/10'." }
		}

		const today = todayIn()
		const planned = await plan(notion, actions, meetingDate, today)
		if (dryRun) {
			return { meeting: title, dryRun: true, wouldCreate: planned.filter((p) => !p.skip).length, actions: planned.map(summarise) }
		}

		const unitIds = await loadUnits(notion)
		const results: { summary: ReturnType<typeof summarise>; url: string | null; id: string | null; error: string | null }[] = []
		for (const p of planned) {
			if (p.skip) {
				results.push({ summary: summarise(p), url: null, id: null, error: null })
				continue
			}
			try {
				const created = p.kind === "task" ? await createTask(notion, p, meetingId) : await createRequest(notion, p, meetingId, unitIds)
				results.push({ summary: summarise(p), url: created.url, id: created.id, error: null })
			} catch (e) {
				results.push({ summary: summarise(p), url: null, id: null, error: e instanceof Error ? e.message : String(e) })
			}
		}

		const createdCount = results.filter((r) => r.id).length
		const failed = results.filter((r) => r.error)

		// Record on the meeting page what was created, so the meeting shows its actions.
		const bullets: any[] = results.map((r) => {
			const label = r.id
				? [
						{ type: "mention", mention: { page: { id: r.id } } },
						...text(` · ${r.summary.goesTo}${r.summary.due ? ` · due ${r.summary.due}` : ""}${r.summary.warnings.length ? ` · check: ${r.summary.warnings.join("; ")}` : ""}`),
					]
				: text(`Not created: "${r.summary.line}" · ${r.error ?? r.summary.warnings.join("; ")}`)
			return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: label } }
		})
		await notion.blocks.children.append({
			block_id: meetingId,
			children: [{ object: "block", type: "heading_3", heading_3: { rich_text: text(`Actions created · ${today}`) } }, ...bullets],
		})

		if (createdCount > 0 && failed.length === 0) {
			await notion.pages.update({ page_id: meetingId, properties: { Status: { select: { name: "Actions assigned" } } } })
		}

		return {
			meeting: title,
			created: createdCount,
			notCreated: results.length - createdCount,
			statusSet: createdCount > 0 && failed.length === 0 ? "Actions assigned" : null,
			actions: results.map((r) => ({ ...r.summary, url: r.url, error: r.error })),
		}
	},
})

worker.tool("openActions", {
	title: "Open actions from meetings",
	description:
		"Lists the App Tasks and Service desk requests created from meetings that are not finished yet, overdue first, then by due date. Optionally only one operating unit's, or only the overdue ones. Use it before a Monday review or when someone asks what is still open from past meetings.",
	schema: j.object({
		unit: j.enum(...UNITS).describe("Only this unit's actions. Leave empty for all.").nullable(),
		overdueOnly: j.boolean().describe("Only actions past their due date. Defaults to false.").nullable(),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ unit, overdueOnly }, { notion }) => {
		const today = todayIn()
		const fromMeeting = { property: "Notes", rich_text: { contains: FROM_MEETING } }

		const taskFilters: any[] = [fromMeeting, { property: "Status", select: { does_not_equal: "Done" } }]
		if (unit) {
			const squads = SQUADS_BY_UNIT[unit]
			if (squads.length) taskFilters.push({ or: squads.map((s) => ({ property: "Team", select: { equals: s } })) })
		}
		const deskFilters: any[] = [fromMeeting, { or: OPEN_STATUSES.map((s) => ({ property: "Status", select: { equals: s } })) }]
		if (unit) {
			const units = await loadUnits(notion)
			deskFilters.push({ property: "Owner unit", relation: { contains: units.get(unit)! } })
		}

		const [tasks, requests] = await Promise.all([
			unit && SQUADS_BY_UNIT[unit].length === 0 ? Promise.resolve([]) : queryAll(notion, { data_source_id: TASKS_DS, filter: { and: taskFilters } }),
			queryAll(notion, { data_source_id: SERVICE_DESK_DS, filter: { and: deskFilters } }),
		])

		const rows = [
			...tasks.map((p) => ({
				kind: "App Task",
				title: plainText(p.properties.Task),
				owner: selectName(p.properties.Team),
				status: selectName(p.properties.Status),
				due: dateStart(p.properties.Due),
				url: p.url ?? null,
			})),
			...requests.map((p) => ({
				kind: "Service desk",
				title: plainText(p.properties.Request),
				owner: null as string | null,
				status: selectName(p.properties.Status),
				due: dateStart(p.properties.Due),
				url: p.url ?? null,
			})),
		].map((r) => ({ ...r, overdue: r.due !== null && r.due < today }))

		const shown = rows
			.filter((r) => !overdueOnly || r.overdue)
			.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due ?? "9999").localeCompare(b.due ?? "9999"))

		return {
			unit: unit ?? "all",
			today,
			open: rows.length,
			overdue: rows.filter((r) => r.overdue).length,
			actions: shown,
		}
	},
})
