import { config } from './config.js';
import { createApp } from './app.js';
import { prisma } from './lib/db.js';
import { expirePendingPayments } from './services/appointments.js';
import { resumeImportQueue } from './services/agendaImport.js';
import { fillMissingVat, issueMissingRectifications } from './services/tickets.js';
import { runReminders } from './services/reminders.js';

const server = createApp().listen(config.port, () => {
  console.log(`API de Peluquería Armando en http://localhost:${config.port}`);
});

// Retoma la lectura de fotos de la agenda que quedara pendiente.
resumeImportQueue().catch((e) => console.error('[importación]', e));

// Rectificativos que no se pudieron emitir en su momento.
const rectify = () => issueMissingRectifications().catch((e) => console.error('[rectificativos]', e));
fillMissingVat().catch((e) => console.error('[iva]', e)).finally(rectify);

// Libera cada minuto los huecos cuyo pago online no se completó.
const timer = setInterval(() => {
  // Recordatorios de las próximas citas (email / WhatsApp) según la configuración.
  runReminders().catch((e) => console.error('[recordatorios]', e));
  rectify();
  expirePendingPayments().catch((e) => console.error('[expirar pagos]', e));
}, 60_000);

// Al publicar una versión nueva, el servidor recibe SIGTERM: termina las
// peticiones en curso y sale con código 0 (si no, Railway lo da por caído).
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const exit = () => { prisma.$disconnect().catch(() => {}).finally(() => process.exit(0)); };
  server.close(exit);
  server.closeIdleConnections();
  setTimeout(exit, 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
