import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MyUpcoming } from '../components/MyUpcoming';
import { PayPalCheckout } from '../components/PayPalCheckout';
import { RecurrencePlanner, type SeriesPlan } from '../components/RecurrencePlanner';
import { SlotPicker } from '../components/SlotPicker';
import { Alert, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, money, noticeText } from '../lib/format';
import { useSession } from '../lib/session';
import type { Appointment, SeriesResult } from '../lib/types';
import { IconRepeat } from '../components/icons';

/** Lo que queda pendiente de pagar online: una cita suelta o una serie. */
type Pending =
  | { kind: 'single'; appt: Appointment }
  | { kind: 'series'; result: SeriesResult };

export function Book() {
  const { config } = useSession();
  const nav = useNavigate();
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!config) return null;
  const service = config.services.find((s) => s.id === serviceId);
  const pm = config.paymentMethods.find((m) => m.id === method);
  const canRepeat = config.recurring.enabled;
  const count = repeat ? plan?.starts.length ?? 0 : 1;
  const ready = service && start && method && (!repeat || plan);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      if (repeat && plan) {
        const r = await api.post<SeriesResult>('/appointments/series', {
          serviceId, intervalDays: plan.intervalDays, starts: plan.starts, paymentMethod: method, notes: notes || undefined,
        });
        if (r.pendingPayment) setPending({ kind: 'series', result: r });
        else nav('/mis-citas', { state: { flash: `${r.appointments.length} citas reservadas. Te hemos enviado un email con todas las fechas.` } });
      } else {
        const a = await api.post<Appointment>('/appointments', { serviceId, startAt: start, paymentMethod: method, notes: notes || undefined });
        if (a.status === 'PENDING_PAYMENT') setPending({ kind: 'single', appt: a });
        else nav('/mis-citas', { state: { flash: 'Cita reservada. Te hemos enviado un email de confirmación.' } });
      }
    } catch (e) {
      setError(errMsg(e));
      // Si alguien ocupó el hueco mientras tanto, se fuerza a elegir de nuevo.
      if (!repeat && (e as { code?: string }).code?.startsWith('SLOT_')) setStart(null);
    } finally {
      setBusy(false);
    }
  };

  if (pending && pm?.id === 'paypal') {
    const isSeries = pending.kind === 'series';
    const total = isSeries ? pending.result.totalCents : pending.appt.priceCents;
    const abandon = async () => {
      const path = isSeries ? `/appointments/series/${pending.result.series.id}/cancel` : `/appointments/${pending.appt.id}/cancel`;
      await api.post(path).catch(() => {});
      setPending(null);
    };
    return (
      <div className="card narrow">
        <h1>Pago {isSeries ? 'de las citas' : 'de la cita'}</h1>
        {isSeries ? (
          <p><strong>{pending.result.appointments.length} citas de {pending.result.appointments[0].service.name}</strong>, cada {pending.result.series.intervalDays} días, del {dateTime(pending.result.appointments[0].startAt)} al {dateTime(pending.result.appointments.at(-1)!.startAt)}.</p>
        ) : (
          <p><strong>{pending.appt.service.name}</strong> — {dateTime(pending.appt.startAt)}</p>
        )}
        <p className="total">Total: {money(total)}</p>
        <p className="muted">Guardamos tus huecos durante unos minutos mientras completas el pago.{isSeries && ' Si luego cancelas alguna cita, te devolvemos su parte.'}</p>
        <PayPalCheckout<{ lostCount?: number }>
          basePath={isSeries ? `/appointments/series/${pending.result.series.id}` : `/appointments/${pending.appt.id}`}
          clientId={pm.config.clientId}
          currency={config.currency}
          onPaid={(r) => nav('/mis-citas', {
            state: { flash: r.lostCount ? `Pago completado. ${r.lostCount} cita(s) ya no estaban libres y te hemos devuelto su importe. Tu ticket está disponible en cada cita.` : 'Pago completado y citas confirmadas. Ya puedes descargar tu ticket de compra.' },
          })}
        />
        <button className="btn" onClick={abandon}>Cancelar y volver</button>
      </div>
    );
  }

  return (
    <div className="book">
      <h1>Reservar cita</h1>
      <Alert>{error}</Alert>

      <section className="card step">
        <h2><span className="step-n">1</span> Servicio</h2>
        <div className="options">
          {config.services.map((s) => (
            <button key={s.id} type="button" className={`option ${serviceId === s.id ? 'selected' : ''}`} onClick={() => setServiceId(s.id)}>
              <span>{s.name}</span><strong>{money(s.priceCents)}</strong>
            </button>
          ))}
        </div>
      </section>

      {service && (
        <section className="card step">
          <h2><span className="step-n">2</span> {repeat ? 'Primera cita' : 'Día y hora'}</h2>
          <SlotPicker value={start} onPick={setStart} />
        </section>
      )}

      {service && start && canRepeat && (
        <section className="card step">
          <h2><span className="step-n">3</span> ¿Una cita o varias?</h2>
          <div className="options">
            <button type="button" className={`option ${!repeat ? 'selected' : ''}`} onClick={() => setRepeat(false)}>
              <span>Solo esta cita</span><small>{dateTime(start)}</small>
            </button>
            <button type="button" className={`option ${repeat ? 'selected' : ''}`} onClick={() => setRepeat(true)}>
              <span className="with-icon"><IconRepeat size={18} /> Citas periódicas</span><small>Reserva de una vez, por ejemplo, cada 15 días todo el año</small>
            </button>
          </div>
          {repeat && <RecurrencePlanner firstStart={start} priceCents={service.priceCents} onChange={setPlan} />}
        </section>
      )}

      {service && start && (!repeat || plan) && (
        <section className="card step">
          <h2><span className="step-n">{canRepeat ? 4 : 3}</span> Forma de pago</h2>
          {config.paymentMethods.length === 0 && <p className="error-text">No hay formas de pago disponibles ahora mismo.</p>}
          <div className="options">
            {config.paymentMethods.map((m) => (
              <button key={m.id} type="button" className={`option ${method === m.id ? 'selected' : ''}`} onClick={() => setMethod(m.id)}>
                <span>{m.label}</span>
                <small>{m.online ? (repeat ? `Pagas ahora las ${count} citas` : 'Pagas ahora') : repeat ? 'Pagas cada cita en la peluquería' : 'Pagas en la peluquería'}</small>
              </button>
            ))}
          </div>
          <label>Comentarios (opcional)<textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </section>
      )}

      {ready && (
        <section className="card summary">
          <p>
            <strong>{service.name}</strong> ·{' '}
            {repeat ? <>{count} citas, cada {plan!.intervalDays} días, desde el {dateTime(plan!.starts[0])}</> : dateTime(start)}
            {' '}· {money(service.priceCents * count)}
          </p>
          <p className="muted small">Podrás modificar o cancelar cada cita hasta {noticeText(config.clientCancelMinNoticeMinutes)} antes. Si pagaste online, te devolvemos su importe.</p>
          <button className="btn btn-primary btn-lg" onClick={confirm} disabled={busy}>
            {busy ? 'Reservando…' : pm?.online ? 'Continuar al pago' : repeat ? `Reservar ${count} citas` : 'Confirmar reserva'}
          </button>
        </section>
      )}
      <MyUpcoming refresh={pending} />
    </div>
  );
}
