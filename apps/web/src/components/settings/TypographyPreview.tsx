/**
 * A sample of LaTeX beside the Editor text rows (WP23), drawn with the same
 * CSS variables the editor reads (settings/apply.ts sets them on <html>), so
 * it follows the font, size, line height and ligatures as they change, in
 * Source mode's style and Visual mode's.
 */
export function TypographyPreview() {
  return (
    <figure className="settings-typography" data-testid="settings-typography-preview">
      <figcaption className="settings__hint">Preview</figcaption>
      <div className="settings-typography__panes">
        <pre className="settings-typography__source" aria-label="Source mode" data-testid="settings-typography-source">
          <span className="settings-typography__cmd">\section</span>{'{Results}\n'}
          {'Recall rose to '}<span className="settings-typography__math">$M = 4.2$</span>{' -> see\n'}
          <span className="settings-typography__cmd">\cref</span>{'{tab:recall} != the pilot.\n'}
          <span className="settings-typography__comment">{'% fi fl => <= 0O 1lI'}</span>
        </pre>
        <div className="settings-typography__visual" aria-label="Visual mode" data-testid="settings-typography-visual">
          <p className="settings-typography__heading">1 Results</p>
          <p>Recall rose to <i>M</i> = 4.2, see Table 1, unlike the pilot.</p>
        </div>
      </div>
    </figure>
  );
}
