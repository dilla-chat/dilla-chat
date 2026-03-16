import { useTranslation } from 'react-i18next';
import { useRef, useEffect, useState } from 'react';
import { SoundHigh, MicrophoneMute, HeadsetWarning, AppWindow, Collapse, VideoCamera } from 'iconoir-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import './VoiceChannel.css';

interface Props {
  channel: Channel;
}

function VideoPreview({ stream, onClick, className }: { stream: MediaStream; onClick?: () => void; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      className={className ?? 'voice-tile-screen-preview'}
      autoPlay
      playsInline
      muted
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    />
  );
}

export default function VoiceChannel({ channel }: Props) {
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
    remoteScreenStream,
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

  const activeScreenStream = screenSharing ? localScreenStream : remoteScreenStream;
  const sharerUserId = screenSharingUserId;
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

  // Fullscreen mode: screen share main + webcam thumbnail bar at bottom
  if (fullscreen && hasScreenShare && isInThisChannel) {
    return (
      <div className="voice-channel-view">
        <div className="screen-share-fullscreen">
          <div className="screen-share-header">
            <AppWindow width={16} height={16} strokeWidth={2} />
            <span>{screenSharing ? 'You are sharing your screen' : `${sharerName} is sharing their screen`}</span>
            <button className="screen-share-close" onClick={() => setFullscreen(false)}>
              <Collapse width={16} height={16} strokeWidth={2} />
            </button>
          </div>

          {/* Focused webcam overlay or screen share */}
          {focusedWebcam ? (
            <div className="fullscreen-focused-webcam" onClick={() => setFocusedWebcam(null)}>
              {getWebcamStream(focusedWebcam) && (
                <VideoPreview stream={getWebcamStream(focusedWebcam)!} className="fullscreen-focused-video" />
              )}
              <div className="fullscreen-focused-name">
                {peers[focusedWebcam]?.username ?? 'Unknown'}
                <span className="fullscreen-focused-hint">{t('voice.clickToGoBack', 'Click to go back')}</span>
              </div>
            </div>
          ) : activeScreenStream ? (
            <VideoPreview stream={activeScreenStream} className="screen-share-video" />
          ) : null}

          {/* Floating webcam thumbnail bar */}
          {peerList.length > 0 && (
            <div className="fullscreen-thumbnail-bar">
              {peerList.map((peer) => {
                const webcamStream = getWebcamStream(peer.user_id);
                const hasWebcam = !!(peer.webcam_sharing && webcamStream);
                return (
                  <div
                    key={peer.user_id}
                    className={`fullscreen-thumbnail ${peer.speaking ? 'speaking' : ''} ${focusedWebcam === peer.user_id ? 'focused' : ''}`}
                    onClick={hasWebcam ? () => setFocusedWebcam(peer.user_id) : undefined}
                    style={hasWebcam ? { cursor: 'pointer' } : undefined}
                  >
                    {hasWebcam ? (
                      <VideoPreview stream={webcamStream!} className="fullscreen-thumbnail-video" />
                    ) : (
                      <div className="fullscreen-thumbnail-avatar">
                        {peer.username.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <span className="fullscreen-thumbnail-name">{peer.username}</span>
                    {peer.muted && <MicrophoneMute width={12} height={12} strokeWidth={2} className="fullscreen-thumbnail-icon" />}
                  </div>
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
              <div className="voice-screen-share-banner" onClick={() => setFullscreen(true)}>
                <VideoPreview stream={activeScreenStream} className="voice-screen-share-video" onClick={() => setFullscreen(true)} />
                <div className="voice-screen-share-label">
                  <AppWindow width={14} height={14} strokeWidth={2} />
                  <span>{screenSharing ? 'You' : sharerName} — Screen Share</span>
                </div>
              </div>
            )}

            {/* User tiles grid — webcam replaces avatar */}
            <div className="voice-channel-grid">
              {peerList.map((peer) => {
                const isSharingWebcam = peer.webcam_sharing;
                const webcamStream = isSharingWebcam
                  ? (remoteWebcamStreams[peer.user_id] ?? (webcamSharing ? localWebcamStream : null))
                  : null;

                return (
                  <div
                    key={peer.user_id}
                    className={`voice-tile ${peer.speaking ? 'speaking' : ''}`}
                    style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                  >
                    {isSharingWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="voice-tile-webcam-avatar" />
                    ) : (
                      <div className={`voice-tile-avatar ${peer.speaking ? 'speaking-ring' : ''}`}>
                        {peer.username.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="voice-tile-name">{peer.username}</div>
                    <div className="voice-tile-icons">
                      {peer.muted && <span title={t('voice.mute')}><MicrophoneMute width={16} height={16} strokeWidth={2} /></span>}
                      {peer.deafened && <span title={t('voice.deafen')}><HeadsetWarning width={16} height={16} strokeWidth={2} /></span>}
                      {peer.screen_sharing && <span title="Sharing screen"><AppWindow width={16} height={16} strokeWidth={2} /></span>}
                      {isSharingWebcam && <span title="Camera on"><VideoCamera width={16} height={16} strokeWidth={2} /></span>}
                      {peer.speaking && <span className="voice-tile-speaking-label">{t('voice.speaking')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="voice-channel-empty">
            <div className="voice-channel-empty-icon"><SoundHigh width={48} height={48} strokeWidth={1.5} /></div>
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
            {connecting
              ? t('voice.connecting')
              : isInThisChannel
                ? t('voice.leave')
                : t('voice.join')}
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
