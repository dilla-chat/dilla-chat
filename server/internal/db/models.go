package db

import "time"

type User struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	PublicKey   []byte    `json:"public_key"`
	AvatarURL   string    `json:"avatar_url"`
	StatusText  string    `json:"status_text"`
	StatusType  string    `json:"status_type"`
	IsAdmin     bool      `json:"is_admin"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Team struct {
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	Description         string    `json:"description"`
	IconURL             string    `json:"icon_url"`
	CreatedBy           string    `json:"created_by"`
	MaxFileSize         int64     `json:"max_file_size"`
	AllowMemberInvites  bool      `json:"allow_member_invites"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type Role struct {
	ID          string    `json:"id"`
	TeamID      string    `json:"team_id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	Position    int       `json:"position"`
	Permissions int64     `json:"permissions"`
	IsDefault   bool      `json:"is_default"`
	CreatedAt   time.Time `json:"created_at"`
}

type Member struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"team_id"`
	UserID    string    `json:"user_id"`
	Nickname  string    `json:"nickname"`
	JoinedAt  time.Time `json:"joined_at"`
	InvitedBy string    `json:"invited_by"`
}

type Channel struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"team_id"`
	Name      string    `json:"name"`
	Topic     string    `json:"topic"`
	Type      string    `json:"type"`
	Position  int       `json:"position"`
	Category  string    `json:"category"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Message struct {
	ID          string    `json:"id"`
	ChannelID   string    `json:"channel_id"`
	DMChannelID string    `json:"dm_channel_id,omitempty"`
	AuthorID    string    `json:"author_id"`
	Content     string    `json:"content"`
	Type        string    `json:"type"`
	ThreadID    string    `json:"thread_id"`
	EditedAt    *time.Time `json:"edited_at"`
	Deleted     bool      `json:"deleted"`
	LamportTS   int64     `json:"lamport_ts"`
	CreatedAt   time.Time `json:"created_at"`
}

type Reaction struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	UserID    string    `json:"user_id"`
	Emoji     string    `json:"emoji"`
	CreatedAt time.Time `json:"created_at"`
}

type Attachment struct {
	ID                   string    `json:"id"`
	MessageID            string    `json:"message_id"`
	FilenameEncrypted    []byte    `json:"filename_encrypted"`
	ContentTypeEncrypted []byte    `json:"content_type_encrypted"`
	Size                 int64     `json:"size"`
	StoragePath          string    `json:"storage_path"`
	CreatedAt            time.Time `json:"created_at"`
}

type Invite struct {
	ID        string     `json:"id"`
	TeamID    string     `json:"team_id"`
	CreatedBy string     `json:"created_by"`
	Token     string     `json:"token"`
	MaxUses   *int       `json:"max_uses"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at"`
	Revoked   bool       `json:"revoked"`
	CreatedAt time.Time  `json:"created_at"`
}

type InviteUse struct {
	ID       string    `json:"id"`
	InviteID string    `json:"invite_id"`
	UserID   string    `json:"user_id"`
	UsedAt   time.Time `json:"used_at"`
}

type PrekeyBundle struct {
	ID                    string    `json:"id"`
	UserID                string    `json:"user_id"`
	IdentityKey           []byte    `json:"identity_key"`
	SignedPrekey          []byte    `json:"signed_prekey"`
	SignedPrekeySignature []byte    `json:"signed_prekey_signature"`
	OneTimePrekeys        []byte    `json:"one_time_prekeys"`
	UploadedAt            time.Time `json:"uploaded_at"`
}

type BootstrapToken struct {
	Token     string    `json:"token"`
	Used      bool      `json:"used"`
	CreatedAt time.Time `json:"created_at"`
}

type DMChannel struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"team_id"`
	Type      string    `json:"type"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type DMMember struct {
	ChannelID string    `json:"channel_id"`
	UserID    string    `json:"user_id"`
	JoinedAt  time.Time `json:"joined_at"`
}

type Ban struct {
	TeamID    string    `json:"team_id"`
	UserID    string    `json:"user_id"`
	BannedBy  string    `json:"banned_by"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}

type Thread struct {
	ID              string  `json:"id"`
	ChannelID       string  `json:"channel_id"`
	ParentMessageID string  `json:"parent_message_id"`
	TeamID          string  `json:"team_id"`
	CreatorID       string  `json:"creator_id"`
	Title           string  `json:"title"`
	MessageCount    int     `json:"message_count"`
	LastMessageAt   *string `json:"last_message_at"`
	CreatedAt       string  `json:"created_at"`
}

type IdentityBlob struct {
	UserID    string `json:"user_id"`
	Blob      string `json:"blob"`
	UpdatedAt string `json:"updated_at"`
}
