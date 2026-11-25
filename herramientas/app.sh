#!/bin/bash
# App de ejemplo en http://localhost:4557 con datos ficticios en .ejemplo/ (no toca la base de desarrollo ni la demo).
#   app.sh start   compila y arranca (crea los datos si no existen)
#   app.sh stop    la para
#   app.sh reset   borra los datos y arranca de nuevo
# ZONA=America/Los_Angeles app.sh reset → si es de noche, para que "hoy" esté a media jornada.
set -e
cd "$(dirname "$0")/.."
D="$PWD/.ejemplo"
parar() { P=$(lsof -ti tcp:4557 -sTCP:LISTEN || true); if [ -n "$P" ]; then kill $P; sleep 1; fi; }
case "$1" in
  stop) parar; echo parada; exit 0 ;;
  reset) parar; rm -rf "$D" ;;
  start) parar ;;
  *) sed -n 2,7p "$0"; exit 1 ;;
esac
mkdir -p "$D/tickets" "$D/importar"
npm run build 2>&1 | grep -iE 'error|✓ built' || true
export DATABASE_URL="file:$D/ejemplo.db" TICKETS_DIR="$D/tickets" IMPORT_DIR="$D/importar" PORT=4557 JWT_SECRET=ejemplo \
  ADMIN_EMAIL=admin@peluqueriaarmando.es ADMIN_PASSWORD=admin1234 PUBLIC_URL=http://localhost:4557 DEMO_DATA=true \
  SMTP_HOST= WHATSAPP_TOKEN= WHATSAPP_PHONE_NUMBER_ID= ANTHROPIC_API_KEY= SITE_PASSWORD= PAYPAL_CLIENT_ID=demo PAYPAL_CLIENT_SECRET=demo
cd server
npx prisma db push --skip-generate >"$D/app.log" 2>&1
node dist/seed.js >>"$D/app.log" 2>&1
[ -n "$ZONA" ] && node ../herramientas/ejemplo.mjs zona
node dist/demo.js >>"$D/app.log" 2>&1
node ../herramientas/ejemplo.mjs
DEMO_DATA=false nohup node dist/index.js >>"$D/app.log" 2>&1 &
for _ in $(seq 60); do curl -s -o /dev/null localhost:4557/api/health && echo "lista en http://localhost:4557" && exit 0; sleep .5; done
echo "no arranca:"; tail -20 "$D/app.log"; exit 1
