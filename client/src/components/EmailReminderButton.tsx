import { useState } from 'react';
import { api } from '../lib/api';
import { Alert, Modal, Spinner, errMsg } from './ui';

interface Preview { appointmentId: string; to: string; subject: string; body: string; simulated: boolean; actions: string[] }

/**
 * Envía a mano el recordatorio por email de una cita o, con clientId, de la
 * próxima cita del cliente. Muestra el texto antes de enviarlo.
 */
export function EmailReminderButton({ appointmentId, clientId, disabledReason, small = true }: {
  appointmentId?: string; clientId?: string; disabledReason?: string; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ to: string; simulated: boolean } | null>(null);

  const start = async () => {
    setOpen(true); setPreview(null); setError(''); setResult(null);
    const q = new URLSearchParams(appointmentId ? { appointmentId } : { clientId: clientId ?? '' });
    try { setPreview(await api.get<Preview>(`/admin/reminders/preview?${q}`)); } catch (e) { setError(errMsg(e)); }
  };
  const send = async () => {
    setBusy(true); setError('');
    try { setResult(await api.post(`/admin/appointments/${preview!.appointmentId}/remind-email`)); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const close = () => setOpen(false);

  return (
    <>
      <button type="button" className={`btn ${small ? 'btn-sm ' : ''}btn-mail`} disabled={!!disabledReason} onClick={start}
        title={disabledReason ?? 'Enviar recordatorio de la cita por email'}>Email</button>
      {open && (
        <Modal title="Recordatorio por email" onClose={close}>
          <Alert>{error}</Alert>
          {!preview && !error && <Spinner />}
          {result ? (
            <Alert kind={result.simulated ? 'info' : 'ok'}>
              {result.simulated ? 'El email no ha salido: falta configurar el SMTP en el servidor.' : `Recordatorio enviado a ${result.to}.`}
            </Alert>
          ) : preview && (
            <>
              {preview.simulated && <Alert kind="info">El SMTP no está configurado: el email no llegará al cliente.</Alert>}
              <p><span className="muted">Para:</span> {preview.to}<br /><span className="muted">Asunto:</span> {preview.subject}</p>
              <div className="mail-preview">{preview.body}{preview.actions.length > 0 && <p className="mail-actions">{preview.actions.map((x) => <span key={x}>{x}</span>)}</p>}</div>
            </>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={close}>{result || !preview ? 'Cerrar' : 'Cancelar'}</button>
            {preview && !result && <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Enviando…' : 'Enviar email'}</button>}
          </div>
        </Modal>
      )}
    </>
  );
}
