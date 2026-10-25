import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase = url && key?.startsWith('sb_publishable_')
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'brilliancy-appointments-auth' } }) : null;
