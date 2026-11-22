import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useState } from 'react';
import { api } from '../lib/api';
import { Alert } from './ui';

/**
 * Botones de PayPal. `basePath` es la ruta de la API que gestiona el pedido:
 * `/appointments/:id` para una cita o `/appointments/series/:id` para una serie.
 */
export function PayPalCheckout<T>({ basePath, clientId, currency, onPaid }: {
  basePath: string; clientId: string; currency: string; onPaid: (result: T) => void;
}) {
  const [error, setError] = useState('');
  return (
    <div className="paypal-box">
      <Alert>{error}</Alert>
      <PayPalScriptProvider options={{ clientId, currency, locale: 'es_ES', intent: 'capture' }}>
        <PayPalButtons
          style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
          createOrder={async () => {
            setError('');
            const { orderId } = await api.post<{ orderId: string }>(`${basePath}/pay/start`);
            return orderId;
          }}
          onApprove={async (data) => {
            try {
              onPaid(await api.post<T>(`${basePath}/pay/complete`, { orderId: data.orderID }));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          onError={() => setError('No se pudo completar el pago con PayPal. Inténtalo de nuevo.')}
        />
      </PayPalScriptProvider>
    </div>
  );
}
