import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL = 'file:./test.db';
process.env.NODE_ENV = 'test';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
process.env.TICKETS_DIR = 'storage/test-tickets';
// Base de datos desechable solo para tests
rmSync('prisma/test.db', { force: true });
rmSync('storage/test-tickets', { recursive: true, force: true });
execSync('npx prisma db push --skip-generate', { stdio: 'ignore', env: process.env });

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/db.js');
const { paypalProvider } = await import('../src/payments/paypal.js');
const { saveSettings } = await import('../src/services/settings.js');
const { DateTime } = await import('luxon');

// PayPal simulado
const refunds: number[] = [];
const orders = new Map<string, number>();
paypalProvider.createOrder = async ({ amountCents }) => {
  const orderId = `ORDER-${orders.size + 1}`;
  orders.set(orderId, amountCents);
  return { orderId };
};
paypalProvider.captureOrder = async (orderId) => ({ captureId: `CAP-${orderId}`, amountCents: orders.get(orderId)!, currency: 'EUR', payer: { email: 'pagador@paypal.test', id: 'PAYER1' } });
paypalProvider.refund = async ({ amountCents }) => { refunds.push(amountCents); return { refundId: `REF-${refunds.length}` }; };

let server: Server;
let base = '';
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

let adminToken = '';
let clientToken = '';
let otherToken = '';
let serviceId = '';

/** Primer hueco libre a partir de dentro de `days` días. */
async function slotIn(days: number, index = 0) {
  for (let d = days; d < days + 7; d++) {
    const date = DateTime.now().setZone('Europe/Madrid').plus({ days: d }).toISODate();
    const { body } = await call('GET', `/api/public/availability?date=${date}`);
    const free = body.filter((s: { available: boolean }) => s.available);
    if (free.length > index) return free[index].start as string;
  }
  throw new Error('sin huecos');
}

beforeAll(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await saveSettings({});
  const bcrypt = (await import('bcryptjs')).default;
  await prisma.user.create({ data: { email: 'a@a.es', name: 'Admin', role: 'ADMIN', passwordHash: await bcrypt.hash('admin1234', 4) } });
  serviceId = (await prisma.service.create({ data: { name: 'Corte', priceCents: 1500 } })).id;
  adminToken = (await call('POST', '/api/auth/login', { email: 'a@a.es', password: 'admin1234' })).body.token;
  clientToken = (await call('POST', '/api/auth/register', { name: 'Cliente', email: 'c@c.es', phone: '600111222', password: 'cliente123' })).body.token;
  otherToken = (await call('POST', '/api/auth/register', { name: 'Otro', email: 'o@o.es', phone: '600111333', password: 'otro12345' })).body.token;
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('reservas', () => {
  it('reserva en efectivo, impide doble reserva y permite modificar y cancelar', async () => {
    const start = await slotIn(2);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('CONFIRMED');

    const dup = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    expect(dup.status).toBe(409);

    const newStart = await slotIn(3);
    const mod = await call('PATCH', `/api/appointments/${r.body.id}`, { startAt: newStart }, clientToken);
    expect(mod.status).toBe(200);
    expect(mod.body.startAt).toBe(newStart);

    const cancel = await call('POST', `/api/appointments/${r.body.id}/cancel`, {}, clientToken);
    expect(cancel.status).toBe(200);
    expect(cancel.body.appointment.status).toBe('CANCELLED');
  });

  it('rechaza horas fuera de horario y más allá de 1 año', async () => {
    const offHours = DateTime.now().setZone('Europe/Madrid').plus({ days: 2 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
    const r = await call('POST', '/api/appointments', { serviceId, startAt: offHours.toUTC().toISO(), paymentMethod: 'cash' }, clientToken);
    expect(r.status).toBe(400);
    const farDate = DateTime.now().setZone('Europe/Madrid').plus({ days: 372 });
    const farDay = farDate.weekday === 7 ? farDate.plus({ days: 1 }) : farDate;
    const farSlots = (await call('GET', `/api/public/availability?date=${farDay.toISODate()}`)).body;
    expect(farSlots[0].reason).toBe('OUT_OF_RANGE');
    const far = farSlots[0].start;
    expect((await call('POST', '/api/appointments', { serviceId, startAt: far, paymentMethod: 'cash' }, clientToken)).status).toBe(409);
  });

  it('el cliente no puede cancelar con menos de 1 h, el admin sí', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    const soon = new Date(Date.now() + 30 * 60_000);
    const a = await prisma.appointment.create({
      data: { clientId: client.id, serviceId, startAt: soon, endAt: new Date(soon.getTime() + 30 * 60_000), priceCents: 1500, paymentMethod: 'cash' },
    });
    const byClient = await call('POST', `/api/appointments/${a.id}/cancel`, {}, clientToken);
    expect(byClient.status).toBe(403);
    expect((await call('PATCH', `/api/appointments/${a.id}`, { startAt: await slotIn(5) }, clientToken)).status).toBe(403);
    const byAdmin = await call('POST', `/api/admin/appointments/${a.id}/cancel`, { reason: 'Imprevisto' }, adminToken);
    expect(byAdmin.status).toBe(200);
  });

  it('pago PayPal: confirma tras capturar y reembolsa al cancelar', async () => {
    const start = await slotIn(4);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'paypal' }, clientToken);
    expect(r.body.status).toBe('PENDING_PAYMENT');
    const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    expect(order.body.orderId).toMatch(/^ORDER-/);
    const done = await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    expect(done.body.status).toBe('CONFIRMED');

    const cancel = await call('POST', `/api/appointments/${r.body.id}/cancel`, {}, clientToken);
    expect(cancel.body.refundedCents).toBe(1500);
    expect(refunds).toEqual([1500]);
  });

  it('admin: reembolso parcial manual', async () => {
    const start = await slotIn(6);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'paypal' }, clientToken);
    const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    const done = await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    const paymentId = done.body.payments[0].id;
    expect((await call('POST', `/api/admin/payments/${paymentId}/refund`, { amountCents: 500 }, adminToken)).status).toBe(200);
    expect((await call('POST', `/api/admin/payments/${paymentId}/refund`, { amountCents: 1500 }, adminToken)).status).toBe(400);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p.status).toBe('PARTIALLY_REFUNDED');
    expect(p.refundedCents).toBe(500);
  });
});

describe('usuarios y cierres', () => {
  it('un cliente bloqueado no puede operar y uno desbloqueado sí', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    await call('POST', `/api/admin/users/${client.id}/block`, { reason: 'No se presentó' }, adminToken);
    expect((await call('GET', '/api/appointments', undefined, clientToken)).status).toBe(403);
    expect((await call('POST', '/api/auth/login', { email: 'c@c.es', password: 'cliente123' })).status).toBe(403);
    await call('POST', `/api/admin/users/${client.id}/unblock`, {}, adminToken);
    expect((await call('GET', '/api/appointments', undefined, clientToken)).status).toBe(200);
  });

  it('un cierre bloquea los huecos y puede cancelar las citas afectadas', async () => {
    const start = await slotIn(8);
    const a = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const date = DateTime.fromISO(start).setZone('Europe/Madrid').toISODate()!;
    const day = DateTime.fromISO(date, { zone: 'Europe/Madrid' });
    // Puede haber citas de otros tests ese mismo día: el cierre las cancela todas.
    const sameDay = await prisma.appointment.count({ where: { status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startAt: { gte: day.startOf('day').toJSDate(), lte: day.endOf('day').toJSDate() } } });
    const c = await call('POST', '/api/admin/closures', { start: date, end: date, reason: 'Festivo', cancelAppointments: true }, adminToken);
    expect(c.body.cancelled).toBe(sameDay);
    expect(sameDay).toBeGreaterThanOrEqual(1);
    const slots = (await call('GET', `/api/public/availability?date=${date}`)).body;
    expect(slots.every((s: { reason?: string }) => s.reason === 'CLOSED' || s.reason === 'PAST')).toBe(true);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.body.id } })).status).toBe('CANCELLED');
  });

  it('la baja cancela citas futuras y desactiva la cuenta', async () => {
    const r = await call('POST', '/api/admin/users', { name: 'Temp', email: 't@t.es', password: 'temporal1', phone: '600000000' }, adminToken);
    expect(r.status).toBe(201);
    const del = await call('DELETE', `/api/admin/users/${r.body.id}`, undefined, adminToken);
    expect(del.body.user.status).toBe('DELETED');
    expect((await call('POST', '/api/auth/login', { email: 't@t.es', password: 'temporal1' })).status).toBe(403);
  });
});

describe('roles', () => {
  it('un administrador no puede reservar citas propias ni recibir citas', async () => {
    const start = await slotIn(9);
    const own = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, adminToken);
    expect(own.status).toBe(403);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'a@a.es' } });
    const forAdmin = await call('POST', '/api/admin/appointments', { clientId: admin.id, serviceId, startAt: start }, adminToken);
    expect(forAdmin.status).toBe(400);
  });

  it('el alta permite crear administradores y clientes', async () => {
    const a = await call('POST', '/api/admin/users', { name: 'Ayudante', email: 'ayu@a.es', password: 'ayudante1', role: 'ADMIN' }, adminToken);
    expect(a.body.role).toBe('ADMIN');
    const token = (await call('POST', '/api/auth/login', { email: 'ayu@a.es', password: 'ayudante1' })).body.token;
    expect((await call('GET', '/api/admin/dashboard', undefined, token)).status).toBe(200);
    const c = await call('POST', '/api/admin/users', { name: 'Normal', email: 'nor@n.es', password: 'normal123' }, adminToken);
    expect(c.body.role).toBe('CLIENT');
    const ctoken = (await call('POST', '/api/auth/login', { email: 'nor@n.es', password: 'normal123' })).body.token;
    expect((await call('GET', '/api/admin/dashboard', undefined, ctoken)).status).toBe(403);
  });
});

describe('ocupación y cobros', () => {
  it('el admin ve para quién está reservada una hora; un cliente no', async () => {
    const start = await slotIn(10);
    const booked = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, otherToken);
    expect(booked.status).toBe(201);
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });

    // Admin intentando reservar esa hora para otro cliente
    const byAdmin = await call('POST', '/api/admin/appointments', { clientId: client.id, serviceId, startAt: start }, adminToken);
    expect(byAdmin.status).toBe(409);
    expect(byAdmin.body.error).toBe('Esa hora ya está reservada para Otro');
    expect(byAdmin.body.details.bookedBy[0]).toMatchObject({ clientName: 'Otro', appointmentId: booked.body.id });

    // Cliente: mensaje genérico, sin datos de nadie
    const byClient = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    expect(byClient.status).toBe(409);
    expect(JSON.stringify(byClient.body)).not.toContain('Otro');
    expect(byClient.body.details).toBeUndefined();

    // Disponibilidad: la del admin dice quién; la pública no
    const date = DateTime.fromISO(start).setZone('Europe/Madrid').toISODate();
    const adminSlots = (await call('GET', `/api/admin/availability?date=${date}`, undefined, adminToken)).body;
    expect(adminSlots.find((x: { start: string }) => x.start === start).bookedBy[0].clientName).toBe('Otro');
    const publicSlots = (await call('GET', `/api/public/availability?date=${date}`)).body;
    expect(JSON.stringify(publicSlots)).not.toContain('Otro');
    expect((await call('GET', `/api/admin/availability?date=${date}`, undefined, clientToken)).status).toBe(403);
  });

  it('las series en el panel indican quién ocupa la hora pedida', async () => {
    const start = await slotIn(11);
    await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, otherToken);
    const r = await call('POST', '/api/admin/appointments/series/preview', { firstStart: start, intervalDays: 7, count: 2 }, adminToken);
    expect(r.body.occurrences[0].bookedBy[0].clientName).toBe('Otro');
    const rc = await call('POST', '/api/appointments/series/preview', { firstStart: start, intervalDays: 7, count: 2 }, clientToken);
    expect(rc.body.occurrences[0].bookedBy).toBeUndefined();
  });

  it('marcar como cobrada una cita en efectivo, deshacerlo y cancelarla sin error', async () => {
    const start = await slotIn(12);
    const a = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const paid = await call('POST', `/api/admin/appointments/${a.body.id}/mark-paid`, {}, adminToken);
    expect(paid.body.payments).toHaveLength(1);
    expect(paid.body.payments[0]).toMatchObject({ provider: 'cash', status: 'COMPLETED', amountCents: 1500 });
    // Idempotente
    expect((await call('POST', `/api/admin/appointments/${a.body.id}/mark-paid`, {}, adminToken)).body.payments).toHaveLength(1);
    const undone = await call('POST', `/api/admin/appointments/${a.body.id}/unmark-paid`, {}, adminToken);
    expect(undone.body.payments).toHaveLength(0);
    await call('POST', `/api/admin/appointments/${a.body.id}/mark-paid`, {}, adminToken);
    // Cancelar una cita cobrada en efectivo no intenta reembolsar por PayPal
    const c = await call('POST', `/api/admin/appointments/${a.body.id}/cancel`, {}, adminToken);
    expect(c.status).toBe(200);
    expect(c.body.refundedCents).toBe(0);
  });

  it('la ficha del cliente devuelve sus datos y todas sus citas', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    const u = await call('GET', `/api/admin/users/${client.id}`, undefined, adminToken);
    expect(u.body).toMatchObject({ name: 'Cliente', whatsappLink: expect.stringContaining('wa.me/34600111222') });
    const appts = await call('GET', `/api/admin/appointments?clientId=${client.id}`, undefined, adminToken);
    expect(appts.body.length).toBeGreaterThan(3);
    expect(appts.body.every((x: { client: { id: string } }) => x.client.id === client.id)).toBe(true);
  });
});

describe('foto de perfil', () => {
  // PNG de 1x1 píxel
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('se puede subir al registrarse y se sirve como imagen', async () => {
    const r = await call('POST', '/api/auth/register', { name: 'Con Foto', email: 'foto@f.es', phone: '600222333', password: 'foto12345', avatar: png });
    expect(r.status).toBe(201);
    expect(r.body.user.avatarUrl).toMatch(/^\/api\/public\/avatars\/.+\?v=\d+$/);
    const img = await fetch(base + r.body.user.avatarUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(50);
  });

  it('rechaza ficheros que no son imágenes aunque digan serlo', async () => {
    const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    const r = await call('POST', '/api/auth/register', { name: 'Malo', email: 'malo@m.es', phone: '600333444', password: 'malo12345', avatar: fake });
    expect(r.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: 'malo@m.es' } })).toBeNull();
  });

  it('se puede cambiar y quitar desde el perfil, y no viaja en los listados', async () => {
    const login = await call('POST', '/api/auth/login', { email: 'foto@f.es', password: 'foto12345' });
    const removed = await call('PATCH', '/api/auth/me', { avatar: null }, login.body.token);
    expect(removed.body.avatarUrl).toBeNull();
    const added = await call('PATCH', '/api/auth/me', { avatar: png }, login.body.token);
    expect(added.body.avatarUrl).not.toBeNull();
    const list = await call('GET', '/api/admin/users?q=foto', undefined, adminToken);
    expect(list.body[0].avatarUrl).toBe(added.body.avatarUrl);
    expect(list.body[0].avatar).toBeUndefined();
  });
});

describe('citas periódicas', () => {
  /** Lunes a las 10:00 (Madrid), al menos dentro de `weeks` semanas. */
  const mondayAt10 = (weeks: number) => {
    const d = DateTime.now().setZone('Europe/Madrid').plus({ weeks }).set({ weekday: 1, hour: 10, minute: 0, second: 0, millisecond: 0 });
    return d.toUTC().toISO()!;
  };

  it('previsualiza cada 15 días y mueve las que caen en domingo', async () => {
    const firstStart = mondayAt10(20);
    const r = await call('POST', '/api/appointments/series/preview', { firstStart, intervalDays: 15, count: 8 }, clientToken);
    expect(r.status).toBe(200);
    const occ = r.body.occurrences;
    expect(occ).toHaveLength(8);
    expect(occ[0]).toMatchObject({ status: 'OK', start: firstStart });
    // 15 días después de un lunes es martes; 6×15 = 90 días -> domingo (cerrado) -> se mueve
    const sunday = occ[6];
    expect(DateTime.fromISO(sunday.requested).setZone('Europe/Madrid').weekday).toBe(7);
    expect(sunday.status).toBe('MOVED');
    expect(sunday.reason).toBe('Cerrado ese día');
    expect(DateTime.fromISO(sunday.start).setZone('Europe/Madrid').toFormat('c HH:mm')).toBe('1 10:00');
  });

  it('propone la hora libre más cercana si la pedida está ocupada', async () => {
    const firstStart = mondayAt10(30);
    const second = DateTime.fromISO(firstStart).plus({ days: 7 }).toUTC().toISO()!;
    await call('POST', '/api/appointments', { serviceId, startAt: second, paymentMethod: 'cash' }, otherToken);
    const r = await call('POST', '/api/appointments/series/preview', { firstStart, intervalDays: 7, count: 3 }, clientToken);
    expect(r.body.occurrences[1].status).toBe('MOVED');
    expect(r.body.occurrences[1].reason).toBe('Ocupado a esa hora');
    const moved = DateTime.fromISO(r.body.occurrences[1].start).setZone('Europe/Madrid');
    expect(['09:30', '10:30']).toContain(moved.toFormat('HH:mm'));
  });

  it('reserva la serie completa en efectivo y la cancela de una vez', async () => {
    const firstStart = mondayAt10(40);
    const preview = (await call('POST', '/api/appointments/series/preview', { firstStart, intervalDays: 14, count: 5 }, clientToken)).body;
    const starts = preview.occurrences.map((o: { start: string }) => o.start);
    const r = await call('POST', '/api/appointments/series', { serviceId, intervalDays: 14, starts, paymentMethod: 'cash' }, clientToken);
    expect(r.status).toBe(201);
    expect(r.body.appointments).toHaveLength(5);
    expect(r.body.appointments.every((a: { status: string; series: { intervalDays: number } }) => a.status === 'CONFIRMED' && a.series.intervalDays === 14)).toBe(true);

    const c = await call('POST', `/api/appointments/series/${r.body.series.id}/cancel`, {}, clientToken);
    expect(c.body).toMatchObject({ cancelled: 5, skipped: 0 });
  });

  it('si una fecha ya no está libre no se reserva ninguna', async () => {
    const firstStart = mondayAt10(45);
    const starts = [0, 7, 14].map((d) => DateTime.fromISO(firstStart).plus({ days: d }).toUTC().toISO()!);
    await call('POST', '/api/appointments', { serviceId, startAt: starts[2], paymentMethod: 'cash' }, otherToken);
    const before = await prisma.appointment.count();
    const r = await call('POST', '/api/appointments/series', { serviceId, intervalDays: 7, starts, paymentMethod: 'cash' }, clientToken);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^Cita del /);
    expect(await prisma.appointment.count()).toBe(before);
  });

  it('serie con PayPal: un solo pago y reembolso individual al cancelar una cita', async () => {
    const firstStart = mondayAt10(33);
    const starts = [0, 14, 28].map((d) => DateTime.fromISO(firstStart).plus({ days: d }).toUTC().toISO()!);
    const r = await call('POST', '/api/appointments/series', { serviceId, intervalDays: 14, starts, paymentMethod: 'paypal' }, clientToken);
    expect(r.body).toMatchObject({ pendingPayment: true, totalCents: 4500 });
    const order = await call('POST', `/api/appointments/series/${r.body.series.id}/pay/start`, {}, clientToken);
    expect(order.body.amountCents).toBe(4500);
    const done = await call('POST', `/api/appointments/series/${r.body.series.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    expect(done.body.appointments).toHaveLength(3);
    expect(done.body.lostCount).toBe(0);

    refunds.length = 0;
    const one = await call('POST', `/api/appointments/${done.body.appointments[1].id}/cancel`, {}, clientToken);
    expect(one.body.refundedCents).toBe(1500);
    expect(refunds).toEqual([1500]);
    // El admin cancela el resto de la serie: solo se reembolsan las 2 restantes
    const rest = await call('POST', `/api/admin/series/${r.body.series.id}/cancel`, {}, adminToken);
    expect(rest.body).toMatchObject({ cancelled: 2, refundedCents: 3000 });
  });

  it('respeta el máximo de citas por serie', async () => {
    await saveSettings({ recurringMaxAppointments: 4 });
    const r = await call('POST', '/api/appointments/series/preview', { firstStart: mondayAt10(20), intervalDays: 7, count: 10 }, clientToken);
    expect(r.body.occurrences).toHaveLength(4);
    await saveSettings({ recurringMaxAppointments: 60 });
  });
});

describe('tickets', () => {
  const year = DateTime.now().setZone('Europe/Madrid').year;
  const month = String(DateTime.now().setZone('Europe/Madrid').month).padStart(2, '0');
  const seqOf = (n: string) => Number(n.split('-')[1]);
  const ticketOf = (a: { payments: { ticket: { id: string; number: string } | null }[] }) => a.payments.find((p) => p.ticket)?.ticket ?? null;
  const download = async (ticketId: string, token: string) => {
    const link = await call('GET', `/api/tickets/${ticketId}/link`, undefined, token);
    if (link.status !== 200) return { status: link.status, bytes: null };
    const res = await fetch(base + link.body.url);
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
  };

  it('pago online: la cita queda pagada con ticket descargable solo por su dueño', async () => {
    const start = await slotIn(40);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'paypal' }, clientToken);
    const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    const done = await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    expect(done.body.status).toBe('CONFIRMED');
    const t = ticketOf(done.body)!;
    expect(t.number).toMatch(new RegExp(`^${year}-\\d{4}$`));

    const pdf = await download(t.id, clientToken);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain('application/pdf');
    expect(pdf.disposition).toContain(`ticket-${t.number}.pdf`);
    expect(pdf.bytes!.subarray(0, 4).toString()).toBe('%PDF');
    // Guardado en carpeta año/mes, no en la base de datos
    const file = `storage/test-tickets/${year}/${month}/${t.number}.pdf`;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(pdf.bytes!)).toBe(true);

    // Vista previa con el mismo contenido que el PDF
    const view = await call('GET', `/api/tickets/${t.id}`, undefined, clientToken);
    expect(view.body).toMatchObject({ number: t.number, client: 'Cliente', totalCents: 1500, vatPercent: 21, baseCents: 1240, vatCents: 260 });
    expect(view.body.lines).toHaveLength(1);
    expect((await call('GET', `/api/tickets/${t.id}`, undefined, otherToken)).status).toBe(404);
    expect((await call('GET', `/api/tickets/${t.id}`, undefined, adminToken)).status).toBe(200);
    expect((await download(t.id, otherToken)).status).toBe(404);
    expect((await download(t.id, adminToken)).status).toBe(200);
    expect((await fetch(`${base}/api/public/tickets/${t.id}/pdf?sig=falso`)).status).toBe(403);
    // Un enlace de ticket no sirve como sesión
    const link = await call('GET', `/api/tickets/${t.id}/link`, undefined, clientToken);
    const sig = new URL(base + link.body.url).searchParams.get('sig')!;
    expect((await call('GET', '/api/auth/me', undefined, sig)).status).toBe(401);
  });

  it('efectivo: el admin cobra y emite ticket; la numeración es consecutiva y común', async () => {
    const before = await call('GET', '/api/appointments', undefined, clientToken);
    const lastOnline = Math.max(...before.body.flatMap((a: { payments: { ticket: { number: string } | null }[] }) => a.payments.map((p) => (p.ticket ? seqOf(p.ticket.number) : 0))));

    const a1 = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(41), paymentMethod: 'cash' }, clientToken);
    const a2 = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(41, 1), paymentMethod: 'cash' }, clientToken);
    const paid1 = await call('POST', `/api/admin/appointments/${a1.body.id}/mark-paid`, { ticket: true }, adminToken);
    expect(seqOf(ticketOf(paid1.body)!.number)).toBe(lastOnline + 1);

    // Cobrada sin ticket y ticket después
    const paid2 = await call('POST', `/api/admin/appointments/${a2.body.id}/mark-paid`, {}, adminToken);
    expect(ticketOf(paid2.body)).toBeNull();
    const t2 = await call('POST', `/api/admin/appointments/${a2.body.id}/ticket`, {}, adminToken);
    expect(seqOf(ticketOf(t2.body)!.number)).toBe(lastOnline + 2);
    expect((await call('POST', `/api/admin/appointments/${a2.body.id}/ticket`, {}, adminToken)).status).toBe(409);

    // Con ticket ya no se puede deshacer el cobro
    expect((await call('POST', `/api/admin/appointments/${a2.body.id}/unmark-paid`, {}, adminToken)).status).toBe(409);
    // El cliente ve el ticket en sus citas y lo puede descargar
    expect((await download(ticketOf(t2.body)!.id, clientToken)).status).toBe(200);
  });

  it('no se emite ticket de una cita sin cobrar ni lo puede pedir un cliente', async () => {
    const a = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(42), paymentMethod: 'cash' }, clientToken);
    expect((await call('POST', `/api/admin/appointments/${a.body.id}/ticket`, {}, adminToken)).status).toBe(400);
    expect((await call('POST', `/api/admin/appointments/${a.body.id}/ticket`, {}, clientToken)).status).toBe(403);
  });

  it('una serie pagada online genera un único ticket con todas las citas', async () => {
    const first = DateTime.now().setZone('Europe/Madrid').plus({ weeks: 44 }).set({ weekday: 2, hour: 11, minute: 0, second: 0, millisecond: 0 });
    const starts = [0, 7].map((d) => first.plus({ days: d }).toUTC().toISO()!);
    const r = await call('POST', '/api/appointments/series', { serviceId, intervalDays: 7, starts, paymentMethod: 'paypal' }, clientToken);
    const order = await call('POST', `/api/appointments/series/${r.body.series.id}/pay/start`, {}, clientToken);
    const done = await call('POST', `/api/appointments/series/${r.body.series.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    const [t1, t2] = done.body.appointments.map(ticketOf);
    expect(t1.number).toBe(t2.number);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: t1.id } });
    expect(t).toMatchObject({ totalCents: 3000, origin: 'ONLINE', provider: 'paypal' });
  });
});

describe('cobradas con ticket: reembolsar en vez de cancelar', () => {
  type A = { id: string; status: string; paymentMethod: string; payments: { id: string; status: string; refundedCents: number; payerEmail: string | null; ticket: { number: string } | null }[] };
  const payOnline = async (start: string) => {
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'paypal' }, clientToken);
    const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    return (await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken)).body as A;
  };
  const payCash = async (start: string) => {
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    return (await call('POST', `/api/admin/appointments/${r.body.id}/mark-paid`, { ticket: true }, adminToken)).body as A;
  };

  it('efectivo con ticket: nadie la cancela hasta reembolsar; después queda pendiente de cobro', async () => {
    const a = await payCash(await slotIn(50));
    expect((await call('POST', `/api/admin/appointments/${a.id}/cancel`, {}, adminToken)).body.code).toBe('PAID_WITH_TICKET');
    expect((await call('POST', `/api/appointments/${a.id}/cancel`, {}, clientToken)).body.code).toBe('PAID_WITH_TICKET');

    const r = await call('POST', `/api/admin/appointments/${a.id}/refund-cash`, {}, adminToken);
    expect(r.body.refundedCents).toBe(1500);
    expect(r.body.appointment.status).toBe('CONFIRMED');
    const p = r.body.appointment.payments[0];
    expect(p).toMatchObject({ status: 'REFUNDED', refundedCents: 1500 });
    expect(p.ticket.number).toBe(a.payments[0].ticket!.number); // el ticket se conserva

    // Se puede volver a cobrar (nuevo ticket) o cancelar
    const again = await call('POST', `/api/admin/appointments/${a.id}/mark-paid`, { ticket: true }, adminToken);
    expect(again.body.payments).toHaveLength(2);
    await call('POST', `/api/admin/appointments/${a.id}/refund-cash`, {}, adminToken);
    expect((await call('POST', `/api/appointments/${a.id}/cancel`, {}, clientToken)).status).toBe(200);
  });

  it('PayPal con ticket: guarda el pagador; el admin reembolsa anulando o manteniendo la cita', async () => {
    const a = await payOnline(await slotIn(51));
    expect(a.payments[0]).toMatchObject({ payerEmail: 'pagador@paypal.test', ticket: expect.anything() });
    // Anular sin reembolsar no se permite
    expect((await call('POST', `/api/admin/appointments/${a.id}/cancel`, { refund: false }, adminToken)).body.code).toBe('PAID_WITH_TICKET');

    // Reembolso completo manteniendo la cita: pasa a cobrarse en el local
    refunds.length = 0;
    const kept = await call('POST', `/api/admin/appointments/${a.id}/refund`, { cancel: false }, adminToken);
    expect(refunds).toEqual([1500]);
    expect(kept.body.appointment).toMatchObject({ status: 'CONFIRMED', paymentMethod: 'cash' });
    expect((await call('POST', `/api/admin/appointments/${a.id}/cancel`, {}, adminToken)).status).toBe(200);

    // Reembolso anulando la cita
    const b = await payOnline(await slotIn(52));
    const cancelled = await call('POST', `/api/admin/appointments/${b.id}/refund`, { cancel: true }, adminToken);
    expect(cancelled.body).toMatchObject({ refundedCents: 1500, appointment: { status: 'CANCELLED' } });
  });

  it('PayPal: el cliente reembolsa anulando con antelación; con menos de 1 h solo el admin', async () => {
    const a = await payOnline(await slotIn(53));
    const r = await call('POST', `/api/appointments/${a.id}/cancel`, {}, clientToken);
    expect(r.body.refundedCents).toBe(1500);

    const b = await payOnline(await slotIn(54));
    const soon = new Date(Date.now() + 30 * 60_000);
    await prisma.appointment.update({ where: { id: b.id }, data: { startAt: soon, endAt: new Date(soon.getTime() + 30 * 60_000) } });
    expect((await call('POST', `/api/appointments/${b.id}/cancel`, {}, clientToken)).status).toBe(403);
    expect((await call('POST', `/api/admin/appointments/${b.id}/refund`, { cancel: true }, adminToken)).body.refundedCents).toBe(1500);
  });

  it('las cancelaciones masivas se saltan las cobradas en efectivo con ticket', async () => {
    const first = DateTime.now().setZone('Europe/Madrid').plus({ weeks: 46 }).set({ weekday: 3, hour: 12, minute: 0, second: 0, millisecond: 0 });
    const starts = [0, 7, 14].map((d) => first.plus({ days: d }).toUTC().toISO()!);
    const r = await call('POST', '/api/appointments/series', { serviceId, intervalDays: 7, starts, paymentMethod: 'cash' }, clientToken);
    await call('POST', `/api/admin/appointments/${r.body.appointments[1].id}/mark-paid`, { ticket: true }, adminToken);
    const c = await call('POST', `/api/admin/series/${r.body.series.id}/cancel`, {}, adminToken);
    expect(c.body).toMatchObject({ cancelled: 2, skipped: 1 });
  });

  it('histórico de anulaciones y ausencias por cliente', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    const past = new Date(Date.now() - 3 * 86_400_000);
    await prisma.appointment.create({ data: { clientId: client.id, serviceId, startAt: past, endAt: new Date(past.getTime() + 1_800_000), priceCents: 1500, paymentMethod: 'cash', status: 'NO_SHOW' } });
    const r = await call('GET', '/api/admin/reports/incidents', undefined, adminToken);
    const row = r.body.find((x: { client: { id: string } }) => x.client.id === client.id);
    const expected = await prisma.appointment.groupBy({ by: ['status', 'cancelledBy'], where: { clientId: client.id, NOT: { status: 'CANCELLED', cancelledBy: 'SYSTEM' } }, _count: { _all: true } });
    const count = (f: (x: (typeof expected)[number]) => boolean) => expected.filter(f).reduce((n, x) => n + x._count._all, 0);
    expect(row).toMatchObject({
      noShow: count((x) => x.status === 'NO_SHOW'),
      cancelledByClient: count((x) => x.status === 'CANCELLED' && x.cancelledBy === 'CLIENT'),
      cancelledByShop: count((x) => x.status === 'CANCELLED' && x.cancelledBy === 'ADMIN'),
    });
    expect(row.noShow).toBeGreaterThan(0);
    expect((await call('GET', '/api/admin/reports/incidents', undefined, clientToken)).status).toBe(403);
  });
});

vi.setConfig({ testTimeout: 20_000 });
