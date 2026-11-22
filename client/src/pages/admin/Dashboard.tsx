import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

interface Data {
  today: number; upcoming: number; clients: number; onlineRevenueMonthCents: number; cashRevenueMonthCents: number;
  integrations: { email: boolean; whatsappApi: boolean; payments: { id: string; label: string; configured: boolean }[] };
}

export function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get<Data>('/admin/dashboard').then(setD).catch((e) => setError(e.message)); }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!d) return <Spinner />;
  return (
    <div>
      <h1>Resumen</h1>
      <div className="stats">
        <Link to="/admin/agenda" className="stat"><strong>{d.today}</strong><span>Citas hoy</span></Link>
        <div className="stat"><strong>{d.upcoming}</strong><span>Citas próximas</span></div>
        <Link to="/admin/usuarios" className="stat"><strong>{d.clients}</strong><span>Clientes</span></Link>
        <div className="stat"><strong>{money(d.onlineRevenueMonthCents)}</strong><span>Cobrado online este mes</span></div>
        <div className="stat"><strong>{money(d.cashRevenueMonthCents)}</strong><span>Cobrado en el local este mes</span></div>
      </div>
      <section className="card">
        <h2>Estado de integraciones</h2>
        <ul className="status-list">
          <li><span className={d.integrations.email ? 'dot ok' : 'dot warn'} /> Email {d.integrations.email ? 'configurado' : 'en modo prueba (se muestra en la consola del servidor). Configura SMTP en server/.env'}</li>
          <li><span className={d.integrations.whatsappApi ? 'dot ok' : 'dot info'} /> WhatsApp {d.integrations.whatsappApi ? 'API conectada' : 'mediante enlaces wa.me (API opcional no configurada)'}</li>
          {d.integrations.payments.map((p) => (
            <li key={p.id}><span className={p.configured ? 'dot ok' : 'dot warn'} /> {p.label}: {p.configured ? 'listo' : 'faltan credenciales en server/.env'}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
