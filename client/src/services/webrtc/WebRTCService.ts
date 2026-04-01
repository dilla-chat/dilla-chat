import { ws } from '../websocket';
import { api } from '../api';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUserSettingsStore } from '../../stores/userSettingsStore';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';
import { playJoinSound, playLeaveSound } from '../sounds';
import { supportsE2EVoice } from '../voiceCrypto';
import { VoiceActivityDetector } from './voiceActivityDetection';
import { PushToTalkManager } from './pushToTalk';
import { VoiceEncryptionManager } from './voiceEncryption';

class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private readonly remoteStreams: Map<string, MediaStream> = new Map();
  private readonly remoteVideoStreams: Map<string, MediaStream> = new Map();
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

  // Composed modules
  private readonly vad = new VoiceActivityDetector();
  private readonly ptt = new PushToTalkManager();
  private readonly encryption = new VoiceEncryptionManager();

  async connect(channelId: string, teamId: string): Promise<void> {
    this.channelId = channelId;
    this.teamId = teamId;

    // Get local user ID
    const authEntry = useAuthStore.getState().teams.get(teamId);
    this.localUserId = authEntry?.user?.id ?? null;

    // Get user media with audio processing settings
    try {
      const { useAudioSettingsStore } = await import('../../stores/audioSettingsStore');
      const { useUserSettingsStore } = await import('../../stores/userSettingsStore');
      const deviceId = useUserSettingsStore.getState().selectedInputDevice;
      const audioSettings = useAudioSettingsStore.getState();
      const audioConstraints = audioSettings.getAudioConstraints(deviceId);
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });

      // Build audio graph: source -> gain -> destination
      const ctx = this.vad.getAudioContext();

      const source = ctx.createMediaStreamSource(this.rawStream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = useUserSettingsStore.getState().inputVolume;
      this.gainNode = gainNode;
      const destination = ctx.createMediaStreamDestination();

      source.connect(gainNode);
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
        // Only keep TURN entries (skip STUN -- relay-only doesn't need it)
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
    this.encryption.e2eEnabled = supportsE2EVoice();
    if (this.encryption.e2eEnabled) {
      await this.encryption.setupE2EEncryption(this.pc, this.localUserId);
    } else {
      console.log(
        '[Voice] E2E encryption not available (browser does not support RTCRtpScriptTransform)',
      );
    }
    useVoiceStore.getState().setE2eVoice(this.encryption.e2eEnabled);

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.channelId && this.teamId) {
        ws.voiceICECandidate(this.teamId, this.channelId, event.candidate.toJSON());
      }
    };

    // Handle remote tracks (audio and video)
    this.pc.ontrack = (event) => {
      const track = event.track;
      // Some Pion scenarios deliver tracks without streams -- create one as fallback
      const stream = event.streams[0] ?? new MediaStream([track]);
      const streamId = event.streams[0]?.id ?? track.id;

      // Apply E2E decrypt transform to incoming track
      this.encryption.applyDecryptTransform(event.receiver, streamId, this.localUserId);

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
        // Audio track -- must append to DOM for playback in some browsers
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
        this.vad.addRemoteAnalyser(stream, userId);
      }
    };

    // Subscribe to WS voice events
    this.setupWSListeners();

    // Subscribe to store changes for volume and PTT
    this.setupStoreSubscriptions();

    // Setup push-to-talk if enabled
    this.ptt.setupPTT(this.localStream, this.teamId, this.channelId);

    // Start VAD
    this.vad.startVAD(this.rawStream, this.localStream, this.localUserId);

    // Send WS join (server will send voice:state + voice:offer back via WS)
    console.log('[Voice] Sending WS voice:join for channel', channelId);
    ws.voiceJoin(teamId, channelId);
  }

  private setupStoreSubscriptions(): void {
    // Subscribe to inputVolume changes
    const unsubInput = useUserSettingsStore.subscribe((state) => {
      if (this.gainNode) {
        this.gainNode.gain.value = state.inputVolume;
      }
    });
    this.storeUnsubscribers.push(unsubInput);

    // Subscribe to outputVolume changes
    const unsubOutput = useUserSettingsStore.subscribe((state) => {
      this.setSpeakerVolume(state.outputVolume);
    });
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
      ws.on(
        'voice:ice-candidate',
        async (payload: {
          candidate: string;
          sdp_mid?: string;
          sdp_mline_index?: number;
        }) => {
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
        },
      ),
      ws.on('voice:user-joined', (payload: { user_id: string; username: string }) => {
        store().addPeer({
          user_id: payload.user_id,
          username: payload.username,
          muted: false,
          deafened: false,
          speaking: false,
          voiceLevel: 0,
        });
        if (payload.user_id !== this.localUserId) {
          playJoinSound();
          // Distribute our E2E voice key to the new participant
          this.encryption.distributeVoiceKey(this.teamId, this.channelId, this.localUserId)
            .catch((err) => console.warn('[Voice] Failed to distribute voice key:', err));
        }
      }),
      ws.on('voice:user-left', (payload: { user_id: string }) => {
        store().removePeer(payload.user_id);
        if (payload.user_id !== this.localUserId) playLeaveSound();
      }),
      ws.on('voice:speaking', (payload: { user_id: string; speaking: boolean }) => {
        store().updatePeer(payload.user_id, { speaking: payload.speaking });
      }),
      ws.on(
        'voice:state',
        (payload: {
          peers: Array<{
            user_id: string;
            username: string;
            muted: boolean;
            deafened: boolean;
            speaking: boolean;
            voiceLevel?: number;
            screen_sharing?: boolean;
            webcam_sharing?: boolean;
          }>;
        }) => {
          console.log('[Voice] WS voice:state received, peers:', payload.peers?.length ?? 0);
          store().setPeers(payload.peers.map((p) => ({ ...p, voiceLevel: p.voiceLevel ?? 0 })));

          // Detect existing screen sharer so late joiners see the share
          const sharer = payload.peers.find((p) => p.screen_sharing);
          if (sharer) {
            store().setScreenSharingUserId(sharer.user_id);
          }

          // Distribute E2E voice key to existing participants after joining
          this.encryption.distributeVoiceKey(this.teamId, this.channelId, this.localUserId)
            .catch((err) => console.warn('[Voice] Failed to distribute voice key:', err));
        },
      ),
      // E2E voice key distribution handler
      ws.on(
        'voice:key-distribute',
        async (payload: {
          sender_id: string;
          key_id: number;
          encrypted_keys: Record<string, string>;
        }) => {
          if (!this.encryption.e2eEnabled || !this.localUserId) return;
          const myKey = payload.encrypted_keys[this.localUserId];
          if (myKey) {
            await this.encryption.handleReceivedVoiceKey(
              payload.sender_id,
              payload.key_id,
              myKey,
              this.teamId,
              this.channelId,
            );
          }
        },
      ),
      ws.on(
        'voice:mute-update',
        (payload: { user_id: string; muted: boolean; deafened: boolean }) => {
          store().updatePeer(payload.user_id, {
            muted: payload.muted,
            deafened: payload.deafened,
          });
        },
      ),
      ws.on('voice:screen-update', (payload: { user_id: string; sharing: boolean }) => {
        store().updatePeer(payload.user_id, { screen_sharing: payload.sharing });
        if (payload.sharing) {
          store().setScreenSharingUserId(payload.user_id);
        } else {
          store().setRemoteScreenStream(null);
          store().setScreenSharingUserId(null);
        }
      }),
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

  async disconnect(): Promise<void> {
    this.vad.cleanup();

    // Clean up PTT listeners
    this.ptt.cleanupPTT();

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
    this.encryption.cleanup();
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

    // Store the local screen stream for preview immediately.
    const store = useVoiceStore.getState();
    store.setLocalScreenStream(this.screenStream);
    store.setScreenSharing(true);
    store.setScreenSharingUserId(this.localUserId);

    // Tell the server we're starting screen share. The server will add a
    // recv transceiver on its side and send a new voice:offer. We wait for
    // that offer before adding the track to avoid signaling state conflicts.
    ws.voiceScreenStart(this.teamId, this.channelId);

    // Wait for the server's renegotiation offer to arrive and be handled,
    // then add the track. A short delay ensures setRemoteDescription completes.
    await new Promise<void>((resolve) => {
      const unsub = ws.on('voice:offer', () => {
        unsub();
        resolve();
      });
      // Timeout fallback in case the offer doesn't arrive
      setTimeout(() => { unsub(); resolve(); }, 3000);
    });

    if (this.pc && this.screenStream) {
      this.screenSender = this.pc.addTrack(videoTrack, this.screenStream);
    }
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

    const store = useVoiceStore.getState();
    store.setLocalWebcamStream(this.webcamStream);
    store.setWebcamSharing(true);
    store.updatePeer(this.localUserId ?? '', { webcam_sharing: true });

    // Tell server, wait for renegotiation offer, then add track
    ws.voiceWebcamStart(this.teamId, this.channelId);

    await new Promise<void>((resolve) => {
      const unsub = ws.on('voice:offer', () => {
        unsub();
        resolve();
      });
      setTimeout(() => { unsub(); resolve(); }, 3000);
    });

    if (this.pc && this.webcamStream) {
      this.webcamSender = this.pc.addTrack(videoTrack, this.webcamStream);
    }
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

  // Delegated VAD methods (public interface preserved)
  startVAD(): void {
    this.vad.startVAD(this.rawStream, this.localStream, this.localUserId);
  }

  stopVAD(): void {
    this.vad.stopVAD();
  }

  getRemoteStream(userId: string): MediaStream | undefined {
    return this.remoteStreams.get(userId);
  }
}

// Preserve singleton across Vite HMR reloads to avoid dropping active connections.
const globalKey = '__dilla_webrtcService__';
const _global = globalThis as Record<string, unknown>;
if (!_global[globalKey]) {
  _global[globalKey] = new WebRTCService();
}
export const webrtcService: WebRTCService = _global[globalKey] as WebRTCService;
