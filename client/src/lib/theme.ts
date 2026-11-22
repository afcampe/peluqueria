import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'pa_theme';

const readPref = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

const systemTheme = () => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** Aplica el tema al documento (también lo usa el script inicial de index.html). */
export function applyTheme(pref: ThemePref) {
  const theme = pref === 'system' ? systemTheme() : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
  return theme;
}

/** Tema elegido por el usuario (claro, oscuro o el del sistema), guardado en este dispositivo. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (pref === 'system' ? systemTheme() : pref));

  useEffect(() => {
    setTheme(applyTheme(pref));
    if (pref !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(applyTheme('system'));
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch { /* sin almacenamiento: se aplica solo en esta sesión */ }
    setPrefState(p);
    window.dispatchEvent(new CustomEvent('pa-theme', { detail: p }));
  }, []);

  // Mantener sincronizados el botón de la cabecera y el selector del perfil.
  useEffect(() => {
    const onExternal = (e: Event) => setPrefState((e as CustomEvent<ThemePref>).detail);
    window.addEventListener('pa-theme', onExternal);
    return () => window.removeEventListener('pa-theme', onExternal);
  }, []);

  const toggle = () => setPref(theme === 'dark' ? 'light' : 'dark');
  return { pref, theme, setPref, toggle };
}
