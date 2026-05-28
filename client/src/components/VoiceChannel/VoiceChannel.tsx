import { useTranslation } from 'react-i18next';
import { useRef, useEffect, useState } from 'react';
import { IconVolume, IconMicrophoneOff, IconHeadphonesOff, IconScreenShare, IconArrowsMinimize, IconArrowsMaximize, IconVideo } from '@tabler/icons-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import './VoiceChannel.css';

interface Props {
  channel: Channel;
}

function VideoPreview({ stream, onClick, className }: Readonly<{ stream: MediaStream; onClick?: () => void; className?: string }>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stats, setStats] = useState<{ w: number; h: number; fps: number } | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let lastFrames = 0;
    let lastTime = performance.now();
    const tick = () => {
      const w = el.videoWidth;
      const h = el.videoHeight;
      const now = performance.now();
      const quality = el.getVideoPlaybackQuality?.();
      const frames = quality?.totalVideoFrames ?? 0;
      const dt = (now - lastTime) / 1000;
      const fps = dt > 0 ? Math.round((frames - lastFrames) / dt) : 0;
      lastFrames = frames;
      lastTime = now;
      if (w > 0 && h > 0) {
        setStats({ w, h, fps });
      }
    };
    const id = globalThis.setInterval(tick, 1000);
    return () => globalThis.clearInterval(id);
  }, [stream]);

  const cls = className ?? 'voice-tile-screen-preview';
  return (
    <div className="video-preview-wrap">
      <video
        ref={videoRef}
        className={cls}
        autoPlay
        playsInline
        muted
        onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      />
      {stats && (
        <div className="video-preview-stats">
          {stats.w}×{stats.h} · {stats.fps}fps
        </div>
      )}
    </div>
  );
}

export default function VoiceChannel({ channel }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId } = useTeamStore();
  const {
    currentChannelId,
    connected,
    connecting,
    peers,
    screenSharingUserId,
    screenSharing,
    webcamSharing,
    remoteScreenStreams,
    localScreenStream,
    localWebcamStream,
    remoteWebcamStreams,
    joinChannel,
    leaveChannel,
  } = useVoiceStore();

  const [fullscreen, setFullscreen] = useState(false);
  const [focusedWebcam, setFocusedWebcam] = useState<string | null>(null);

  const peerList = Object.values(peers);
  const isInThisChannel = connected && currentChannelId === channel.id;
  const teamId = channel.teamId || (channel as unknown as Record<string, unknown>).team_id as string || activeTeamId;

  const sharerUserId = screenSharingUserId;
  let activeScreenStream: MediaStream | null;
  if (screenSharing) {
    activeScreenStream = localScreenStream;
  } else if (sharerUserId) {
    activeScreenStream = remoteScreenStreams[sharerUserId] ?? null;
  } else {
    activeScreenStream = null;
  }
  const sharerName = sharerUserId ? (peers[sharerUserId]?.username ?? 'Someone') : 'You';
  const hasScreenShare = !!(activeScreenStream && (screenSharing || sharerUserId));

  const getWebcamStream = (userId: string): MediaStream | null => {
    if (remoteWebcamStreams[userId]) return remoteWebcamStreams[userId];
    if (webcamSharing && localWebcamStream) return localWebcamStream;
    return null;
  };

  const handleJoinLeave = () => {
    if (isInThisChannel) {
      leaveChannel();
    } else if (teamId) {
      joinChannel(teamId, channel.id);
    }
  };

  // Focus mode without screen share: a single webcam tile fills, others collapse to bottom strip.
  if (focusedWebcam && !hasScreenShare && isInThisChannel) {
    const focusedPeer = peers[focusedWebcam];
    const focusedStream = getWebcamStream(focusedWebcam);
    return (
      <div className="voice-channel-view">
        <div className="screen-share-fullscreen voice-focus-mode">
          <div className="screen-share-header">
            <IconVideo size={16} stroke={1.75} />
            <span className="voice-focus-viewing">
              <span className="voice-focus-dot" /> VIEWING {focusedPeer?.username ?? '...'}
            </span>
            <button className="screen-share-close" onClick={() => setFocusedWebcam(null)}>
              <IconArrowsMinimize size={16} stroke={1.75} />
            </button>
          </div>

          {focusedStream ? (
            <VideoPreview stream={focusedStream} className="fullscreen-focused-video" />
          ) : (
            <div className="voice-focus-no-stream">
              <div className="voice-tile-avatar speaking-ring">
                {(focusedPeer?.username ?? '?').slice(0, 2).toUpperCase()}
              </div>
            </div>
          )}

          {peerList.length > 1 && (
            <div className="fullscreen-thumbnail-bar">
              {peerList.map((peer) => {
                const webcamStream = getWebcamStream(peer.user_id);
                const hasWebcam = !!(peer.webcam_sharing && webcamStream);
                return (
                  <button
                    key={peer.user_id}
                    className={`fullscreen-thumbnail ${peer.speaking ? 'speaking' : ''} ${focusedWebcam === peer.user_id ? 'focused' : ''}`}
                    onClick={() => setFocusedWebcam(peer.user_id)}
                    type="button"
                  >
                    {hasWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="fullscreen-thumbnail-video" />
                    ) : (
                      <div className="fullscreen-thumbnail-avatar">
                        {peer.username.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <span className="fullscreen-thumbnail-name">{peer.username}</span>
                    {peer.muted && <IconMicrophoneOff size={12} stroke={1.75} className="fullscreen-thumbnail-icon" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fullscreen mode: screen share main + webcam thumbnail bar at bottom
  if (fullscreen && hasScreenShare && isInThisChannel) {
    return (
      <div className="voice-channel-view">
        <div className="screen-share-fullscreen">
          <div className="screen-share-header">
            <IconScreenShare size={16} stroke={1.75} />
            <span>{screenSharing ? 'You are sharing your screen' : `${sharerName} is sharing their screen`}</span>
            <button className="screen-share-close" onClick={() => setFullscreen(false)}>
              <IconArrowsMinimize size={16} stroke={1.75} />
            </button>
          </div>

          {/* Focused webcam overlay or screen share */}
          {(() => {
            if (focusedWebcam) {
              return (
                <button className="fullscreen-focused-webcam" onClick={() => setFocusedWebcam(null)} type="button">
                  {(() => { const s = getWebcamStream(focusedWebcam); return s ? (
                    <VideoPreview stream={s} className="fullscreen-focused-video" />
                  ) : null; })()}
                  <div className="fullscreen-focused-name">
                    {peers[focusedWebcam]?.username ?? 'Unknown'}
                    <span className="fullscreen-focused-hint">{t('voice.clickToGoBack', 'Click to go back')}</span>
                  </div>
                </button>
              );
            }
            if (activeScreenStream) {
              return <VideoPreview stream={activeScreenStream} className="screen-share-video" />;
            }
            return null;
          })()}

          {/* Floating webcam thumbnail bar */}
          {peerList.length > 0 && (
            <div className="fullscreen-thumbnail-bar">
              {peerList.map((peer) => {
                const webcamStream = getWebcamStream(peer.user_id);
                const hasWebcam = !!(peer.webcam_sharing && webcamStream);
                return (
                  <button
                    key={peer.user_id}
                    className={`fullscreen-thumbnail ${peer.speaking ? 'speaking' : ''} ${focusedWebcam === peer.user_id ? 'focused' : ''}`}
                    onClick={hasWebcam ? () => setFocusedWebcam(peer.user_id) : undefined}
                    style={hasWebcam ? { cursor: 'pointer' } : undefined}
                    type="button"
                  >
                    {hasWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="fullscreen-thumbnail-video" />
                    ) : (
                      <div className="fullscreen-thumbnail-avatar">
                        {peer.username.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <span className="fullscreen-thumbnail-name">{peer.username}</span>
                    {peer.muted && <IconMicrophoneOff size={12} stroke={1.75} className="fullscreen-thumbnail-icon" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Normal grid view
  return (
    <div className="voice-channel-view">
      <div className="voice-channel-content">
        {isInThisChannel && peerList.length > 0 ? (
          <>
            {/* Screen share as a separate large element at the top */}
            {hasScreenShare && activeScreenStream && (
              <button className="voice-screen-share-banner" onClick={() => setFullscreen(true)} type="button">
                <VideoPreview stream={activeScreenStream} className="voice-screen-share-video" onClick={() => setFullscreen(true)} />
                <div className="voice-screen-share-label">
                  <IconScreenShare size={14} stroke={1.75} />
                  <span>{screenSharing ? 'You' : sharerName} — Screen Share</span>
                </div>
              </button>
            )}

            {/* User tiles grid — webcam replaces avatar */}
            <div className="voice-channel-grid">
              {peerList.map((peer) => {
                const isSharingWebcam = peer.webcam_sharing;
                let webcamStream: MediaStream | null = null;
                if (isSharingWebcam) {
                  webcamStream = remoteWebcamStreams[peer.user_id] ?? (webcamSharing ? localWebcamStream : null);
                }

                const canFocus = isSharingWebcam && webcamStream;
                return (
                  <div
                    key={peer.user_id}
                    className={`voice-tile ${peer.speaking ? 'speaking' : ''} ${isSharingWebcam && webcamStream ? 'has-webcam' : ''}`}
                    style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                  >
                    {isSharingWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="voice-tile-webcam-fill" />
                    ) : (
                      <div className={`voice-tile-avatar ${peer.speaking ? 'speaking-ring' : ''}`}>
                        {peer.username.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    {canFocus && (
                      <button
                        type="button"
                        className="voice-tile-expand-btn"
                        title="Focus this stream"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusedWebcam(peer.user_id);
                        }}
                      >
                        <IconArrowsMaximize size={14} stroke={1.75} />
                      </button>
                    )}
                    <div className="voice-tile-overlay">
                      <div className="voice-tile-name truncate">{peer.username}</div>
                      <div className="voice-tile-icons">
                        {peer.muted && <span title={t('voice.mute')}><IconMicrophoneOff size={16} stroke={1.75} /></span>}
                        {peer.deafened && <span title={t('voice.deafen')}><IconHeadphonesOff size={16} stroke={1.75} /></span>}
                        {peer.screen_sharing && <span title="Sharing screen"><IconScreenShare size={16} stroke={1.75} /></span>}
                        {isSharingWebcam && <span title="Camera on"><IconVideo size={16} stroke={1.75} /></span>}
                        {peer.speaking && <span className="voice-tile-speaking-label">{t('voice.speaking')}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="voice-channel-empty">
            <div className="voice-channel-empty-icon"><IconVolume size={48} stroke={1.5} /></div>
            <h3>{t('voice.noOneHere')}</h3>
            <p>{t('voice.joinPrompt')}</p>
          </div>
        )}

        <div className="voice-channel-actions">
          <button
            className={`voice-channel-btn ${isInThisChannel ? 'leave' : 'join'}`}
            onClick={handleJoinLeave}
            disabled={connecting}
          >
            {(() => {
              if (connecting) return t('voice.connecting');
              if (isInThisChannel) return t('voice.leave');
              return t('voice.join');
            })()}
          </button>
          {isInThisChannel && (
            <div className="voice-channel-participants">
              {t('voice.participants', { count: peerList.length })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
