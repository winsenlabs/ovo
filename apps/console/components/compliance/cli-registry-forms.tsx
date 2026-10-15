import { FormField } from '../ui/form-field';
import { humaniseEnum } from '../../lib/status';
import { DrawerForm, type SimpleDrawerProps } from './drawer-form';

export const NUMBER_STATUSES = ['active', 'flagged', 'suspended', 'retired'] as const;

/** The "Add caller number" drawer. Split out of `CliRegistryPanel` purely to keep that module
 * under the size gate. */
export function AddCliNumberDrawer({ open, canEdit, onClose, onSubmit }: SimpleDrawerProps) {
  return (
    <DrawerForm
      open={open}
      title="Add caller number"
      canEdit={canEdit}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel="Save caller number"
    >
      <FormField id="cli-number" label="Caller number">
        {(control) => (
          <input {...control} name="phoneNumber" type="tel" placeholder="+911600…" required />
        )}
      </FormField>
      {/* Nested grouping fieldset, not the one `DrawerForm` already flattens — reset the same
          way so it does not draw its own native border inside the drawer. */}
      <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend>Categories</legend>
        {['service', 'transactional', 'promotional'].map((category) => (
          <label key={category} className="toggle-row">
            <input
              type="checkbox"
              name="categories"
              value={category}
              defaultChecked={category === 'service'}
            />
            <span>{humaniseEnum(category)}</span>
          </label>
        ))}
      </fieldset>
      <FormField
        id="cli-status"
        label="Status"
        help="Flagged or suspended numbers are never dialed and pause their campaigns."
      >
        {(control) => (
          <select {...control} name="status" defaultValue="active">
            {NUMBER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {humaniseEnum(status)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id="cli-oap" label="Telco (OAP)">
        {(control) => <input {...control} name="oap" />}
      </FormField>
    </DrawerForm>
  );
}

/** The "Record A2P declaration" drawer. Split out of `CliRegistryPanel` purely to keep that
 * module under the size gate. */
export function RecordA2pDeclarationDrawer({
  open,
  canEdit,
  onClose,
  onSubmit,
}: SimpleDrawerProps) {
  return (
    <DrawerForm
      open={open}
      title="Record A2P declaration"
      canEdit={canEdit}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel="Record declaration"
    >
      <FormField id="a2p-start" label="First number">
        {(control) => <input {...control} name="rangeStart" type="tel" required />}
      </FormField>
      <FormField id="a2p-end" label="Last number">
        {(control) => <input {...control} name="rangeEnd" type="tel" required />}
      </FormField>
      <FormField id="a2p-oap" label="Telco (OAP)">
        {(control) => <input {...control} name="oap" required />}
      </FormField>
      <FormField id="a2p-ref" label="Declaration reference">
        {(control) => <input {...control} name="reference" required />}
      </FormField>
      <FormField id="a2p-declared" label="Declared on">
        {(control) => <input {...control} name="declaredAt" type="date" required />}
      </FormField>
      <FormField id="a2p-effective" label="Effective from">
        {(control) => <input {...control} name="effectiveFrom" type="date" required />}
      </FormField>
    </DrawerForm>
  );
}
