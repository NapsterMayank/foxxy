'use client';

import Link from 'next/link';
import { use } from 'react';
import { adminUserDetailResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, Masked, useAdminData } from '@/components/screen';
import { Reveal } from '@/components/reveal';

/**
 * =============================================================================
 * ONE USER — the only screen in this app that can disclose anything.
 *
 * Both masked values below are rendered as the server sent them, wrapped in
 * `<Masked>` so they read as WITHHELD rather than as missing. Next to each sits
 * a `<Reveal>`, which is the whole disclosure surface: one resource, one named
 * field, one reason code, one audit row. Nothing on this page reconstructs a
 * value, and nothing implies the real value is available for free.
 * =============================================================================
 */

/** Section headings. `globals.css` styles `h2` only; these are the smaller rung. */
const SECTION: React.CSSProperties = { fontSize: 13, margin: '18px 0 6px' };

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  /*
   * Next 16 hands a dynamic route its params as a PROMISE. `use` unwraps it in
   * the client component rather than splitting the screen into a server shell
   * plus a client child: everything below — loading state, reveal, the audit it
   * writes — is client work already, so the extra file would buy nothing.
   */
  const { id } = use(params);
  const { data, error, loading } = useAdminData(adminPaths.user(id), adminUserDetailResponseSchema);

  return (
    <>
      <h2>User</h2>
      <p className="sub">
        <Link href="/users">Users</Link> / {id}
      </p>

      {error !== null ? (
        <Failure error={error} />
      ) : loading ? (
        <p className="muted">Loading user…</p>
      ) : data === null ? (
        <p className="muted">Nothing to show.</p>
      ) : (
        <>
          <table>
            <tbody>
              <tr>
                <th>Email</th>
                <td>
                  <Reveal
                    resourceType="user"
                    resourceId={data.user.id}
                    field="email"
                    masked={<Masked>{data.user.emailMasked}</Masked>}
                  />
                </td>
              </tr>
              <tr>
                <th>Role</th>
                <td>{data.user.role}</td>
              </tr>
              <tr>
                <th>Tenant</th>
                <td className="muted">{data.user.tenantId}</td>
              </tr>
              <tr>
                <th>Verified</th>
                <td className={data.user.emailVerified ? 'ok' : 'muted'}>
                  {data.user.emailVerified ? 'yes' : 'no'}
                </td>
              </tr>
              <tr>
                <th>Created</th>
                <td>{data.user.createdAt}</td>
              </tr>
            </tbody>
          </table>

          <h3 style={SECTION}>Learner</h3>
          {data.learner === null ? (
            <p className="muted">
              This account has no learner profile. Not every user is a student.
            </p>
          ) : (
            <table>
              <tbody>
                <tr>
                  <th>Display name</th>
                  <td>
                    {/*
                      The learner profile is keyed by the USER id — there is no
                      separate learner id anywhere on the wire — so this reveal
                      names the same id under a different resource type. Passing
                      an invented id here would 404 as "absent, or not permitted"
                      and read as a permissions problem.
                    */}
                    <Reveal
                      resourceType="learner"
                      resourceId={id}
                      field="displayName"
                      masked={<Masked>{data.learner.displayNameMasked}</Masked>}
                    />
                  </td>
                </tr>
                <tr>
                  <th>Grade</th>
                  <td>{data.learner.grade}</td>
                </tr>
                <tr>
                  <th>Board</th>
                  <td>{data.learner.board}</td>
                </tr>
                <tr>
                  <th>Language</th>
                  <td>{data.learner.preferredLanguage}</td>
                </tr>
                <tr>
                  <th>Subjects</th>
                  <td>
                    {data.learner.subjects.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      data.learner.subjects.join(', ')
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          )}

          <h3 style={SECTION}>Counts</h3>
          <div className="cards">
            <div className="card">
              <div className="label">Practice sessions</div>
              <div className="value">{data.counts.practiceSessions}</div>
            </div>
            <div className="card">
              <div className="label">Chat sessions</div>
              <div className="value">{data.counts.chatSessions}</div>
            </div>
            <div className="card">
              {/*
                The wire calls this one `sessions` and does not say which kind.
                Labelling it "sign-ins" here would assert something the contract
                never states, so it keeps the name it was given.
              */}
              <div className="label">Sessions</div>
              <div className="value">{data.counts.sessions}</div>
            </div>
          </div>

          <p>
            <Link href={`/users/${encodeURIComponent(id)}/activity`}>
              Activity feed — chat and practice on one timeline, grouped by visit
            </Link>
          </p>
        </>
      )}
    </>
  );
}
