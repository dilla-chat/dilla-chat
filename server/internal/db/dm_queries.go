package db

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// --- DM Channels ---

// CreateDMChannel creates a 1-on-1 or group DM channel and adds members.
func (d *DB) CreateDMChannel(teamID string, memberIDs []string) (*DMChannel, error) {
	if len(memberIDs) < 2 {
		return nil, fmt.Errorf("DM requires at least 2 members")
	}

	dmType := "dm"
	if len(memberIDs) > 2 {
		dmType = "group_dm"
	}

	ch := &DMChannel{
		ID:        newID(),
		TeamID:    teamID,
		Type:      dmType,
		CreatedAt: time.Now().UTC(),
	}

	tx, err := d.conn.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO dm_channels (id, team_id, type, name, created_at) VALUES (?, ?, ?, ?, ?)`,
		ch.ID, ch.TeamID, ch.Type, ch.Name, formatTime(ch.CreatedAt),
	)
	if err != nil {
		return nil, err
	}

	for _, uid := range memberIDs {
		_, err = tx.Exec(
			`INSERT INTO dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`,
			ch.ID, uid, formatTime(ch.CreatedAt),
		)
		if err != nil {
			return nil, err
		}
	}

	return ch, tx.Commit()
}

// GetDMChannel retrieves a DM channel by ID.
func (d *DB) GetDMChannel(channelID string) (*DMChannel, error) {
	var ch DMChannel
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, COALESCE(team_id, ''), type, COALESCE(name, ''), created_at FROM dm_channels WHERE id = ?`,
		channelID,
	).Scan(&ch.ID, &ch.TeamID, &ch.Type, &ch.Name, &createdAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	ch.CreatedAt = parseTime(createdAt)
	return &ch, nil
}

// GetDMChannelByMembers finds an existing DM between an exact set of members within a team.
func (d *DB) GetDMChannelByMembers(teamID string, memberIDs []string) (*DMChannel, error) {
	if len(memberIDs) < 2 {
		return nil, nil
	}

	sorted := make([]string, len(memberIDs))
	copy(sorted, memberIDs)
	sort.Strings(sorted)

	placeholders := make([]string, len(sorted))
	args := make([]interface{}, 0, len(sorted)+2)
	args = append(args, teamID, len(sorted))
	for i, id := range sorted {
		placeholders[i] = "?"
		args = append(args, id)
	}

	// Find dm_channels where team matches, member count matches, and all specified members are present.
	query := fmt.Sprintf(`
		SELECT dc.id, COALESCE(dc.team_id, ''), dc.type, COALESCE(dc.name, ''), dc.created_at
		FROM dm_channels dc
		WHERE dc.team_id = ?
		  AND (SELECT COUNT(*) FROM dm_members WHERE channel_id = dc.id) = ?
		  AND NOT EXISTS (
		    SELECT 1 FROM dm_members dm2
		    WHERE dm2.channel_id = dc.id AND dm2.user_id NOT IN (%s)
		  )
		  AND (SELECT COUNT(*) FROM dm_members dm3
		       WHERE dm3.channel_id = dc.id AND dm3.user_id IN (%s)) = ?
		LIMIT 1`,
		strings.Join(placeholders, ","),
		strings.Join(placeholders, ","),
	)

	// Add memberIDs again for second IN clause, plus count arg
	for _, id := range sorted {
		args = append(args, id)
	}
	args = append(args, len(sorted))

	var ch DMChannel
	var createdAt string
	err := d.conn.QueryRow(query, args...).Scan(
		&ch.ID, &ch.TeamID, &ch.Type, &ch.Name, &createdAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	ch.CreatedAt = parseTime(createdAt)
	return &ch, nil
}

// GetUserDMChannels returns all DM channels a user belongs to within a team.
func (d *DB) GetUserDMChannels(teamID, userID string) ([]DMChannel, error) {
	rows, err := d.conn.Query(`
		SELECT dc.id, COALESCE(dc.team_id, ''), dc.type, COALESCE(dc.name, ''), dc.created_at
		FROM dm_channels dc
		JOIN dm_members dm ON dm.channel_id = dc.id
		WHERE dc.team_id = ? AND dm.user_id = ?
		ORDER BY dc.created_at DESC`,
		teamID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []DMChannel
	for rows.Next() {
		var ch DMChannel
		var createdAt string
		if err := rows.Scan(&ch.ID, &ch.TeamID, &ch.Type, &ch.Name, &createdAt); err != nil {
			return nil, err
		}
		ch.CreatedAt = parseTime(createdAt)
		channels = append(channels, ch)
	}
	return channels, rows.Err()
}

// AddDMMembers adds users to a group DM channel.
func (d *DB) AddDMMembers(channelID string, userIDs []string) error {
	now := formatTime(time.Now().UTC())
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, uid := range userIDs {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`,
			channelID, uid, now,
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RemoveDMMember removes a user from a DM channel.
func (d *DB) RemoveDMMember(channelID, userID string) error {
	_, err := d.conn.Exec(
		`DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?`,
		channelID, userID,
	)
	return err
}

// GetDMMembers returns all members of a DM channel.
func (d *DB) GetDMMembers(channelID string) ([]DMMember, error) {
	rows, err := d.conn.Query(
		`SELECT channel_id, user_id, joined_at FROM dm_members WHERE channel_id = ? ORDER BY joined_at`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []DMMember
	for rows.Next() {
		var m DMMember
		var joinedAt string
		if err := rows.Scan(&m.ChannelID, &m.UserID, &joinedAt); err != nil {
			return nil, err
		}
		m.JoinedAt = parseTime(joinedAt)
		members = append(members, m)
	}
	return members, rows.Err()
}

// CreateDMMessage creates a message in a DM channel.
func (d *DB) CreateDMMessage(msg *Message) error {
	if msg.ID == "" {
		msg.ID = newID()
	}
	msg.CreatedAt = time.Now().UTC()
	_, err := d.conn.Exec(
		`INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at)
		 VALUES (?, '', ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
		msg.ID, msg.DMChannelID, msg.AuthorID, msg.Content, msg.Type,
		msg.ThreadID, msg.LamportTS, formatTime(msg.CreatedAt),
	)
	return err
}

// GetDMMessages retrieves messages for a DM channel with cursor pagination.
func (d *DB) GetDMMessages(dmChannelID string, before string, limit int) ([]Message, error) {
	var rows *sql.Rows
	var err error

	if before != "" {
		rows, err = d.conn.Query(
			`SELECT id, COALESCE(channel_id, ''), COALESCE(dm_channel_id, ''), author_id, content, type,
			        COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE dm_channel_id = ? AND deleted = 0
			   AND created_at < (SELECT created_at FROM messages WHERE id = ?)
			 ORDER BY created_at DESC LIMIT ?`,
			dmChannelID, before, limit)
	} else {
		rows, err = d.conn.Query(
			`SELECT id, COALESCE(channel_id, ''), COALESCE(dm_channel_id, ''), author_id, content, type,
			        COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE dm_channel_id = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT ?`,
			dmChannelID, limit)
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
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.DMChannelID, &m.AuthorID, &m.Content, &m.Type,
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

// GetLastDMMessage returns the most recent message in a DM channel.
func (d *DB) GetLastDMMessage(dmChannelID string) (*Message, error) {
	var m Message
	var editedAt sql.NullString
	var deleted int
	var createdAt string
	err := d.conn.QueryRow(
		`SELECT id, COALESCE(channel_id, ''), COALESCE(dm_channel_id, ''), author_id, content, type,
		        COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
		 FROM messages
		 WHERE dm_channel_id = ? AND deleted = 0
		 ORDER BY created_at DESC LIMIT 1`,
		dmChannelID,
	).Scan(&m.ID, &m.ChannelID, &m.DMChannelID, &m.AuthorID, &m.Content, &m.Type,
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

// IsDMMember checks if a user is a member of a DM channel.
func (d *DB) IsDMMember(channelID, userID string) (bool, error) {
	var count int
	err := d.conn.QueryRow(
		`SELECT COUNT(*) FROM dm_members WHERE channel_id = ? AND user_id = ?`,
		channelID, userID,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}
