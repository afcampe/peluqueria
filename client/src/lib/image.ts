/**
 * Recorta la imagen al centro en cuadrado y la reduce a `size` px en JPEG.
 * Se hace en el dispositivo para que la subida sea ligera (≈20-40 KB)
 * también desde el móvil, donde las fotos de la cámara pesan varios MB.
 */
export async function resizeToSquare(file: File, size = 256, quality = 0.85): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('El archivo no es una imagen');
  if (file.size > 25 * 1024 * 1024) throw new Error('La imagen es demasiado grande');

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con una foto JPG o PNG.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // fondo para PNG transparentes
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
