'use client';

import { useState } from 'react';
import { Failure, useAdminData } from '@/components/screen';
import { adminAuditResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * AUDIT — the record, including the reading of it.
 *
 * Three things about this table are not obvious from its columns, and all three
 * are stated on the screen rather than only here, because the person who needs
 * them is an auditor reading the page, not a developer reading the source:
 *
 *   1. `actorUserId` IS NULL FOR SYSTEM ACTIONS. A worker expiring a
 *      subscription has no user behind it. Rendered blank that would read as
 *      missing data — a row somebody failed to attribute — so it renders as
 *      "system", which is what it means.
 *
 *   2. `actorRole` IS THE ROLE AT THE TIME OF THE ACTION, denormalised onto the
 *      row on purpose. If it were a live join to `users.role`, promoting or
 *      demoting somebody would silently rewrite what the record says they were
 *      when they acted, and a record that changes retroactively is not a
 *      record.
 *
 *   3. READING THIS PAGE IS ITSELF AUDITED. The request writes an `admin.read`
 *      row against resource `audit` before the response leaves the server, so
 *      the next load shows this visit at the top. That is deliberate: an
 *      operator who could review the trail without appearing in it would have a
 *      blind spot shaped exactly like themselves.
 * =============================================================================
 */

/** `metadata` is identifiers and counts by contract — never PII — so it is safe
 *  to print whole. Compact JSON keeps a row one line high. */
function compact(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
}

function stamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export default function AuditPage() {
  // See the billing screen: keyset cursors only go forward, so "previous" is a
  // stack of the cursors that opened earlier pages. Empty stack is page one.
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [actionFilter, setActionFilter] = useState('');

  const cursor = trail.at(-1);
  const path =
    cursor === undefined
      ? adminPaths.audit
      : `${adminPaths.audit}?cursor=${encodeURIComponent(cursor)}`;

  const { data, error, loading, reload } = useAdminData(path, adminAuditResponseSchema);

  const needle = actionFilter.trim().toLowerCase();
  const rows =
    data === null
      ? []
      : needle === ''
        ? data.items
        : data.items.filter((row) => row.action.toLowerCase().includes(needle));

  const advance = (): void => {
    const next = data?.nextCursor;
    if (next === undefined || next === null) return;
    setTrail((pages) => [...pages, next]);
  };
  const back = (): void => { setTrail((pages) => pages.slice(0, -1)); };

  return (
    <>
      <h2>Audit</h2>
      <p className="sub">
        Newest first. <strong>actorRole</strong> is the role the actor held at the
        moment of the action, copied onto the row rather than joined from{' '}
        <strong>users</strong> — a later promotion or demotion cannot rewrite what
        the record says. <strong>actorUserId</strong> is empty for system actions
        and shows as <span className="muted">system</span>; the worker has no user.
      </p>
      <p className="sub">
        Reading this page is itself audited: the request wrote an{' '}
        <strong>admin.read</strong> row against <strong>audit</strong> attributed
        to you, and reloading will show it. An operator who could review the trail
        without appearing in it would have a blind spot shaped exactly like
        themselves.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <input
          value={actionFilter}
          onChange={(event) => { setActionFilter(event.target.value); }}
          placeholder="filter by action, e.g. admin.revealed"
          aria-label="Filter by action"
          style={{
            font: 'inherit',
            background: 'var(--line)',
            color: 'var(--text)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '4px 8px',
            minWidth: 260,
          }}
        />
        <button type="button" onClick={reload}>Reload</button>
        {/*
          SAYING WHAT THE FILTER CAN AND CANNOT SEE.
          It narrows the rows already fetched, not the table. An auditor hunting
          `admin.revealed` who sees nothing here must not conclude it never
          happened — it may be on the next page. Stating the scope is the
          difference between a filter and a false negative.
        */}
        <span className="muted">
          Narrows the loaded page only, not the whole log — page through to search further.
        </span>
      </div>

      {loading ? <p className="muted">Loading the record…</p> : null}
      {error === null ? null : <Failure error={error} />}

      {/* Only a clean load renders rows. `useAdminData` keeps the last good page
          on failure, and stale rows under a failed refresh would read as a
          complete record when it is not one. */}
      {!loading && error === null && data !== null ? (
        <>
          {rows.length === 0 ? (
            <p className="muted">
              {data.items.length === 0
                ? 'No entries on this page.'
                : `No entry on this page matches ${actionFilter.trim()}. ${String(data.items.length)} loaded rows were searched.`}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Role then</th>
                  <th>Resource</th>
                  <th>Resource id</th>
                  <th>Tenant</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{stamp(row.createdAt)}</td>
                    <td>{row.action}</td>
                    <td>
                      {row.actorUserId === null ? (
                        <span className="muted" title="No user behind this action — a worker or a scheduled job.">
                          system
                        </span>
                      ) : (
                        row.actorUserId
                      )}
                    </td>
                    <td>
                      {row.actorRole === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title="The role at the time of the action, not the current one.">
                          {row.actorRole}
                        </span>
                      )}
                    </td>
                    <td>{row.resourceType}</td>
                    <td>{row.resourceId ?? <span className="muted">—</span>}</td>
                    <td>{row.tenantId ?? <span className="muted">—</span>}</td>
                    <td>{compact(row.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={back} disabled={trail.length === 0}>
              Previous
            </button>
            <button type="button" onClick={advance} disabled={data.nextCursor === null}>
              Next
            </button>
            <span className="muted">
              Page {trail.length + 1} — showing {rows.length} of {data.items.length} loaded
              {data.nextCursor === null ? ', last page' : ''}
            </span>
          </div>
        </>
      ) : null}
    </>
  );
}
