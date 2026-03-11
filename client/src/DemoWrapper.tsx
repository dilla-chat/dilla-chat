import { useEffect, useRef } from 'react';
import { useAuthStore } from './stores/authStore';
import { useTeamStore } from './stores/teamStore';
import { useMessageStore } from './stores/messageStore';
import { useDMStore } from './stores/dmStore';
import { usePresenceStore } from './stores/presenceStore';
import { useThreadStore } from './stores/threadStore';
import { enableMockApi } from './services/api';
import { enableMockWs } from './services/websocket';
import { MockApiService } from './services/mockApi';
import { MockWebSocketService } from './services/mockWebSocket';
import {
  DEMO_TEAM_ID, DEMO_CURRENT_USER_ID,
  MOCK_TEAM, MOCK_CHANNELS, MOCK_MEMBERS, MOCK_ROLES,
  MOCK_GENERAL_MESSAGES, MOCK_WELCOME_MESSAGES,
  MOCK_DM_CHANNELS,
  MOCK_PRESENCES, MOCK_THREADS, MOCK_THREAD_MESSAGES,
} from './services/mockData';
import AppLayout from './pages/AppLayout';

export default function DemoWrapper() {
  const initialized = useRef(false);

  const { setTeam, setChannels, setMembers, setRoles, setActiveTeam, setActiveChannel } = useTeamStore();
  const { setPresences, setMyStatus } = usePresenceStore();
  const { setDMChannels } = useDMStore();
  const { setThreads, setThreadMessages } = useThreadStore();
  const { prependMessages, setHasMore } = useMessageStore();

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const mockApi = new MockApiService();
    const mockWs = new MockWebSocketService();
    enableMockApi(mockApi as unknown as Record<string, unknown>);
    enableMockWs(mockWs as unknown as Record<string, unknown>);

    const authStore = useAuthStore.getState();
    authStore.setDerivedKey('demo-passphrase');
    authStore.setPublicKey('demo-public-key');
    authStore.addTeam(
      DEMO_TEAM_ID,
      'demo-token',
      { id: DEMO_CURRENT_USER_ID, username: 'alice', display_name: 'Alice' },
      MOCK_TEAM,
    );

    setTeam(MOCK_TEAM);
    setChannels(DEMO_TEAM_ID, MOCK_CHANNELS);
    setMembers(DEMO_TEAM_ID, MOCK_MEMBERS);
    setRoles(DEMO_TEAM_ID, MOCK_ROLES);
    setActiveTeam(DEMO_TEAM_ID);
    setActiveChannel('ch-2');

    prependMessages('ch-1', MOCK_WELCOME_MESSAGES);
    prependMessages('ch-2', MOCK_GENERAL_MESSAGES);
    setHasMore('ch-1', false);
    setHasMore('ch-2', false);

    setDMChannels(DEMO_TEAM_ID, MOCK_DM_CHANNELS);

    setPresences(DEMO_TEAM_ID, MOCK_PRESENCES);
    setMyStatus('online');

    setThreads('ch-2', MOCK_THREADS);
    for (const [threadId, messages] of Object.entries(MOCK_THREAD_MESSAGES)) {
      setThreadMessages(threadId, messages);
    }

    mockWs.connect(DEMO_TEAM_ID, '', '');
  }, [
    setTeam, setChannels, setMembers, setRoles, setActiveTeam, setActiveChannel,
    setPresences, setMyStatus, setDMChannels, setThreads, setThreadMessages,
    prependMessages, setHasMore,
  ]);

  return <AppLayout />;
}
