import { FormField } from '../ui/form-field';
import { humaniseEnum } from '../../lib/status';
import { DrawerForm, type SimpleDrawerProps } from './drawer-form';

export const BASIS_OPTIONS = [
  'explicit_service_7d',
  'inquiry_7d',
  'application_3m',
  'explicit_registered',
  'explicit_legacy_registered',
  'transaction_30min',
  'inferred_relationship',
] as const;

/** The "Record consent" drawer. Split out of `ConsentRecordsPanel` purely to keep that module
 * under the size gate. */
export function RecordConsentDrawer({
  open,
  phone,
  canEdit,
  onClose,
  onSubmit,
}: SimpleDrawerProps & { phone: string }) {
  return (
    <DrawerForm
      open={open}
      title={`Record consent for ${phone || 'this number'}`}
      canEdit={canEdit}
      disabled={!phone}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel="Record consent"
    >
      <FormField id="consent-pe" label="Brand (principal entity)">
        {(control) => <input {...control} name="principalEntity" required />}
      </FormField>
      <FormField id="consent-purpose" label="Purpose">
        {(control) => <input {...control} name="purpose" required />}
      </FormField>
      <FormField id="consent-category" label="Category">
        {(control) => (
          <select {...control} name="category" defaultValue="service">
            <option value="service">Service</option>
            <option value="promotional">Promotional</option>
            <option value="transactional">Transactional</option>
          </select>
        )}
      </FormField>
      <FormField id="consent-basis" label="Basis">
        {(control) => (
          <select {...control} name="basis" defaultValue="explicit_service_7d">
            {BASIS_OPTIONS.map((basis) => (
              <option key={basis} value={basis}>
                {humaniseEnum(basis)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        id="consent-evidence"
        label="Evidence reference"
        help="DLT consent ID, CRF reference, or your inquiry record."
      >
        {(control) => <input {...control} name="evidenceRef" required />}
      </FormField>
      <FormField id="consent-obtained" label="Obtained">
        {(control) => <input {...control} name="obtainedAt" type="datetime-local" required />}
      </FormField>
      <label className="toggle-row">
        <input type="checkbox" name="customerInitiated" />
        <span>The customer opted in on their own (allowed inside the 90-day lock)</span>
      </label>
    </DrawerForm>
  );
}

/** The "Upload scrub results" drawer. Split out of `ConsentRecordsPanel` purely to keep that
 * module under the size gate. */
export function UploadScrubResultsDrawer({ open, canEdit, onClose, onSubmit }: SimpleDrawerProps) {
  return (
    <DrawerForm
      open={open}
      title="Upload scrub results"
      canEdit={canEdit}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel="Upload scrub results"
    >
      <FormField
        id="scrub-rows"
        label="DND scrub results (phone,result per line)"
        help="result is allowed, blocked, fully_blocked or unknown, as your telco or RTM portal reports it."
      >
        {(control) => <textarea {...control} name="rows" rows={6} required />}
      </FormField>
    </DrawerForm>
  );
}
