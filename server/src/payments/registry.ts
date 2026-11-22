import { badRequest } from '../lib/errors.js';
import type { Settings } from '../services/settings.js';
import { cashProvider } from './cash.js';
import { paypalProvider } from './paypal.js';
import type { PaymentProvider } from './types.js';

// Añade aquí nuevos proveedores de pago.
const providers: PaymentProvider[] = [cashProvider, paypalProvider];

export const allProviders = () => providers;

export function getProvider(id: string): PaymentProvider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw badRequest(`Método de pago desconocido: ${id}`);
  return p;
}

/** Métodos que se pueden usar ahora mismo: activados en ajustes y configurados. */
export function enabledProviders(settings: Settings) {
  return providers.filter((p) => settings.paymentMethods[p.id]?.enabled && p.isConfigured());
}
