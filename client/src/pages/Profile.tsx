import { useState, type FormEvent } from 'react';
import { AvatarInput } from '../components/Avatar';
import { ReminderPrefs, reminderPayload } from '../components/ReminderPrefs';
import { Alert, Badge, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useTheme, type ThemePref } from '../lib/theme';
import type { User } from '../lib/types';

export function Profile() {
  const { user, setUser, config } = useSession();
  const { pref, setPref } = useTheme();
  const [f, setF] = useState({ name: user!.name, phone: user!.phone ?? '', acceptsEmail: user!.acceptsEmail, password: '', remindEmail: user!.remindEmail, remindWhatsapp: user!.remindWhatsapp });
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(''); setError('');
    try {
      setUser(await api.patch<User>('/auth/me', { ...f, acceptsWhatsapp: f.acceptsEmail, ...reminderPayload(f, config?.reminders), password: f.password || undefined, avatar }));
      setF({ ...f, password: '' });
      setAvatar(undefined);
      setMsg('Datos guardados');
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Mi perfil</h1>
      <p className="account-type">
        Tipo de cuenta:{' '}
        {user!.role === 'ADMIN'
          ? <><Badge status="admin">Administrador</Badge> <span className="muted small">Gestionas la peluquería desde el panel de administración.</span></>
          : <Badge status="active">Cliente</Badge>}
      </p>
      <Alert kind="ok">{msg}</Alert>
      <Alert>{error}</Alert>
      <AvatarInput name={f.name} current={user!.avatarUrl} value={avatar} onChange={setAvatar} />
      <label>Email<input value={user!.email ?? ''} disabled /></label>
      <label>Nombre<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Teléfono<input type="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      {user!.role === 'CLIENT' && (
        <>
          <ReminderPrefs value={f} onChange={(v) => setF({ ...f, ...v })} hasEmail={!!user!.email} hasPhone={!!f.phone.trim()} />
          <label className="check"><input type="checkbox" checked={f.acceptsEmail} onChange={(e) => setF({ ...f, acceptsEmail: e.target.checked })} /> Recibir novedades y promociones por email y WhatsApp</label>
        </>
      )}
      <label>Nueva contraseña (opcional)<input type="password" minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      <fieldset className="theme-picker">
        <legend>Apariencia</legend>
        {([['light', 'Claro', 'Fondo blanco'], ['dark', 'Oscuro', 'Fondo negro'], ['system', 'Automático', 'Como el dispositivo']] as [ThemePref, string, string][]).map(([v, label, hint]) => (
          <label key={v} className={`theme-option theme-option-${v} ${pref === v ? 'selected' : ''}`}>
            <input type="radio" name="theme" checked={pref === v} onChange={() => setPref(v)} />
            <span className="theme-swatch" aria-hidden />
            <span><strong>{label}</strong><small>{hint}</small></span>
          </label>
        ))}
        <p className="muted small">Se aplica al momento y se recuerda en este dispositivo.</p>
      </fieldset>
      <button className="btn btn-primary">Guardar</button>
    </form>
  );
}
