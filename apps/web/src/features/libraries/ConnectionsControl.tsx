/**
 * Libraries (F8): the "Reference managers" row of Settings › Connections.
 * Your Mendeley connection (and Zotero sign-in, when the server offers it):
 * connect, or disconnect. The Zotero API key keeps its own row above.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { withBase } from '../../basePath';
import { useCapabilities } from '../../settings/capabilities';
import type { CustomControlProps } from '../../settings/types';
import { connectUrl, providerConfigured, readConnection, type ConnectionState } from './connection';

interface Row { provider: 'mendeley' | 'zotero'; label: string }

function ProviderRow({ provider, label, configured }: Row & { configured: boolean }) {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void readConnection(provider).then(setState); }, [provider]);
  useEffect(load, [load]);

  const disconnect = async () => {
    setBusy(true);
    try { await fetch(withBase(`/api/libraries/${provider}/connection`), { method: 'DELETE' }); } catch { /* the reload below shows what is true */ }
    setBusy(false);
    load();
  };

  let body: ReactNode;
  if (!state) body = <span style={{ color: 'var(--text-2)' }}>Checking…</span>;
  else if (state.kind === 'unsupported' || (!configured && state.kind !== 'connected')) {
    body = (
      <span style={{ color: 'var(--text-2)' }} data-testid={`libraries-connection-${provider}-unconfigured`}>
        {state.kind === 'unsupported'
          ? `This server can’t connect to ${label} yet.`
          : `${label} sign-in isn’t set up on this server. The administrator turns it on by registering a ${label} app.`}
      </span>
    );
  } else if (state.kind === 'connected') {
    body = (
      <>
        <span data-testid={`libraries-connection-${provider}-connected`}>Connected{state.name ? ` as ${state.name}` : ''}</span>
        <button type="button" className="btn btn--small" disabled={busy} onClick={disconnect} data-testid={`libraries-connection-${provider}-disconnect`}>Disconnect</button>
      </>
    );
  } else {
    body = (
      <>
        <span style={{ color: 'var(--text-2)' }}>Not connected</span>
        <button type="button" className="btn btn--small btn--primary" onClick={() => window.location.assign(connectUrl(provider, `${window.location.pathname}${window.location.search}`))} data-testid={`libraries-connection-${provider}-connect`}>
          Sign in with {label}
        </button>
      </>
    );
  }
  return (
    <div className="settings__row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-testid={`libraries-connection-${provider}`}>
      <strong style={{ minWidth: 80 }}>{label}</strong>
      {body}
    </div>
  );
}

export default function ConnectionsControl(_: CustomControlProps<null>) {
  const caps = useCapabilities();
  const rows: Array<Row & { configured: boolean }> = [{ provider: 'mendeley', label: 'Mendeley', configured: providerConfigured(caps, 'mendeley') }];
  if (providerConfigured(caps, 'zoteroOAuth')) rows.push({ provider: 'zotero', label: 'Zotero', configured: true });
  return (
    <div data-testid="libraries-connections" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => <ProviderRow key={r.provider} {...r} />)}
    </div>
  );
}
