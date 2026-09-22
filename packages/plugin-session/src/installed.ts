/** The installed-package loader moved to `@winsendotai/ovo-runtime` (§3.9); this re-export keeps old imports working. */
export {
  createNativeHandlerMarker,
  loadInstalledSessionExtensions,
  nativeHandlerMarkerService,
} from '@winsendotai/ovo-runtime';
export type {
  InstalledNativeHandlerPackage,
  InstalledSessionExtensions,
} from '@winsendotai/ovo-runtime';
