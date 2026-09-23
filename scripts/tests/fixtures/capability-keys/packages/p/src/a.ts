// Known violation: capability strings spelled outside contracts/capabilities/keys.ts.
export const stt = 'ovo.stt@2';
export const tool = `ovo.tool-connector.${'http'}`;
// Known violation: the key is in the tail and the middle of a template, not its head.
export const tail = (prefix: string) => `${prefix}ovo.stt`;
export const middle = (a: string, b: string) => `${a}ovo.tool-connector.mcp${b}`;
