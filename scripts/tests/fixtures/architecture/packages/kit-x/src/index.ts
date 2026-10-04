// Known violation: kits may not import node built-ins.
import { readFileSync } from 'node:fs';

export const read = readFileSync;
