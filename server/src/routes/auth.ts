import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, signToken, userBlockReason } from '../lib/auth.js';
import { avatarData, avatarField } from '../lib/avatar.js';
import { prisma } from '../lib/db.js';
import { HttpError, conflict } from '../lib/errors.js';
import { h, publicUser } from './util.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Indica tu nombre'),
  email: z.string().trim().toLowerCase().email('Email no válido'),
  phone: z.string().trim().min(9, 'Teléfono no válido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  acceptsEmail: z.boolean().optional(),
  avatar: avatarField,
});

authRouter.post('/register', h(async (req, res) => {
  const data = registerSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: data.email } })) throw conflict('Ya existe una cuenta con ese email');
  const user = await prisma.user.create({
    data: {
      name: data.name, email: data.email, phone: data.phone, acceptsEmail: data.acceptsEmail ?? true,
      passwordHash: await bcrypt.hash(data.password, 10), ...avatarData(data.avatar),
    },
  });
  res.status(201).json({ token: signToken({ id: user.id, role: 'CLIENT' }), user: publicUser(user) });
}));

authRouter.post('/login', h(async (req, res) => {
  const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Email o contraseña incorrectos');
  const blocked = userBlockReason(user);
  if (blocked) throw new HttpError(403, blocked, 'USER_BLOCKED');
  res.json({ token: signToken({ id: user.id, role: user.role as 'CLIENT' | 'ADMIN' }), user: publicUser(user) });
}));

authRouter.get('/me', requireAuth, h(async (req, res) => {
  res.json(publicUser(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })));
}));

authRouter.patch('/me', requireAuth, h(async (req, res) => {
  const data = z.object({
    name: z.string().trim().min(2).optional(),
    phone: z.string().trim().min(9).optional(),
    acceptsEmail: z.boolean().optional(),
    password: z.string().min(8).optional(),
    avatar: avatarField,
  }).parse(req.body);
  const { password, avatar, ...rest } = data;
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { ...rest, ...avatarData(avatar), ...(password && { passwordHash: await bcrypt.hash(password, 10) }) },
  });
  res.json(publicUser(user));
}));
