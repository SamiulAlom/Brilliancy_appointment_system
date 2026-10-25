// All dates are Bangladesh time (UTC+6, no daylight saving).
const pad = (n: number) => String(n).padStart(2, '0');
export const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm.slice(0, 5)}:00+06:00`);
export function dhakaDate(ms: number) { const d = new Date(ms + 6 * 3600e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export const addDays = (date: string, n: number) => dhakaDate(at(date, '00:00') + n * 86400e3);
export const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();
const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', ...o });
export const fmtDay = (date: string, o: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }) => f(o).format(new Date(at(date, '12:00')));
export const fmtTime = (ms: number | string) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
export const fmtDateTime = (iso: string) => f({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) + ', ' + fmtTime(iso);
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
