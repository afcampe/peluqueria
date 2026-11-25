#!/bin/bash
# Publica: compila, pasa los tests, commit, push y espera a que Railway lo despliegue.
#   publicar.sh "mensaje del commit"     publicar.sh --comprobar (solo mira el despliegue)
# Solo cuando el usuario haya dicho que sí. Las claves de la demo están en herramientas/.env (no se sube a git).
set -e
cd "$(dirname "$0")/.."
[ -f herramientas/.env ] && . herramientas/.env
npm run build 2>&1 | grep -iE 'error|✓ built'
if [ "$1" != "--comprobar" ]; then
  [ -n "$1" ] || { echo "falta el mensaje"; exit 1; }
  npm test >/tmp/peluqueria-tests.log 2>&1 || { grep -E 'FAIL|Assert|Tests|❯' /tmp/peluqueria-tests.log | head -30; echo "TESTS FALLAN: no se publica"; exit 1; }
  grep -E 'Tests ' /tmp/peluqueria-tests.log
  git add -A
  git commit -qm "$1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push -q
  git log --oneline -1
fi
J=$(ls client/dist/assets | grep '^index.*js$')
for _ in $(seq 50); do
  if curl -s -u "$DEMO_USUARIO:$DEMO_CLAVE" "$DEMO_URL/" | grep -q "$J"; then echo "desplegado · $(curl -s "$DEMO_URL/api/health")"; exit 0; fi
  sleep 6
done
echo "el despliegue no ha llegado en 5 min: revisar Railway"; exit 1
