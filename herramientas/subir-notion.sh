#!/bin/bash
# Sube un PDF a Notion con los datos de notion-create-file-upload (el token entero, con el = final si lo lleva).
#   subir-notion.sh <upload_url> '<authorization, con o sin Bearer>' <archivo.pdf>
curl -s -X POST "$1" -H "authorization: Bearer ${2#Bearer }" -F "file=@$3;type=application/pdf" | grep -oE '"(status|message|suggested_markdown)":"[^}]*' | head -3
