import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { addDays, addMonths, contactLine, dateLong, dateShort, dateTime, isoToLocalDate, localISODate, money, monthLabel, startOfMonth, startOfWeek, statusLabel, time, waitPartLabel } from '../lib/format';
import { useSession } from '../lib/session';
import type { Appointment, Slot, WaitEntry, WaitPart } from '../lib/types';
import { CancelModal } from '../pages/admin/Agenda';
import { IconChevronLeft, IconChevronRight } from './icons';
import { RecurrencePlanner, type SeriesPlan } from './RecurrencePlanner';
import { Alert, ErrorAlert, Modal, OwnerLinks, Spinner, errMsg } from './ui';

interface CalDay { date: string; open: boolean; total: number; free: number }
const WEEK = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Ventana para que el administrador reserve a un cliente: calendario con huecos, horas del día y sus citas. */
interface Client { id: string; name: string; email: string | null; phone: string | null; status?: string; blockReason?: string | null }

export function BookForClient({ user, onClose, onDone, initialDate, onChanged }: {
  user: Client; onClose: () => void; onDone: (m: string) => void; initialDate?: string; onChanged?: () => void;
}) {
  const { config } = useSession();
  const today = localISODate();
  const last = localISODate(new Date(), config?.bookingHorizonDays ?? 365);
  const [month, setMonth] = useState(startOfMonth(initialDate ?? today));
  const [days, setDays] = useState<Map<string, CalDay> | null>(null);
  const [day, setDay] = useState('');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [mine, setMine] = useState<Appointment[] | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [start, setStart] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState('');
  const [flash, setFlash] = useState('');
  const [moving, setMoving] = useState<Appointment | null>(null); // cita que se está cambiando de hora
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [waits, setWaits] = useState<WaitEntry[]>([]);
  const [part, setPart] = useState<WaitPart>('ANY');

  // Sus citas: las próximas, y la última para proponer el mismo servicio.
  const loadMine = useCallback(() => {
    api.get<WaitEntry[]>(`/admin/waitlist?clientId=${user.id}`).then(setWaits).catch(() => {});
    return api.get<Appointment[]>(`/admin/appointments?clientId=${user.id}`).then((list) => {
      setMine(list);
      const active = config?.services ?? [];
      const prev = list.filter((a) => ['CONFIRMED', 'COMPLETED'].includes(a.status) && Date.parse(a.endAt) <= Date.now() && active.some((s) => s.id === a.service.id)).at(-1);
      setServiceId((cur) => cur || prev?.service.id || active[0]?.id || '');
    }).catch((e) => setLoadError(errMsg(e)));
  }, [user.id, config]);
  useEffect(() => { loadMine(); }, [loadMine]);

  // Día al que ir cuando cargue el mes (si es de otro mes).
  const target = useRef(initialDate ?? '');
  const goTo = (d: string) => {
    if (startOfMonth(d) === month) { setDay(d); return; }
    target.current = d;
    setMonth(startOfMonth(d));
  };

  const loadMonth = useCallback((m: string, pick: boolean) => {
    setDays(null);
    return api.get<CalDay[]>(`/admin/calendar?month=${m.slice(0, 7)}`).then((r) => {
      setDays(new Map(r.map((d) => [d.date, d])));
      // Al abrir (o cambiar de mes) se elige el primer día con huecos.
      if (pick && target.current) { setDay(target.current); target.current = ''; }
      else if (pick) setDay(r.find((d) => d.free > 0 && d.date.slice(0, 7) === m.slice(0, 7))?.date ?? '');
    }).catch((e) => setLoadError(errMsg(e)));
  }, []);
  useEffect(() => { loadMonth(month, true); }, [month, loadMonth]);

  const loadSlots = useCallback((d: string, exclude?: string) => api.get<Slot[]>(`/admin/availability?date=${d}${exclude ? `&excludeId=${exclude}` : ''}`), []);
  useEffect(() => {
    setStart(null); setRepeat(false); setPlan(null); setError(null); setPart('ANY');
    if (!day) { setSlots(null); return; }
    let live = true;
    setSlots(null);
    loadSlots(day, moving?.id).then((r) => live && setSlots(r)).catch((e) => live && setLoadError(errMsg(e)));
    return () => { live = false; };
  }, [day, moving?.id, loadSlots]);

  /** Tras mover, cancelar o apuntar en espera: se refresca todo sin cerrar la ventana. */
  const changed = (m: string) => {
    setFlash(m); setMoving(null); setCancelling(null); setStart(null); setBusy(false); setError(null);
    loadMine(); loadMonth(month, false); onChanged?.();
    if (day) loadSlots(day).then(setSlots).catch(() => {});
  };

  const now = Date.now();
  const upcoming = useMemo(() => (mine ?? []).filter((a) => ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status) && Date.parse(a.endAt) > now), [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastVisit = (mine ?? []).filter((a) => ['CONFIRMED', 'COMPLETED'].includes(a.status) && Date.parse(a.endAt) <= now).at(-1);
  const mineByDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    upcoming.forEach((a) => { const k = isoToLocalDate(a.startAt); m.set(k, [...(m.get(k) ?? []), a]); });
    return m;
  }, [upcoming]);
  const service = config?.services.find((s) => s.id === serviceId);
  const sameDay = (mineByDay.get(day) ?? []).filter((a) => a.id !== moving?.id);
  const near = day ? upcoming.filter((a) => a.id !== moving?.id).filter((a) => { const d = Math.abs(daysBetween(day, isoToLocalDate(a.startAt))); return d > 0 && d <= 6; }) : [];

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (moving) {
        await api.patch(`/admin/appointments/${moving.id}`, { startAt: start });
        changed(`Cita cambiada al ${dateTime(start!)}.${user.email ? ' Se ha avisado al cliente por email.' : ''}`);
      } else if (repeat && plan) {
        await api.post('/admin/appointments/series', { clientId: user.id, serviceId, intervalDays: plan.intervalDays, starts: plan.starts, paymentMethod: 'cash', notes: notes || undefined });
        onDone(`${plan.starts.length} citas reservadas para ${user.name}`);
      } else {
        await api.post('/admin/appointments', { clientId: user.id, serviceId, startAt: start, paymentMethod: 'cash', notes: notes || undefined });
        onDone(`Cita reservada para ${user.name}: ${dateTime(start!)}`);
      }
    } catch (e) {
      setError(e); setBusy(false);
      // Puede que la hora ya no esté libre: se refrescan los huecos.
      loadMonth(month, false);
      loadSlots(day, moving?.id).then(setSlots).catch(() => {});
    }
  };

  // Lista de espera: solo si no queda ninguna hora libre en esa parte del día.
  const isMorning = (s: Slot) => Number(time(s.start).slice(0, 2)) < 14;
  const fullParts = slots && slots.some((s) => s.reason === 'BOOKED')
    ? (['ANY', 'MORNING', 'AFTERNOON'] as const).filter((p) => {
        const l = slots.filter((s) => p === 'ANY' || (p === 'MORNING') === isMorning(s));
        return l.some((s) => s.reason === 'BOOKED') && !l.some((s) => s.available);
      })
    : [];
  const waiting = waits.find((w) => w.date === day);
  const join = async () => {
    setError(null);
    try {
      await api.post('/admin/waitlist', { clientId: user.id, date: day, part: fullParts.includes(part as never) ? part : fullParts[0] });
      changed(`${user.name} está en la lista de espera del ${dateShort(`${day}T12:00:00Z`)}.`);
    } catch (e) { setError(e); }
  };
  const leave = async (w: WaitEntry) => {
    try { await api.del(`/admin/waitlist/${w.id}`); changed('Quitado de la lista de espera.'); } catch (e) { setError(e); }
  };

  const first = startOfWeek(month);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i)).filter((d, i, all) => i < 35 || all[35].slice(0, 7) === month.slice(0, 7));
  const groups = ([['Mañana', (slots ?? []).filter((s) => Number(time(s.start).slice(0, 2)) < 14)], ['Tarde', (slots ?? []).filter((s) => Number(time(s.start).slice(0, 2)) >= 14)]] as const);

  return (
    <Modal title={`Reservar cita · ${user.name}`} onClose={onClose} size="xl">
      <p className="muted small book-who">{contactLine(user)}{lastVisit && <> · Última visita: {dateShort(lastVisit.startAt)}, {lastVisit.service.name}</>}</p>
      {user.status === 'BLOCKED' && <Alert kind="info">Este cliente está bloqueado{user.blockReason ? ` (${user.blockReason})` : ''}. Puedes reservarle igualmente.</Alert>}
      <Alert kind="ok">{flash}</Alert>
      <Alert>{loadError}</Alert>
      {moving && <Alert kind="info">Cambiando la cita del <strong>{dateShort(moving.startAt)} a las {time(moving.startAt)}</strong> ({moving.service.name}). Elige el nuevo día y la hora. <button type="button" className="link" onClick={() => setMoving(null)}>Dejarla como está</button></Alert>}
      <div className="book-grid">
        <section className="book-cal" aria-label="Calendario">
          <div className="book-nav">
            <button type="button" className="btn-icon" aria-label="Mes anterior" disabled={month <= startOfMonth(today)} onClick={() => setMonth(addMonths(month, -1))}><IconChevronLeft size={20} /></button>
            <strong>{monthLabel(month)}</strong>
            <button type="button" className="btn-icon" aria-label="Mes siguiente" disabled={startOfMonth(last) <= month} onClick={() => setMonth(addMonths(month, 1))}><IconChevronRight size={20} /></button>
          </div>
          <div className={`book-month ${days ? '' : 'is-loading'}`}>
            {WEEK.map((w) => <div key={w} className="mo-head">{w}</div>)}
            {cells.map((d) => {
              const c = days?.get(d);
              const own = mineByDay.get(d) ?? [];
              const off = d < today || d > last || d.slice(0, 7) !== month.slice(0, 7) || !c?.open;
              const text = d < today || d.slice(0, 7) !== month.slice(0, 7) || !c ? '' : !c.open ? 'Cerrado' : c.free ? `${c.free} libre${c.free === 1 ? '' : 's'}` : 'Completo';
              return (
                <button key={d} type="button" disabled={off && !own.length} onClick={() => goTo(d)} aria-pressed={d === day}
                  aria-label={`${dateLong(`${d}T12:00:00Z`)}${text && `, ${text}`}${own.length ? `, ya tiene cita a las ${own.map((a) => time(a.startAt)).join(' y ')}` : ''}`}
                  className={`book-day ${d.slice(0, 7) !== month.slice(0, 7) ? 'other' : ''} ${d === today ? 'is-today' : ''} ${d === day ? 'selected' : ''} ${c?.open && !c.free ? 'is-full' : ''}`}>
                  <b>{Number(d.slice(8))}</b>
                  {text && <span>{text}</span>}
                  {own.slice(0, 2).map((a) => <em key={a.id}>{time(a.startAt)}</em>)}{own.length > 2 && <em>+{own.length - 2}</em>}
                </button>
              );
            })}
          </div>
          <p className="legend small book-legend"><span><em>10:30</em> Ya tiene cita</span><span>Cada día indica cuántas horas libres quedan.</span></p>

          <h4 className="slot-group">Sus próximas citas {mine && `(${upcoming.length})`}</h4>
          {!mine ? <Spinner /> : upcoming.length === 0 ? <p className="muted small">No tiene ninguna.</p> : (
            <ul className="book-mine">
              {upcoming.map((a) => (
                <li key={a.id}><button type="button" className="link" onClick={() => goTo(isoToLocalDate(a.startAt))}>{dateShort(a.startAt)} · {time(a.startAt)}</button> <span className="muted small">{a.service.name}{a.status !== 'CONFIRMED' && ` · ${statusLabel[a.status]}`}{a.series && ` · cada ${a.series.intervalDays} días`}</span>
                  {a.status === 'CONFIRMED' && <span className="actions"><button type="button" className="btn btn-sm" aria-pressed={moving?.id === a.id} onClick={() => { setFlash(''); setMoving(a); goTo(isoToLocalDate(a.startAt)); }}>Cambiar</button><button type="button" className="btn btn-sm btn-danger" onClick={() => { setFlash(''); setCancelling(a); }}>Cancelar</button></span>}</li>
              ))}
            </ul>
          )}
          {waits.length > 0 && (
            <>
              <h4 className="slot-group">En lista de espera ({waits.length})</h4>
              <ul className="book-mine">
                {waits.map((w) => (
                  <li key={w.id}><button type="button" className="link" onClick={() => goTo(w.date)}>{dateShort(`${w.date}T12:00:00Z`)}</button> <span className="muted small">{waitPartLabel[w.part]}{w.free.length > 0 && ' · ¡hay hueco!'}</span>
                    <span className="actions"><button type="button" className="btn btn-sm" onClick={() => leave(w)}>Quitar</button></span></li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="book-form" aria-label="Nueva cita">
          {!moving && <label>Servicio
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {config?.services.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.priceCents)}</option>)}
            </select>
          </label>}
          {!day ? <p className="empty">{days ? 'No quedan días con huecos en este mes. Pasa al siguiente.' : 'Cargando huecos…'}</p> : (
            <>
              <h3 className="book-day-title">{dateLong(`${day}T12:00:00Z`)}</h3>
              {sameDay.length > 0 && <Alert kind="info">Ese día ya tiene cita a las {sameDay.map((a) => time(a.startAt)).join(' y ')}.</Alert>}
              {sameDay.length === 0 && near.length > 0 && <p className="book-near">Tiene otra cita cerca: {near.slice(0, 3).map((a) => `${dateShort(a.startAt)} ${time(a.startAt)}`).join(', ')}.</p>}
              {!slots ? <Spinner /> : slots.length === 0 ? <p className="empty">Cerrado este día.</p> : groups.map(([label, list]) => list.length > 0 && (
                <div key={label}>
                  <h4 className="slot-group">{label}</h4>
                  <div className="slots">
                    {list.map((s) => {
                      const own = s.bookedBy?.some((o) => o.clientId === user.id) || sameDay.some((a) => a.id !== moving?.id && a.startAt < s.end && s.start < a.endAt);
                      if (own) return <div key={s.start} className="slot booked is-own"><span>{time(s.start)}</span><small>Su cita</small></div>;
                      if (s.available) return <button type="button" key={s.start} className={`slot ${start === s.start ? 'selected' : ''}`} aria-pressed={start === s.start} onClick={() => setStart(s.start)}>{time(s.start)}</button>;
                      return <div key={s.start} className="slot booked"><span>{time(s.start)}</span><small>{s.bookedBy?.length ? <OwnerLinks owners={s.bookedBy} /> : s.reason === 'PAST' ? 'Pasada' : s.reason === 'CLOSED' ? 'Cerrado' : 'Ocupada'}</small></div>;
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
          {day && !moving && sameDay.length === 0 && fullParts.length > 0 && (
            <div className="book-wait">
              {waiting ? <p>Está en la lista de espera de este día ({waitPartLabel[waiting.part]}).</p> : (
                <>
                  <p>{fullParts[0] === 'ANY' ? 'Este día está completo.' : fullParts[0] === 'MORNING' ? 'La mañana está completa.' : 'La tarde está completa.'} Puedes apuntarle en la lista de espera.</p>
                  <div className="actions">
                    {fullParts.length > 1 && <select aria-label="Parte del día" value={fullParts.includes(part as never) ? part : fullParts[0]} onChange={(e) => setPart(e.target.value as WaitPart)}>{fullParts.map((p) => <option key={p} value={p}>{p === 'ANY' ? 'Cualquier hora' : p === 'MORNING' ? 'Por la mañana' : 'Por la tarde'}</option>)}</select>}
                    <button type="button" className="btn btn-sm" onClick={join}>Apuntar en lista de espera</button>
                  </div>
                </>
              )}
            </div>
          )}
          {start && !moving && (
            <>
              <label className="check"><input type="checkbox" checked={repeat} onChange={(e) => { setRepeat(e.target.checked); setPlan(null); }} /> Repetir periódicamente</label>
              {repeat && service && <RecurrencePlanner admin firstStart={start} priceCents={service.priceCents} onChange={setPlan} />}
            </>
          )}
          {!moving && <label>Notas<input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></label>}
          <ErrorAlert error={error} />
          <p className="muted small">{moving ? 'El pago y el ticket se mantienen.' : 'Se paga en el local.'}{moving ? (user.email ? ' Se avisa al cliente por email.' : '') : user.email ? ' El cliente recibirá un email de confirmación.' : ' No tiene email: no se le enviará confirmación.'}</p>
          <button type="button" className="btn btn-primary btn-lg book-save" disabled={!start || (!moving && !serviceId) || busy || (repeat && !plan)} onClick={save}>
            {busy ? (moving ? 'Cambiando…' : 'Reservando…') : !start ? 'Elige una hora' : moving ? `Cambiar a ${dateShort(start)}, ${time(start)}` : repeat && plan ? `Reservar ${plan.starts.length} citas` : `Reservar ${dateShort(start)} a las ${time(start)}`}
          </button>
        </section>
      </div>
      {cancelling && <CancelModal appt={cancelling} onClose={() => setCancelling(null)} onDone={changed} />}
    </Modal>
  );
}
