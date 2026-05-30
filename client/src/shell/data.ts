// @ts-nocheck
// Empty shell-data fallback. The original handoff exported a full
// `MOCK_DATA` fixture (servers, members, channels, messages), but
// client-side mock data is no longer allowed — every regression where
// mock content leaked into /app traced back to this module. The
// legitimate demo experience now comes from a server started in
// seed-demo mode, not from a literal in the bundle.
//
// What this still provides: the empty-shape fallback ChatApp.tsx
// reaches for when `useShellDataContext()` returns null (test
// isolation, hard render-before-bootstrap path). Every field is
// empty so nothing here can be mistaken for real data.
//
// Name change vs. the historical `MOCK_DATA` export: this is the
// SAME object, just renamed to match what it actually is now. The
// `MOCK_DATA` alias used to ride along for a transition window but
// is gone in this commit — bare imports of `MOCK_DATA` will trip
// the build, which is the desired forcing-function.

export const EMPTY_SHELL_DATA = {
  SERVERS: [],
  MEMBERS: [],
  byId: {},
  CHANNELS: [],
  MESSAGES: {},
  DMS: [],
  DM_MESSAGES: {},
  THREAD_REPLIES: {},
};
