import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SlotPicker } from '../components/SlotPicker';
import { Alert, Badge, Modal, Spinner, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { canClientChange, dateTime, isoToLocalDate, methodLabel, money, noticeText, statusLabel } from '../lib/format';
import { useSession } from '../lib/session';
import type { Appointment } from '../lib/types';

export function MyAppointments() {
  const { config } = useSession();
  const location = useLocation();
  const [list, setList] = useState<Appointment[] | null>(null);
  const [flash, setFlash] = useState<string>((location.state as { flash?: string })?.flash ?? '');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);

  const load = useCallback(() => api.get<Appointment[]>('/appointments').then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!config) return null;
  const notice = config.clientCancelMinNoticeMinutes;
  const now = Date.now();
  const upcoming = (list ?? []).filter((a) => ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status) && new Date(a.endAt).getTime() > now).reverse();
  const past = (list ?? []).filter((a) => !upcoming.includes(a));

  const paid = (a: Appointment) => a.payments.find((p) => ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status));

  return (
    <div>
      <div className="page-head">
        <h1>Mis citas</h1>
        <Link to="/reservar" className="btn btn-primary">Nueva cita</Link>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {!list && <Spinner />}
      {list && upcoming.length === 0 && <p className="empty">No tienes citas próximas.</p>}

      <div className="appt-list">
        {upcoming.map((a) => {
          const changeable = canClientChange(a.startAt, notice);
          return (
            <article key={a.id} className="card appt">
              <div>
                <h3>{dateTime(a.startAt)}</h3>
                <p>{a.service.name} · {money(a.priceCents)} · {methodLabel(a.paymentMethod)} {paid(a) && '(pagada)'}</p>
                <Badge status={a.status}>{statusLabel[a.status]}</Badge>
              </div>
              <div className="actions">
                {changeable ? (
                  <>
                    <button className="btn" onClick={() => setEditing(a)}>Cambiar hora</button>
                    <button className="btn btn-danger" onClick={() => setCancelling(a)}>Cancelar</button>
                  </>
                ) : (
                  <p className="muted small">Faltan menos de {noticeText(notice)}: para cambios llama a la peluquería{config.shop.phone && <> (<a href={`tel:${config.shop.phone}`}>{config.shop.phone}</a>)</>}.</p>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {past.length > 0 && (
        <>
          <h2>Historial</h2>
          <table className="table">
            <thead><tr><th>Fecha</th><th>Servicio</th><th>Estado</th></tr></thead>
            <tbody>
              {past.map((a) => (
                <tr key={a.id}>
                  <td>{dateTime(a.startAt)}</td>
                  <td>{a.service.name}</td>
                  <td><Badge status={a.status}>{statusLabel[a.status]}</Badge>{a.payments.some((p) => p.refundedCents > 0) && <small className="muted"> · reembolsada</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {editing && <RescheduleModal appt={editing} onClose={() => setEditing(null)} onDone={(msg) => { setEditing(null); setFlash(msg); load(); }} />}
      {cancelling && (
        <Modal title="Cancelar cita" onClose={() => setCancelling(null)}>
          <p>¿Seguro que quieres cancelar la cita del <strong>{dateTime(cancelling.startAt)}</strong>?</p>
          {paid(cancelling) && <p>Te devolveremos {money(paid(cancelling)!.amountCents - paid(cancelling)!.refundedCents)} a tu cuenta de PayPal.</p>}
          <CancelButton id={cancelling.id} onDone={(msg) => { setCancelling(null); setFlash(msg); load(); }} />
        </Modal>
      )}
    </div>
  );
}

function CancelButton({ id, onDone }: { id: string; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <Alert>{error}</Alert>
      <button className="btn btn-danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ refundedCents: number }>(`/appointments/${id}/cancel`);
          onDone(r.refundedCents ? `Cita cancelada. Se han reembolsado ${money(r.refundedCents)}.` : 'Cita cancelada.');
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{busy ? 'Cancelando…' : 'Sí, cancelar cita'}</button>
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
