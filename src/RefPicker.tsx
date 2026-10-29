import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search, UserRound, X } from 'lucide-react';

type Ref = { code: string; name: string };
type Option = { key: string; kind: 'staff' | 'other' | 'none'; label: string; hint?: string; code?: string };

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// Rank: name starts with the query, then any word starts with it, then it appears anywhere (or in the employee ID).
function matches(list: Ref[], q: string): Ref[] {
  const n = norm(q);
  if (!n) return list.slice(0, 8);
  return list.map(r => {
    const name = norm(r.name);
    const score = name.startsWith(n) ? 0 : name.split(' ').some(w => w.startsWith(n)) ? 1 : name.includes(n) ? 2 : norm(r.code).includes(n) ? 3 : -1;
    return { r, score };
  }).filter(x => x.score >= 0).sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name)).slice(0, 8).map(x => x.r);
}

/** "Who referred you?" with suggestions as the client types. choice: employee code, '__other' or '__none'. */
export default function RefPicker({ referrers, choice, other, onChange }: {
  referrers: Ref[]; choice: string; other: string; onChange: (choice: string, other: string) => void;
}) {
  const picked = referrers.find(r => r.code === choice);
  const [q, setQ] = useState(picked?.name || (choice === '__other' ? other : ''));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options: Option[] = useMemo(() => {
    const found = matches(referrers, q).map(r => ({ key: r.code, kind: 'staff' as const, label: r.name, hint: r.code, code: r.code }));
    const exact = found.some(o => norm(o.label) === norm(q));
    return [
      ...found,
      ...(q.trim().length >= 2 && !exact ? [{ key: '__other', kind: 'other' as const, label: `“${q.trim()}”`, hint: 'Not in the list — use this name' }] : []),
      { key: '__none', kind: 'none' as const, label: 'No one referred me' },
    ];
  }, [referrers, q]);

  const picked_ = useRef(false);
  const choose = (o: Option) => {
    picked_.current = true;
    if (o.kind === 'staff') { setQ(o.label); onChange(o.code!, ''); }
    else if (o.kind === 'other') { onChange('__other', q.trim()); }
    else { setQ(''); onChange('__none', ''); }
    setOpen(false);
  };
  const type = (v: string) => {
    picked_.current = false; setQ(v); setOpen(true); setActive(0);
    const exact = referrers.find(r => norm(r.name) === norm(v));
    onChange(exact ? exact.code : '', '');           // a free-typed name is only used once they leave the field
  };
  const commit = () => {
    setTimeout(() => setOpen(false), 150);
    if (picked_.current) return;
    const exact = referrers.find(r => norm(r.name) === norm(q));
    if (exact) { if (choice !== exact.code) onChange(exact.code, ''); }
    else if (q.trim().length >= 2 && choice !== '__none') onChange('__other', q.trim());
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  if (choice === '__none') return <div className="ref-picked"><UserRound size={16} aria-hidden/> No one referred me
    <button type="button" className="link" onClick={() => { onChange('', ''); setOpen(true); setTimeout(() => input.current?.focus()); }}>Change</button></div>;

  return <div className="ref-picker">
    <label htmlFor={listId + 'in'}>Who referred you to Brilliancy Research?</label>
    <div className={`ref-box ${picked ? 'ok' : ''}`}>
      <Search size={16} aria-hidden className="ref-icon"/>
      <input id={listId + 'in'} ref={input} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined} autoComplete="off" maxLength={120}
        placeholder="Start typing a name…" value={q} onChange={e => type(e.target.value)} onFocus={() => setOpen(true)}
        onBlur={commit} onKeyDown={key}/>
      {picked && <Check size={17} className="ref-ok" aria-label="Selected"/>}
      {q && !picked && <button type="button" className="ref-clear" aria-label="Clear" onMouseDown={e => e.preventDefault()} onClick={() => type('')}><X size={15}/></button>}
      {open && <ul className="ref-list" role="listbox" id={listId}>
        {options.map((o, i) => <li key={o.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
          className={`${o.kind} ${i === active ? 'active' : ''}`} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(o)}>
          <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
        </li>)}
      </ul>}
    </div>
    <small className="ref-help">{picked ? `Selected: ${picked.name}` : choice === '__other' ? 'We will record this name as your referrer.' : 'Type to search our team, or choose “No one referred me”.'}</small>
  </div>;
}
