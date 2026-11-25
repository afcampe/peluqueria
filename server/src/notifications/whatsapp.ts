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
  return post(phone, { type: 'text', text: { body } });
}

/**
 * Envío con una plantilla aprobada en Meta (necesaria para los recordatorios,
 * que se mandan sin que el cliente haya escrito antes). Los parámetros
 * rellenan {{1}}, {{2}}... del cuerpo de la plantilla, en orden.
 */
export async function sendWhatsAppTemplate(phone: string, name: string, lang: string, params: string[], buttons: string[] = []) {
  return post(phone, {
    type: 'template',
    template: { name, language: { code: lang || 'es' }, components: [
      { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
      // Botones de respuesta rápida de la plantilla (en el mismo orden: Sí, No).
      ...buttons.map((payload, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] })),
    ] },
  });
}

/** Texto libre con botones de respuesta (solo a quien ha escrito en las últimas 24 h). */
export async function sendWhatsAppButtons(phone: string, body: string, buttons: { id: string; title: string }[]) {
  return post(phone, { type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: b })) } } });
}

export const whatsappRepliesConfigured = () => Boolean(config.whatsapp.appSecret && config.whatsapp.verifyToken);

async function post(phone: string, message: Record<string, unknown>) {
  if (!whatsappApiConfigured()) throw new HttpError(400, 'La API de WhatsApp no está configurada');
  const to = normalizePhone(phone);
  if (!to) throw new HttpError(400, `Teléfono no válido: ${phone}`);
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...message }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new HttpError(502, `WhatsApp: ${data.error?.message ?? res.statusText}`);
  }
}
