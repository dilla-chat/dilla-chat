package ws

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/slimcord/slimcord-server/internal/db"
	"github.com/slimcord/slimcord-server/internal/voice"
)

type Subscription struct {
	Client    *Client
	ChannelID string
}

type ChannelMessage struct {
	ChannelID     string
	Event         Event
	ExcludeClient *Client
}

type DirectMessage struct {
	UserID string
	Event  Event
}

type Hub struct {
	clients   map[*Client]bool
	channels  map[string]map[*Client]bool
	userIndex map[string][]*Client // userID -> list of clients

	register   chan *Client
	unregister chan *Client

	subscribe   chan *Subscription
	unsubscribe chan *Subscription

	broadcast chan *ChannelMessage
	direct    chan *DirectMessage
	broadcastAll chan []byte

	// Typing throttle: channelID:userID -> last relay time (unix seconds)
	typingMu       sync.Mutex
	typingThrottle map[string]int64

	DB *db.DB

	// OnMessageSend is called after a message is persisted locally, for federation replication.
	OnMessageSend   func(msg *db.Message, username string)
	// OnMessageEdit is called after a message is edited locally.
	OnMessageEdit   func(messageID, channelID, content string)
	// OnMessageDelete is called after a message is deleted locally.
	OnMessageDelete func(messageID, channelID string)

	// Thread message federation callbacks.
	OnThreadMessageSend   func(msg *db.Message, threadID string)
	OnThreadMessageEdit   func(messageID, threadID, content string)
	OnThreadMessageDelete func(messageID, threadID string)

	// Presence callbacks (set by main).
	OnClientConnect    func(userID string)
	OnClientDisconnect func(userID string)
	OnClientActivity   func(userID string)
	OnPresenceUpdate   func(userID, statusType, customStatus string)
	GetAllPresences    func() interface{}

	// Voice subsystem (set by main).
	VoiceRoomManager *voice.RoomManager
	VoiceSFU         *voice.SFU

	// Voice federation callbacks (set by main).
	OnVoiceJoin  func(channelID, userID, username string)
	OnVoiceLeave func(channelID, userID string)
}

func NewHub(database *db.DB) *Hub {
	return &Hub{
		clients:        make(map[*Client]bool),
		channels:       make(map[string]map[*Client]bool),
		userIndex:      make(map[string][]*Client),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		subscribe:      make(chan *Subscription),
		unsubscribe:    make(chan *Subscription),
		broadcast:      make(chan *ChannelMessage),
		direct:         make(chan *DirectMessage),
		broadcastAll:   make(chan []byte, 64),
		typingThrottle: make(map[string]int64),
		DB:             database,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = true
			h.userIndex[client.userID] = append(h.userIndex[client.userID], client)
			slog.Info("ws: client connected", "user_id", client.userID, "username", client.username)
			if h.OnClientConnect != nil {
				h.OnClientConnect(client.userID)
			}

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				// Remove this client from the userIndex slice.
				clients := h.userIndex[client.userID]
				for i, c := range clients {
					if c == client {
						h.userIndex[client.userID] = append(clients[:i], clients[i+1:]...)
						break
					}
				}
				if len(h.userIndex[client.userID]) == 0 {
					delete(h.userIndex, client.userID)
				}
				// Remove from all channel subscriptions.
				for chID := range client.channels {
					if subs, ok := h.channels[chID]; ok {
						delete(subs, client)
						if len(subs) == 0 {
							delete(h.channels, chID)
						}
					}
				}
				close(client.send)
				slog.Info("ws: client disconnected", "user_id", client.userID)
				if h.OnClientDisconnect != nil {
					h.OnClientDisconnect(client.userID)
				}
			}

		case sub := <-h.subscribe:
			if h.channels[sub.ChannelID] == nil {
				h.channels[sub.ChannelID] = make(map[*Client]bool)
			}
			h.channels[sub.ChannelID][sub.Client] = true
			sub.Client.channels[sub.ChannelID] = true

		case sub := <-h.unsubscribe:
			if subs, ok := h.channels[sub.ChannelID]; ok {
				delete(subs, sub.Client)
				if len(subs) == 0 {
					delete(h.channels, sub.ChannelID)
				}
			}
			delete(sub.Client.channels, sub.ChannelID)

		case msg := <-h.broadcast:
			if subs, ok := h.channels[msg.ChannelID]; ok {
				for client := range subs {
					if client == msg.ExcludeClient {
						continue
					}
					client.SendEvent(msg.Event)
				}
			}

		case msg := <-h.direct:
			if clients, ok := h.userIndex[msg.UserID]; ok {
				for _, client := range clients {
					client.SendEvent(msg.Event)
				}
			}

		case data := <-h.broadcastAll:
			for client := range h.clients {
				select {
				case client.send <- data:
				default:
					slog.Warn("ws: broadcast-all buffer full, dropping", "user_id", client.userID)
				}
			}
		}
	}
}

func (h *Hub) BroadcastToChannel(channelID string, event Event, exclude *Client) {
	h.broadcast <- &ChannelMessage{
		ChannelID:     channelID,
		Event:         event,
		ExcludeClient: exclude,
	}
}

func (h *Hub) SendToUser(userID string, event Event) {
	h.direct <- &DirectMessage{UserID: userID, Event: event}
}

func (h *Hub) GetOnlineUsers() []string {
	users := make([]string, 0, len(h.userIndex))
	for uid := range h.userIndex {
		users = append(users, uid)
	}
	return users
}

func (h *Hub) GetChannelClients(channelID string) []*Client {
	subs := h.channels[channelID]
	clients := make([]*Client, 0, len(subs))
	for c := range subs {
		clients = append(clients, c)
	}
	return clients
}

// Register sends a client to the register channel (thread-safe).
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Subscribe sends a subscription to the subscribe channel (thread-safe).
func (h *Hub) Subscribe(client *Client, channelID string) {
	h.subscribe <- &Subscription{Client: client, ChannelID: channelID}
}

// Unsubscribe removes a client from a channel's broadcast group.
func (h *Hub) Unsubscribe(client *Client, channelID string) {
	h.unsubscribe <- &Subscription{Client: client, ChannelID: channelID}
}

// BroadcastToAllClients sends an event to all connected clients.
func (h *Hub) BroadcastToAllClients(event Event) {
	// Use direct channel to avoid blocking in the Run loop. We iterate clients
	// asynchronously via a goroutine that reads from the broadcast-all channel.
	// For simplicity, we send to each user via the direct channel.
	// NOTE: this is called from outside the Run goroutine, so we must not access
	// h.clients directly. Instead, queue individual direct sends.
	// However, userIndex is also only safe inside Run. To avoid data races, we
	// marshal once and push via a dedicated channel-less approach.
	data, err := MarshalEvent(event)
	if err != nil {
		return
	}
	h.broadcastAll <- data
}

// MarshalEvent marshals an Event to JSON bytes.
func MarshalEvent(event Event) ([]byte, error) {
	return json.Marshal(event)
}
