import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Alert, Badge, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateLong, methodLabel, money, statusLabel, time } from '../../lib/format';
import { canIssueTicket, cashPayment, onlinePayment, paymentInfo, ticketOf, ticketedPayment, ticketsOf } from '../../lib/payment';
import { TicketButtons } from '../../components/TicketButton';
import { CashModal, CashRefundModal, OnlineRefundModal } from './Agenda';
import type { Appointment, User } from '../../lib/types';
import { IconRepeat, IconTicket } from '../../components/icons';

type Filter = 'all' | 'future' | 'past' | 'incidents';
const statusText = { ACTIVE: 'Activo', BLOCKED: 'Bloqueado', DELETED: 'De baja' };

export function UserDetail() {
  const { id } = useParams();
  const [user, setUser] = useState<User | null>(null);
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(params.get('ver') === 'incidencias' ? 'incidents' : 'all');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<User>(`/admin/users/${id}`).then(setUser).catch((e) => setError(e.message));
    api.get<Appointment[]>(`/admin/appointments?clientId=${id}`).then(setAppts).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!user || !appts) return <Spinner />;

  const now = Date.now();
  const isFuture = (a: Appointment) => new Date(a.startAt).getTime() > now;
  // Próximas: de la más cercana a la más lejana. Pasadas: de la más reciente a la más antigua.
  const future = appts.filter(isFuture).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const past = appts.filter((a) => !isFuture(a)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const isIncident = (a: Appointment) => a.status === 'NO_SHOW' || a.status === 'CANCELLED';
  const incidents = past.filter(isIncident).concat(future.filter(isIncident)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const shown = filter === 'future' ? future : filter === 'past' ? past : filter === 'incidents' ? incidents : [...future, ...past];

  const active = (a: Appointment) => a.status !== 'CANCELLED';
  const paidCents = appts.reduce((sum, a) => sum + a.payments.filter((p) => p.status !== 'FAILED' && p.status !== 'CREATED').reduce((s, p) => s + p.amountCents - p.refundedCents, 0), 0);
  const pendingCents = appts.filter((a) => active(a) && a.status !== 'NO_SHOW' && paymentInfo(a).kind === 'unpaid').reduce((s, a) => s + a.priceCents, 0);
  const stats = [
    { n: future.filter(active).length, label: 'Próximas' },
    { n: past.filter((a) => a.status === 'COMPLETED' || a.status === 'CONFIRMED').length, label: 'Pasadas' },
    { n: appts.filter((a) => a.status === 'CANCELLED').length, label: 'Canceladas' },
    { n: appts.filter((a) => a.status === 'NO_SHOW').length, label: 'No vino' },
  ];

  return (
    <div>
      <p><Link to="/admin/usuarios">← Usuarios</Link></p>
      <section className="card user-head">
        <Avatar name={user.name} src={user.avatarUrl} size={64} />
        <div className="grow">
          <h1>{user.name}</h1>
          <p className="muted">
            {user.email}{user.phone && <> · <a href={`tel:${user.phone}`}>{user.phone}</a></>}
          </p>
          <p>
            {user.role === 'ADMIN' ? <Badge status="admin">Administrador</Badge> : <Badge status="active">Usuario normal</Badge>}
            <Badge status={user.status}>{statusText[user.status]}</Badge>
            {user.status === 'BLOCKED' && user.blockReason && <span className="muted small"> {user.blockReason}</span>}
          </p>
        </div>
        {user.whatsappLink && <a className="btn btn-wa" href={user.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}
      </section>

      {user.role === 'ADMIN' ? (
        <p className="empty">Las cuentas de administrador no tienen citas.</p>
      ) : (
        <>
          <div className="stats">
            {stats.map((s) => <div key={s.label} className="stat"><strong>{s.n}</strong><span>{s.label}</span></div>)}
            <div className="stat"><strong>{money(paidCents)}</strong><span>Pagado en total</span></div>
            <div className="stat"><strong>{money(pendingCents)}</strong><span>Pendiente de cobro</span></div>
          </div>

          <div className="page-head">
            <h2>Citas</h2>
            <div className="chips" role="group" aria-label="Filtrar citas">
              {([['all', `Todas (${appts.length})`], ['future', `Próximas (${future.length})`], ['past', `Pasadas (${past.length})`], ['incidents', `Anuladas y no vino (${incidents.length})`]] as const).map(([k, label]) => (
                <button key={k} type="button" className={`chip ${filter === k ? 'selected' : ''}`} onClick={() => setFilter(k)}>{label}</button>
              ))}
            </div>
          </div>
          <p className="legend">
            <span><i className="swatch swatch-future" /> Próximas</span>
            <span><i className="swatch swatch-past" /> Pasadas</span>
          </p>

          {shown.length === 0 && <p className="empty">No hay citas.</p>}
          <div className="history">
            {shown.map((a, i) => {
              const fut = isFuture(a);
              // Separador entre próximas y pasadas en la vista "Todas"
              const divider = filter === 'all' && i > 0 && !fut && isFuture(shown[i - 1]);
              return (
                <div key={a.id}>
                  {divider && <div className="history-divider">Pasadas</div>}
                  <HistoryRow appt={a} future={fut} onChange={load} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function HistoryRow({ appt: a, future, onChange }: { appt: Appointment; future: boolean; onChange: () => void }) {
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'cash' | 'refund' | 'refundCash' | null>(null);
  const locked = ticketedPayment(a);
  const pay = paymentInfo(a);
  const ticket = ticketOf(a);
  const cash = cashPayment(a);
  const canMarkPaid = a.paymentMethod === 'cash' && a.status !== 'CANCELLED' && a.status !== 'PENDING_PAYMENT' && !cash;
  const run = async (path: string) => {
    setError('');
    try { await api.post(`/admin/appointments/${a.id}/${path}`); onChange(); } catch (e) { setError(errMsg(e)); }
  };

  return (
    <article className={`history-item ${future ? 'is-future' : 'is-past'} ${a.status === 'CANCELLED' ? 'is-cancelled' : ''}`}>
      <div className="history-when">
        <strong>{dateLong(a.startAt)}</strong>
        <span>{time(a.startAt)}–{time(a.endAt)}</span>
      </div>
      <div className="history-main">
        <div>{a.service.name} · {money(a.priceCents)} {a.series && <span className="series-badge"><IconRepeat size={14} /> cada {a.series.intervalDays} días</span>}</div>
        <div className="history-tags">
          <Badge status={a.status}>{statusLabel[a.status]}</Badge>
          <span className={`pay pay-${pay.kind}`}>{pay.label}</span>
          <span className="muted small">· {methodLabel(a.paymentMethod)}</span>
        </div>
        {a.notes && <div className="muted small">Nota: {a.notes}</div>}
        {a.cancelReason && <div className="muted small">Motivo: {a.cancelReason} ({a.cancelledBy === 'CLIENT' ? 'cliente' : 'peluquería'})</div>}
        {error && <div className="error-text small">{error}</div>}
      </div>
      <div className="actions">
        {canMarkPaid && <button className="btn btn-sm" onClick={() => setModal('cash')}>Marcar cobrada</button>}
        {cash && !ticket && <button className="btn btn-sm" onClick={() => run('unmark-paid')}>Deshacer cobro</button>}
        <TicketButtons tickets={ticketsOf(a)} />
        {canIssueTicket(a) && (
          <button className="btn btn-sm btn-ticket" onClick={() => run('ticket')}><IconTicket size={16} /> Generar ticket</button>
        )}
        {(locked || onlinePayment(a)) && (
          <button className="btn btn-sm btn-refund" onClick={() => setModal(locked?.provider === 'cash' ? 'refundCash' : 'refund')}>Reembolsar</button>
        )}
      </div>
      {modal && (() => {
        const close = () => setModal(null);
        const done = () => { setModal(null); onChange(); };
        if (modal === 'cash') return <CashModal appt={a} onClose={close} onDone={done} />;
        if (modal === 'refundCash') return <CashRefundModal appt={a} onClose={close} onDone={done} />;
        return <OnlineRefundModal appt={a} onClose={close} onDone={done} />;
      })()}
    </article>
  );
}
