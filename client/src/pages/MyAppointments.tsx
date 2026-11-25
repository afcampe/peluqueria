import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SlotPicker } from '../components/SlotPicker';
import { Alert, Badge, Modal, Spinner, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { canClientChange, dateShort, dateTime, isoToLocalDate, localISODate, methodLabel, money, monthLabel, noticeText, shownStatus, statusLabel, time } from '../lib/format';
import { useSession } from '../lib/session';
import { activePayment, cashPayment, onlinePayment, ticketsOf } from '../lib/payment';
import { TicketButtons } from '../components/TicketButton';
import type { Appointment } from '../lib/types';
import { IconRepeat } from '../components/icons';

/** Citas que se ven antes de «Ver las…», y tamaño de cada tanda del historial. */
const FIRST = 5;
const HISTORY_PAGE = 10;

export function MyAppointments() {
  const { config } = useSession();
  const location = useLocation();
  const [list, setList] = useState<Appointment[] | null>(null);
  const [all, setAll] = useState(false);
  const [flash, setFlash] = useState<string>((location.state as { flash?: string })?.flash ?? '');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [cancellingSeries, setCancellingSeries] = useState<SeriesGroup | null>(null);

  const load = useCallback(() => api.get<Appointment[]>('/appointments').then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!config) return null;
  const notice = config.clientCancelMinNoticeMinutes;
  const now = Date.now();
  const upcoming = (list ?? []).filter((a) => ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status) && new Date(a.endAt).getTime() > now).reverse();
  const past = (list ?? []).filter((a) => !upcoming.includes(a));

  // Series con citas próximas
  const seriesGroups = new Map<string, SeriesGroup>();
  upcoming.forEach((a) => {
    if (!a.series) return;
    const g = seriesGroups.get(a.series.id) ?? { id: a.series.id, intervalDays: a.series.intervalDays, service: a.service.name, appts: [] };
    g.appts.push(a);
    seriesGroups.set(a.series.id, g);
  });

  const shopPhone = config.shop.phone ? <a href={`tel:${config.shop.phone}`}>{config.shop.phone}</a> : 'la peluquería';
  const [next, ...rest] = upcoming;
  const shown = all ? rest : rest.slice(0, FIRST);

  /** Botones de una cita próxima, o por qué no se puede tocar. */
  const actions = (a: Appointment) => !canClientChange(a.startAt, notice) ? (
    <p className="muted small mc-note">Falta menos de {noticeText(notice)}. Para cambiarla o cancelarla, llama al {shopPhone}.</p>
  ) : (
    <>
      <button className="btn btn-sm" onClick={() => setEditing(a)}>Cambiar hora</button>
      {/* Pagada online: al cancelar se devuelve el dinero. Cobrada en el local: solo la peluquería. */}
      {cashPayment(a)
        ? <p className="muted small mc-note">Ya cobrada. Para cancelarla, llama al {shopPhone}.</p>
        : <button className="btn btn-sm btn-danger" onClick={() => setCancelling(a)}>Cancelar</button>}
    </>
  );

  return (
    <div className="mc">
      <div className="page-head">
        <h1>Mis citas</h1>
        <Link to="/reservar" className="btn btn-primary">Nueva cita</Link>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {!list && !error && <Spinner />}
      {list && upcoming.length === 0 && <p className="empty">No tienes citas próximas.</p>}

      {next && (
        <section className="card mc-next" aria-label="Tu próxima cita">
          <DateTile iso={next.startAt} />
          <div className="mc-main">
            <span className="mc-eyebrow">Tu próxima cita · {inDays(next.startAt)}</span>
            <h2>{time(next.startAt)} <span>{next.service.name}</span></h2>
            <Meta a={next} />
            <TicketRow a={next} />
          </div>
          <div className="mc-actions">{actions(next)}</div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="card mc-card">
          <div className="mc-head"><h2>Más citas <small>{rest.length}</small></h2></div>
          <ul className="mc-list">
            {shown.map((a) => <Row key={a.id} a={a}>{actions(a)}</Row>)}
          </ul>
          {rest.length > FIRST && <button type="button" className="mc-more" onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver las ${rest.length}`}</button>}
        </section>
      )}

      {seriesGroups.size > 0 && (
        <section className="card mc-card">
          <div className="mc-head"><h2>Citas periódicas</h2></div>
          <ul className="mc-list">
            {[...seriesGroups.values()].map((g) => (
              <li key={g.id} className="mc-row mc-series">
                <span className="mc-series-icon"><IconRepeat size={18} /></span>
                <div className="mc-main">
                  <strong>{g.service} cada {g.intervalDays} días</strong>
                  <p className="muted small">{g.appts.length === 1 ? '1 cita próxima' : `${g.appts.length} citas próximas`}, hasta el {dateShort(g.appts.at(-1)!.startAt).toLowerCase()} {isoToLocalDate(g.appts.at(-1)!.startAt).slice(0, 4)}</p>
                </div>
                <div className="mc-actions"><button className="btn btn-sm btn-danger" onClick={() => setCancellingSeries(g)}>Cancelar todas</button></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && <History list={past} />}

      {cancellingSeries && (
        <Modal title="Cancelar citas periódicas" onClose={() => setCancellingSeries(null)}>
          <p>Se cancelarán las <strong>{cancellingSeries.appts.length} citas</strong> próximas de {cancellingSeries.service} (cada {cancellingSeries.intervalDays} días).</p>
          <p className="muted small">Las que falten menos de {noticeText(notice)} no se pueden cancelar desde la app. Si pagaste online, te devolvemos el importe de cada cita cancelada.</p>
          <CancelSeriesButton id={cancellingSeries.id} onDone={(msg) => { setCancellingSeries(null); setFlash(msg); load(); }} />
        </Modal>
      )}
      {editing && <RescheduleModal appt={editing} onClose={() => setEditing(null)} onDone={(msg) => { setEditing(null); setFlash(msg); load(); }} />}
      {cancelling && (
        <Modal title="Cancelar cita" onClose={() => setCancelling(null)}>
          {onlinePayment(cancelling) ? (() => {
            const p = onlinePayment(cancelling)!;
            return (
              <>
                <p>¿Seguro que quieres cancelar la cita del <strong>{dateTime(cancelling.startAt)}</strong>?</p>
                <Alert kind="info">Ya está pagada: al cancelarla te devolveremos automáticamente <strong>{money(p.amountCents - p.refundedCents)}</strong> a tu cuenta de {methodLabel(p.provider)}{p.payerEmail && <> ({p.payerEmail})</>}.</Alert>
                <p className="muted small">El reembolso puede tardar unos días en aparecer.{p.ticket && ` Recibirás un ticket rectificativo del ${p.ticket.number}, que podrás descargar en el historial.`}</p>
              </>
            );
          })() : <p>¿Seguro que quieres cancelar la cita del <strong>{dateTime(cancelling.startAt)}</strong>?</p>}
          <CancelButton id={cancelling.id} refund={!!onlinePayment(cancelling)} onDone={(msg) => { setCancelling(null); setFlash(msg); load(); }} />
        </Modal>
      )}
    </div>
  );
}

/** Día, número y mes en un recuadro. */
function DateTile({ iso }: { iso: string }) {
  const d = isoToLocalDate(iso);
  const year = d.slice(0, 4) !== localISODate().slice(0, 4) ? d.slice(0, 4) : null;
  const [wd, num, mon] = dateShort(iso).replace(',', '').split(' ');
  return <time className="mc-date" dateTime={iso} aria-label={dateTime(iso)}><span>{wd}</span><b>{num}</b><span>{mon}{year && ` ’${year.slice(2)}`}</span></time>;
}

function inDays(iso: string) {
  const n = Math.round((Date.parse(isoToLocalDate(iso)) - Date.parse(localISODate())) / 86_400_000);
  return n <= 0 ? 'hoy' : n === 1 ? 'mañana' : `dentro de ${n} días`;
}

/** Estado, precio y pago en una línea. */
function Meta({ a }: { a: Appointment }) {
  const refunded = a.payments.reduce((n, p) => n + p.refundedCents, 0);
  const pay = a.status === 'PENDING_PAYMENT' ? 'pago sin completar'
    : refunded ? `reembolsados ${money(refunded)}`
    : activePayment(a) ? `pagada (${methodLabel(activePayment(a)!.provider)})`
    : ['CONFIRMED', 'COMPLETED'].includes(a.status) && new Date(a.endAt) > new Date() ? 'pagas en la peluquería' : '';
  return (
    <div className="mc-meta">
      <Badge status={shownStatus(a)}>{statusLabel[shownStatus(a)]}</Badge>
      <span>{money(a.priceCents)}{pay && ` · ${pay}`}</span>
      {a.series && <span className="series-badge"><IconRepeat size={13} /> cada {a.series.intervalDays} días</span>}
    </div>
  );
}

const TicketRow = ({ a }: { a: Appointment }) => (ticketsOf(a).length > 0 ? <div className="mc-tickets"><TicketButtons tickets={ticketsOf(a)} /></div> : null);

function Row({ a, children, showTickets = true }: { a: Appointment; children?: ReactNode; showTickets?: boolean }) {
  return (
    <li className={`mc-row ${a.status === 'CANCELLED' ? 'is-cancelled' : ''}`}>
      <DateTile iso={a.startAt} />
      <div className="mc-main">
        <strong>{time(a.startAt)} · {a.service.name}</strong>
        <Meta a={a} />
        {showTickets && <TicketRow a={a} />}
      </div>
      {children && <div className="mc-actions">{children}</div>}
    </li>
  );
}

/** Momento en que la cita pasó al historial: el de su hora o, si se canceló antes, el de la cancelación. */
const historyDate = (a: Appointment) => (a.cancelledAt && a.cancelledAt < a.startAt ? a.cancelledAt : a.startAt);
const monthShort = (ym: string) => monthLabel(`${ym}-01`).slice(0, 3);

/** Citas pasadas y anuladas: las últimas, o las de un año o mes. */
function History({ list }: { list: Appointment[] }) {
  const [period, setPeriod] = useState(''); // '' = últimas, 'YYYY' o 'YYYY-MM'
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const ym = (a: Appointment) => isoToLocalDate(a.startAt).slice(0, 7);
  const years = [...new Set(list.map((a) => ym(a).slice(0, 4)))].sort().reverse();
  const year = period.slice(0, 4);
  const months = [...new Set(list.map(ym).filter((m) => year && m.startsWith(year)))].sort();
  const found = period
    ? list.filter((a) => ym(a).startsWith(period))
    : [...list].sort((a, b) => historyDate(b).localeCompare(historyDate(a))).slice(0, FIRST);
  const pick = (p: string) => { setPeriod(p); setLimit(HISTORY_PAGE); };
  const chip = (value: string, label: string, on: boolean) => (
    <button key={value || 'last'} type="button" className={`chip ${on ? 'selected' : ''}`} aria-pressed={on} aria-label={value.length === 7 ? monthLabel(`${value}-01`) : undefined} onClick={() => pick(value)}>{label}</button>
  );
  return (
    <section className="card mc-card" aria-label="Historial">
      <div className="mc-head">
        <h2>Historial <small>{period ? found.length : list.length}</small></h2>
        <div className="chips" role="group" aria-label="Año">
          {chip('', 'Últimas', !period)}
          {years.map((y) => chip(y, y, year === y))}
        </div>
      </div>
      {year && (
        <div className="chips mc-months" role="group" aria-label={`Mes de ${year}`}>
          {chip(year, 'Todo el año', period === year)}
          {months.map((m) => chip(m, monthShort(m), period === m))}
        </div>
      )}
      <ul className="mc-list">
        {found.slice(0, limit).map((a) => <Row key={a.id} a={a} showTickets={false}>{ticketsOf(a).length > 0 && <TicketButtons tickets={ticketsOf(a)} />}</Row>)}
      </ul>
      {found.length > limit && <button type="button" className="mc-more" onClick={() => setLimit(limit + HISTORY_PAGE)}>Ver {Math.min(HISTORY_PAGE, found.length - limit)} más</button>}
      {!period && list.length > FIRST && <p className="muted small mc-foot">Se muestran las {FIRST} últimas. Elige un año para ver las demás.</p>}
    </section>
  );
}

interface SeriesGroup { id: string; intervalDays: number; service: string; appts: Appointment[] }

function CancelSeriesButton({ id, onDone }: { id: string; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <Alert>{error}</Alert>
      <button className="btn btn-danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ cancelled: number; skipped: number; refundedCents: number }>(`/appointments/series/${id}/cancel`);
          onDone(`${r.cancelled} cita(s) cancelada(s).${r.refundedCents ? ` Reembolsados ${money(r.refundedCents)}.` : ''}${r.skipped ? ` ${r.skipped} no se pudieron cancelar por falta de antelación o porque ya están cobradas en el local.` : ''}`);
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{busy ? 'Cancelando…' : 'Sí, cancelar todas'}</button>
    </>
  );
}

function CancelButton({ id, refund, onDone }: { id: string; refund: boolean; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <Alert>{error}</Alert>
      <button className="btn btn-danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ refundedCents: number }>(`/appointments/${id}/cancel`);
          onDone(r.refundedCents ? `Cita cancelada. Te hemos devuelto ${money(r.refundedCents)}; puede tardar unos días en aparecer.` : 'Cita cancelada.');
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{busy ? 'Cancelando…' : refund ? 'Sí, cancelar y devolver el dinero' : 'Sí, cancelar cita'}</button>
    </>
  );
}

function RescheduleModal({ appt, onClose, onDone }: { appt: Appointment; onClose: () => void; onDone: (msg: string) => void }) {
  const [start, setStart] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Cambiar hora" onClose={onClose}>
      <p className="muted">Cita actual: {dateTime(appt.startAt)}</p>
      <Alert>{error}</Alert>
      <SlotPicker value={start} onPick={setStart} excludeId={appt.id} initialDate={isoToLocalDate(appt.startAt)} />
      <button className="btn btn-primary" disabled={!start || busy} onClick={async () => {
        setBusy(true);
        try {
          await api.patch(`/appointments/${appt.id}`, { startAt: start });
          onDone(`Cita cambiada al ${dateTime(start!)}.`);
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{start ? `Cambiar al ${dateTime(start)}` : 'Elige una hora'}</button>
    </Modal>
  );
}
