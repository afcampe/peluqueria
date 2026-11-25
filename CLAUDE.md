# Peluquería Armando · app de reservas

Monorepo npm: `server/` (Express 4, Prisma 6 + SQLite, zod, luxon, vitest), `client/` (React 18 + Vite), `desktop/` (Electron). Node 22.
Demo en Railway: cada push a `main` despliega solo. Responder siempre en **español**.

## Cómo trabajar (preferencias del usuario)
- Hacer solo lo pedido. No ampliar el alcance; si algo más conviene, proponerlo al final en una línea.
- **Backup solo si lo pide**: `git tag -a antes-xxx -m "…" && git push origin antes-xxx`.
- Implementar y probar en local → informar → preguntar → **publicar solo cuando diga que sí**. Si pide cambiar o añadir algo, eso no autoriza a publicar.
- Manual y Notion, solo cuando lo pida (o diga "publica con manual y Notion").
- Probar en navegador (ordenador y móvil) y mirar las capturas antes de dar algo por hecho. Decir claramente lo que no se ha podido probar (SMTP, WhatsApp API y PayPal no están configurados; PayPal solo simulado en tests).
- Su email es privado: no enviarlo a servicios externos. No subir `.env` ni claves. Las claves de la demo están en `herramientas/.env` (fuera de git) y en Notion.
- Para ahorrar: leer solo los archivos necesarios, hacer pocas capturas y recortadas (`--el`), no releer Notion entero.

## Herramientas (usar esto en vez de escribirlo de nuevo)
- `herramientas/app.sh start|stop|reset` → app de ejemplo en :4557 con datos ficticios en `.ejemplo/`. `start` también recompila. Si es de noche: `ZONA=America/Los_Angeles herramientas/app.sh reset`.
  Admin `admin@peluqueriaarmando.es`/`admin1234`; clientes `javier0@example.com`…/`cliente1234`. Javier tiene PayPal (ficticio), serie y efectivo.
- `node herramientas/captura.mjs <ruta> <nombre> [--de javier0] [--el '.card'] [--movil] [--oscuro] [--entera] [--clic 'sel|texto']` → `.ejemplo/capturas/`. Para guiones más largos: `import { browser, entrar } from './navegador.mjs'` (go, click, type, ev, shot, close).
- `herramientas/manual.sh captura|pdf`, `herramientas/publicar.sh "mensaje"` (compila, tests, commit, push y espera el despliegue) y `herramientas/subir-notion.sh`.
- Tests: `npm test`. Sin variables SMTP falsas en el entorno (4 tests de recordatorios fallan).

## Mapa
- Citas: `server/src/services/appointments.ts`. Asistencia (enlace email, webhook WhatsApp): `services/attendance.ts`, `routes/attendance.ts`. Recordatorios: `services/reminders.ts`. Tickets y rectificativos: `services/tickets.ts`. Resumen: `services/dashboard.ts`. Lista de espera: `services/waitlist.ts`. Ajustes: `services/settings.ts`. Pagos: `server/src/payments/`. Importar agenda: `services/agendaImport.ts`. Datos de la demo: `src/demo.ts`.
- Rutas: `server/src/routes/{admin,appointments,auth,public,tickets,imports}.ts`. Tests: `server/test/api.test.ts`.
- Web: `client/src/pages/{Book,MyAppointments,Profile}.tsx`, `pages/admin/{Dashboard,Agenda,Users,UserDetail,Settings,Reminders,WhatsApp,Import}.tsx`; modales de cancelar/cobrar/devolver en `Agenda.tsx`; lista de citas de un cliente (`AppointmentHistory`) y ventana «Ver citas» (`AppointmentsModal`) en `UserDetail.tsx`; `components/BookForClient.tsx`, `BlockModal.tsx` (bloquear horas), `MyUpcoming.tsx`, `ui.tsx`; `lib/{format,payment,types,blocks}.ts`; estilos en `styles.css` (tokens y tema oscuro arriba).
- Manuales: `docs/manuales/fuente/*.html` + `capturas/`. El PDF del administrador debe pesar < 5 MB y va justo (≈ 4,99 MB): para añadir capturas, reducir antes otras (`djpeg -scale 7/8 | cjpeg -quality 45`); recomprimir a la misma calidad no ahorra. Figura nueva: `Figura 0.0`, `manual.sh pdf` la numera.

## Reglas de negocio
- Estado interno `CONFIRMED` = **reservada** (ocupa hora). "Confirmada" es aparte: `attendance` YES/NO/null + `attendanceBy`. Lo que se ve sale de `shownStatus()`: Reservada, Confirmada, No asistirá, Realizada (ya terminó), Cancelada, No se presentó.
- Al cambiar la hora se borra la asistencia. "No" no cancela la cita.
- Cita terminada: ni se mueve ni se cancela ni se reembolsa (salvo "No vino" pagada por PayPal). "No vino" y cobrada en el local son incompatibles.
- Cobro en el local es definitivo. Cancelar con PayPal: primero se devuelve; si falla, no se cancela. Cada devolución con ticket emite rectificativo RAAAA-NNNN. El IVA se guarda en cada ticket.
- El cliente cambia o cancela hasta 1 h antes; el admin, siempre que no haya terminado. El cliente nunca ve datos de otros.
- Novedades (email y WhatsApp): casilla sin marcar. Los recordatorios son avisos de servicio.
- Duración de las citas y horario semanal (tramos, apertura y cierre) solo se cambian si no hay ninguna cita (`gridLocked` en `routes/admin.ts`); el usuario no quiere que se puedan cambiar después. Para no atender horas: **Bloquear horas** (Agenda, `POST /admin/blocks`), que son cierres (`Closure`) de un mismo día; solo horas sin cita, todas o ninguna. Días enteros: Cierres.
- En la vista Semana, los puntos de pago (8 px, `#066322`/`#9c0a15`) los ajustó el usuario: no tocarlos.

## Cuidado con
- Esquema Prisma: solo cambios **aditivos** (columnas con null o valor por defecto, tablas nuevas). Nada de `@unique` nuevo en tablas existentes: `db push` falla en el despliegue. Tras cambiarlo: `npx prisma generate` y `npx prisma db push --skip-generate` en `server/`.
- `demo.ts` corre en cada arranque de la demo: todo idempotente y sin pisar lo que el usuario haya tocado allí.
- Rutas `/api` inexistentes devuelven HTML (SPA): no esperar JSON en tests.
- `sips` engorda las imágenes: usar `manual.sh captura` (djpeg/cjpeg).

## Notion
Página principal `42095873265d81e59c51e4eff6285899` (índice) con subpáginas; leer **solo la que haga falta**:
- Portada: estado y copias de seguridad (etiquetas) · Manuales (PDF) `42395873265d81a889a2d88529eb4f0d`
- Funciones clientes `42395873265d81fc8b7acbaf8bd5d4de` · Funciones administración `42395873265d8177936bf248f7b15dc6`
- Demo y accesos `42395873265d819595aded3cce472c7f` · Pendiente `42395873265d8116a07ac6074abe6569`
- Técnica y diseño `42395873265d81faa185e1a9c01c6103` · Problemas Railway/GitHub `42395873265d813a9da7f5c2b0b62a39`
No anotar el último commit en Notion. Los tokens de subida terminan a veces en `=`: copiarlos enteros.
Publicar un PDF: `notion-create-file-upload` → `subir-notion.sh` (caduca pronto) → `update_content` cambiando el `<pdf source="notion-file-block://…" />` por `<pdf source="file-upload://ID" />` en la página Manuales.
