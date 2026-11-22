import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const required = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret: required('JWT_SECRET', process.env.NODE_ENV === 'test' ? 'test-secret' : undefined),
  paypal: {
    mode: (process.env.PAYPAL_MODE ?? 'sandbox') as 'sandbox' | 'live',
    clientId: process.env.PAYPAL_CLIENT_ID ?? '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'Peluquería Armando <no-reply@example.com>',
  },
  /** Carpeta de los PDF de tickets (subcarpetas año/mes). */
  ticketsDir: path.resolve(serverRoot, process.env.TICKETS_DIR ?? 'storage/tickets'),
  /** Fotos de la agenda en papel pendientes de importar (se borran al terminar). */
  importDir: path.resolve(serverRoot, process.env.IMPORT_DIR ?? 'storage/import'),
  /** Web compilada (client/dist) que sirve el propio servidor; así web y API van en la misma dirección. */
  clientDist: path.resolve(serverRoot, process.env.CLIENT_DIST ?? '../client/dist'),
  /** Contraseña para entrar en la web mientras es un borrador (vacía = acceso libre). */
  sitePassword: process.env.SITE_PASSWORD ?? '',
  /** Pide a los buscadores que no indexen la web (demostraciones). */
  noindex: process.env.NOINDEX === 'true' || Boolean(process.env.SITE_PASSWORD),
  /** Lectura automática de las fotos de la agenda con Claude (opcional). */
  anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  },
};
