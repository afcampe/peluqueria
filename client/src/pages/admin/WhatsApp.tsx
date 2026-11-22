import { useEffect, useState } from 'react';
import { Alert, confirmDialog, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { AudiencePicker, defaultAudience } from './Audience';

interface LinkRow { id: string; name: string; phone: string | null; link: string | null }

export function WhatsApp() {
  const [aud, setAud] = useState(defaultAudience);
  const [body, setBody] = useState('Hola {nombre}, ');
  const [rows, setRows] = useState<LinkRow[] | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [apiOn, setApiOn] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api.get<{ apiConfigured: boolean }>('/admin/whatsapp/status').then((r) => setApiOn(r.apiConfigured)).catch(() => {}); }, []);

  const generate = async () => {
    setError(''); setFlash('');
    try { setRows(await api.post<LinkRow[]>('/admin/whatsapp/links', { ...aud, body })); setOpened(new Set()); } catch (e) { setError(errMsg(e)); }
  };
  const sendApi = async () => {
    if (!(await confirmDialog({ title: 'Enviar por WhatsApp', message: 'Se enviará el mensaje automáticamente por la API de WhatsApp a los clientes elegidos. ¿Continuar?', confirmLabel: 'Sí, enviar' }))) return;
    try {
      const r = await api.post<{ sent: number; failed: { name: string; error: string }[] }>('/admin/whatsapp/send', { ...aud, body });
      setFlash(`Enviados ${r.sent}.${r.failed.length ? ` Fallos: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : ''}`);
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <h1>WhatsApp</h1>
      <p className="muted">
        Genera un enlace por cliente con el mensaje ya escrito: al pulsarlo se abre WhatsApp (web, escritorio o móvil) y solo tienes que enviarlo.
        {apiOn ? ' La API de WhatsApp Business está conectada: también puedes enviar automáticamente.' : ' Para envíos automáticos configura la API de WhatsApp Business en el servidor.'}
      </p>
      <div className="card">
        <Alert kind="ok">{flash}</Alert>
        <Alert>{error}</Alert>
        <AudiencePicker value={aud} onChange={setAud} allLabel="Todos los clientes" />
        <label>Mensaje <small className="muted">— {'{nombre}'} se sustituye por el nombre</small><textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <div className="actions">
          <button className="btn btn-primary" onClick={generate} disabled={!body.trim()}>Preparar enlaces</button>
          {apiOn && <button className="btn" onClick={sendApi} disabled={!body.trim()}>Enviar automáticamente (API)</button>}
        </div>
      </div>
      {rows && (
        <div className="card">
          <h2>{rows.length} cliente(s)</h2>
          <ul className="wa-list">
            {rows.map((r) => (
              <li key={r.id} className={opened.has(r.id) ? 'dim' : ''}>
                <span>{r.name} <small className="muted">{r.phone ?? 'sin teléfono'}</small></span>
                {r.link ? (
                  <a className="btn btn-sm btn-wa" href={r.link} target="_blank" rel="noreferrer" onClick={() => setOpened(new Set(opened).add(r.id))}>
                    {opened.has(r.id) ? 'Abierto ✓' : 'Abrir chat'}
                  </a>
                ) : <span className="error-text small">teléfono no válido</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
