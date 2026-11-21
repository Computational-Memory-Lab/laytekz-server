/**
 * One registry setting on the settings page: label, scope badge, hint and
 * its generic control, bound to the settings store (WP02). Device and
 * account settings go through useSetting, project settings through
 * useProjectSetting; each row is its own error boundary, so one feature's
 * broken definition or custom control never takes the page down.
 */
import { Component, useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { AnySettingDef, SettingsEnv } from '../../settings/types';
import { defaultOf, getSetting, subscribeSetting, useProjectSetting, useSetting } from '../../settings/store';
import { sameValue } from '../../settings/codecs';
import { settingDef } from '../../settings/registry';
import { useToast } from '../Toast';
import { SettingControl } from './controls';
import { useSettingsActions } from './actions';
import { controlDomId, controlKind, controlTestId, hintDomId, hintText, labelDomId, labelledByFor, rowTestId, defaultScopeName, scopeName, scopeTitle } from './model';

export interface SettingRowProps {
  def: AnySettingDef;
  env: SettingsEnv;
  /** The row a `#<id>` link pointed at: highlighted. */
  target?: boolean;
}

export function SettingRow(p: SettingRowProps) {
  return (
    <RowBoundary def={p.def}>
      {p.def.scope === 'project' ? <ProjectSettingRow {...p} /> : <StoredSettingRow {...p} />}
    </RowBoundary>
  );
}

/** True while `dependsOn` names a setting that is false. */
function useParentOff(dep: string | undefined): boolean {
  const subscribe = useCallback((cb: () => void) => (dep ? subscribeSetting(dep, cb) : () => {}), [dep]);
  const read = () => (dep ? getSetting<unknown>(dep) === false : false);
  return useSyncExternalStore(subscribe, read, read);
}

function StoredSettingRow({ def, env, target }: SettingRowProps) {
  const [value, set] = useSetting<unknown>(def.id);
  const parentOff = useParentOff(def.dependsOn);
  const { resetRow } = useSettingsActions();
  const onChange = (v: unknown) => {
    if (!def.validate(v)) return false;
    set(v);
    return true;
  };
  // WP23: "Reset" while the value differs from the default; Undo is in the toast.
  let changed = false;
  try { changed = !sameValue(value, defaultOf(def)); } catch { changed = false; }
  return <SettingRowView def={def} env={env} target={target} value={value} onChange={onChange} disabled={parentOff} parentOff={parentOff} onReset={changed ? () => resetRow(def) : undefined} />;
}

function ProjectSettingRow({ def, env, target }: SettingRowProps) {
  const [value, set, { canEdit }] = useProjectSetting<unknown>(def.id);
  const parentOff = useParentOff(def.dependsOn);
  const toast = useToast();
  const onChange = (v: unknown) => {
    if (!def.validate(v)) return false;
    set(v).catch((err: Error) => toast(`Could not save “${def.label}”: ${err.message}`, 'error'));
    return true;
  };
  const locked = !canEdit || !env.project?.canEdit;
  return <SettingRowView def={def} env={env} target={target} value={value} onChange={onChange} disabled={parentOff || locked} parentOff={parentOff} />;
}

export interface SettingRowViewProps extends SettingRowProps {
  value: unknown;
  onChange(v: unknown): boolean;
  disabled: boolean;
  parentOff: boolean;
  /** Shown as "Reset" while the value differs from the default. */
  onReset?(): void;
}

/** The row's markup, separate from the store so it renders in tests as is. */
export function SettingRowView({ def, env, target, value, onChange, disabled, parentOff, onReset }: SettingRowViewProps) {
  const kind = controlKind(def);
  const group = labelledByFor(kind);
  const hint = hintText(def, value, { parentOff, parentLabel: def.dependsOn ? settingDef(def.dependsOn)?.label : null });
  const scope = scopeName(def, env);
  const ids = { id: controlDomId(def.id), labelId: labelDomId(def.id), hintId: hint ? hintDomId(def.id) : undefined };
  return (
    <div
      className={`settings__row settings-row${target ? ' is-target' : ''}${disabled ? ' is-disabled' : ''}${kind === 'checklist' || kind === 'custom' ? ' settings-row--tall' : ''}`}
      data-testid={rowTestId(def.id)}
      data-setting-row={def.id}
      data-scope={def.scope}
      data-target={target ? 'true' : undefined}
    >
      <div className="settings__text">
        <span className="settings-row__head">
          {group
            ? <span className="settings__label" id={ids.labelId}>{def.label}</span>
            : <label className="settings__label" id={ids.labelId} htmlFor={ids.id}>{def.label}</label>}
          {scope !== defaultScopeName(env) && (
            <span className="settings-badge" title={scopeTitle(scope)} data-testid={`${rowTestId(def.id)}-scope`}>{scope}</span>
          )}
          {onReset && !disabled && (
            <button type="button" className="settings-row__reset" onClick={onReset} title="Use the default" aria-label={`Reset ${def.label}`} data-testid={`${rowTestId(def.id)}-reset`}>Reset</button>
          )}
        </span>
        {hint && <span className="settings__hint" id={ids.hintId} data-testid={`${rowTestId(def.id)}-hint`}>{hint}</span>}
      </div>
      <div className="settings__control">
        <SettingControl def={def} value={value} onChange={onChange} disabled={disabled} {...ids} testId={controlTestId(def.id)} />
      </div>
    </div>
  );
}

class RowBoundary extends Component<{ def: AnySettingDef; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn(`Settings: the row for '${this.props.def.id}' could not be shown`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { def } = this.props;
    return (
      <div className="settings__row settings-row" data-testid={rowTestId(def.id)} data-setting-row={def.id} data-failed="true">
        <div className="settings__text">
          <span className="settings__label">{def.label}</span>
          <span className="settings__hint settings__hint--error">This setting could not be shown. Reload the page to try again.</span>
        </div>
      </div>
    );
  }
}
