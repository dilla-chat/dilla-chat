// Mock session bootstrap — used by the /mesh sandbox to activate the
// in-memory mock services and seed authStore with the demo identity.
// Idempotent so HMR / multiple imports don't double-mount.
//
// After ensureMockSession() returns, the rest of the app (AppLayout's
// useTeamSync hook) drives data loading exactly as in prod: it calls
// api.getTeam(), connects the WS, requests sync:init via ws.request(),
// and writes the result to the team/presence stores.

import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { enableMockApi } from './api';
import { enableMockWs } from './websocket';
import { MockApiService } from './mockApi';
import { MockWebSocketService } from './mockWebSocket';

let active = false;
let mockApi: MockApiService | null = null;
let mockWs: MockWebSocketService | null = null;

export function ensureMockSession(): void {
  if (active) return;
  active = true;

  mockApi = new MockApiService();
  mockWs = new MockWebSocketService();
  // Link ws.request → mockApi so per-channel loads (messages:list, dms:list,
  // threads:list, etc.) return the same fixture data REST would serve.
  mockWs.setPeerApi(mockApi);
  enableMockApi(mockApi as unknown as Record<string, unknown>);
  enableMockWs(mockWs as unknown as Record<string, unknown>);

  // Synchronously simulate the persisted post-login state. In prod this is
  // what auth-rehydration would restore from localStorage before first render.
  const identity = mockApi.getDemoIdentity();
  const auth = useAuthStore.getState();
  auth.setDerivedKey('demo-passphrase');
  auth.setPublicKey('demo-public-key');
  auth.addTeam(
    identity.teamId,
    identity.token,
    identity.user,
    identity.team as unknown as Record<string, unknown>,
  );

  // Pre-select the team + a default text channel so the demo lands on a
  // useful view instead of "Select a channel". Channels themselves arrive
  // asynchronously via sync:init; activeChannelId is just a string handle.
  const team = useTeamStore.getState();
  team.setActiveTeam(identity.teamId);
  team.setActiveChannel('ch-2');
}

/** Returns the singletons so the sandbox can drive eager-channel loads
 *  (loading messages/DMs/threads via api so they appear before the user
 *  clicks each channel). */
export function getMockHandles(): { api: MockApiService | null; ws: MockWebSocketService | null } {
  return { api: mockApi, ws: mockWs };
}
