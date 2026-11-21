/**
 * Opens the custom-colour dialog from anywhere (button, right-click menu,
 * card, palette). The dialog's code loads on first use.
 */
export interface ColorDialogOptions {
  /** The colour the dialog starts with. */
  initial?: string;
  /** The chosen colour, '#rrggbb'. */
  onPick(color: `#${string}`): void;
}

let open = false;

export function openColorDialog(o: ColorDialogOptions): void {
  if (open || typeof document === 'undefined') return;
  open = true;
  void import('./ColorDialog')
    .then((m) => m.mountColorDialog(o, () => { open = false; }))
    .catch((err) => { open = false; console.warn('[laytekz] the colour dialog did not load', err); });
}
