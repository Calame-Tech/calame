/**
 * Confirms with the user before running `fn` when there are unsaved changes.
 * Used at ConfigurationDetailPage's outbound navigation points (breadcrumb,
 * "Manage databases", delete) so in-progress edits are never silently
 * discarded by a stray click away from the page (Lot D3).
 */
export function guardedNavigate(isDirty: boolean, fn: () => void): void {
  if (isDirty && !window.confirm('You have unsaved changes. Leave without saving?')) {
    return;
  }
  fn();
}
