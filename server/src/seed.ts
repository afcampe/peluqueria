import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { prisma } from './lib/db.js';
import { getSettings, saveSettings } from './services/settings.js';

const email = (process.env.ADMIN_EMAIL ?? 'admin@peluqueriaarmando.es').toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? 'admin1234';

const admin = await prisma.user.findUnique({ where: { email } });
if (!admin) {
  await prisma.user.create({ data: { email, name: 'Armando', role: 'ADMIN', passwordHash: await bcrypt.hash(password, 10) } });
  console.log(`Administrador creado: ${email} / ${password}  (¡cambia la contraseña!)`);
}

if ((await prisma.service.count()) === 0) {
  await prisma.service.createMany({
    data: [
      { name: 'Corte de pelo', priceCents: 1500, sortOrder: 1 },
      { name: 'Corte + barba', priceCents: 2000, sortOrder: 2 },
      { name: 'Arreglo de barba', priceCents: 800, sortOrder: 3 },
      { name: 'Corte infantil', priceCents: 1200, sortOrder: 4 },
    ],
  });
  console.log('Servicios de ejemplo creados');
}

await saveSettings(await getSettings()); // guarda la configuración por defecto
await prisma.$disconnect();
