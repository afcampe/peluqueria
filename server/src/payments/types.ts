/**
 * Contrato que debe cumplir cualquier forma de pago.
 * Para añadir una nueva (Stripe, Bizum, Redsys...):
 *   1. Crea un fichero en esta carpeta que implemente PaymentProvider.
 *   2. Regístralo en registry.ts.
 *   3. Actívalo desde Admin > Configuración > Métodos de pago.
 */
export interface PaymentProvider {
  /** Identificador estable que se guarda en la cita ("cash", "paypal"...). */
  id: string;
  label: string;
  /** true si el cliente paga al reservar; false si se paga en el local. */
  online: boolean;
  /** Si faltan credenciales, el método no se ofrece aunque esté activado. */
  isConfigured(): boolean;
  /** Datos que el frontend necesita (p. ej. clientId público de PayPal). */
  publicConfig(): Record<string, unknown>;
  createOrder?(args: { reference: string; description: string; amountCents: number; currency: string }): Promise<{ orderId: string }>;
  captureOrder?(orderId: string): Promise<{ captureId: string; amountCents: number; currency: string; payer?: { email?: string; id?: string } }>;
  refund?(args: { captureId: string; amountCents: number; currency: string; idempotencyKey: string; note?: string }): Promise<{ refundId: string }>;
}

export const centsToAmount = (cents: number) => (cents / 100).toFixed(2);
export const amountToCents = (amount: string) => Math.round(Number(amount) * 100);
