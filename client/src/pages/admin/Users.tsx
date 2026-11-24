import { ReminderPrefs, reminderPayload } from '../../components/ReminderPrefs';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { EmailReminderButton } from '../../components/EmailReminderButton';
import { Avatar, AvatarInput } from '../../components/Avatar';
import { Alert, Badge, Modal, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateLong } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { User } from '../../lib/types';
import { IconCalendar } from '../../components/icons';

const statusText = { ACTIVE: 'Activo', BLOCKED: 'Bloqueado', DELETED: 'De baja' };

export function Users() {
  const { user: me } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [list, setList] = useState<User[] | null>(null);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [modal, setModal] = useState<{ kind: 'edit' | 'block' | 'delete'; user?: User } | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(role && { role }) });
    api.get<User[]>(`/admin/users?${p}`).then(setList).catch((e) => setError(e.message));
  }, [q, status, role]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const done = (m: string) => { setModal(null); setFlash(m); load(); };
  const unblock = async (u: User) => {
    try { await api.post(`/admin/users/${u.id}/unblock`); done(`${u.name} desbloqueado`); } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Usuarios</h1>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'edit' })}>Alta de usuario</button>
      </div>
      <div className="filters">
        <label className="grow">Buscar<input placeholder="Nombre, email o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label>Tipo
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Todos</option>
            <option value="CLIENT">Usuarios normales</option>
            <option value="ADMIN">Administradores</option>
          </select>
        </label>
        <label>Estado
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Activos y bloqueados</option>
            <option value="ACTIVE">Activos</option>
            <option value="BLOCKED">Bloqueados</option>
            <option value="DELETED">De baja</option>
          </select>
        </label>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {!list && <Spinner />}
      {list && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Nombre</th><th>Tipo</th><th>Contacto</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td><span className="user-cell"><Avatar name={u.name} src={u.avatarUrl} /> <span><Link to={`/admin/usuarios/${u.id}`}>{u.name}</Link>{u.id === me?.id && <span className="muted small"> (tú)</span>}</span></span></td>
                  <td>{u.role === 'ADMIN' ? <Badge status="admin">Administrador</Badge> : <span className="muted">Usuario normal</span>}</td>
                  <td>{u.email ? <div>{u.email}</div> : <div><span className="badge badge-noaccount" title="Ficha creada desde la agenda en papel">Sin cuenta</span></div>}<div className="muted small">{u.phone}</div></td>
                  <td>
                    <Badge status={u.status}>{statusText[u.status]}</Badge>
                    {u.status === 'BLOCKED' && <div className="muted small">{u.blockedUntil ? `hasta ${dateLong(u.blockedUntil)}` : 'indefinido'}{u.blockReason && ` · ${u.blockReason}`}</div>}
                  </td>
                  <td className="actions">
                    {u.role === 'CLIENT' && <Link className="btn btn-sm" to={`/admin/usuarios/${u.id}`}><IconCalendar size={14} /> Ver citas</Link>}
                    {u.whatsappLink && <a className="btn btn-sm btn-wa" href={u.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>}
                    {u.role === 'CLIENT' && u.status !== 'DELETED' && <EmailReminderButton clientId={u.id} disabledReason={u.email ? undefined : 'El cliente no tiene email'} />}
                    <button className="btn btn-sm" onClick={() => setModal({ kind: 'edit', user: u })}>{u.status === 'DELETED' ? 'Reactivar' : 'Editar'}</button>
                    {u.id !== me?.id && u.status === 'ACTIVE' && <button className="btn btn-sm" onClick={() => setModal({ kind: 'block', user: u })}>Bloquear</button>}
                    {u.status === 'BLOCKED' && <button className="btn btn-sm" onClick={() => unblock(u)}>Desbloquear</button>}
                    {u.id !== me?.id && u.status !== 'DELETED' && <button className="btn btn-sm btn-danger" onClick={() => setModal({ kind: 'delete', user: u })}>Baja</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="empty">No hay usuarios.</p>}
        </div>
      )}
      {modal?.kind === 'edit' && <UserForm user={modal.user} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'block' && <BlockForm user={modal.user!} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'delete' && (
        <Modal title="Dar de baja" onClose={() => setModal(null)}>
          <p>¿Dar de baja a <strong>{modal.user!.name}</strong>? No podrá entrar y se cancelarán (con reembolso) sus citas futuras. Su historial se conserva.</p>
          <button className="btn btn-danger" onClick={async () => {
            try { const r = await api.del<{ cancelled: number; skippedPaid: number }>(`/admin/users/${modal.user!.id}`); done(`Baja realizada. ${r.cancelled} cita(s) cancelada(s).${r.skippedPaid ? ` ${r.skippedPaid} cobrada(s) en el local siguen activas: cancélalas desde la Agenda.` : ''}`); } catch (e) { setError(errMsg(e)); setModal(null); }
          }}>Dar de baja</button>
        </Modal>
      )}
    </div>
  );
}

function UserForm({ user, onClose, onDone }: { user?: User; onClose: () => void; onDone: (m: string) => void }) {
  const reactivate = user?.status === 'DELETED';
  const { user: me, config } = useSession();
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', role: user?.role ?? 'CLIENT', password: '', acceptsEmail: user?.acceptsEmail ?? true, remindEmail: user?.remindEmail ?? true, remindWhatsapp: user?.remindWhatsapp ?? true });
  const isMe = user?.id === me?.id;
  const noAccount = !!user && !user.hasAccount;
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (user && !reactivate) {
        await api.patch(`/admin/users/${user.id}`, { ...f, ...reminderPayload(f, config?.reminders), email: f.email || undefined, password: f.password || undefined, avatar });
        onDone('Usuario actualizado');
      } else {
        await api.post('/admin/users', { ...f, ...reminderPayload(f, config?.reminders), avatar: avatar ?? undefined });
        onDone(reactivate ? 'Usuario reactivado' : 'Usuario dado de alta');
      }
    } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title={reactivate ? 'Reactivar usuario' : user ? 'Editar usuario' : 'Alta de usuario'} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <fieldset className="role-picker" disabled={isMe}>
          <legend>Tipo de usuario</legend>
          <label className={`role-option ${f.role === 'CLIENT' ? 'selected' : ''}`}>
            <input type="radio" name="role" checked={f.role === 'CLIENT'} onChange={() => setF({ ...f, role: 'CLIENT' })} />
            <span><strong>Usuario normal</strong><small>Reserva y gestiona sus propias citas</small></span>
          </label>
          <label className={`role-option ${f.role === 'ADMIN' ? 'selected' : ''}`}>
            <input type="radio" name="role" checked={f.role === 'ADMIN'} onChange={() => setF({ ...f, role: 'ADMIN' })} />
            <span><strong>Administrador</strong><small>Acceso completo al panel: agenda, usuarios, pagos y configuración. No reserva citas propias</small></span>
          </label>
          {isMe && <p className="muted small">No puedes cambiar tu propio tipo de usuario.</p>}
        </fieldset>
        <AvatarInput name={f.name} current={user?.avatarUrl} value={avatar} onChange={setAvatar} />
        <label>Nombre<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        {noAccount && <p className="muted small">Ficha sin cuenta (viene de la agenda en papel). Para que pueda entrar en la app, ponle email y contraseña.</p>}
        <label>Email<input type="email" required={!noAccount} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>Teléfono<input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>{noAccount ? 'Contraseña (para darle acceso)' : user && !reactivate ? 'Nueva contraseña (opcional)' : 'Contraseña inicial'}
          <input type="password" minLength={8} required={!user || reactivate || (noAccount && !!f.email)} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        {f.role === 'CLIENT' && (
          <>
            <ReminderPrefs admin value={f} onChange={(v) => setF({ ...f, ...v })} hasEmail={!!f.email.trim()} hasPhone={!!f.phone.trim()} />
            <label className="check"><input type="checkbox" checked={f.acceptsEmail} onChange={(e) => setF({ ...f, acceptsEmail: e.target.checked })} /> Acepta novedades y promociones por email</label>
          </>
        )}
        <button className="btn btn-primary">Guardar</button>
      </form>
    </Modal>
  );
}

function BlockForm({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (m: string) => void }) {
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [cancelFuture, setCancelFuture] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={`Bloquear a ${user.name}`} onClose={onClose}>
      <Alert>{error}</Alert>
      <label>Bloqueado hasta (vacío = indefinido)<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      <label>Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="p. ej. no se presentó 3 veces" /></label>
      <label className="check"><input type="checkbox" checked={cancelFuture} onChange={(e) => setCancelFuture(e.target.checked)} /> Cancelar también sus citas futuras (con reembolso)</label>
      <button className="btn btn-danger" onClick={async () => {
        try {
          const r = await api.post<{ cancelled: number; skippedPaid: number }>(`/admin/users/${user.id}/block`, { until: until || undefined, reason: reason || undefined, cancelFuture });
          onDone(`${user.name} bloqueado${r.cancelled ? `; ${r.cancelled} cita(s) cancelada(s)` : ''}${r.skippedPaid ? `; ${r.skippedPaid} cobrada(s) en el local siguen activas` : ''}`);
        } catch (e) { setError(errMsg(e)); }
      }}>Bloquear</button>
    </Modal>
  );
}
