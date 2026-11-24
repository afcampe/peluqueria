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
process.env.IMPORT_DIR = 'storage/test-import';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
// Base de datos desechable solo para tests
rmSync('prisma/test.db', { force: true });
rmSync('storage/test-tickets', { recursive: true, force: true });
rmSync('storage/test-import', { recursive: true, force: true });
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

  it('admin: al cancelar puede devolver una parte o nada', async () => {
    const pay = async (d: number) => {
      const r = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(d), paymentMethod: 'paypal' }, clientToken);
      const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
      return (await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken)).body.id as string;
    };
    const a = await pay(6);
    expect((await call('POST', `/api/admin/appointments/${a}/cancel`, { refundCents: 2000 }, adminToken)).status).toBe(400);
    const c = await call('POST', `/api/admin/appointments/${a}/cancel`, { refundCents: 500 }, adminToken);
    expect(c.body).toMatchObject({ refundedCents: 500, appointment: { status: 'CANCELLED', payments: [{ status: 'PARTIALLY_REFUNDED', refundedCents: 500 }] } });
    refunds.length = 0;
    const b = await pay(6);
    expect((await call('POST', `/api/admin/appointments/${b}/cancel`, { refund: false }, adminToken)).body).toMatchObject({ refundedCents: 0, appointment: { status: 'CANCELLED', payments: [{ status: 'COMPLETED' }] } });
    expect(refunds).toEqual([]);
  });

  it('si PayPal no devuelve el dinero, la cita no se cancela', async () => {
    const r = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(7), paymentMethod: 'paypal' }, clientToken);
    const order = await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: order.body.orderId }, clientToken);
    const ok = paypalProvider.refund;
    paypalProvider.refund = async () => { throw new Error('PayPal caído'); };
    for (const [u, t] of [['/api/appointments', clientToken], ['/api/admin/appointments', adminToken]] as const) {
      const c = await call('POST', `${u}/${r.body.id}/cancel`, {}, t);
      expect([c.status, c.body.code]).toEqual([502, 'REFUND_FAILED']);
    }
    paypalProvider.refund = ok;
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: r.body.id } })).toMatchObject({ status: 'CONFIRMED' });
    expect((await call('POST', `/api/appointments/${r.body.id}/cancel`, {}, clientToken)).body.refundedCents).toBe(1500);
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

  it('marcar como cobrada una cita en efectivo es definitivo; al cancelarla se devuelve en mano', async () => {
    const start = await slotIn(12);
    const a = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const paid = await call('POST', `/api/admin/appointments/${a.body.id}/mark-paid`, {}, adminToken);
    expect(paid.body.payments).toHaveLength(1);
    expect(paid.body.payments[0]).toMatchObject({ provider: 'cash', status: 'COMPLETED', amountCents: 1500 });
    // Idempotente
    expect((await call('POST', `/api/admin/appointments/${a.body.id}/mark-paid`, {}, adminToken)).body.payments).toHaveLength(1);
    // Aunque no tenga ticket, el cliente ya no la cancela desde la app
    expect((await call('POST', `/api/appointments/${a.body.id}/cancel`, {}, clientToken)).body.code).toBe('PAID_IN_SHOP');
    // Cancelar una cita cobrada en efectivo no intenta reembolsar por PayPal
    const c = await call('POST', `/api/admin/appointments/${a.body.id}/cancel`, {}, adminToken);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ refundedCents: 0, cashRefundedCents: 1500 });
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

describe('cancelar citas pagadas', () => {
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

  it('cobrada en el local: el cliente no la cancela; el admin sí, devolviendo en mano o no', async () => {
    const a = await payCash(await slotIn(50));
    expect((await call('POST', `/api/appointments/${a.id}/cancel`, {}, clientToken)).body.code).toBe('PAID_IN_SHOP');
    const r = await call('POST', `/api/admin/appointments/${a.id}/cancel`, {}, adminToken);
    expect(r.body).toMatchObject({ cashRefundedCents: 1500, appointment: { status: 'CANCELLED' } });
    expect(r.body.appointment.payments[0]).toMatchObject({ status: 'REFUNDED', refundedCents: 1500, ticket: { number: a.payments[0].ticket!.number } }); // el ticket se conserva
    const b = await payCash(await slotIn(50));
    const kept = await call('POST', `/api/admin/appointments/${b.id}/cancel`, { refund: false }, adminToken);
    expect(kept.body).toMatchObject({ cashRefundedCents: 0, appointment: { payments: [{ status: 'COMPLETED' }] } });
  });

  it('realizada: ni se cancela ni se reembolsa; con «No vino» el admin puede devolver el pago online', async () => {
    const a = await payOnline(await slotIn(51));
    expect(a.payments[0]).toMatchObject({ payerEmail: 'pagador@paypal.test', ticket: expect.anything() });
    const past = new Date(Date.now() - 3 * 3_600_000);
    await prisma.appointment.update({ where: { id: a.id }, data: { startAt: past, endAt: new Date(past.getTime() + 1_800_000) } });
    const refund = (amountCents?: number) => call('POST', `/api/admin/appointments/${a.id}/refund`, { amountCents }, adminToken);
    expect((await call('POST', `/api/admin/appointments/${a.id}/cancel`, {}, adminToken)).status).toBe(400);
    expect((await refund()).status).toBe(400);
    await call('PATCH', `/api/admin/appointments/${a.id}`, { status: 'NO_SHOW' }, adminToken);
    refunds.length = 0;
    expect((await refund(500)).body.refundedCents).toBe(500);
    expect((await refund(1500)).status).toBe(400);
    expect((await refund()).body.refundedCents).toBe(1000);
    expect(refunds).toEqual([500, 1000]);
    // Si al final vino, se cobra en el local
    expect((await call('PATCH', `/api/admin/appointments/${a.id}`, { status: 'CONFIRMED' }, adminToken)).body.paymentMethod).toBe('cash');
    expect((await call('POST', `/api/admin/appointments/${a.id}/mark-paid`, {}, adminToken)).status).toBe(200);
  });

  it('cada devolución con ticket emite un rectificativo con serie propia y sin tocar el original', async () => {
    const year = DateTime.now().setZone('Europe/Madrid').year;
    type Full = { paymentMethod: string; status: string; payments: { status: string; ticket: { id: string; number: string } | null; refunds: { amountCents: number; rectification: { id: string; number: string } | null }[] }[] };
    const a = await payOnline(await slotIn(56));
    const url = `/api/admin/appointments/${a.id}/refund`;
    // Corregir cobro: exige motivo y no cancela
    expect((await call('POST', url, { amountCents: 500 }, adminToken)).status).toBe(400);
    expect((await call('POST', url, { amountCents: 500, reason: 'x' }, clientToken)).status).toBe(403);
    const part = (await call('POST', url, { amountCents: 500, reason: 'Importe equivocado' }, adminToken)).body.appointment as Full;
    expect(part).toMatchObject({ status: 'CONFIRMED', paymentMethod: 'paypal' });
    const full = (await call('POST', url, { reason: 'Cobro duplicado' }, adminToken)).body.appointment as Full;
    expect(full).toMatchObject({ status: 'CONFIRMED', paymentMethod: 'cash' });
    const rects = full.payments[0].refunds.map((r) => r.rectification!);
    expect(rects).toHaveLength(2);
    const seqs = rects.map((r) => Number(r.number.split('-')[1])).sort((x, y) => x - y);
    expect(rects[0].number).toMatch(new RegExp(`^R${year}-\\d{4}$`));
    expect(seqs[1]).toBe(seqs[0] + 1);

    const first = full.payments[0].refunds.find((r) => r.amountCents === 500)!.rectification!;
    const v = (await call('GET', `/api/tickets/${first.id}`, undefined, clientToken)).body;
    expect(v).toMatchObject({ number: first.number, totalCents: -500, rectifies: { number: full.payments[0].ticket!.number, reason: 'Importe equivocado' } });
    expect(v.baseCents + v.vatCents).toBe(-500);
    const orig = (await call('GET', `/api/tickets/${full.payments[0].ticket!.id}`, undefined, clientToken)).body;
    expect(orig).toMatchObject({ totalCents: 1500, refundedCents: 1500, rectifies: null });
    expect(orig.rectifications).toHaveLength(2);
    // PDF descargable por su dueño y por nadie más
    expect((await call('GET', `/api/tickets/${first.id}`, undefined, otherToken)).status).toBe(404);
    const link = await call('GET', `/api/tickets/${first.id}/link`, undefined, clientToken);
    const pdf = await fetch(base + link.body.url);
    expect(pdf.headers.get('content-disposition')).toContain(`rectificativo-${first.number}.pdf`);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');

    // Efectivo con ticket: rectificativo al cancelar devolviendo; sin devolución o sin ticket, no
    const c = await payCash(await slotIn(57));
    const cc = (await call('POST', `/api/admin/appointments/${c.id}/cancel`, {}, adminToken)).body.appointment as Full;
    expect(cc.payments[0].refunds[0].rectification!.number).toMatch(/^R/);
    const n = await prisma.rectification.count();
    const d = await payCash(await slotIn(57));
    await call('POST', `/api/admin/appointments/${d.id}/cancel`, { refund: false }, adminToken);
    const e = await call('POST', '/api/appointments', { serviceId, startAt: await slotIn(57), paymentMethod: 'cash' }, clientToken);
    await call('POST', `/api/admin/appointments/${e.body.id}/mark-paid`, {}, adminToken);
    await call('POST', `/api/admin/appointments/${e.body.id}/cancel`, {}, adminToken);
    expect(await prisma.rectification.count()).toBe(n);

    // El IVA es el del ticket al emitirse, aunque cambie en Configuración; los antiguos lo fijan al arrancar
    const { fillMissingVat } = await import('../src/services/tickets.js');
    await prisma.ticket.update({ where: { id: full.payments[0].ticket!.id }, data: { vatPercent: null } });
    expect(await fillMissingVat()).toBe(1);
    await saveSettings({ ticketVatPercent: 10 });
    expect((await call('GET', `/api/tickets/${full.payments[0].ticket!.id}`, undefined, clientToken)).body).toMatchObject({ vatPercent: 21, baseCents: 1240 });
    expect((await call('GET', `/api/tickets/${first.id}`, undefined, clientToken)).body).toMatchObject({ vatPercent: 21, vatCents: -87 });
    const nuevo = await payCash(await slotIn(58));
    expect((await call('GET', `/api/tickets/${(nuevo as unknown as Full).payments[0].ticket!.id}`, undefined, clientToken)).body.vatPercent).toBe(10);
    await saveSettings({ ticketVatPercent: 21 });

    // Los que falten se emiten después, una sola vez
    const { issueMissingRectifications } = await import('../src/services/tickets.js');
    await prisma.rectification.delete({ where: { number: cc.payments[0].refunds[0].rectification!.number } });
    expect(await issueMissingRectifications()).toBe(1);
    expect(await issueMissingRectifications()).toBe(0);
  });

  it('PayPal: el cliente cancela y se le devuelve todo; con menos de 1 h solo el admin', async () => {
    const a = await payOnline(await slotIn(53));
    const r = await call('POST', `/api/appointments/${a.id}/cancel`, { refund: false, refundCents: 1 }, clientToken);
    expect(r.body).toMatchObject({ refundedCents: 1500, appointment: { status: 'CANCELLED' } });

    const b = await payOnline(await slotIn(54));
    const soon = new Date(Date.now() + 30 * 60_000);
    await prisma.appointment.update({ where: { id: b.id }, data: { startAt: soon, endAt: new Date(soon.getTime() + 30 * 60_000) } });
    expect((await call('POST', `/api/appointments/${b.id}/cancel`, {}, clientToken)).status).toBe(403);
    expect((await call('POST', `/api/admin/appointments/${b.id}/cancel`, {}, adminToken)).body.refundedCents).toBe(1500);
  });

  it('las cancelaciones masivas se saltan las cobradas en el local', async () => {
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

  it('"no vino" se puede corregir con "sí vino" y las pasadas cuentan como realizadas', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    const past = new Date(Date.now() - 4 * 86_400_000);
    const a = await prisma.appointment.create({ data: { clientId: client.id, serviceId, startAt: past, endAt: new Date(past.getTime() + 1_800_000), priceCents: 1500, paymentMethod: 'cash', status: 'CONFIRMED',
      payments: { create: { provider: 'paypal', amountCents: 1500, currency: 'EUR', status: 'COMPLETED' } } } });
    const noShows = async () => (await call('GET', '/api/admin/reports/incidents', undefined, adminToken)).body.find((x: { client: { id: string } }) => x.client.id === client.id)?.noShow ?? 0;
    const listed = async (status: string) => (await call('GET', `/api/admin/appointments?status=${status}`, undefined, adminToken)).body.some((x: { id: string }) => x.id === a.id);
    const set = (status: string) => call('PATCH', `/api/admin/appointments/${a.id}`, { status }, adminToken);
    const n = await noShows();
    expect([await listed('COMPLETED'), await listed('CONFIRMED')]).toEqual([true, false]);
    for (let i = 0; i < 2; i++) {
      expect((await set('NO_SHOW')).status).toBe(200);
      expect([await noShows(), await listed('NO_SHOW'), await listed('COMPLETED')]).toEqual([n + 1, true, false]);
      const back = await set('CONFIRMED');
      expect(back.body.payments).toMatchObject([{ status: 'COMPLETED', amountCents: 1500 }]);
      expect([await noShows(), await listed('COMPLETED')]).toEqual([n, true]);
    }
    // Como ausencia no se puede cobrar; al corregirla, sí. Una vez cobrada en el local, vino.
    const c = await prisma.appointment.create({ data: { clientId: client.id, serviceId, startAt: past, endAt: new Date(past.getTime() + 1_800_000), priceCents: 1500, paymentMethod: 'cash', status: 'CONFIRMED' } });
    const noShow = () => call('PATCH', `/api/admin/appointments/${c.id}`, { status: 'NO_SHOW' }, adminToken);
    expect((await noShow()).status).toBe(200);
    const pay = () => call('POST', `/api/admin/appointments/${c.id}/mark-paid`, {}, adminToken);
    expect((await pay()).status).toBe(400);
    await call('PATCH', `/api/admin/appointments/${c.id}`, { status: 'CONFIRMED' }, adminToken);
    expect((await pay()).status).toBe(200);
    expect((await noShow()).status).toBe(400);
    // Una cita futura no se puede marcar como ausencia
    const fut = new Date(Date.now() + 400 * 86_400_000);
    const f = await prisma.appointment.create({ data: { clientId: client.id, serviceId, startAt: fut, endAt: new Date(fut.getTime() + 1_800_000), priceCents: 1500, paymentMethod: 'cash', status: 'CONFIRMED' } });
    expect((await call('PATCH', `/api/admin/appointments/${f.id}`, { status: 'NO_SHOW' }, adminToken)).status).toBe(400);
    await prisma.appointment.delete({ where: { id: f.id } });
  });
});

describe('importar la agenda en papel', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const tz = 'Europe/Madrid';
  // Martes dentro de un año y pico: más allá del límite de reserva de los clientes.
  const day = DateTime.now().setZone(tz).plus({ weeks: 54 }).set({ weekday: 2 });

  async function uploadWith(result: unknown) {
    const { setAgendaReader } = await import('../src/services/agendaReader.js');
    const { kickImportQueue } = await import('../src/services/agendaImport.js');
    setAgendaReader(async () => result as never);
    const up = await call('POST', '/api/admin/imports', { image: PNG, fileName: 'pagina.png' }, adminToken);
    expect(up.status).toBe(201);
    await kickImportQueue();
    return (await call('GET', `/api/admin/imports/${up.body.id}`, undefined, adminToken)).body;
  }

  it('lee la foto, propone las filas y crea fichas sin cuenta y citas', async () => {
    const entry = (time: string | null, name: string, crossedOut = false) => ({ time, name, service: null, crossedOut, uncertain: false, note: null });
    const d = await uploadWith({
      days: [
        { day: day.day, month: day.month, year: null, weekday: 2, entries: [entry('11:00', 'Juan'), entry('11.30', 'juan'), entry('12', 'Cliente'), entry('12:30', 'Pepe', true)] },
        { day: 1, month: 1, year: 2020, weekday: null, entries: [entry('10:00', 'Antiguo')] },
      ],
    });
    expect(d.status).toBe('READY');
    expect(d.rows).toHaveLength(5);
    expect(d.rows[0]).toMatchObject({ date: day.toISODate(), time: '11:00', include: true, serviceId: expect.any(String) });
    expect(d.rows[1].time).toBe('11:30');
    expect(d.rows[2]).toMatchObject({ time: '12:00', clientId: expect.any(String) }); // coincide con el cliente "Cliente"
    expect(d.rows[3].include).toBe(false); // tachada
    expect(d.rows[4].include).toBe(false); // pasada

    const r = await call('POST', `/api/admin/imports/${d.id}/commit`, { rows: d.rows }, adminToken);
    expect(r.body).toMatchObject({ imported: 3, failed: 0, done: true });
    expect(r.body.detail).toMatchObject({ status: 'IMPORTED', hasImage: false });

    const fichas = await prisma.user.findMany({ where: { name: 'Juan' }, include: { appointments: true } });
    expect(fichas).toHaveLength(1); // las dos filas "Juan" van a la misma ficha
    expect(fichas[0]).toMatchObject({ email: null, passwordHash: null });
    expect(fichas[0].appointments).toHaveLength(2);
    expect((await call('GET', `/api/admin/imports/${d.id}/image`, undefined, adminToken)).status).toBe(410);

    // La misma página subida otra vez no duplica las citas.
    const again = await uploadWith({ days: [{ day: day.day, month: day.month, year: null, weekday: 2, entries: [entry('11:00', 'Juan')] }] });
    const r2 = await call('POST', `/api/admin/imports/${again.id}/commit`, { rows: again.rows }, adminToken);
    expect(r2.body).toMatchObject({ imported: 1, done: true });
    expect(r2.body.detail.rows[0].result.message).toBe('Ya estaba en la agenda');
    expect(await prisma.appointment.count({ where: { client: { name: 'Juan' } } })).toBe(2);
    expect((await call('GET', '/api/admin/imports', undefined, clientToken)).status).toBe(403);
  });

  it('las filas con error se corrigen y se vuelven a importar', async () => {
    const d = await uploadWith({ days: [{ day: day.day, month: day.month, year: day.year, weekday: null, entries: [{ time: '11:10', name: 'Rosa', service: null, crossedOut: false, uncertain: true, note: 'llamar' }] }] });
    const r1 = await call('POST', `/api/admin/imports/${d.id}/commit`, { rows: d.rows }, adminToken);
    expect(r1.body).toMatchObject({ imported: 0, failed: 1, done: false });
    expect(r1.body.detail.rows[0].result.status).toBe('error');
    expect(await prisma.user.count({ where: { name: 'Rosa' } })).toBe(0);
    const fixed = r1.body.detail.rows.map((x: object) => ({ ...x, time: '15:00' }));
    // 15:00 es la hora de comer: tampoco vale
    const r2 = await call('POST', `/api/admin/imports/${d.id}/commit`, { rows: fixed }, adminToken);
    const time = '16:00'; // primera hora de la tarde
    const r3 = await call('POST', `/api/admin/imports/${d.id}/commit`, { rows: r2.body.detail.rows.map((x: object) => ({ ...x, time })) }, adminToken);
    expect(r3.body).toMatchObject({ imported: 1, done: true });
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: r3.body.detail.rows[0].result.appointmentId } });
    expect(appt.notes).toContain('llamar');
  });

  it('la ficha sin cuenta no puede entrar y se une a un cliente registrado', async () => {
    const ficha = await prisma.user.findFirstOrThrow({ where: { name: 'Juan', email: null } });
    expect((await call('POST', '/api/auth/login', { email: '', password: '' })).status).toBe(401);
    const other = await prisma.user.findUniqueOrThrow({ where: { email: 'o@o.es' } });
    const m = await call('POST', `/api/admin/users/${ficha.id}/merge`, { targetId: other.id }, adminToken);
    expect(m.body).toEqual({ moved: 2 });
    expect(await prisma.user.findUnique({ where: { id: ficha.id } })).toBeNull();
    const rosa = await prisma.user.findFirstOrThrow({ where: { name: 'Rosa' } });
    const again = await call('POST', `/api/admin/users/${other.id}/merge`, { targetId: rosa.id }, adminToken);
    expect(again.status).toBe(400); // solo se unen fichas sin email
  });

  it('sin clave de la API la foto queda con error y se puede pasar a mano', async () => {
    const { claudeReader, setAgendaReader } = await import('../src/services/agendaReader.js');
    const { kickImportQueue } = await import('../src/services/agendaImport.js');
    setAgendaReader(claudeReader);
    const up = await call('POST', '/api/admin/imports', { image: PNG }, adminToken);
    await kickImportQueue();
    const d = (await call('GET', `/api/admin/imports/${up.body.id}`, undefined, adminToken)).body;
    expect(d).toMatchObject({ status: 'ERROR', error: expect.stringContaining('ANTHROPIC_API_KEY') });
    const list = await call('GET', '/api/admin/imports', undefined, adminToken);
    expect(list.body.readerConfigured).toBe(false);
    const manual = await call('POST', '/api/admin/imports/manual', {}, adminToken);
    expect(manual.body.status).toBe('READY');
    expect((await call('DELETE', `/api/admin/imports/${up.body.id}`, undefined, adminToken)).status).toBe(204);
  });
});

describe('recordatorios de citas', () => {
  it('avisa con cada antelación una sola vez y vuelve a avisar si cambia la hora', async () => {
    const { runReminders } = await import('../src/services/reminders.js');
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: true, whatsapp: true, offsetsMinutes: [1440, 120] } }, adminToken);
    const start = await slotIn(3);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const id = r.body.id as string;
    const t = new Date(start).getTime();
    const at = (minutesBefore: number) => new Date(t - minutesBefore * 60_000);
    const mine = () => prisma.appointmentReminder.findMany({ where: { appointmentId: id }, orderBy: { createdAt: 'asc' } });

    await runReminders(at(1500)); // aún no toca
    expect(await mine()).toHaveLength(0);
    await runReminders(at(1430)); // 1 día antes
    await runReminders(at(1400)); // no repite
    let rs = await mine();
    expect(rs.map((x) => [x.offsetMinutes, x.channel, x.status])).toEqual([[1440, 'EMAIL', 'SENT'], [1440, 'WHATSAPP', 'SKIPPED']]);
    expect(rs[1].detail).toContain('WhatsApp');
    await runReminders(at(100)); // 2 h antes
    rs = await mine();
    expect(rs.filter((x) => x.offsetMinutes === 120 && x.channel === 'EMAIL')).toHaveLength(1);

    // Cambia la hora: se vuelve a avisar para la nueva
    const newStart = await slotIn(5);
    await call('PATCH', `/api/admin/appointments/${id}`, { startAt: newStart }, adminToken);
    await runReminders(new Date(new Date(newStart).getTime() - 1400 * 60_000));
    rs = await mine();
    expect(rs.filter((x) => x.startAt.toISOString() === new Date(newStart).toISOString() && x.channel === 'EMAIL')).toHaveLength(1);

    // Las canceladas no se avisan
    await call('POST', `/api/admin/appointments/${id}/cancel`, { notify: false }, adminToken);
    const before = (await mine()).length;
    await runReminders(new Date(new Date(newStart).getTime() - 60 * 60_000));
    expect(await mine()).toHaveLength(before);

    const list = await call('GET', '/api/admin/reminders', undefined, adminToken);
    expect(list.body[0]).toMatchObject({ offsetLabel: expect.any(String), appointment: { client: { name: 'Cliente' } } });
  });

  it('no avisa con una antelación que ya había pasado al reservar ni si están desactivados', async () => {
    const { runReminders } = await import('../src/services/reminders.js');
    const start = await slotIn(4, 1);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const t = new Date(start).getTime();
    // Reservada 3 h antes de la cita: el aviso de 1 día no se manda; el de 2 h sí.
    await prisma.appointment.update({ where: { id: r.body.id }, data: { createdAt: new Date(t - 180 * 60_000) } });
    await runReminders(new Date(t - 150 * 60_000));
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: r.body.id } })).toBe(0);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: false, email: true, whatsapp: false, offsetsMinutes: [120] } }, adminToken);
    await runReminders(new Date(t - 100 * 60_000));
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: r.body.id } })).toBe(0);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: true, whatsapp: false, offsetsMinutes: [1440, 120] } }, adminToken);
    await runReminders(new Date(t - 100 * 60_000));
    expect(await prisma.appointmentReminder.findMany({ where: { appointmentId: r.body.id } })).toMatchObject([{ offsetMinutes: 120, status: 'SENT' }]);
    // Validación y envío de prueba
    expect((await call('PUT', '/api/admin/settings', { reminders: { enabled: true, offsetsMinutes: [5] } }, adminToken)).status).toBe(400);
    expect((await call('POST', '/api/admin/reminders/test', { channel: 'EMAIL' }, adminToken)).body).toMatchObject({ status: 'SENT', detail: 'a@a.es' });
    expect((await call('POST', '/api/admin/reminders/test', { channel: 'WHATSAPP', phone: '600000000' }, adminToken)).status).toBe(400);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: false } }, adminToken);
  });

  it('cada cliente elige sus avisos entre los canales activados en Configuración', async () => {
    const { runReminders } = await import('../src/services/reminders.js');
    const flags = async () => (await call('GET', '/api/auth/me', undefined, clientToken)).body as { remindEmail: boolean; remindWhatsapp: boolean };
    // Con los recordatorios apagados no se pueden activar en el perfil
    expect((await flags())).toMatchObject({ remindEmail: false, remindWhatsapp: false });
    expect((await call('PATCH', '/api/auth/me', { remindEmail: true }, clientToken)).status).toBe(400);

    // Al activar el email en Configuración se activa en todos los perfiles; WhatsApp sigue apagado
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: true, whatsapp: false, offsetsMinutes: [120] } }, adminToken);
    expect(await flags()).toMatchObject({ remindEmail: true, remindWhatsapp: false });
    expect((await call('PATCH', '/api/auth/me', { remindWhatsapp: true }, clientToken)).status).toBe(400);
    expect((await call('GET', '/api/public/config')).body.reminders).toEqual({ email: true, whatsapp: false });
    const nuevo = await call('POST', '/api/auth/register', { name: 'Nuevo', email: 'n@n.es', phone: '600999888', password: 'nuevo1234' });
    expect(nuevo.body.user).toMatchObject({ remindEmail: true, remindWhatsapp: false });

    // El cliente quita el email: no se le avisa
    expect((await call('PATCH', '/api/auth/me', { remindEmail: false }, clientToken)).body.remindEmail).toBe(false);
    const start = await slotIn(6, 2);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    await runReminders(new Date(new Date(start).getTime() - 100 * 60_000));
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: r.body.id } })).toBe(0);

    // El admin se lo vuelve a activar desde su ficha
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    expect((await call('PATCH', `/api/admin/users/${me.id}`, { remindEmail: true }, adminToken)).body.remindEmail).toBe(true);
    expect((await call('PATCH', `/api/admin/users/${me.id}`, { remindWhatsapp: true }, adminToken)).status).toBe(400);

    // Desactivar el canal en Configuración lo apaga en todos los perfiles
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: false, whatsapp: true, offsetsMinutes: [120] } }, adminToken);
    expect(await flags()).toMatchObject({ remindEmail: false, remindWhatsapp: true });
    expect(await prisma.user.count({ where: { role: 'CLIENT', remindEmail: true } })).toBe(0);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: false } }, adminToken);
    expect(await prisma.user.count({ where: { role: 'CLIENT', OR: [{ remindEmail: true }, { remindWhatsapp: true }] } })).toBe(0);
  });
});

describe('recordatorio por email enviado a mano', () => {
  it('muestra el texto, lo registra, se puede repetir y no bloquea los automáticos', async () => {
    const start = await slotIn(9, 1);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const id = r.body.id as string;
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'c@c.es' } });
    const p = await call('GET', `/api/admin/reminders/preview?appointmentId=${id}`, undefined, adminToken);
    expect(p.body).toMatchObject({ appointmentId: id, to: 'c@c.es', simulated: true });
    expect(p.body.body).not.toContain('{');
    const next = await prisma.appointment.findFirstOrThrow({ where: { clientId: me.id, status: 'CONFIRMED', startAt: { gt: new Date() } }, orderBy: { startAt: 'asc' } });
    expect((await call('GET', `/api/admin/reminders/preview?clientId=${me.id}`, undefined, adminToken)).body.appointmentId).toBe(next.id);
    for (let i = 0; i < 2; i++) expect((await call('POST', `/api/admin/appointments/${id}/remind-email`, undefined, adminToken)).status).toBe(200);
    // Sin SMTP no consta como enviado
    expect(await prisma.appointmentReminder.findMany({ where: { appointmentId: id } })).toMatchObject([{ offsetMinutes: 0, channel: 'EMAIL', status: 'SKIPPED' }]);
    const { runReminders } = await import('../src/services/reminders.js');
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: true, whatsapp: false, offsetsMinutes: [120] } }, adminToken);
    await runReminders(new Date(new Date(start).getTime() - 100 * 60_000));
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: id, offsetMinutes: 120 } })).toBe(1);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: false } }, adminToken);
  });

  it('solo para el administrador, con email y en citas confirmadas futuras', async () => {
    const start = await slotIn(9, 3);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'cash' }, clientToken);
    const url = `/api/admin/appointments/${r.body.id}/remind-email`;
    expect((await call('POST', url, undefined, clientToken)).status).toBe(403);
    await call('POST', `/api/admin/appointments/${r.body.id}/cancel`, { notify: false }, adminToken);
    expect((await call('POST', url, undefined, adminToken)).status).toBe(400);
    const ficha = await prisma.user.create({ data: { name: 'Sin email', acceptsEmail: false } });
    expect((await call('GET', `/api/admin/reminders/preview?clientId=${ficha.id}`, undefined, adminToken)).status).toBe(400);
    const a = await prisma.appointment.create({ data: { clientId: ficha.id, serviceId, startAt: new Date(Date.now() + 864e5), endAt: new Date(Date.now() + 864e5 + 18e5), status: 'CONFIRMED', paymentMethod: 'cash', priceCents: 1500 } });
    expect((await call('POST', `/api/admin/appointments/${a.id}/remind-email`, undefined, adminToken)).body.error).toContain('email');
  });
});

describe('resumen del administrador', () => {
  it('novedades por WhatsApp: solo con consentimiento expreso', async () => {
    const reg = (email: string, o = {}) => call('POST', '/api/auth/register', { name: 'Consent', email, phone: '600222333', password: 'cliente123', ...o });
    expect((await reg('w1@w.es', { acceptsEmail: true })).body.user).toMatchObject({ acceptsEmail: true, acceptsWhatsapp: false });
    const r = await reg('w2@w.es', { acceptsEmail: true, acceptsWhatsapp: true });
    expect(r.body.user.acceptsWhatsapp).toBe(true);
    expect((await call('PATCH', '/api/auth/me', { name: 'Otro nombre' }, r.body.token)).body.acceptsWhatsapp).toBe(true);
    expect((await call('PATCH', '/api/auth/me', { acceptsEmail: false, acceptsWhatsapp: false }, r.body.token)).body).toMatchObject({ acceptsEmail: false, acceptsWhatsapp: false });
  });

  it('muestra el día, lo pendiente y los huecos liberados', async () => {
    const { dashboard } = await import('../src/services/dashboard.js');
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'o@o.es' } });
    // Un lunes lejano a las 10:15, sin otras citas
    const day = DateTime.now().setZone('Europe/Madrid').plus({ weeks: 70 }).set({ weekday: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
    const at = (h: number, m = 0, d = 0) => day.plus({ days: d }).set({ hour: h, minute: m });
    const now = at(10, 15).toJSDate();
    const mk = (t: ReturnType<typeof at>, o = {}) => prisma.appointment.create({ data: { clientId: me.id, serviceId, startAt: t.toJSDate(), endAt: t.plus({ minutes: 30 }).toJSDate(), priceCents: 1500, paymentMethod: 'cash', status: 'CONFIRMED', ...o } });
    const done = await mk(at(9));
    await prisma.payment.create({ data: { appointmentId: done.id, provider: 'cash', amountCents: 1500, currency: 'EUR', status: 'COMPLETED', createdAt: at(9, 30).toJSDate() } });
    const unpaid = await mk(at(9, 30));
    const next = await mk(at(11));
    const freed = await mk(at(12), { status: 'CANCELLED', cancelledBy: 'CLIENT', cancelledAt: at(9).toJSDate() });
    const retaken = await mk(at(12, 30), { status: 'CANCELLED', cancelledBy: 'CLIENT', cancelledAt: at(9).toJSDate() });
    await mk(at(12, 30));
    const tomorrow = await mk(at(9, 0, 1));
    const d = await dashboard(now);
    expect(d.next!.id).toBe(next.id);
    expect(d.next!.isToday).toBe(true);
    // 16 huecos: 09:00, 09:30, 11:00 y 12:30 ocupados; 10:00 ya pasado
    expect(d.figures).toMatchObject({ done: 2, pending: 2, free: 11, collectedCents: 1500, toCollectCents: 4500 });
    expect(d.agenda).toHaveLength(16);
    expect(d.agenda.filter((c) => c.state === 'booked')).toHaveLength(4);
    expect(d.todo.unpaid.items[0].id).toBe(unpaid.id);
    expect(d.todo.freed.map((x) => x.id)).toEqual([freed.id]);
    expect(d.todo.freed.map((x) => x.id)).not.toContain(retaken.id);
    expect(d.todo.noReminder).toEqual([]); // recordatorios desactivados: no se avisa
    await call('PUT', '/api/admin/settings', { reminders: { enabled: true, email: true, whatsapp: false, offsetsMinutes: [1440] } }, adminToken);
    const on = await dashboard(now);
    expect(on.todo.noReminder.map((x) => x.id)).toContain(tomorrow.id); // sin SMTP nadie lo recibe
    expect(on.todo.warnings).toHaveLength(1);
    await call('PUT', '/api/admin/settings', { reminders: { enabled: false } }, adminToken);
  });

  it('calcula ingresos netos, comparación y ocupación', async () => {
    const { business } = await import('../src/services/dashboard.js');
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'o@o.es' } });
    const day = DateTime.now().setZone('Europe/Madrid').plus({ weeks: 90 }).set({ weekday: 5, hour: 10, minute: 0, second: 0, millisecond: 0 });
    const pay = async (daysAgo: number, provider: string, amountCents: number, refundedCents = 0) => {
      const t = day.minus({ days: daysAgo });
      const a = await prisma.appointment.create({ data: { clientId: me.id, serviceId, startAt: t.toJSDate(), endAt: t.plus({ minutes: 30 }).toJSDate(), priceCents: amountCents, paymentMethod: provider, status: 'COMPLETED' } });
      await prisma.payment.create({ data: { appointmentId: a.id, provider, amountCents, refundedCents, currency: 'EUR', status: refundedCents ? 'PARTIALLY_REFUNDED' : 'COMPLETED', createdAt: t.toJSDate(), capturedAt: provider === 'cash' ? null : t.toJSDate() } });
    };
    await pay(0, 'cash', 2000);
    await pay(1, 'paypal', 1500, 500);
    await pay(8, 'cash', 1000);
    const b = await business('7d', day.set({ hour: 21 }).toJSDate());
    expect(b.buckets).toHaveLength(7);
    expect(b).toMatchObject({ totalCents: 3000, cashCents: 2000, onlineCents: 1000, previousCents: 1000 });
    expect(b.buckets[6]).toMatchObject({ cashCents: 2000, onlineCents: 0 });
    // 5 días × 8 h abiertas; 2 medias horas con cita
    expect(b.occupancy.hours).toEqual([9, 10, 11, 12, 16, 17, 18, 19]);
    expect(b.occupancy.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(b.occupancy.cells[4][1]).toBe(50);
    expect(b.occupancy.percent).toBe(3);
    const m = await business('12m', day.set({ hour: 21 }).toJSDate());
    expect(m.buckets).toHaveLength(12);
    expect(m.totalCents).toBe(m.buckets.reduce((n, x) => n + x.cashCents + x.onlineCents, 0));
    expect((await call('GET', '/api/admin/dashboard/business?period=30d', undefined, adminToken)).status).toBe(200);
    expect((await call('GET', '/api/admin/dashboard/business', undefined, clientToken)).status).toBe(403);
  });

  it('servicios, ausencias, clientes y quién lleva tiempo sin venir', async () => {
    const { business } = await import('../src/services/dashboard.js');
    const base = DateTime.now().setZone('Europe/Madrid').plus({ weeks: 120 }).set({ weekday: 3, hour: 21, minute: 0, second: 0, millisecond: 0 });
    const user = (name: string, o = {}) => prisma.user.create({ data: { name, phone: '600123123', email: `${name}@r.es`, ...o } });
    const [fiel, nuevo, perdido, promo, conCita] = await Promise.all([user('Fiel'), user('Nuevo'), user('Perdido', { acceptsWhatsapp: true }), user('SinPromo'), user('ConCita')]);
    const mk = async (clientId: string, ago: number, hour: number, o: Record<string, unknown> = {}, paid = 1500, refunded = 0) => {
      const t = base.minus({ days: ago }).set({ hour });
      const a = await prisma.appointment.create({ data: { clientId, serviceId, startAt: t.toJSDate(), endAt: t.plus({ minutes: 30 }).toJSDate(), priceCents: 1500, paymentMethod: 'cash', status: 'COMPLETED', ...o } });
      if (paid) {
        const p = await prisma.payment.create({ data: { appointmentId: a.id, provider: 'cash', amountCents: paid, refundedCents: refunded, currency: 'EUR', status: refunded ? 'PARTIALLY_REFUNDED' : 'COMPLETED', createdAt: t.toJSDate() } });
        if (refunded) await prisma.refund.create({ data: { paymentId: p.id, amountCents: refunded, requestedBy: 'ADMIN', createdAt: t.toJSDate() } });
      }
    };
    await mk(fiel.id, 40, 9); await mk(fiel.id, 5, 9); await mk(fiel.id, 2, 9, {}, 2000, 500);
    await mk(nuevo.id, 1, 10);
    await mk(fiel.id, 3, 11, { status: 'NO_SHOW' }, 0);
    await mk(nuevo.id, 3, 12, { status: 'CANCELLED', cancelledBy: 'CLIENT' }, 0); // se quedó vacía
    await mk(fiel.id, 4, 16, { status: 'CANCELLED', cancelledBy: 'CLIENT' }, 0); // se volvió a llenar
    await mk(nuevo.id, 4, 16, { priceCents: 1000 }, 1000);
    await mk(nuevo.id, 4, 17, { status: 'CANCELLED', cancelledBy: 'ADMIN' }, 0);
    for (const u of [perdido, promo, conCita]) for (const d of [150, 120, 90]) await mk(u.id, d, 9);
    await mk(conCita.id, -3, 9, { status: 'CONFIRMED' }, 0);

    const b = await business('30d', base.toJSDate());
    expect(b.incidents).toEqual({ came: 4, noShow: 1, byClient: 2, byShop: 1, lostNoShowCents: 1500, lostCancelledCents: 1500 });
    expect(b.services).toEqual([expect.objectContaining({ count: 4, cents: 1500 + 1500 + 1500 + 1000 })]);
    expect(b.avgTicketCents).toBe(1375);
    expect(b.refunds).toEqual({ count: 1, cents: 500 });
    expect(b.forecast).toEqual({ count: 1, cents: 1500 });
    expect(b.clients).toMatchObject({ fresh: 1, recurring: 2, top: [{ name: 'Fiel', visits: 2, cents: 3000 }, { name: 'Nuevo', visits: 2, cents: 2500 }] });
    const names = b.lapsed.items.map((x) => x.name);
    expect(names).toContain('Perdido');
    expect(names).not.toContain('ConCita');
    expect(names).not.toContain('Fiel');
    expect(b.lapsed.items.find((x) => x.name === 'Perdido')).toMatchObject({ days: 90, usualDays: 30, visits: 3, whatsappLink: expect.stringContaining('wa.me') });
    // Aceptar solo el email (casilla antigua) no vale para WhatsApp
    expect(b.lapsed.items.find((x) => x.name === 'SinPromo')).toMatchObject({ accepts: false, whatsappLink: null });
  });
});

vi.setConfig({ testTimeout: 20_000 });
