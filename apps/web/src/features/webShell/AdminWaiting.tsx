import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../components/Auth';
import { waitingLabel } from './api';

/** Asks at most once a minute (on mount and when the window gets focus). */
const MIN_GAP_MS = 60 * 1000;

/**
 * F6 web readiness (WP45): "2 waiting" in the project list's toolbar, for
 * administrators, when accounts wait for approval; it opens /admin.
 */
export default function AdminWaiting() {
  const { admin } = useAuth();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!admin) return;
    let last = -Infinity;
    let alive = true;
    const ask = () => {
      if (Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      api.adminStats().then((s) => { if (alive) setCount(s.users.awaitingApproval ?? 0); }).catch(() => { /* keep the last count */ });
    };
    ask();
    window.addEventListener('focus', ask);
    return () => { alive = false; window.removeEventListener('focus', ask); };
  }, [admin]);
  const label = admin ? waitingLabel(count) : null;
  if (!label) return null;
  return (
    <Link to="/admin" className="btn btn--ghost" data-testid="admin-waiting" title="Accounts waiting for your approval">
      {label}
    </Link>
  );
}
