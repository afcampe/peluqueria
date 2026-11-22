import { useSession } from '../lib/session';

/**
 * Recordatorios de citas que recibe un cliente. Siempre se muestran los dos
 * canales, pero solo se pueden activar los que la peluquería tiene activados
 * en Configuración.
 */
export function ReminderPrefs({ value, onChange, hasEmail, hasPhone, admin = false }: {
  value: { remindEmail: boolean; remindWhatsapp: boolean };
  onChange: (v: { remindEmail: boolean; remindWhatsapp: boolean }) => void;
  hasEmail: boolean; hasPhone: boolean; admin?: boolean;
}) {
  const { config } = useSession();
  const on = config?.reminders ?? { email: false, whatsapp: false };
  const off = admin ? 'Desactivado en Configuración → Recordatorios de citas' : 'La peluquería no envía recordatorios por este medio';
  const row = (key: 'remindEmail' | 'remindWhatsapp', label: string, enabled: boolean, missing: string | null) => (
    <label className={`check reminder-pref ${enabled ? '' : 'is-off'}`}>
      <input type="checkbox" disabled={!enabled} checked={enabled && value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} />
      <span>{label}{!enabled ? <small className="muted"> · {off}</small> : missing && value[key] ? <small className="warn-text"> · {missing}</small> : null}</span>
    </label>
  );
  return (
    <fieldset className="reminder-prefs">
      <legend>Recordatorios de {admin ? 'sus' : 'mis'} citas</legend>
      {row('remindEmail', 'Por email', on.email, hasEmail ? null : 'falta el email')}
      {row('remindWhatsapp', 'Por WhatsApp', on.whatsapp, hasPhone ? null : 'falta el teléfono')}
      {(on.email || on.whatsapp) && <p className="muted small">Aviso automático antes de cada cita.</p>}
    </fieldset>
  );
}

/** Lo que se envía al guardar: un canal desactivado en Configuración siempre va apagado. */
export const reminderPayload = (v: { remindEmail: boolean; remindWhatsapp: boolean }, on?: { email: boolean; whatsapp: boolean }) => ({
  remindEmail: !!on?.email && v.remindEmail,
  remindWhatsapp: !!on?.whatsapp && v.remindWhatsapp,
});
