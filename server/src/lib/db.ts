import { PrismaClient } from '@prisma/client';

// La foto de perfil no se carga por defecto (sería pesado en listados);
// se pide explícitamente con { omit: { avatar: false } } donde haga falta.
export const prisma = new PrismaClient({ omit: { user: { avatar: true } } });
