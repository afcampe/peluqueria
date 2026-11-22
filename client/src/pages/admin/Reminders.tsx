import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateShort, time } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { ReminderSettings } from '../../lib/types';

/* Configuración de los recordatorios automáticos de las próximas citas. */

const UNITS = [
  { id: 'd', label: 'días', minutes: 1440 },
  { id: 'h', label: 'horas', minutes: 60 },
  { id: 'm', label: 'minutos', minutes: 1 },
] as const;
const split = (m: number) => (m % 1440 === 0 ? { n: m / 1440, unit: 'd' } : m % 60 === 0 ? { n: m / 60, unit: 'h' } : { n: m, unit: 'm' }) as { n: number; unit: 'd' | 'h' | 'm' };
const toMinutes = (n: number, unit: 'd' | 'h' | 'm') => Math.round(n * UNITS.find((u) => u.id === unit)!.minutes);
const offsetLabel = (m: number) => {
  const { n, unit } = split(m);
  return unit === 'd' ? `${n} día${n === 1 ? '' : 's'}` : unit === 'h' ? `${n} h` : `${n} min`;
};

const PLACEHOLDERS = ['{nombre}', '{fecha}', '{hora}', '{servicio}', '{peluqueria}', '{telefono}', '{direccion}'];

interface LogRow {
  id: string; createdAt: string; startAt: string; offsetMinutes: number; offsetLabel: string;
  channel: 'EMAIL' | 'WHATSAPP'; status: 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED'; detail: string | null;
  appointment: { id: string; startAt: string; client: { id: string; name: string } };
}
const statusText = { SENDING: 'Enviando', SENT: 'Enviado', FAILED: 'Falló', SKIPPED: 'No enviado' };
const statusClass = { SENDING: 'pending_payment', SENT: 'confirmed', FAILED: 'cancelled', SKIPPED: 'warn' };

export function Reminders({ value: r, channels, onChange }: {
  value: ReminderSettings; channels: { email: boolean; whatsappApi: boolean }; onChange: (r: ReminderSettings) => void;
}) {
  const { config, user } = useSession();
  const set = (patch: Partial<ReminderSettings>) => onChange({ ...r, ...patch });
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [testPhone, setTestPhone] = useState(user?.phone ?? '');
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { api.get<LogRow[]>('/admin/reminders').then(setLog).catch(() => setLog([])); }, []);

  const setOffset = (i: number, n: number, unit: 'd' | 'h' | 'm') =>
    set({ offsetsMinutes: r.offsetsMinutes.map((m, j) => (j === i ? toMinutes(n, unit) : m)) });

  // Vista previa con una cita de ejemplo
  const sample = (text: string) => {
    const d = new Date(Date.now() + 86_400_000);
    const vars: Record<string, string> = {
      nombre: 'Javier', servicio: config?.services[0]?.name ?? 'Corte de pelo',
      fecha: new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(d), hora: '10:30',
      peluqueria: config?.shop.name ?? '', telefono: config?.shop.phone ?? '', direccion: config?.shop.address ?? '',
    };
    return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  };

  const test = async (channel: 'EMAIL' | 'WHATSAPP') => {
    setTesting(true); setTestMsg(null);
    try {
      const res = await api.post<{ detail: string }>('/admin/reminders/test', { channel, phone: testPhone || undefined, reminders: r });
      setTestMsg({ kind: 'ok', text: `Aviso de prueba enviado a ${res.detail}.${channel === 'EMAIL' && !channels.email ? ' (SMTP sin configurar: el email solo se muestra en la consola del servidor.)' : ''}` });
    } catch (e) { setTestMsg({ kind: 'error', text: errMsg(e) }); }
    setTesting(false);
  };

  const sorted = [...r.offsetsMinutes].sort((a, b) => b - a);

  return (
    <section className="card reminders">
      <h2>Recordatorios de citas</h2>
      <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enviar automáticamente un aviso a los clientes antes de su cita</label>
      <p className="muted small">Se envía a las citas confirmadas, una vez por cada antelación. Si se cambia la hora de la cita, se vuelve a avisar con la nueva hora; las canceladas no se avisan. Si la cita se reserva cuando ya ha pasado el momento del aviso (p. ej. con menos de 1 día), ese aviso no se manda porque el cliente ya recibe la confirmación.</p>

      <fieldset className="reminder-block" disabled={!r.enabled}>
        <legend>Por dónde</legend>
        <label className="check"><input type="checkbox" checked={r.email} onChange={(e) => set({ email: e.target.checked })} /> Email</label>
        {r.email && !channels.email && <p className="small warn-text">El SMTP no está configurado: los emails solo se muestran en la consola del servidor. Configúralo en <code>server/.env</code>.</p>}
        <label className="check"><input type="checkbox" checked={r.whatsapp} onChange={(e) => set({ whatsapp: e.target.checked })} /> WhatsApp</label>
        {r.whatsapp && !channels.whatsappApi && (
          <p className="small warn-text">Para enviar WhatsApp automáticamente hace falta la API de WhatsApp Business (<code>WHATSAPP_TOKEN</code> y <code>WHATSAPP_PHONE_NUMBER_ID</code> en <code>server/.env</code>). Mientras no esté, estos avisos no se envían y quedan anotados como «No enviado».</p>
        )}
        {!r.email && !r.whatsapp && <p className="small warn-text">Elige al menos un canal.</p>}
        <p className="muted small">Los clientes sin email o sin teléfono válido no reciben ese aviso. Son avisos de servicio: se mandan aunque el cliente no quiera recibir novedades por email.</p>
      </fieldset>

      <fieldset className="reminder-block" disabled={!r.enabled}>
        <legend>Con cuánta antelación</legend>
        <div className="offsets">
          {r.offsetsMinutes.map((m, i) => {
            const { n, unit } = split(m);
            return (
              <div key={i} className="offset">
                <input type="number" min={1} aria-label="Cantidad" value={n} onChange={(e) => setOffset(i, Math.max(1, Number(e.target.value) || 1), unit)} />
                <select aria-label="Unidad" value={unit} onChange={(e) => setOffset(i, n, e.target.value as 'd' | 'h' | 'm')}>
                  {UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </select>
                <span className="muted">antes</span>
                {r.offsetsMinutes.length > 1 && <button type="button" className="btn-icon" aria-label="Quitar aviso" onClick={() => set({ offsetsMinutes: r.offsetsMinutes.filter((_, j) => j !== i) })}>✕</button>}
              </div>
            );
          })}
          {r.offsetsMinutes.length < 3 && (
            <button type="button" className="btn btn-sm" onClick={() => set({ offsetsMinutes: [...r.offsetsMinutes, r.offsetsMinutes.includes(120) ? 60 : 120] })}>+ Otro aviso</button>
          )}
        </div>
        <p className="muted small">
          {sorted.length === 1 ? `Un aviso ${offsetLabel(sorted[0])} antes de la cita.` : `Avisos ${sorted.map(offsetLabel).join(', ')} antes de la cita.`} Mínimo 15 minutos y máximo 30 días; hasta 3 avisos.
        </p>
      </fieldset>

      <fieldset className="reminder-block" disabled={!r.enabled}>
        <legend>Mensajes</legend>
        <p className="muted small">Puedes usar: {PLACEHOLDERS.map((p) => <code key={p}>{p}</code>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, ' ', x] : [x]), [])}</p>
        {r.email && (
          <>
            <label>Asunto del email<input maxLength={150} value={r.emailSubject} onChange={(e) => set({ emailSubject: e.target.value })} /></label>
            <label>Texto del email<textarea rows={5} maxLength={2000} value={r.emailBody} onChange={(e) => set({ emailBody: e.target.value })} /></label>
            <div className="preview"><span className="muted small">Vista previa</span><strong>{sample(r.emailSubject)}</strong><p>{sample(r.emailBody)}</p></div>
          </>
        )}
        {r.whatsapp && (
          <>
            <label>Plantilla de WhatsApp aprobada en Meta (nombre)
              <input placeholder="p. ej. recordatorio_cita" value={r.whatsappTemplate} onChange={(e) => set({ whatsappTemplate: e.target.value })} />
            </label>
            {r.whatsappTemplate ? (
              <>
                <label>Idioma de la plantilla<input value={r.whatsappTemplateLang} onChange={(e) => set({ whatsappTemplateLang: e.target.value })} /></label>
                <p className="muted small">La plantilla debe tener 4 variables en este orden: <code>{'{{1}}'}</code> nombre, <code>{'{{2}}'}</code> fecha, <code>{'{{3}}'}</code> hora y <code>{'{{4}}'}</code> servicio. Ejemplo: «Hola {'{{1}}'}, te recordamos tu cita el {'{{2}}'} a las {'{{3}}'} ({'{{4}}'}).»</p>
              </>
            ) : (
              <>
                <label>Texto del WhatsApp<textarea rows={3} maxLength={1000} value={r.whatsappBody} onChange={(e) => set({ whatsappBody: e.target.value })} /></label>
                <div className="preview"><span className="muted small">Vista previa</span><p>{sample(r.whatsappBody)}</p></div>
                <p className="small warn-text">Sin plantilla, WhatsApp solo entrega el texto libre a clientes que te hayan escrito en las últimas 24 h. Para avisar a todos, crea una plantilla en Meta (categoría «Utilidad») y pon aquí su nombre.</p>
              </>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="reminder-block" disabled={!r.enabled || testing}>
        <legend>Probar</legend>
        <p className="muted small">Envía un aviso de ejemplo con los textos de arriba (aunque aún no los hayas guardado).</p>
        <div className="row test-row">
          {r.email && <button type="button" className="btn" onClick={() => test('EMAIL')}>Enviarme un email de prueba{user?.email ? ` (${user.email})` : ''}</button>}
          {r.whatsapp && (
            <span className="test-wa">
              <input type="tel" aria-label="Teléfono para la prueba" placeholder="Teléfono" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
              <button type="button" className="btn" onClick={() => test('WHATSAPP')}>WhatsApp de prueba</button>
            </span>
          )}
        </div>
        {testMsg && <Alert kind={testMsg.kind}>{testMsg.text}</Alert>}
      </fieldset>

      <p className="muted small">Los cambios se aplican al pulsar «Guardar configuración».</p>

      <h3>Últimos avisos</h3>
      {!log ? null : log.length === 0 ? <p className="muted small">Todavía no se ha enviado ningún aviso.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Enviado</th><th>Cliente</th><th>Cita</th><th>Aviso</th><th>Estado</th></tr></thead>
            <tbody>
              {log.map((x) => (
                <tr key={x.id}>
                  <td>{dateShort(x.createdAt)} {time(x.createdAt)}</td>
                  <td><Link to={`/admin/usuarios/${x.appointment.client.id}`}>{x.appointment.client.name}</Link></td>
                  <td>{dateShort(x.startAt)} {time(x.startAt)}</td>
                  <td>{x.channel === 'EMAIL' ? 'Email' : 'WhatsApp'} · {x.offsetLabel} antes</td>
                  <td><span className={`badge badge-${statusClass[x.status]}`}>{statusText[x.status]}</span>{x.detail && <div className="muted small">{x.detail}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
