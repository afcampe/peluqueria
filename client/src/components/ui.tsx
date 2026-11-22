import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import type { Owner } from '../lib/types';

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
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
