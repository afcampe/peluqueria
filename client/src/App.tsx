import type { ReactNode } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useSession } from './lib/session';
import { Book } from './pages/Book';
import { Home } from './pages/Home';
import { Login, Register } from './pages/Login';
import { MyAppointments } from './pages/MyAppointments';
import { Profile } from './pages/Profile';
import { AdminLayout } from './pages/admin/AdminLayout';
import { Agenda } from './pages/admin/Agenda';
import { Incidents } from './pages/admin/Incidents';
import { ImportList, ImportReview } from './pages/admin/Import';
import { Closures } from './pages/admin/Closures';
import { Dashboard } from './pages/admin/Dashboard';
import { Messages } from './pages/admin/Messages';
import { Settings } from './pages/admin/Settings';
import { UserDetail } from './pages/admin/UserDetail';
import { Users } from './pages/admin/Users';
import { WhatsApp } from './pages/admin/WhatsApp';

// En Electron la app se carga desde file://, donde solo funcionan rutas con #.
const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

function RequireAuth({ admin, client, children }: { admin?: boolean; client?: boolean; children: ReactNode }) {
  const { user, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/entrar?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (admin && user.role !== 'ADMIN') return <Navigate to="/" replace />;
  if (client && user.role === 'ADMIN') return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export function App() {
  const { loading, config } = useSession();
  if (loading) return <Spinner />;
  if (!config) return <div className="card narrow"><h1>Sin conexión</h1><p>No se puede contactar con el servidor. Comprueba tu conexión y vuelve a intentarlo.</p><button className="btn btn-primary" onClick={() => location.reload()}>Reintentar</button></div>;

  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="entrar" element={<Login />} />
          <Route path="registro" element={<Register />} />
          <Route path="reservar" element={<RequireAuth client><Book /></RequireAuth>} />
          <Route path="mis-citas" element={<RequireAuth client><MyAppointments /></RequireAuth>} />
          <Route path="perfil" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="admin" element={<RequireAuth admin><AdminLayout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="agenda" element={<Agenda />} />
            <Route path="usuarios" element={<Users />} />
            <Route path="usuarios/:id" element={<UserDetail />} />
            <Route path="importar" element={<ImportList />} />
            <Route path="importar/:id" element={<ImportReview />} />
            <Route path="anulaciones" element={<Incidents />} />
            <Route path="cierres" element={<Closures />} />
            <Route path="avisos" element={<Messages />} />
            <Route path="whatsapp" element={<WhatsApp />} />
            <Route path="configuracion" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
