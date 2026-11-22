import { useState, type FormEvent } from 'react';
import { AvatarInput } from '../components/Avatar';
import { Alert, errMsg } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { User } from '../lib/types';

export function Profile() {
  const { user, setUser } = useSession();
  const [f, setF] = useState({ name: user!.name, phone: user!.phone ?? '', acceptsEmail: user!.acceptsEmail, password: '' });
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(''); setError('');
    try {
      setUser(await api.patch<User>('/auth/me', { ...f, password: f.password || undefined, avatar }));
      setF({ ...f, password: '' });
      setAvatar(undefined);
      setMsg('Datos guardados');
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Mi perfil</h1>
      <Alert kind="ok">{msg}</Alert>
      <Alert>{error}</Alert>
      <AvatarInput name={f.name} current={user!.avatarUrl} value={avatar} onChange={setAvatar} />
      <label>Email<input value={user!.email} disabled /></label>
      <label>Nombre<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Teléfono<input type="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.acceptsEmail} onChange={(e) => setF({ ...f, acceptsEmail: e.target.checked })} /> Recibir avisos por email</label>
      <label>Nueva contraseña (opcional)<input type="password" minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      <button className="btn btn-primary">Guardar</button>
    </form>
  );
}
