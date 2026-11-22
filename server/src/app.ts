import { existsSync } from 'node:fs';
import path from 'node:path';
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
import { ticketsRouter } from './routes/tickets.js';
import { importsRouter } from './routes/imports.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origin === 'null' || config.corsOrigins.includes(origin)) }));
  // Va antes del parser general porque admite fotos de varios MB.
  app.use('/api/admin/imports', importsRouter);
  app.use(express.json({ limit: '600kb' }) /* admite la foto de perfil */);

  if (config.noindex) {
    app.use((_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
    app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/admin', adminRouter);

  serveClient(app);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details !== undefined && { details: err.details }) });
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

/**
 * Sirve la web compilada desde el mismo servidor (si existe client/dist).
 * Con SITE_PASSWORD, la web pide usuario y contraseña (el usuario da igual).
 * La API no lleva esa contraseña: ya tiene su propio inicio de sesión.
 */
function serveClient(app: express.Express) {
  const index = path.join(config.clientDist, 'index.html');
  if (!existsSync(index)) return;
  if (config.sitePassword) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
      const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (pass === config.sitePassword) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="Peluqueria Armando (demo)", charset="UTF-8"');
      res.status(401).send('Acceso restringido');
    });
  }
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  // Rutas de la web (p. ej. /admin/agenda): siempre index.html, sin caché.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
