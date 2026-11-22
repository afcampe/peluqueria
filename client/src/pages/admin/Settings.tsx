import { useEffect, useState } from 'react';
import { Alert, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { money, weekdayNames } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Service, Settings as S } from '../../lib/types';

interface ProviderInfo { id: string; label: string; online: boolean; configured: boolean }

export function Settings() {
  const { reloadConfig } = useSession();
  const [s, setS] = useState<S | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ settings: S; providers: ProviderInfo[] }>('/admin/settings')
      .then((r) => { setS(r.settings); setProviders(r.providers); })
      .catch((e) => setError(e.message));
  }, []);

  if (!s) return error ? <Alert>{error}</Alert> : <Spinner />;
  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const str = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value });
  const setDay = (d: string, ranges: S['weeklySchedule'][string]) => setS({ ...s, weeklySchedule: { ...s.weeklySchedule, [d]: ranges } });

  const save = async () => {
    setMsg(''); setError('');
    try {
      setS(await api.put<S>('/admin/settings', s));
      await reloadConfig();
      setMsg('Configuración guardada. Las citas ya reservadas no se modifican.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setError(errMsg(e)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };

  return (
    <div>
      <h1>Configuración</h1>
      <Alert kind="ok">{msg}</Alert>
      <Alert>{error}</Alert>

      <section className="card">
        <h2>Citas</h2>
        <div className="row">
          <label>Duración de cada cita (min)<input type="number" min={5} max={240} step={5} value={s.slotMinutes} onChange={num('slotMinutes')} /></label>
          <label>Citas a la vez (sillones)<input type="number" min={1} max={50} value={s.capacity} onChange={num('capacity')} /></label>
          <label>Reservar hasta (días vista)<input type="number" min={1} max={730} value={s.bookingHorizonDays} onChange={num('bookingHorizonDays')} /></label>
          <label>Antelación mínima para que el cliente cancele (min)<input type="number" min={0} step={15} value={s.clientCancelMinNoticeMinutes} onChange={num('clientCancelMinNoticeMinutes')} /></label>
          <label>Tiempo para completar el pago online (min)<input type="number" min={5} max={120} value={s.paymentHoldMinutes} onChange={num('paymentHoldMinutes')} /></label>
        </div>
      </section>

      <section className="card">
        <h2>Horario semanal</h2>
        <div className="schedule">
          {Object.entries(weekdayNames).map(([d, name]) => {
            const ranges = s.weeklySchedule[d] ?? [];
            return (
              <div key={d} className="schedule-day">
                <strong>{name}</strong>
                <div className="ranges">
                  {ranges.length === 0 && <span className="muted">Cerrado</span>}
                  {ranges.map((r, i) => (
                    <span key={i} className="range">
                      <input type="time" value={r.start} onChange={(e) => setDay(d, ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      –
                      <input type="time" value={r.end} onChange={(e) => setDay(d, ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                      <button className="btn-icon" aria-label="Quitar tramo" onClick={() => setDay(d, ranges.filter((_, j) => j !== i))}>✕</button>
                    </span>
                  ))}
                  <button className="btn btn-sm" onClick={() => setDay(d, [...ranges, { start: ranges.length ? '16:00' : '09:00', end: ranges.length ? '20:00' : '13:00' }])}>+ tramo</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>Formas de pago</h2>
        {providers.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={!!s.paymentMethods[p.id]?.enabled}
              onChange={(e) => setS({ ...s, paymentMethods: { ...s.paymentMethods, [p.id]: { enabled: e.target.checked } } })} />
            {p.label} {!p.configured && <span className="error-text small">(faltan credenciales en el servidor)</span>}
          </label>
        ))}
      </section>

      <section className="card">
        <h2>Datos de la peluquería</h2>
        <div className="row">
          <label>Nombre<input value={s.shopName} onChange={str('shopName')} /></label>
          <label>Teléfono<input value={s.shopPhone} onChange={str('shopPhone')} /></label>
          <label>Email<input value={s.shopEmail} onChange={str('shopEmail')} /></label>
          <label>Dirección<input value={s.shopAddress} onChange={str('shopAddress')} /></label>
        </div>
      </section>

      <div className="sticky-save"><button className="btn btn-primary btn-lg" onClick={save}>Guardar configuración</button></div>

      <Services onChange={reloadConfig} />
    </div>
  );
}

function Services({ onChange }: { onChange: () => Promise<void> }) {
  const [list, setList] = useState<Service[]>([]);
  const [f, setF] = useState({ name: '', price: '' });
  const [error, setError] = useState('');
  const load = () => api.get<Service[]>('/admin/services').then(setList);
  useEffect(() => { load(); }, []);
  const update = async (s: Service, patch: Partial<Service>) => {
    try { await api.patch(`/admin/services/${s.id}`, patch); await load(); await onChange(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <section className="card">
      <h2>Servicios y precios</h2>
      <Alert>{error}</Alert>
      <table className="table">
        <tbody>
          {list.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'dim'}>
              <td>{s.name}</td>
              <td>{money(s.priceCents)}</td>
              <td className="actions">
                <button className="btn btn-sm" onClick={() => { const p = prompt('Nuevo precio (€)', (s.priceCents / 100).toFixed(2)); if (p) update(s, { priceCents: Math.round(Number(p.replace(',', '.')) * 100) }); }}>Precio</button>
                <button className="btn btn-sm" onClick={() => update(s, { active: !s.active })}>{s.active ? 'Ocultar' : 'Activar'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/admin/services', { name: f.name, priceCents: Math.round(Number(f.price.replace(',', '.')) * 100), sortOrder: list.length + 1 });
          setF({ name: '', price: '' }); await load(); await onChange();
        } catch (e) { setError(errMsg(e)); }
      }}>
        <label>Nuevo servicio<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Precio (€)<input required inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <button className="btn">Añadir</button>
      </form>
    </section>
  );
}
