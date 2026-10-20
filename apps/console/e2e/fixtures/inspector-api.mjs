// The call inspector and routed-call fixture API (Wave 18, console-visibility lane). Wired into
// e2e/auth-server.mjs beside the desk and routing fixtures; this stub answers nothing until that
// lane fills it in, so the server falls through to the next handler.
export async function handleInspectorApi() {
  return false;
}
