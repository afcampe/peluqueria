import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAdmin, requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/db.js';
import { commitImport, createImport, discardImport, importDetail, kickImportQueue, readImportImage, saveRows, summary } from '../services/agendaImport.js';
import { actor, h } from './util.js';

/** Importación de la agenda en papel a partir de fotos (solo administrador). */
export const importsRouter = Router();
// Las fotos de la cámara pesan más que el límite general de la API.
importsRouter.use(express.json({ limit: '12mb' }), requireAuth, requireAdmin);

const ADMIN = (req: Parameters<typeof actor>[0]) => ({ ...actor(req), role: 'ADMIN' as const });

const rowSchema = z.object({
  key: z.string().min(1).max(64),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().max(5).nullable(),
  name: z.string().max(80),
  serviceId: z.string().nullable(),
  clientId: z.string().nullable(),
  include: z.boolean(),
  uncertain: z.boolean(),
  crossedOut: z.boolean().default(false),
  note: z.string().max(200).nullable(),
});
const rowsBody = z.object({ rows: z.array(rowSchema).max(500) });

importsRouter.get('/', h(async (_req, res) => {
  const items = await prisma.agendaImport.findMany({ where: { status: { not: 'DISCARDED' } }, orderBy: { createdAt: 'desc' }, take: 1000 });
  res.json({
    readerConfigured: config.anthropicConfigured,
    items: items.map(({ rows, imagePath, ...i }) => ({ ...i, hasImage: !!imagePath, ...summary({ id: i.id, rows, status: i.status }) })),
  });
}));

importsRouter.post('/', h(async (req, res) => {
  const data = z.object({ image: z.string().min(30), fileName: z.string().optional() }).parse(req.body);
  const item = await createImport(data, req.user!.id);
  res.status(201).json({ id: item.id, status: item.status });
}));

/** Página para pasar a mano, sin foto ni lectura automática. */
importsRouter.post('/manual', h(async (req, res) => {
  const item = await prisma.agendaImport.create({ data: { status: 'READY', fileName: 'Introducida a mano', createdBy: req.user!.id } });
  res.status(201).json({ id: item.id, status: item.status });
}));

importsRouter.get('/:id', h(async (req, res) => { res.json(await importDetail(req.params.id)); }));

importsRouter.get('/:id/image', h(async (req, res) => {
  const img = await readImportImage(req.params.id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(img.mime).send(img.data);
}));

importsRouter.put('/:id', h(async (req, res) => {
  await saveRows(req.params.id, rowsBody.parse(req.body).rows);
  res.json(await importDetail(req.params.id));
}));

importsRouter.post('/:id/retry', h(async (req, res) => {
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!item.imagePath) return res.status(400).json({ error: 'Esta página no tiene foto' });
  await prisma.agendaImport.update({ where: { id: item.id }, data: { status: 'PENDING', error: null, rows: '[]' } });
  kickImportQueue();
  res.json({ ok: true });
}));

importsRouter.post('/:id/commit', h(async (req, res) => {
  const body = rowsBody.partial().parse(req.body ?? {});
  const r = await commitImport(req.params.id, ADMIN(req), body.rows);
  res.json({ ...r, detail: await importDetail(req.params.id) });
}));

importsRouter.delete('/:id', h(async (req, res) => {
  await discardImport(req.params.id);
  res.status(204).end();
}));
