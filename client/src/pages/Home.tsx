import { Link } from 'react-router-dom';
import barbaBn from '../assets/photos/barba-bn.jpg';
import corteBarbero from '../assets/photos/corte-barbero.jpg';
import corteEstilista from '../assets/photos/corte-estilista.jpg';
import hero from '../assets/photos/barbero-tunel.jpg';
import { IconBeard, IconBell, IconCalendar, IconCard, IconClock, IconPhone, IconPin, IconRazor, IconRepeat, IconScissors } from '../components/icons';
import { money, weekdayNames } from '../lib/format';
import { useSession } from '../lib/session';

const serviceIcon = (name: string) => {
  const n = name.toLowerCase();
  if (n.includes('barba')) return <IconBeard />;
  if (n.includes('afeitado')) return <IconRazor />;
  return <IconScissors />;
};

/** Hoy en formato ISO de día de la semana (1 = lunes … 7 = domingo). */
const todayIso = () => String(((new Date().getDay() + 6) % 7) + 1);

export function Home() {
  const { config, user } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const bookTo = user ? '/reservar' : '/entrar?next=/reservar';
  const today = config?.weeklySchedule[todayIso()] ?? [];

  return (
    <div className="home">
      <section className="hero">
        <img src={hero} alt="" className="hero-img" />
        <div className="hero-inner">
          <p className="eyebrow">Barbería de caballeros</p>
          <h1>{config?.shop.name ?? 'Peluquería Armando'}</h1>
          {isAdmin ? (
            <>
              <p className="hero-lead">Hola, {user!.name.split(' ')[0]}. Has entrado como administrador.</p>
              <div className="hero-ctas"><Link to="/admin" className="btn btn-gold btn-lg">Ir al panel de administración</Link></div>
            </>
          ) : (
            <>
              <p className="hero-lead">Corte clásico, degradados y arreglo de barba con el cuidado de siempre. Reserva tu hora en un minuto.</p>
              <div className="hero-ctas">
                <Link to={bookTo} className="btn btn-gold btn-lg">Reservar cita</Link>
                <a href="#servicios" className="btn btn-ghost btn-lg">Ver servicios</a>
              </div>
            </>
          )}
        </div>
        {config && (
          <div className="hero-bar">
            <span><IconClock size={18} /> Hoy: {today.length ? today.map((r) => `${r.start}–${r.end}`).join(' · ') : 'cerrado'}</span>
            {config.shop.address && <span><IconPin size={18} /> {config.shop.address}</span>}
            {config.shop.phone && <a href={`tel:${config.shop.phone}`}><IconPhone size={18} /> {config.shop.phone}</a>}
          </div>
        )}
      </section>

      {config && (
        <>
          <section id="servicios" className="section">
            <div className="section-grid">
              <div>
                <p className="eyebrow">La carta</p>
                <h2 className="section-title">Servicios</h2>
                <ul className="menu-list">
                  {config.services.map((s) => (
                    <li key={s.id}>
                      <span className="menu-icon">{serviceIcon(s.name)}</span>
                      <span className="menu-name">{s.name}</span>
                      <span className="menu-dots" aria-hidden />
                      <span className="menu-price">{money(s.priceCents)}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted small">Cada cita dura {config.slotMinutes} minutos.</p>
                {!isAdmin && <Link to={bookTo} className="btn btn-primary">Reservar ahora</Link>}
              </div>
              <figure className="photo-frame">
                <img src={corteBarbero} alt="Barbero haciendo un corte a máquina" loading="lazy" />
              </figure>
            </div>
          </section>

          <section className="section section-alt">
            <p className="eyebrow center">Reserva sin llamadas</p>
            <h2 className="section-title center">Tu barbería, en el bolsillo</h2>
            <div className="features">
              <article><IconCalendar size={30} /><h3>Reserva online</h3><p>Elige día y hora libres, hasta un año vista, a cualquier hora.</p></article>
              <article><IconRepeat size={30} /><h3>Citas periódicas</h3><p>¿Vienes cada 15 días? Reserva todo el año de una vez.</p></article>
              <article><IconCard size={30} /><h3>Paga como quieras</h3><p>Online con PayPal o en el local, al terminar.</p></article>
              <article><IconBell size={30} /><h3>Sin sorpresas</h3><p>Confirmación por email. Cambia o cancela hasta {config.clientCancelMinNoticeMinutes >= 60 ? `${config.clientCancelMinNoticeMinutes / 60} h` : `${config.clientCancelMinNoticeMinutes} min`} antes.</p></article>
            </div>
          </section>

          <section className="section">
            <div className="gallery">
              <img src={corteEstilista} alt="Degradado a máquina" loading="lazy" />
              <img src={hero} alt="Barbero peinando a un cliente" loading="lazy" />
              <img src={barbaBn} alt="Afeitado clásico en una barbería tradicional" loading="lazy" />
            </div>
          </section>

          <section className="section section-alt">
            <div className="section-grid">
              <div>
                <p className="eyebrow">Cuándo venir</p>
                <h2 className="section-title">Horario</h2>
                <ul className="hours">
                  {Object.entries(weekdayNames).map(([d, name]) => (
                    <li key={d} className={d === todayIso() ? 'is-today' : ''}>
                      <span>{name}</span>
                      <span>{config.weeklySchedule[d]?.length ? config.weeklySchedule[d].map((r) => `${r.start}–${r.end}`).join('  ·  ') : 'Cerrado'}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="cta-panel">
                <h3>¿Te toca repaso?</h3>
                <p>Reserva tu próxima cita en un minuto y recibe la confirmación por email.</p>
                {isAdmin
                  ? <Link to="/admin/agenda" className="btn btn-gold btn-lg">Ver la agenda</Link>
                  : <Link to={bookTo} className="btn btn-gold btn-lg">Reservar cita</Link>}
                {config.shop.phone && <p className="small">O llámanos al <a href={`tel:${config.shop.phone}`}>{config.shop.phone}</a></p>}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
