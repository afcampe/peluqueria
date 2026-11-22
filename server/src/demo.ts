import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { prisma } from './lib/db.js';
import { getSettings } from './services/settings.js';
import { issueTicket } from './services/tickets.js';

/**
 * Datos de ejemplo para enseñar la aplicación (solo con DEMO_DATA=true y si
 * aún no hay ningún cliente). Clientes ficticios con emails @example.com,
 * citas pasadas y futuras, cobros con ticket, anulaciones y ausencias.
 */

if (process.env.DEMO_DATA !== 'true') process.exit(0);
if ((await prisma.user.count({ where: { role: 'CLIENT' } })) > 0) {
  console.log('[demo] ya hay clientes: no se crean datos de ejemplo');
  process.exit(0);
}

const s = await getSettings();
const tz = s.timezone;
const services = await prisma.service.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
const password = await bcrypt.hash(process.env.DEMO_CLIENT_PASSWORD ?? 'cliente1234', 10);

const people = [
  ['Javier Ruiz', '612345001'], ['Carlos Méndez', '612345002'], ['Luis Ortega', '612345003'], ['Pablo Serrano', '612345004'],
  ['Andrés Gil', '612345005'], ['Miguel Navarro', '612345006'], ['Sergio Vidal', '612345007'], ['Raúl Campos', '612345008'],
  ['Diego Fernández', '612345009'], ['Álvaro Prieto', '612345010'],
] as const;

const clients = [];
for (const [i, [name, phone]] of people.entries()) {
  const first = name.split(' ')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  clients.push(await prisma.user.create({
    data: {
      name, phone, email: `${first}${i}@example.com`, passwordHash: password,
      remindEmail: s.reminders.enabled && s.reminders.email, remindWhatsapp: s.reminders.enabled && s.reminders.whatsapp,
    },
  }));
}
// Una ficha sin cuenta, como las que salen de la agenda en papel
clients.push(await prisma.user.create({ data: { name: 'Manolo (agenda)', acceptsEmail: false, remindEmail: false, remindWhatsapp: false } }));

const now = DateTime.now().setZone(tz);
const hours = ['09:00', '09:30', '10:30', '11:00', '12:00', '12:30', '16:00', '16:30', '17:30', '18:00', '19:00'];
let k = 0;
let created = 0;
for (let d = -14; d <= 21; d++) {
  const day = now.plus({ days: d }).startOf('day');
  const ranges = s.weeklySchedule[String(day.weekday) as keyof typeof s.weeklySchedule] ?? [];
  if (!ranges.length) continue; // día cerrado
  const n = ((d + 20) * 7) % 5 + 2;
  const used = new Set<string>();
  for (let j = 0; j < n; j++) {
    const hhmm = hours[(j * 4 + d + 30) % hours.length];
    if (used.has(hhmm)) continue;
    used.add(hhmm);
    const [h, m] = hhmm.split(':').map(Number);
    const start = day.set({ hour: h, minute: m });
    const svc = services[k % services.length];
    const client = clients[(k * 3 + d + 40) % clients.length];
    k++;
    const past = start < now;
    const status = past ? (k % 9 === 0 ? 'NO_SHOW' : k % 11 === 0 ? 'CANCELLED' : 'COMPLETED') : (k % 13 === 0 ? 'CANCELLED' : 'CONFIRMED');
    const a = await prisma.appointment.create({
      data: {
        clientId: client.id, serviceId: svc.id, startAt: start.toJSDate(), endAt: start.plus({ minutes: s.slotMinutes }).toJSDate(),
        status, paymentMethod: 'cash', priceCents: svc.priceCents,
        createdAt: start.minus({ days: 5 }).toJSDate(),
        ...(status === 'CANCELLED' && { cancelledAt: start.minus({ days: 1 }).toJSDate(), cancelledBy: k % 2 ? 'CLIENT' : 'ADMIN' }),
      },
    });
    created++;
    // Las realizadas están cobradas en el local; la mayoría con ticket.
    if (status === 'COMPLETED') {
      const p = await prisma.payment.create({ data: { appointmentId: a.id, provider: 'cash', amountCents: a.priceCents, currency: s.currency, status: 'COMPLETED' } });
      if (k % 3 !== 0) await issueTicket([p.id], 'SHOP');
    }
  }
}
console.log(`[demo] ${clients.length} clientes y ${created} citas de ejemplo creados`);
await prisma.$disconnect();
