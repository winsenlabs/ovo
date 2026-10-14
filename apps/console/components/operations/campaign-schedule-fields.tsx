import { FormField } from '../ui/form-field';
import { CampaignCallingWindow } from './campaign-calling-window';

/** Step 3's schedule, limit and calling-window fields. Split out of `CampaignCreateForm` purely
 * to keep that module under the size gate; `disabled` gates every control until the contact
 * preview above it is clean. */
export function CampaignScheduleFields({
  disabled,
  defaultAttempts,
}: {
  disabled: boolean;
  defaultAttempts: number;
}) {
  return (
    <>
      <div className="form-grid">
        <FormField id="campaign-name" label="Campaign name">
          {(control) => <input {...control} name="name" required disabled={disabled} />}
        </FormField>
        <FormField id="campaign-from" label="Permitted caller number">
          {(control) => (
            <input
              {...control}
              name="fromNumber"
              type="tel"
              placeholder="+91…"
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-at" label="Local schedule">
          {(control) => (
            <input
              {...control}
              name="localDateTime"
              type="datetime-local"
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-timezone" label="IANA timezone">
          {(control) => (
            <input
              {...control}
              name="timezone"
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-per-number" label="Attempts per number">
          {(control) => (
            <input
              {...control}
              name="perNumberAttemptLimit"
              type="number"
              min={1}
              max={100}
              defaultValue={1}
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-total" label="Maximum total attempts">
          {(control) => (
            <input
              {...control}
              name="maxAttemptsTotal"
              type="number"
              min={1}
              defaultValue={defaultAttempts}
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-daily" label="Maximum attempts per local day">
          {(control) => (
            <input
              {...control}
              name="maxAttemptsPerLocalDay"
              type="number"
              min={1}
              defaultValue={defaultAttempts}
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-concurrency" label="Maximum concurrent calls">
          {(control) => (
            <input
              {...control}
              name="maxConcurrency"
              type="number"
              min={1}
              max={1000}
              defaultValue={1}
              required
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField id="campaign-active-policy" label="Active calls on cancel">
          {(control) => (
            <select {...control} name="activeCallPolicy" disabled={disabled}>
              <option value="continue">Allow active calls to continue</option>
              <option value="request_end">Request active calls to end</option>
            </select>
          )}
        </FormField>
      </div>
      <CampaignCallingWindow disabled={disabled} />
    </>
  );
}
