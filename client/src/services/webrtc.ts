import { ws } from './websocket';
import { api } from './api';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { playJoinSound, playLeaveSound } from './sounds';

const VAD_THRESHOLD = 15;
const VAD_INTERVAL_MS = 100;

interface TURNResponse {
  iceServers: RTCIceServer[];
}

class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
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

  async connect(channelId: string, teamId: string): Promise<void> {
    this.channelId = channelId;
    this.teamId = teamId;

    // Get local user ID
    const authEntry = useAuthStore.getState().teams.get(teamId);
    this.localUserId = (authEntry?.user as { id?: string } | null)?.id ?? null;

    // Get user media with audio processing settings
    try {
      const { useAudioSettingsStore } = await import('../stores/audioSettingsStore');
      const audioConstraints = useAudioSettingsStore.getState().getAudioConstraints();
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
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
        console.log('[Voice] Using Cloudflare TURN relay (no IP leaks)');
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

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.channelId && this.teamId) {
        ws.voiceICECandidate(this.teamId, this.channelId, event.candidate.toJSON());
      }
    };

    // Handle remote tracks (audio and video)
    this.pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      if (event.track.kind === 'video') {
        // Distinguish webcam vs screen by stream ID prefix
        const streamId = stream.id;
        if (streamId.startsWith('webcam-stream-')) {
          const userId = streamId.replace('webcam-stream-', '');
          useVoiceStore.getState().setRemoteWebcamStream(userId, stream);
        } else {
          // Screen share video track
          this.remoteVideoStreams.set(stream.id, stream);
          useVoiceStore.getState().setRemoteScreenStream(stream);
        }
      } else {
        // Audio track — must append to DOM for playback in some browsers
        this.remoteStreams.set(stream.id, stream);
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.dataset.streamId = stream.id;
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

    // Start VAD
    this.startVAD();

    // Send WS join (server will send voice:state + voice:offer back via WS)
    console.log('[Voice] Sending WS voice:join for channel', channelId);
    ws.voiceJoin(teamId, channelId);
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
        if (payload.user_id !== this.localUserId) playJoinSound();
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
      ws.on('voice:state', (payload: { peers: Array<{ user_id: string; username: string; muted: boolean; deafened: boolean; speaking: boolean }> }) => {
        console.log('[Voice] WS voice:state received, peers:', payload.peers?.length ?? 0);
        store().setPeers(payload.peers);
      }),
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

  async disconnect(): Promise<void> {
    console.log('[Voice] disconnect() called');
    this.stopVAD();
    this.stopRemoteVAD();

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

    // Stop local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    // Close peer connection
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
      this.analyser = null;
    }

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
  }

  toggleMute(): boolean {
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
      for (const [, entry] of this.remoteAnalysers) {
        entry.analyser.getByteFrequencyData(entry.data);
        const avg = entry.data.reduce((a, b) => a + b, 0) / entry.data.length;
        const level = Math.min(avg / 80, 1);
        const speaking = avg > VAD_THRESHOLD;
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
    if (!this.localStream) return;

    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(this.localStream);
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
        const isSpeaking = avg > VAD_THRESHOLD;

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
const globalKey = '__slimcord_webrtcService__';
export const webrtcService: WebRTCService =
  (globalThis as Record<string, unknown>)[globalKey] as WebRTCService ??
  ((globalThis as Record<string, unknown>)[globalKey] = new WebRTCService()) as WebRTCService;
