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
    this.statsPollerId = setInterval(async () => {
      if (!this.pc) return;
      try {
        const report = await this.pc.getStats();
        let rttMs: number | null = null;
        let bytesSent: number | null = null;
        report.forEach((stat) => {
          // currentRoundTripTime lives on the *succeeded* candidate
          // pair. nominated is the one actively in use.
          if (
            stat.type === 'candidate-pair' &&
            (stat as { state?: string; nominated?: boolean }).state === 'succeeded' &&
            (stat as { nominated?: boolean }).nominated &&
            typeof (stat as { currentRoundTripTime?: number }).currentRoundTripTime === 'number'
          ) {
            rttMs = Math.round((stat as { currentRoundTripTime: number }).currentRoundTripTime * 1000);
          }
          // Sum bytes across ALL outbound RTP streams (audio + video
          // when webcam/screen share are active) so the bitrate card
          // reflects total upstream media bandwidth, not just the mic.
          if (
            stat.type === 'outbound-rtp' &&
            typeof (stat as { bytesSent?: number }).bytesSent === 'number'
          ) {
            bytesSent = (bytesSent ?? 0) + (stat as { bytesSent: number }).bytesSent;
          }
        });

        if (rttMs !== null) {
          const s = useVoiceStore.getState();
          s.pushLatencySample(rttMs);
          // Mirror into peerLatencies under our own user id so the
          // self card reads the same map as the remote cards do —
          // single source of truth for per-user RTT.
          if (this.localUserId) s.setPeerLatency(this.localUserId, rttMs);
          // Tell other clients about our latency so their cards can
          // render real per-user RTT (not just their own). The
          // server rebroadcasts with our user_id stamped in.
          if (this.teamId && this.channelId) {
            ws.voiceLatency(this.teamId, this.channelId, rttMs);
          }
        }

        // Bitrate from outbound-rtp byte delta over the poll interval.
        if (bytesSent !== null) {
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
      } catch {
        /* ignore stats errors; will retry next tick */
      }
    }, 600);
  }

  private stopStatsPoller(): void {
    if (this.statsPollerId) {
      clearInterval(this.statsPollerId);
      this.statsPollerId = null;
    }
    this.lastBytesSent = 0;
    this.lastBytesSentAt = 0;
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
        // Chain onto the offer queue so two close-together offers
        // can't interleave their await points. Each offer waits for
        // the previous one's setLocalDescription to land before its
        // own setRemoteDescription runs.
        this.offerQueue = this.offerQueue.then(async () => {
          if (!this.pc) return;
          // signalingState !== 'stable' means we're already mid-
          // negotiation — abandon the older offer and let this one
          // run. Anything else (closed, etc.) bails out cleanly.
          if (this.pc.signalingState === 'closed') return;
          try {
            const desc: RTCSessionDescriptionInit = { type: 'offer', sdp: payload.sdp };
            await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
            // If a second offer arrived during the await above, the
            // pc state may have moved on. Skip the rest so we don't
            // build an answer for a description that's no longer
            // current — the next queue tick will handle the newer
            // offer.
            if (this.pc.signalingState !== 'have-remote-offer') return;
            this.remoteDescSet = true;
            for (const c of this.pendingCandidates) {
              try {
                await this.pc.addIceCandidate(new RTCIceCandidate(c));
              } catch (e) {
                console.warn('[WebRTC] pending ICE flush failed:', e);
              }
            }
            this.pendingCandidates = [];
            const answer = await this.pc.createAnswer();
            // Same check again — state can advance during createAnswer.
            if (this.pc.signalingState !== 'have-remote-offer') return;
            await this.pc.setLocalDescription(answer);
            if (this.teamId && this.channelId && answer) {
              ws.voiceAnswer(this.teamId, this.channelId, answer);
            }
          } catch (err) {
            console.error('[WebRTC] Failed to handle offer:', err);
          }
        }).catch((err) => {
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
        store().removePeer(payload.user_id);
        voiceIsoTearDownPeer(payload.user_id);
        if (payload.user_id !== this.localUserId) playLeaveSound();
      }),
      ws.on('voice:speaking', (payload: { user_id: string; speaking: boolean }) => {
        const s = store();
        s.updatePeer(payload.user_id, { speaking: payload.speaking });
        // voiceOccupants is a separate source of truth for the
        // channel sidebar's participant rows — mirror the speaking
        // flag there so non-self users light up too.
        const occ = s.voiceOccupants;
        const next: typeof occ = {};
        let changed = false;
        for (const [chId, list] of Object.entries(occ)) {
          let listChanged = false;
          const nextList = list.map((p) => {
            if (p.user_id !== payload.user_id) return p;
            if (p.speaking === payload.speaking) return p;
            listChanged = true;
            return { ...p, speaking: payload.speaking };
          });
          if (listChanged) {
            next[chId] = nextList;
            changed = true;
          } else {
            next[chId] = list;
          }
        }
        if (changed) s.setVoiceOccupants(next);
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
            window.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
              channel: '', author: 'admin',
              text: 'You were server-muted by a moderator.',
              duration: 5000,
            }}));
          }
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

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60 },
        },
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
