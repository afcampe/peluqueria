import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { ticketDownloadPath, ticketView } from '../services/tickets.js';
import { h } from './util.js';

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

/**
 * Enlace temporal para descargar el PDF. Así la descarga funciona con un enlace normal
 * (navegador, Electron y apps móviles) sin poner el token de sesión en la URL.
 */
ticketsRouter.get('/:id/link', h(async (req, res) => {
  const t = await loadOwn(req.params.id, req.user!);
  res.json({ number: t.number, url: ticketDownloadPath(t.id) });
}));

/** Contenido del ticket para mostrarlo en la app (vista previa). */
ticketsRouter.get('/:id', h(async (req, res) => {
  const t = await loadOwn(req.params.id, req.user!);
  res.json(await ticketView(t.id));
}));

// Cada cliente solo ve sus tickets; el administrador, todos.
async function loadOwn(id: string, user: { id: string; role: string }) {
  const t = await prisma.ticket.findUnique({ where: { id } });
  if (!t || (user.role !== 'ADMIN' && t.clientId !== user.id)) throw notFound('Ticket no encontrado');
  return t;
}
