#!/bin/bash
# Manuales.
#   manual.sh captura <archivo.jpg> <nombre>   comprime la captura y la pone en docs/manuales/fuente/capturas/<nombre>.jpg (CALIDAD=50)
#   manual.sh pdf administrador|cliente        renumera las figuras, genera el PDF y comprueba los 5 MB de Notion
set -e
cd "$(dirname "$0")/../docs/manuales/fuente"
case "$1" in
  captura) (cd "$OLDPWD" && djpeg "$2") | cjpeg -quality "${CALIDAD:-50}" -optimize > "capturas/$3.jpg"; stat -f '%N %z bytes' "capturas/$3.jpg" ;;
  pdf)
    python3 - "manual-$2.html" <<'P'
import re, sys
s = open(sys.argv[1]).read(); out = []; ch = k = 0
for part in re.split(r'(<section class="chapter"[^>]*>|Figura \d+\.\d+)', s):
    if part.startswith('<section'): ch += 1; k = 0
    elif re.fullmatch(r'Figura \d+\.\d+', part): k += 1; part = f'Figura {ch}.{k}'
    out.append(part)
open(sys.argv[1], 'w').write(''.join(out))
P
    node generar-pdf.mjs "$2"
    P="../Manual-$2-Peluqueria-Armando.pdf"; Z=$(stat -f %z "$P")
    echo "$(pdfinfo "$P" | grep Pages) · $Z bytes"
    [ "$Z" -lt 5242880 ] || { echo "PASA DE 5 MB: recomprime las capturas más grandes (ls -S capturas/*.jpg) con CALIDAD=40"; exit 1; } ;;
  *) sed -n 2,5p "$0"; exit 1 ;;
esac
