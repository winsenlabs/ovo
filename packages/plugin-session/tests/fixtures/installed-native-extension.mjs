export const nativeHandlers = Object.freeze({
  package: Object.freeze({ name: '@example/ovo-business-tools', version: '1.2.3' }),
  plugin: Object.freeze({
    id: '@example/ovo-business-tools/native-handlers',
    version: '1.2.3',
  }),
  handlers: Object.freeze({
    lookup: async (input, context) => ({
      configured: input,
      operationId: context.operationId,
      workspaceId: context.workspaceId,
    }),
  }),
});
