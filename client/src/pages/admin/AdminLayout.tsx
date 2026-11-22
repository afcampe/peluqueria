import { NavLink, Outlet } from 'react-router-dom';

const links = [
  ['/admin', 'Resumen'],
  ['/admin/agenda', 'Agenda'],
  ['/admin/usuarios', 'Usuarios'],
  ['/admin/anulaciones', 'Anulaciones'],
  ['/admin/cierres', 'Cierres'],
  ['/admin/avisos', 'Avisos email'],
  ['/admin/whatsapp', 'WhatsApp'],
  ['/admin/configuracion', 'Configuración'],
];

export function AdminLayout() {
  return (
    <div className="admin">
      <nav className="admin-nav">
        {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/admin'}>{label}</NavLink>)}
      </nav>
      <div className="admin-body"><Outlet /></div>
    </div>
  );
}
