import { config } from './config.js';
import { createApp } from './app.js';
import { expirePendingPayments } from './services/appointments.js';

createApp().listen(config.port, () => {
  console.log(`API de Peluquería Armando en http://localhost:${config.port}`);
});

// Libera cada minuto los huecos cuyo pago online no se completó.
setInterval(() => {
  expirePendingPayments().catch((e) => console.error('[expirar pagos]', e));
}, 60_000);
