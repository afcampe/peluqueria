import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

/** Normaliza a formato internacional sin "+" (asume España si son 9 dígitos). */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '');
  if (digits.length === 9) digits = `34${digits}`;
  return digits.length >= 10 ? digits : null;
}

/** Enlace click-to-chat: abre WhatsApp (web, escritorio o móvil) con el texto escrito. */
export function waLink(phone: string | null | undefined, text = '') {
  const n = normalizePhone(phone);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export const whatsappApiConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);

/**
 * Envío automático mediante WhatsApp Business Cloud API (Meta).
 * Ojo: Meta solo permite texto libre si el cliente ha escrito en las últimas 24 h;
 * fuera de esa ventana hay que usar plantillas aprobadas.
 */
export async function sendWhatsApp(phone: string, body: string) {
  if (!whatsappApiConfigured()) throw new HttpError(400, 'La API de WhatsApp no está configurada');
  const to = normalizePhone(phone);
  if (!to) throw new HttpError(400, `Teléfono no válido: ${phone}`);
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new HttpError(502, `WhatsApp: ${data.error?.message ?? res.statusText}`);
  }
}
