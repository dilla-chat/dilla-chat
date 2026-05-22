-- H-3 / SFU-IP-1 mitigation: per-team TURN-only voice mode.
--
-- WebRTC ICE candidates exchanged in voice channels include each
-- speaker's real IP. Even after the WS subscription ACL fix
-- (VULN-004), a member of a voice channel still sees every other
-- speaker's candidates. For high-privacy teams the operator can flip
-- this flag, which the client honors by setting
-- `RTCConfiguration.iceTransportPolicy = "relay"` — host/srflx
-- candidates are filtered out and only TURN-relayed candidates are
-- gathered + advertised.
--
-- Server-side: this migration adds the column + makes it readable
-- via team payloads. Client-side enforcement (applying the relay
-- policy to its RTCPeerConnections) is a separate diff per
-- HANDOVER.md H-3 §note.

ALTER TABLE teams ADD COLUMN force_turn_relay INTEGER NOT NULL DEFAULT 0;
