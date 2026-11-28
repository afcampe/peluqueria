import { useState } from 'react';
import { api } from '../lib/api';
import { dateLong, time } from '../lib/format';
import { Alert, Modal, Spinner, errMsg } from './ui';

type Channel = 'EMAIL' | 'WHATSAPP';
interface Row { appointmentId: string; name: string; startAt: string; service: string; to: string | null; reason: string | null; link?: string | null }
interface Preview { date: string; channel: Channel; rows: Row[]; simulated: boolean; sample: { subject: string | null; body: string } | null }
interface Result { total: number; sent: number; skipped: { name: string; detail: string }[]; failed: { name: string; detail: string }[]; simulated: boolean }

/**
 * Botones de la Agenda (vista «Mañana») para recordar de una vez todas las
 * citas reservadas del día siguiente, por WhatsApp o por email.
 */
export function TomorrowReminders({ count }: { count: number }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (c: Channel) => {
    setChannel(c); setPreview(null); setResult(null); setError(''); setOpened(new Set());
    try { setPreview(await api.get<Preview>(`/admin/reminders/tomorrow?channel=${c}`)); } catch (e) { setError(errMsg(e)); }
  };
  const send = async () => {
    setBusy(true); setError('');
    try { setResult(await api.post<Result>('/admin/reminders/tomorrow', { channel })); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const close = () => setChannel(null);

  const ready = preview?.rows.filter((r) => !r.reason).length ?? 0;
  const manualWa = channel === 'WHATSAPP' && preview?.simulated; // sin API: un chat por cliente
  const label = channel === 'EMAIL' ? 'email' : 'WhatsApp';

  return (
    <div className="tomorrow-reminders">
      <span className="muted small">Recordar las {count} cita{count === 1 ? '' : 's'} de mañana:</span>
      <button type="button" className="btn btn-sm btn-wa" onClick={() => open('WHATSAPP')}>WhatsApp a todos</button>
      <button type="button" className="btn btn-sm btn-mail" onClick={() => open('EMAIL')}>Email a todos</button>

      {channel && (
        <Modal title={`Recordatorio por ${label} · citas de mañana`} onClose={close}>
          <Alert>{error}</Alert>
          {!preview && !error && <Spinner />}
          {preview && (
            <>
              <p className="muted">{dateLong(`${preview.date}T12:00:00Z`)}</p>
              {preview.rows.length === 0 && <p className="empty">No hay citas reservadas para mañana.</p>}

              {result ? (
                <>
                  <Alert kind={result.sent ? 'ok' : 'info'}>
                    {result.simulated ? 'Los emails no han salido: falta configurar el SMTP en el servidor.'
                      : `Enviado${result.sent === 1 ? '' : 's'} ${result.sent} de ${result.total}.`}
                  </Alert>
                  {!result.simulated && result.skipped.length > 0 && <p className="small">Sin enviar: {result.skipped.map((x) => `${x.name} (${x.detail})`).join('; ')}</p>}
                  {result.failed.length > 0 && <p className="small error-text">Fallos: {result.failed.map((x) => `${x.name} (${x.detail})`).join('; ')}</p>}
                </>
              ) : preview.rows.length > 0 && (
                <>
                  {channel === 'EMAIL' && preview.simulated && <Alert kind="info">El SMTP no está configurado: los emails no llegarán a los clientes.</Alert>}
                  {manualWa && <Alert kind="info">La API de WhatsApp no está configurada: pulsa «Abrir chat» en cada cliente y envía el mensaje, que ya va escrito.</Alert>}
                  {preview.sample && (
                    <details className="tomorrow-sample">
                      <summary>Ver el mensaje{preview.rows.length > 1 ? ' (ejemplo con la primera cita)' : ''}</summary>
                      {preview.sample.subject && <p><span className="muted">Asunto:</span> {preview.sample.subject}</p>}
                      <div className="mail-preview">{preview.sample.body}</div>
                    </details>
                  )}
                  <ul className="wa-list">
                    {preview.rows.map((r) => (
                      <li key={r.appointmentId} className={opened.has(r.appointmentId) ? 'dim' : ''}>
                        <span><strong>{time(r.startAt)}</strong> {r.name} <small className="muted">{r.to ?? ''}</small></span>
                        {r.reason ? <span className="error-text small">{r.reason}</span>
                          : manualWa && r.link ? (
                            <a className="btn btn-sm btn-wa" href={r.link} target="_blank" rel="noreferrer" onClick={() => setOpened(new Set(opened).add(r.appointmentId))}>
                              {opened.has(r.appointmentId) ? 'Abierto ✓' : 'Abrir chat'}
                            </a>
                          ) : <span className="muted small nowrap">{r.service}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={close}>{result || !preview || manualWa || !ready ? 'Cerrar' : 'Cancelar'}</button>
            {preview && !result && !manualWa && ready > 0 && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>
                {busy ? 'Enviando…' : `Enviar ${ready} ${channel === 'EMAIL' ? 'email' : 'WhatsApp'}${ready === 1 || channel === 'WHATSAPP' ? '' : 's'}`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
