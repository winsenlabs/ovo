import { FormField } from '../ui/form-field';
import type { ComplianceSettings } from './compliance-types';
import { FLAT_FIELDSET } from './drawer-form';

const SERIES_OPTIONS = ['refuse', 'warn'] as const;

/**
 * The second half of the settings form: enforcement toggles, test numbers, blackout dates and
 * the complaint SLA. Split out of `ComplianceSettingsPanel` purely to keep that module under the
 * size gate — these fieldsets stay inside its one `<form>`, so no `onSubmit` lives here.
 */
export function ComplianceSettingsEnforcementFields({
  settings,
}: {
  settings: ComplianceSettings;
}) {
  return (
    <>
      <fieldset className="stack" style={FLAT_FIELDSET}>
        <legend className="eyebrow">Enforcement</legend>
        <div className="form-grid">
          <FormField
            id="cs-series"
            label="Caller number outside its series"
            help="Refuse is the safe default; warn dials and records the warning (open question Q11)."
          >
            {(control) => (
              <select {...control} name="series" defaultValue={settings.enforcement.series}>
                {SERIES_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'refuse' ? 'Refuse the call' : 'Dial and record a warning'}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="cs-a2p"
            label="A2P declarations required from"
            help="Third Amendment Reg 4 (about 17 Nov 2026); only an earlier date is accepted."
          >
            {(control) => (
              <input
                {...control}
                name="a2pDeclarationRequiredFrom"
                type="date"
                defaultValue={settings.enforcement.a2pDeclarationRequiredFrom}
              />
            )}
          </FormField>
          <FormField id="cs-breaker" label="Abandoned-call breaker">
            {(control) => (
              <select
                {...control}
                name="abandonedBreaker"
                defaultValue={settings.enforcement.abandonedBreaker}
              >
                <option value="enforce">Pause campaigns at 3%</option>
                <option value="monitor">Report only</option>
              </select>
            )}
          </FormField>
          <FormField id="cs-optout" label="An in-call opt-out stops">
            {(control) => (
              <select {...control} name="optOutScope" defaultValue={settings.optOutScope}>
                <option value="all">Every call to the number</option>
                <option value="promotional">Promotional calls only</option>
              </select>
            )}
          </FormField>
          <FormField
            id="cs-test-caps"
            label="Caps for test numbers"
            help="Exempt lets you call your own phones again straight away; every decision records it."
          >
            {(control) => (
              <select
                {...control}
                name="testNumberCaps"
                defaultValue={settings.enforcement.testNumberCaps}
              >
                <option value="exempt">No attempt or gap limits</option>
                <option value="enforce">Same limits as customers</option>
              </select>
            )}
          </FormField>
        </div>
      </fieldset>
      <fieldset className="stack" style={FLAT_FIELDSET}>
        <legend className="eyebrow">Test numbers &amp; blackout</legend>
        <div className="form-grid">
          <FormField
            id="cs-test"
            label="Test numbers (one per line)"
            help="Your own phones: category, series, A2P, consent and DND checks are skipped; windows and the do-not-call list still apply."
          >
            {(control) => (
              <textarea
                {...control}
                name="testNumbers"
                rows={3}
                defaultValue={settings.testNumbers.join('\n')}
              />
            )}
          </FormField>
          <FormField
            id="cs-blackout"
            label="Blackout dates"
            help={`YYYY-MM-DD or MM-DD; applies to ${settings.blackout.appliesTo.join(', ')}.`}
          >
            {(control) => (
              <textarea
                {...control}
                name="blackoutDates"
                rows={3}
                defaultValue={settings.blackout.dates.join('\n')}
              />
            )}
          </FormField>
        </div>
      </fieldset>
      <fieldset className="stack" style={FLAT_FIELDSET}>
        <legend className="eyebrow">Complaint SLA</legend>
        <div className="form-grid">
          <FormField id="cs-ack" label="Acknowledge complaints within (hours)">
            {(control) => (
              <input
                {...control}
                name="ackHours"
                type="number"
                min={1}
                max={720}
                defaultValue={settings.complaintSla.ackHours}
              />
            )}
          </FormField>
          <FormField id="cs-resolve" label="Resolve complaints within (days)">
            {(control) => (
              <input
                {...control}
                name="resolveDays"
                type="number"
                min={1}
                max={90}
                defaultValue={settings.complaintSla.resolveDays}
              />
            )}
          </FormField>
        </div>
      </fieldset>
    </>
  );
}
