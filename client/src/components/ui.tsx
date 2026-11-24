import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import type { Owner } from '../lib/types';

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ title, onClose, children, size }: { title: string; onClose: () => void; children: ReactNode; size?: 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Con ventanas apiladas (p. ej. ticket sobre cita), Escape cierra solo la de arriba.
    const onKey = (e: KeyboardEvent) => {
      const all = document.querySelectorAll('.modal-backdrop');
      if (e.key === 'Escape' && all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${size ? `modal-${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- Confirmación
// Ventana de confirmación propia de la app (en lugar del confirm() del navegador).

interface ConfirmOptions { title: string; message: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let showConfirm: ((p: Pending) => void) | null = null;

/** Muestra la ventana y resuelve true si se acepta, false si se cancela o se cierra. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!showConfirm) { resolve(window.confirm(typeof opts.message === 'string' ? opts.message : opts.title)); return; }
    showConfirm({ ...opts, resolve });
  });
}

/** Se monta una vez en la app; pinta la ventana cuando se pide una confirmación. */
export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { showConfirm = setP; return () => { showConfirm = null; }; }, []);
  useEffect(() => { if (p) okRef.current?.focus(); }, [p]);
  if (!p) return null;
  const close = (ok: boolean) => { p.resolve(ok); setP(null); };
  return (
    <Modal title={p.title} onClose={() => close(false)}>
      <div className="confirm-body">{p.message}</div>
      <div className="confirm-actions">
        <button type="button" className="btn" onClick={() => close(false)}>{p.cancelLabel ?? 'Cancelar'}</button>
        <button type="button" ref={okRef} className={`btn ${p.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>{p.confirmLabel ?? 'Aceptar'}</button>
      </div>
    </Modal>
  );
}

export const Badge = ({ status, children }: { status: string; children: ReactNode }) => (
  <span className={`badge badge-${status.toLowerCase()}`}>{children}</span>
);

export const Spinner = () => <div className="spinner" aria-label="Cargando" />;

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Error inesperado');

/** Enlaces a la ficha de los clientes que ocupan una hora (solo admin). */
export const OwnerLinks = ({ owners }: { owners: Owner[] }) => (
  <>
    {owners.map((o, i) => (
      <span key={o.appointmentId}>{i > 0 && ', '}<Link to={`/admin/usuarios/${o.clientId}`}>{o.clientName}</Link></span>
    ))}
  </>
);

/** Muestra un error. Si es una hora ocupada y el servidor indica por quién, enlaza a su ficha. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const owners = error instanceof ApiError ? error.details?.bookedBy : undefined;
  if (owners?.length) {
    const prefix = error instanceof Error ? error.message.replace(/reservada para .*$/, 'reservada para ') : '';
    return <Alert>{prefix}<OwnerLinks owners={owners} />.</Alert>;
  }
  return <Alert>{errMsg(error)}</Alert>;
}
