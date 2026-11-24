import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';
import { Prisma, type Rectification, type Ticket } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getProvider } from '../payments/registry.js';
import { getSettings } from './settings.js';

export type TicketOrigin = 'SHOP' | 'ONLINE';

/** Estados de pago que admiten ticket: cobrado y sin devoluciones. */
const TICKETABLE = ['COMPLETED'];

const pad = (n: number) => String(n).padStart(4, '0');
export const ticketNumber = (year: number, seq: number) => `${year}-${pad(seq)}`;

/** Ruta absoluta del PDF de un ticket. */
export const ticketFile = (t: Pick<Ticket, 'filePath'>) => path.join(config.ticketsDir, t.filePath);

/**
 * Emite un ticket para uno o varios pagos del mismo cliente (varios = una serie
 * pagada de una vez). La numeración es AAAA-NNNN, consecutiva y común a todos los
 * métodos de pago; se reinicia cada año. El PDF se guarda en TICKETS_DIR/AAAA/MM/.
 */
export async function issueTicket(paymentIds: string[], origin: TicketOrigin): Promise<Ticket> {
  const ids = [...new Set(paymentIds)];
  if (!ids.length) throw badRequest('No hay pagos para el ticket');
  const settings = await getSettings();
  const payments = await prisma.payment.findMany({ where: { id: { in: ids } }, include: { appointment: true } });
  if (payments.length !== ids.length) throw notFound('Pago no encontrado');
  if (payments.some((p) => p.ticketId)) throw conflict('Este cobro ya tiene ticket', 'TICKET_EXISTS');
  if (payments.some((p) => !TICKETABLE.includes(p.status))) throw badRequest('Solo se emite ticket de citas cobradas');
  const clientIds = new Set(payments.map((p) => p.appointment.clientId));
  if (clientIds.size !== 1) throw badRequest('Un ticket solo puede ser de un cliente');
  const providers = new Set(payments.map((p) => p.provider));
  if (providers.size !== 1) throw badRequest('Un ticket solo puede tener una forma de pago');

  let ticket: Ticket | null = null;
  for (let attempt = 0; !ticket; attempt++) {
    try {
      ticket = await prisma.$transaction(async (tx) => {
        const now = DateTime.now().setZone(settings.timezone);
        const last = await tx.ticket.findFirst({ where: { year: now.year }, orderBy: { seq: 'desc' }, select: { seq: true } });
        const seq = (last?.seq ?? 0) + 1;
        const number = ticketNumber(now.year, seq);
        const t = await tx.ticket.create({
          data: {
            number, year: now.year, seq, issuedAt: now.toJSDate(),
            clientId: [...clientIds][0], provider: [...providers][0], origin,
            totalCents: payments.reduce((s, p) => s + p.amountCents, 0),
            vatPercent: settings.ticketVatPercent,
            currency: payments[0].currency,
            filePath: `${now.year}/${String(now.month).padStart(2, '0')}/${number}.pdf`,
          },
        });
        // Evita dos tickets para el mismo cobro si se pulsa dos veces a la vez.
        const linked = await tx.payment.updateMany({ where: { id: { in: ids }, ticketId: null }, data: { ticketId: t.id } });
        if (linked.count !== ids.length) throw conflict('Este cobro ya tiene ticket', 'TICKET_EXISTS');
        return t;
      }, { isolationLevel: 'Serializable' });
    } catch (e) {
      // Número ya usado por otro ticket emitido a la vez: se reintenta con el siguiente.
      const retryable = e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(e.code);
      if (!retryable || attempt >= 5) throw e;
    }
  }

  try {
    await writeTicketFile(ticket.id);
  } catch (e) {
    // El ticket ya tiene número; si falla el disco, el PDF se regenera al descargarlo.
    console.error(`No se pudo guardar el PDF del ticket ${ticket.number}:`, e);
  }
  return ticket;
}

/** Emite ticket para los pagos online completados de estas citas que aún no lo tengan. */
export async function issueOnlineTicket(orderId: string, appointmentIds: string[]) {
  const pending = await prisma.payment.findMany({
    where: { providerOrderId: orderId, appointmentId: { in: appointmentIds }, status: { in: TICKETABLE }, ticketId: null },
    select: { id: true },
  });
  if (!pending.length) return null;
  return issueTicket(pending.map((p) => p.id), 'ONLINE');
}

// ---------------------------------------------------------------- Rectificativos

export const rectificationNumber = (year: number, seq: number) => `R${year}-${pad(seq)}`;

/**
 * Emite el ticket rectificativo de un reembolso, si el cobro tenía ticket. Serie propia
 * RAAAA-NNNN. Es idempotente: cada reembolso tiene como mucho un rectificativo.
 */
export async function issueRectification(refundId: string): Promise<Rectification | null> {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true, rectification: true } });
  if (refund.rectification) return refund.rectification;
  if (!refund.payment.ticketId) return null;
  const settings = await getSettings();
  let rect: Rectification | null = null;
  for (let attempt = 0; !rect; attempt++) {
    try {
      rect = await prisma.$transaction(async (tx) => {
        const now = DateTime.now().setZone(settings.timezone);
        const last = await tx.rectification.findFirst({ where: { year: now.year }, orderBy: { seq: 'desc' }, select: { seq: true } });
        const seq = (last?.seq ?? 0) + 1;
        const number = rectificationNumber(now.year, seq);
        return tx.rectification.create({
          data: {
            number, year: now.year, seq, issuedAt: now.toJSDate(), ticketId: refund.payment.ticketId!, refundId,
            amountCents: refund.amountCents, reason: refund.reason || 'Devolución del importe',
            filePath: `${now.year}/${String(now.month).padStart(2, '0')}/${number}.pdf`,
          },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (e) {
      const done = await prisma.rectification.findUnique({ where: { refundId } });
      if (done) return done;
      const retryable = e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(e.code);
      if (!retryable || attempt >= 5) throw e;
    }
  }
  try {
    await writeTicketFile(rect.id);
  } catch (e) {
    console.error(`No se pudo guardar el PDF del rectificativo ${rect.number}:`, e);
  }
  return rect;
}

/** Tras un reembolso ya hecho: si falla la emisión no se pierde el reembolso; se reintenta después. */
export async function rectifyRefund(refundId: string) {
  try {
    return await issueRectification(refundId);
  } catch (e) {
    console.error(`No se pudo emitir el rectificativo del reembolso ${refundId}:`, e);
    return null;
  }
}

/** Emite los rectificativos que falten (reembolsos con ticket sin rectificativo). */
export async function issueMissingRectifications() {
  const pending = await prisma.refund.findMany({
    where: { rectification: { is: null }, payment: { ticketId: { not: null } } }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  for (const r of pending) await rectifyRefund(r.id);
  return pending.length;
}

/** Los tickets anteriores a guardar el IVA toman el configurado ahora, y ya no cambian. */
export async function fillMissingVat() {
  const { ticketVatPercent } = await getSettings();
  return (await prisma.ticket.updateMany({ where: { vatPercent: null }, data: { vatPercent: ticketVatPercent } })).count;
}

/** Busca un ticket o un rectificativo por su id. */
export async function findTicketDoc(id: string) {
  const t = await prisma.ticket.findUnique({ where: { id } });
  if (t) return { id: t.id, number: t.number, filePath: t.filePath, clientId: t.clientId };
  const r = await prisma.rectification.findUnique({ where: { id }, include: { ticket: { select: { clientId: true } } } });
  return r ? { id: r.id, number: r.number, filePath: r.filePath, clientId: r.ticket.clientId } : null;
}

/** Guarda el PDF en disco (año/mes). */
export async function writeTicketFile(ticketId: string) {
  const t = await findTicketDoc(ticketId);
  if (!t) throw notFound('Ticket no encontrado');
  const file = ticketFile(t);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await renderTicketPdf(ticketId));
  return file;
}

/** Devuelve la ruta del PDF, regenerándolo si falta en disco. */
export async function ensureTicketFile(t: Pick<Ticket, 'id' | 'filePath'>) {
  const file = ticketFile(t);
  if (!existsSync(file)) await writeTicketFile(t.id);
  return file;
}

// ---------------------------------------------------------------- Enlaces de descarga

// Secreto distinto al de sesión: un enlace de ticket nunca sirve para iniciar sesión.
const linkSecret = () => `${config.jwtSecret}:tickets`;

/** URL temporal (10 min) para descargar el PDF sin cabecera de autorización. */
export function ticketDownloadPath(ticketId: string) {
  const sig = jwt.sign({ tid: ticketId }, linkSecret(), { expiresIn: '10m' });
  return `/api/public/tickets/${ticketId}/pdf?sig=${encodeURIComponent(sig)}`;
}

export function verifyTicketSig(ticketId: string, sig: string) {
  try {
    const p = jwt.verify(sig, linkSecret()) as { tid?: string };
    return p.tid === ticketId;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Contenido del ticket

/** Contenido del ticket, ya formateado. Lo usan el PDF y la vista previa de la app. */
export interface TicketView {
  id: string;
  number: string;
  issuedAt: string;
  issuedAtText: string;
  issuer: { name: string; lines: string[] };
  client: string;
  method: string;
  origin: TicketOrigin;
  currency: string;
  lines: { concept: string; detail: string; amountCents: number }[];
  vatPercent: number;
  baseCents: number | null;
  vatCents: number | null;
  totalCents: number;
  /** Devuelto después de emitir el ticket (reembolsos). */
  refundedCents: number;
  reference: string | null;
  /** Solo en los rectificativos: ticket que corrigen y motivo. */
  rectifies: { number: string; issuedAtText: string; reason: string } | null;
  /** Rectificativos emitidos para este ticket. */
  rectifications: string[];
  footer: string;
}

export async function ticketView(id: string): Promise<TicketView> {
  const rect = await prisma.rectification.findUnique({ where: { id }, include: { refund: true } });
  if (!rect) return originalView(id);
  const t = await originalView(rect.ticketId);
  const s = await getSettings();
  const total = -rect.amountCents;
  const base = t.vatPercent > 0 ? Math.round(total / (1 + t.vatPercent / 100)) : null;
  // Importes en negativo: rectificación por la diferencia devuelta.
  const line = await prisma.payment.findUniqueOrThrow({ where: { id: rect.refund.paymentId }, include: { appointment: { include: { service: true } } } });
  const when = (d: Date, f: string) => DateTime.fromJSDate(d).setZone(s.timezone).setLocale('es').toFormat(f);
  return {
    ...t,
    id: rect.id, number: rect.number, issuedAt: rect.issuedAt.toISOString(), issuedAtText: when(rect.issuedAt, 'dd/MM/yyyy HH:mm'),
    lines: [{ concept: `Devolución: ${line.appointment.service.name}`, detail: `Cita del ${when(line.appointment.startAt, "cccc d 'de' LLLL yyyy, HH:mm")}`, amountCents: total }],
    baseCents: base, vatCents: base === null ? null : total - base, totalCents: total, refundedCents: 0,
    method: line.provider === 'cash' ? 'Devuelto en mano' : `Devuelto por ${t.method}`,
    reference: rect.refund.providerRefundId,
    rectifies: { number: t.number, issuedAtText: t.issuedAtText, reason: rect.reason },
    rectifications: [],
  };
}

async function originalView(ticketId: string): Promise<TicketView> {
  const s = await getSettings();
  const t = await prisma.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: {
      client: { select: { name: true } },
      rectifications: { select: { number: true }, orderBy: { issuedAt: 'asc' } },
      payments: { include: { appointment: { include: { service: true } } }, orderBy: { appointment: { startAt: 'asc' } } },
    },
  });
  const when = (d: Date, f: string) => DateTime.fromJSDate(d).setZone(s.timezone).setLocale('es').toFormat(f);
  let method = t.provider;
  try { method = getProvider(t.provider).label; } catch { /* proveedor retirado */ }
  const vat = t.vatPercent ?? s.ticketVatPercent; // el IVA con el que se emitió, aunque cambie después
  const base = vat > 0 ? Math.round(t.totalCents / (1 + vat / 100)) : null;
  return {
    id: t.id,
    number: t.number,
    issuedAt: t.issuedAt.toISOString(),
    issuedAtText: when(t.issuedAt, 'dd/MM/yyyy HH:mm'),
    issuer: {
      name: s.ticketLegalName || s.shopName,
      lines: [
        s.ticketLegalName && s.ticketLegalName !== s.shopName ? s.shopName : '',
        s.ticketTaxId ? `NIF: ${s.ticketTaxId}` : '',
        s.shopAddress,
        [s.shopPhone, s.shopEmail].filter(Boolean).join(' · '),
      ].filter(Boolean),
    },
    client: t.client.name,
    method: method + (t.origin === 'ONLINE' ? ' (pago online)' : ''),
    origin: t.origin as TicketOrigin,
    currency: t.currency,
    lines: t.payments.map((p) => ({
      concept: p.appointment.service.name,
      detail: `Cita del ${when(p.appointment.startAt, "cccc d 'de' LLLL yyyy, HH:mm")}`,
      amountCents: p.amountCents,
    })),
    vatPercent: vat,
    baseCents: base,
    vatCents: base === null ? null : t.totalCents - base,
    totalCents: t.totalCents,
    refundedCents: t.payments.reduce((n, p) => n + p.refundedCents, 0),
    reference: t.payments.find((p) => p.providerCaptureId)?.providerCaptureId ?? null,
    rectifies: null,
    rectifications: t.rectifications.map((r) => r.number),
    footer: s.ticketFooter,
  };
}

// ---------------------------------------------------------------- PDF

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100).replace(/ /g, ' ');

export async function renderTicketPdf(ticketId: string): Promise<Buffer> {
  const v = await ticketView(ticketId);
  const cur = (c: number) => money(c, v.currency);

  const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `${v.rectifies ? 'Rectificativo' : 'Ticket'} ${v.number}`, Author: v.issuer.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const gold = '#a9813f';
  const rule = (y = doc.y) => doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor('#cccccc').stroke();

  // Cabecera
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(v.issuer.name, left, doc.y, { width, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#444444');
  v.issuer.lines.forEach((line) => doc.text(line, { width, align: 'center' }));
  doc.moveDown(0.8);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.2).strokeColor(gold).stroke();
  doc.moveDown(0.8);

  // Datos del ticket
  const meta = (label: string, value: string) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(label, left, y, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#111111').text(value, left + 90, y, { width: width - 90 });
    doc.moveDown(0.25);
  };
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(v.rectifies ? 'TICKET RECTIFICATIVO' : 'TICKET DE COMPRA', left, doc.y);
  doc.moveDown(0.4);
  meta(v.rectifies ? 'Nº rectificativo' : 'Nº de ticket', v.number);
  meta('Fecha', v.issuedAtText);
  meta('Cliente', v.client);
  meta(v.rectifies ? 'Devolución' : 'Forma de pago', v.method);
  if (v.rectifies) {
    meta('Rectifica a', `Ticket ${v.rectifies.number} (${v.rectifies.issuedAtText})`);
    meta('Motivo', v.rectifies.reason);
  }
  doc.moveDown(0.6);

  // Líneas
  const amountW = 80;
  const row = (concept: string, detail: string, amount: string, bold = false) => {
    if (doc.y > bottom() - 60) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor('#111111').text(concept, left, y, { width: width - amountW - 8 });
    if (detail) doc.font('Helvetica').fontSize(8).fillColor('#666666').text(detail, left, doc.y, { width: width - amountW - 8 });
    const endY = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor('#111111').text(amount, left + width - amountW, y, { width: amountW, align: 'right' });
    doc.y = Math.max(endY, doc.y) + 4;
    doc.x = left;
  };
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#666666');
  const hy = doc.y;
  doc.text('CONCEPTO', left, hy);
  doc.text('IMPORTE', left + width - amountW, hy, { width: amountW, align: 'right' });
  doc.moveDown(0.3);
  rule();
  doc.moveDown(0.5);
  v.lines.forEach((l) => row(l.concept, l.detail, cur(l.amountCents)));
  rule();
  doc.moveDown(0.5);

  // Totales
  if (v.baseCents !== null && v.vatCents !== null) {
    row('Base imponible', '', cur(v.baseCents));
    row(`IVA ${String(v.vatPercent).replace('.', ',')} %`, '', cur(v.vatCents));
  }
  doc.moveDown(0.2);
  row(v.vatPercent > 0 ? 'TOTAL (IVA incluido)' : 'TOTAL', '', cur(v.totalCents), true);

  if (v.refundedCents > 0) {
    doc.moveDown(0.2);
    row('Reembolsado', v.rectifications.length ? `Rectificativo: ${v.rectifications.join(', ')}` : '', `-${cur(v.refundedCents)}`);
  }

  if (v.reference) {
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(7.5).fillColor('#888888').text(`Referencia ${v.rectifies ? 'del reembolso' : 'del pago'}: ${v.reference}`, left, doc.y, { width });
  }
  if (v.footer && !v.rectifies) {
    doc.moveDown(1.5);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#444444').text(v.footer, left, doc.y, { width, align: 'center' });
  }

  doc.end();
  return done;
}
