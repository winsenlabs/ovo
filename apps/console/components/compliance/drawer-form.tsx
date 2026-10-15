import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { Drawer } from '../ui/drawer';

// A raw `<fieldset>` renders the browser's own grooved border and padding, which no stylesheet
// in this app resets; the drawer card (or, for Settings, the surrounding `nested-card`) already
// supplies the visual box, so a fieldset used purely for its free `disabled`/`<legend>` cascade
// is flattened back to an invisible grouping element. Exported so every compliance form fieldset
// shares the one definition instead of redeclaring it per file.
export const FLAT_FIELDSET: CSSProperties = { border: 0, margin: 0, padding: 0 };

/** The props every plain "open this one form in a drawer" component takes — no field beyond
 * open/close and the submit handler itself varies. Shared so that shape is declared once instead
 * of repeated, byte for byte, across every such drawer (what the duplication gate caught). */
export type SimpleDrawerProps = {
  open: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * The one "a drawer holding a single `form-grid` form, submit button included" shape every
 * add/record/upload drawer on this tab needs. Centralising the Drawer/form/fieldset/button shell
 * here is what keeps each drawer's own file about its fields, not about re-deriving the same
 * wrapper four times (that repetition is exactly what the duplication gate caught).
 */
export function DrawerForm({
  open,
  title,
  canEdit,
  disabled = false,
  onClose,
  onSubmit,
  submitLabel,
  children,
}: {
  open: boolean;
  title: string;
  canEdit: boolean;
  /** An extra condition (e.g. "no phone number chosen yet") that also disables the fieldset. */
  disabled?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel: string;
  children: ReactNode;
}) {
  return (
    <Drawer open={open} onClose={onClose} title={title}>
      <form className="form-grid" onSubmit={onSubmit}>
        <fieldset disabled={!canEdit || disabled} className="form-grid" style={FLAT_FIELDSET}>
          {children}
          <button className="button primary align-start" style={{ alignSelf: 'start' }}>
            {submitLabel}
          </button>
        </fieldset>
      </form>
    </Drawer>
  );
}
