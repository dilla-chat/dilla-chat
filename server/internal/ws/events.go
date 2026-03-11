package ws

import "encoding/json"

// Client -> Server events
const (
	EventMessageSend    = "message:send"
	EventMessageEdit    = "message:edit"
	EventMessageDelete  = "message:delete"
	EventTypingStart    = "typing:start"
	EventTypingStop     = "typing:stop"
	EventPresenceUpdate = "presence:update"
	EventChannelJoin    = "channel:join"
	EventChannelLeave   = "channel:leave"

	// Thread client -> server events
	EventThreadMessageSend   = "thread:message:send"
	EventThreadMessageEdit   = "thread:message:edit"
	EventThreadMessageRemove = "thread:message:remove"

	// Voice client -> server events
	EventVoiceJoin         = "voice:join"
	EventVoiceLeave        = "voice:leave"
	EventVoiceAnswer       = "voice:answer"
	EventVoiceICECandidate = "voice:ice-candidate"
	EventVoiceMute         = "voice:mute"
	EventVoiceDeafen       = "voice:deafen"
	EventVoiceScreenStart  = "voice:screen-start"
	EventVoiceScreenStop   = "voice:screen-stop"
	EventVoiceWebcamStart  = "voice:webcam-start"
	EventVoiceWebcamStop   = "voice:webcam-stop"
)

// Server -> Client events
const (
	EventMessageNew      = "message:new"
	EventMessageUpdated  = "message:updated"
	EventMessageDeleted  = "message:deleted"
	EventTypingIndicator = "typing:indicator"
	EventPresenceChanged = "presence:changed"
	EventMemberJoined    = "member:joined"
	EventMemberLeft      = "member:left"
	EventChannelCreated  = "channel:created"
	EventChannelUpdated  = "channel:updated"
	EventChannelDeleted  = "channel:deleted"
	EventError           = "error"

	// Thread events
	EventThreadCreated        = "thread:created"
	EventThreadMessageNew     = "thread:message:new"
	EventThreadMessageUpdated = "thread:message:updated"
	EventThreadMessageDeleted = "thread:message:deleted"
	EventThreadUpdated        = "thread:updated"

	// Reaction events
	EventReactionAdded   = "reaction:added"
	EventReactionRemoved = "reaction:removed"

	// Voice server -> client events
	EventVoiceOffer      = "voice:offer"
	EventVoiceICEOut     = "voice:ice-candidate"
	EventVoiceUserJoined = "voice:user-joined"
	EventVoiceUserLeft   = "voice:user-left"
	EventVoiceSpeaking   = "voice:speaking"
	EventVoiceState      = "voice:state"
	EventVoiceMuteUpdate    = "voice:mute-update"
	EventVoiceScreenUpdate  = "voice:screen-update"
	EventVoiceWebcamUpdate  = "voice:webcam-update"

	// DM events
	EventDMMessageNew     = "dm:message:new"
	EventDMMessageUpdated = "dm:message:updated"
	EventDMMessageDeleted = "dm:message:deleted"
	EventDMTypingStart    = "dm:typing:start"
	EventDMTypingStop     = "dm:typing:stop"
	EventDMCreated        = "dm:created"

	// Request/Response events (client requests data over WS)
	EventRequest  = "request"
	EventResponse = "response"

	// Ping/Pong for latency measurement
	EventPing = "ping"
	EventPong = "pong"
)

// Event is the wire format for all WebSocket messages.
type Event struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// MakeEvent creates an Event with a JSON-encoded payload.
func MakeEvent(eventType string, payload interface{}) (Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return Event{}, err
	}
	return Event{Type: eventType, Payload: data}, nil
}

type MessageSendPayload struct {
	ChannelID string `json:"channel_id"`
	Content   string `json:"content"`
	Type      string `json:"type"`
	ThreadID  string `json:"thread_id"`
}

type MessageEditPayload struct {
	MessageID string `json:"message_id"`
	ChannelID string `json:"channel_id"`
	Content   string `json:"content"`
}

type MessageDeletePayload struct {
	MessageID string `json:"message_id"`
	ChannelID string `json:"channel_id"`
}

type ThreadMessageSendPayload struct {
	ThreadID string `json:"thread_id"`
	Content  string `json:"content"`
	Nonce    string `json:"nonce"`
}

type ThreadMessageEditPayload struct {
	ThreadID  string `json:"thread_id"`
	MessageID string `json:"message_id"`
	Content   string `json:"content"`
}

type ThreadMessageRemovePayload struct {
	ThreadID  string `json:"thread_id"`
	MessageID string `json:"message_id"`
}

type TypingPayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
}

type PresenceUpdatePayload struct {
	UserID     string `json:"user_id"`
	StatusType string `json:"status_type"`
	StatusText string `json:"status_text"`
}

type MessageNewPayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Username  string `json:"username"`
	Content   string `json:"content"`
	Type      string `json:"type"`
	ThreadID  string `json:"thread_id"`
	CreatedAt string `json:"created_at"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}

// DM event payloads

type DMMessageNewPayload struct {
	ID          string `json:"id"`
	DMChannelID string `json:"dm_channel_id"`
	AuthorID    string `json:"author_id"`
	Username    string `json:"username"`
	Content     string `json:"content"`
	Type        string `json:"type"`
	CreatedAt   string `json:"created_at"`
}

type DMMessageUpdatedPayload struct {
	ID          string `json:"id"`
	DMChannelID string `json:"dm_channel_id"`
	Content     string `json:"content"`
	EditedAt    string `json:"edited_at"`
}

type DMMessageDeletedPayload struct {
	ID          string `json:"id"`
	DMChannelID string `json:"dm_channel_id"`
}

type DMTypingPayload struct {
	DMChannelID string `json:"dm_channel_id"`
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
}

type DMCreatedPayload struct {
	ID        string   `json:"id"`
	TeamID    string   `json:"team_id"`
	Type      string   `json:"type"`
	MemberIDs []string `json:"member_ids"`
	CreatedAt string   `json:"created_at"`
}

// Thread event payloads

type ThreadCreatedPayload struct {
	ID              string  `json:"id"`
	ChannelID       string  `json:"channel_id"`
	ParentMessageID string  `json:"parent_message_id"`
	TeamID          string  `json:"team_id"`
	CreatorID       string  `json:"creator_id"`
	Title           string  `json:"title"`
	CreatedAt       string  `json:"created_at"`
}

type ThreadMessageNewPayload struct {
	ID        string `json:"id"`
	ThreadID  string `json:"thread_id"`
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Content   string `json:"content"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
}

type ThreadMessageUpdatedPayload struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
	Content  string `json:"content"`
	EditedAt string `json:"edited_at"`
}

type ThreadMessageDeletedPayload struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
}

type ThreadUpdatedPayload struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	MessageCount int     `json:"message_count"`
	LastMessageAt *string `json:"last_message_at"`
}

// Reaction event payload
type ReactionPayload struct {
	MessageID string `json:"message_id"`
	UserID    string `json:"user_id"`
	Emoji     string `json:"emoji"`
	ChannelID string `json:"channel_id"`
}

// Voice event payloads

type VoiceJoinPayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceLeavePayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceAnswerPayload struct {
	ChannelID string `json:"channel_id"`
	SDP       string `json:"sdp"`
}

type VoiceICECandidatePayload struct {
	ChannelID string `json:"channel_id"`
	Candidate string `json:"candidate"`
	SDPMid    string `json:"sdp_mid"`
	SDPMLine  uint16 `json:"sdp_mline_index"`
}

type VoiceMutePayload struct {
	ChannelID string `json:"channel_id"`
	Muted     bool   `json:"muted"`
}

type VoiceDeafenPayload struct {
	ChannelID string `json:"channel_id"`
	Deafened  bool   `json:"deafened"`
}

type VoiceOfferPayload struct {
	ChannelID string `json:"channel_id"`
	SDP       string `json:"sdp"`
}

type VoiceUserJoinedPayload struct {
	ChannelID     string `json:"channel_id"`
	UserID        string `json:"user_id"`
	Username      string `json:"username"`
	Muted         bool   `json:"muted"`
	Deafened      bool   `json:"deafened"`
	ScreenSharing bool   `json:"screen_sharing"`
	WebcamSharing bool   `json:"webcam_sharing"`
}

type VoiceUserLeftPayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
}

type VoiceSpeakingPayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Speaking  bool   `json:"speaking"`
}

type VoiceStatePayload struct {
	ChannelID string      `json:"channel_id"`
	Peers     interface{} `json:"peers"`
}

type VoiceMuteUpdatePayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
}

type VoiceScreenStartPayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceScreenStopPayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceScreenUpdatePayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Sharing   bool   `json:"sharing"`
}

type VoiceWebcamStartPayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceWebcamStopPayload struct {
	ChannelID string `json:"channel_id"`
}

type VoiceWebcamUpdatePayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Sharing   bool   `json:"sharing"`
}

// Request/Response payloads for data fetching over WS

type RequestEvent struct {
	ID      string          `json:"id"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload"`
}

type ResponseEvent struct {
	ID      string      `json:"id"`
	Action  string      `json:"action"`
	OK      bool        `json:"ok"`
	Payload interface{} `json:"payload,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// Request action constants
const (
	ActionSyncInit       = "sync:init"
	ActionMessageList    = "messages:list"
	ActionThreadList     = "threads:list"
	ActionThreadMessages = "threads:messages"
	ActionDMList         = "dms:list"
	ActionDMMessages     = "dms:messages"
)

type MessagesListRequest struct {
	ChannelID string `json:"channel_id"`
	Before    string `json:"before"`
	Limit     int    `json:"limit"`
}

type ThreadsListRequest struct {
	ChannelID string `json:"channel_id"`
}

type ThreadMessagesRequest struct {
	ThreadID string `json:"thread_id"`
	Before   string `json:"before"`
	Limit    int    `json:"limit"`
}

type DMMessagesRequest struct {
	DMID   string `json:"dm_id"`
	Before string `json:"before"`
	Limit  int    `json:"limit"`
}

// Reaction client -> server events
const (
	EventReactionAdd    = "reaction:add"
	EventReactionRemove = "reaction:remove"
)

type ReactionRequestPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
}
