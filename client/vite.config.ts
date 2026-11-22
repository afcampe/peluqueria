import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Rutas relativas para que el build funcione dentro de Electron (file://) y Capacitor.
  // La web servida por el propio servidor (Railway) usa VITE_BASE=/ para que funcionen las rutas profundas.
  base: process.env.VITE_BASE ?? './',
  server: { port: 5173 },
});
