/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_API_URL?: string; readonly VITE_SUPABASE_URL?: string; readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string; readonly VITE_TURNSTILE_SITE_KEY?: string; }
interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void } }
