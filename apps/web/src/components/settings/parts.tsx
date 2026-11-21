/**
 * Smaller pieces of the settings page (WP23): the sync status in the header,
 * the import preview, the Desktop app section and the Labs note.
 */
import type { SyncStatus } from '../../settings/store';
import { syncSettingsNow, useSyncStatus } from '../../settings/store';
import { settingDef } from '../../settings/registry';
import { withBase } from '../../basePath';
import { desktopVersion } from '../../util/desktop';
import Modal from '../Modal';
import { describeValue, type ImportPlan } from './transfer';

export const SYNC_TEXT: Readonly<Record<SyncStatus, string>> = {
  local: 'Settings stay on this browser',
  saving: 'Saving…',
  saved: 'Saved to your account',
  offline: 'You’re offline. Changes sync when you reconnect',
  error: 'Your account couldn’t be reached. Changes stay on this browser for now',
};

/** Where changes are going; read through a guard so a missing store leaves the browser's wording. */
export function SyncStatusLine() {
  let status: SyncStatus = 'local';
  try { status = useSyncStatus(); } catch { status = 'local'; }
  return (
    <p className={`settings-sync settings-sync--${status}`} role="status" data-testid="settings-sync-status" data-status={status}>
      <span className="settings-sync__dot" aria-hidden="true" />
      {SYNC_TEXT[status]}
      {status === 'error' && (
        <button type="button" className="btn btn--small settings-sync__retry" onClick={() => { void syncSettingsNow().catch(() => {}); }} data-testid="settings-sync-retry">Try again</button>
      )}
    </p>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));

/** What an import will change, before anything does. */
export function ImportPreview({ plan, onApply, onCancel }: { plan: ImportPlan; onApply(): void; onCancel(): void }) {
  const n = plan.changes.length;
  return (
    <Modal onClose={onCancel} label="Import settings" testId="settings-import-preview" width={520}>
      <div>
        <h2>Import settings</h2>
        <p className="modal__sub" data-testid="settings-import-count">
          {n ? plural(n, '1 setting will change.', '# settings will change.') : 'Nothing will change: this browser already has these settings.'} Settings the file doesn’t name stay as they are.
        </p>
        {n > 0 && (
          <ul className="settings-import__list" data-testid="settings-import-changes">
            {plan.changes.map((c) => {
              const def = settingDef(c.id);
              return (
                <li key={c.id} data-testid={`settings-import-change-${c.id}`}>
                  <span className="settings-import__label">{c.label}</span>
                  <span className="settings-import__values">{describeValue(def, c.from)} → <strong>{describeValue(def, c.to)}</strong></span>
                </li>
              );
            })}
          </ul>
        )}
        {plan.invalid.length > 0 && (
          <p className="settings__hint" data-testid="settings-import-invalid">
            {plural(plan.invalid.length, '1 setting in the file is skipped: its value isn’t allowed here.', '# settings in the file are skipped: their values aren’t allowed here.')}
          </p>
        )}
        {plan.ignored.length > 0 && (
          <p className="settings__hint" data-testid="settings-import-ignored">
            {plural(plan.ignored.length, '1 entry this version doesn’t know is ignored.', '# entries this version doesn’t know are ignored.')}
          </p>
        )}
        <div className="modal__row">
          <button type="button" className="btn" onClick={onCancel} data-testid="settings-import-cancel">Cancel</button>
          {n > 0 && <button type="button" className="btn btn--primary" onClick={onApply} data-testid="settings-import-apply">{plural(n, 'Change 1 setting', 'Change # settings')}</button>}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The Desktop app section. In the app: its version and the button that opens
 * the app's own settings window (the shell intercepts /settings/desktop-app;
 * the page learns nothing back). Reached on that address without the
 * intercept: the app is too old. On the web: where these settings live.
 */
export function DesktopRows({ desktop, viaAppPath }: { desktop: boolean; viaAppPath: boolean }) {
  if (!desktop) {
    return <p className="settings__hint settings-page__note" data-testid="settings-desktop-web">These settings belong to the Laytekz desktop app, on your computer. Open them from the app’s Settings… menu.</p>;
  }
  if (viaAppPath) {
    return <p className="settings__hint settings-page__note" data-testid="settings-desktop-update">Update the desktop app to change these here.</p>;
  }
  let version: string | null = null;
  try { version = desktopVersion(); } catch { version = null; }
  return (
    <div className="settings__row" data-setting-row="desktop.open">
      <div className="settings__text">
        <span className="settings__label">Desktop app settings</span>
        <span className="settings__hint">{version ? `Laytekz desktop ${version}. ` : ''}The server address, opening at login, page zoom and spelling languages, kept on this computer</span>
      </div>
      <div className="settings__control">
        <button type="button" className="btn" onClick={() => { window.open(withBase('/settings/desktop-app')); }} data-testid="settings-desktop-open">Open desktop app settings…</button>
      </div>
    </div>
  );
}

export function LabsNote() {
  return <p className="settings__hint settings-page__note" data-testid="settings-labs-note">Experiments that may change or go away. Each one is off until you turn it on.</p>;
}
