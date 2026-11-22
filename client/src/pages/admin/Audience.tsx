import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { contactLine, localISODate } from '../../lib/format';
import type { User } from '../../lib/types';

export interface AudienceValue { audience: 'all' | 'selected' | 'date'; userIds: string[]; date: string }
export const defaultAudience: AudienceValue = { audience: 'all', userIds: [], date: localISODate() };

/** Selector de destinatarios compartido por Avisos email y WhatsApp. */
export function AudiencePicker({ value, onChange, allLabel }: { value: AudienceValue; onChange: (v: AudienceValue) => void; allLabel: string }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    if (value.audience !== 'selected') return;
    const t = setTimeout(() => api.get<User[]>(`/admin/users?role=CLIENT&q=${encodeURIComponent(q)}`).then(setUsers).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, value.audience]);

  const toggle = (id: string) =>
    onChange({ ...value, userIds: value.userIds.includes(id) ? value.userIds.filter((x) => x !== id) : [...value.userIds, id] });

  return (
    <fieldset className="audience">
      <legend>Destinatarios</legend>
      <label className="check"><input type="radio" checked={value.audience === 'all'} onChange={() => onChange({ ...value, audience: 'all' })} /> {allLabel}</label>
      <label className="check"><input type="radio" checked={value.audience === 'date'} onChange={() => onChange({ ...value, audience: 'date' })} /> Clientes con cita el día…</label>
      {value.audience === 'date' && <input type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />}
      <label className="check"><input type="radio" checked={value.audience === 'selected'} onChange={() => onChange({ ...value, audience: 'selected' })} /> Elegir clientes ({value.userIds.length} seleccionados)</label>
      {value.audience === 'selected' && (
        <div className="user-select">
          <input placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {users.map((u) => (
              <li key={u.id}>
                <label className="check"><input type="checkbox" checked={value.userIds.includes(u.id)} onChange={() => toggle(u.id)} /> {u.name} <small className="muted">{contactLine(u)}</small></label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
