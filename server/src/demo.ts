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
  await demoHistory();
  await demoClients();
  await demoAttendance();
  console.log('[demo] ya hay clientes: no se crean más datos de ejemplo');
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
await demoHistory();
await demoClients();
await demoAttendance();
console.log(`[demo] ${clients.length} clientes y ${created} citas de ejemplo creados`);
await prisma.$disconnect();

/**
 * Historial de ejemplo para los gráficos del Resumen: unos 7 meses de citas pasadas y
 * cobradas de los clientes ficticios (@example.com), y los cobros de ejemplo con la fecha
 * de su cita. Solo se hace una vez (si no hay citas de hace más de 30 días).
 */
async function demoHistory() {
  const s = await getSettings();
  const now = DateTime.now().setZone(s.timezone);
  if (await prisma.appointment.count({ where: { startAt: { lt: now.minus({ days: 30 }).toJSDate() } } })) return;
  const clients = await prisma.user.findMany({ where: { role: 'CLIENT', email: { endsWith: '@example.com' } }, orderBy: { email: 'asc' } });
  const services = await prisma.service.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  if (!clients.length || !services.length) return;

  const demoPays = await prisma.payment.findMany({ where: { provider: 'cash', appointment: { client: { email: { endsWith: '@example.com' } }, startAt: { lt: now.toJSDate() } } }, include: { appointment: true } });
  for (const p of demoPays) if (p.createdAt > p.appointment.endAt) await prisma.payment.update({ where: { id: p.id }, data: { createdAt: p.appointment.endAt } });

  let k = 0;
  const start = now.minus({ days: 210 }).startOf('day');
  const end = now.minus({ days: 15 }).startOf('day');
  for (let day = start; day < end; day = day.plus({ days: 1 })) {
    const ranges = s.weeklySchedule[String(day.weekday) as keyof typeof s.weeklySchedule] ?? [];
    const growth = 0.75 + 0.35 * (day.diff(start, 'days').days / 195); // el negocio va creciendo
    for (const r of ranges) {
      const [h0, m0] = r.start.split(':').map(Number);
      const [h1, m1] = r.end.split(':').map(Number);
      for (let t = h0 * 60 + m0; t + s.slotMinutes <= h1 * 60 + m1; t += s.slotMinutes) {
        // Más llenos los viernes y las tardes a partir de las 17 h.
        const rnd = ((k * 7919 + t * 31 + day.ordinal * 17) % 100) / 100;
        const p = (t >= 17 * 60 ? 0.6 : t >= 11 * 60 ? 0.42 : 0.25) * growth * (day.weekday === 5 ? 1.3 : day.weekday === 2 ? 0.75 : 1);
        k++;
        if (rnd >= p) continue;
        const at = day.set({ hour: Math.floor(t / 60), minute: t % 60 });
        const svc = services[(k * 3) % services.length];
        const status = k % 19 === 0 ? 'NO_SHOW' : k % 23 === 0 ? 'CANCELLED' : 'COMPLETED';
        const online = k % 4 === 0;
        const paid = at.plus(online ? { days: -2 } : { minutes: s.slotMinutes }).toJSDate();
        await prisma.appointment.create({
          data: {
            clientId: clients[k % clients.length].id, serviceId: svc.id, startAt: at.toJSDate(), endAt: at.plus({ minutes: s.slotMinutes }).toJSDate(),
            status, paymentMethod: status === 'COMPLETED' && online ? 'paypal' : 'cash', priceCents: svc.priceCents, createdAt: at.minus({ days: 6 }).toJSDate(),
            ...(status === 'CANCELLED' && { cancelledAt: at.minus({ days: 1 }).toJSDate(), cancelledBy: k % 2 ? 'CLIENT' : 'ADMIN' }),
            ...(status === 'COMPLETED' && { payments: { create: {
              provider: online ? 'paypal' : 'cash', amountCents: svc.priceCents, currency: s.currency, status: 'COMPLETED', createdAt: paid,
              ...(online && { capturedAt: paid, providerOrderId: `DEMO-O-${k}`, providerCaptureId: `DEMO-C-${k}` }),
            } } }),
          },
        });
      }
    }
  }
  console.log('[demo] historial de ejemplo creado para los gráficos');
}

/** Clientes de ejemplo para el apartado Clientes del Resumen: tres que han dejado de venir y dos nuevos. Solo una vez. */
async function demoClients() {
  if (await prisma.user.count({ where: { email: 'victor10@example.com' } })) return;
  const s = await getSettings();
  const now = DateTime.now().setZone(s.timezone);
  const services = await prisma.service.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  if (!services.length) return;
  const hash = await bcrypt.hash(process.env.DEMO_CLIENT_PASSWORD ?? 'cliente1234', 10);
  // [nombre, email, teléfono, días desde cada visita, acepta novedades]
  const list: [string, string, string, number[], boolean][] = [
    ['Víctor Soler', 'victor10', '612345011', [74, 102, 131, 160, 188], true],
    ['Hugo Marín', 'hugo11', '612345012', [61, 82, 103, 124, 146, 167], true],
    ['Óscar Peña', 'oscar12', '612345013', [95, 130, 166], false],
    ['Iván Crespo', 'ivan13', '612345014', [6], true],
    ['Marcos Rey', 'marcos14', '612345015', [11], true],
  ];
  for (const [name, email, phone, ago, acceptsEmail] of list) {
    const u = await prisma.user.create({ data: { name, email: `${email}@example.com`, phone, passwordHash: hash, acceptsEmail, acceptsWhatsapp: acceptsEmail, remindEmail: s.reminders.enabled && s.reminders.email, remindWhatsapp: s.reminders.enabled && s.reminders.whatsapp, createdAt: now.minus({ days: Math.max(...ago) + 2 }).toJSDate() } });
    for (const [i, d] of ago.entries()) {
      // Día laborable y hora libre más cercanos
      let day = now.minus({ days: d }).startOf('day');
      for (let n = 0; n < 7 && !(s.weeklySchedule[String(day.weekday) as keyof typeof s.weeklySchedule] ?? []).length; n++) day = day.minus({ days: 1 });
      const ranges = s.weeklySchedule[String(day.weekday) as keyof typeof s.weeklySchedule] ?? [];
      let at: DateTime | null = null;
      for (const r of ranges) {
        const [h0, m0] = r.start.split(':').map(Number);
        const [h1, m1] = r.end.split(':').map(Number);
        for (let t = h0 * 60 + m0; t + s.slotMinutes <= h1 * 60 + m1 && !at; t += s.slotMinutes) {
          const c = day.set({ hour: Math.floor(t / 60), minute: t % 60 });
          if (!(await prisma.appointment.count({ where: { startAt: c.toJSDate(), status: { not: 'CANCELLED' } } }))) at = c;
        }
      }
      if (!at) continue;
      const svc = services[i % Math.min(2, services.length)];
      const end = at.plus({ minutes: s.slotMinutes });
      await prisma.appointment.create({ data: {
        clientId: u.id, serviceId: svc.id, startAt: at.toJSDate(), endAt: end.toJSDate(), status: 'COMPLETED', paymentMethod: 'cash', priceCents: svc.priceCents, createdAt: at.minus({ days: 1 }).toJSDate(),
        payments: { create: { provider: 'cash', amountCents: svc.priceCents, currency: s.currency, status: 'COMPLETED', createdAt: end.toJSDate() } },
      } });
    }
  }
  console.log('[demo] clientes de ejemplo creados para el Resumen');
}

/** Respuestas de asistencia de ejemplo en citas próximas de los clientes ficticios. Solo si no hay ninguna. */
async function demoAttendance() {
  if (await prisma.appointment.count({ where: { attendance: { not: null } } })) return;
  const list = await prisma.appointment.findMany({ where: { status: 'CONFIRMED', startAt: { gt: new Date() }, client: { email: { endsWith: '@example.com' } } }, orderBy: { startAt: 'asc' }, take: 30 });
  for (const [i, a] of list.entries()) {
    if (i % 5 > 2 || (i > 0 && i % 11 === 0)) continue;
    await prisma.appointment.update({ where: { id: a.id }, data: { attendance: i === 4 || i === 12 ? 'NO' : 'YES', attendanceAt: new Date(), attendanceBy: (['WHATSAPP', 'EMAIL', 'ADMIN'] as const)[i % 3] } });
  }
  if (list[6]) await prisma.appointment.update({ where: { id: list[6].id }, data: { attendance: 'NO', attendanceAt: new Date(), attendanceBy: 'WHATSAPP' } });
}
