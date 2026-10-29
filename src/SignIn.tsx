import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CalendarCheck2, CheckCircle2, Headset, KeyRound, LockKeyhole, Mail, PhoneCall, ShieldCheck } from 'lucide-react';
import { api } from './lib/api';

export type Role = 'team' | 'admin';
export const TOKEN_KEYS: Record<Role, string> = { team: 'brilliancy-appointments-team', admin: 'brilliancy-appointments-admin' };
const HOME: Record<Role, string> = { team: '/team', admin: '/admin' };
const save = (role: Role, t: string) => { try { localStorage.setItem(TOKEN_KEYS[role], t); } catch { /* private mode */ } };

const RESET = new URLSearchParams(location.search).get('reset');
type Mode = 'signin' | 'forgot' | 'sent' | 'reset' | 'changed';

/** One sign-in page for both the communication team and administrators, with "forgot password" and reset-link screens. */
export default function SignIn({ initial, error: outerError, onToken }: { initial: Role; error?: string; onToken: (role: Role, token: string) => void }) {
  const [role, setRole] = useState<Role>(initial);
  const [mode, setMode] = useState<Mode>(RESET ? 'reset' : 'signin');
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [p2, setP2] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const go = (m: Mode) => { setMode(m); setError(''); setP(''); setP2(''); };
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  const signIn = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const { access_token } = await api<{ access_token: string }>(role === 'team' ? '/api/team/login' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    if (role === initial) onToken(role, access_token);
    else { save(role, access_token); location.href = HOME[role]; }   // other portal: hand over and go there
  }); };
  const forgot = (e: FormEvent) => { e.preventDefault(); run(async () => { await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ role, email: u }) }); setMode('sent'); }); };
  const reset = (e: FormEvent) => { e.preventDefault();
    if (p !== p2) { setError('The two passwords do not match.'); return; }
    run(async () => {
      const r = await api<{ role: Role }>('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: RESET, password: p }) });
      setRole(r.role); history.replaceState(null, '', location.pathname); setMode('changed'); setP(''); setP2('');
    });
  };
  const team = role === 'team';
  const roleSwitch = <div className="seg" role="tablist" aria-label="Sign in as">
    <button type="button" role="tab" aria-selected={team} className={team ? 'on' : ''} onClick={() => { setRole('team'); setError(''); }}><Headset size={16}/> Communication team</button>
    <button type="button" role="tab" aria-selected={!team} className={!team ? 'on' : ''} onClick={() => { setRole('admin'); setError(''); }}><ShieldCheck size={16}/> Administrator</button>
  </div>;
  const err = (error || (mode === 'signin' ? outerError : '')) && <p className="alert" role="alert">{error || outerError}</p>;
  const emailField = <label>Email<span className="input-icon"><Mail size={17}/><input type="email" autoComplete="username" value={u} onChange={e => setU(e.target.value)} required placeholder="name@example.com"/></span></label>;
  return <Frame team={team}>
    {mode === 'signin' && <form className="signin-card" onSubmit={signIn}>
      {roleSwitch}
      <h2>{team ? 'Team sign-in' : 'Administrator sign-in'}</h2>
      <p className="muted">{team ? 'Use the email and password an administrator gave you.' : 'Use your administrator email and password.'}</p>
      {emailField}
      <div className="pw-field">
        <label>Password<span className="input-icon"><LockKeyhole size={17}/><input type="password" autoComplete="current-password" value={p} onChange={e => setP(e.target.value)} required placeholder="••••••••••"/></span></label>
        <button type="button" className="link small forgot" onClick={() => go('forgot')}>Forgot password?</button>
      </div>
      {err}
      <button className="primary wide-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="signin-foot">Booking an appointment? <a href="/">Go to the booking page</a></p>
    </form>}
    {mode === 'forgot' && <form className="signin-card" onSubmit={forgot}>
      {roleSwitch}
      <h2>Forgot your password?</h2>
      <p className="muted">Enter the email of your {team ? 'team' : 'administrator'} account. We will email you a link to choose a new password.</p>
      {emailField}
      {err}
      <button className="primary wide-btn" disabled={busy}>{busy ? 'Sending…' : 'Email me a reset link'}</button>
      <button type="button" className="link back" onClick={() => go('signin')}><ArrowLeft size={15}/> Back to sign-in</button>
    </form>}
    {mode === 'sent' && <div className="signin-card center">
      <span className="big-icon"><Mail size={26}/></span>
      <h2>Check your email</h2>
      <p className="muted">If <b>{u}</b> has a {team ? 'team' : 'administrator'} account, a reset link is on its way. It works once and expires in 60 minutes. Check spam if you don’t see it.</p>
      <p className="muted small">No email? Ask an administrator to reset your password from Settings.</p>
      <button type="button" className="secondary wide-btn" onClick={() => go('signin')}>Back to sign-in</button>
    </div>}
    {mode === 'reset' && <form className="signin-card" onSubmit={reset}>
      <span className="big-icon"><KeyRound size={26}/></span>
      <h2>Choose a new password</h2>
      <p className="muted">At least 10 characters. Use something only you know.</p>
      <label>New password<span className="input-icon"><LockKeyhole size={17}/><input type="password" minLength={10} autoComplete="new-password" value={p} onChange={e => setP(e.target.value)} required/></span></label>
      <label>Confirm new password<span className="input-icon"><LockKeyhole size={17}/><input type="password" minLength={10} autoComplete="new-password" value={p2} onChange={e => setP2(e.target.value)} required/></span></label>
      {err}
      <button className="primary wide-btn" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
      <button type="button" className="link back" onClick={() => { history.replaceState(null, '', location.pathname); go('forgot'); }}>Link expired? Ask for a new one</button>
    </form>}
    {mode === 'changed' && <div className="signin-card center">
      <span className="big-icon ok"><CheckCircle2 size={26}/></span>
      <h2>Password changed</h2>
      <p className="muted">You can now sign in with your new password.</p>
      <button type="button" className="primary wide-btn" onClick={() => go('signin')}>Sign in</button>
    </div>}
  </Frame>;
}

export function Frame({ team, children }: { team: boolean; children: ReactNode }) {
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
    <main className="signin-main">{children}</main>
  </div>;
}
