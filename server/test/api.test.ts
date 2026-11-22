import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL = 'file:./test.db';
process.env.NODE_ENV = 'test';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
// Base de datos desechable solo para tests
rmSync('prisma/test.db', { force: true });
execSync('npx prisma db push --skip-generate', { stdio: 'ignore', env: process.env });

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/db.js');
const { paypalProvider } = await import('../src/payments/paypal.js');
const { saveSettings } = await import('../src/services/settings.js');
const { DateTime } = await import('luxon');

// PayPal simulado
const refunds: number[] = [];
paypalProvider.createOrder = async () => ({ orderId: 'ORDER-1' });
paypalProvider.captureOrder = async () => ({ captureId: 'CAP-1', amountCents: 1500, currency: 'EUR' });
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
    expect(order.body.orderId).toBe('ORDER-1');
    const done = await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: 'ORDER-1' }, clientToken);
    expect(done.body.status).toBe('CONFIRMED');

    const cancel = await call('POST', `/api/appointments/${r.body.id}/cancel`, {}, clientToken);
    expect(cancel.body.refundedCents).toBe(1500);
    expect(refunds).toEqual([1500]);
  });

  it('admin: reembolso parcial manual', async () => {
    const start = await slotIn(6);
    const r = await call('POST', '/api/appointments', { serviceId, startAt: start, paymentMethod: 'paypal' }, clientToken);
    await call('POST', `/api/appointments/${r.body.id}/pay/start`, {}, clientToken);
    const done = await call('POST', `/api/appointments/${r.body.id}/pay/complete`, { orderId: 'ORDER-1' }, clientToken);
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
    const c = await call('POST', '/api/admin/closures', { start: date, end: date, reason: 'Festivo', cancelAppointments: true }, adminToken);
    expect(c.body.cancelled).toBe(1);
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

vi.setConfig({ testTimeout: 20_000 });
