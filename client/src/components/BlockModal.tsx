import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateLong, localISODate, time } from '../lib/format';
import { useSession } from '../lib/session';
import type { Appointment, Closure, Slot } from '../lib/types';
import { blockAt } from '../lib/blocks';
import { ErrorAlert, Modal, Spinner } from './ui';

/** Bloquear horas sueltas de un día (un trámite, llegar más tarde…) para que nadie las reserve. */
export function BlockModal({ initialDate, version, onAppt, onClose, onDone }: {
  initialDate: string;
  /** Cambia cuando se mueve o cancela una cita desde aquí, para recargar el día. */
  version: number;
  onAppt: (kind: 'move' | 'cancel', a: Appointment) => void;
  onClose: () => void; onDone: (m: string) => void;
}) {
  const { config } = useSession();
  const today = localISODate();
  const max = localISODate(new Date(), config?.bookingHorizonDays ?? 365);
  const [date, setDate] = useState(initialDate < today ? today : initialDate);
  const [day, setDay] = useState<{ slots: Slot[]; appts: Appointment[]; closures: Closure[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    const [slots, appts, closures] = await Promise.all([
      api.get<Slot[]>(`/admin/availability?date=${date}`),
      api.get<Appointment[]>(`/admin/appointments?from=${date}&to=${date}`),
      api.get<Closure[]>('/admin/closures'),
    ]);
    return { slots, appts: appts.filter((a) => a.status === 'CONFIRMED' || a.status === 'PENDING_PAYMENT'), closures };
  }, [date]);
  useEffect(() => {
    let alive = true;
    load().then((d) => { if (alive) setDay(d); }).catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [load, version]);

  const change = (d: string) => { if (d >= today && d <= max && d !== date) { setDate(d); setDay(null); setPicked([]); setError(null); } };
  const shift = (n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); change(d.toISOString().slice(0, 10)); };
  const toggle = (s: string) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  const cells = (day?.slots ?? []).filter((s) => s.reason !== 'PAST' && s.reason !== 'OUT_OF_RANGE')
    .map((s) => ({ ...s, appts: day!.appts.filter((a) => Date.parse(a.startAt) < Date.parse(s.end) && Date.parse(s.start) < Date.parse(a.endAt)), block: blockAt(day!.closures, s) }));
  const groups = [['Mañana', cells.filter((s) => Number(time(s.start).slice(0, 2)) < 14)], ['Tarde', cells.filter((s) => Number(time(s.start).slice(0, 2)) >= 14)]] as const;
  const busyAppts = day?.appts.filter((a) => cells.some((s) => s.appts.includes(a))) ?? [];

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/admin/blocks', { starts: picked, reason: reason.trim() || undefined });
      onDone(picked.length === 1 ? 'Hora bloqueada' : `${picked.length} horas bloqueadas`);
    } catch (e) { setError(e); setBusy(false); load().then(setDay).catch(() => {}); }
  };

  return (
    <Modal title="Bloquear horas" onClose={onClose}>
      <p className="muted small">Pulsa las horas que no vas a atender. Nadie podrá reservarlas y el motivo solo lo ves tú.</p>
      <ErrorAlert error={error} />
      <div className="slot-picker">
        <div className="date-nav">
          <button type="button" className="btn-icon" onClick={() => shift(-1)} disabled={date <= today} aria-label="Día anterior">‹</button>
          <input type="date" value={date} min={today} max={max} onChange={(e) => e.target.value && change(e.target.value)} />
          <button type="button" className="btn-icon" onClick={() => shift(1)} disabled={date >= max} aria-label="Día siguiente">›</button>
        </div>
        <p className="muted date-label">{dateLong(`${date}T12:00:00Z`)}</p>
        {!day && !error && <Spinner />}
        {day && cells.length === 0 && <p className="empty">No hay horas que bloquear este día.</p>}
        {groups.map(([label, l]) => l.length > 0 && (
          <div key={label}>
            <h4 className="slot-group">{label}</h4>
            <div className="slots">
              {l.map((s) => s.available && !s.appts.length
                ? <button type="button" key={s.start} aria-pressed={picked.includes(s.start)} className={`slot ${picked.includes(s.start) ? 'selected' : ''}`} onClick={() => toggle(s.start)}>{time(s.start)}</button>
                : <div key={s.start} className="slot booked"><span>{time(s.start)}</span><small>{s.appts.length ? s.appts.map((a) => a.client.name).join(', ') : s.block ? 'Bloqueada' : s.reason === 'CLOSED' ? 'Cerrado' : 'Ocupada'}</small></div>)}
            </div>
          </div>
        ))}
      </div>
      {busyAppts.length > 0 && (
        <>
          <h4 className="slot-group">Citas de ese día</h4>
          <p className="muted small">Para bloquear una hora con cita, antes muévela o cancélala.</p>
          <ul className="block-appts">
            {busyAppts.map((a) => (
              <li key={a.id}><span><strong>{time(a.startAt)}</strong> {a.client.name}</span>
                {new Date(a.endAt) > new Date() && (
                  <span className="actions">
                    <button type="button" className="btn btn-sm" onClick={() => onAppt('move', a)}>Cambiar hora</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => onAppt('cancel', a)}>Cancelar</button>
                  </span>
                )}</li>
            ))}
          </ul>
        </>
      )}
      <label>Motivo (opcional)<input value={reason} maxLength={300} placeholder="Trámite" onChange={(e) => setReason(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={!picked.length || busy} onClick={save}>{picked.length > 1 ? `Bloquear ${picked.length} horas` : 'Bloquear'}</button>
    </Modal>
  );
}
