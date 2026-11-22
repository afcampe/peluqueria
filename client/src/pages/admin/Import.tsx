import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Modal, Spinner, errMsg } from '../../components/ui';
import { api } from '../../lib/api';
import { contactLine, dateLong, dateShort, localISODate } from '../../lib/format';
import { resizeMax } from '../../lib/image';
import { useSession } from '../../lib/session';
import type { User } from '../../lib/types';

/* Importación de la agenda en papel: se fotografían las páginas, la
   aplicación lee las citas y el administrador las revisa antes de crearlas. */

type Status = 'PENDING' | 'READING' | 'READY' | 'ERROR' | 'IMPORTED';
interface Summary { total: number; included: number; imported: number; failed: number; uncertain: number; dates: string[] }
interface ImportItem extends Summary {
  id: string; createdAt: string; status: Status; fileName: string | null; error: string | null;
  hasImage: boolean; importedCount: number; importedAt: string | null;
}
interface Row {
  key: string; date: string | null; time: string | null; name: string; serviceId: string | null;
  clientId: string | null; include: boolean; uncertain: boolean; crossedOut: boolean; note: string | null;
  result?: { status: 'imported' | 'error'; message?: string; appointmentId?: string };
}
interface Candidate { id: string; name: string; phone: string | null; email: string | null }
interface Detail extends ImportItem { rows: Row[]; candidates: Record<string, Candidate[]>; chosenClients: Candidate[] }

const statusText: Record<Status, string> = {
  PENDING: 'En cola', READING: 'Leyendo…', READY: 'Por revisar', ERROR: 'No se pudo leer', IMPORTED: 'Importada',
};
const statusClass: Record<Status, string> = {
  PENDING: 'pending_payment', READING: 'pending_payment', READY: 'warn', ERROR: 'cancelled', IMPORTED: 'confirmed',
};

/** Igual que en el servidor: sin tildes, en minúsculas y sin signos. */
const normalizeName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const dayLabel = (date: string) => dateShort(`${date}T12:00:00Z`);
const datesLabel = (dates: string[]) =>
  !dates.length ? '—' : dates.length === 1 ? dayLabel(dates[0]) : `${dayLabel(dates[0])} – ${dayLabel(dates.at(-1)!)}`;

// ---------------------------------------------------------------- Listado y subida

export function ImportList() {
  const navigate = useNavigate();
  const [data, setData] = useState<{ readerConfigured: boolean; items: ImportItem[] } | null>(null);
  const [filter, setFilter] = useState<'todo' | 'pendientes' | 'importadas'>('pendientes');
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.get<{ readerConfigured: boolean; items: ImportItem[] }>('/admin/imports').then(setData).catch((e) => setError(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  // Mientras haya fotos en cola o leyéndose, se refresca la lista.
  const busy = data?.items.some((i) => i.status === 'PENDING' || i.status === 'READING');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setError(''); setFlash('');
    const failed: string[] = [];
    setUpload({ done: 0, total: files.length });
    for (const [i, file] of files.entries()) {
      try {
        const image = await resizeMax(file);
        await api.post('/admin/imports', { image, fileName: file.name });
      } catch (err) {
        failed.push(`${file.name}: ${errMsg(err)}`);
      }
      setUpload({ done: i + 1, total: files.length });
      if (i % 3 === 2) load();
    }
    setUpload(null);
    setFlash(`${files.length - failed.length} foto(s) subida(s). Se están leyendo; puedes ir revisando las que estén listas.`);
    if (failed.length) setError(`No se pudieron subir: ${failed.join(' · ')}`);
    load();
  };

  const manual = async () => {
    try {
      const r = await api.post<{ id: string }>('/admin/imports/manual');
      navigate(`/admin/importar/${r.id}`);
    } catch (e) { setError(errMsg(e)); }
  };

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const items = data.items.filter((i) => filter === 'todo' || (filter === 'importadas' ? i.status === 'IMPORTED' : i.status !== 'IMPORTED'));
  const pendingCount = data.items.filter((i) => i.status !== 'IMPORTED').length;
  const importedAppts = data.items.reduce((n, i) => n + i.imported, 0);

  return (
    <div>
      <div className="page-head">
        <h1>Importar agenda en papel</h1>
        <div className="actions">
          <button className="btn" onClick={manual}>Pasar una página a mano</button>
          <button className="btn btn-primary" disabled={!!upload} onClick={() => fileRef.current?.click()}>Subir fotos</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
        </div>
      </div>

      <section className="card import-help">
        <ol>
          <li><strong>Fotografía las páginas</strong> de la agenda con citas de hoy en adelante: una foto por página (o por las dos páginas abiertas), recta y con buena luz.</li>
          <li><strong>Súbelas</strong> todas de una vez. La aplicación lee la fecha de cada página y, en cada hora, el nombre apuntado.</li>
          <li><strong>Revisa cada página</strong> comparando con la foto: corrige lo que esté mal (lo dudoso sale en amarillo) y pulsa <em>Importar</em>.</li>
        </ol>
        <p className="muted small">Los clientes que no estén registrados se guardan como <strong>fichas sin cuenta</strong> (solo nombre). Si más adelante se registran, únelos desde su ficha con «Unir con un cliente registrado». Las citas pasadas y las tachadas no se importan. La foto se borra al terminar de importar la página.</p>
      </section>

      {!data.readerConfigured && (
        <Alert kind="info">La lectura automática no está configurada (falta <code>ANTHROPIC_API_KEY</code> en <code>server/.env</code>). Puedes subir las fotos igualmente y pasar las citas a mano mirando la foto.</Alert>
      )}
      {upload && <Alert kind="info">Subiendo foto {Math.min(upload.done + 1, upload.total)} de {upload.total}…</Alert>}
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>

      <div className="page-head">
        <h2>Páginas</h2>
        <div className="chips" role="group" aria-label="Filtrar páginas">
          {([['pendientes', `Por terminar (${pendingCount})`], ['importadas', `Importadas (${data.items.length - pendingCount})`], ['todo', `Todas (${data.items.length})`]] as const).map(([k, label]) => (
            <button key={k} type="button" className={`chip ${filter === k ? 'selected' : ''}`} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      {importedAppts > 0 && <p className="muted small">{importedAppts} cita(s) importadas en total.</p>}

      {items.length === 0 ? <p className="empty">{data.items.length ? 'No hay páginas en este filtro.' : 'Aún no has subido ninguna foto.'}</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Página</th><th>Días</th><th>Estado</th><th>Citas</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><div>{i.fileName ?? 'Foto'}</div><div className="muted small">subida {dateLong(i.createdAt)}</div></td>
                  <td>{datesLabel(i.dates)}</td>
                  <td>
                    <span className={`badge badge-${statusClass[i.status]}`}>{statusText[i.status]}</span>
                    {i.status === 'ERROR' && i.error && <div className="muted small">{i.error}</div>}
                  </td>
                  <td>
                    {i.status === 'IMPORTED' ? `${i.imported} importada(s)` : i.total ? `${i.included} de ${i.total} para importar` : '—'}
                    {i.status !== 'IMPORTED' && i.imported > 0 && <div className="muted small">{i.imported} ya importada(s)</div>}
                    {i.uncertain > 0 && i.status !== 'IMPORTED' && <div className="small warn-text">{i.uncertain} dudosa(s)</div>}
                    {i.failed > 0 && <div className="small err-text">{i.failed} con error</div>}
                  </td>
                  <td className="actions">
                    {(i.status === 'READY' || i.status === 'ERROR' || i.status === 'IMPORTED') && (
                      <Link className={`btn btn-sm ${i.status === 'READY' ? 'btn-primary' : ''}`} to={`/admin/importar/${i.id}`}>{i.status === 'IMPORTED' ? 'Ver' : 'Revisar'}</Link>
                    )}
                    {i.status === 'ERROR' && i.hasImage && (
                      <button className="btn btn-sm" onClick={() => api.post(`/admin/imports/${i.id}/retry`).then(load).catch((e) => setError(errMsg(e)))}>Volver a leer</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Revisión de una página

export function ImportReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { config } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [picking, setPicking] = useState<Row | null>(null);
  const [extraClients, setExtraClients] = useState<Candidate[]>([]);

  const apply = (d: Detail) => { setDetail(d); setRows(d.rows); setDirty(false); };
  const load = useCallback(() => api.get<Detail>(`/admin/imports/${id}`).then(apply).catch((e) => setError(errMsg(e))), [id]);
  useEffect(() => { setDetail(null); setFlash(''); setError(''); load(); }, [load]);
  // La foto se pide con el token y se muestra desde memoria.
  useEffect(() => {
    if (!detail?.hasImage) { setImage(null); return; }
    let url: string | null = null;
    api.blob(`/admin/imports/${detail.id}/image`).then((b) => { url = URL.createObjectURL(b); setImage(url); }).catch(() => setImage(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [detail?.id, detail?.hasImage]);
  // Mientras se lee la foto, se espera.
  useEffect(() => {
    if (detail?.status !== 'PENDING' && detail?.status !== 'READING') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [detail?.status, load]);

  const services = config?.services ?? [];
  const today = localISODate();
  const clientsById = useMemo(() => {
    const m = new Map<string, Candidate>();
    for (const list of Object.values(detail?.candidates ?? {})) for (const c of list) m.set(c.id, c);
    for (const c of [...(detail?.chosenClients ?? []), ...extraClients]) m.set(c.id, c);
    return m;
  }, [detail, extraClients]);

  if (!detail) return error ? <Alert>{error}</Alert> : <Spinner />;
  const reading = detail.status === 'PENDING' || detail.status === 'READING';
  const done = detail.status === 'IMPORTED';

  const update = (key: string, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); };
  const remove = (key: string) => { setRows((rs) => rs.filter((r) => r.key !== key)); setDirty(true); };
  const addRow = () => {
    const last = rows.at(-1);
    setRows((rs) => [...rs, {
      key: crypto.randomUUID(), date: last?.date ?? today, time: null, name: '', serviceId: last?.serviceId ?? services[0]?.id ?? null,
      clientId: null, include: true, uncertain: false, crossedOut: false, note: null,
    }]);
    setDirty(true);
  };
  const editable = (r: Row) => r.result?.status !== 'imported' && !done;
  const problems = (r: Row): string[] => {
    const p: string[] = [];
    if (!r.date) p.push('falta la fecha');
    else if (r.date < today) p.push('fecha pasada');
    if (!r.time) p.push('falta la hora');
    if (!r.name.trim()) p.push('falta el nombre');
    if (!r.serviceId) p.push('falta el servicio');
    return p;
  };
  const toImport = rows.filter((r) => r.include && r.result?.status !== 'imported');

  const save = async () => {
    setBusy(true); setError('');
    try { apply(await api.put<Detail>(`/admin/imports/${detail.id}`, { rows })); setFlash('Cambios guardados.'); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const commit = async () => {
    setBusy(true); setError(''); setFlash('');
    try {
      const r = await api.post<{ imported: number; failed: number; done: boolean; detail: Detail }>(`/admin/imports/${detail.id}/commit`, { rows });
      apply(r.detail);
      if (r.done) setFlash(`Página importada: ${r.detail.imported} cita(s) en la agenda. La foto se ha borrado.`);
      else setError(`${r.failed} cita(s) no se han podido importar. Corrige las marcadas en rojo y vuelve a pulsar Importar.`);
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const discard = async () => {
    if (!confirm('¿Descartar esta página? Se borra la foto y lo leído (las citas ya importadas se quedan en la agenda).')) return;
    try { await api.del(`/admin/imports/${detail.id}`); navigate('/admin/importar'); } catch (e) { setError(errMsg(e)); }
  };
  const next = async () => {
    const list = await api.get<{ items: ImportItem[] }>('/admin/imports');
    const n = list.items.filter((i) => i.status === 'READY' && i.id !== detail.id).sort((a, b) => (a.dates[0] ?? '9').localeCompare(b.dates[0] ?? '9'))[0];
    navigate(n ? `/admin/importar/${n.id}` : '/admin/importar');
  };

  const clientOptions = (r: Row) => {
    const own = detail.candidates[normalizeName(r.name)] ?? [];
    const list = [...own];
    const chosen = r.clientId ? clientsById.get(r.clientId) : undefined;
    if (chosen && !list.some((c) => c.id === chosen.id)) list.unshift(chosen);
    return list;
  };

  return (
    <div>
      <p><Link to="/admin/importar">← Importar agenda</Link></p>
      <div className="page-head">
        <div>
          <h1>{detail.dates.length ? datesLabel(detail.dates) : 'Página de la agenda'}</h1>
          <p className="muted small">{detail.fileName ?? 'Foto'} · <span className={`badge badge-${statusClass[detail.status]}`}>{statusText[detail.status]}</span></p>
        </div>
        <div className="actions">
          {!done && <button className="btn btn-danger" onClick={discard}>Descartar página</button>}
          <button className="btn" onClick={next}>Siguiente por revisar →</button>
        </div>
      </div>
      <Alert kind="ok">{flash}</Alert>
      <Alert>{error}</Alert>
      {detail.status === 'ERROR' && <Alert>{detail.error ?? 'No se pudo leer la foto.'} Puedes pasar las citas a mano mirando la foto, o volver a intentarlo desde el listado.</Alert>}

      <div className={`import-review ${image ? '' : 'no-image'}`}>
        {image && (
          <figure className={`import-photo ${zoom ? 'zoom' : ''}`}>
            <button type="button" className="photo-btn" onClick={() => setZoom((z) => !z)} title={zoom ? 'Reducir' : 'Ampliar'}>
              <img src={image} alt="Foto de la página de la agenda" />
            </button>
            <figcaption className="muted small">Toca la foto para {zoom ? 'reducirla' : 'ampliarla'} · <a href={image} target="_blank" rel="noreferrer">abrir en grande</a></figcaption>
          </figure>
        )}

        <section className="import-rows">
          {reading ? <div className="empty"><Spinner /> Leyendo la foto… suele tardar menos de un minuto.</div> : (
            <>
              {rows.length === 0 && <p className="empty">{done ? 'Esta página no tenía citas.' : 'No hay citas leídas. Añádelas a mano mirando la foto.'}</p>}
              <div className="import-list">
                {rows.map((r) => {
                  const p = problems(r);
                  const imported = r.result?.status === 'imported';
                  const failed = r.result?.status === 'error';
                  const opts = clientOptions(r);
                  const cls = imported ? 'is-imported' : failed && r.include ? 'is-error' : !r.include ? 'is-skipped' : r.uncertain || p.length ? 'is-doubt' : '';
                  return (
                    <div key={r.key} className={`import-row ${cls}`}>
                      <label className="check include" title="Importar esta cita">
                        <input type="checkbox" checked={r.include} disabled={!editable(r)} onChange={(e) => update(r.key, { include: e.target.checked })} />
                        <span className="sr-only">Importar</span>
                      </label>
                      <label className="f-date">Fecha
                        <input type="date" value={r.date ?? ''} disabled={!editable(r)} onChange={(e) => update(r.key, { date: e.target.value || null, uncertain: false })} />
                        {r.date && <small className="muted">{dayLabel(r.date)}</small>}
                      </label>
                      <label className="f-time">Hora
                        <input type="time" step={300} value={r.time ?? ''} disabled={!editable(r)} onChange={(e) => update(r.key, { time: e.target.value || null, uncertain: false })} />
                      </label>
                      <label className="f-name">Nombre
                        <input value={r.name} disabled={!editable(r)} onChange={(e) => update(r.key, { name: e.target.value, uncertain: false, clientId: null })} />
                      </label>
                      <label className="f-client">Cliente
                        <select value={r.clientId ?? ''} disabled={!editable(r)} onChange={(e) => {
                          if (e.target.value === '__buscar') { setPicking(r); return; }
                          update(r.key, { clientId: e.target.value || null });
                        }}>
                          <option value="">Ficha nueva: {r.name || '…'}</option>
                          {opts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}{c.email ? '' : ' (sin cuenta)'}</option>)}
                          <option value="__buscar">Buscar otro cliente…</option>
                        </select>
                        {!r.clientId && opts.length > 0 && editable(r) && <small className="warn-text">Hay {opts.length} cliente(s) con ese nombre: elige si es uno de ellos</small>}
                      </label>
                      <label className="f-service">Servicio
                        <select value={r.serviceId ?? ''} disabled={!editable(r)} onChange={(e) => update(r.key, { serviceId: e.target.value || null })}>
                          <option value="" disabled>Elige…</option>
                          {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </label>
                      <div className="f-state">
                        {imported && <span className="badge badge-confirmed">{r.result?.message ?? 'Importada'}</span>}
                        {!imported && failed && r.include && <span className="err-text small">{r.result!.message}</span>}
                        {!imported && !failed && r.include && p.length > 0 && <span className="warn-text small">{p.join(', ')}</span>}
                        {!imported && r.include && !p.length && r.uncertain && <span className="warn-text small">Lectura dudosa: compruébala</span>}
                        {r.crossedOut && <span className="muted small">Tachada en la agenda</span>}
                        {!r.include && !imported && !r.crossedOut && <span className="muted small">No se importa{p.length ? ` (${p.join(', ')})` : ''}</span>}
                        {r.note && <span className="muted small">Nota: {r.note}</span>}
                        {editable(r) && <button type="button" className="link small" onClick={() => remove(r.key)}>Quitar</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!done && (
                <div className="import-actions">
                  <button className="btn" onClick={addRow}>+ Añadir cita</button>
                  <span className="grow" />
                  <button className="btn" disabled={!dirty || busy} onClick={save}>Guardar cambios</button>
                  <button className="btn btn-primary" disabled={busy || toImport.length === 0} onClick={commit}>
                    {busy ? 'Importando…' : `Importar ${toImport.length} cita(s)`}
                  </button>
                </div>
              )}
              {done && <p className="muted small">Página importada{detail.importedAt ? ` el ${dateLong(detail.importedAt)}` : ''}. Las citas ya están en la agenda.</p>}
            </>
          )}
        </section>
      </div>

      {picking && (
        <ClientSearch
          initial={picking.name}
          onClose={() => setPicking(null)}
          onPick={(u) => {
            setExtraClients((xs) => [...xs, { id: u.id, name: u.name, phone: u.phone, email: u.email }]);
            // Se asigna a todas las filas de esta página con el mismo nombre.
            const n = normalizeName(picking.name);
            setRows((rs) => rs.map((r) => (normalizeName(r.name) === n && editable(r) ? { ...r, clientId: u.id } : r)));
            setDirty(true);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function ClientSearch({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (u: User) => void }) {
  const [q, setQ] = useState(initial.split(' ')[0] ?? '');
  const [list, setList] = useState<User[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<User[]>(`/admin/users?role=CLIENT&q=${encodeURIComponent(q)}`).then((r) => setList(r.filter((u) => u.status !== 'DELETED'))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Modal title="Buscar cliente" onClose={onClose}>
      <label>Buscar<input autoFocus placeholder="Nombre, email o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <ul className="pick-list">
        {list.map((u) => (
          <li key={u.id}><button className="link" onClick={() => onPick(u)}>{u.name} <small className="muted">{contactLine(u)}{!u.hasAccount && ' · sin cuenta'}</small></button></li>
        ))}
        {list.length === 0 && <li className="muted small">No hay clientes que coincidan.</li>}
      </ul>
    </Modal>
  );
}
