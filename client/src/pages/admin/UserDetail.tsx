import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookForClient } from '../../components/BookForClient';
import { EmailReminderButton } from '../../components/EmailReminderButton';
import { Avatar } from '../../components/Avatar';
import { Alert, Badge, Modal, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { attendanceText, contactLine, dateLong, isBooked, methodLabel, money, shownStatus, statusLabel, time } from '../../lib/format';
import { canCorrectCharge, canIssueTicket, canMarkNoShow, cashPayment, onlinePayment, paymentInfo, ticketsOf } from '../../lib/payment';
import { TicketButtons } from '../../components/TicketButton';
import { CashModal, OnlineRefundModal } from './Agenda';
import type { Appointment, User } from '../../lib/types';
import { IconRepeat, IconTicket } from '../../components/icons';

type Filter = 'all' | 'future' | 'past' | 'incidents';
const statusText = { ACTIVE: 'Activo', BLOCKED: 'Bloqueado', DELETED: 'De baja' };

export function UserDetail() {
  const { id } = useParams();
  const { config } = useSession();
  const [user, setUser] = useState<User | null>(null);
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(params.get('ver') === 'incidencias' ? 'incidents' : 'all');
  const [error, setError] = useState('');
  const [merging, setMerging] = useState(false);
  const [booking, setBooking] = useState(false);
  const [flash, setFlash] = useState('');

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
            {user.email ?? 'Sin email'}{user.phone && <> · <a href={`tel:${user.phone}`}>{user.phone}</a></>}
          </p>
          <p>
            {user.role === 'ADMIN' ? <Badge status="admin">Administrador</Badge> : <Badge status="active">Usuario normal</Badge>}
            <Badge status={user.status}>{statusText[user.status]}</Badge>
            {!user.hasAccount && <span className="badge badge-noaccount">Sin cuenta · agenda en papel</span>}
            {user.status === 'BLOCKED' && user.blockReason && <span className="muted small"> {user.blockReason}</span>}
          </p>
          {user.role === 'CLIENT' && (
            <p className="muted small">
              Recordatorios de citas: {[config?.reminders.email && user.remindEmail && 'por email', config?.reminders.whatsapp && user.remindWhatsapp && 'por WhatsApp'].filter(Boolean).join(' y ') || 'ninguno'}
            </p>
          )}
        </div>
 {!user.hasAccount && user.role === 'CLIENT' && <button className="btn" onClick={() => setMerging(true)}>Unir con un cliente registrado</button>}
        {user.role === 'CLIENT' && user.status !== 'DELETED' && <button className="btn btn-primary" onClick={() => setBooking(true)}>Reservar cita</button>}
        {user.whatsappLink && <a className="btn btn-wa" href={user.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}
        {user.role === 'CLIENT' && user.status !== 'DELETED' && (
          <EmailReminderButton small={false} clientId={user.id} disabledReason={!user.email ? 'El cliente no tiene email'
            : future.some((a) => a.status === 'CONFIRMED') ? undefined : 'No tiene ninguna cita próxima'} />
        )}
      </section>

      <Alert kind="ok">{flash}</Alert>
      {booking && <BookForClient user={user} onChanged={load} onClose={() => setBooking(false)} onDone={(m) => { setBooking(false); setFlash(m); load(); }} />}
      {merging && <MergeModal user={user} onClose={() => setMerging(false)} />}

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
  const [modal, setModal] = useState<'cash' | 'refund' | null>(null);
  const pay = paymentInfo(a);
  const cash = cashPayment(a);
  const canMarkPaid = a.paymentMethod === 'cash' && !['CANCELLED', 'PENDING_PAYMENT', 'NO_SHOW'].includes(a.status) && !cash;
  const run = async (path: string) => {
    setError('');
    try { await api.post(`/admin/appointments/${a.id}/${path}`); onChange(); } catch (e) { setError(errMsg(e)); }
  };

  const attend = async (answer: 'YES' | null) => {
    setError('');
    try { await api.post(`/admin/appointments/${a.id}/attendance`, { answer }); onChange(); } catch (e) { setError(errMsg(e)); }
  };
  const setStatus = async (status: string) => {
    setError('');
    try { await api.patch(`/admin/appointments/${a.id}`, { status }); onChange(); } catch (e) { setError(errMsg(e)); }
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
          <Badge status={shownStatus(a)}>{statusLabel[shownStatus(a)]}</Badge>
          <span className={`pay pay-${pay.kind}`}>{pay.label}</span>
          <span className="muted small">· {methodLabel(a.paymentMethod)}</span>
        </div>
        {a.attendance && a.status === 'CONFIRMED' && <div className="muted small">{attendanceText(a)}</div>}
        {a.notes && <div className="muted small">Nota: {a.notes}</div>}
        {a.cancelReason && <div className="muted small">Motivo: {a.cancelReason} ({a.cancelledBy === 'CLIENT' ? 'cliente' : 'peluquería'})</div>}
        {error && <div className="error-text small">{error}</div>}
      </div>
      <div className="actions">
        {isBooked(a) && (a.attendance === 'YES' ? <button className="btn btn-sm" onClick={() => attend(null)}>Quitar confirmación</button> : <button className="btn btn-sm btn-ok" onClick={() => attend('YES')}>Confirmar asistencia</button>)}
        {canMarkNoShow(a) && <button className="btn btn-sm" onClick={() => setStatus('NO_SHOW')}>No vino</button>}
        {a.status === 'NO_SHOW' && <button className="btn btn-sm" onClick={() => setStatus('CONFIRMED')}>Sí vino</button>}
        {canMarkPaid && <button className="btn btn-sm" onClick={() => setModal('cash')}>Marcar cobrada</button>}
        <TicketButtons tickets={ticketsOf(a)} />
        {canIssueTicket(a) && (
          <button className="btn btn-sm btn-ticket" onClick={() => run('ticket')}><IconTicket size={16} /> Generar ticket</button>
        )}
        {canCorrectCharge(a) && <button className="btn btn-sm" onClick={() => setModal('refund')}>Corregir cobro</button>}
        {a.status === 'NO_SHOW' && onlinePayment(a) && <button className="btn btn-sm btn-refund" onClick={() => setModal('refund')}>Reembolsar</button>}
      </div>
      {modal && (() => {
        const close = () => setModal(null);
        const done = () => { setModal(null); onChange(); };
        if (modal === 'cash') return <CashModal appt={a} onClose={close} onDone={done} />;
        return <OnlineRefundModal appt={a} onClose={close} onDone={done} />;
      })()}
    </article>
  );
}

/** Pasa las citas de una ficha sin cuenta a un cliente registrado y borra la ficha. */
function MergeModal({ user, onClose }: { user: User; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState(user.name.split(' ')[0]);
  const [list, setList] = useState<User[]>([]);
  const [target, setTarget] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<User[]>(`/admin/users?role=CLIENT&q=${encodeURIComponent(q)}`)
        .then((r) => setList(r.filter((u) => u.id !== user.id && u.status !== 'DELETED'))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q, user.id]);
  return (
    <Modal title="Unir con un cliente registrado" onClose={onClose}>
      <p>Las citas de <strong>{user.name}</strong> (ficha sin cuenta) pasarán al cliente que elijas y esta ficha se borrará.</p>
      <Alert>{error}</Alert>
      <label>Buscar cliente<input autoFocus placeholder="Nombre, email o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <ul className="pick-list">
        {list.map((u) => (
          <li key={u.id}>
            <label className="check"><input type="radio" name="merge-target" checked={target?.id === u.id} onChange={() => setTarget(u)} /> {u.name} <small className="muted">{contactLine(u)}{!u.hasAccount && ' · sin cuenta'}</small></label>
          </li>
        ))}
        {list.length === 0 && <li className="muted small">No hay clientes que coincidan.</li>}
      </ul>
      <button className="btn btn-primary" disabled={!target || busy} onClick={async () => {
        setBusy(true);
        try {
          await api.post(`/admin/users/${user.id}/merge`, { targetId: target!.id });
          navigate(`/admin/usuarios/${target!.id}`, { replace: true });
          onClose();
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{target ? `Unir con ${target.name}` : 'Elige un cliente'}</button>
    </Modal>
  );
}
