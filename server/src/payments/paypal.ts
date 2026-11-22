import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { amountToCents, centsToAmount, type PaymentProvider } from './types.js';

const baseUrl = () =>
  config.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new HttpError(502, 'No se pudo conectar con PayPal');
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function call<T>(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; details?: { description?: string }[] };
  if (!res.ok) {
    const detail = data.details?.[0]?.description ?? data.message ?? res.statusText;
    throw new HttpError(502, `PayPal: ${detail}`);
  }
  return data;
}

export const paypalProvider: PaymentProvider = {
  id: 'paypal',
  label: 'PayPal / tarjeta',
  online: true,
  isConfigured: () => Boolean(config.paypal.clientId && config.paypal.clientSecret),
  publicConfig: () => ({ clientId: config.paypal.clientId }),

  async createOrder({ reference, description, amountCents, currency }) {
    const order = await call<{ id: string }>('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [
        { reference_id: reference, description, amount: { currency_code: currency, value: centsToAmount(amountCents) } },
      ],
    });
    return { orderId: order.id };
  },

  async captureOrder(orderId) {
    type Capture = { id: string; status: string; amount: { value: string; currency_code: string } };
    const data = await call<{ status: string; payer?: { email_address?: string; payer_id?: string }; purchase_units: { payments: { captures: Capture[] } }[] }>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
    );
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (data.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED') {
      throw new HttpError(402, 'El pago no se ha completado');
    }
    return {
      captureId: capture.id,
      amountCents: amountToCents(capture.amount.value),
      currency: capture.amount.currency_code,
      payer: { email: data.payer?.email_address, id: data.payer?.payer_id },
    };
  },

  async refund({ captureId, amountCents, currency, idempotencyKey, note }) {
    const data = await call<{ id: string }>(
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      { amount: { value: centsToAmount(amountCents), currency_code: currency }, ...(note && { note_to_payer: note.slice(0, 255) }) },
      { 'PayPal-Request-Id': idempotencyKey },
    );
    return { refundId: data.id };
  },
};
