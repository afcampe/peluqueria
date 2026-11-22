import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateShort, isoToLocalDate, localISODate, money, time } from '../lib/format';
import { useSession } from '../lib/session';
import type { Occurrence } from '../lib/types';
import { SlotPicker } from './SlotPicker';
import { Modal, Spinner } from './ui';

export interface SeriesPlan { intervalDays: number; starts: string[] }

const PRESETS = [7, 14, 15, 21, 28, 30];

interface Row extends Occurrence { include: boolean; edited?: boolean }

/**
 * Planificador de citas periódicas: periodicidad + fin + lista de fechas revisable.
 * Llama a onChange con las horas finales elegidas (o null si aún no hay plan válido).
 */
export function RecurrencePlanner({ firstStart, priceCents, onChange }: {
  firstStart: string; priceCents: number; onChange: (plan: SeriesPlan | null) => void;
}) {
  const { config } = useSession();
  const max = config?.recurring.maxAppointments ?? 60;
  const horizonDate = localISODate(new Date(), config?.bookingHorizonDays ?? 365);
  const [interval, setIntervalDays] = useState(15);
  const [custom, setCustom] = useState(false);
  const [endMode, setEndMode] = useState<'until' | 'count'>('until');
  const [until, setUntil] = useState(horizonDate);
  const [count, setCount] = useState(10);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);

  // Recalcular las fechas cuando cambian los parámetros (con pequeña espera mientras se escribe).
  useEffect(() => {
    if (!interval || interval < 1) return;
    setRows(null);
    setError('');
    const t = setTimeout(() => {
      api.post<{ occurrences: Occurrence[]; truncated: boolean }>('/appointments/series/preview', {
        firstStart, intervalDays: interval, ...(endMode === 'until' ? { until } : { count }),
      })
        .then((r) => { setRows(r.occurrences.map((o) => ({ ...o, include: !!o.start }))); setTruncated(r.truncated); })
        .catch((e) => setError(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [firstStart, interval, endMode, until, count]);

  const chosen = rows?.filter((r) => r.include && r.start) ?? [];
  useEffect(() => {
    onChange(chosen.length >= 2 ? { intervalDays: interval, starts: chosen.map((r) => r.start!) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, interval]);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moved = rows?.filter((r) => r.status === 'MOVED' && r.include && !r.edited).length ?? 0;
  const missing = rows?.filter((r) => !r.start).length ?? 0;

  return (
    <div className="recurrence">
      <div className="field-label">Repetir cada</div>
      <div className="chips">
        {PRESETS.map((d) => (
          <button key={d} type="button" className={`chip ${!custom && interval === d ? 'selected' : ''}`} onClick={() => { setCustom(false); setIntervalDays(d); }}>
            {d === 7 ? '1 semana' : d === 14 ? '2 semanas' : d === 21 ? '3 semanas' : d === 28 ? '4 semanas' : `${d} días`}
          </button>
        ))}
        <button type="button" className={`chip ${custom ? 'selected' : ''}`} onClick={() => setCustom(true)}>Otro…</button>
        {custom && (
          <label className="inline">
            <input type="number" min={1} max={365} value={interval || ''} onChange={(e) => setIntervalDays(Number(e.target.value))} aria-label="Cada cuántos días" /> días
          </label>
        )}
      </div>

      <div className="field-label">Hasta</div>
      <div className="chips">
        <label className="check"><input type="radio" checked={endMode === 'until'} onChange={() => setEndMode('until')} /> Fecha</label>
        {endMode === 'until' && <input type="date" className="w-auto" value={until} min={isoToLocalDate(firstStart)} max={horizonDate} onChange={(e) => e.target.value && setUntil(e.target.value)} />}
        <label className="check"><input type="radio" checked={endMode === 'count'} onChange={() => setEndMode('count')} /> Número de citas</label>
        {endMode === 'count' && <input type="number" className="w-auto" min={2} max={max} value={count} onChange={(e) => setCount(Math.min(max, Number(e.target.value)))} />}
      </div>

      {error && <p className="error-text">{error}</p>}
      {!rows && !error && <Spinner />}
      {rows && (
        <>
          <p className="series-summary">
            <strong>{chosen.length} citas</strong> · total {money(chosen.length * priceCents)}
            {moved > 0 && <span className="warn-text"> · {moved} con la hora cambiada</span>}
            {missing > 0 && <span className="error-text"> · {missing} sin hueco</span>}
          </p>
          {truncated && <p className="muted small">Se ha llegado al máximo de {max} citas por serie.</p>}
          <ul className="occurrences">
            {rows.map((r, i) => (
              <li key={r.requested} className={!r.include ? 'dim' : ''}>
                <label className="check">
                  <input type="checkbox" checked={r.include} disabled={!r.start} onChange={(e) => update(i, { include: e.target.checked })} />
                  <span className="occ-date">{dateShort(r.start ?? r.requested)}</span>
                  <span className="occ-time">{r.start ? time(r.start) : '—'}</span>
                </label>
                <span className="occ-note">
                  {r.edited ? <span className="muted small">elegida por ti</span>
                    : r.status === 'MOVED' ? <span className="warn-text small">{r.reason}: pedida {dateShort(r.requested)} {time(r.requested)}</span>
                    : r.status === 'UNAVAILABLE' ? <span className="error-text small">{r.reason}, sin huecos cercanos</span> : null}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(i)}>Cambiar</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing !== null && rows && (
        <Modal title={`Cambiar cita del ${dateShort(rows[editing].requested)}`} onClose={() => setEditing(null)}>
          <SlotPicker
            value={rows[editing].start}
            initialDate={isoToLocalDate(rows[editing].start ?? rows[editing].requested)}
            onPick={(start) => { update(editing, { start, include: true, edited: true }); setEditing(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
