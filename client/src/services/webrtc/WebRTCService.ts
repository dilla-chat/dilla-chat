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
import {
  initializeVoiceIsolation,
  processIncoming as voiceIsoProcessIncoming,
  processOutgoing as voiceIsoProcessOutgoing,
  tearDownAll as voiceIsoTearDownAll,
  tearDownOutgoing as voiceIsoTearDownOutgoing,
  tearDownPeer as voiceIsoTearDownPeer,
  type InitializedContext as VoiceIsolationContext,
} from '../voiceIsolation/dispatcher';

type OutboundStreamStat = { kind?: string; mid?: string; bytesSent?: number; packetsSent?: number; targetBitrate?: number };
type InboundStreamStat = { kind?: string; mid?: string; bytesReceived?: number; packetsReceived?: number; framesDecoded?: number; framesDropped?: number; frameWidth?: number; frameHeight?: number };

/** Walk an RTCStatsReport once, pulling out:
 *  - rttMs from the nominated, succeeded candidate-pair (when present)
 *  - bytesSent summed across every outbound-rtp stream (audio + video)
 *  - per-stream outbound + inbound rows for diag logging */
function summarizeRtcStats(report: RTCStatsReport): {
  rttMs: number | null;
  bytesSent: number | null;
  perStream: OutboundStreamStat[];
  perInbound: InboundStreamStat[];
} {
  let rttMs: number | null = null;
  let bytesSent: number | null = null;
  const perStream: OutboundStreamStat[] = [];
  const perInbound: InboundStreamStat[] = [];
  report.forEach((stat) => {
    if (
      stat.type === 'candidate-pair' &&
      (stat as { state?: string; nominated?: boolean }).state === 'succeeded' &&
      (stat as { nominated?: boolean }).nominated &&
      typeof (stat as { currentRoundTripTime?: number }).currentRoundTripTime === 'number'
    ) {
      rttMs = Math.round((stat as { currentRoundTripTime: number }).currentRoundTripTime * 1000);
    }
    if (
      stat.type === 'outbound-rtp' &&
      typeof (stat as { bytesSent?: number }).bytesSent === 'number'
    ) {
      const s = stat as { bytesSent: number; kind?: string; mid?: string; packetsSent?: number; targetBitrate?: number };
      bytesSent = (bytesSent ?? 0) + s.bytesSent;
      perStream.push({ kind: s.kind, mid: s.mid, bytesSent: s.bytesSent, packetsSent: s.packetsSent, targetBitrate: s.targetBitrate });
    }
    if (
      stat.type === 'inbound-rtp' &&
      typeof (stat as { bytesReceived?: number }).bytesReceived === 'number'
    ) {
      const s = stat as { bytesReceived: number; kind?: string; mid?: string; packetsReceived?: number; framesDecoded?: number; framesDropped?: number; frameWidth?: number; frameHeight?: number };
      perInbound.push({
        kind: s.kind, mid: s.mid,
        bytesReceived: s.bytesReceived,
        packetsReceived: s.packetsReceived,
        framesDecoded: s.framesDecoded,
        framesDropped: s.framesDropped,
        frameWidth: s.frameWidth,
        frameHeight: s.frameHeight,
      });
    }
  });
  return { rttMs, bytesSent, perStream, perInbound };
}

/** Every ~5 polling ticks (~3s), log the outbound + inbound stream
 *  breakdown so a 'sending but not receiving' or 'receiving but not
 *  rendering' situation shows up in the console. */
function logRtcStreamBreakdown(
  tickCount: number,
  perStream: OutboundStreamStat[],
  perInbound: InboundStreamStat[],
): number {
  const next = tickCount + 1;
  if (next % 5 === 0) {
    if (perStream.length > 0) {
      console.log('[Voice/diag] outbound-rtp stream breakdown:', perStream);
    }
    if (perInbound.length > 0) {
      console.log('[Voice/diag] inbound-rtp stream breakdown:', perInbound);
    }
  }
  return next;
}

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
  // Serialise voice:offer handling so a second offer arriving mid-
  // handshake (between setRemoteDescription's await and the
  // corresponding setLocalDescription) doesn't trample the
  // RTCPeerConnection signalingState. Reproduces as
  //   'no pending remote description' or
  //   'Cannot set local answer when createAnswer has not been called'.
  private offerQueue: Promise<unknown> = Promise.resolve();
  private localUserId: string | null = null;
  private screenSender: RTCRtpSender | null = null;
  private webcamStream: MediaStream | null = null;
  private webcamSender: RTCRtpSender | null = null;
  private gainNode: GainNode | null = null;
  private storeUnsubscribers: Array<() => void> = [];
  private voiceIsolationContext: VoiceIsolationContext | null = null;
  private readonly peerIdByStreamId: Map<string, string> = new Map();
  // Stats poller — samples currentRoundTripTime from the active
  // candidate pair every ~600ms and feeds voiceStore so the dock's
  // latency sparkline can render without spinning its own RAF.
  private statsPollerId: ReturnType<typeof setInterval> | null = null;
  private lastBytesSent = 0;
  private lastBytesSentAt = 0;
  // Tracks queued up by startWebcam / startScreenShare to be bound to
  // the next renegotiation's new transceiver BEFORE createAnswer runs.
  // Without this, the answer m-line lands as a=inactive (Chrome
  // downgrades empty sendonly to inactive) and the encoder never
  // produces frames. Separate slots per kind so a rapid cam-then-
  // screen sequence doesn't make the second start overwrite the first
  // (single-slot version did, and cam never got bound).
  private pendingCamTrack: MediaStreamTrack | null = null;
  private pendingScreenTrack: MediaStreamTrack | null = null;
  // Per-kind operation generation. Incremented on every start AND
  // stop. Inside start, we snapshot at entry; after any await we
  // compare — a mismatch means a newer start or a stop has happened
  // since, so the in-flight start aborts. Without this guard, a
  // rapid ON → OFF sequence let the ON's slow getUserMedia /
  // getDisplayMedia complete after the OFF and re-enable the
  // sender (user clicked OFF but we kept sending).
  private camOpGen = 0;
  private screenOpGen = 0;

  // Composed modules
  private readonly vad = new VoiceActivityDetector();
  private readonly ptt = new PushToTalkManager();
  private readonly encryption = new VoiceEncryptionManager();

  async connect(channelId: string, teamId: string): Promise<void> {
    this.channelId = channelId;
    this.teamId = teamId;

    // Defensive: if a previous session left media tracks alive
    // (server crashed mid-share, page didn't reload, etc.), kill
    // them now so we don't end up with the browser sharing-banner
    // pinned to a track no one is using. The store flags are reset
    // either way so the UI starts fresh.
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.screenSender = null;
    }
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((t) => t.stop());
      this.webcamStream = null;
      this.webcamSender = null;
    }
    const vs = useVoiceStore.getState();
    if (vs.localScreenStream) {
      vs.localScreenStream.getTracks().forEach((t) => t.stop());
      vs.setLocalScreenStream(null);
      vs.setScreenSharing(false);
    }
    if (vs.localWebcamStream) {
      vs.localWebcamStream.getTracks().forEach((t) => t.stop());
      vs.setLocalWebcamStream(null);
      vs.setWebcamSharing(false);
    }

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
      // TURN credentials endpoint not available — expected when no TURN
      // server is configured. Voice falls back to STUN (peer-to-peer).
    }

    // Create peer connection
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    store.setPeerConnection(this.pc);

    // Initialize DFN3 voice isolation if enabled. We await the init (with
    // a timeout) so the first voice join gets processed tracks, not just
    // subsequent joins. The model bundle is cached in IndexedDB after the
    // first load, so repeat joins are fast.
    const dfn3Enabled = useAudioSettingsStore.getState().noiseSuppressionMode === 'dfn3';
    if (dfn3Enabled && !this.voiceIsolationContext) {
      // SharedArrayBuffer is required for the DFN3 AudioWorklet ring buffer.
      // It's available on localhost in Chromium without COEP, but Firefox
      // requires full cross-origin isolation. Skip init if unavailable.
      if (typeof SharedArrayBuffer === 'undefined') {
        console.warn('[Voice] SharedArrayBuffer not available — DFN3 disabled');
      } else {
        const authEntry = useAuthStore.getState().teams.get(teamId);
        const serverUrl = authEntry?.baseUrl ?? '';
        if (serverUrl) {
          try {
            const ctx = await Promise.race([
              initializeVoiceIsolation(serverUrl),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
            ]);
            if (ctx) {
              this.voiceIsolationContext = ctx;
              console.log('[Voice] DFN3 noise suppression ready');
            } else {
              console.warn('[Voice] DFN3 init timed out — falling back to pass-through');
            }
          } catch (err) {
            console.error('[Voice] DFN3 init failed:', err);
          }
        }
      }
    }

    // Add local tracks. Wrap audio tracks with the voice isolation pipeline
    // when available.
    let dfn3ProcessedStream: MediaStream | null = null;
    for (const track of this.localStream.getTracks()) {
      const processed =
        dfn3Enabled && this.voiceIsolationContext && track.kind === 'audio'
          ? voiceIsoProcessOutgoing(this.voiceIsolationContext, track)
          : track;
      if (processed !== track) {
        dfn3ProcessedStream = new MediaStream([processed]);
      }
      this.pc.addTrack(processed, this.localStream);
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

    // Diagnostic state-change logging — chases "screen attached but
    // never flows" and "track frozen for remote" by showing exactly
    // when negotiation transitions vs. when tracks fire.
    this.pc.onsignalingstatechange = () => {
      console.log('[Voice/diag] signalingState →', this.pc?.signalingState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log('[Voice/diag] iceConnectionState →', this.pc?.iceConnectionState);
    };
    this.pc.onconnectionstatechange = () => {
      console.log('[Voice/diag] connectionState →', this.pc?.connectionState);
    };
    this.pc.onnegotiationneeded = () => {
      console.log('[Voice/diag] onnegotiationneeded fired (not handled — server drives negotiation)');
    };

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.channelId && this.teamId) {
        ws.voiceICECandidate(this.teamId, this.channelId, event.candidate.toJSON());
      }
    };

    // Handle remote tracks (audio and video)
    this.pc.ontrack = (event) => {
      const track = event.track;
      // Use msid stream-ID for classification, but ALWAYS build a fresh
      // single-track MediaStream for the store. Chrome reuses the same
      // MediaStream object across renegotiations whose msid matches
      // (e.g. "webcam-stream-<uid>"), so a publisher's cam restart
      // leaves the previous (now-ended) track lingering inside that
      // shared MediaStream. The <video> element then renders the dead
      // track's last frame instead of the live one — "cam frozen on
      // remote, still thinks they're sharing" even after the state
      // flips back to true. Wrapping the new track in its own stream
      // means the store always points at a stream that contains only
      // the live track from THIS ontrack event.
      const streamId = event.streams[0]?.id ?? track.id;
      const stream =
        track.kind === 'video' ? new MediaStream([track]) : (event.streams[0] ?? new MediaStream([track]));

      // Apply E2E decrypt transform to incoming track
      this.encryption.applyDecryptTransform(event.receiver, streamId, this.localUserId);

      if (track.kind === 'video') {
        console.log('[Voice/diag] ontrack video — streamId=', streamId, 'trackId=', track.id, 'streamIdsAll=', event.streams.map((s) => s.id));
        // Distinguish webcam vs screen by stream/track ID prefix
        if (streamId.startsWith('webcam-stream-') || track.id.startsWith('webcam-')) {
          const userId = streamId.startsWith('webcam-stream-')
            ? streamId.replace('webcam-stream-', '')
            : track.id.replace('webcam-', '');
          console.log('[Voice/diag] ontrack → webcam for', userId);
          // Watch the track for unexpected end events — that's the
          // smoking gun for "B sees A's stream vanish even though
          // server thinks A is still publishing".
          track.addEventListener('ended', () => {
            console.warn('[Voice/diag] webcam track ended for', userId, 'streamId=', streamId, 'trackId=', track.id);
          });
          track.addEventListener('mute', () => {
            console.warn('[Voice/diag] webcam track muted for', userId, 'streamId=', streamId, 'trackId=', track.id);
          });
          useVoiceStore.getState().setRemoteWebcamStream(userId, stream);
        } else {
          // Screen share video track. stream id format is
          // "screen-stream-<userId>" from the server; extract so we
          // can key the per-user map instead of stomping a single
          // global slot.
          console.log('[WebRTC] Screen share track received:', streamId);
          this.remoteVideoStreams.set(streamId, stream);
          let userId: string;
          if (streamId.startsWith('screen-stream-')) {
            userId = streamId.replace('screen-stream-', '');
          } else if (track.id.startsWith('screen-')) {
            userId = track.id.replace('screen-', '').replace(/-[a-f0-9-]+$/, ''); // NOSONAR(typescript:S5852) — bounded over a track.id we generate ourselves
          } else {
            userId = streamId;
          }
          console.log('[Voice/diag] ontrack → screen for', userId);
          track.addEventListener('ended', () => {
            console.warn('[Voice/diag] screen track ended for', userId, 'streamId=', streamId, 'trackId=', track.id);
          });
          track.addEventListener('mute', () => {
            console.warn('[Voice/diag] screen track muted for', userId, 'streamId=', streamId, 'trackId=', track.id);
          });
          useVoiceStore.getState().setRemoteScreenStream(userId, stream);
        }
      } else {
        // Extract userId from stream ID (format: "stream-{userId}") for
        // both VAD analyser labeling and voice-isolation peer keying.
        const userId = stream.id.startsWith('stream-') ? stream.id.slice(7) : undefined;

        // Run incoming audio through the DFN3 pipeline when isolation is
        // enabled and the dispatcher has finished initializing. Otherwise
        // pass through. SFrame decryption is applied upstream by
        // `applyDecryptTransform` on the RTCRtpReceiver, so by the time
        // we see the MediaStreamTrack here the bytes are already
        // plaintext PCM.
        const dfn3EnabledForIncoming = useAudioSettingsStore.getState().noiseSuppressionMode === 'dfn3';
        const peerId = userId ?? streamId;
        let playbackStream: MediaStream = stream;
        if (dfn3EnabledForIncoming && this.voiceIsolationContext) {
          const processedTrack = voiceIsoProcessIncoming(
            this.voiceIsolationContext,
            track,
            peerId,
          );
          if (processedTrack !== track) {
            playbackStream = new MediaStream([processedTrack]);
            this.peerIdByStreamId.set(streamId, peerId);
          }
        }

        // Audio track -- must append to DOM for playback in some browsers
        this.remoteStreams.set(streamId, playbackStream);
        const audio = document.createElement('audio');
        audio.srcObject = playbackStream;
        audio.autoplay = true;
        audio.dataset.streamId = streamId;
        audio.volume = useUserSettingsStore.getState().outputVolume;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        // Surface autoplay rejections so they're not swallowed silently —
        // an unplayable audio element is the most common 'why don't I
        // hear them' bug. Browsers can block play() if it's called
        // outside the original user gesture (the WS roundtrip + SDP
        // handshake may push us past that window).
        audio.play().catch((err: unknown) => {
          console.error('[WebRTC] audio.play() rejected for', streamId, err);
        });
        this.vad.addRemoteAnalyser(stream, userId);
      }
    };

    // Subscribe to WS voice events
    this.setupWSListeners();

    // Subscribe to store changes for volume and PTT
    this.setupStoreSubscriptions();

    // Start the stats poller (RTT + bitrate → voiceStore sparkline)
    this.startStatsPoller();

    // Setup push-to-talk if enabled
    this.ptt.setupPTT(this.localStream, this.teamId, this.channelId);

    // Start VAD — use DFN3-processed stream when available so the speaking
    // indicator reflects the cleaned audio, not raw mic noise.
    this.vad.startVAD(this.rawStream, this.localStream, this.localUserId, dfn3ProcessedStream);

    // Send WS join (server will send voice:state + voice:offer back via WS)
    console.log('[Voice] Sending WS voice:join for channel', channelId);
    ws.voiceJoin(teamId, channelId);
  }

  /**
   * Periodically sample RTCStatsReport for round-trip time (active
   * candidate pair) and outbound audio bitrate, push the values to
   * voiceStore so the channel-sidebar voice-dock latency sparkline
   * and bitrate readout can render without each component spinning
   * its own getStats() interval.
   */
  private startStatsPoller(): void {
    if (this.statsPollerId) return; // already running
    const store = useVoiceStore.getState();
    store.resetStatsWindow();
    this.lastBytesSent = 0;
    this.lastBytesSentAt = 0;
    let diagTickCount = 0;
    this.statsPollerId = setInterval(async () => {
      if (!this.pc) return;
      // Hard gate: don't run the poller when not in a voice channel.
      const vs = useVoiceStore.getState();
      if (!vs.connected) return;
      try {
        const report = await this.pc.getStats();
        const { rttMs, bytesSent, perStream, perInbound } = summarizeRtcStats(report);
        diagTickCount = logRtcStreamBreakdown(diagTickCount, perStream, perInbound);
        if (rttMs !== null) this.recordLatency(rttMs);
        if (bytesSent !== null) this.recordBitrateSample(bytesSent);
      } catch {
        /* ignore stats errors; will retry next tick */
      }
    }, 250);
  }

  /** Push a new RTT sample into the voice store + mirror to peerLatencies
   *  and broadcast via WS so other clients see our per-user latency. */
  private recordLatency(rttMs: number): void {
    const s = useVoiceStore.getState();
    s.pushLatencySample(rttMs);
    if (this.localUserId) s.setPeerLatency(this.localUserId, rttMs);
    if (this.teamId && this.channelId) {
      ws.voiceLatency(this.teamId, this.channelId, rttMs);
    }
  }

  /** Compute outgoing-bitrate (kbps) from a fresh bytesSent reading +
   *  the previous bytesSent watermark, push the sample, advance the
   *  watermark. */
  private recordBitrateSample(bytesSent: number): void {
    const now = performance.now();
    if (this.lastBytesSentAt && bytesSent >= this.lastBytesSent) {
      const dt = (now - this.lastBytesSentAt) / 1000; // seconds
      const dBytes = bytesSent - this.lastBytesSent;
      if (dt > 0) {
        const kbps = Math.round((dBytes * 8) / 1000 / dt);
        useVoiceStore.getState().pushBitrateSample(kbps);
      }
    }
    this.lastBytesSent = bytesSent;
    this.lastBytesSentAt = now;
  }

  private stopStatsPoller(): void {
    if (this.statsPollerId) {
      clearInterval(this.statsPollerId);
      this.statsPollerId = null;
    }
    this.lastBytesSent = 0;
    this.lastBytesSentAt = 0;
  }

  /** Re-pin every transceiver to its intended direction after a remote
   *  offer landed (Chrome mirrors the offer's literal direction onto
   *  matched transceivers, clobbering bound sendonly slots → senders
   *  end up a=inactive in our answer otherwise). */
  private repinTransceiverDirections(): void {
    if (!this.pc) return;
    for (const tx of this.pc.getTransceivers()) {
      if (tx.currentDirection === 'stopped') continue;
      if (tx.sender.track && tx.direction !== 'sendonly') {
        try {
          tx.direction = 'sendonly';
          console.log('[Voice/diag] re-pin sendonly:', { mid: tx.mid, kind: tx.sender.track.kind });
        } catch { /* read-only in some states */ }
        continue;
      }
      if (!tx.sender.track && tx.receiver.track && tx.direction !== 'recvonly') {
        try {
          tx.direction = 'recvonly';
          console.log('[Voice/diag] re-pin recvonly:', { mid: tx.mid, kind: tx.receiver.track.kind });
        } catch { /* read-only in some states */ }
      }
    }
  }

  /** Re-attach cam/screen tracks to senders whose `.track` Chrome cleared
   *  on the new offer's transceiver re-mirror. */
  private async reattachOwnedTracks(): Promise<void> {
    const reattach = async (sender: RTCRtpSender | null, track: MediaStreamTrack | null | undefined, label: string) => {
      if (!sender || !track || sender.track === track) return;
      try {
        await sender.replaceTrack(track);
        const tx = this.pc?.getTransceivers().find((t) => t.sender === sender);
        if (tx) {
          try { tx.direction = 'sendonly'; } catch { /* read-only */ }
        }
        console.log('[Voice/diag] re-attach', label, '→ sender (track was cleared by Chrome on remote offer)');
      } catch (err) {
        console.warn('[Voice/diag] re-attach', label, 'failed:', err);
      }
    };
    await reattach(this.webcamSender, this.webcamStream?.getVideoTracks()[0], 'cam');
    await reattach(this.screenSender, this.screenStream?.getVideoTracks()[0], 'screen');
  }

  /** Bind pending cam/screen tracks to whichever fresh transceiver the
   *  server's offer just added. Required because Chrome mirrors the
   *  offer direction literally — the new slot starts recvonly so we
   *  must flip + attach BEFORE createAnswer. */
  private async preBindPendingVideoTracks(knownMidsBefore: Set<string>): Promise<void> {
    if (!this.pc) return;
    const pendingPairs: Array<{ kind: 'cam' | 'screen'; track: MediaStreamTrack }> = [];
    if (this.pendingCamTrack) pendingPairs.push({ kind: 'cam', track: this.pendingCamTrack });
    if (this.pendingScreenTrack) pendingPairs.push({ kind: 'screen', track: this.pendingScreenTrack });
    for (const pending of pendingPairs) {
      if (pending.track.readyState !== 'live') {
        if (pending.kind === 'cam') this.pendingCamTrack = null;
        else this.pendingScreenTrack = null;
        continue;
      }
      const target = this.pc.getTransceivers().find((tx) => {
        if (tx.currentDirection === 'stopped') return false;
        if (tx.sender.track) return false;
        if (tx.receiver.track?.kind !== 'video') return false;
        if (!tx.mid || knownMidsBefore.has(tx.mid)) return false;
        return true;
      });
      if (target) {
        try { target.direction = 'sendonly'; } catch { /* read-only */ }
        await target.sender.replaceTrack(pending.track);
        if (pending.kind === 'screen') {
          this.screenSender = target.sender;
          this.pendingScreenTrack = null;
        } else {
          this.webcamSender = target.sender;
          this.pendingCamTrack = null;
        }
        console.log('[Voice/diag] pre-bind:', pending.kind, '→ transceiver', { mid: target.mid, dir: target.direction });
      }
    }
  }

  /** Flush any ICE candidates that arrived before setRemoteDescription. */
  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc) return;
    for (const c of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn('[WebRTC] pending ICE flush failed:', e);
      }
    }
    this.pendingCandidates = [];
  }

  /** Handle a single voice:offer payload through the offer queue. */
  private async handleVoiceOffer(payload: { sdp: string }): Promise<void> {
    if (!this.pc) return;
    if (this.pc.signalingState === 'closed') return;
    try {
      console.log('[Voice/diag] offer SDP m-lines:', this.summariseSdp(payload.sdp));
      const knownMidsBefore = new Set(
        this.pc.getTransceivers().map((t) => t.mid).filter((m): m is string => !!m),
      );
      const desc: RTCSessionDescriptionInit = { type: 'offer', sdp: payload.sdp };
      await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
      this.diagSnapshot('after setRemoteDescription(offer)');
      if (this.pc.signalingState !== 'have-remote-offer') return;
      this.remoteDescSet = true;
      await this.flushPendingIceCandidates();
      this.repinTransceiverDirections();
      await this.reattachOwnedTracks();
      await this.preBindPendingVideoTracks(knownMidsBefore);

      const answer = await this.pc.createAnswer();
      if (this.pc.signalingState !== 'have-remote-offer') return;
      await this.pc.setLocalDescription(answer);
      this.diagSnapshot('after setLocalDescription(answer)');
      console.log('[Voice/diag] answer SDP m-lines:', this.summariseSdp(answer.sdp ?? ''));
      if (this.teamId && this.channelId && answer) {
        ws.voiceAnswer(this.teamId, this.channelId, answer);
      }
    } catch (err) {
      console.error('[WebRTC] Failed to handle offer:', err);
    }
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

    // Safety net: if `connected` flips to false while we still have
    // a peer connection alive (logout, force-disconnect, etc.), tear
    // EVERYTHING down. Guarded by `disconnecting` so multiple
    // subscriptions (HMR / repeat connect cycles) can't fire
    // overlapping disconnects in a tight loop — log spam was 30+
    // 'connected → false with live pc' lines in one ms.
    let wasConnected = useVoiceStore.getState().connected;
    let disconnecting = false;
    const unsubConnected = useVoiceStore.subscribe((state) => {
      if (wasConnected && !state.connected && this.pc && !disconnecting) {
        disconnecting = true;
        console.warn('[Voice/diag] connected → false with live pc, forcing disconnect');
        this.disconnect()
          .catch((err) => console.error('[Voice] force-disconnect failed:', err))
          .finally(() => { disconnecting = false; });
      }
      wasConnected = state.connected;
    });
    this.storeUnsubscribers.push(unsubConnected);
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

    // voiceOccupants is the source of truth the channel sidebar reads
    // from when it renders the per-user state pills (mic/headphone/
    // cam/screen). The store's `peers` map and `voiceOccupants` map
    // can drift apart because most updates only touch peers — mirror
    // the same field onto every occupant entry the user appears in,
    // so the sidebar reacts to flag flips in real time instead of
    // showing the snapshot from voice:state.
    const mirrorOccupantFlag = (
      userId: string,
      patch: Partial<{ muted: boolean; deafened: boolean; speaking: boolean; webcam_sharing: boolean; screen_sharing: boolean }>,
    ) => {
      const s = store();
      const occ = s.voiceOccupants;
      const next: typeof occ = {};
      let changed = false;
      for (const [chId, list] of Object.entries(occ)) {
        let listChanged = false;
        const nextList = list.map((p) => {
          if (p.user_id !== userId) return p;
          for (const k of Object.keys(patch) as Array<keyof typeof patch>) {
            if ((p as unknown as Record<string, unknown>)[k as string] !== patch[k]) {
              listChanged = true;
              break;
            }
          }
          return listChanged ? { ...p, ...patch } : p;
        });
        if (listChanged) {
          next[chId] = nextList;
          changed = true;
        } else {
          next[chId] = list;
        }
      }
      if (changed) s.setVoiceOccupants(next);
    };

    this.unsubscribers.push(
      ws.on('ws:disconnected', ({ teamId }: { teamId: string }) => {
        // Voice WS for our team just dropped. Reconnect logic will
        // retry, but during the gap our screen-share / webcam tracks
        // would otherwise keep capturing — and on reconnect the
        // server has no idea we were sharing, so the OS-level banner
        // ends up orphaned. Stop the media tracks immediately; the
        // user can re-enable them after reconnect.
        if (teamId !== this.teamId) return;
        if (this.screenStream) {
          this.screenStream.getTracks().forEach((t) => t.stop());
          this.screenStream = null;
          this.screenSender = null;
          const vs = useVoiceStore.getState();
          vs.setLocalScreenStream(null);
          vs.setScreenSharing(false);
        }
        if (this.webcamStream) {
          this.webcamStream.getTracks().forEach((t) => t.stop());
          this.webcamStream = null;
          this.webcamSender = null;
          const vs = useVoiceStore.getState();
          vs.setLocalWebcamStream(null);
          vs.setWebcamSharing(false);
        }
      }),
      ws.on('voice:offer', (payload: { sdp: string; channel_id?: string }) => {
        this.diagSnapshot('voice:offer received');
        this.offerQueue = this.offerQueue
          .then(() => this.handleVoiceOffer(payload))
          .catch((err) => {
            // Defensive: don't let one failure poison the chain.
            console.error('[WebRTC] offer queue error:', err);
          });
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
        const s = store();
        s.removePeer(payload.user_id);
        // Drop any media streams the departing user was sourcing —
        // without this the receivers keep rendering a frozen "last
        // frame" (or a black tile) after the sender disappears.
        s.setRemoteWebcamStream(payload.user_id, null);
        // Always drop the user's screen stream (per-user keyed map).
        s.setRemoteScreenStream(payload.user_id, null);
        if (s.screenSharingUserId === payload.user_id) {
          s.setScreenSharingUserId(null);
        }
        voiceIsoTearDownPeer(payload.user_id);
        if (payload.user_id !== this.localUserId) playLeaveSound();
      }),
      ws.on('voice:speaking', (payload: { user_id: string; speaking: boolean }) => {
        store().updatePeer(payload.user_id, { speaking: payload.speaking });
        mirrorOccupantFlag(payload.user_id, { speaking: payload.speaking });
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

          // Server-confirmed join: flip from `connecting` to `connected`
          // only when this voice:state actually lists us in the room.
          // Until then, the optimistic UI from joinChannel renders self
          // as a peer but the store stays in `connecting` so timeouts
          // and force-disconnects still work.
          const s = store();
          if (
            this.localUserId &&
            s.connecting &&
            payload.peers.some((p) => p.user_id === this.localUserId)
          ) {
            s.setConnected(true, this.channelId ?? undefined, this.teamId ?? undefined);
            s.setConnecting(false);
          }

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
          console.log('[Voice] voice:key-distribute received from', payload.sender_id,
            'e2eEnabled=', this.encryption.e2eEnabled,
            'localUserId=', this.localUserId,
            'recipients=', Object.keys(payload.encrypted_keys ?? {}));
          if (!this.encryption.e2eEnabled || !this.localUserId) {
            console.warn('[Voice] dropping voice key — e2eEnabled or localUserId missing');
            return;
          }
          const myKey = payload.encrypted_keys[this.localUserId];
          if (!myKey) {
            console.warn('[Voice] voice key payload has no entry for me', this.localUserId, 'available=', Object.keys(payload.encrypted_keys ?? {}));
            return;
          }
          await this.encryption.handleReceivedVoiceKey(
            payload.sender_id,
            payload.key_id,
            myKey,
            this.teamId,
            this.channelId,
          );
        },
      ),
      ws.on(
        'voice:mute-update',
        (payload: { user_id: string; muted: boolean; deafened: boolean }) => {
          store().updatePeer(payload.user_id, {
            muted: payload.muted,
            deafened: payload.deafened,
          });
          mirrorOccupantFlag(payload.user_id, {
            muted: payload.muted,
            deafened: payload.deafened,
          });
          // Server-driven mute targeting ME — typically the result of an
          // admin's voice:force-mute. Kill the mic hardware-side so the
          // OS indicator goes dark, not just the UI badge. We only
          // ENFORCE the mute direction; unmuting stays a user choice so
          // an admin can't keep someone's mic hot against their will.
          if (
            payload.user_id === this.localUserId &&
            payload.muted &&
            !useVoiceStore.getState().muted
          ) {
            this.toggleMute().catch((err) =>
              console.error('[Voice] force-mute apply failed:', err),
            );
            globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
              channel: '', author: 'admin',
              text: 'You were server-muted by a moderator.',
              duration: 5000,
            }}));
          }
        },
      ),
      ws.on('voice:screen-update', (payload: { user_id: string; sharing: boolean }) => {
        const s = store();
        s.updatePeer(payload.user_id, { screen_sharing: payload.sharing });
        mirrorOccupantFlag(payload.user_id, { screen_sharing: payload.sharing });
        if (payload.sharing) {
          s.setScreenSharingUserId(payload.user_id);
        } else {
          // Always drop THIS user's screen stream from the per-user
          // map (own echo doesn't matter — we don't have an entry
          // for ourselves there anyway). Only clear the global
          // "primary sharer" pointer if it was pointing at this
          // user; if another peer is still sharing, leave it.
          s.setRemoteScreenStream(payload.user_id, null);
          if (s.screenSharingUserId === payload.user_id) {
            // Promote any remaining active sharer to the primary
            // slot for auto-focus. Pick deterministically by user_id
            // sort.
            const stillSharing = Object.values(s.peers)
              .filter((p) => p.screen_sharing && p.user_id !== payload.user_id)
              .map((p) => p.user_id)
              .sort((a, b) => a.localeCompare(b));
            s.setScreenSharingUserId(stillSharing[0] ?? null);
          }
        }
      }),
      ws.on('voice:webcam-update', (payload: { user_id: string; sharing: boolean }) => {
        store().updatePeer(payload.user_id, { webcam_sharing: payload.sharing });
        mirrorOccupantFlag(payload.user_id, { webcam_sharing: payload.sharing });
        if (!payload.sharing) {
          store().setRemoteWebcamStream(payload.user_id, null);
        }
      }),
      ws.on('voice:latency-update', (payload: { user_id: string; latency_ms: number }) => {
        // Server is just forwarding what a peer published. Each peer
        // is the source of truth for its own RTT to the SFU.
        store().setPeerLatency(payload.user_id, payload.latency_ms);
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
    this.stopStatsPoller();
    useVoiceStore.getState().resetStatsWindow();

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
    this.peerIdByStreamId.clear();

    // Tear down DFN3 voice-isolation pipelines (per-peer + outgoing),
    // terminate the inference worker, and close its audio context. The
    // next voice join will lazy-reinit from scratch.
    voiceIsoTearDownAll();
    this.voiceIsolationContext = null;

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

  /** Toggle hardware mute — stops the mic track entirely on mute,
   *  re-acquires on unmute. This turns off the OS mic indicator. */
  async toggleMute(): Promise<boolean> {
    // PTT mode: toggleMute is a no-op
    if (useAudioSettingsStore.getState().pushToTalk) return false;

    // Allow toggling mute even when not in a voice channel (pre-set state)
    if (!this.pc) {
      const store = useVoiceStore.getState();
      const newMuted = !store.muted;
      store.setMuted(newMuted);
      return newMuted;
    }

    const store = useVoiceStore.getState();
    const wasMuted = store.muted;

    if (!wasMuted) {
      // MUTE: stop raw mic track to release hardware
      if (this.rawStream) {
        this.rawStream.getTracks().forEach((t) => t.stop());
      }
      // Stop VAD so it doesn't try to read a dead stream
      this.vad.stopVAD();
      // Clear per-peer speaking state for the local user
      if (this.localUserId && store.peers[this.localUserId]) {
        store.updatePeer(this.localUserId, { voiceLevel: 0, speaking: false });
      }
      // Tear down the DFN3 outgoing pipeline so it stops processing silence
      voiceIsoTearDownOutgoing();

      // Replace the sender's track with null (sends silence)
      const sender = this.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(null);
      }
    } else {
      // UNMUTE: re-acquire mic and rebuild audio graph
      try {
        const audioSettings = useAudioSettingsStore.getState();
        const deviceId = useUserSettingsStore.getState().selectedInputDevice;
        const audioConstraints = audioSettings.getAudioConstraints(deviceId);
        this.rawStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });

        // Rebuild gain node pipeline
        const ctx = this.vad.getAudioContext();
        const source = ctx.createMediaStreamSource(this.rawStream);
        const gainNode = ctx.createGain();
        gainNode.gain.value = useUserSettingsStore.getState().inputVolume;
        this.gainNode = gainNode;
        const destination = ctx.createMediaStreamDestination();
        source.connect(gainNode);
        gainNode.connect(destination);
        this.localStream = destination.stream;

        // Replace sender track with new processed audio, wrapping through
        // DFN3 if voice isolation is active.
        let newTrack: MediaStreamTrack | undefined = this.localStream.getAudioTracks()[0];
        if (
          newTrack &&
          this.voiceIsolationContext &&
          useAudioSettingsStore.getState().noiseSuppressionMode === 'dfn3'
        ) {
          newTrack = voiceIsoProcessOutgoing(this.voiceIsolationContext, newTrack);
        }
        const sender = this.pc.getSenders().find((s) => s.track === null || s.track?.kind === 'audio');
        if (sender && newTrack) {
          await sender.replaceTrack(newTrack);
        }

        // Restart VAD — use DFN3-processed stream when available
        const processedStream = newTrack && newTrack !== this.localStream.getAudioTracks()[0]
          ? new MediaStream([newTrack])
          : null;
        this.vad.startVAD(this.rawStream, this.localStream, this.localUserId, processedStream);

        store.setLocalStream(this.localStream);
      } catch (err) {
        console.error('[Voice] Failed to re-acquire mic:', err);
        return true; // stay muted
      }
    }

    const muted = !wasMuted;
    // The connected path used to broadcast voice:mute-update to peers
    // but never wrote the new value back to the local store — so
    // remote clients saw 'muted' while the local UI button stayed in
    // the previous state. Set it here so the dock button (bound to
    // useVoiceStore.muted) reflects reality.
    store.setMuted(muted);
    if (this.teamId && this.channelId) {
      ws.voiceMute(this.teamId, this.channelId, muted);
    }
    return muted;
  }

  async toggleDeafen(): Promise<boolean> {
    const store = useVoiceStore.getState();
    const deafened = !store.deafened;

    // Allow toggling deafen even when not in a voice channel (pre-set state)
    if (!this.pc) {
      store.setDeafened(deafened);
      if (deafened) store.setMuted(true);
      return deafened;
    }

    // Mute all remote audio
    for (const stream of this.remoteStreams.values()) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !deafened;
      }
    }
    // Deafen also hardware-mutes the mic (same as toggleMute)
    if (deafened && !store.muted) {
      if (this.rawStream) {
        this.rawStream.getTracks().forEach((t) => t.stop());
      }
      this.vad.stopVAD();
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(null);
      }
    }
    // Mirror the new state into the store so the dock button reflects
    // it locally. Deafen implies mute on the mic, so set both if we
    // just turned deafen on.
    store.setDeafened(deafened);
    if (deafened) store.setMuted(true);
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

    // Bump the generation counter. Anything else that bumps it (a
    // stop, or another start) invalidates us. Snapshot on entry and
    // check after each await — if it's moved, abort and drop the
    // resources we acquired so we don't re-enable a share the user
    // already turned off.
    const myGen = ++this.screenOpGen;
    const stale = () => this.screenOpGen !== myGen;

    let acquiredStream: MediaStream;
    try {
      acquiredStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (err) {
      console.error('[Voice] getDisplayMedia failed:', err);
      throw new Error('Screen sharing cancelled or denied');
    }
    if (stale()) {
      console.log('[Voice/diag] startScreenShare: superseded after getDisplayMedia, dropping');
      acquiredStream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.screenStream = acquiredStream;

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

    console.log('[Voice/diag] startScreenShare — track', { id: videoTrack.id, kind: videoTrack.kind, label: videoTrack.label, readyState: videoTrack.readyState, enabled: videoTrack.enabled });
    this.diagSnapshot('startScreenShare: before voiceScreenStart');
    // Queue the track so the offer-queue handler binds it to the
    // new transceiver BEFORE createAnswer (otherwise the answer
    // becomes a=inactive and the encoder never produces frames —
    // see the offer/answer pre-bind logic in setupWSListeners).
    this.pendingScreenTrack = videoTrack;
    ws.voiceScreenStart(this.teamId, this.channelId);
    await this.waitForSignalingStable(3000);
    if (stale()) {
      console.log('[Voice/diag] startScreenShare: superseded after signaling stable, dropping');
      // The stop that bumped the gen already cleared local state and
      // told the server; don't fight it.
      return;
    }
    this.diagSnapshot('startScreenShare: after signaling stable');

    if (this.screenSender) {
      // High priority so the BWE allocator favors the screen over the cam
      // when both are sending; no maxBitrate cap, the encoder targets
      // whatever the network can sustain.
      await this.setSenderEncoding(this.screenSender, 'maintain-resolution', 'high');
      console.log('[Voice/diag] startScreenShare: sender params after setParameters', this.screenSender.getParameters());
    } else {
      console.warn('[Voice/diag] startScreenShare: pre-bind never landed — screen will not flow');
    }
  }

  /** Heavy diagnostic snapshot of the PC state — every transceiver's
   *  direction, currentDirection, mid, sender track id/kind/readyState
   *  and receiver track id/kind/readyState. Used to chase track-flow
   *  bugs in the multi-peer multi-video matrix where reasoning about
   *  what the PC actually thinks is going on becomes the hard part. */
  private diagSnapshot(label: string): void {
    if (!this.pc) {
      console.log('[Voice/diag]', label, '— pc is null');
      return;
    }
    const txs = this.pc.getTransceivers().map((tx, i) => ({
      i,
      mid: tx.mid,
      dir: tx.direction,
      cur: tx.currentDirection,
      stopped: tx.currentDirection === 'stopped',
      sendKind: tx.sender.track?.kind,
      sendTrack: tx.sender.track?.id,
      sendReady: tx.sender.track?.readyState,
      sendMuted: tx.sender.track?.muted,
      sendEnabled: tx.sender.track?.enabled,
      recvKind: tx.receiver.track?.kind,
      recvTrack: tx.receiver.track?.id,
      recvReady: tx.receiver.track?.readyState,
      recvMuted: tx.receiver.track?.muted,
    }));
    console.log(
      '[Voice/diag]', label,
      `\n  signalingState=${this.pc.signalingState}`,
      `connectionState=${this.pc.connectionState}`,
      `iceConnectionState=${this.pc.iceConnectionState}`,
      '\n  transceivers:', txs,
    );
  }

  /** Compact one-line summary of an SDP's m-lines for log readability. */
  private summariseSdp(sdp: string): string {
    return sdp
      .split('\n')
      .filter((l) => l.startsWith('m=') || /^a=(mid|sendrecv|sendonly|recvonly|inactive|msid)/.test(l))
      .map((l) => l.trim())
      .join(' | ');
  }

  /** Wait until the PC's signaling state goes through a renegotiation
   *  and lands back on 'stable'. Specifically: catches the next
   *  have-remote-offer → stable transition, so the caller knows the
   *  server's renegotiation finished before they do further work
   *  (like addTrack) that could race the negotiation. */
  private waitForSignalingStable(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) return resolve();
      const t0 = performance.now();
      let sawRemoteOffer = this.pc.signalingState !== 'stable';
      const tick = () => {
        if (!this.pc) return resolve();
        if (this.pc.signalingState !== 'stable') sawRemoteOffer = true;
        if (sawRemoteOffer && this.pc.signalingState === 'stable') return resolve();
        if (performance.now() - t0 > timeoutMs) return resolve();
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  async stopScreenShare(): Promise<void> {
    console.log('[Voice/diag] stopScreenShare — track', this.screenStream?.getTracks()[0]?.id ?? 'none', 'sender', !!this.screenSender);
    // Bump the generation — any in-flight startScreenShare snapshots
    // a smaller value and will abort on its next stale() check.
    this.screenOpGen++;
    // Drop any queued pending track from a start that didn't bind yet
    // — otherwise a quick start→stop leaves a stale entry that would
    // get bound on the next unrelated offer.
    this.pendingScreenTrack = null;
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

    // Clear LOCAL state only. Remote sharers live in the per-user
    // remoteScreenStreams map (managed by voice:screen-update / WS
    // handlers) — we never touch their entries here. For the global
    // "primary sharer" pointer, only nudge it off ourselves if it's
    // currently us; promote a remaining sharer if any. Mirrors the
    // post-clear logic in the voice:screen-update handler.
    const store = useVoiceStore.getState();
    store.setScreenSharing(false);
    store.setLocalScreenStream(null);
    if (store.screenSharingUserId === this.localUserId) {
      const stillSharing = Object.values(store.peers)
        .filter((p) => p.screen_sharing && p.user_id !== this.localUserId)
        .map((p) => p.user_id)
        .sort((a, b) => a.localeCompare(b));
      store.setScreenSharingUserId(stillSharing[0] ?? null);
    }
  }

  isScreenSharing(): boolean {
    return this.screenStream !== null;
  }

  async startWebcam(): Promise<void> {
    if (!this.pc || !this.teamId || !this.channelId) {
      throw new Error('Not connected to a voice channel');
    }

    // See startScreenShare for the rationale — generation guard
    // protects against a rapid OFF coming in mid-getUserMedia.
    const myGen = ++this.camOpGen;
    const stale = () => this.camOpGen !== myGen;

    let acquiredStream: MediaStream;
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        video: {
          aspectRatio: 16 / 9,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (err) {
      console.error('[Voice] getUserMedia (webcam) failed:', err);
      throw new Error('Webcam access denied');
    }
    if (stale()) {
      console.log('[Voice/diag] startWebcam: superseded after getUserMedia, dropping');
      acquiredStream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.webcamStream = acquiredStream;

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

    console.log('[Voice/diag] startWebcam — track', { id: videoTrack.id, kind: videoTrack.kind, label: videoTrack.label, readyState: videoTrack.readyState, enabled: videoTrack.enabled });
    this.diagSnapshot('startWebcam: before voiceWebcamStart');
    this.pendingCamTrack = videoTrack;
    ws.voiceWebcamStart(this.teamId, this.channelId);
    await this.waitForSignalingStable(3000);
    if (stale()) {
      console.log('[Voice/diag] startWebcam: superseded after signaling stable, dropping');
      return;
    }
    this.diagSnapshot('startWebcam: after signaling stable');

    if (this.webcamSender) {
      // Low priority so the allocator favors the screen when both are
      // sending; no maxBitrate cap. Cam stays smooth (face) by dropping
      // resolution under load.
      await this.setSenderEncoding(this.webcamSender, 'maintain-framerate', 'low');
      console.log('[Voice/diag] startWebcam: sender params after setParameters', this.webcamSender.getParameters());
    } else {
      console.warn('[Voice/diag] startWebcam: pre-bind never landed — cam will not flow');
    }
  }

  /** Set degradation preference and priority on a sender. Priority hints
   *  tell WebRTC's bandwidth allocator how to divide estimated capacity
   *  between simultaneous tracks — without this, two video senders are
   *  treated equally and the screen-share can be starved by the cam
   *  (visible as: screen-share doesn't actually flow until the cam is
   *  turned off). No maxBitrate is applied — the encoder targets whatever
   *  the network can sustain via REMB/TWCC feedback. */
  private async setSenderEncoding(
    sender: RTCRtpSender,
    degradationPreference: 'maintain-framerate' | 'maintain-resolution' | 'balanced',
    priority: 'very-low' | 'low' | 'medium' | 'high',
  ): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      // Explicitly clear any previously-set cap so a per-session
      // change from a capped binary leaves the encoder uncapped.
      params.encodings[0].maxBitrate = undefined;
      params.encodings[0].priority = priority;
      params.encodings[0].networkPriority = priority;
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        degradationPreference;
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[Voice] setParameters failed:', err);
    }
  }

  async stopWebcam(): Promise<void> {
    console.log('[Voice/diag] stopWebcam — track', this.webcamStream?.getTracks()[0]?.id ?? 'none', 'sender', !!this.webcamSender);
    // Bump the generation — any in-flight startWebcam aborts on
    // its next stale() check (see startWebcam).
    this.camOpGen++;
    // Drop any queued pending track from a start that didn't bind yet.
    this.pendingCamTrack = null;
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
