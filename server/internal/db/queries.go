package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func newID() string {
	return uuid.New().String()
}

// ExportNewID returns a new UUID. Exported for use by API handlers.
func ExportNewID() string {
	return newID()
}

// --- Users ---

func (d *DB) CreateUser(user *User) error {
	if user.ID == "" {
		user.ID = newID()
	}
	now := time.Now().UTC()
	user.CreatedAt = now
	user.UpdatedAt = now
	_, err := d.conn.Exec(
		`INSERT INTO users (id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		user.ID, user.Username, user.DisplayName, user.PublicKey, user.AvatarURL,
		user.StatusText, user.StatusType, boolToInt(user.IsAdmin), formatTime(now), formatTime(now),
	)
	return err
}

func (d *DB) GetUserByID(id string) (*User, error) {
	return d.scanUser(d.conn.QueryRow(
		`SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at
		 FROM users WHERE id = ?`, id))
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	return d.scanUser(d.conn.QueryRow(
		`SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at
		 FROM users WHERE username = ?`, username))
}

func (d *DB) GetUserByPublicKey(publicKey []byte) (*User, error) {
	return d.scanUser(d.conn.QueryRow(
		`SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at
		 FROM users WHERE public_key = ?`, publicKey))
}

func (d *DB) scanUser(row *sql.Row) (*User, error) {
	var u User
	var isAdmin int
	var createdAt, updatedAt string
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PublicKey, &u.AvatarURL,
		&u.StatusText, &u.StatusType, &isAdmin, &createdAt, &updatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	u.IsAdmin = isAdmin != 0
	u.CreatedAt = parseTime(createdAt)
	u.UpdatedAt = parseTime(updatedAt)
	return &u, nil
}

// --- Teams ---

func (d *DB) CreateTeam(team *Team) error {
	if team.ID == "" {
		team.ID = newID()
	}
	now := time.Now().UTC()
	team.CreatedAt = now
	team.UpdatedAt = now
	_, err := d.conn.Exec(
		`INSERT INTO teams (id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		team.ID, team.Name, team.Description, team.IconURL, team.CreatedBy,
		team.MaxFileSize, boolToInt(team.AllowMemberInvites), formatTime(now), formatTime(now),
	)
	return err
}

func (d *DB) GetTeam(id string) (*Team, error) {
	var t Team
	var allowInvites int
	var createdAt, updatedAt string
	err := d.conn.QueryRow(
		`SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at
		 FROM teams WHERE id = ?`, id).Scan(
		&t.ID, &t.Name, &t.Description, &t.IconURL, &t.CreatedBy,
		&t.MaxFileSize, &allowInvites, &createdAt, &updatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	t.AllowMemberInvites = allowInvites != 0
	t.CreatedAt = parseTime(createdAt)
	t.UpdatedAt = parseTime(updatedAt)
	return &t, nil
}

// GetFirstTeam returns the first team (each server hosts one team).
func (d *DB) GetFirstTeam() (*Team, error) {
	var t Team
	var allowInvites int
	var createdAt, updatedAt string
	err := d.conn.QueryRow(
		`SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at
		 FROM teams LIMIT 1`).Scan(
		&t.ID, &t.Name, &t.Description, &t.IconURL, &t.CreatedBy,
		&t.MaxFileSize, &allowInvites, &createdAt, &updatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	t.AllowMemberInvites = allowInvites != 0
	t.CreatedAt = parseTime(createdAt)
	t.UpdatedAt = parseTime(updatedAt)
	return &t, nil
}

// GetTeamsByUser returns all teams a user is a member of.
func (d *DB) GetTeamsByUser(userID string) ([]Team, error) {
	rows, err := d.conn.Query(
		`SELECT t.id, t.name, t.description, t.icon_url, t.created_by, t.max_file_size, t.allow_member_invites, t.created_at, t.updated_at
		 FROM teams t
		 JOIN members m ON m.team_id = t.id
		 WHERE m.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var teams []Team
	for rows.Next() {
		var t Team
		var allowInvites int
		var createdAt, updatedAt string
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.IconURL, &t.CreatedBy,
			&t.MaxFileSize, &allowInvites, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		t.AllowMemberInvites = allowInvites != 0
		t.CreatedAt = parseTime(createdAt)
		t.UpdatedAt = parseTime(updatedAt)
		teams = append(teams, t)
	}
	return teams, rows.Err()
}

// --- Channels ---

func (d *DB) CreateChannel(channel *Channel) error {
	if channel.ID == "" {
		channel.ID = newID()
	}
	now := time.Now().UTC()
	channel.CreatedAt = now
	channel.UpdatedAt = now
	_, err := d.conn.Exec(
		`INSERT INTO channels (id, team_id, name, topic, type, position, category, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		channel.ID, channel.TeamID, channel.Name, channel.Topic, channel.Type,
		channel.Position, channel.Category, channel.CreatedBy, formatTime(now), formatTime(now),
	)
	return err
}

func (d *DB) GetChannelsByTeam(teamID string) ([]Channel, error) {
	rows, err := d.conn.Query(
		`SELECT id, team_id, name, topic, type, position, category, created_by, created_at, updated_at
		 FROM channels WHERE team_id = ? ORDER BY position`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []Channel
	for rows.Next() {
		var c Channel
		var createdAt, updatedAt string
		if err := rows.Scan(&c.ID, &c.TeamID, &c.Name, &c.Topic, &c.Type,
			&c.Position, &c.Category, &c.CreatedBy, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		c.CreatedAt = parseTime(createdAt)
		c.UpdatedAt = parseTime(updatedAt)
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

// --- Members ---

func (d *DB) CreateMember(member *Member) error {
	if member.ID == "" {
		member.ID = newID()
	}
	member.JoinedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT INTO members (id, team_id, user_id, nickname, joined_at, invited_by)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		member.ID, member.TeamID, member.UserID, member.Nickname,
		formatTime(member.JoinedAt), member.InvitedBy,
	)
	return err
}

func (d *DB) GetMembersByTeam(teamID string) ([]Member, error) {
	rows, err := d.conn.Query(
		`SELECT id, team_id, user_id, nickname, joined_at, COALESCE(invited_by, '')
		 FROM members WHERE team_id = ? ORDER BY joined_at`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []Member
	for rows.Next() {
		var m Member
		var joinedAt string
		if err := rows.Scan(&m.ID, &m.TeamID, &m.UserID, &m.Nickname, &joinedAt, &m.InvitedBy); err != nil {
			return nil, err
		}
		m.JoinedAt = parseTime(joinedAt)
		members = append(members, m)
	}
	return members, rows.Err()
}

// --- Invites ---

func (d *DB) CreateInvite(invite *Invite) error {
	if invite.ID == "" {
		invite.ID = newID()
	}
	invite.CreatedAt = time.Now().UTC()
	var expiresAt *string
	if invite.ExpiresAt != nil {
		s := formatTime(*invite.ExpiresAt)
		expiresAt = &s
	}
	_, err := d.conn.Exec(
		`INSERT INTO invites (id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		invite.ID, invite.TeamID, invite.CreatedBy, invite.Token,
		invite.MaxUses, invite.Uses, expiresAt, boolToInt(invite.Revoked), formatTime(invite.CreatedAt),
	)
	return err
}

func (d *DB) GetInviteByToken(token string) (*Invite, error) {
	var inv Invite
	var maxUses sql.NullInt64
	var expiresAt sql.NullString
	var revoked int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at
		 FROM invites WHERE token = ?`, token).Scan(
		&inv.ID, &inv.TeamID, &inv.CreatedBy, &inv.Token,
		&maxUses, &inv.Uses, &expiresAt, &revoked, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if maxUses.Valid {
		v := int(maxUses.Int64)
		inv.MaxUses = &v
	}
	if expiresAt.Valid {
		t := parseTime(expiresAt.String)
		inv.ExpiresAt = &t
	}
	inv.Revoked = revoked != 0
	inv.CreatedAt = parseTime(createdAt)
	return &inv, nil
}

func (d *DB) IncrementInviteUses(inviteID string) error {
	_, err := d.conn.Exec(`UPDATE invites SET uses = uses + 1 WHERE id = ?`, inviteID)
	return err
}

func (d *DB) RevokeInvite(inviteID string) error {
	_, err := d.conn.Exec(`UPDATE invites SET revoked = 1 WHERE id = ?`, inviteID)
	return err
}

func (d *DB) GetActiveInvitesByTeam(teamID string) ([]Invite, error) {
	rows, err := d.conn.Query(
		`SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at
		 FROM invites WHERE team_id = ? AND revoked = 0
		 AND (expires_at IS NULL OR expires_at > datetime('now'))
		 AND (max_uses IS NULL OR uses < max_uses)
		 ORDER BY created_at DESC`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var invites []Invite
	for rows.Next() {
		var inv Invite
		var maxUses sql.NullInt64
		var expiresAt sql.NullString
		var revoked int
		var createdAt string
		if err := rows.Scan(&inv.ID, &inv.TeamID, &inv.CreatedBy, &inv.Token,
			&maxUses, &inv.Uses, &expiresAt, &revoked, &createdAt); err != nil {
			return nil, err
		}
		if maxUses.Valid {
			v := int(maxUses.Int64)
			inv.MaxUses = &v
		}
		if expiresAt.Valid {
			t := parseTime(expiresAt.String)
			inv.ExpiresAt = &t
		}
		inv.Revoked = revoked != 0
		inv.CreatedAt = parseTime(createdAt)
		invites = append(invites, inv)
	}
	return invites, rows.Err()
}

func (d *DB) LogInviteUse(inviteUse *InviteUse) error {
	if inviteUse.ID == "" {
		inviteUse.ID = newID()
	}
	inviteUse.UsedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT INTO invite_uses (id, invite_id, user_id, used_at) VALUES (?, ?, ?, ?)`,
		inviteUse.ID, inviteUse.InviteID, inviteUse.UserID, formatTime(inviteUse.UsedAt),
	)
	return err
}

// --- Bootstrap Tokens ---

func (d *DB) CreateBootstrapToken(token string) error {
	_, err := d.conn.Exec(
		`INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?, 0, ?)`,
		token, formatTime(time.Now().UTC()),
	)
	return err
}

func (d *DB) GetBootstrapToken(token string) (*BootstrapToken, error) {
	var bt BootstrapToken
	var used int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT token, used, created_at FROM bootstrap_tokens WHERE token = ?`, token).Scan(
		&bt.Token, &used, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	bt.Used = used != 0
	bt.CreatedAt = parseTime(createdAt)
	return &bt, nil
}

func (d *DB) UseBootstrapToken(token string) error {
	_, err := d.conn.Exec(`UPDATE bootstrap_tokens SET used = 1 WHERE token = ?`, token)
	return err
}

// --- Roles ---

func (d *DB) CreateRole(role *Role) error {
	if role.ID == "" {
		role.ID = newID()
	}
	role.CreatedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT INTO roles (id, team_id, name, color, position, permissions, is_default, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		role.ID, role.TeamID, role.Name, role.Color, role.Position,
		role.Permissions, boolToInt(role.IsDefault), formatTime(role.CreatedAt),
	)
	return err
}

func (d *DB) GetRolesByTeam(teamID string) ([]Role, error) {
	rows, err := d.conn.Query(
		`SELECT id, team_id, name, color, position, permissions, is_default, created_at
		 FROM roles WHERE team_id = ? ORDER BY position`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var roles []Role
	for rows.Next() {
		var r Role
		var isDefault int
		var createdAt string
		if err := rows.Scan(&r.ID, &r.TeamID, &r.Name, &r.Color, &r.Position,
			&r.Permissions, &isDefault, &createdAt); err != nil {
			return nil, err
		}
		r.IsDefault = isDefault != 0
		r.CreatedAt = parseTime(createdAt)
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

// --- Prekey Bundles ---

func (d *DB) SavePrekeyBundle(bundle *PrekeyBundle) error {
	if bundle.ID == "" {
		bundle.ID = newID()
	}
	bundle.UploadedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT OR REPLACE INTO prekey_bundles (id, user_id, identity_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		bundle.ID, bundle.UserID, bundle.IdentityKey, bundle.SignedPrekey,
		bundle.SignedPrekeySignature, bundle.OneTimePrekeys, formatTime(bundle.UploadedAt),
	)
	return err
}

func (d *DB) GetPrekeyBundle(userID string) (*PrekeyBundle, error) {
	var b PrekeyBundle
	var uploadedAt string
	err := d.conn.QueryRow(
		`SELECT id, user_id, identity_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at
		 FROM prekey_bundles WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1`, userID).Scan(
		&b.ID, &b.UserID, &b.IdentityKey, &b.SignedPrekey,
		&b.SignedPrekeySignature, &b.OneTimePrekeys, &uploadedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	b.UploadedAt = parseTime(uploadedAt)
	return &b, nil
}

// --- Messages ---

func (d *DB) CreateMessage(msg *Message) error {
	if msg.ID == "" {
		msg.ID = newID()
	}
	msg.CreatedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT INTO messages (id, channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
		msg.ID, msg.ChannelID, msg.AuthorID, msg.Content, msg.Type,
		msg.ThreadID, msg.LamportTS, formatTime(msg.CreatedAt),
	)
	return err
}

func (d *DB) GetMessageByID(id string) (*Message, error) {
	var m Message
	var editedAt sql.NullString
	var deleted int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, channel_id, author_id, content, type, COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
		 FROM messages WHERE id = ?`, id).Scan(
		&m.ID, &m.ChannelID, &m.AuthorID, &m.Content, &m.Type,
		&m.ThreadID, &editedAt, &deleted, &m.LamportTS, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	m.Deleted = deleted != 0
	m.CreatedAt = parseTime(createdAt)
	if editedAt.Valid {
		t := parseTime(editedAt.String)
		m.EditedAt = &t
	}
	return &m, nil
}

func (d *DB) GetMessagesByChannel(channelID string, before string, limit int) ([]Message, error) {
	var rows *sql.Rows
	var err error

	if before != "" {
		rows, err = d.conn.Query(
			`SELECT id, channel_id, author_id, content, type, COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE channel_id = ? AND deleted = 0 AND created_at < (SELECT created_at FROM messages WHERE id = ?)
			 ORDER BY created_at DESC LIMIT ?`,
			channelID, before, limit)
	} else {
		rows, err = d.conn.Query(
			`SELECT id, channel_id, author_id, content, type, COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE channel_id = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT ?`,
			channelID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var m Message
		var editedAt sql.NullString
		var deleted int
		var createdAt string
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.AuthorID, &m.Content, &m.Type,
			&m.ThreadID, &editedAt, &deleted, &m.LamportTS, &createdAt); err != nil {
			return nil, err
		}
		m.Deleted = deleted != 0
		m.CreatedAt = parseTime(createdAt)
		if editedAt.Valid {
			t := parseTime(editedAt.String)
			m.EditedAt = &t
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func (d *DB) UpdateMessageContent(id string, content string) error {
	_, err := d.conn.Exec(
		`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`,
		content, formatTime(time.Now().UTC()), id)
	return err
}

func (d *DB) SoftDeleteMessage(id string) error {
	_, err := d.conn.Exec(`UPDATE messages SET deleted = 1, content = X'' WHERE id = ?`, id)
	return err
}

func (d *DB) UpdateUserStatus(userID, statusType, statusText string) error {
	_, err := d.conn.Exec(
		`UPDATE users SET status_type = ?, status_text = ?, updated_at = ? WHERE id = ?`,
		statusType, statusText, formatTime(time.Now().UTC()), userID)
	return err
}

func (d *DB) DeletePrekeyBundle(userID string) error {
	_, err := d.conn.Exec(`DELETE FROM prekey_bundles WHERE user_id = ?`, userID)
	return err
}

// ConsumeOneTimePrekey removes and returns one one-time prekey from the user's bundle.
func (d *DB) ConsumeOneTimePrekey(userID string) ([]byte, error) {
	bundle, err := d.GetPrekeyBundle(userID)
	if err != nil || bundle == nil {
		return nil, err
	}

	var keys []string
	if err := json.Unmarshal(bundle.OneTimePrekeys, &keys); err != nil {
		return nil, fmt.Errorf("unmarshal one_time_prekeys: %w", err)
	}
	if len(keys) == 0 {
		return nil, nil
	}

	// Pop the first key.
	consumed := keys[0]
	remaining := keys[1:]

	updatedJSON, err := json.Marshal(remaining)
	if err != nil {
		return nil, fmt.Errorf("marshal remaining prekeys: %w", err)
	}

	_, err = d.conn.Exec(
		`UPDATE prekey_bundles SET one_time_prekeys = ? WHERE user_id = ?`,
		updatedJSON, userID)
	if err != nil {
		return nil, err
	}

	return []byte(consumed), nil
}

// --- Helpers ---

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

const timeLayout = "2006-01-02 15:04:05"

func formatTime(t time.Time) string {
	return t.UTC().Format(timeLayout)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(timeLayout, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// --- Teams (update) ---

func (d *DB) UpdateTeam(team *Team) error {
	team.UpdatedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`UPDATE teams SET name = ?, description = ?, icon_url = ?, max_file_size = ?, allow_member_invites = ?, updated_at = ? WHERE id = ?`,
		team.Name, team.Description, team.IconURL, team.MaxFileSize,
		boolToInt(team.AllowMemberInvites), formatTime(team.UpdatedAt), team.ID,
	)
	return err
}

// --- Members (additional) ---

func (d *DB) GetMemberByUserAndTeam(userID, teamID string) (*Member, error) {
	var m Member
	var joinedAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, user_id, nickname, joined_at, COALESCE(invited_by, '')
		 FROM members WHERE user_id = ? AND team_id = ?`, userID, teamID).Scan(
		&m.ID, &m.TeamID, &m.UserID, &m.Nickname, &joinedAt, &m.InvitedBy)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	m.JoinedAt = parseTime(joinedAt)
	return &m, nil
}

func (d *DB) UpdateMember(member *Member) error {
	_, err := d.conn.Exec(
		`UPDATE members SET nickname = ? WHERE id = ?`,
		member.Nickname, member.ID,
	)
	return err
}

func (d *DB) DeleteMember(teamID, userID string) error {
	_, err := d.conn.Exec(`DELETE FROM members WHERE team_id = ? AND user_id = ?`, teamID, userID)
	return err
}

// --- Bans ---

func (d *DB) CreateBan(teamID, userID, bannedBy, reason string) error {
	_, err := d.conn.Exec(
		`INSERT INTO bans (team_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
		teamID, userID, bannedBy, reason, formatTime(time.Now().UTC()),
	)
	return err
}

func (d *DB) DeleteBan(teamID, userID string) error {
	_, err := d.conn.Exec(`DELETE FROM bans WHERE team_id = ? AND user_id = ?`, teamID, userID)
	return err
}

func (d *DB) GetBan(teamID, userID string) (*Ban, error) {
	var b Ban
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT team_id, user_id, banned_by, reason, created_at FROM bans WHERE team_id = ? AND user_id = ?`,
		teamID, userID).Scan(&b.TeamID, &b.UserID, &b.BannedBy, &b.Reason, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	b.CreatedAt = parseTime(createdAt)
	return &b, nil
}

func (d *DB) GetBannedUsers(teamID string) ([]Ban, error) {
	rows, err := d.conn.Query(
		`SELECT team_id, user_id, banned_by, reason, created_at FROM bans WHERE team_id = ? ORDER BY created_at DESC`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bans []Ban
	for rows.Next() {
		var b Ban
		var createdAt string
		if err := rows.Scan(&b.TeamID, &b.UserID, &b.BannedBy, &b.Reason, &createdAt); err != nil {
			return nil, err
		}
		b.CreatedAt = parseTime(createdAt)
		bans = append(bans, b)
	}
	return bans, rows.Err()
}

// --- Channels (additional) ---

func (d *DB) GetChannelByID(id string) (*Channel, error) {
	var c Channel
	var createdAt, updatedAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, name, topic, type, position, category, created_by, created_at, updated_at
		 FROM channels WHERE id = ?`, id).Scan(
		&c.ID, &c.TeamID, &c.Name, &c.Topic, &c.Type,
		&c.Position, &c.Category, &c.CreatedBy, &createdAt, &updatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	c.CreatedAt = parseTime(createdAt)
	c.UpdatedAt = parseTime(updatedAt)
	return &c, nil
}

func (d *DB) UpdateChannel(channel *Channel) error {
	channel.UpdatedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`UPDATE channels SET name = ?, topic = ?, position = ?, category = ?, updated_at = ? WHERE id = ?`,
		channel.Name, channel.Topic, channel.Position, channel.Category,
		formatTime(channel.UpdatedAt), channel.ID,
	)
	return err
}

func (d *DB) DeleteChannel(id string) error {
	_, err := d.conn.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

// --- Roles (additional) ---

func (d *DB) GetRoleByID(id string) (*Role, error) {
	var r Role
	var isDefault int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, name, color, position, permissions, is_default, created_at
		 FROM roles WHERE id = ?`, id).Scan(
		&r.ID, &r.TeamID, &r.Name, &r.Color, &r.Position,
		&r.Permissions, &isDefault, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	r.IsDefault = isDefault != 0
	r.CreatedAt = parseTime(createdAt)
	return &r, nil
}

func (d *DB) UpdateRole(role *Role) error {
	_, err := d.conn.Exec(
		`UPDATE roles SET name = ?, color = ?, position = ?, permissions = ? WHERE id = ?`,
		role.Name, role.Color, role.Position, role.Permissions, role.ID,
	)
	return err
}

func (d *DB) DeleteRole(id string) error {
	_, err := d.conn.Exec(`DELETE FROM roles WHERE id = ?`, id)
	return err
}

// --- Member Roles ---

func (d *DB) AssignRoleToMember(memberID, roleID string) error {
	_, err := d.conn.Exec(
		`INSERT OR IGNORE INTO member_roles (member_id, role_id) VALUES (?, ?)`,
		memberID, roleID,
	)
	return err
}

func (d *DB) RemoveRoleFromMember(memberID, roleID string) error {
	_, err := d.conn.Exec(`DELETE FROM member_roles WHERE member_id = ? AND role_id = ?`, memberID, roleID)
	return err
}

func (d *DB) ClearMemberRoles(memberID string) error {
	_, err := d.conn.Exec(`DELETE FROM member_roles WHERE member_id = ?`, memberID)
	return err
}

func (d *DB) GetMemberRoles(memberID string) ([]Role, error) {
	rows, err := d.conn.Query(
		`SELECT r.id, r.team_id, r.name, r.color, r.position, r.permissions, r.is_default, r.created_at
		 FROM roles r
		 JOIN member_roles mr ON mr.role_id = r.id
		 WHERE mr.member_id = ?
		 ORDER BY r.position`, memberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var roles []Role
	for rows.Next() {
		var r Role
		var isDefault int
		var createdAt string
		if err := rows.Scan(&r.ID, &r.TeamID, &r.Name, &r.Color, &r.Position,
			&r.Permissions, &isDefault, &createdAt); err != nil {
			return nil, err
		}
		r.IsDefault = isDefault != 0
		r.CreatedAt = parseTime(createdAt)
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

// --- Permission Checking ---

const (
	PermAdmin           = 1 << 0  // Full admin (bypasses all checks)
	PermManageChannels  = 1 << 1
	PermManageRoles     = 1 << 2
	PermManageMembers   = 1 << 3  // Kick/ban
	PermCreateInvites   = 1 << 4
	PermSendMessages    = 1 << 5
	PermManageMessages  = 1 << 6  // Delete others' messages
	PermVoiceConnect    = 1 << 7
	PermVoiceSpeak      = 1 << 8
	PermUploadFiles     = 1 << 9
	PermCreateThreads   = 1 << 10
	PermMentionEveryone = 1 << 11
)

// DefaultEveryonePerms are the default permissions for the @everyone role.
const DefaultEveryonePerms = PermSendMessages | PermVoiceConnect | PermVoiceSpeak | PermCreateInvites | PermUploadFiles | PermCreateThreads

// UserHasPermission checks if a user has a specific permission within a team.
// Admin users (is_admin flag) bypass all permission checks.
func (d *DB) UserHasPermission(teamID, userID string, permission int) (bool, error) {
	// Check if user is a global admin.
	user, err := d.GetUserByID(userID)
	if err != nil {
		return false, err
	}
	if user == nil {
		return false, nil
	}
	if user.IsAdmin {
		return true, nil
	}

	// Get the member record.
	member, err := d.GetMemberByUserAndTeam(userID, teamID)
	if err != nil {
		return false, err
	}
	if member == nil {
		return false, nil
	}

	// Get all roles assigned to this member.
	roles, err := d.GetMemberRoles(member.ID)
	if err != nil {
		return false, err
	}

	// Also include the default role for the team.
	allRoles, err := d.GetRolesByTeam(teamID)
	if err != nil {
		return false, err
	}
	for _, r := range allRoles {
		if r.IsDefault {
			roles = append(roles, r)
			break
		}
	}

	// OR all role permissions together.
	var combined int64
	for _, r := range roles {
		combined |= r.Permissions
	}

	// Admin permission bit bypasses all.
	if combined&int64(PermAdmin) != 0 {
		return true, nil
	}

	return combined&int64(permission) != 0, nil
}

// GetInviteUsesByTeam returns invite uses for audit purposes.
func (d *DB) GetInviteUsesByTeam(teamID string) ([]InviteUse, error) {
	rows, err := d.conn.Query(
		`SELECT iu.id, iu.invite_id, iu.user_id, iu.used_at
		 FROM invite_uses iu
		 JOIN invites i ON i.id = iu.invite_id
		 WHERE i.team_id = ?
		 ORDER BY iu.used_at DESC`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var uses []InviteUse
	for rows.Next() {
		var u InviteUse
		var usedAt string
		if err := rows.Scan(&u.ID, &u.InviteID, &u.UserID, &usedAt); err != nil {
			return nil, err
		}
		u.UsedAt = parseTime(usedAt)
		uses = append(uses, u)
	}
	return uses, rows.Err()
}

// GetDefaultRoleForTeam returns the default role for a team.
func (d *DB) GetDefaultRoleForTeam(teamID string) (*Role, error) {
	var r Role
	var isDefault int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, name, color, position, permissions, is_default, created_at
		 FROM roles WHERE team_id = ? AND is_default = 1`, teamID).Scan(
		&r.ID, &r.TeamID, &r.Name, &r.Color, &r.Position,
		&r.Permissions, &isDefault, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	r.IsDefault = isDefault != 0
	r.CreatedAt = parseTime(createdAt)
	return &r, nil
}

// GetInviteByID returns an invite by its ID.
func (d *DB) GetInviteByID(id string) (*Invite, error) {
	var inv Invite
	var maxUses sql.NullInt64
	var expiresAt sql.NullString
	var revoked int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at
		 FROM invites WHERE id = ?`, id).Scan(
		&inv.ID, &inv.TeamID, &inv.CreatedBy, &inv.Token,
		&maxUses, &inv.Uses, &expiresAt, &revoked, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get invite by id: %w", err)
	}
	if maxUses.Valid {
		v := int(maxUses.Int64)
		inv.MaxUses = &v
	}
	if expiresAt.Valid {
		t := parseTime(expiresAt.String)
		inv.ExpiresAt = &t
	}
	inv.Revoked = revoked != 0
	inv.CreatedAt = parseTime(createdAt)
	return &inv, nil
}

// GetSetting retrieves a value from the settings table.
func (d *DB) GetSetting(key string) (string, error) {
d.conn.Exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
var value string
err := d.conn.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
if err == sql.ErrNoRows {
return "", nil
}
return value, err
}

// SetSetting stores a value in the settings table.
func (d *DB) SetSetting(key, value string) error {
d.conn.Exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
_, err := d.conn.Exec(
`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
key, value)
return err
}

// UpsertIdentityBlob stores or updates an encrypted identity blob for a user.
func (d *DB) UpsertIdentityBlob(userID, blob string) error {
	now := formatTime(time.Now())
	_, err := d.conn.Exec(
		`INSERT INTO identity_blobs (user_id, blob, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
		userID, blob, now)
	return err
}

// GetIdentityBlobByUsername fetches the encrypted identity blob for a user by username.
func (d *DB) GetIdentityBlobByUsername(username string) (*IdentityBlob, error) {
	var ib IdentityBlob
	err := d.conn.QueryRow(
		`SELECT ib.user_id, ib.blob, ib.updated_at
		 FROM identity_blobs ib
		 JOIN users u ON u.id = ib.user_id
		 WHERE LOWER(u.username) = LOWER(?)`, username).Scan(&ib.UserID, &ib.Blob, &ib.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ib, nil
}
