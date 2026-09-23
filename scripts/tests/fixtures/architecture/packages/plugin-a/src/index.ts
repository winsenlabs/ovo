// Known violation: a plugin importing another plugin.
import { b } from '@winsendotai/ovo-plugin-b';

export const a = b + 1;
