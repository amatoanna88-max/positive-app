// Calendar-date helpers. Dates are plain "YYYY-MM-DD" strings so that no
// time zone can shift them; "today" is taken in Sua Motu's own time zone.

export const TIME_ZONE = "Europe/Rome"

export function todayIn(timeZone: string = TIME_ZONE, now: Date = new Date()): string {
	// en-CA formats as YYYY-MM-DD
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now)
}

export function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const [y, m, d] = value.split("-").map(Number)
	const date = new Date(Date.UTC(y, m - 1, d))
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function toUtc(iso: string): Date {
	if (!isIsoDate(iso)) throw new Error(`Not a valid date (expected YYYY-MM-DD): ${iso}`)
	const [y, m, d] = iso.split("-").map(Number)
	return new Date(Date.UTC(y, m - 1, d))
}

function fromUtc(date: Date): string {
	return date.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
	const date = toUtc(iso)
	date.setUTCDate(date.getUTCDate() + days)
	return fromUtc(date)
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(iso: string): number {
	return toUtc(iso).getUTCDay()
}

/** The Friday of the date's Monday–Friday week; Saturday and Sunday roll to the next Friday. */
export function fridayOf(iso: string): string {
	const day = weekday(iso)
	if (day === 6) return addDays(iso, 6)
	if (day === 0) return addDays(iso, 5)
	return addDays(iso, 5 - day)
}

/** Counts Monday–Friday only. Public holidays are not excluded. */
export function addWorkingDays(iso: string, count: number): string {
	let current = iso
	let added = 0
	while (added < count) {
		current = addDays(current, 1)
		const day = weekday(current)
		if (day !== 0 && day !== 6) added++
	}
	return current
}

export function minDate(a: string, b: string): string {
	return a <= b ? a : b
}
