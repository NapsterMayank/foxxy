export function FoxyArt({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'foxy-art foxy-art--compact' : 'foxy-art'} role="img" aria-label="Foxy, the Alfanumrik learning guide">
      <svg viewBox="0 0 440 390" aria-hidden="true">
        <defs>
          <linearGradient id="fox-tail" x1="0" x2="1">
            <stop stopColor="#ff7a19" />
            <stop offset="1" stopColor="#f4510b" />
          </linearGradient>
        </defs>
        <circle cx="220" cy="192" r="170" fill="#fff0df" />
        <path d="M292 286c91-36 108 45 35 68-48 15-87-2-106-26 31 6 52-8 71-42Z" fill="url(#fox-tail)" />
        <path d="M156 124 175 45l49 55m58 24-18-79-50 56" fill="#f76212" stroke="#292139" strokeWidth="8" strokeLinejoin="round" />
        <path d="m169 74 12-7 19 28m56-1 16-28 6 10" fill="#ffd7ba" />
        <path d="M145 165c0-57 34-87 75-87s76 30 76 87c0 47-29 78-76 78s-75-31-75-78Z" fill="#ff7418" stroke="#292139" strokeWidth="8" />
        <path d="M174 163c5-24 29-23 46 7 17-30 41-31 46-7 5 28-13 61-46 61s-51-33-46-61Z" fill="#fff7ef" />
        <circle cx="187" cy="149" r="8" fill="#292139" /><circle cx="253" cy="149" r="8" fill="#292139" />
        <path d="M211 178c5-8 13-8 18 0-2 9-16 9-18 0Zm-8 18c11 9 23 9 34 0" fill="#292139" stroke="#292139" strokeWidth="5" strokeLinecap="round" />
        <path d="M164 234h112l16 112H148l16-112Z" fill="#251f31" />
        <path d="m220 254 14 27-14 26-14-26 14-27Z" fill="#ff7615" />
        <path d="M289 251c25-8 33-30 27-53m-1 1-12 11m12-11 10 13" fill="none" stroke="#292139" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="art-note">Illustration placeholder</span>
    </div>
  );
}

export function DashboardArt({ variant = 'student' }: { variant?: 'parent' | 'school' | 'student' }) {
  const title = variant === 'parent' ? 'Family progress' : variant === 'school' ? 'Class overview' : 'Today’s learning';
  return (
    <div className={`dashboard-art dashboard-art--${variant}`} role="img" aria-label={`${title} product preview placeholder`}>
      <div className="dashboard-art__top"><i /><i /><i /></div>
      <div className="dashboard-art__layout">
        <div className="dashboard-art__side"><b /><b /><b /><b /></div>
        <div className="dashboard-art__body">
          <small>{title}</small>
          <strong>{variant === 'parent' ? 'A clear view of every step' : variant === 'school' ? 'Learning across your class' : 'Welcome back, Aarav'}</strong>
          <div className="dashboard-art__stats"><span /><span /><span /></div>
          <div className="dashboard-art__chart"><i /><i /><i /><i /><i /><i /></div>
        </div>
      </div>
      <span className="art-note">Product preview placeholder</span>
    </div>
  );
}
