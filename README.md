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

**Administración** (`/admin`). Los administradores no reservan citas propias: no ven *Reservar* ni *Mis citas* y crean las citas de los clientes desde la Agenda.
- **Agenda**: ver citas por día o por rango, crear una cita para un cliente, cambiar la hora, cancelar en cualquier momento (con o sin reembolso, y avisando o no al cliente), reembolsos totales o parciales, marcar como realizada o como "no vino", y botón de WhatsApp
- **Usuarios**: alta como usuario normal o administrador, edición, bloqueo (temporal hasta una fecha o indefinido, con opción de cancelar sus citas), desbloqueo, baja (se conserva el historial) y reactivación
- **Cierres**: vacaciones o festivos (días enteros o por horas). Bloquean las reservas y pueden cancelar y reembolsar las citas afectadas
- **Avisos email**: envío a todos los clientes que aceptan emails, a los clientes con cita un día concreto o a clientes elegidos. Incluye plantillas, `{nombre}` personalizado e historial
- **WhatsApp**: enlaces `wa.me` con el mensaje ya escrito para cada cliente (funciona sin configurar nada). Opcionalmente, envío automático con la API de WhatsApp Business
- **Agenda**: también se pueden crear citas periódicas para un cliente y cancelar una cita junto con las siguientes de su serie
- **Configuración**: activar o desactivar las citas periódicas, máximo de citas por serie (60 por defecto), duración de las citas (30 min por defecto), horario semanal por tramos (9–13 y 16–20 por defecto, de lunes a sábado), días máximos de antelación, antelación mínima para cancelar, número de sillones, formas de pago, servicios y precios

Si cambias la duración de las citas o el horario, las citas ya reservadas se mantienen y nunca se solapan con las nuevas.

## Configuración (`server/.env`)

| Qué | Variables | Dónde conseguirlo |
|---|---|---|
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE` | developer.paypal.com → Apps & Credentials. Usa `sandbox` para pruebas y `live` en producción |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Tu proveedor de correo (Gmail con contraseña de aplicación, Brevo, SES…). Sin esto, los emails solo se muestran en la consola |
| WhatsApp API (opcional) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers → WhatsApp Business. Meta solo permite texto libre si el cliente escribió en las últimas 24 h; fuera de esa ventana exige plantillas aprobadas |

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
