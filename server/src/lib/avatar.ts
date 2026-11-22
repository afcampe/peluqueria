import { z } from 'zod';
import { badRequest } from './errors.js';

const MAX_BYTES = 300 * 1024;

/** Detecta el formato por la cabecera del fichero, sin fiarse del tipo declarado. */
function sniffMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Acepta un data URL ("data:image/jpeg;base64,...") y devuelve los bytes validados. */
export function parseAvatar(dataUrl: string) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('La imagen de perfil no es válida');
  const buffer = Buffer.from(m[1], 'base64');
  if (buffer.length > MAX_BYTES) throw badRequest('La imagen de perfil es demasiado grande (máx. 300 KB)');
  const mime = sniffMime(buffer);
  if (!mime) throw badRequest('Formato de imagen no admitido. Usa JPG, PNG o WebP.');
  return { avatar: buffer, avatarMime: mime, avatarUpdatedAt: new Date() };
}

/** Campo opcional: string = nueva foto, null = quitar foto, ausente = no tocar. */
export const avatarField = z.string().max(500_000).nullable().optional();

export function avatarData(value: string | null | undefined) {
  if (value === undefined) return {};
  if (value === null) return { avatar: null, avatarMime: null, avatarUpdatedAt: null };
  return parseAvatar(value);
}
