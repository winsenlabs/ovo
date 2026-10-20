'use client';
import { SwitchField, TagsField, TextField } from './fields';
import { WEEKDAYS, type QueueHours, type Weekday } from '../../lib/types/queues';

const DAY_LABEL: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const DEFAULT_WINDOW = { start: '09:00', end: '18:00' };

/**
 * Opening hours: off means always open. Each day has one window here (the first); a definition
 * saved with more windows keeps them, and the days not ticked are closed all day.
 */
export function HoursEditor({
  value,
  onChange,
  errors = {},
  required = false,
  idPrefix = 'queue-hours',
}: {
  value: QueueHours | undefined;
  onChange: (value: QueueHours | undefined) => void;
  errors?: Record<string, string | undefined>;
  /** Hours that must exist (a time rule): no "always open" switch, the zone and days stay. */
  required?: boolean;
  /** Distinguishes the controls of two hours editors on one page. */
  idPrefix?: string;
}) {
  if (!value && required) return null;
  if (!value)
    return (
      <SwitchField
        label="Only open during set hours"
        checked={false}
        help="Off: the queue is always open. On: callers outside the hours skip this queue."
        onChange={() =>
          onChange({
            timezone: 'Asia/Kolkata',
            weekly: Object.fromEntries(
              (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((day) => [
                day,
                [{ ...DEFAULT_WINDOW }],
              ]),
            ),
            closed: [],
          })
        }
      />
    );
  const setWindow = (day: Weekday, patch: Partial<typeof DEFAULT_WINDOW> | null) => {
    const windows = value.weekly[day] ?? [];
    const weekly = { ...value.weekly };
    if (patch === null) delete weekly[day];
    else weekly[day] = [{ ...(windows[0] ?? DEFAULT_WINDOW), ...patch }, ...windows.slice(1)];
    onChange({ ...value, weekly });
  };
  return (
    <div className="queue-hours">
      {!required && (
        <SwitchField
          label="Only open during set hours"
          checked
          onChange={() => onChange(undefined)}
        />
      )}
      <TextField
        id={`${idPrefix}-zone`}
        label="Time zone"
        value={value.timezone}
        error={errors['hours.timezone']}
        help="An IANA zone, for example Asia/Kolkata."
        onChange={(timezone) => onChange({ ...value, timezone })}
      />
      <table className="queue-hours-table">
        <caption className="sr-only">Opening hours by day</caption>
        <tbody>
          {WEEKDAYS.map((day) => {
            const window = value.weekly[day]?.[0];
            return (
              <tr key={day}>
                <th scope="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={window !== undefined}
                      onChange={(event) => setWindow(day, event.target.checked ? {} : null)}
                    />{' '}
                    {DAY_LABEL[day]}
                  </label>
                </th>
                <td>
                  <input
                    type="time"
                    aria-label={`${DAY_LABEL[day]} opens`}
                    disabled={!window}
                    value={window?.start ?? ''}
                    onChange={(event) => setWindow(day, { start: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    aria-label={`${DAY_LABEL[day]} closes`}
                    disabled={!window}
                    value={window?.end ?? ''}
                    onChange={(event) => setWindow(day, { end: event.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TagsField
        id={`${idPrefix}-closed`}
        label="Closed on dates"
        values={value.closed}
        placeholder="YYYY-MM-DD"
        error={errors['hours.closed']}
        onChange={(closed) => onChange({ ...value, closed })}
      />
    </div>
  );
}
