import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { ticketDownloadPath } from '../services/tickets.js';
import { h } from './util.js';

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

/**
 * Enlace temporal para descargar el PDF. Así la descarga funciona con un enlace normal
 * (navegador, Electron y apps móviles) sin poner el token de sesión en la URL.
 */
ticketsRouter.get('/:id/link', h(async (req, res) => {
  const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  // Cada cliente solo ve sus tickets; el administrador, todos.
  if (!t || (req.user!.role !== 'ADMIN' && t.clientId !== req.user!.id)) throw notFound('Ticket no encontrado');
  res.json({ number: t.number, url: ticketDownloadPath(t.id) });
}));
