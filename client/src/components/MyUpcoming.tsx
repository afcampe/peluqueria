import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { canClientChange, dateLong, dateTime, methodLabel, money, noticeText, shownStatus, statusLabel, time } from '../lib/format';
import { activePayment, cashPayment, ticketsOf } from '../lib/payment';
import { useSession } from '../lib/session';
import type { Appointment } from '../lib/types';
import { IconRepeat } from './icons';
import { TicketButtons } from './TicketButton';
import { Alert, Badge, Modal, Spinner, errMsg } from './ui';

const FIRST = 5;

const payText = (a: Appointment) =>
  a.status === 'PENDING_PAYMENT' ? 'Pago sin completar' : activePayment(a) ? 'Pagada' : 'Pagas en la peluquería';

/** Citas actuales y futuras del cliente, para verlas sin salir de la pantalla de reservar. */
export function MyUpcoming({ refresh }: { refresh?: unknown }) {
  const [list, setList] = useState<Appointment[] | null>(null);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  const [detail, setDetail] = useState<Appointment | null>(null);

  useEffect(() => {
    let live = true;
    api.get<Appointment[]>('/appointments').then((r) => {
      if (!live) return;
      const now = Date.now();
      setList(r.filter((a) => ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status) && Date.parse(a.endAt) > now).sort((a, b) => a.startAt.localeCompare(b.startAt)));
      setError('');
    }).catch((e) => live && setError(errMsg(e)));
    return () => { live = false; };
  }, [refresh]);

  const shown = all ? list ?? [] : (list ?? []).slice(0, FIRST);
  return (
    <section className="card my-upcoming" aria-label="Tus próximas citas">
      <div className="dash-head"><h2>Tus próximas citas {list && list.length > 0 && <small className="muted">{list.length}</small>}</h2><Link to="/mis-citas" className="small">Ir a Mis citas</Link></div>
      <Alert>{error}</Alert>
      {!list && !error && <Spinner />}
      {list?.length === 0 && <p className="muted">No tienes ninguna cita reservada.</p>}
      {shown.length > 0 && (
        <ul>
          {shown.map((a) => (
            <li key={a.id}>
              <div className="mu-when"><strong>{dateLong(a.startAt)}</strong><span>{time(a.startAt)}</span></div>
              <div className="mu-what"><span>{a.service.name} · {money(a.priceCents)}</span><span className="muted small">{payText(a)}{a.series && ` · cada ${a.series.intervalDays} días`}</span></div>
              <button type="button" className="btn btn-sm" onClick={() => setDetail(a)} aria-label={`Ver detalles de la cita del ${dateTime(a.startAt)}`}>Ver detalles</button>
            </li>
          ))}
        </ul>
      )}
      {list && list.length > FIRST && <button type="button" className="link small" onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver las ${list.length}`}</button>}
      {detail && <Detail a={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function Detail({ a, onClose }: { a: Appointment; onClose: () => void }) {
  const { config } = useSession();
  const notice = config?.clientCancelMinNoticeMinutes ?? 60;
  const shop = config?.shop;
  const changeable = canClientChange(a.startAt, notice);
  const tickets = ticketsOf(a);
  const paid = activePayment(a);
  return (
    <Modal title="Detalles de la cita" onClose={onClose}>
      <dl className="payment-data mu-detail">
        <dt>Día</dt><dd>{dateLong(a.startAt)}</dd>
        <dt>Hora</dt><dd>{time(a.startAt)}–{time(a.endAt)}</dd>
        <dt>Servicio</dt><dd>{a.service.name}</dd>
        <dt>Precio</dt><dd>{money(a.priceCents)}</dd>
        <dt>Pago</dt><dd>{payText(a)}{paid && ` (${methodLabel(paid.provider)})`}</dd>
        <dt>Estado</dt><dd><Badge status={shownStatus(a)}>{statusLabel[shownStatus(a)]}</Badge></dd>
        {a.series && <><dt>Serie</dt><dd><span className="series-badge"><IconRepeat size={14} /> cada {a.series.intervalDays} días</span></dd></>}
        {a.notes && <><dt>Comentarios</dt><dd>{a.notes}</dd></>}
        {shop?.address && <><dt>Dirección</dt><dd>{shop.address}</dd></>}
        {shop?.phone && <><dt>Teléfono</dt><dd><a href={`tel:${shop.phone}`}>{shop.phone}</a></dd></>}
      </dl>
      {tickets.length > 0 && <div className="actions mu-tickets"><TicketButtons tickets={tickets} /></div>}
      <p className="muted small">
        {!changeable ? `Faltan menos de ${noticeText(notice)}: para cambiarla o cancelarla, llama a la peluquería.`
          : cashPayment(a) ? 'Ya está cobrada en el local. Puedes cambiarla de hora en Mis citas; para cancelarla, llama a la peluquería.'
          : `Puedes cambiarla o cancelarla en Mis citas hasta ${noticeText(notice)} antes.`}
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn" onClick={onClose}>Cerrar</button>
        {changeable && <Link className="btn btn-primary" to="/mis-citas">{cashPayment(a) ? 'Cambiar hora' : 'Cambiar o cancelar'}</Link>}
      </div>
    </Modal>
  );
}
