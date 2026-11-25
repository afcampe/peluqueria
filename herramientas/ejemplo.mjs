// Completa los datos de ejemplo con lo que la demo no tiene: pagos con PayPal (ficticios), cobro con ticket y una serie.
// Lo llama app.sh. Con "zona" como argumento, solo fija la zona horaria (antes de crear los datos).
import { prisma } from '../server/dist/lib/db.js';
import { getSettings } from '../server/dist/services/settings.js';

if (process.argv[2] === 'zona') {
  const row = await prisma.setting.findUnique({ where: { key: 'business' } });
  const value = JSON.stringify({ ...(row ? JSON.parse(row.value) : {}), timezone: process.env.ZONA });
  await prisma.setting.upsert({ where: { key: 'business' }, create: { key: 'business', value }, update: { value } });
  process.exit(0);
}
const { issueTicket } = await import('../server/dist/services/tickets.js');
if (!(await prisma.payment.count({ where: { provider: 'paypal' } }))) {
  const s = await getSettings();
  const libres = await prisma.appointment.findMany({ where: { status: 'CONFIRMED', startAt: { gt: new Date() }, payments: { none: {} }, client: { email: { in: ['javier0@example.com', 'carlos1@example.com', 'luis2@example.com'] } } }, include: { client: true }, orderBy: { startAt: 'asc' } });
  const de = (n) => libres.find((a) => a.client.email.startsWith(n));
  for (const [quien, provider] of [['javier0', 'paypal'], ['carlos1', 'paypal'], ['luis2', 'cash']]) {
    const a = de(quien);
    if (!a) continue;
    const online = provider === 'paypal';
    const p = await prisma.payment.create({ data: { appointmentId: a.id, provider, amountCents: a.priceCents, currency: s.currency, status: 'COMPLETED', capturedAt: new Date(), ...(online && { providerOrderId: `EJ${a.id}`, providerCaptureId: `EJC${a.id}`, payerEmail: a.client.email, payerId: 'EJEMPLO' }) } });
    if (online) await prisma.appointment.update({ where: { id: a.id }, data: { paymentMethod: 'paypal', attendance: 'YES', attendanceAt: new Date(), attendanceBy: 'EMAIL' } });
    await issueTicket([p.id], online ? 'ONLINE' : 'SHOP');
  }
  const serie = libres.filter((a) => a.client.email.startsWith('javier0')).slice(1, 4);
  if (serie.length > 1) {
    const { id } = await prisma.appointmentSeries.create({ data: { clientId: serie[0].clientId, intervalDays: 14 } });
    await prisma.appointment.updateMany({ where: { id: { in: serie.map((a) => a.id) } }, data: { seriesId: id } });
  }
}
process.exit(0);
