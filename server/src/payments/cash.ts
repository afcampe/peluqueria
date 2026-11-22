import type { PaymentProvider } from './types.js';

/** Pago en metálico en la peluquería: la cita se confirma sin cobro online. */
export const cashProvider: PaymentProvider = {
  id: 'cash',
  label: 'Pago en el local (efectivo)',
  online: false,
  isConfigured: () => true,
  publicConfig: () => ({}),
};
