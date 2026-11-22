import { useCallback, useEffect, useState } from 'react';
import { RecurrencePlanner, type SeriesPlan } from '../../components/RecurrencePlanner';
import { SlotPicker } from '../../components/SlotPicker';
import { Link } from 'react-router-dom';
import { Alert, Badge, ErrorAlert, Modal, Spinner, errMsg } from '../../components/ui';
import { cashPayment, onlinePayment, paymentInfo } from '../../lib/payment';
import { api } from '../../lib/api';
import { dateLong, dateShort, isoToLocalDate, localISODate, methodLabel, money, statusLabel, time } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Appointment, Payment, User } from '../../lib/types';
import { IconRepeat } from '../../components/icons';

const waUrl = (phone: string | null, text: string) => {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 9) d = `34${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
};

export function Agenda() {
  const [from, setFrom] = useState(localISODate());
  const [to, setTo] = useState(localISODate());
  const [status, setStatus] = useState('');
  const [list, setList] = useState<Appointment[] | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [modal, setModal] = useState<{ kind: 'new' | 'move' | 'cancel' | 'refund'; appt?: Appointment; payment?: Payment } | null>(null);

  const load = useCallback(() => {
    setList(null);
    const q = new URLSearchParams({ from, to, ...(status && { status }) });
    api.get<Appointment[]>(`/admin/appointments?${q}`).then(setList).catch((e) => setError(e.message));
  }, [from, to, status]);
  useEffect(() => { load(); }, [load]);

  const done = (msg: string) => { setModal(null); setFlash(msg); load(); };
  const setStat = async (a: Appointment, s: string) => {
    try { await api.patch(`/admin/appointments/${a.id}`, { status: s }); done(`Marcada como "${statusLabel[s]}"`); } catch (e) { setError(errMsg(e)); }
  };
  const toggleCash = async (a: Appointment) => {
    try {
      await api.post(`/admin/appointments/${a.id}/${cashPayment(a) ? 'unmark-paid' : 'mark-paid'}`);
      done(cashPayment(a) ? 'Cobro deshecho' : `Cita de ${a.client.name} marcada como cobrada`);
    } catch (e) { setError(errMsg(e)); }
  };
  const quick = (days: number) => { const d = localISODate(new Date(), days); setFrom(d); setTo(d); };

  // Agrupar por día
  const byDay = new Map<string, Appointment[]>();
  list?.forEach((a) => { const k = isoToLocalDate(a.startAt); byDay.set(k, [...(byDay.get(k) ?? []), a]); });

  return (
    <div>
      <div className="page-head">
        <h1>Agenda</h1>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>Nueva cita</button>
      </div>
      <div className="filters">
        <button className="btn btn-sm" onClick={() => quick(0)}>Hoy</button>
        <button className="btn btn-sm" onClick={() => quick(1)}>Mañana</button>
        <button className="btn btn-sm" onClick={() => { setFrom(localISODate()); setTo(localISODate(new Date(), 7)); }}>7 días</button>
        <label>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Estado
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {!list && <Spinner />}
      {list?.length === 0 && <p className="empty">No hay citas en este periodo.</p>}

      {[...byDay.entries()].map(([day, appts]) => (
        <section key={day}>
          <h2 className="day-title">{dateLong(`${day}T12:00:00Z`)} <small className="muted">({appts.filter((a) => a.status === 'CONFIRMED').length} confirmadas)</small></h2>
          <div className="agenda">
            {appts.map((a) => {
              const paid = onlinePayment(a);
              const pay = paymentInfo(a);
              const active = ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status);
              const wa = waUrl(a.client.phone, `Hola ${a.client.name}, te escribimos de la peluquería por tu cita del ${dateShort(a.startAt)} a las ${time(a.startAt)}.`);
              return (
                <article key={a.id} className={`card agenda-item ${a.status === 'CANCELLED' ? 'dim' : ''}`}>
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
                    {active && <button className="btn btn-sm" onClick={() => setModal({ kind: 'move', appt: a })}>Cambiar hora</button>}
                    {a.status === 'CONFIRMED' && new Date(a.startAt) < new Date() && (
                      <>
                        <button className="btn btn-sm" onClick={() => setStat(a, 'COMPLETED')}>Realizada</button>
                        <button className="btn btn-sm" onClick={() => setStat(a, 'NO_SHOW')}>No vino</button>
                      </>
                    )}
                    {a.paymentMethod === 'cash' && a.status !== 'CANCELLED' && (
                      <button className="btn btn-sm" onClick={() => toggleCash(a)}>{cashPayment(a) ? 'Deshacer cobro' : 'Marcar cobrada'}</button>
                    )}
                    {paid && paid.refundedCents < paid.amountCents && (
                      <button className="btn btn-sm" onClick={() => setModal({ kind: 'refund', appt: a, payment: paid })}>Reembolsar</button>
                    )}
                    {active && <button className="btn btn-sm btn-danger" onClick={() => setModal({ kind: 'cancel', appt: a })}>Cancelar</button>}
                    {wa && <a className="btn btn-sm btn-wa" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {modal?.kind === 'new' && <NewAppointmentModal onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'move' && <MoveModal appt={modal.appt!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'cancel' && <CancelModal appt={modal.appt!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'refund' && <RefundModal payment={modal.payment!} onClose={() => setModal(null)} onDone={done} />}
    </div>
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
