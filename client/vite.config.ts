import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Rutas relativas para que el build funcione dentro de Electron (file://) y Capacitor.
  base: './',
  server: { port: 5173 },
});
