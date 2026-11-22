const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

// Si se define APP_URL, la app de escritorio carga la web publicada
// (recomendado para que PayPal funcione igual que en el navegador).
// Si no, carga la copia local de la web (carpeta app/, generada desde client/dist).
const APP_URL = process.env.APP_URL;

// Ventanas que sí se abren dentro de la app (pago con PayPal).
const inAppHosts = [/(^|\.)paypal\.com$/, /(^|\.)paypalobjects\.com$/];

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    title: 'Peluquería Armando',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (inAppHosts.some((re) => re.test(new URL(url).hostname))) return { action: 'allow' };
    } catch { /* URL no válida */ }
    shell.openExternal(url); // WhatsApp, enlaces externos...
    return { action: 'deny' };
  });

  if (APP_URL) win.loadURL(APP_URL);
  else win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
