import { useTranslation } from 'react-i18next';
import { useRef, useEffect, useState } from 'react';
import { SoundHigh, MicrophoneMute, HeadsetWarning, AppWindow, Collapse, VideoCamera } from 'iconoir-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTeamStore, type Channel } from '../../stores/teamStore';

interface Props {
  channel: Channel;
}

function VideoPreview({ stream, onClick, className }: Readonly<{ stream: MediaStream; onClick?: () => void; className?: string }>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      className={className ?? 'w-full aspect-video object-cover rounded-lg bg-surface-tertiary cursor-pointer'}
      autoPlay
      playsInline
      muted
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    />
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
      <div className="flex flex-col flex-1 min-w-0 relative">
        <div className="absolute inset-0 z-20 flex flex-col bg-surface-tertiary" data-testid="screen-share-fullscreen">
          <div className="flex items-center gap-1.5 px-md py-sm text-sm font-medium text-foreground-secondary bg-surface-tertiary shrink-0">
            <AppWindow width={16} height={16} strokeWidth={2} />
            <span>{screenSharing ? 'You are sharing your screen' : `${sharerName} is sharing their screen`}</span>
            <button
              className="ml-auto bg-transparent border-none text-foreground-muted cursor-pointer p-1 rounded-sm flex items-center justify-center hover:text-foreground-primary hover:bg-surface-hover"
              onClick={() => setFullscreen(false)}
              data-testid="screen-share-close"
            >
              <Collapse width={16} height={16} strokeWidth={2} />
            </button>
          </div>

          {/* Focused webcam overlay or screen share */}
          {(() => {
            if (focusedWebcam) {
              return (
                <button
                  className="border-none p-0 font-inherit text-inherit w-full flex-1 flex flex-col items-center justify-center bg-surface-tertiary cursor-pointer min-h-0"
                  onClick={() => setFocusedWebcam(null)}
                  type="button"
                  data-testid="fullscreen-focused-webcam"
                >
                  {(() => { const s = getWebcamStream(focusedWebcam); return s ? (
                    <VideoPreview stream={s} className="max-w-full max-h-full object-contain -scale-x-100" />
                  ) : null; })()}
                  <div className="absolute bottom-[60px] text-white text-base font-medium flex flex-col items-center gap-xs" style={{ textShadow: '0 1px 4px var(--overlay-dark)' }}>
                    {peers[focusedWebcam]?.username ?? 'Unknown'}
                    <span className="text-micro text-foreground-muted">{t('voice.clickToGoBack', 'Click to go back')}</span>
                  </div>
                </button>
              );
            }
            if (activeScreenStream) {
              return <VideoPreview stream={activeScreenStream} className="w-full flex-1 min-h-0 object-contain bg-surface-tertiary" />;
            }
            return null;
          })()}

          {/* Floating webcam thumbnail bar */}
          {peerList.length > 0 && (
            <div className="flex gap-sm px-md py-sm bg-surface-tertiary overflow-x-auto shrink-0 items-center justify-center" data-testid="fullscreen-thumbnail-bar">
              {peerList.map((peer) => {
                const webcamStream = getWebcamStream(peer.user_id);
                const hasWebcam = !!(peer.webcam_sharing && webcamStream);
                return (
                  <button
                    key={peer.user_id}
                    className={`bg-transparent font-inherit text-inherit flex flex-col items-center gap-xs p-xs rounded-lg border-2 border-transparent transition-[border-color,box-shadow] duration-150 ease-linear min-w-[80px] shrink-0 ${peer.speaking ? 'border-status-online shadow-[0_0_8px_var(--success-alpha-40)]' : ''} ${focusedWebcam === peer.user_id ? 'border-brand' : ''}`}
                    onClick={hasWebcam ? () => setFocusedWebcam(peer.user_id) : undefined}
                    style={hasWebcam ? { cursor: 'pointer' } : undefined}
                    type="button"
                    data-testid="fullscreen-thumbnail"
                  >
                    {hasWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="w-[72px] h-[40px] object-cover rounded-sm bg-surface-tertiary -scale-x-100" />
                    ) : (
                      <div className="w-[40px] h-[40px] rounded-full bg-bg-accent text-white flex items-center justify-center text-base font-semibold">
                        {peer.username.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <span className="text-micro text-foreground-secondary max-w-[80px] truncate text-center">{peer.username}</span>
                    {peer.muted && <MicrophoneMute width={12} height={12} strokeWidth={2} className="absolute bottom-0.5 right-0.5 text-foreground-danger" />}
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
    <div className="flex flex-col flex-1 min-w-0 relative">
      <div className="flex-1 flex flex-col items-center justify-center p-2xl gap-xl">
        {isInThisChannel && peerList.length > 0 ? (
          <>
            {/* Screen share as a separate large element at the top */}
            {hasScreenShare && activeScreenStream && (
              <button
                className="border-none p-0 font-inherit text-inherit text-left w-full max-w-[800px] rounded-[12px] overflow-hidden bg-surface-tertiary cursor-pointer relative hover:shadow-[0_0_0_2px_var(--brand)]"
                onClick={() => setFullscreen(true)}
                type="button"
                data-testid="voice-screen-share-banner"
              >
                <VideoPreview stream={activeScreenStream} className="w-full aspect-video object-contain bg-surface-tertiary block" onClick={() => setFullscreen(true)} />
                <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-overlay-heavy text-foreground-secondary text-xs font-medium">
                  <AppWindow width={14} height={14} strokeWidth={2} />
                  <span>{screenSharing ? 'You' : sharerName} — Screen Share</span>
                </div>
              </button>
            )}

            {/* User tiles grid — webcam replaces avatar */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-lg w-full max-w-[800px]">
              {peerList.map((peer) => {
                const isSharingWebcam = peer.webcam_sharing;
                let webcamStream: MediaStream | null = null;
                if (isSharingWebcam) {
                  webcamStream = remoteWebcamStreams[peer.user_id] ?? (webcamSharing ? localWebcamStream : null);
                }

                return (
                  <div
                    key={peer.user_id}
                    className={`voice-tile bg-surface-secondary rounded-[12px] px-lg py-xl flex flex-col items-center gap-sm transition-shadow duration-150 ease-linear relative ${peer.speaking ? 'speaking shadow-[0_0_0_1.5px_var(--status-online)]' : ''}`}
                    style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                    data-testid="voice-tile"
                  >
                    {isSharingWebcam && webcamStream ? (
                      <VideoPreview stream={webcamStream} className="w-16 h-16 rounded-full object-cover bg-surface-tertiary -scale-x-100 shadow-[0_0_0_2px_var(--white-overlay-light)]" />
                    ) : (
                      <div className={`w-16 h-16 rounded-full bg-bg-accent text-white flex items-center justify-center text-[22px] font-semibold shadow-[0_0_0_2px_var(--white-overlay-light)] transition-shadow duration-150 ease-linear ${peer.speaking ? 'speaking-ring' : ''}`} data-testid="voice-tile-avatar">
                        {peer.username.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="text-base font-medium text-foreground-primary text-center max-w-full truncate">{peer.username}</div>
                    <div className="flex gap-1.5 items-center text-base min-h-[20px]">
                      {peer.muted && <span title={t('voice.mute')}><MicrophoneMute width={16} height={16} strokeWidth={2} /></span>}
                      {peer.deafened && <span title={t('voice.deafen')}><HeadsetWarning width={16} height={16} strokeWidth={2} /></span>}
                      {peer.screen_sharing && <span title="Sharing screen"><AppWindow width={16} height={16} strokeWidth={2} /></span>}
                      {isSharingWebcam && <span title="Camera on"><VideoCamera width={16} height={16} strokeWidth={2} /></span>}
                      {peer.speaking && <span className="text-micro text-status-online font-medium">{t('voice.speaking')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-center text-foreground-muted">
            <div className="text-[48px] mb-md"><SoundHigh width={48} height={48} strokeWidth={1.5} /></div>
            <h3 className="text-foreground-primary m-0 mb-sm text-xl">{t('voice.noOneHere')}</h3>
            <p className="m-0 text-base">{t('voice.joinPrompt')}</p>
          </div>
        )}

        <div className="flex flex-col items-center gap-sm">
          <button
            className={`py-2.5 px-8 border-none rounded-sm text-base font-semibold cursor-pointer transition-colors duration-150 text-white ${isInThisChannel ? 'bg-danger hover:bg-foreground-danger' : 'bg-success hover:bg-status-online disabled:opacity-60 disabled:cursor-not-allowed'}`}
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
            <div className="text-xs text-foreground-muted">
              {t('voice.participants', { count: peerList.length })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
