import { useEffect, useState } from 'react';
import { Alert, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { AudiencePicker, defaultAudience } from './Audience';

interface Log { id: string; channel: string; subject: string | null; body: string; recipients: number; createdAt: string }

const templates = [
  { label: 'Cierre por vacaciones', subject: 'Cerramos por vacaciones', body: 'Hola {nombre},\n\nTe informamos de que la peluquería permanecerá cerrada del ... al ... .\n\n¡Gracias y hasta pronto!' },
  { label: 'Recordatorio', subject: 'Recordatorio de tu cita', body: 'Hola {nombre},\n\nTe recordamos que tienes cita mañana. Si no puedes venir, cancélala desde la app.\n\n¡Te esperamos!' },
  { label: 'Promoción', subject: 'Oferta especial', body: 'Hola {nombre},\n\nEste mes tenemos ... . Reserva desde la app.\n\nUn saludo.' },
];

export function Messages() {
  const [aud, setAud] = useState(defaultAudience);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadLogs = () => api.get<Log[]>('/admin/messages').then(setLogs).catch(() => {});
  useEffect(() => { loadLogs(); }, []);
  useEffect(() => {
    setCount(null);
    if (aud.audience === 'selected' && !aud.userIds.length) return setCount(0);
    api.post<{ count: number }>('/admin/messages/email/preview', aud).then((r) => setCount(r.count)).catch(() => {});
  }, [aud]);

  const send = async () => {
    if (!confirm(`¿Enviar el email a ${count} cliente(s)?`)) return;
    setBusy(true); setError(''); setFlash('');
    try {
      const r = await api.post<{ sent: number; failed: string[]; simulated: boolean }>('/admin/messages/email', { ...aud, subject, body });
      setFlash(`Enviado a ${r.sent} cliente(s).${r.failed.length ? ` Fallaron: ${r.failed.join(', ')}` : ''}${r.simulated ? ' (Modo prueba: SMTP sin configurar, los emails se han mostrado en la consola del servidor.)' : ''}`);
      setSubject(''); setBody(''); loadLogs();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <h1>Avisos por email</h1>
      <div className="card">
        <Alert kind="ok">{flash}</Alert>
        <Alert>{error}</Alert>
        <AudiencePicker value={aud} onChange={setAud} allLabel="Todos los clientes que aceptan emails" />
        <div className="templates">Plantillas: {templates.map((t) => <button key={t.label} className="btn btn-sm" onClick={() => { setSubject(t.subject); setBody(t.body); }}>{t.label}</button>)}</div>
        <label>Asunto<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        <label>Mensaje <small className="muted">— escribe {'{nombre}'} para personalizarlo</small><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !subject || !body || !count} onClick={send}>
          {busy ? 'Enviando…' : `Enviar a ${count ?? '…'} cliente(s)`}
        </button>
      </div>
      <h2>Últimos envíos</h2>
      <table className="table">
        <thead><tr><th>Fecha</th><th>Canal</th><th>Asunto / mensaje</th><th>Destinatarios</th></tr></thead>
        <tbody>
          {logs.map((l) => <tr key={l.id}><td>{dateTime(l.createdAt)}</td><td>{l.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}</td><td>{l.subject ?? l.body.slice(0, 60)}</td><td>{l.recipients}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
