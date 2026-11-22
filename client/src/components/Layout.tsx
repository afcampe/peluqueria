import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Avatar } from './Avatar';
import { IconMenu, IconMoon, IconSun, Logo } from './icons';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'claro' : 'oscuro';
  return (
    <button type="button" className="btn-icon theme-toggle" onClick={toggle} aria-label={`Cambiar a tema ${next}`} title={`Tema ${next}`}>
      {theme === 'dark' ? <IconSun size={20} /> : <IconMoon size={20} />}
    </button>
  );
}

export function Layout() {
  const { user, logout, config } = useSession();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const close = () => setOpen(false);
  const isAdmin = user?.role === 'ADMIN';
  const name = config?.shop.name ?? 'Peluquería Armando';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" onClick={close}>
            <Logo />
            <span className="brand-text">
              <span className="brand-name">{name}</span>
              <span className="brand-sub">Barbería de caballeros</span>
            </span>
          </Link>
          <nav className={open ? 'open' : ''} onClick={close} aria-label="Principal">
            {isAdmin ? (
              <NavLink to="/admin">Administración</NavLink>
            ) : (
              <>
                <NavLink to="/" end>Inicio</NavLink>
                {user && <NavLink to="/mis-citas">Mis citas</NavLink>}
              </>
            )}
            {user ? (
              <>
                <NavLink to="/perfil" className="nav-user"><Avatar name={user.name} src={user.avatarUrl} size={28} /> {user.name.split(' ')[0]}</NavLink>
                <button className="link nav-link" onClick={() => { logout(); nav('/'); }}>Salir</button>
              </>
            ) : (
              <NavLink to="/entrar">Entrar</NavLink>
            )}
          </nav>
          <div className="topbar-actions">
            <ThemeToggle />
            {!isAdmin && pathname !== '/reservar' && (
              <Link to={user ? '/reservar' : '/entrar?next=/reservar'} className="btn btn-primary btn-sm cta">Reservar</Link>
            )}
            <button className="menu-toggle btn-icon" onClick={() => setOpen(!open)} aria-label="Menú" aria-expanded={open}><IconMenu size={22} /></button>
          </div>
        </div>
      </header>
      <main className={pathname === '/' ? 'content content-full' : 'content'}>
        <Outlet />
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <div>
            <div className="footer-brand"><Logo size={26} /> {name}</div>
            <p className="muted small">Barbería de caballeros{config?.shop.address && ` · ${config.shop.address}`}{config?.shop.phone && ` · ${config.shop.phone}`}</p>
          </div>
          <p className="muted small">Fotografías: Thom Holmes, Hair Spies, Redd Francisco y Adam Sherez en Unsplash.</p>
        </div>
      </footer>
    </div>
  );
}
