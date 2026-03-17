import { ws } from './websocket';
import { api } from './api';
import { noiseSuppression } from './noiseSuppression';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import { playJoinSound, playLeaveSound } from './sounds';
import { VoiceKeyManager, supportsE2EVoice } from './voiceCrypto';

const VAD_INTERVAL_MS = 100;


class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private remoteStreams: Map<string, MediaStream> = new Map();
  private remoteVideoStreams: Map<string, MediaStream> = new Map();
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private remoteAnalysers: Map<string, { analyser: AnalyserNode; data: Uint8Array; userId: string }> = new Map();
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private remoteVadTimer: ReturnType<typeof setInterval> | null = null;
  private channelId: string | null = null;
  private teamId: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;
  private localUserId: string | null = null;
  private screenSender: RTCRtpSender | null = null;
  private webcamStream: MediaStream | null = null;
  private webcamSender: RTCRtpSender | null = null;
  private gainNode: GainNode | null = null;
  private storeUnsubscribers: Array<() => void> = [];
  private pttListeners: Array<() => void> = [];

  // E2E voice encryption
  private e2eEnabled = false;
  private voiceKeyManager = new VoiceKeyManager();
  private encryptWorker: Worker | null = null;
  private decryptWorkers: Map<string, Worker> = new Map();

  async connect(channelId: string, teamId: string): Promise<void> {
    this.channelId = channelId;
    this.teamId = teamId;

    // Get local user ID
    const authEntry = useAuthStore.getState().teams.get(teamId);
    this.localUserId = (authEntry?.user as { id?: string } | null)?.id ?? null;

    // Get user media with audio processing settings
    try {
      const { useAudioSettingsStore } = await import('../stores/audioSettingsStore');
      const { useUserSettingsStore } = await import('../stores/userSettingsStore');
      const deviceId = useUserSettingsStore.getState().selectedInputDevice;
      const audioSettings = useAudioSettingsStore.getState();
      const audioConstraints = audioSettings.getAudioConstraints(deviceId);
      this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

      // Build a single audio graph: source → [worklet] → gain → destination
      const useRNNoise = audioSettings.enhancedNoiseSuppression;
      const ctx = useRNNoise
        ? new AudioContext({ sampleRate: 48000 })
        : this.getAudioContext();
      if (useRNNoise) this.audioContext = ctx;

      const source = ctx.createMediaStreamSource(this.rawStream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = useUserSettingsStore.getState().inputVolume;
      this.gainNode = gainNode;
      const destination = ctx.createMediaStreamDestination();

      if (useRNNoise) {
        noiseSuppression.setEnabled(true);
        await noiseSuppression.initWorklet(ctx);
        const workletNode = noiseSuppression.getWorkletNode()!;
        source.connect(workletNode);
        workletNode.connect(gainNode);
        await noiseSuppression.waitForReady();
      } else {
        noiseSuppression.setEnabled(false);
        source.connect(gainNode);
      }

      gainNode.connect(destination);
      this.localStream = destination.stream;
    } catch {
      throw new Error('Microphone access denied');
    }

    const store = useVoiceStore.getState();
    store.setLocalStream(this.localStream);

    // Fetch TURN credentials if available, fall back to public STUN
    let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
    let iceTransportPolicy: RTCIceTransportPolicy = 'all';
    try {
      const resp = await api.getTURNCredentials(teamId);
      if (resp?.iceServers?.length) {
        // Only keep TURN entries (skip STUN — relay-only doesn't need it)
        // Limit to 3 best URLs to avoid browser "too many servers" warning
        iceServers = resp.iceServers
          .filter((s: RTCIceServer) => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some((u: string) => u.startsWith('turn:') || u.startsWith('turns:'));
          })
          .map((s: RTCIceServer) => {
            const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
              .filter((u: string) => !u.includes(':53?')) // port 53 often blocked
              .slice(0, 3);
            return { ...s, urls };
          });
        iceTransportPolicy = 'relay';
        console.log('[Voice] Using TURN relay (no IP leaks)');
      }
    } catch {
      console.log('[Voice] TURN not available, using STUN');
    }

    // Create peer connection
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    store.setPeerConnection(this.pc);

    // Add local tracks
    for (const track of this.localStream.getTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // Set up E2E voice encryption if supported
    this.e2eEnabled = supportsE2EVoice();
    if (this.e2eEnabled) {
      await this.setupE2EEncryption();
    } else {
      console.log('[Voice] E2E encryption not available (browser does not support RTCRtpScriptTransform)');
    }
    useVoiceStore.getState().setE2eVoice(this.e2eEnabled);

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.channelId && this.teamId) {
        ws.voiceICECandidate(this.teamId, this.channelId, event.candidate.toJSON());
      }
    };

    // Handle remote tracks (audio and video)
    this.pc.ontrack = (event) => {
      const track = event.track;
      // Some Pion scenarios deliver tracks without streams — create one as fallback
      const stream = event.streams[0] ?? new MediaStream([track]);
      const streamId = event.streams[0]?.id ?? track.id;

      console.log('[WebRTC] ontrack:', track.kind, 'stream:', streamId, 'track:', track.id);

      // Apply E2E decrypt transform to incoming track
      this.applyDecryptTransform(event.receiver, streamId);

      if (track.kind === 'video') {
        // Distinguish webcam vs screen by stream/track ID prefix
        if (streamId.startsWith('webcam-stream-') || track.id.startsWith('webcam-')) {
          const userId = streamId.startsWith('webcam-stream-')
            ? streamId.replace('webcam-stream-', '')
            : track.id.replace('webcam-', '');
          useVoiceStore.getState().setRemoteWebcamStream(userId, stream);
        } else {
          // Screen share video track
          console.log('[WebRTC] Screen share track received:', streamId);
          this.remoteVideoStreams.set(streamId, stream);
          useVoiceStore.getState().setRemoteScreenStream(stream);
        }
      } else {
        // Audio track — must append to DOM for playback in some browsers
        this.remoteStreams.set(streamId, stream);
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.dataset.streamId = streamId;
        audio.volume = useUserSettingsStore.getState().outputVolume;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.play().catch(() => {});
        // Extract userId from stream ID (format: "stream-{userId}")
        const userId = stream.id.startsWith('stream-') ? stream.id.slice(7) : undefined;
        this.addRemoteAnalyser(stream, userId);
      }
    };

    // Subscribe to WS voice events
    this.setupWSListeners();

    // Subscribe to store changes for volume and PTT
    this.setupStoreSubscriptions();

    // Setup push-to-talk if enabled
    this.setupPTT();

    // Start VAD
    this.startVAD();

    // Send WS join (server will send voice:state + voice:offer back via WS)
    console.log('[Voice] Sending WS voice:join for channel', channelId);
    ws.voiceJoin(teamId, channelId);
  }

  private setupStoreSubscriptions(): void {
    // Subscribe to inputVolume changes
    const unsubInput = useUserSettingsStore.subscribe(
      (state) => {
        if (this.gainNode) {
          this.gainNode.gain.value = state.inputVolume;
        }
      },
    );
    this.storeUnsubscribers.push(unsubInput);

    // Subscribe to outputVolume changes
    const unsubOutput = useUserSettingsStore.subscribe(
      (state) => {
        this.setSpeakerVolume(state.outputVolume);
      },
    );
    this.storeUnsubscribers.push(unsubOutput);
  }

  private setSpeakerVolume(volume: number): void {
    document.querySelectorAll<HTMLAudioElement>('audio[data-stream-id]').forEach((el) => {
      el.volume = volume;
    });
  }

  setInputVolume(v: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = v;
    }
  }

  private setupPTT(): void {
    this.cleanupPTT();
    const audioSettings = useAudioSettingsStore.getState();
    if (!audioSettings.pushToTalk) return;

    // Start with mic muted when PTT is enabled
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = false;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const currentKey = useAudioSettingsStore.getState().pushToTalkKey;
      if (e.code === currentKey && this.localStream) {
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack && !audioTrack.enabled) {
          audioTrack.enabled = true;
          if (this.teamId && this.channelId) {
            ws.voiceMute(this.teamId, this.channelId, false);
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const currentKey = useAudioSettingsStore.getState().pushToTalkKey;
      if (e.code === currentKey && this.localStream) {
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack && audioTrack.enabled) {
          audioTrack.enabled = false;
          if (this.teamId && this.channelId) {
            ws.voiceMute(this.teamId, this.channelId, true);
          }
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.pttListeners.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    );

    // Subscribe to PTT setting changes to re-setup when toggled
    const unsubPTT = useAudioSettingsStore.subscribe(
      (state) => {
        if (!state.pushToTalk) {
          this.cleanupPTT();
          // Re-enable mic when PTT is turned off
          if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) audioTrack.enabled = true;
          }
        }
      },
    );
    this.pttListeners.push(unsubPTT);
  }

  private cleanupPTT(): void {
    for (const cleanup of this.pttListeners) {
      cleanup();
    }
    this.pttListeners = [];
  }

  private setupWSListeners(): void {
    const store = useVoiceStore.getState;

    this.unsubscribers.push(
      ws.on('voice:offer', async (payload: { sdp: string; channel_id?: string }) => {
        if (!this.pc) return;
        try {
          const desc: RTCSessionDescriptionInit = { type: 'offer', sdp: payload.sdp };
          await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
          this.remoteDescSet = true;
          // Flush any ICE candidates that arrived before the offer
          for (const c of this.pendingCandidates) {
            await this.pc.addIceCandidate(new RTCIceCandidate(c));
          }
          this.pendingCandidates = [];
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          if (this.teamId && this.channelId && answer) {
            ws.voiceAnswer(this.teamId, this.channelId, answer);
          }
        } catch (err) {
          console.error('[WebRTC] Failed to handle offer:', err);
        }
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:ice-candidate', async (payload: { candidate: string; sdp_mid?: string; sdp_mline_index?: number }) => {
        if (!this.pc) return;
        const init: RTCIceCandidateInit = {
          candidate: payload.candidate,
          sdpMid: payload.sdp_mid ?? null,
          sdpMLineIndex: payload.sdp_mline_index ?? null,
        };
        if (!this.remoteDescSet) {
          this.pendingCandidates.push(init);
          return;
        }
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(init));
        } catch (err) {
          console.error('[WebRTC] ICE candidate error:', err);
        }
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:user-joined', (payload: { user_id: string; username: string }) => {
        store().addPeer({
          user_id: payload.user_id,
          username: payload.username,
          muted: false,
          deafened: false,
          speaking: false,
          voiceLevel: 0,        });
        if (payload.user_id !== this.localUserId) {
          playJoinSound();
          // Distribute our E2E voice key to the new participant
          this.distributeVoiceKey();
        }
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:user-left', (payload: { user_id: string }) => {
        store().removePeer(payload.user_id);
        if (payload.user_id !== this.localUserId) playLeaveSound();
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:speaking', (payload: { user_id: string; speaking: boolean }) => {
        store().updatePeer(payload.user_id, { speaking: payload.speaking });
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:state', (payload: { peers: Array<{ user_id: string; username: string; muted: boolean; deafened: boolean; speaking: boolean; voiceLevel?: number; screen_sharing?: boolean; webcam_sharing?: boolean }> }) => {
        console.log('[Voice] WS voice:state received, peers:', payload.peers?.length ?? 0);
        store().setPeers(payload.peers.map((p) => ({ ...p, voiceLevel: p.voiceLevel ?? 0 })));

        // Detect existing screen sharer so late joiners see the share
        const sharer = payload.peers.find((p) => p.screen_sharing);
        if (sharer) {
          store().setScreenSharingUserId(sharer.user_id);
        }

        // Distribute E2E voice key to existing participants after joining
        this.distributeVoiceKey();
      }),
    );

    // E2E voice key distribution handler
    this.unsubscribers.push(
      ws.on(
        'voice:key-distribute',
        async (payload: {
          sender_id: string;
          key_id: number;
          encrypted_keys: Record<string, string>;
        }) => {
          if (!this.e2eEnabled || !this.localUserId) return;
          const myKey = payload.encrypted_keys[this.localUserId];
          if (myKey) {
            await this.handleReceivedVoiceKey(payload.sender_id, payload.key_id, myKey);
          }
        },
      ),
    );

    this.unsubscribers.push(
      ws.on('voice:mute-update', (payload: { user_id: string; muted: boolean; deafened: boolean }) => {
        store().updatePeer(payload.user_id, { muted: payload.muted, deafened: payload.deafened });
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:screen-update', (payload: { user_id: string; sharing: boolean }) => {
        store().updatePeer(payload.user_id, { screen_sharing: payload.sharing });
        if (!payload.sharing) {
          store().setRemoteScreenStream(null);
          store().setScreenSharingUserId(null);
        } else {
          store().setScreenSharingUserId(payload.user_id);
        }
      }),
    );

    this.unsubscribers.push(
      ws.on('voice:webcam-update', (payload: { user_id: string; sharing: boolean }) => {
        store().updatePeer(payload.user_id, { webcam_sharing: payload.sharing });
        if (!payload.sharing) {
          store().setRemoteWebcamStream(payload.user_id, null);
        }
      }),
    );
  }

  async handleOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) return null;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleICECandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /** Set up E2E voice encryption transforms on all senders. */
  private async setupE2EEncryption(): Promise<void> {
    if (!this.pc) return;

    // Generate local voice key
    const { rawKey, keyId } = await this.voiceKeyManager.generateLocalKey();

    // Create encrypt worker and apply to all senders
    this.encryptWorker = new Worker(
      new URL('../workers/voiceEncryptWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.encryptWorker.postMessage({
      type: 'setKey',
      key: rawKey.buffer,
      keyId,
    });

    // Apply encrypt transform to all outgoing tracks
    for (const sender of this.pc.getSenders()) {
      if (sender.track) {
        const transform = new RTCRtpScriptTransform(this.encryptWorker, { operation: 'encrypt' });
        sender.transform = transform;
      }
    }

    // Also set up our own key in the decrypt map (for self-hearing in some SFU configs)
    await this.voiceKeyManager.setRemoteKey(this.localUserId ?? '', rawKey);

    console.log('[Voice] E2E encryption enabled');
  }

  /** Distribute voice key to all participants in the channel. */
  private distributeVoiceKey(): void {
    if (!this.e2eEnabled || !this.teamId || !this.channelId) return;

    const rawKey = this.voiceKeyManager.getLocalRawKey();
    const keyId = this.voiceKeyManager.getLocalKeyId();
    if (!rawKey) return;

    // For now, distribute the raw key base64-encoded.
    // In a full implementation, this would be encrypted per-recipient via Signal Protocol.
    const keyBase64 = btoa(String.fromCharCode(...rawKey));

    // Get all peers in the channel
    const peers = useVoiceStore.getState().peers;
    const encryptedKeys: Record<string, string> = {};
    for (const userId of Object.keys(peers)) {
      if (userId !== this.localUserId) {
        encryptedKeys[userId] = keyBase64;
      }
    }

    if (Object.keys(encryptedKeys).length > 0) {
      ws.voiceKeyDistribute(this.teamId, this.channelId, keyId, encryptedKeys);
    }
  }

  /** Handle received voice key from another participant. */
  private async handleReceivedVoiceKey(
    senderId: string,
    keyId: number,
    encryptedKey: string,
  ): Promise<void> {
    // Decode the key (in full implementation, decrypt via Signal Protocol first)
    const rawKey = new Uint8Array(
      atob(encryptedKey)
        .split('')
        .map((c) => c.charCodeAt(0)),
    );

    await this.voiceKeyManager.setRemoteKey(senderId, rawKey);

    // Update all decrypt workers with the new key
    for (const worker of this.decryptWorkers.values()) {
      worker.postMessage({
        type: 'addDecryptKey',
        key: rawKey.buffer,
        keyId,
      });
    }

    console.log('[Voice] Received E2E key from', senderId);
  }

  /** Apply decrypt transform to an incoming track's receiver. */
  private applyDecryptTransform(receiver: RTCRtpReceiver, streamId: string): void {
    if (!this.e2eEnabled) return;

    const worker = new Worker(
      new URL('../workers/voiceEncryptWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.decryptWorkers.set(streamId, worker);

    const transform = new RTCRtpScriptTransform(worker, { operation: 'decrypt' });
    receiver.transform = transform;

    // Send all known keys to the new decrypt worker
    const peers = useVoiceStore.getState().peers;
    for (const userId of Object.keys(peers)) {
      const rawKey = this.voiceKeyManager.getLocalRawKey();
      if (userId === this.localUserId && rawKey) {
        worker.postMessage({
          type: 'addDecryptKey',
          key: rawKey.buffer,
          keyId: this.voiceKeyManager.getLocalKeyId(),
        });
      }
    }
  }

  async disconnect(): Promise<void> {
    console.log('[Voice] disconnect() called');
    this.stopVAD();
    this.stopRemoteVAD();

    // Clean up PTT listeners
    this.cleanupPTT();

    // Clean up store subscriptions
    for (const unsub of this.storeUnsubscribers) {
      unsub();
    }
    this.storeUnsubscribers = [];

    // Stop screen sharing if active.
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.screenSender = null;
    }

    // Stop webcam if active.
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((t) => t.stop());
      this.webcamStream = null;
      this.webcamSender = null;
    }

    // Unsubscribe WS listeners
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Notify server via WS only
    if (this.teamId && this.channelId) {
      ws.voiceLeave(this.teamId, this.channelId);
    }

    // Clean up noise suppression pipeline
    noiseSuppression.cleanup();

    // Stop local tracks (raw stream holds the actual mic tracks)
    if (this.rawStream) {
      this.rawStream.getTracks().forEach((t) => t.stop());
      this.rawStream = null;
    }
    this.localStream = null;
    this.gainNode = null;

    // Close peer connection
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Close audio context (we always own it now)
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyser = null;

    this.remoteAnalysers.clear();
    this.remoteStreams.clear();

    // Remove orphaned audio elements from DOM
    document.querySelectorAll('audio[data-stream-id]').forEach((el) => el.remove());
    this.remoteVideoStreams.clear();
    this.pendingCandidates = [];
    this.remoteDescSet = false;
    this.channelId = null;
    this.teamId = null;
    this.localUserId = null;

    // Clean up E2E encryption
    this.e2eEnabled = false;
    this.voiceKeyManager.clear();
    if (this.encryptWorker) {
      this.encryptWorker.terminate();
      this.encryptWorker = null;
    }
    for (const worker of this.decryptWorkers.values()) {
      worker.terminate();
    }
    this.decryptWorkers.clear();
  }

  toggleMute(): boolean {
    // PTT mode: toggleMute is a no-op
    if (useAudioSettingsStore.getState().pushToTalk) return false;

    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const muted = !audioTrack.enabled;
      if (this.teamId && this.channelId) {
        ws.voiceMute(this.teamId, this.channelId, muted);
      }
      return muted;
    }
    return false;
  }

  toggleDeafen(): boolean {
    const store = useVoiceStore.getState();
    const deafened = !store.deafened;
    // Mute all remote audio
    for (const stream of this.remoteStreams.values()) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !deafened;
      }
    }
    // Deafen mutes the mic; undeafen does NOT auto-unmute it
    if (deafened && this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = false;
      }
    }
    if (this.teamId && this.channelId) {
      ws.voiceDeafen(this.teamId, this.channelId, deafened);
    }
    return deafened;
  }

  async startScreenShare(): Promise<void> {
    if (!this.pc || !this.teamId || !this.channelId) {
      throw new Error('Not connected to a voice channel');
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported in this environment');
    }

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch (err) {
      console.error('[Voice] getDisplayMedia failed:', err);
      throw new Error('Screen sharing cancelled or denied');
    }

    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error('No video track from screen capture');
    }

    // Handle the user clicking "Stop sharing" in the browser/OS chrome.
    videoTrack.onended = () => {
      this.stopScreenShare();
    };

    // Tell the server we're starting screen share (it will renegotiate).
    ws.voiceScreenStart(this.teamId, this.channelId);

    // Add the video track to our PC. The server will send a new offer after renegotiation.
    this.screenSender = this.pc.addTrack(videoTrack, this.screenStream);

    // Store the local screen stream for preview.
    const store = useVoiceStore.getState();
    store.setLocalScreenStream(this.screenStream);
    store.setScreenSharing(true);
    store.setScreenSharingUserId(this.localUserId);
  }

  async stopScreenShare(): Promise<void> {
    // Stop the screen track.
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }

    // Remove the sender from the PC.
    if (this.screenSender && this.pc) {
      try {
        this.pc.removeTrack(this.screenSender);
      } catch {
        // PC may already be closed
      }
      this.screenSender = null;
    }

    // Tell the server.
    if (this.teamId && this.channelId) {
      ws.voiceScreenStop(this.teamId, this.channelId);
    }

    // Clear local state.
    const store = useVoiceStore.getState();
    store.setScreenSharing(false);
    store.setLocalScreenStream(null);
    store.setScreenSharingUserId(null);
  }

  isScreenSharing(): boolean {
    return this.screenStream !== null;
  }

  async startWebcam(): Promise<void> {
    if (!this.pc || !this.teamId || !this.channelId) {
      throw new Error('Not connected to a voice channel');
    }

    try {
      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { aspectRatio: 16 / 9, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      console.error('[Voice] getUserMedia (webcam) failed:', err);
      throw new Error('Webcam access denied');
    }

    const videoTrack = this.webcamStream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error('No video track from webcam');
    }

    videoTrack.onended = () => {
      this.stopWebcam();
    };

    ws.voiceWebcamStart(this.teamId, this.channelId);
    this.webcamSender = this.pc.addTrack(videoTrack, this.webcamStream);

    const store = useVoiceStore.getState();
    store.setLocalWebcamStream(this.webcamStream);
    store.setWebcamSharing(true);
    store.updatePeer(this.localUserId ?? '', { webcam_sharing: true });
  }

  async stopWebcam(): Promise<void> {
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((t) => t.stop());
      this.webcamStream = null;
    }

    if (this.webcamSender && this.pc) {
      try {
        this.pc.removeTrack(this.webcamSender);
      } catch {
        // PC may already be closed
      }
      this.webcamSender = null;
    }

    if (this.teamId && this.channelId) {
      ws.voiceWebcamStop(this.teamId, this.channelId);
    }

    const store = useVoiceStore.getState();
    store.setWebcamSharing(false);
    store.setLocalWebcamStream(null);
    store.updatePeer(this.localUserId ?? '', { webcam_sharing: false });
  }

  isWebcamSharing(): boolean {
    return this.webcamStream !== null;
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private addRemoteAnalyser(stream: MediaStream, userId?: string): void {
    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.remoteAnalysers.set(stream.id, {
        analyser,
        data: new Uint8Array(analyser.frequencyBinCount),
        userId: userId ?? stream.id,
      });
      this.startRemoteVAD();
    } catch {
      // AudioContext not available
    }
  }

  private startRemoteVAD(): void {
    if (this.remoteVadTimer) return; // already running
    const wasSpeaking = new Map<string, boolean>();
    this.remoteVadTimer = setInterval(() => {
      const store = useVoiceStore.getState();
      const userThreshold = useUserSettingsStore.getState().inputThreshold;
      const vadThreshold = Math.round(userThreshold * 100);
      for (const [, entry] of this.remoteAnalysers) {
        entry.analyser.getByteFrequencyData(entry.data as unknown as Uint8Array<ArrayBuffer>);
        const avg = entry.data.reduce((a, b) => a + b, 0) / entry.data.length;
        const level = Math.min(avg / 80, 1);
        const speaking = avg > vadThreshold;
        const prev = wasSpeaking.get(entry.userId) ?? false;
        if (speaking !== prev || level > 0) {
          wasSpeaking.set(entry.userId, speaking);
          if (store.peers[entry.userId]) {
            store.updatePeer(entry.userId, { voiceLevel: level, speaking });
          }
        }
      }
    }, VAD_INTERVAL_MS);
  }

  private stopRemoteVAD(): void {
    if (this.remoteVadTimer) {
      clearInterval(this.remoteVadTimer);
      this.remoteVadTimer = null;
    }
  }

  private updateLocalLevel(level: number, speaking: boolean): void {
    if (!this.localUserId) return;
    const store = useVoiceStore.getState();
    if (store.peers[this.localUserId]) {
      store.updatePeer(this.localUserId, { voiceLevel: level, speaking });
    }
  }

  startVAD(): void {
    // Use raw (unprocessed) stream for VAD — gives more accurate threshold detection
    const vadStream = this.rawStream ?? this.localStream;
    if (!vadStream) return;

    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(vadStream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      let wasSpeaking = false;

      this.vadTimer = setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const level = Math.min(avg / 80, 1);
        const userThreshold = useUserSettingsStore.getState().inputThreshold;
        const vadThreshold = Math.round(userThreshold * 100);
        const isSpeaking = avg > vadThreshold;

        if (isSpeaking !== wasSpeaking) {
          wasSpeaking = isSpeaking;
          useVoiceStore.getState().setSpeaking(isSpeaking);
        }

        this.updateLocalLevel(level, wasSpeaking);
      }, VAD_INTERVAL_MS);
    } catch {
      // AudioContext not available
    }
  }

  stopVAD(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
  }

  getRemoteStream(userId: string): MediaStream | undefined {
    return this.remoteStreams.get(userId);
  }
}

// Preserve singleton across Vite HMR reloads to avoid dropping active connections.
const globalKey = '__dilla_webrtcService__';
export const webrtcService: WebRTCService =
  (globalThis as Record<string, unknown>)[globalKey] as WebRTCService ??
  ((globalThis as Record<string, unknown>)[globalKey] = new WebRTCService()) as WebRTCService;
