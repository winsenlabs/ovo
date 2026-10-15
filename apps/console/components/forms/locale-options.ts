// Common BCP-47 language tags and IANA timezones for the new-agent wizard's combo inputs. The
// list is a starting point, not a whitelist — `ComboInput` accepts anything typed.
import type { ComboOption } from './combo-input';

export const COMMON_LANGUAGES: readonly ComboOption[] = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'hi-IN', label: 'Hindi (India)' },
  { value: 'bn-IN', label: 'Bengali (India)' },
  { value: 'ta-IN', label: 'Tamil (India)' },
  { value: 'te-IN', label: 'Telugu (India)' },
  { value: 'mr-IN', label: 'Marathi (India)' },
  { value: 'gu-IN', label: 'Gujarati (India)' },
  { value: 'kn-IN', label: 'Kannada (India)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
];

export const COMMON_TIMEZONES: readonly ComboOption[] = [
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'America/New_York', label: 'America/New York (ET)' },
  { value: 'America/Los_Angeles', label: 'America/Los Angeles (PT)' },
  { value: 'UTC', label: 'UTC' },
];
