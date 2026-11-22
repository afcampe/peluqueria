import { useState } from 'react';
import { api, assetUrl } from '../lib/api';
import type { TicketRef } from '../lib/types';
import { errMsg } from './ui';
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

export function TicketButton({ ticket, small = true }: { ticket: TicketRef; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button type="button" className={`btn ${small ? 'btn-sm' : ''} btn-ticket`} disabled={busy} title={`Descargar ticket ${ticket.number} (PDF)`}
        onClick={async () => {
          setBusy(true); setError('');
          try { await downloadTicket(ticket.id); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
        }}>
        <IconTicket size={16} /> Ticket {ticket.number}
      </button>
      {error && <span className="error-text small">{error}</span>}
    </>
  );
}
