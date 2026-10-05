import { createLogger } from '@winsendotai/ovo-plugin-kit';

/** Twilio code runs inside the gateway (callbacks) and the worker (REST control). */
export const twilioLog = createLogger({ component: 'carrier-twilio' });
