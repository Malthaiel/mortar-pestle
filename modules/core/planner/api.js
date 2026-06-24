// Planner module's SDK handle. Captures the api instance at register-time
// so non-React modules (provider effects, helpers) can reach the dirty
// surface without prop-drilling.
let _api = null;

export function bindPlannerApi(api) {
  _api = api;
}

export function plannerApi() {
  return _api;
}
