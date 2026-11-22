import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { RecurrencePlanner, type SeriesPlan } from '../../components/RecurrencePlanner';
import { SlotPicker } from '../../components/SlotPicker';
import { TicketButton } from '../../components/TicketButton';
import { Link } from 'react-router-dom';
import { Alert, Badge, ErrorAlert, Modal, Spinner, errMsg } from '../../components/ui';
import { canIssueTicket, cashPayment, onlinePayment, paymentInfo, ticketOf } from '../../lib/payment';
import { api } from '../../lib/api';
import { addDays, addMonths, dateLong, dateShort, isoToLocalDate, isoWeekday, localISODate, methodLabel, money, monthLabel, startOfMonth, startOfWeek, statusLabel, time, weekLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Appointment, Closure, Payment, PublicConfig, User } from '../../lib/types';
import { IconChevronLeft, IconChevronRight, IconRepeat, IconTicket } from '../../components/icons';
const waUrl = (phone: string | null, text: string) => {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 9) d = `34${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
};

type View = 'list' | 'week' | 'month';
type ModalState = { kind: 'new' | 'move' | 'cancel' | 'refund' | 'cash' | 'detail'; appt?: Appointment; payment?: Payment };
const VIEW_KEY = 'pa_agenda_view';
const readView = (): View => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'week' || v === 'month' ? v : 'list'; } catch { return 'list'; } };

export function Agenda() {
  const { config } = useSession();
  const [view, setViewState] = useState<View>(readView);
  const [from, setFrom] = useState(localISODate());
  const [to, setTo] = useState(localISODate());
  const [anchor, setAnchor] = useState(localISODate()); // día de referencia de las vistas semana y mes
  const [selectedDay, setSelectedDay] = useState(localISODate());
  const [status, setStatus] = useState('');
  const [list, setList] = useState<Appointment[] | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null);

  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* sin almacenamiento */ } };

  // Rango que se pide al servidor según la vista
  const range = useMemo(() => {
    if (view === 'week') { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 6) }; }
    if (view === 'month') { const s = startOfWeek(startOfMonth(anchor)); return { from: s, to: addDays(s, 41) }; }
    return { from, to };
  }, [view, anchor, from, to]);

  // soft: recarga sin vaciar la vista (tras una acción, para no perder la posición)
  const load = useCallback((soft = false) => {
    if (!soft) setList(null);
    const q = new URLSearchParams({ from: range.from, to: range.to, ...(status && { status }) });
    api.get<Appointment[]>(`/admin/appointments?${q}`).then(setList).catch((e) => setError(e.message));
  }, [range.from, range.to, status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<Closure[]>('/admin/closures').then(setClosures).catch(() => {}); }, []);

  const done = (msg: string) => { setModal(null); setFlash(msg); load(true); };
  const act: CardActions = {
    open: (kind, a, payment) => setModal({ kind, appt: a, payment }),
    setStatus: async (a, s) => {
      try { await api.patch(`/admin/appointments/${a.id}`, { status: s }); done(`Marcada como "${statusLabel[s]}"`); } catch (e) { setError(errMsg(e)); }
    },
    undoCash: async (a) => {
      try { await api.post(`/admin/appointments/${a.id}/unmark-paid`); done('Cobro deshecho'); } catch (e) { setError(errMsg(e)); }
    },
    issueTicket: async (a) => {
      try {
        const r = await api.post<Appointment>(`/admin/appointments/${a.id}/ticket`);
        done(`Ticket ${ticketOf(r)?.number} generado para ${a.client.name}`);
      } catch (e) { setError(errMsg(e)); }
    },
  };
  const quick = (days: number) => { const d = localISODate(new Date(), days); setFrom(d); setTo(d); };

  // En semana y mes las canceladas solo se ven si se filtran expresamente.
  const shown = (list ?? []).filter((a) => view === 'list' || status === 'CANCELLED' || a.status !== 'CANCELLED');
  const byDay = new Map<string, Appointment[]>();
  shown.forEach((a) => { const k = isoToLocalDate(a.startAt); byDay.set(k, [...(byDay.get(k) ?? []), a]); });

  const step = (dir: 1 | -1) => setAnchor(view === 'week' ? addDays(anchor, 7 * dir) : addMonths(anchor, dir));
  const goToday = () => { setAnchor(localISODate()); setSelectedDay(localISODate()); };
  const title = view === 'week' ? weekLabel(startOfWeek(anchor)) : monthLabel(anchor);

  return (
    <div>
      <div className="page-head">
        <h1>Agenda</h1>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>Nueva cita</button>
      </div>

      <div className="agenda-toolbar">
        <div className="segmented" role="tablist" aria-label="Vista de la agenda">
          {([['list', 'Lista'], ['week', 'Semana'], ['month', 'Mes']] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
        {view !== 'list' && (
          <div className="cal-nav">
            <button className="btn-icon" aria-label={view === 'week' ? 'Semana anterior' : 'Mes anterior'} onClick={() => step(-1)}><IconChevronLeft size={20} /></button>
            <strong className="cal-title">{title}</strong>
            <button className="btn-icon" aria-label={view === 'week' ? 'Semana siguiente' : 'Mes siguiente'} onClick={() => step(1)}><IconChevronRight size={20} /></button>
            <button className="btn btn-sm" onClick={goToday}>Hoy</button>
          </div>
        )}
        <label className="inline">Estado
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>

      {view === 'list' && (
        <div className="filters">
          <button className="btn btn-sm" onClick={() => quick(0)}>Hoy</button>
          <button className="btn btn-sm" onClick={() => quick(1)}>Mañana</button>
          <button className="btn btn-sm" onClick={() => { setFrom(localISODate()); setTo(localISODate(new Date(), 7)); }}>7 días</button>
          <label>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}

      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {!list && <Spinner />}

      {list && view === 'list' && (
        <>
          {shown.length === 0 && <p className="empty">No hay citas en este periodo.</p>}
          {[...byDay.entries()].map(([day, appts]) => <DayList key={day} day={day} appts={appts} act={act} />)}
        </>
      )}

      {list && view === 'week' && config && (
        <WeekView start={startOfWeek(anchor)} byDay={byDay} config={config} closures={closures} onOpen={(a) => setModal({ kind: 'detail', appt: a })} />
      )}

      {list && view === 'month' && config && (
        <>
          <MonthView anchor={anchor} byDay={byDay} config={config} closures={closures} selected={selectedDay}
            onSelect={(d) => { setSelectedDay(d); if (d.slice(0, 7) !== anchor.slice(0, 7)) setAnchor(d); }} />
          <p className="legend small mo-legend">
            <span><span className="mo-unpaid static">2</span> Citas pendientes de cobro</span>
            <span><i className="swatch swatch-closed" /> Cerrado</span>
            <span className="muted">Pulsa un día para ver sus citas.</span>
          </p>
          <div id="dia-seleccionado">
            {(byDay.get(selectedDay)?.length ?? 0) > 0
              ? <DayList day={selectedDay} appts={byDay.get(selectedDay)!} act={act} />
              : <><h2 className="day-title">{dateLong(`${selectedDay}T12:00:00Z`)}</h2><p className="empty">No hay citas este día.</p></>}
          </div>
        </>
      )}

      {modal?.kind === 'detail' && (
        <Modal title={`Cita de ${modal.appt!.client.name}`} onClose={() => setModal(null)}>
          <p className="muted">{dateLong(modal.appt!.startAt)}</p>
          <AppointmentCard a={modal.appt!} act={act} />
        </Modal>
      )}
      {modal?.kind === 'new' && <NewAppointmentModal onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'move' && <MoveModal appt={modal.appt!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'cancel' && <CancelModal appt={modal.appt!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'refund' && <RefundModal payment={modal.payment!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'cash' && <CashModal appt={modal.appt!} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

// ================================================================ Tarjeta de cita

interface CardActions {
  open: (kind: 'move' | 'cancel' | 'refund' | 'cash', a: Appointment, payment?: Payment) => void;
  setStatus: (a: Appointment, s: string) => void;
  undoCash: (a: Appointment) => void;
  issueTicket: (a: Appointment) => void;
}

function DayList({ day, appts, act }: { day: string; appts: Appointment[]; act: CardActions }) {
  return (
    <section>
      <h2 className="day-title">{dateLong(`${day}T12:00:00Z`)} <small className="muted">({appts.filter((a) => a.status === 'CONFIRMED').length} confirmadas)</small></h2>
      <div className="agenda">{appts.map((a) => <AppointmentCard key={a.id} a={a} act={act} />)}</div>
    </section>
  );
}

function AppointmentCard({ a, act }: { a: Appointment; act: CardActions }) {
  const paid = onlinePayment(a);
  const pay = paymentInfo(a);
  const ticket = ticketOf(a);
  const active = ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status);
  const wa = waUrl(a.client.phone, `Hola ${a.client.name}, te escribimos de la peluquería por tu cita del ${dateShort(a.startAt)} a las ${time(a.startAt)}.`);
  return (
    <article className={`card agenda-item ${a.status === 'CANCELLED' ? 'dim' : ''}`}>
      <div className="agenda-time">{time(a.startAt)}<small>{time(a.endAt)}</small></div>
      <div className="agenda-main">
        <Link to={`/admin/usuarios/${a.client.id}`}><strong>{a.client.name}</strong></Link> <span className="muted small">{a.client.phone} · {a.client.email}</span>
        <div>{a.service.name} · {money(a.priceCents)} · {methodLabel(a.paymentMethod)} · <span className={`pay pay-${pay.kind}`}>{pay.label}</span></div>
        {a.notes && <div className="muted small">Nota: {a.notes}</div>}
        {a.cancelReason && <div className="muted small">Motivo: {a.cancelReason} ({a.cancelledBy === 'CLIENT' ? 'cliente' : 'peluquería'})</div>}
        <Badge status={a.status}>{statusLabel[a.status]}</Badge>
        {a.series && <span className="series-badge"><IconRepeat size={14} /> cada {a.series.intervalDays} días</span>}
      </div>
      <div className="actions">
        {active && <button className="btn btn-sm" onClick={() => act.open('move', a)}>Cambiar hora</button>}
        {a.status === 'CONFIRMED' && new Date(a.startAt) < new Date() && (
          <>
            <button className="btn btn-sm" onClick={() => act.setStatus(a, 'COMPLETED')}>Realizada</button>
            <button className="btn btn-sm" onClick={() => act.setStatus(a, 'NO_SHOW')}>No vino</button>
          </>
        )}
        {a.paymentMethod === 'cash' && a.status !== 'CANCELLED' && !cashPayment(a) && (
          <button className="btn btn-sm" onClick={() => act.open('cash', a)}>Marcar cobrada</button>
        )}
        {cashPayment(a) && !ticket && <button className="btn btn-sm" onClick={() => act.undoCash(a)}>Deshacer cobro</button>}
        {ticket ? <TicketButton ticket={ticket} /> : canIssueTicket(a) && (
          <button className="btn btn-sm btn-ticket" onClick={() => act.issueTicket(a)}><IconTicket size={16} /> Generar ticket</button>
        )}
        {paid && paid.refundedCents < paid.amountCents && (
          <button className="btn btn-sm" onClick={() => act.open('refund', a, paid)}>Reembolsar</button>
        )}
        {active && <button className="btn btn-sm btn-danger" onClick={() => act.open('cancel', a)}>Cancelar</button>}
        {wa && <a className="btn btn-sm btn-wa" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
      </div>
    </article>
  );
}

// ================================================================ Vista semanal

const WEEKDAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** ¿Está la hora local `day hh:mm` dentro de algún cierre? */
const inClosure = (closures: Closure[], day: string, hhmm: string) => {
  const k = `${day} ${hhmm}`;
  return closures.some((c) => `${isoToLocalDate(c.startAt)} ${time(c.startAt)}` <= k && k < `${isoToLocalDate(c.endAt)} ${time(c.endAt)}`);
};
const dayClosed = (closures: Closure[], day: string) =>
  closures.some((c) => isoToLocalDate(c.startAt) <= day && day <= isoToLocalDate(c.endAt));

function WeekView({ start, byDay, config, closures, onOpen }: {
  start: string; byDay: Map<string, Appointment[]>; config: PublicConfig; closures: Closure[]; onOpen: (a: Appointment) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const step = config.slotMinutes;
  const isOpen = (day: string, hhmm: string) =>
    (config.weeklySchedule[String(isoWeekday(day))] ?? []).some((r) => r.start <= hhmm && hhmm < r.end) && !inClosure(closures, day, hhmm);

  // Filas: todas las franjas del horario semanal más las horas de citas que no encajen (p. ej. si cambió la duración).
  const rows = new Set<number>();
  Object.values(config.weeklySchedule).flat().forEach((r) => { for (let m = toMin(r.start); m + step <= toMin(r.end); m += step) rows.add(m); });
  const cell = new Map<string, Appointment[]>();
  days.forEach((d) => (byDay.get(d) ?? []).forEach((a) => {
    const m = toMin(time(a.startAt));
    rows.add(m);
    const k = `${d} ${toHHMM(m)}`;
    cell.set(k, [...(cell.get(k) ?? []), a]);
  }));
  const sorted = [...rows].sort((a, b) => a - b);
  const today = localISODate();

  if (!sorted.length) return <p className="empty">No hay horario configurado.</p>;
  return (
    <div className="week-scroll">
      <div className="week-grid" style={{ gridTemplateColumns: `64px repeat(7, minmax(110px, 1fr))` }}>
        <div className="wk-corner" />
        {days.map((d, i) => (
          <div key={d} className={`wk-head ${d === today ? 'is-today' : ''}`}>
            <span>{WEEKDAYS_SHORT[i]}</span><strong>{Number(d.slice(8))}</strong>
            <small>{(byDay.get(d) ?? []).length || ''}</small>
          </div>
        ))}
        {sorted.map((m, ri) => {
          const hhmm = toHHMM(m);
          const gap = ri > 0 && m - sorted[ri - 1] > step;
          return (
            <Fragment key={m}>
              <div className={`wk-time ${gap ? 'gap' : ''}`}>{hhmm}</div>
              {days.map((d) => {
                const appts = cell.get(`${d} ${hhmm}`) ?? [];
                return (
                  <div key={d} className={`wk-cell ${isOpen(d, hhmm) ? '' : 'closed'} ${gap ? 'gap' : ''} ${d === today ? 'is-today' : ''}`}>
                    {appts.map((a) => {
                      const pay = paymentInfo(a);
                      return (
                        <button key={a.id} type="button" className={`cal-appt st-${a.status} pay-${pay.kind}`} onClick={() => onOpen(a)}
                          title={`${time(a.startAt)}–${time(a.endAt)} · ${a.client.name} · ${a.service.name} · ${pay.label}`}>
                          <strong>{a.client.name}</strong>
                          <span>{a.service.name}</span>
                          <i className="pay-dot" aria-label={pay.label} />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>
      <p className="legend small">
        <span><i className="pay-dot pay-paid" /> Pagada</span>
        <span><i className="pay-dot pay-unpaid" /> Pendiente de cobro</span>
        <span><i className="swatch swatch-closed" /> Cerrado</span>
        <span className="muted">Pulsa una cita para ver sus opciones.</span>
      </p>
    </div>
  );
}

// ================================================================ Vista mensual

function MonthView({ anchor, byDay, config, closures, selected, onSelect }: {
  anchor: string; byDay: Map<string, Appointment[]>; config: PublicConfig; closures: Closure[]; selected: string; onSelect: (d: string) => void;
}) {
  const gridStart = startOfWeek(startOfMonth(anchor));
  const month = anchor.slice(0, 7);
  const today = localISODate();
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return (
    <div className="month-grid" role="grid" aria-label={monthLabel(anchor)}>
      {WEEKDAYS_SHORT.map((w) => <div key={w} className="mo-head">{w}</div>)}
      {days.map((d) => {
        const appts = byDay.get(d) ?? [];
        const closed = !(config.weeklySchedule[String(isoWeekday(d))] ?? []).length || dayClosed(closures, d);
        const unpaid = appts.filter((a) => paymentInfo(a).kind === 'unpaid' && a.status !== 'CANCELLED').length;
        return (
          <button key={d} type="button" role="gridcell" aria-selected={d === selected}
            className={`mo-day ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'is-today' : ''} ${d === selected ? 'selected' : ''} ${closed ? 'closed' : ''}`}
            onClick={() => { onSelect(d); setTimeout(() => document.getElementById('dia-seleccionado')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>
            <span className="mo-num">{Number(d.slice(8))}</span>
            {appts.length > 0 && (
              <>
                <span className="mo-count">{appts.length} {appts.length === 1 ? 'cita' : 'citas'}</span>
                <ul className="mo-list">
                  {appts.slice(0, 3).map((a) => <li key={a.id} className={`st-${a.status}`}>{time(a.startAt)} {a.client.name}</li>)}
                  {appts.length > 3 && <li className="muted">+{appts.length - 3} más</li>}
                </ul>
                {unpaid > 0 && <span className="mo-unpaid" title={`${unpaid} sin cobrar`}>{unpaid}</span>}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ================================================================ Cobro en efectivo

export function CashModal({ appt, onClose, onDone }: { appt: Appointment; onClose: () => void; onDone: (m: string) => void }) {
  const [ticket, setTicket] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Cobrar en el local" onClose={onClose}>
      <p><strong>{appt.client.name}</strong> — {appt.service.name}, {dateShort(appt.startAt)} {time(appt.startAt)}</p>
      <p className="total">{money(appt.priceCents)} en efectivo</p>
      <Alert>{error}</Alert>
      <label className="check"><input type="checkbox" checked={ticket} onChange={(e) => setTicket(e.target.checked)} /> Generar ticket de compra</label>
      <p className="muted small">El ticket recibe el siguiente número de la serie del año y el cliente lo podrá descargar desde sus citas. Una vez emitido, el cobro ya no se puede deshacer.</p>
      <button className="btn btn-primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<Appointment>(`/admin/appointments/${appt.id}/mark-paid`, { ticket });
          const t = ticketOf(r);
          onDone(`Cita de ${appt.client.name} cobrada${t ? ` · ticket ${t.number} generado` : ''}.`);
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{ticket ? 'Cobrar y generar ticket' : 'Marcar como cobrada'}</button>
    </Modal>
  );
}

function NewAppointmentModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { config } = useSession();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [client, setClient] = useState<User | null>(null);
  const [serviceId, setServiceId] = useState(config?.services[0]?.id ?? '');
  const [start, setStart] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const service = config?.services.find((s) => s.id === serviceId);

  useEffect(() => {
    const t = setTimeout(() => api.get<User[]>(`/admin/users?status=ACTIVE&role=CLIENT&q=${encodeURIComponent(q)}`).then(setUsers).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);

  const save = async () => {
    try {
      if (repeat && plan) {
        await api.post('/admin/appointments/series', { clientId: client!.id, serviceId, intervalDays: plan.intervalDays, starts: plan.starts, paymentMethod: 'cash', notes: notes || undefined });
        onDone(`${plan.starts.length} citas creadas para ${client!.name}`);
      } else {
        await api.post('/admin/appointments', { clientId: client!.id, serviceId, startAt: start, paymentMethod: 'cash', notes: notes || undefined });
        onDone(`Cita creada para ${client!.name}`);
      }
    } catch (e) { setError(e); }
  };

  return (
    <Modal title="Nueva cita" onClose={onClose}>
      <ErrorAlert error={error} />
      {!client ? (
        <>
          <label>Buscar cliente<input autoFocus placeholder="Nombre, email o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <ul className="pick-list">
            {users.map((u) => <li key={u.id}><button className="link" onClick={() => setClient(u)}>{u.name} <small className="muted">{u.phone} · {u.email}</small></button></li>)}
          </ul>
          <p className="muted small">¿No existe? Créalo antes en Usuarios.</p>
        </>
      ) : (
        <>
          <p>Cliente: <strong>{client.name}</strong> <button className="link" onClick={() => setClient(null)}>cambiar</button></p>
          <label>Servicio
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {config?.services.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.priceCents)}</option>)}
            </select>
          </label>
          <SlotPicker admin value={start} onPick={setStart} />
          {start && (
            <label className="check"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repetir periódicamente</label>
          )}
          {start && repeat && service && <RecurrencePlanner admin firstStart={start} priceCents={service.priceCents} onChange={setPlan} />}
          <label>Notas<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <p className="muted small">Las citas creadas desde el panel se pagan en el local.</p>
          <button className="btn btn-primary" disabled={!start || (repeat && !plan)} onClick={save}>
            {repeat && plan ? `Crear ${plan.starts.length} citas` : 'Crear cita'}
          </button>
        </>
      )}
    </Modal>
  );
}

function MoveModal({ appt, onClose, onDone }: { appt: Appointment; onClose: () => void; onDone: (m: string) => void }) {
  const [start, setStart] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title={`Cambiar cita de ${appt.client.name}`} onClose={onClose}>
      <ErrorAlert error={error} />
      <SlotPicker admin value={start} onPick={setStart} excludeId={appt.id} initialDate={isoToLocalDate(appt.startAt)} />
      <button className="btn btn-primary" disabled={!start} onClick={async () => {
        try { await api.patch(`/admin/appointments/${appt.id}`, { startAt: start }); onDone('Cita movida. Se ha avisado al cliente por email.'); } catch (e) { setError(e); }
      }}>Guardar</button>
    </Modal>
  );
}

function CancelModal({ appt, onClose, onDone }: { appt: Appointment; onClose: () => void; onDone: (m: string) => void }) {
  const paid = onlinePayment(appt);
  const cash = cashPayment(appt);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(true);
  const [notify, setNotify] = useState(true);
  const [wholeSeries, setWholeSeries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Cancelar cita" onClose={onClose}>
      <p>{appt.client.name} — {dateShort(appt.startAt)} {time(appt.startAt)}</p>
      <Alert>{error}</Alert>
      <label>Motivo (se incluye en el email)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {paid && <label className="check"><input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} /> Reembolsar {money(paid.amountCents - paid.refundedCents)} por {methodLabel(paid.provider)}</label>}
      {cash && <p className="muted small">Esta cita se cobró en el local ({money(cash.amountCents)}): si hay que devolverlo, hazlo en mano.</p>}
      <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Avisar al cliente por email</label>
      {appt.series && (
        <label className="check"><input type="checkbox" checked={wholeSeries} onChange={(e) => setWholeSeries(e.target.checked)} /> Cancelar también las siguientes citas de esta serie (cada {appt.series.intervalDays} días)</label>
      )}
      <button className="btn btn-danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const body = { reason: reason || undefined, refund, notify };
          if (wholeSeries && appt.series) {
            const r = await api.post<{ cancelled: number; refundedCents: number }>(`/admin/series/${appt.series.id}/cancel`, { ...body, fromAppointmentId: appt.id });
            onDone(`${r.cancelled} cita(s) cancelada(s)${r.refundedCents ? ` y ${money(r.refundedCents)} reembolsados` : ''}.`);
          } else {
            const r = await api.post<{ refundedCents: number }>(`/admin/appointments/${appt.id}/cancel`, body);
            onDone(`Cita cancelada${r.refundedCents ? ` y ${money(r.refundedCents)} reembolsados` : ''}.`);
          }
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{wholeSeries ? 'Cancelar esta y las siguientes' : 'Cancelar cita'}</button>
    </Modal>
  );
}

function RefundModal({ payment, onClose, onDone }: { payment: Payment; onClose: () => void; onDone: (m: string) => void }) {
  const max = payment.amountCents - payment.refundedCents;
  const [amount, setAmount] = useState((max / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title="Reembolso" onClose={onClose}>
      <p>Pagado: {money(payment.amountCents)} · Ya reembolsado: {money(payment.refundedCents)}</p>
      <Alert>{error}</Alert>
      <label>Importe a devolver (máx. {money(max)})<input type="number" step="0.01" min="0.01" max={max / 100} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>Nota para el cliente<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <p className="muted small">El reembolso no cancela la cita.</p>
      <button className="btn btn-primary" onClick={async () => {
        try {
          await api.post(`/admin/payments/${payment.id}/refund`, { amountCents: Math.round(Number(amount) * 100), reason: reason || undefined });
          onDone(`Reembolsados ${money(Math.round(Number(amount) * 100))}`);
        } catch (e) { setError(errMsg(e)); }
      }}>Reembolsar</button>
    </Modal>
  );
}
