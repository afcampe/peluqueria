import { config } from './config.js';
import { createApp } from './app.js';
import { expirePendingPayments } from './services/appointments.js';
import { resumeImportQueue } from './services/agendaImport.js';
import { runReminders } from './services/reminders.js';

createApp().listen(config.port, () => {
  console.log(`API de Peluquería Armando en http://localhost:${config.port}`);
});

// Retoma la lectura de fotos de la agenda que quedara pendiente.
resumeImportQueue().catch((e) => console.error('[importación]', e));

// Libera cada minuto los huecos cuyo pago online no se completó.
setInterval(() => {
  // Recordatorios de las próximas citas (email / WhatsApp) según la configuración.
  runReminders().catch((e) => console.error('[recordatorios]', e));
  expirePendingPayments().catch((e) => console.error('[expirar pagos]', e));
}, 60_000);
