import { useRef, useState } from 'react';
import { assetUrl } from '../lib/api';
import { resizeToSquare } from '../lib/image';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';

/** Foto de perfil o, si no hay, las iniciales. `src` puede ser ruta de la API o data URL. */
export function Avatar({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const url = src && !broken ? (src.startsWith('data:') ? src : assetUrl(src)) : null;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {url ? <img src={url} alt="" onError={() => setBroken(true)} /> : initials(name)}
    </span>
  );
}

/**
 * Selector de foto de perfil.
 * value: data URL nueva · null: sin foto · undefined: sin cambios (se muestra `current`).
 */
export function AvatarInput({ name, current, value, onChange }: {
  name: string; current?: string | null; value: string | null | undefined; onChange: (v: string | null | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = value === undefined ? current : value;

  const pick = async (file?: File) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      onChange(await resizeToSquare(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ''; // permite volver a elegir la misma foto
    }
  };

  return (
    <div className="avatar-input">
      <Avatar name={name || '?'} src={shown} size={72} />
      <div>
        <div className="actions">
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Procesando…' : shown ? 'Cambiar foto' : 'Añadir foto de perfil'}
          </button>
          {shown && <button type="button" className="btn btn-sm" onClick={() => onChange(current ? null : undefined)}>Quitar</button>}
        </div>
        <p className="muted small">Opcional. JPG, PNG o WebP; se recorta en cuadrado.</p>
        {error && <p className="error-text small">{error}</p>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}
