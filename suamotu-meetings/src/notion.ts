// Thin helpers over the Notion SDK client for the databases this worker uses.

import type { Client } from "@notionhq/client"
import { UNITS, type Unit } from "./rules.js"

// Data sources in SuaMotu Groupwide › Company OS. Override with env vars if a
// database is ever moved or rebuilt.
export const SERVICE_DESK_DS = process.env.SERVICE_DESK_DATA_SOURCE_ID ?? "a58804b0-40f3-49f2-b46a-e0fee76dcf4b"
export const OPERATING_UNITS_DS = process.env.OPERATING_UNITS_DATA_SOURCE_ID ?? "47658da5-a549-400c-bb2e-f2c54a1c1671"
export const MEETINGS_DS = process.env.MEETINGS_DATA_SOURCE_ID ?? "fbd33368-c049-4227-82f4-a572c727e435"
export const TASKS_DS = process.env.TASKS_DATA_SOURCE_ID ?? "8dcabe6c-cb96-463d-9349-4fee62daf54d"
export const EPICS_DS = process.env.EPICS_DATA_SOURCE_ID ?? "4b627d94-af75-4347-85da-0411598d922d"

/** Accepts a Notion page URL or id and returns the dashed page id. */
export function pageIdFrom(value: string): string {
	const hex = value.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i)
	if (!hex) throw new Error(`Not a Notion page link or id: ${value}`)
	const h = hex[0].toLowerCase()
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function normaliseId(id: string): string {
	return id.replace(/-/g, "").toLowerCase()
}

type Page = { id: string; url?: string; properties: Record<string, any> }

export function plainText(prop: any): string {
	const parts = prop?.title ?? prop?.rich_text ?? []
	return parts.map((p: any) => p.plain_text ?? "").join("")
}

export function selectName(prop: any): string | null {
	return prop?.select?.name ?? null
}

export function dateStart(prop: any): string | null {
	return prop?.date?.start?.slice(0, 10) ?? null
}

export function text(content: string) {
	// Notion caps one rich-text item at 2000 characters
	const chunks: { type: "text"; text: { content: string } }[] = []
	for (let i = 0; i < content.length; i += 2000) {
		chunks.push({ type: "text", text: { content: content.slice(i, i + 2000) } })
	}
	return chunks
}

/** Maps each operating unit's name to its page id. */
export async function loadUnits(notion: Client): Promise<Map<Unit, string>> {
	const response = await notion.dataSources.query({ data_source_id: OPERATING_UNITS_DS, page_size: 100 })
	const units = new Map<Unit, string>()
	for (const page of response.results as Page[]) {
		const name = plainText(page.properties.Unit)
		if ((UNITS as readonly string[]).includes(name)) units.set(name as Unit, page.id)
	}
	const missing = UNITS.filter((u) => !units.has(u))
	if (missing.length) {
		throw new Error(`Operating units not found in Notion: ${missing.join(", ")}. Check that the integration can see the Operating units database.`)
	}
	return units
}

export async function queryAll(
	notion: Client,
	params: Parameters<Client["dataSources"]["query"]>[0],
	max = 500,
): Promise<Page[]> {
	const pages: Page[] = []
	let cursor: string | undefined
	do {
		const response = await notion.dataSources.query({ ...params, start_cursor: cursor, page_size: 100 })
		pages.push(...(response.results as Page[]))
		cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
	} while (cursor && pages.length < max)
	return pages
}
