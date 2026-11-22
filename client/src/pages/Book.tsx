import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PayPalCheckout } from '../components/PayPalCheckout';
import { SlotPicker } from '../components/SlotPicker';
import { Alert, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, money, noticeText } from '../lib/format';
import { useSession } from '../lib/session';
import type { Appointment } from '../lib/types';

export function Book() {
  const { config } = useSession();
  const nav = useNavigate();
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<Appointment | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!config) return null;
  const service = config.services.find((s) => s.id === serviceId);
  const pm = config.paymentMethods.find((m) => m.id === method);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const a = await api.post<Appointment>('/appointments', { serviceId, startAt: start, paymentMethod: method, notes: notes || undefined });
      if (a.status === 'PENDING_PAYMENT') setPending(a);
      else nav('/mis-citas', { state: { flash: 'Cita reservada. Te hemos enviado un email de confirmación.' } });
    } catch (e) {
      setError(errMsg(e));
      if ((e as { code?: string }).code?.startsWith('SLOT_')) setStart(null);
    } finally {
      setBusy(false);
    }
  };

  if (pending && pm?.id === 'paypal') {
    return (
      <div className="card narrow">
        <h1>Pago de la cita</h1>
        <p><strong>{pending.service.name}</strong> — {dateTime(pending.startAt)}</p>
        <p className="total">Total: {money(pending.priceCents)}</p>
        <p className="muted">Guardamos tu hueco durante unos minutos mientras completas el pago.</p>
        <PayPalCheckout
          appointmentId={pending.id}
          clientId={pm.config.clientId}
          currency={config.currency}
          onPaid={() => nav('/mis-citas', { state: { flash: 'Pago completado y cita confirmada.' } })}
        />
        <button className="btn" onClick={async () => { await api.post(`/appointments/${pending.id}/cancel`).catch(() => {}); setPending(null); }}>
          Cancelar y elegir otra hora
        </button>
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
          <h2><span className="step-n">2</span> Día y hora</h2>
          <SlotPicker value={start} onPick={setStart} />
        </section>
      )}

      {service && start && (
        <section className="card step">
          <h2><span className="step-n">3</span> Forma de pago</h2>
          {config.paymentMethods.length === 0 && <p className="error-text">No hay formas de pago disponibles ahora mismo.</p>}
          <div className="options">
            {config.paymentMethods.map((m) => (
              <button key={m.id} type="button" className={`option ${method === m.id ? 'selected' : ''}`} onClick={() => setMethod(m.id)}>
                <span>{m.label}</span><small>{m.online ? 'Pagas ahora' : 'Pagas en la peluquería'}</small>
              </button>
            ))}
          </div>
          <label>Comentarios (opcional)<textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </section>
      )}

      {service && start && method && (
        <section className="card summary">
          <p><strong>{service.name}</strong> · {dateTime(start)} · {money(service.priceCents)}</p>
          <p className="muted small">Podrás modificar o cancelar hasta {noticeText(config.clientCancelMinNoticeMinutes)} antes. Si pagaste online, te devolvemos el importe.</p>
          <button className="btn btn-primary btn-lg" onClick={confirm} disabled={busy}>
            {busy ? 'Reservando…' : pm?.online ? 'Continuar al pago' : 'Confirmar reserva'}
          </button>
        </section>
      )}
      <p className="muted"><Link to="/mis-citas">Ver mis citas</Link></p>
    </div>
  );
}
