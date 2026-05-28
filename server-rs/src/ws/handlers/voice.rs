use crate::ws::events::*;
use crate::ws::hub::Hub;
use super::verify_channel_team;

async fn check_voice_join_access(hub: &Hub, user_id: &str, team_id: &str, channel_id: &str) -> bool {
    let db_clone = hub.db.clone();
    let cid = channel_id.to_string();
    let uid = user_id.to_string();
    let tid = team_id.to_string();
    let uid_log = uid.clone();
    let cid_log = cid.clone();
    let allowed = tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| crate::db::user_can_access_channel(conn, &uid, &tid, &cid))
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);
    tracing::info!(user_id = %uid_log, channel_id = %cid_log, allowed, "voice:join access-check result");
    allowed
}

async fn deny_voice_join(hub: &Hub, user_id: &str, channel_id: &str) {
    tracing::info!(user_id, channel_id, "voice:join denied — channel access denied");
    if let Ok(evt) = Event::new(
        EVENT_VOICE_JOIN_DENIED,
        serde_json::json!({ "channel_id": channel_id, "reason": "no_access" }),
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            hub.send_to_user(user_id, bytes).await;
        }
    }
}

async fn process_eviction(hub: &Hub, client_id: &str, user_id: &str, evicted: &[String]) {
    for old_channel in evicted {
        if let Ok(evt) = Event::new(
            EVENT_VOICE_USER_LEFT,
            VoiceUserLeftPayload {
                channel_id: old_channel.clone(),
                user_id: user_id.to_string(),
            },
        ) {
            if let Ok(bytes) = evt.to_bytes() {
                hub.broadcast_to_all(bytes).await;
            }
        }
        if let Some(sfu) = &hub.voice_sfu {
            sfu.handle_leave(old_channel, user_id).await;
        }
        hub.unsubscribe(client_id, old_channel).await;
    }
}

pub(in crate::ws) async fn handle_voice_join(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    p: VoiceJoinPayload,
) {
    tracing::info!(
        "voice: handle_voice_join entered user={} channel={} team={}",
        user_id,
        p.channel_id,
        team_id
    );
    if !verify_channel_team(&hub.db, &p.channel_id, team_id).await {
        tracing::warn!(user_id = user_id, channel_id = %p.channel_id, "voice:join denied — channel does not belong to user's team");
        return;
    }

    if !check_voice_join_access(hub, user_id, team_id, &p.channel_id).await {
        deny_voice_join(hub, user_id, &p.channel_id).await;
        return;
    }

    let Some(room_mgr) = &hub.voice_room_manager else {
        tracing::warn!("voice:join: no voice_room_manager wired; bailing");
        return;
    };

    let evicted = room_mgr
        .add_peer(&p.channel_id, user_id, username, team_id)
        .await;
    if !evicted.is_empty() {
        tracing::info!(
            "voice: evicting user={} from {} old channel(s) on join to {}: {:?}",
            user_id,
            evicted.len(),
            p.channel_id,
            evicted
        );
    }
    process_eviction(hub, client_id, user_id, &evicted).await;

    hub.subscribe(client_id, &p.channel_id).await;
    // Tag this WS as the voice-session holder so its eventual close
    // cleans up RoomManager/SFU/broadcast voice:user-left even if the
    // client never sent voice:leave (tab reload, crash).
    hub.set_voice_client(client_id, &p.channel_id).await;

    broadcast_voice_joined(hub, &p.channel_id, user_id, username).await;
    send_voice_state(hub, room_mgr, &p.channel_id, user_id).await;
    initiate_sfu_join(hub, &p.channel_id, user_id).await;

    hub.emit_event(crate::ws::hub::HubEvent::VoiceJoined {
        channel_id: p.channel_id.clone(),
        user_id: user_id.to_string(),
        team_id: team_id.to_string(),
    });
}

/// Broadcast a voice:user:joined event to all clients.
async fn broadcast_voice_joined(hub: &Hub, channel_id: &str, user_id: &str, username: &str) {
    let evt = Event::new(
        EVENT_VOICE_USER_JOINED,
        VoiceUserJoinedPayload {
            channel_id: channel_id.to_string(),
            user_id: user_id.to_string(),
            username: username.to_string(),
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }
}

/// Send current voice state to the joining client.
async fn send_voice_state(
    hub: &Hub,
    room_mgr: &crate::voice::RoomManager,
    channel_id: &str,
    user_id: &str,
) {
    if let Some(peers) = room_mgr.get_room(channel_id).await {
        let evt = Event::new(
            EVENT_VOICE_STATE,
            VoiceStatePayload {
                channel_id: channel_id.to_string(),
                peers,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.send_to_user(user_id, data).await;
            }
        }
    }
}

/// Initiate SFU join and send offer to the client.
async fn initiate_sfu_join(hub: &Hub, channel_id: &str, user_id: &str) {
    let sfu = match &hub.voice_sfu {
        Some(sfu) => sfu,
        None => return,
    };

    match sfu.handle_join(channel_id, user_id).await {
        Ok(offer_sdp) => {
            let evt = Event::new(
                EVENT_VOICE_OFFER,
                VoiceOfferPayload {
                    channel_id: channel_id.to_string(),
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

/// Client → server: deliver a voice-call ring to a specific peer. The server
/// resolves the channel name and forwards a `voice:incoming-call` event to the
/// target user's WS connections. No-op if the channel doesn't belong to the
/// caller's team or if the target user isn't connected.
pub(in crate::ws) async fn handle_voice_invite(
    hub: &Hub,
    user_id: &str,
    username: &str,
    team_id: &str,
    p: VoiceInvitePayload,
) {
    if !verify_channel_team(&hub.db, &p.channel_id, team_id).await {
        tracing::warn!(
            user_id = user_id,
            channel_id = %p.channel_id,
            "voice:invite denied — channel not in caller's team"
        );
        return;
    }

    // Look up the channel name so the recipient knows where they're being invited.
    let channel_name = {
        let db = hub.db.clone();
        let cid = p.channel_id.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| crate::db::get_channel_by_id(conn, &cid))
        })
        .await
        .ok()
        .and_then(|r| r.ok().flatten())
        .map(|ch| ch.name)
        .unwrap_or_else(|| p.channel_id.clone())
    };

    let payload = VoiceIncomingCallPayload {
        caller_user_id: user_id.to_string(),
        caller_username: username.to_string(),
        channel_id: p.channel_id,
        channel_name,
    };
    if let Ok(evt) = Event::new(EVENT_VOICE_INCOMING_CALL, payload) {
        if let Ok(data) = evt.to_bytes() {
            hub.send_to_user(&p.target_user_id, data).await;
        }
    }
}

pub(in crate::ws) async fn handle_voice_leave(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    p: VoiceJoinPayload,
) {
    // Drop the voice-client tag so the unregister path doesn't
    // double-fire VoiceClientGone on this client's eventual close.
    hub.clear_voice_client(client_id).await;

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

/// Admin/mod force-mute. Validates that:
///   1. The actor is in the same team as the target channel.
///   2. The actor has PERM_MUTE_VOICE (or PERM_ADMIN / is team owner).
/// Then writes the target's muted state into the room snapshot, broadcasts
/// the same voice:mute-update everyone else already listens for (so the
/// target client kills its mic), and audit-logs the action.
pub(in crate::ws) async fn handle_voice_force_mute(
    hub: &Hub,
    actor_user_id: &str,
    actor_team_id: &str,
    p: VoiceForceMutePayload,
) {
    if !verify_channel_team(&hub.db, &p.channel_id, actor_team_id).await {
        tracing::warn!(
            user_id = actor_user_id,
            channel_id = %p.channel_id,
            "voice:force-mute denied — channel does not belong to actor team"
        );
        return;
    }

    let db_clone = hub.db.clone();
    let actor = actor_user_id.to_string();
    let tid = actor_team_id.to_string();
    let allowed = tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| {
            crate::db::user_has_permission(conn, &actor, &tid, crate::db::PERM_MUTE_VOICE)
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);
    if !allowed {
        tracing::warn!(
            user_id = actor_user_id,
            target = %p.target_user_id,
            channel_id = %p.channel_id,
            "voice:force-mute denied — actor lacks PERM_MUTE_VOICE"
        );
        return;
    }

    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_muted(&p.channel_id, &p.target_user_id, true)
            .await;

        let deafened = room_mgr
            .get_room(&p.channel_id)
            .await
            .and_then(|peers| {
                peers
                    .iter()
                    .find(|peer| peer.user_id == p.target_user_id)
                    .map(|peer| peer.deafened)
            })
            .unwrap_or(false);

        let evt = Event::new(
            EVENT_VOICE_MUTE_UPDATE,
            VoiceMuteUpdatePayload {
                channel_id: p.channel_id.clone(),
                user_id: p.target_user_id.clone(),
                muted: true,
                deafened,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }
    }

    // Audit log — moderation actions only ever ENFORCE mute; lifting a
    // server-mute is a user-only action (the target must take their own
    // mic back). So there's no force_unmute audit type.
    let db_clone = hub.db.clone();
    let actor = actor_user_id.to_string();
    let tid = actor_team_id.to_string();
    let target = p.target_user_id.clone();
    let channel = p.channel_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| {
            crate::db::insert_audit_event(
                conn,
                &tid,
                Some(&actor),
                "voice.force_mute",
                Some("user"),
                Some(&target),
                Some(&serde_json::json!({ "channel_id": channel })),
            )
        })
    })
    .await;
}

/// Admin/mod force-disconnect. Stronger sibling to handle_voice_force_mute
/// — instead of just silencing the target, this kicks them out of the
/// voice channel entirely. Same permission gate (PERM_MUTE_VOICE) covers
/// both since they're the two halves of "voice moderator". Audit-logged.
pub(in crate::ws) async fn handle_voice_force_disconnect(
    hub: &Hub,
    actor_user_id: &str,
    actor_team_id: &str,
    p: VoiceForceDisconnectPayload,
) {
    if !verify_channel_team(&hub.db, &p.channel_id, actor_team_id).await {
        tracing::warn!(
            user_id = actor_user_id,
            channel_id = %p.channel_id,
            "voice:force-disconnect denied — channel does not belong to actor team"
        );
        return;
    }

    let db_clone = hub.db.clone();
    let actor = actor_user_id.to_string();
    let tid = actor_team_id.to_string();
    let allowed = tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| {
            crate::db::user_has_permission(conn, &actor, &tid, crate::db::PERM_MUTE_VOICE)
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);
    if !allowed {
        tracing::warn!(
            user_id = actor_user_id,
            target = %p.target_user_id,
            channel_id = %p.channel_id,
            "voice:force-disconnect denied — actor lacks PERM_MUTE_VOICE"
        );
        return;
    }

    // Mirror the access-eviction teardown path so the SFU, room map,
    // and roster all drop the target consistently.
    if let Some(sfu) = &hub.voice_sfu {
        sfu.handle_leave(&p.channel_id, &p.target_user_id).await;
    }
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr.remove_peer(&p.channel_id, &p.target_user_id).await;
    }

    // Tell everyone else the target left.
    if let Ok(evt) = Event::new(
        EVENT_VOICE_USER_LEFT,
        VoiceUserLeftPayload {
            channel_id: p.channel_id.clone(),
            user_id: p.target_user_id.clone(),
        },
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            hub.broadcast_to_all(bytes).await;
        }
    }

    // Tell the target directly so their client tears down WebRTC.
    if let Ok(evt) = Event::new(
        EVENT_VOICE_FORCE_DISCONNECT,
        serde_json::json!({
            "channel_id": p.channel_id,
            "reason": "moderator_action",
        }),
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            hub.send_to_user(&p.target_user_id, bytes).await;
        }
    }

    let db_clone = hub.db.clone();
    let actor = actor_user_id.to_string();
    let tid = actor_team_id.to_string();
    let target = p.target_user_id.clone();
    let channel = p.channel_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| {
            crate::db::insert_audit_event(
                conn,
                &tid,
                Some(&actor),
                "voice.force_disconnect",
                Some("user"),
                Some(&target),
                Some(&serde_json::json!({ "channel_id": channel })),
            )
        })
    })
    .await;
}

/// Rebroadcast a peer's self-published RTT measurement so other
/// clients can render per-user latency. No permission check —
/// publishing your own metric is harmless and the value is naturally
/// rate-limited by the publishing client (one sample every ~600ms).
pub(in crate::ws) async fn handle_voice_latency(
    hub: &Hub,
    user_id: &str,
    p: VoiceLatencyPayload,
) {
    let evt = Event::new(
        EVENT_VOICE_LATENCY_UPDATE,
        VoiceLatencyUpdatePayload {
            channel_id: p.channel_id,
            user_id: user_id.to_string(),
            latency_ms: p.latency_ms,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
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
