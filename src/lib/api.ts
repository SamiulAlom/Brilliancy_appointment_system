const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const apiConfigured = BASE.startsWith('https://') || BASE.startsWith('http://127.0.0.1') || BASE.startsWith('http://localhost');
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  if (!apiConfigured) throw new ApiError(0, 'NOT_CONFIGURED', 'The booking service is not configured yet (VITE_API_URL).');
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = 'Bearer ' + init.token;
  let res: Response;
  try { res = await fetch(BASE + path, { ...init, headers, signal: init.signal || AbortSignal.timeout(30000) }); }
  catch { throw new ApiError(0, 'NETWORK', 'Could not reach the booking service. Check your internet connection and try again.'); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'ERROR', data?.error?.message || 'Something went wrong. Please try again.');
  return data as T;
}
export type Service = { id: string; name: string; description: string; duration_min: number; sort_order?: number; active?: boolean };
export type Settings = { open_time: string; close_time: string; working_days: number[]; slot_step_min: number; min_notice_min: number; max_days_ahead: number; modes: Mode[]; office_address: string };
export type Mode = 'office' | 'meet' | 'phone';
export type OffDay = { id: string; from_date: string; to_date: string; reason: string };
export type PublicConfig = { today: string; settings: Settings; services: Service[]; referrers: { code: string; name: string }[]; off_days: OffDay[]; calendar_connected: boolean; other_duration_min?: number };
export type PublicBooking = { id: string; service_name: string; duration_min: number; mode: Mode; mode_label: string; start_at: string; end_at: string; when_label: string; status: string; client_name: string; meet_link: string | null; office_address: string; can_cancel: boolean };
