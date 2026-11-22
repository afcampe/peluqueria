import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import authPhoto from '../assets/photos/corte-estilista.jpg';
import { AvatarInput } from '../components/Avatar';
import { Alert, errMsg } from '../components/ui';
import { useSession } from '../lib/session';

export function Login() {
  const { login } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await login(email, password);
      const next = params.get('next');
      if (u.role === 'ADMIN') nav(next && (next.startsWith('/admin') || next === '/perfil') ? next : '/admin');
      else nav(next ?? '/mis-citas');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
    <aside className="auth-photo" aria-hidden>
      <img src={authPhoto} alt="" />
      <p>El corte de siempre,<br />reservado en un minuto.</p>
    </aside>
    <form className="card auth-card" onSubmit={submit}>
      <h1>Entrar</h1>
      <Alert>{error}</Alert>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Contraseña<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="muted">¿No tienes cuenta? <Link to={`/registro${params.get('next') ? `?next=${params.get('next')}` : ''}`}>Regístrate</Link></p>
    </form>
    </div>
  );
}

export function Register() {
  const { register } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '', acceptsEmail: true });
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await register({ ...f, avatar: avatar ?? undefined });
      nav(params.get('next') ?? '/reservar');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
    <aside className="auth-photo" aria-hidden>
      <img src={authPhoto} alt="" />
      <p>El corte de siempre,<br />reservado en un minuto.</p>
    </aside>
    <form className="card auth-card" onSubmit={submit}>
      <h1>Crear cuenta</h1>
      <Alert>{error}</Alert>
      <AvatarInput name={f.name} value={avatar} onChange={setAvatar} />
      <label>Nombre y apellidos<input required autoComplete="name" value={f.name} onChange={set('name')} /></label>
      <label>Email<input type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></label>
      <label>Teléfono (WhatsApp)<input type="tel" required autoComplete="tel" value={f.phone} onChange={set('phone')} /></label>
      <label>Contraseña<input type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} /></label>
      <label className="check"><input type="checkbox" checked={f.acceptsEmail} onChange={set('acceptsEmail')} /> Quiero recibir avisos y novedades por email</label>
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Creando…' : 'Crear cuenta'}</button>
      <p className="muted">¿Ya tienes cuenta? <Link to="/entrar">Entra</Link></p>
    </form>
    </div>
  );
}
