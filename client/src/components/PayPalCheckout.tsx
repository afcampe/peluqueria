import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useState } from 'react';
import { api } from '../lib/api';
import type { Appointment } from '../lib/types';
import { Alert } from './ui';

export function PayPalCheckout({ appointmentId, clientId, currency, onPaid }: {
  appointmentId: string; clientId: string; currency: string; onPaid: (a: Appointment) => void;
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
            const { orderId } = await api.post<{ orderId: string }>(`/appointments/${appointmentId}/pay/start`);
            return orderId;
          }}
          onApprove={async (data) => {
            try {
              onPaid(await api.post<Appointment>(`/appointments/${appointmentId}/pay/complete`, { orderId: data.orderID }));
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
