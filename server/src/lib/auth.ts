import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from './db.js';
import { HttpError } from './errors.js';

export interface AuthUser {
  id: string;
  role: 'CLIENT' | 'ADMIN';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (u: AuthUser) => jwt.sign(u, config.jwtSecret, { expiresIn: '30d' });

/** Devuelve el motivo si el usuario no puede operar, o null si está activo. */
export function userBlockReason(u: { status: string; blockedUntil: Date | null }, now = new Date()) {
  if (u.status === 'DELETED') return 'Esta cuenta ha sido dada de baja';
  if (u.status === 'BLOCKED') {
    if (!u.blockedUntil) return 'Tu cuenta está bloqueada. Contacta con la peluquería.';
    if (u.blockedUntil > now) return `Tu cuenta está bloqueada hasta el ${u.blockedUntil.toLocaleDateString('es-ES')}`;
  }
  return null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Debes iniciar sesión');
    let payload: AuthUser;
    try {
      payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    } catch {
      throw new HttpError(401, 'Sesión caducada, vuelve a iniciar sesión');
    }
    // Se comprueba en cada petición para que bajas y bloqueos tengan efecto inmediato.
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) throw new HttpError(401, 'Usuario no encontrado');
    const blocked = userBlockReason(user);
    if (blocked) throw new HttpError(403, blocked, 'USER_BLOCKED');
    req.user = { id: user.id, role: user.role as AuthUser['role'] };
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return next(new HttpError(403, 'Solo para administradores'));
  next();
}
