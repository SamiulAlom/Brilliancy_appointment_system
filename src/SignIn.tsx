import { useState, type FormEvent } from 'react';
import { CalendarCheck2, Headset, LockKeyhole, Mail, PhoneCall, ShieldCheck } from 'lucide-react';
import { api } from './lib/api';

export type Role = 'team' | 'admin';
export const TOKEN_KEYS: Record<Role, string> = { team: 'brilliancy-appointments-team', admin: 'brilliancy-appointments-admin' };
const HOME: Record<Role, string> = { team: '/team', admin: '/admin' };
const save = (role: Role, t: string) => { try { localStorage.setItem(TOKEN_KEYS[role], t); } catch { /* private mode */ } };

/** One sign-in page for both the communication team and administrators. */
export default function SignIn({ initial, error: outerError, onToken }: { initial: Role; error?: string; onToken: (role: Role, token: string) => void }) {
  const [role, setRole] = useState<Role>(initial);
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { access_token } = await api<{ access_token: string }>(role === 'team' ? '/api/team/login' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      if (role === initial) onToken(role, access_token);
      else { save(role, access_token); location.href = HOME[role]; }   // other portal: hand over and go there
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  const team = role === 'team';
  return <div className="signin">
    <aside className="signin-art">
      <a href="/" className="signin-logo"><img src="/brand/brilliancy-research-logo.jpg" alt="Brilliancy Research" width="2317" height="654"/></a>
      <div className="signin-copy">
        <h1>{team ? <>Every booked client,<br/>one call away.</> : <>Run the booking<br/>system with ease.</>}</h1>
        <p>{team ? 'See booked slots, call or WhatsApp clients in one tap, and log every follow-up for the whole team.' : 'Bookings, analytics, referrals, staff and settings for Brilliancy Research appointments.'}</p>
      </div>
      <ul className="signin-points">
        {team ? <><li><PhoneCall size={18}/> Today’s “to call” list, updated every minute</li><li><CalendarCheck2 size={18}/> Booked slots by day with referrer</li><li><Headset size={18}/> Shared call log and call-back reminders</li></>
          : <><li><CalendarCheck2 size={18}/> Bookings and Google Calendar</li><li><ShieldCheck size={18}/> Team accounts and permissions</li><li><Headset size={18}/> Follow-up activity from the team</li></>}
      </ul>
    </aside>
    <main className="signin-main">
      <form className="signin-card" onSubmit={submit}>
        <div className="seg" role="tablist" aria-label="Sign in as">
          <button type="button" role="tab" aria-selected={team} className={team ? 'on' : ''} onClick={() => { setRole('team'); setError(''); }}><Headset size={16}/> Communication team</button>
          <button type="button" role="tab" aria-selected={!team} className={!team ? 'on' : ''} onClick={() => { setRole('admin'); setError(''); }}><ShieldCheck size={16}/> Administrator</button>
        </div>
        <h2>{team ? 'Team sign-in' : 'Administrator sign-in'}</h2>
        <p className="muted">{team ? 'Use the email and password an administrator gave you.' : 'Use your administrator email and password.'}</p>
        <label>Email<span className="input-icon"><Mail size={17}/><input type="email" autoComplete="username" value={u} onChange={e => setU(e.target.value)} required placeholder="name@example.com"/></span></label>
        <label>Password<span className="input-icon"><LockKeyhole size={17}/><input type="password" autoComplete="current-password" value={p} onChange={e => setP(e.target.value)} required placeholder="••••••••••"/></span></label>
        {(error || outerError) && <p className="alert" role="alert">{error || outerError}</p>}
        <button className="primary wide-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="signin-foot">Booking an appointment? <a href="/">Go to the booking page</a></p>
      </form>
    </main>
  </div>;
}
