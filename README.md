# Peluquería Armando

App de reservas de citas: **web**, **escritorio** (Mac y Windows, con Electron) y **móvil** (Android e iOS, con Capacitor), todo con el mismo código.

```
peluqueria/
├── server/    API (Node + Express + Prisma). Reglas de negocio, pagos, emails, WhatsApp
├── client/    Web (React + Vite). Capacitor la empaqueta como app Android/iOS
└── desktop/   Electron: empaqueta la web como app de Mac/Windows
```

## Puesta en marcha (desarrollo)

Requisitos: Node 20 o superior.

```bash
npm install
npm run db:setup     # crea la base de datos, el admin y servicios de ejemplo
npm run dev          # API en :4000 y web en http://localhost:5173
```

Administrador inicial: `admin@peluqueriaarmando.es` / `admin1234`. Cámbiala en *Mi perfil* (o define `ADMIN_EMAIL`/`ADMIN_PASSWORD` en `server/.env` antes del `db:setup`).

Tests: `npm test`. Cubren los huecos, el horario, el cambio de hora, la regla de 1 h, PayPal con reembolsos, los bloqueos, las bajas y los cierres.

## Funcionalidades

**Clientes**
- Registro e inicio de sesión, con foto de perfil opcional (se puede cambiar o quitar en *Mi perfil*)
- Reserva: servicio → día y hora → forma de pago (PayPal o en el local)
- Se puede reservar hasta 1 año vista
- **Citas periódicas**: reservar varias de una vez cada X días (1 semana, 15 días, 4 semanas o cualquier número), hasta una fecha o un número de citas. Antes de confirmar se ven todas las fechas. Si alguna cae en día cerrado u ocupado, se propone el hueco libre más cercano, y cada fecha se puede cambiar o quitar. Se reservan todas o ninguna, se pagan en un solo pago (PayPal) o en el local, y luego se pueden cancelar una a una (con reembolso de su parte) o todas a la vez
- Mis citas: cambiar la hora o cancelar. No se puede hacer con menos de 1 h de antelación
- Si la cita estaba pagada por PayPal, al cancelarla se reembolsa automáticamente
- Al pagar online se genera el **ticket de compra** y la cita aparece como pagada, con un botón para descargar el PDF (también en el historial)

**Administración** (`/admin`). Los administradores no reservan citas propias: no ven *Reservar* ni *Mis citas* y crean las citas de los clientes desde la Agenda.
- **Agenda** con tres vistas: **Lista** (por día o rango), **Semana** (una columna por día y una fila por franja horaria, con las citas en su hueco; al pulsar una se abren sus opciones) y **Mes** (cada día muestra cuántas citas tiene y cuántas faltan por cobrar; al pulsar un día aparecen sus citas debajo). En todas: ver citas (con el estado de pago de cada una), ver en las horas ocupadas para qué cliente están (con enlace a su ficha), marcar como cobradas las citas en efectivo, crear una cita para un cliente, cambiar la hora, cancelar en cualquier momento (con o sin reembolso, y avisando o no al cliente), reembolsos totales o parciales, marcar como realizada o como "no vino", y botón de WhatsApp
- **Usuarios**: ficha de cada cliente con todas sus citas (próximas y pasadas en colores distintos, estado de pago y método), alta como usuario normal o administrador, edición, bloqueo (temporal hasta una fecha o indefinido, con opción de cancelar sus citas), desbloqueo, baja (se conserva el historial) y reactivación
- **Cierres**: vacaciones o festivos (días enteros o por horas). Bloquean las reservas y pueden cancelar y reembolsar las citas afectadas
- **Avisos email**: envío a todos los clientes que aceptan emails, a los clientes con cita un día concreto o a clientes elegidos. Incluye plantillas, `{nombre}` personalizado e historial
- **WhatsApp**: enlaces `wa.me` con el mensaje ya escrito para cada cliente (funciona sin configurar nada). Opcionalmente, envío automático con la API de WhatsApp Business
- **Agenda**: también se pueden crear citas periódicas para un cliente y cancelar una cita junto con las siguientes de su serie
- **Tickets de compra**: al marcar como cobrada una cita en efectivo se puede generar su ticket en el momento, o más tarde con *Generar ticket*. Los pagos online lo generan solos (una serie pagada de una vez lleva un único ticket con todas las citas). Numeración `AAAA-NNNN` consecutiva y común a todas las formas de pago, que empieza en 0001 cada año. Una vez emitido, el cobro ya no se puede deshacer. Los PDF se guardan en disco en `server/storage/tickets/AAAA/MM/` (no en la base de datos); si faltara alguno se regenera al descargarlo
- **Configuración**: datos fiscales del ticket (razón social, NIF, IVA incluido y texto al pie), activar o desactivar las citas periódicas, máximo de citas por serie (60 por defecto), duración de las citas (30 min por defecto), horario semanal por tramos (9–13 y 16–20 por defecto, de lunes a sábado), días máximos de antelación, antelación mínima para cancelar, número de sillones, formas de pago, servicios y precios

Si cambias la duración de las citas o el horario, las citas ya reservadas se mantienen y nunca se solapan con las nuevas.

## Diseño

- **Estilo** de barbería de caballeros: blanco y negro con un acento dorado. Títulos en Oswald (mayúsculas estrechas) y texto en Inter. Las tipografías van incluidas en la app, así que funcionan sin conexión.
- **Dos temas**, claro (blanco) y oscuro (negro). Se cambian con el botón ☀/☾ de la cabecera o en *Mi perfil → Apariencia*, donde también está la opción "Automático", que sigue al dispositivo. La elección se guarda en cada dispositivo. Los colores de cada tema están al principio de `client/src/styles.css`.
- **Fotos** en `client/src/assets/photos/`: son de Unsplash, con licencia gratuita de uso comercial (ver `CREDITOS.md`). Para usar fotos del propio local, sustituye esos archivos manteniendo el nombre. Los iconos y el logotipo son SVG propios (`client/src/components/icons.tsx`).

## Configuración (`server/.env`)

| Qué | Variables | Dónde conseguirlo |
|---|---|---|
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE` | developer.paypal.com → Apps & Credentials. Usa `sandbox` para pruebas y `live` en producción |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Tu proveedor de correo (Gmail con contraseña de aplicación, Brevo, SES…). Sin esto, los emails solo se muestran en la consola |
| WhatsApp API (opcional) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers → WhatsApp Business. Meta solo permite texto libre si el cliente escribió en las últimas 24 h; fuera de esa ventana exige plantillas aprobadas |

Los tickets se guardan en `TICKETS_DIR` (por defecto `server/storage/tickets`). En producción esa carpeta debe estar en un disco persistente y entrar en las copias de seguridad.

Mientras no estén las credenciales de PayPal, la opción no aparece y solo se puede pagar en el local.

## Añadir nuevas formas de pago

1. Crea `server/src/payments/<nombre>.ts` implementando `PaymentProvider` (ver `types.ts`; `paypal.ts` sirve de ejemplo).
2. Regístralo en `server/src/payments/registry.ts`.
3. Si necesita botones propios en la web, añade su componente en `client/src/pages/Book.tsx`, igual que `PayPalCheckout`.
4. Actívalo en *Admin → Configuración → Formas de pago*.

Las reservas, cancelaciones y reembolsos ya funcionan con cualquier proveedor que cumpla la interfaz.

## Producción

1. **Base de datos**: en `server/prisma/schema.prisma` cambia `provider = "sqlite"` por `"postgresql"` y pon la URL en `DATABASE_URL`.
2. **API**: `npm run build && npm start --workspace server` en un servidor con HTTPS (Railway, Render, un VPS…). Añade los orígenes de la web a `CORS_ORIGINS`.
3. **Web**: en `client/.env` pon `VITE_API_URL=https://tu-api`, ejecuta `npm run build --workspace client` y publica `client/dist` (Netlify, Vercel, el mismo servidor…).

## App móvil (Android / iOS)

Requiere Android Studio (Android) y Xcode en un Mac (iOS). `VITE_API_URL` tiene que apuntar a la API pública, no a localhost.

```bash
cd client
npx cap add android     # solo la primera vez
npx cap add ios         # solo la primera vez
npm run cap:android     # compila, sincroniza y abre Android Studio
npm run cap:ios         # compila, sincroniza y abre Xcode
```

Desde Android Studio o Xcode se genera la app para Google Play o App Store.

**Permisos para la foto de perfil.** Tras `npx cap add ios`, añade en `client/ios/App/App/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Para hacer tu foto de perfil</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Para elegir tu foto de perfil</string>
```

Sin la primera clave, iOS cierra la app si el usuario elige "Hacer foto". En Android la galería funciona sin cambios. Para ofrecer también la cámara, añade `<uses-permission android:name="android.permission.CAMERA" />` en `client/android/app/src/main/AndroidManifest.xml`.

## App de escritorio (Mac / Windows)

```bash
npm run desktop          # prueba en local (usa client/dist)
npm run desktop:dist     # genera .dmg (Mac) y .exe (Windows) en desktop/release/
```

Con `APP_URL=https://tu-web` la app carga la web publicada en vez de la copia local. Así las actualizaciones llegan sin reinstalar y PayPal funciona igual que en el navegador.

Nota: para firmar las apps (y evitar avisos de "desarrollador no identificado") hace falta una cuenta de Apple Developer y un certificado de firma de código para Windows.
