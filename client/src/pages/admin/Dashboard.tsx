import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookForClient } from '../../components/BookForClient';
import { EmailReminderButton } from '../../components/EmailReminderButton';
import { Alert, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateLong, dateShort, money, time, waitPartLabel, weekdayNames } from '../../lib/format';
import type { Appointment, WaitEntry } from '../../lib/types';
import { CashModal, NewAppointmentModal } from './Agenda';

interface Brief {
  id: string; startAt: string; endAt: string; status: string; priceCents: number; paymentMethod: string; paid: boolean; service: string; attendance: 'YES' | 'NO' | null;
  client: { id: string; name: string; email: string | null; phone: string | null };
}
interface Cell { start: string; end: string; state: 'booked' | 'free' | 'past' | 'closed'; bookable: boolean; appts: Brief[] }
interface Data {
  now: string; today: string;
  next: (Brief & { isToday: boolean; whatsappLink: string | null }) | null;
  agenda: Cell[];
  figures: { done: number; pending: number; free: number; collectedCents: number; toCollectCents: number; monthCashCents: number; monthOnlineCents: number; clients: number; upcoming: number };
  todo: {
    unpaid: { count: number; totalCents: number; items: Brief[] };
    declined: (Brief & { by: string | null })[];
    unconfirmed: (Brief & { noReminder: boolean; whatsappLink: string | null })[];
    failedReminders: { id: string; channel: string; reason: string; detail: string | null; whatsappLink: string | null; startAt: string; client: { id: string; name: string; phone: string | null } }[];
    imports: number; warnings: string[];
  };
  waitlist: WaitEntry[];
  /** Hoy y los 6 días siguientes. cancelledBy = hueco que viene de una cancelación. */
  week: { date: string; open: boolean; gaps: { start: string; cancelledBy: string | null }[] }[];
}

export function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [newAt, setNewAt] = useState<string | null>(null);
  const [give, setGive] = useState<WaitEntry | null>(null);
  const load = useCallback(() => api.get<Data>('/admin/dashboard').then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message)), []);
  // Se refresca cada minuto: cambian la próxima cita y las horas libres.
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const done = (m: string) => { setNewAt(null); setFlash(m); load(); };

  if (!d) return error ? <Alert>{error}</Alert> : <Spinner />;
  const f = d.figures;
  return (
    <div className="dash">
      <div className="page-head">
        <h1>Resumen</h1>
        <p className="muted dash-date">{dateLong(`${d.today}T12:00:00Z`)}</p>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>

      <div className="dash-top">
        <NextCard next={d.next} now={d.now} />
        <div className="stats dash-stats">
          <div className="stat"><strong>{f.done}<small> de {f.done + f.pending}</small></strong><span>Citas hechas hoy</span></div>
          <div className="stat"><strong>{f.free}</strong><span>Huecos libres hoy</span></div>
          <div className="stat"><strong>{money(f.collectedCents)}</strong><span>Cobrado hoy</span></div>
          <div className="stat"><strong>{money(f.toCollectCents)}</strong><span>Por cobrar hoy</span></div>
        </div>
      </div>

      <section className="card">
        <div className="dash-head"><h2>El día de un vistazo</h2><Link to="/admin/agenda" className="small">Ver la agenda</Link></div>
        {d.agenda.length === 0 ? <p className="empty">Hoy la peluquería está cerrada y no hay citas.</p> : <DayStrip cells={d.agenda} now={d.now} onFree={setNewAt} />}
      </section>

      <Todo todo={d.todo} week={d.week} today={d.today} onChange={done} onGive={setNewAt} />
      <Waitlist list={d.waitlist} onGive={setGive} onChange={done} />
      <Business figures={f} />

      {give && <BookForClient user={give.client} initialDate={give.date} onChanged={load} onClose={() => setGive(null)} onDone={(m) => { setGive(null); done(m); }} />}
      {newAt && <NewAppointmentModal initialStart={newAt} onClose={() => setNewAt(null)} onDone={done} />}
    </div>
  );
}

// ---------------------------------------------------------------- Hoy

const inText = (iso: string, now: string) => {
  const min = Math.max(0, Math.round((Date.parse(iso) - Date.parse(now)) / 60_000));
  return min < 1 ? 'ahora' : min < 60 ? `dentro de ${min} min` : `dentro de ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
};

function NextCard({ next, now }: { next: Data['next']; now: string }) {
  if (!next) return <section className="card dash-next"><span className="dash-kicker">Próxima cita</span><p className="empty">No hay citas próximas.</p></section>;
  return (
    <section className="card dash-next">
      <span className="dash-kicker">Próxima cita · {next.isToday ? inText(next.startAt, now) : dateShort(next.startAt)}</span>
      <p className="dash-next-time">{time(next.startAt)}</p>
      <p className="dash-next-who"><Link to={`/admin/usuarios/${next.client.id}`}><strong>{next.client.name}</strong></Link><br />
        <span className="muted">{next.service} · {money(next.priceCents)} · {next.paid ? 'pagada' : 'pendiente de cobro'} · {next.attendance === 'YES' ? 'asistencia confirmada' : next.attendance === 'NO' ? 'ha dicho que no puede venir' : 'sin confirmar'}</span></p>
      <div className="actions">
        {next.whatsappLink && <a className="btn btn-sm btn-wa" href={next.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}
        <EmailReminderButton appointmentId={next.id} disabledReason={next.client.email ? undefined : 'El cliente no tiene email'} />
      </div>
    </section>
  );
}

function DayStrip({ cells, now, onFree }: { cells: Cell[]; now: string; onFree: (start: string) => void }) {
  const groups = ([['Mañana', cells.filter((c) => Number(time(c.start).slice(0, 2)) < 14)], ['Tarde', cells.filter((c) => Number(time(c.start).slice(0, 2)) >= 14)]] as const).filter(([, l]) => l.length);
  return (
    <>
      {groups.map(([label, list]) => (
        <div key={label}>
          <h3 className="dash-part">{label}</h3>
          <div className="day-strip">
            {list.map((c) => {
              const current = c.start <= now && now < c.end;
              const cls = `day-cell is-${c.state}${c.end <= now ? ' is-over' : ''}${current ? ' is-now' : ''}`;
              if (c.bookable) return <button key={c.start} type="button" className={cls} onClick={() => onFree(c.start)} aria-label={`Hueco libre a las ${time(c.start)}: crear cita`}><b>{time(c.start)}</b><span>{c.appts.length ? c.appts.map((a) => a.client.name).join(', ') : 'Libre'}</span><i aria-hidden>+</i></button>;
              return (
                <div key={c.start + (c.appts[0]?.id ?? '')} className={cls}>
                  <b>{time(c.start)}</b>
                  {c.appts.length ? c.appts.map((a) => (
                    <span key={a.id} title={`${a.client.name} · ${a.service}`}><Link to={`/admin/usuarios/${a.client.id}`}>{a.client.name}</Link><small>{a.status === 'NO_SHOW' ? 'No vino' : a.attendance === 'NO' ? 'No asistirá' : `${a.attendance === 'YES' ? '✓ ' : ''}${a.paid ? 'Pagada' : a.service}`}</small></span>
                  )) : <span>{c.state === 'closed' ? 'Cerrado' : c.state === 'booked' ? 'Ocupada' : '—'}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Por resolver

function Todo({ todo: t, week, today, onChange, onGive }: { todo: Data['todo']; week: Data['week']; today: string; onChange: (m: string) => void; onGive: (start: string) => void }) {
  const [cash, setCash] = useState<Appointment | null>(null);
  const [booking, setBooking] = useState<Brief['client'] | null>(null);
  const [error, setError] = useState('');
  const n = t.unpaid.count + t.declined.length + t.unconfirmed.length + t.failedReminders.length + t.imports + t.warnings.length;

  const confirm = async (a: Brief) => {
    setError('');
    try { await api.post(`/admin/appointments/${a.id}/attendance`, { answer: 'YES' }); onChange(`Asistencia de ${a.client.name} confirmada`); } catch (e) { setError(errMsg(e)); }
  };
  const noShow = async (a: Brief) => {
    setError('');
    try { await api.patch(`/admin/appointments/${a.id}`, { status: 'NO_SHOW' }); onChange(`Apuntado: ${a.client.name} no vino`); } catch (e) { setError(errMsg(e)); }
  };
  const who = (a: { client: { id: string; name: string } }) => <Link to={`/admin/usuarios/${a.client.id}`}>{a.client.name}</Link>;
  return (
    <section className="card">
      <h2>Por resolver</h2>
      <Alert>{error}</Alert>
      {!n && <p className="dash-ok"><span className="dot ok" /> Todo al día: no hay nada por resolver.</p>}
      {t.warnings.map((w) => <p key={w} className="todo-warn">{w} <Link to="/admin/configuracion">Configuración</Link></p>)}
      {n > t.warnings.length && <div className="todo-grid">
        {t.declined.length > 0 && (
          <div className="todo">
            <h3>No pueden venir <small>{t.declined.length}</small></h3>
            <p className="muted small">La cita sigue ocupando su hora: cancélala o cámbiala.</p>
            <ul>{t.declined.map((a) => (
              <li key={a.id}><div>{who(a)} <span className="muted small">{dateShort(a.startAt)} {time(a.startAt)}{a.by === 'EMAIL' ? ' · por email' : a.by === 'WHATSAPP' ? ' · por WhatsApp' : ''}</span></div>
                <div className="actions"><button className="btn btn-sm" onClick={() => setBooking(a.client)}>Cambiar o cancelar</button></div></li>
            ))}</ul>
          </div>
        )}
        {t.unconfirmed.length > 0 && (
          <div className="todo">
            <h3>Mañana sin confirmar <small>{t.unconfirmed.length}</small></h3>
            <p className="muted small">No han confirmado que vienen. Escríbeles, o apúntalo si te lo dicen.</p>
            <ul>{t.unconfirmed.map((a) => (
              <li key={a.id}><div>{who(a)} <span className="muted small">{time(a.startAt)}{a.client.phone && <> · <a href={`tel:${a.client.phone}`}>{a.client.phone}</a></>}</span>{a.noReminder && <div className="warn-text small">No recibirá el aviso automático</div>}</div>
                <div className="actions"><button className="btn btn-sm btn-ok" onClick={() => confirm(a)}>Confirmar</button>{a.whatsappLink && <a className="btn btn-sm btn-wa" href={a.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}</div></li>
            ))}</ul>
          </div>
        )}
        {t.unpaid.count > 0 && (
          <div className="todo">
            <h3>Sin cobrar <small>{t.unpaid.count} · {money(t.unpaid.totalCents)}</small></h3>
            <p className="muted small">Citas ya pasadas. Cóbralas o apunta que no vino.</p>
            <ul>
              {t.unpaid.items.map((a) => (
                <li key={a.id}>
                  <div>{who(a)} <span className="muted small">{dateShort(a.startAt)} {time(a.startAt)} · {money(a.priceCents)}</span></div>
                  <div className="actions">
                    {a.paymentMethod === 'cash' && <button className="btn btn-sm" onClick={() => setCash(a as unknown as Appointment)}>Marcar cobrada</button>}
                    <button className="btn btn-sm" onClick={() => noShow(a)}>No vino</button>
                  </div>
                </li>
              ))}
            </ul>
            {t.unpaid.count > t.unpaid.items.length && <p className="small muted">y {t.unpaid.count - t.unpaid.items.length} más en la <Link to="/admin/agenda">agenda</Link>.</p>}
          </div>
        )}
        {t.failedReminders.length > 0 && (
          <div className="todo">
            <h3>Avisos que han fallado <small>{t.failedReminders.length}</small></h3>
            <p className="muted small">El cliente no lo ha recibido: avísale tú.</p>
            <ul>{t.failedReminders.map((r) => (
              <li key={r.id}><div>{who(r)} <span className="muted small">{dateShort(r.startAt)} {time(r.startAt)} · {r.channel === 'EMAIL' ? 'email' : 'WhatsApp'}{r.client.phone && <> · <a href={`tel:${r.client.phone}`}>{r.client.phone}</a></>}</span><div className="warn-text small" title={r.detail ?? undefined}>{r.reason}</div></div>
                <div className="actions">{r.whatsappLink ? <a className="btn btn-sm btn-wa" href={r.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a> : <span className="muted small">sin teléfono</span>}</div></li>
            ))}</ul>
          </div>
        )}
        {t.imports > 0 && (
          <div className="todo">
            <h3>Agenda en papel <small>{t.imports}</small></h3>
            <p className="muted small">Páginas por revisar o que no se pudieron leer.</p>
            <Link className="btn btn-sm" to="/admin/importar">Revisar páginas</Link>
          </div>
        )}
      </div>}
      <WeekGaps week={week} today={today} onGive={onGive} />
      {booking && <BookForClient user={booking} onClose={() => { setBooking(null); onChange(''); }} onDone={(m) => { setBooking(null); onChange(m); }} />}
      {cash && <CashModalFor id={cash.id} onClose={() => setCash(null)} onDone={(m) => { setCash(null); onChange(m); }} />}
    </section>
  );
}

/** Huecos de hoy y los 6 días siguientes: para dar hora a quien llama o llega a última hora. */
function WeekGaps({ week, today, onGive }: { week: Data['week']; today: string; onGive: (start: string) => void }) {
  const total = week.reduce((n, d) => n + d.gaps.length, 0);
  const freed = week.reduce((n, d) => n + d.gaps.filter((g) => g.cancelledBy).length, 0);
  return (
    <div className="week-gaps">
      <h3>Huecos en 7 días <small>{total}{freed > 0 && ` · ${freed} por cancelación`}</small></h3>
      <p className="muted small">Pulsa una hora para dar la cita.{freed > 0 && <> Las <span className="gap-key">resaltadas</span> vienen de una cancelación.</>}</p>
      <ul>
        {week.map((d, i) => (
          <li key={d.date}>
            <div className="gap-day"><strong>{d.date === today ? 'Hoy' : i === 1 ? 'Mañana' : dateShort(`${d.date}T12:00:00Z`)}</strong>
              <span className="muted small">{!d.open ? 'Cerrado' : d.gaps.length === 0 ? (d.date === today ? 'Sin huecos' : 'Completo') : d.gaps.length === 1 ? '1 libre' : `${d.gaps.length} libres`}</span></div>
            <div className="gap-times">
              {d.gaps.map((g) => (
                <button key={g.start} type="button" className={g.cancelledBy ? 'is-freed' : ''} onClick={() => onGive(g.start)}
                  title={g.cancelledBy ? `Canceló ${g.cancelledBy}` : undefined} aria-label={`${dateShort(g.start)} a las ${time(g.start)}${g.cancelledBy ? `, canceló ${g.cancelledBy}` : ''}: crear cita`}>{time(g.start)}</button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** La ventana de cobro necesita la cita completa. */
function CashModalFor({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (m: string) => void }) {
  const [a, setA] = useState<Appointment | null>(null);
  useEffect(() => { api.get<Appointment>(`/admin/appointments/${id}`).then(setA).catch(onClose); /* eslint-disable-next-line */ }, [id]);
  return a ? <CashModal appt={a} onClose={onClose} onDone={onDone} /> : null;
}

// ---------------------------------------------------------------- Lista de espera

/** Quien espera hora en un día completo; primero los que ya tienen hueco. */
function Waitlist({ list, onGive, onChange }: { list: WaitEntry[]; onGive: (w: WaitEntry) => void; onChange: (m: string) => void }) {
  const [error, setError] = useState('');
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => Number(b.free.length > 0) - Number(a.free.length > 0));
  const withGap = list.filter((w) => w.free.length).length;
  const remove = async (w: WaitEntry) => {
    try { await api.del(`/admin/waitlist/${w.id}`); onChange(`${w.client.name} ya no está en la lista de espera`); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <section className="card">
      <h2>Lista de espera <small className="muted">{list.length}</small></h2>
      <p className="muted small">{withGap ? `${withGap === 1 ? 'Hay hueco para 1 cliente' : `Hay hueco para ${withGap} clientes`}.` : 'Todavía no se ha liberado ninguna hora para ellos.'}</p>
      <Alert>{error}</Alert>
      <ul className="lapsed">
        {sorted.map((w) => (
          <li key={w.id} className={w.free.length ? 'has-gap' : ''}>
            <div><Link to={`/admin/usuarios/${w.client.id}`}>{w.client.name}</Link>
              <span className="muted small">{dateShort(`${w.date}T12:00:00Z`)}, {waitPartLabel[w.part]}{w.free.length > 0 ? <> · <strong>libre: {w.free.slice(0, 4).map(time).join(', ')}{w.free.length > 4 && '…'}</strong>{w.notifiedAt && ' · avisado por email'}</> : ' · completo'}</span></div>
            <div className="actions">
              {w.free.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => onGive(w)}>Reservar</button>}
              {w.whatsappLink && <a className="btn btn-sm btn-wa" href={w.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}
              <button className="btn btn-sm" onClick={() => remove(w)}>Quitar</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Negocio

type Period = '7d' | '30d' | '12m';
interface Bucket { key: string; label: string; title: string; cashCents: number; onlineCents: number }
interface Biz {
  period: Period; buckets: Bucket[]; totalCents: number; cashCents: number; onlineCents: number; previousCents: number | null;
  occupancy: { percent: number | null; hours: number[]; weekdays: number[]; cells: (number | null)[][] };
  avgTicketCents: number | null; refunds: { count: number; cents: number }; forecast: { count: number; cents: number };
  services: { id: string; name: string; count: number; cents: number }[];
  incidents: { came: number; noShow: number; byClient: number; byShop: number; lostNoShowCents: number; lostCancelledCents: number };
  clients: { fresh: number; recurring: number; top: { id: string; name: string; visits: number; cents: number }[] };
  lapsed: { count: number; items: { id: string; name: string; days: number; usualDays: number | null; visits: number; spentCents: number; accepts: boolean; whatsappLink: string | null }[] };
}
const periods: [Period, string, string][] = [['7d', 'Últimos 7 días', 'los 7 días anteriores'], ['30d', 'Últimos 30 días', 'los 30 días anteriores'], ['12m', 'Últimos 12 meses', 'los 12 meses anteriores']];

function Business({ figures }: { figures: Data['figures'] }) {
  const [period, setPeriod] = useState<Period>('30d');
  const [b, setB] = useState<Biz | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setBusy(true);
    api.get<Biz>(`/admin/dashboard/business?period=${period}`).then((r) => { if (live) { setB(r); setError(''); } }).catch((e) => live && setError(errMsg(e))).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [period]);
  const prevLabel = periods.find(([p]) => p === (b?.period ?? period))![2];
  const diff = b && b.previousCents ? Math.round(((b.totalCents - b.previousCents) / b.previousCents) * 100) : null;
  return (
    <section className="dash-biz">
      <div className="dash-head">
        <h2>Cómo va el negocio</h2>
        <div className="chips" role="group" aria-label="Periodo">
          {periods.map(([p, l]) => <button key={p} type="button" className={`chip ${p === period ? 'selected' : ''}`} aria-pressed={p === period} onClick={() => setPeriod(p)}>{l}</button>)}
        </div>
      </div>
      <Alert>{error}</Alert>
      {!b ? !error && <Spinner /> : (
        <div className={busy ? 'dash-busy' : ''}>
          <div className="stats">
            <div className="stat"><strong>{money(b.totalCents)}</strong><span>Cobrado</span>
              <p className="stat-note">{diff === null ? 'Sin datos anteriores para comparar' : <><b className={diff >= 0 ? 'up' : 'down'}>{diff >= 0 ? '▲' : '▼'} {Math.abs(diff)} %</b> frente a {prevLabel}</>}</p></div>
            <div className="stat"><strong>{money(figures.monthCashCents + figures.monthOnlineCents)}</strong><span>Este mes</span><p className="stat-note">{money(figures.monthCashCents)} en el local · {money(figures.monthOnlineCents)} online</p></div>
            <div className="stat"><strong>{money(b.forecast.cents)}</strong><span>Previsto en 7 días</span><p className="stat-note">{times(b.forecast.count, 'cita reservada', 'citas reservadas')} · {figures.upcoming} en total</p></div>
            <div className="stat"><strong>{b.occupancy.percent === null ? '—' : `${b.occupancy.percent} %`}</strong><span>Ocupación</span><p className="stat-note">Horas con cita sobre horas abiertas</p></div>
            <div className="stat"><strong>{b.avgTicketCents === null ? '—' : money(b.avgTicketCents)}</strong><span>Ticket medio</span><p className="stat-note">Por cita cobrada</p></div>
            <div className="stat"><strong>{money(b.refunds.cents)}</strong><span>Devoluciones</span><p className="stat-note">{b.refunds.count === 1 ? '1 devolución' : `${b.refunds.count} devoluciones`}</p></div>
          </div>
          <div className="dash-charts">
            <RevenueChart b={b} />
            <Occupancy o={b.occupancy} />
          </div>
          <div className="dash-two">
            <Services list={b.services} />
            <Incidents x={b.incidents} />
            <ClientsCard c={b.clients} total={figures.clients} />
            <Lapsed l={b.lapsed} />
          </div>
        </div>
      )}
    </section>
  );
}

const niceMax = (cents: number) => {
  const eur = Math.max(cents / 100, 10);
  const mag = 10 ** Math.floor(Math.log10(eur));
  return (([1, 2, 4, 5, 8, 10].find((m) => m * mag >= eur) ?? 10) * mag) * 100;
};
const eur0 = (cents: number) => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: 'always' } as unknown as Intl.NumberFormatOptions).format(cents / 100)} €`;

/** Columnas apiladas: local y online. Cada columna se puede recorrer con el ratón o el teclado. */
function RevenueChart({ b }: { b: Biz }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(...b.buckets.map((x) => x.cashCents + x.onlineCents), 0));
  const every = b.buckets.length > 12 ? 5 : 1;
  const h = hover === null ? null : b.buckets[hover];
  return (
    <section className="card chart-card">
      <div className="dash-head"><h3>Ingresos por {b.period === '12m' ? 'mes' : 'día'}</h3><button type="button" className="link small" onClick={() => setTable(!table)}>{table ? 'Ver gráfico' : 'Ver tabla'}</button></div>
      <p className="chart-legend"><span><i className="key-cash" /> En el local {money(b.cashCents)}</span><span><i className="key-online" /> Online {money(b.onlineCents)}</span></p>
      {table ? (
        <div className="table-wrap chart-table"><table className="table"><thead><tr><th>Fecha</th><th>Local</th><th>Online</th><th>Total</th></tr></thead>
          <tbody>{b.buckets.map((x) => <tr key={x.key}><td>{x.title}</td><td>{money(x.cashCents)}</td><td>{money(x.onlineCents)}</td><td>{money(x.cashCents + x.onlineCents)}</td></tr>)}</tbody></table></div>
      ) : (
        <div className="bars" onMouseLeave={() => setHover(null)}>
          <div className="bars-y" aria-hidden>{[1, 0.5, 0].map((r) => <span key={r} style={{ bottom: `${r * 100}%` }}>{eur0(max * r)}</span>)}</div>
          <div className="bars-plot">
            {[1, 0.5, 0].map((r) => <hr key={r} style={{ bottom: `${r * 100}%` }} />)}
            {b.buckets.map((x, i) => {
              const last = i === b.buckets.length - 1;
              return (
                <div key={x.key} className={`bar-slot ${hover === i ? 'on' : ''}`} tabIndex={0} role="img" aria-label={`${x.title}: ${money(x.cashCents + x.onlineCents)}, ${money(x.cashCents)} en el local y ${money(x.onlineCents)} online`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onTouchStart={() => setHover(i)}>
                  <div className="bar">
                    {x.onlineCents > 0 && <i className="key-online" style={{ height: `${(x.onlineCents / max) * 100}%` }} />}
                    {x.cashCents > 0 && <i className="key-cash" style={{ height: `${(x.cashCents / max) * 100}%` }} />}
                  </div>
                  {(i % every === 0 && !(every > 1 && b.buckets.length - 1 - i < every) || last) && <em>{x.label}</em>}
                </div>
              );
            })}
            {h && hover !== null && (
              <div className={`tip ${hover > b.buckets.length / 2 ? 'left' : ''}`} style={hover > b.buckets.length / 2 ? { right: `${(1 - hover / b.buckets.length) * 100}%` } : { left: `${((hover + 1) / b.buckets.length) * 100}%` }}>
                <strong>{money(h.cashCents + h.onlineCents)}</strong><span>{h.title}</span>
                <span><i className="key-cash" /> {money(h.cashCents)} local</span><span><i className="key-online" /> {money(h.onlineCents)} online</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Mapa de calor: cada casilla lleva su porcentaje, así que no depende solo del color. */
function Occupancy({ o }: { o: Biz['occupancy'] }) {
  if (!o.hours.length) return <section className="card chart-card"><h3>Ocupación</h3><p className="empty">No ha habido días abiertos en este periodo.</p></section>;
  return (
    <section className="card chart-card">
      <div className="dash-head"><h3>Ocupación por día y hora</h3></div>
      <p className="muted small">Porcentaje de horas con cita. Cuanto más intenso el color, más lleno. Según el horario actual.</p>
      <div className="heat-wrap">
        <table className="heat">
          <thead><tr><th><span className="sr-only">Hora</span></th>{o.weekdays.map((w) => <th key={w} scope="col" title={weekdayNames[String(w)]}>{weekdayNames[String(w)].slice(0, 3)}</th>)}</tr></thead>
          <tbody>
            {o.hours.map((hr, hi) => (
              <tr key={hr}><th scope="row">{hr}:00</th>
                {o.weekdays.map((w, wi) => {
                  const v = o.cells[wi][hi];
                  return v === null ? <td key={w} className="off">·</td>
                    : <td key={w} className={`lv${Math.min(5, Math.floor(v / 17))}`} title={`${weekdayNames[String(w)]}, ${hr}:00–${hr + 1}:00: ${v} % ocupado`}>{v}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Barras horizontales de una sola serie, con su valor escrito: se leen sin depender del color. */
function BarList({ rows }: { rows: { key: string; label: React.ReactNode; value: number; text: string; note?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="bar-list">
      {rows.map((r) => (
        <li key={r.key}>
          <div><span>{r.label}</span><span className="bar-value"><strong>{r.text}</strong>{r.note && <small>{r.note}</small>}</span></div>
          <i aria-hidden><b style={{ width: `${Math.max(0, (r.value / max) * 100)}%` }} /></i>
        </li>
      ))}
    </ul>
  );
}

const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Services({ list }: { list: Biz['services'] }) {
  return (
    <section className="card chart-card">
      <h3>Servicios</h3>
      <p className="muted small">Cobrado por las citas realizadas en el periodo.</p>
      {list.length === 0 ? <p className="empty">No hay citas realizadas en este periodo.</p>
        : <BarList rows={list.map((x) => ({ key: x.id, label: x.name, value: x.cents, text: money(x.cents), note: times(x.count, 'cita', 'citas') }))} />}
    </section>
  );
}

function Incidents({ x }: { x: Biz['incidents'] }) {
  const total = x.came + x.noShow + x.byClient + x.byShop;
  const pct = (n: number) => `${Math.round((n / total) * 100)} %`;
  const lost = x.lostNoShowCents + x.lostCancelledCents;
  return (
    <section className="card chart-card">
      <div className="dash-head"><h3>Ausencias y cancelaciones</h3><Link to="/admin/anulaciones" className="small">Ver por cliente</Link></div>
      {total === 0 ? <p className="empty">No hay citas en este periodo.</p> : (
        <>
          <BarList rows={[
            { key: 'came', label: 'Vinieron', value: x.came, text: pct(x.came), note: times(x.came, 'cita', 'citas') },
            { key: 'noShow', label: 'No vinieron', value: x.noShow, text: pct(x.noShow), note: times(x.noShow, 'cita', 'citas') },
            { key: 'byClient', label: 'Canceló el cliente', value: x.byClient, text: pct(x.byClient), note: times(x.byClient, 'cita', 'citas') },
            { key: 'byShop', label: 'Canceló la peluquería', value: x.byShop, text: pct(x.byShop), note: times(x.byShop, 'cita', 'citas') },
          ]} />
          <p className="dash-lost"><strong>{money(lost)}</strong> perdidos (estimado): {money(x.lostNoShowCents)} por ausencias y {money(x.lostCancelledCents)} por horas canceladas que no se volvieron a llenar.</p>
        </>
      )}
    </section>
  );
}

function ClientsCard({ c, total }: { c: Biz['clients']; total: number }) {
  return (
    <section className="card chart-card">
      <div className="dash-head"><h3>Clientes</h3><Link to="/admin/usuarios" className="small">{total} en total</Link></div>
      <div className="dash-pair"><p><strong>{c.fresh}</strong><span>nuevos</span></p><p><strong>{c.recurring}</strong><span>han repetido</span></p></div>
      <h4 className="dash-part">Mejores del periodo</h4>
      {c.top.length === 0 ? <p className="empty">No hay citas realizadas en este periodo.</p>
        : <BarList rows={c.top.map((x) => ({ key: x.id, label: <Link to={`/admin/usuarios/${x.id}`}>{x.name}</Link>, value: x.cents, text: money(x.cents), note: times(x.visits, 'visita', 'visitas') }))} />}
    </section>
  );
}

function Lapsed({ l }: { l: Biz['lapsed'] }) {
  return (
    <section className="card chart-card">
      <h3>Llevan tiempo sin venir {l.count > 0 && <small className="muted">{l.count}</small>}</h3>
      <p className="muted small">Más de lo habitual en ellos y sin cita reservada. No depende del periodo.</p>
      {l.items.length === 0 ? <p className="empty">Todos vienen a su ritmo.</p> : (
        <ul className="lapsed">
          {l.items.map((x) => (
            <li key={x.id}>
              <div><Link to={`/admin/usuarios/${x.id}`}>{x.name}</Link><span className="muted small">hace {x.days} días{x.usualDays ? ` · suele venir cada ${x.usualDays}` : ' · solo ha venido una vez'}</span></div>
              {x.whatsappLink ? <a className="btn btn-sm btn-wa" href={x.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>
                : <span className="muted small">{x.accepts ? 'Sin teléfono' : 'No acepta WhatsApp'}</span>}
            </li>
          ))}
        </ul>
      )}
      {l.count > l.items.length && <p className="small muted">y {l.count - l.items.length} más.</p>}
    </section>
  );
}
