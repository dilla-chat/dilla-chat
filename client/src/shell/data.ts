// @ts-nocheck
// Empty shell-data fixture. The original handoff included a full BERRALITOS
// mock dataset (servers, members, channels, messages), but client-side mock
// data is no longer allowed — every regression where mock content leaked
// into /app traced back to this module. The legitimate demo experience now
// has to come from a server started in seed-demo mode, not from a literal
// in the bundle.
//
// `MOCK_DATA` is kept as an export only so existing imports (e.g. the
// /mesh path, useShellData fallback type alias) don't break the build
// until those are removed. Every field is empty: nothing here can be
// mistaken for real data.

export const MOCK_DATA = {
  SERVERS: [],
  MEMBERS: [],
  byId: {},
  CHANNELS: [],
  MESSAGES: {},
  DMS: [],
  DM_MESSAGES: {},
  THREAD_REPLIES: {},
};
