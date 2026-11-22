import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Alert, Badge, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { dateShort, localISODate } from '../../lib/format';
import type { User } from '../../lib/types';

interface Row { client: User; total: number; cancelledByClient: number; cancelledByShop: number; noShow: number; lastIncidentAt: string | null }
type Period = 'year' | '12m' | 'all' | 'custom';
type Sort = 'noShow' | 'cancelledByClient' | 'cancelledByShop' | 'rate';
const statusText = { ACTIVE: 'Activo', BLOCKED: 'Bloqueado', DELETED: 'De baja' };

/** Histórico de citas anuladas y ausencias por cliente. */
export function Incidents() {
  const today = localISODate();
  const [period, setPeriod] = useState<Period>('year');
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [sort, setSort] = useState<Sort>('noShow');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  const range = period === 'year' ? { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` }
    : period === '12m' ? { from: localISODate(new Date(), -365), to: today }
    : period === 'custom' ? { from, to } : {};

  useEffect(() => {
    setRows(null);
    api.get<Row[]>(`/admin/reports/incidents?${new URLSearchParams(range as Record<string, string>)}`).then(setRows).catch((e) => setError(e.message));
  }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = (r: Row) => (r.total ? (r.noShow + r.cancelledByClient) / r.total : 0);
  const sorted = [...(rows ?? [])].sort((a, b) => (sort === 'rate' ? rate(b) - rate(a) : b[sort] - a[sort]) || b.noShow - a.noShow);
  const sum = (k: 'noShow' | 'cancelledByClient' | 'cancelledByShop') => (rows ?? []).reduce((n, r) => n + r[k], 0);
  const th = (k: Sort, label: string) => (
    <th className="num"><button type="button" className={`sort ${sort === k ? 'active' : ''}`} onClick={() => setSort(k)}>{label}{sort === k && ' ↓'}</button></th>
  );

  return (
    <div>
      <div className="page-head"><h1>Anulaciones y ausencias</h1></div>
      <p className="muted">Citas anuladas y "no vino" de cada cliente. Las citas nunca se borran, así que el histórico se conserva aunque el cliente se dé de baja.</p>
      <div className="filters">
        <div className="chips" role="group" aria-label="Periodo">
          {([['year', 'Este año'], ['12m', 'Últimos 12 meses'], ['all', 'Todo'], ['custom', 'Fechas']] as const).map(([k, l]) => (
            <button key={k} type="button" className={`chip ${period === k ? 'selected' : ''}`} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
        {period === 'custom' && (
          <>
            <label>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
      </div>
      <Alert>{error}</Alert>
      {!rows && !error && <Spinner />}
      {rows && (
        <>
          <div className="stats">
            <div className="stat"><strong>{sum('noShow')}</strong><span>No vinieron</span></div>
            <div className="stat"><strong>{sum('cancelledByClient')}</strong><span>Anuladas por el cliente</span></div>
            <div className="stat"><strong>{sum('cancelledByShop')}</strong><span>Anuladas por la peluquería</span></div>
            <div className="stat"><strong>{rows.length}</strong><span>Clientes con incidencias</span></div>
          </div>
          {rows.length === 0 ? <p className="empty">No hay anulaciones ni ausencias en este periodo.</p> : (
            <div className="table-wrap">
              <table className="table incidents">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    {th('noShow', 'No vino')}
                    {th('cancelledByClient', 'Anuló él')}
                    {th('cancelledByShop', 'Anuló la peluquería')}
                    {th('rate', '% de sus citas')}
                    <th>Última</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.client.id}>
                      <td>
                        <div className="who">
                          <Avatar name={r.client.name} src={r.client.avatarUrl} size={32} />
                          <div>
                            <Link to={`/admin/usuarios/${r.client.id}?ver=incidencias`}><strong>{r.client.name}</strong></Link>
                            <div className="muted small">{r.client.phone ?? r.client.email}{r.client.status !== 'ACTIVE' && <> · <Badge status={r.client.status}>{statusText[r.client.status]}</Badge></>}</div>
                          </div>
                        </div>
                      </td>
                      <td className={`num ${r.noShow ? 'hot' : ''}`}>{r.noShow}</td>
                      <td className="num">{r.cancelledByClient}</td>
                      <td className="num muted">{r.cancelledByShop}</td>
                      <td className="num">{Math.round(rate(r) * 100)} %<small className="muted"> de {r.total}</small></td>
                      <td className="nowrap">{r.lastIncidentAt ? dateShort(r.lastIncidentAt) : '—'}</td>
                      <td><Link className="btn btn-sm" to={`/admin/usuarios/${r.client.id}?ver=incidencias`}>Ver citas</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">"% de sus citas" cuenta las ausencias y las anulaciones del propio cliente sobre todas sus citas del periodo. No se cuentan los pagos online que no se llegaron a completar.</p>
        </>
      )}
    </div>
  );
}
