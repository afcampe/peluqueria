import { Link } from 'react-router-dom';
import { money, weekdayNames } from '../lib/format';
import { useSession } from '../lib/session';

export function Home() {
  const { config, user } = useSession();
  return (
    <div className="home">
      <section className="hero">
        <h1>{config?.shop.name ?? 'Peluquería Armando'}</h1>
        <p>Reserva tu cita en segundos. Paga online o en el local.</p>
        <Link to={user ? '/reservar' : '/entrar?next=/reservar'} className="btn btn-primary btn-lg">Reservar cita</Link>
      </section>
      {config && (
        <div className="grid-2">
          <section className="card">
            <h2>Servicios</h2>
            <ul className="price-list">
              {config.services.map((s) => (
                <li key={s.id}><span>{s.name}</span><strong>{money(s.priceCents)}</strong></li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Horario</h2>
            <ul className="price-list">
              {Object.entries(weekdayNames).map(([d, name]) => (
                <li key={d}>
                  <span>{name}</span>
                  <span>{config.weeklySchedule[d]?.length ? config.weeklySchedule[d].map((r) => `${r.start}–${r.end}`).join(' · ') : 'Cerrado'}</span>
                </li>
              ))}
            </ul>
            {(config.shop.address || config.shop.phone) && (
              <p className="muted">{config.shop.address}{config.shop.address && config.shop.phone && ' · '}{config.shop.phone && <a href={`tel:${config.shop.phone}`}>{config.shop.phone}</a>}</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
