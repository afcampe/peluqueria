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

      {[...seriesGroups.values()].map((g) => (
        <section key={g.id} className="card series-card">
          <div>
            <span className="series-badge">🔁 Citas periódicas · cada {g.intervalDays} días</span>
            <h3>{g.service}: {g.appts.length} citas próximas</h3>
            <p className="muted small">Próxima: {dateTime(g.appts[0].startAt)} · Última: {dateTime(g.appts.at(-1)!.startAt)}</p>
          </div>
          <button className="btn btn-danger" onClick={() => setCancellingSeries(g)}>Cancelar todas</button>
        </section>
      ))}

      <div className="appt-list">
        {upcoming.map((a) => {
          const changeable = canClientChange(a.startAt, notice);
          return (
            <article key={a.id} className="card appt">
              <div>
                <h3>{dateTime(a.startAt)}</h3>
                <p>{a.service.name} · {money(a.priceCents)} · {methodLabel(a.paymentMethod)} {paid(a) && '(pagada)'}</p>
                <Badge status={a.status}>{statusLabel[a.status]}</Badge>
                {a.series && <span className="series-badge"> 🔁 cada {a.series.intervalDays} días</span>}
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
          <p>¿Seguro que quieres cancelar la cita del <strong>{dateTime(cancelling.startAt)}</strong>?</p>
          {paid(cancelling) && <p>Te devolveremos {money(paid(cancelling)!.amountCents - paid(cancelling)!.refundedCents)} a tu cuenta de PayPal.</p>}
          <CancelButton id={cancelling.id} onDone={(msg) => { setCancelling(null); setFlash(msg); load(); }} />
        </Modal>
      )}
    </div>
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
          onDone(`${r.cancelled} cita(s) cancelada(s).${r.refundedCents ? ` Reembolsados ${money(r.refundedCents)}.` : ''}${r.skipped ? ` ${r.skipped} no se pudieron cancelar por falta de antelación.` : ''}`);
        } catch (e) { setError(errMsg(e)); setBusy(false); }
      }}>{busy ? 'Cancelando…' : 'Sí, cancelar todas'}</button>
    </>
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
