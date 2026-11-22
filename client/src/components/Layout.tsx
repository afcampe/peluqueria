import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Avatar } from './Avatar';

export function Layout() {
  const { user, logout, config } = useSession();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const close = () => setOpen(false);

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand" onClick={close}>
          <span aria-hidden>💈</span> {config?.shop.name ?? 'Peluquería Armando'}
        </NavLink>
        <button className="menu-toggle btn-icon" onClick={() => setOpen(!open)} aria-label="Menú" aria-expanded={open}>☰</button>
        <nav className={open ? 'open' : ''} onClick={close}>
          {user?.role === 'ADMIN' ? (
            <NavLink to="/admin">Administración</NavLink>
          ) : (
            <>
              <NavLink to="/reservar">Reservar</NavLink>
              {user && <NavLink to="/mis-citas">Mis citas</NavLink>}
            </>
          )}
          {user ? (
            <>
              <NavLink to="/perfil" className="nav-user"><Avatar name={user.name} src={user.avatarUrl} size={28} /> {user.name.split(' ')[0]}</NavLink>
              <button className="link" onClick={() => { logout(); nav('/'); }}>Salir</button>
            </>
          ) : (
            <NavLink to="/entrar">Entrar</NavLink>
          )}
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
