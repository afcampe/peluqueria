import type { NextFunction, Request, Response } from 'express';
import type { Actor } from '../services/appointments.js';

/** Envuelve handlers async para que los errores lleguen al middleware de errores. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const actor = (req: Request): Actor => req.user!;

export const publicUser = (u: {
  id: string; email: string | null; name: string; phone: string | null; role: string; status: string;
  blockedUntil: Date | null; blockReason: string | null; acceptsEmail: boolean; createdAt: Date;
  remindEmail: boolean; remindWhatsapp: boolean;
  avatarUpdatedAt: Date | null;
}) => ({
  id: u.id, email: u.email, name: u.name,
  // Ficha sin cuenta: creada desde la agenda en papel, sin email ni acceso a la app.
  hasAccount: u.email !== null, phone: u.phone, role: u.role, status: u.status,
  blockedUntil: u.blockedUntil, blockReason: u.blockReason, acceptsEmail: u.acceptsEmail, createdAt: u.createdAt,
  remindEmail: u.remindEmail, remindWhatsapp: u.remindWhatsapp,
  // Ruta relativa a la API; el parámetro v invalida la caché al cambiar la foto.
  avatarUrl: u.avatarUpdatedAt ? `/api/public/avatars/${u.id}?v=${u.avatarUpdatedAt.getTime()}` : null,
});
