'use client';

import Link from 'next/link';
import { useState } from 'react';
import { adminUsersResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, Masked, useAdminData } from '@/components/screen';

/**
 * =============================================================================
 * USERS — the list, and the only screen here with no way to unmask anything.
 *
 * `emailMasked` arrives already reduced to a first character and a TLD, and is
 * rendered exactly as it arrived. There is deliberately NO reveal control in a
 * list: a control repeated fifty times down a page is a control somebody clicks
 * without deciding to, and every click of it writes an audit row asserting a
 * decision that was never made. Unmasking lives one click deeper, on the detail
 * screen, where it applies to one named person for one stated reason.
 * =============================================================================
 */

/** The server's own default. Sent explicitly so the URL says what it asked for. */
const PAGE_LIMIT = 50;

export default function UsersPage() {
  /*
   * A STACK of cursors, not a single cursor.
   *
   * Keyset pagination is forward-only — `nextCursor` points onward and the wire
   * carries no "previous" — so the only way back is to remember the cursors
   * already spent. Without this an operator four pages in can only start over.
   */
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);

  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor !== undefined) query.set('cursor', cursor);
  /*
   * A plain string, and that matters: `useAdminData` keys its effect on this
   * value, so two renders that produce the same URL must produce the same
   * string. A freshly built object here would refetch on every render forever.
   */
  const path = `${adminPaths.users}?${query.toString()}`;

  const { data, error, loading } = useAdminData(path, adminUsersResponseSchema);
  const nextCursor = data?.nextCursor ?? null;

  return (
    <>
      <h2>Users</h2>
      <p className="sub">
        Every address is masked by the server before it reaches this app. Open a
        user to unmask one, on the record.
      </p>

      {error !== null ? (
        /*
         * Not a table with no rows. "No users" and "the request failed" are
         * different facts, and an empty table quietly states the wrong one.
         */
        <Failure error={error} />
      ) : loading ? (
        <p className="muted">Loading users…</p>
      ) : data === null || data.items.length === 0 ? (
        <p className="muted">No users on this page.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Tenant</th>
              <th>Verified</th>
              <th>Created</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((user) => (
              <tr key={user.id}>
                <td>
                  <Masked>{user.emailMasked}</Masked>
                </td>
                <td>{user.role}</td>
                <td className="muted">{user.tenantId}</td>
                <td className={user.emailVerified ? 'ok' : 'muted'}>
                  {/*
                    Unverified is muted rather than red. It is a normal state for
                    a new account, and colouring it as a fault would train the
                    operator to ignore the colour that does mean one.
                  */}
                  {user.emailVerified ? 'yes' : 'no'}
                </td>
                <td>{user.createdAt}</td>
                <td>
                  <Link href={`/users/${encodeURIComponent(user.id)}`}>open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error === null ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => { setCursors((spent) => spent.slice(0, -1)); }}
            disabled={loading || cursors.length === 0}
          >
            Previous page
          </button>
          <button
            type="button"
            onClick={() => {
              if (nextCursor !== null) setCursors((spent) => [...spent, nextCursor]);
            }}
            disabled={loading || nextCursor === null}
          >
            Next page
          </button>
          <span className="muted">
            Page {cursors.length + 1}, {PAGE_LIMIT} per page
            {!loading && nextCursor === null ? ' — last page' : ''}
          </span>
        </div>
      ) : null}
    </>
  );
}
