import { useEffect, useState } from 'react';
import { api, assetUrl } from '../lib/api';
import { money } from '../lib/format';
import type { TicketRef, TicketView } from '../lib/types';
import { Alert, Modal, Spinner, errMsg } from './ui';
import { IconTicket } from './icons';

const isNativeApp = () => !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

/** Descarga el PDF de un ticket con un enlace temporal firmado por el servidor. */
export async function downloadTicket(id: string) {
  const { url } = await api.get<{ url: string }>(`/tickets/${id}/link`);
  const full = assetUrl(url);
  // En móvil se abre con el visor del sistema; en web y escritorio el servidor lo envía como descarga.
  if (isNativeApp()) window.open(full, '_system');
  else window.location.href = full;
}

/** Botón "Ticket AAAA-NNNN": abre la vista previa del ticket, desde la que se descarga. */
export function TicketButton({ ticket, small = true, refunded = false, rectification = false }: { ticket: TicketRef; small?: boolean; refunded?: boolean; rectification?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn ${small ? 'btn-sm' : ''} btn-ticket ${refunded ? 'is-refunded' : ''}`} title={`Ver ${rectification ? 'rectificativo' : 'ticket'} ${ticket.number}${refunded ? ' (reembolsado)' : ''}`} onClick={() => setOpen(true)}>
        <IconTicket size={16} /> {rectification ? 'Rectificativo' : 'Ticket'} {ticket.number}{refunded && <small> · reembolsado</small>}
      </button>
      {open && <TicketModal ticket={ticket} onClose={() => setOpen(false)} />}
    </>
  );
}

export function TicketModal({ ticket, onClose }: { ticket: TicketRef; onClose: () => void }) {
  const [view, setView] = useState<TicketView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<TicketView>(`/tickets/${ticket.id}`).then(setView).catch((e) => setError(errMsg(e))); }, [ticket.id]);

  const download = async () => {
    setBusy(true); setError('');
    try { await downloadTicket(ticket.id); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={`${view?.rectifies ? 'Rectificativo' : 'Ticket'} ${ticket.number}`} onClose={onClose}>
      <Alert>{error}</Alert>
      {!view && !error && <Spinner />}
      {view && <TicketPaper v={view} />}
      <div className="ticket-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !view} onClick={download}>
          {busy ? 'Preparando…' : 'Descargar PDF'}
        </button>
        <button type="button" className="btn" onClick={onClose}>Cerrar</button>
      </div>
    </Modal>
  );
}

/** Ticket con aspecto de papel (siempre claro, como el PDF). */
function TicketPaper({ v }: { v: TicketView }) {
  const cur = (c: number) => money(c);
  return (
    <article className="ticket-paper" aria-label={`Ticket ${v.number}`}>
      <header>
        <h3>{v.issuer.name}</h3>
        {v.issuer.lines.map((l) => <p key={l}>{l}</p>)}
      </header>
      <h4>{v.rectifies ? 'Ticket rectificativo' : 'Ticket de compra'}</h4>
      <dl>
        <dt>{v.rectifies ? 'Nº rectificativo' : 'Nº de ticket'}</dt><dd>{v.number}</dd>
        <dt>Fecha</dt><dd>{v.issuedAtText}</dd>
        <dt>Cliente</dt><dd>{v.client}</dd>
        <dt>{v.rectifies ? 'Devolución' : 'Forma de pago'}</dt><dd>{v.method}</dd>
        {v.rectifies && <><dt>Rectifica a</dt><dd>Ticket {v.rectifies.number} ({v.rectifies.issuedAtText})</dd><dt>Motivo</dt><dd>{v.rectifies.reason}</dd></>}
      </dl>
      <table>
        <thead><tr><th>Concepto</th><th>Importe</th></tr></thead>
        <tbody>
          {v.lines.map((l, i) => (
            <tr key={i}><td>{l.concept}<small>{l.detail}</small></td><td>{cur(l.amountCents)}</td></tr>
          ))}
        </tbody>
        <tfoot>
          {v.baseCents !== null && v.vatCents !== null && (
            <>
              <tr><td>Base imponible</td><td>{cur(v.baseCents)}</td></tr>
              <tr><td>IVA {String(v.vatPercent).replace('.', ',')} %</td><td>{cur(v.vatCents)}</td></tr>
            </>
          )}
          <tr className="total"><td>{v.vatPercent > 0 ? 'Total (IVA incluido)' : 'Total'}</td><td>{cur(v.totalCents)}</td></tr>
          {v.refundedCents > 0 && <tr className="refunded"><td>Reembolsado{v.rectifications.length > 0 && <small>Rectificativo: {v.rectifications.join(', ')}</small>}</td><td>-{cur(v.refundedCents)}</td></tr>}
        </tfoot>
      </table>
      {v.reference && <p className="ref">Referencia {v.rectifies ? 'del reembolso' : 'del pago'}: {v.reference}</p>}
      {v.footer && !v.rectifies && <p className="foot">{v.footer}</p>}
    </article>
  );
}

/** Botones de todos los tickets de una cita. */
export function TicketButtons({ tickets }: { tickets: (TicketRef & { refunded: boolean; rectification?: boolean })[] }) {
  return <>{tickets.map((t) => <TicketButton key={t.id} ticket={t} refunded={t.refunded} rectification={t.rectification} />)}</>;
}
