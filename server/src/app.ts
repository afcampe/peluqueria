import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { adminRouter } from './routes/admin.js';
import { appointmentsRouter } from './routes/appointments.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origin === 'null' || config.corsOrigins.includes(origin)) }));
  app.use(express.json({ limit: '600kb' }) /* admite la foto de perfil */);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/admin', adminRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => i.message).join('. '), code: 'VALIDATION' });
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') return res.status(404).json({ error: 'No encontrado' });
      if (err.code === 'P2034') return res.status(409).json({ error: 'Otra persona está reservando a la vez. Inténtalo de nuevo.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });
  return app;
}
