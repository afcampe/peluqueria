import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateLong, localISODate, time } from '../lib/format';
import { useSession } from '../lib/session';
import type { Slot } from '../lib/types';
import { Spinner } from './ui';

/** Selector de fecha + huecos libres. Llama a onPick con el ISO del inicio. */
export function SlotPicker({ value, onPick, excludeId, initialDate }: {
  value: string | null; onPick: (start: string) => void; excludeId?: string; initialDate?: string;
}) {
  const { config } = useSession();
  const today = localISODate();
  const max = localISODate(new Date(), config?.bookingHorizonDays ?? 365);
  const [date, setDate] = useState(initialDate ?? today);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSlots(null);
    setError('');
    const q = new URLSearchParams({ date, ...(excludeId && { excludeId }) });
    api.get<Slot[]>(`/public/availability?${q}`).then(setSlots).catch((e) => setError(e.message));
  }, [date, excludeId]);

  const shift = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const next = d.toISOString().slice(0, 10);
    if (next >= today && next <= max) setDate(next);
  };

  const free = slots?.filter((s) => s.available) ?? [];
  const morning = free.filter((s) => Number(time(s.start).slice(0, 2)) < 14);
  const afternoon = free.filter((s) => Number(time(s.start).slice(0, 2)) >= 14);

  return (
    <div className="slot-picker">
      <div className="date-nav">
        <button type="button" className="btn-icon" onClick={() => shift(-1)} disabled={date <= today} aria-label="Día anterior">‹</button>
        <input type="date" value={date} min={today} max={max} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button type="button" className="btn-icon" onClick={() => shift(1)} disabled={date >= max} aria-label="Día siguiente">›</button>
      </div>
      <p className="muted date-label">{dateLong(`${date}T12:00:00Z`)}</p>
      {error && <p className="error-text">{error}</p>}
      {!slots && !error && <Spinner />}
      {slots && free.length === 0 && (
        <p className="empty">{slots.length === 0 ? 'Cerrado este día.' : 'No quedan huecos libres este día.'}</p>
      )}
      {[['Mañana', morning], ['Tarde', afternoon]].map(([label, list]) =>
        (list as Slot[]).length ? (
          <div key={label as string}>
            <h4 className="slot-group">{label as string}</h4>
            <div className="slots">
              {(list as Slot[]).map((s) => (
                <button type="button" key={s.start} className={`slot ${value === s.start ? 'selected' : ''}`} onClick={() => onPick(s.start)}>
                  {time(s.start)}
                </button>
              ))}
            </div>
          </div>
        ) : null,
      )}
    </div>
  );
}
