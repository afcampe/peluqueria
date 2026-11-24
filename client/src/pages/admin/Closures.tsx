import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime, localISODate } from '../../lib/format';

interface Closure { id: string; startAt: string; endAt: string; reason: string | null }

export function Closures() {
  const [list, setList] = useState<Closure[] | null>(null);
  const [f, setF] = useState({ startDate: localISODate(), startTime: '', endDate: localISODate(), endTime: '', reason: '', cancelAppointments: false });
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api.get<Closure[]>('/admin/closures').then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setFlash('');
    try {
      const r = await api.post<{ affected: number; cancelled: number; skippedPaid: number }>('/admin/closures', {
        start: f.startTime ? `${f.startDate}T${f.startTime}` : f.startDate,
        end: f.endTime ? `${f.endDate}T${f.endTime}` : f.endDate,
        reason: f.reason || undefined,
        cancelAppointments: f.cancelAppointments,
      });
      const paidNote = r.skippedPaid ? ` ${r.skippedPaid} cita(s) cobradas en el local siguen activas: cancélalas desde la Agenda.` : '';
      setFlash(r.cancelled || r.skippedPaid
        ? `Cierre creado. ${r.cancelled} cita(s) cancelada(s) y reembolsada(s); los clientes han sido avisados.${paidNote}`
        : r.affected ? `Cierre creado. Atención: hay ${r.affected} cita(s) en ese periodo que siguen activas; revísalas en la Agenda.` : 'Cierre creado.');
      setF({ ...f, reason: '' });
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <h1>Cierres temporales</h1>
      <p className="muted">Vacaciones, festivos o ausencias. Durante un cierre no se pueden reservar citas.</p>
      <form className="card" onSubmit={submit}>
        <Alert kind="ok">{flash}</Alert>
        <Alert>{error}</Alert>
        <div className="row">
          <label>Desde<input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></label>
          <label>Hora (opcional)<input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></label>
          <label>Hasta<input type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          <label>Hora (opcional)<input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></label>
        </div>
        <label>Motivo<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Vacaciones de verano" /></label>
        <label className="check"><input type="checkbox" checked={f.cancelAppointments} onChange={(e) => setF({ ...f, cancelAppointments: e.target.checked })} /> Cancelar las citas existentes en ese periodo, reembolsar y avisar por email</label>
        <button className="btn btn-primary">Crear cierre</button>
      </form>
      {!list && <Spinner />}
      {list?.length === 0 && <p className="empty">No hay cierres programados.</p>}
      <ul className="closure-list">
        {list?.map((c) => (
          <li key={c.id} className="card">
            <div><strong>{dateTime(c.startAt)}</strong> → <strong>{dateTime(c.endAt)}</strong>{c.reason && <div className="muted">{c.reason}</div>}</div>
            <button className="btn btn-sm btn-danger" onClick={async () => { await api.del(`/admin/closures/${c.id}`); load(); }}>Eliminar</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
