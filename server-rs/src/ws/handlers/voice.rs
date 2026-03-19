use crate::ws::events::*;
use crate::ws::hub::Hub;

pub(in crate::ws) async fn handle_voice_join(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    p: VoiceJoinPayload,
) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .add_peer(&p.channel_id, user_id, username, team_id)
            .await;

        hub.subscribe(client_id, &p.channel_id).await;

        // Notify all clients about the join.
        let evt = Event::new(
            EVENT_VOICE_USER_JOINED,
            VoiceUserJoinedPayload {
                channel_id: p.channel_id.clone(),
                user_id: user_id.to_string(),
                username: username.to_string(),
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }

        // Send current voice state to the joining client.
        if let Some(peers) = room_mgr.get_room(&p.channel_id).await {
            let evt = Event::new(
                EVENT_VOICE_STATE,
                VoiceStatePayload {
                    channel_id: p.channel_id.clone(),
                    peers,
                },
            );
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    hub.send_to_user(user_id, data).await;
                }
            }
        }

        // SFU join - create peer connection and send offer.
        if let Some(sfu) = &hub.voice_sfu {
            match sfu.handle_join(&p.channel_id, user_id).await {
                Ok(offer_sdp) => {
                    let evt = Event::new(
                        EVENT_VOICE_OFFER,
                        VoiceOfferPayload {
                            channel_id: p.channel_id.clone(),
                            sdp: offer_sdp,
                        },
                    );
                    if let Ok(evt) = evt {
                        if let Ok(data) = evt.to_bytes() {
                            hub.send_to_user(user_id, data).await;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("voice join failed: {}", e);
                }
            }
        }

        hub.emit_event(crate::ws::hub::HubEvent::VoiceJoined {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            team_id: team_id.to_string(),
        });
    }
}

pub(in crate::ws) async fn handle_voice_leave(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    p: VoiceJoinPayload,
) {
    if let Some(sfu) = &hub.voice_sfu {
        sfu.handle_leave(&p.channel_id, user_id).await;
    }

    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr.remove_peer(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_USER_LEFT,
        VoiceUserLeftPayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    hub.unsubscribe(client_id, &p.channel_id).await;

    hub.emit_event(crate::ws::hub::HubEvent::VoiceLeft {
        channel_id: p.channel_id.clone(),
        user_id: user_id.to_string(),
    });
}

pub(in crate::ws) async fn handle_voice_answer(hub: &Hub, user_id: &str, p: VoiceAnswerPayload) {
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.handle_answer(&p.channel_id, user_id, &p.sdp).await {
            tracing::error!("voice answer failed: {}", e);
        }
    }
}

pub(in crate::ws) async fn handle_voice_ice_candidate(hub: &Hub, user_id: &str, p: VoiceICECandidatePayload) {
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu
            .handle_ice_candidate(&p.channel_id, user_id, &p.candidate, &p.sdp_mid, p.sdp_mline_index)
            .await
        {
            tracing::error!("voice ice candidate failed: {}", e);
        }
    }
}

pub(in crate::ws) async fn handle_voice_mute(hub: &Hub, user_id: &str, p: VoiceMutePayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr.set_muted(&p.channel_id, user_id, p.muted).await;

        let deafened = room_mgr
            .get_room(&p.channel_id)
            .await
            .and_then(|peers| peers.iter().find(|peer| peer.user_id == user_id).map(|peer| peer.deafened))
            .unwrap_or(false);

        let evt = Event::new(
            EVENT_VOICE_MUTE_UPDATE,
            VoiceMuteUpdatePayload {
                channel_id: p.channel_id,
                user_id: user_id.to_string(),
                muted: p.muted,
                deafened,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }
    }
}

pub(in crate::ws) async fn handle_voice_deafen(hub: &Hub, user_id: &str, p: VoiceDeafenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_deafened(&p.channel_id, user_id, p.deafened)
            .await;
        if p.deafened {
            room_mgr.set_muted(&p.channel_id, user_id, true).await;
        }

        let muted = if p.deafened {
            true
        } else {
            room_mgr
                .get_room(&p.channel_id)
                .await
                .and_then(|peers| peers.iter().find(|peer| peer.user_id == user_id).map(|peer| peer.muted))
                .unwrap_or(false)
        };

        let evt = Event::new(
            EVENT_VOICE_MUTE_UPDATE,
            VoiceMuteUpdatePayload {
                channel_id: p.channel_id,
                user_id: user_id.to_string(),
                muted,
                deafened: p.deafened,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }
    }
}

pub(in crate::ws) async fn handle_voice_screen_start(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_screen_sharing(&p.channel_id, user_id, true)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.add_screen_track(&p.channel_id, user_id).await {
            tracing::error!("voice screen start failed: {}", e);
            if let Some(room_mgr) = &hub.voice_room_manager {
                room_mgr
                    .set_screen_sharing(&p.channel_id, user_id, false)
                    .await;
            }
            return;
        }
    }

    let evt = Event::new(
        EVENT_VOICE_SCREEN_UPDATE,
        VoiceScreenUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: true,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

pub(in crate::ws) async fn handle_voice_screen_stop(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_screen_sharing(&p.channel_id, user_id, false)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        let _ = sfu.remove_screen_track(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_SCREEN_UPDATE,
        VoiceScreenUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: false,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

pub(in crate::ws) async fn handle_voice_webcam_start(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_webcam_sharing(&p.channel_id, user_id, true)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.add_webcam_track(&p.channel_id, user_id).await {
            tracing::error!("voice webcam start failed: {}", e);
            if let Some(room_mgr) = &hub.voice_room_manager {
                room_mgr
                    .set_webcam_sharing(&p.channel_id, user_id, false)
                    .await;
            }
            return;
        }
    }

    let evt = Event::new(
        EVENT_VOICE_WEBCAM_UPDATE,
        VoiceWebcamUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: true,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

pub(in crate::ws) async fn handle_voice_webcam_stop(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_webcam_sharing(&p.channel_id, user_id, false)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        let _ = sfu.remove_webcam_track(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_WEBCAM_UPDATE,
        VoiceWebcamUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: false,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}
