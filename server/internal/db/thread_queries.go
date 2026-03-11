package db

import (
	"database/sql"
	"time"
)

// CreateThread creates a new thread anchored to a parent message.
func (d *DB) CreateThread(channelID, parentMessageID, teamID, creatorID, title string) (*Thread, error) {
	// Verify parent message exists.
	parent, err := d.GetMessageByID(parentMessageID)
	if err != nil {
		return nil, err
	}
	if parent == nil {
		return nil, sql.ErrNoRows
	}

	t := &Thread{
		ID:              newID(),
		ChannelID:       channelID,
		ParentMessageID: parentMessageID,
		TeamID:          teamID,
		CreatorID:       creatorID,
		Title:           title,
		MessageCount:    0,
		CreatedAt:       formatTime(time.Now().UTC()),
	}

	_, err = d.conn.Exec(
		`INSERT INTO threads (id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
		t.ID, t.ChannelID, t.ParentMessageID, t.TeamID, t.CreatorID, t.Title, t.MessageCount, t.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// GetThread retrieves a thread by ID.
func (d *DB) GetThread(threadID string) (*Thread, error) {
	var t Thread
	var lastMessageAt sql.NullString
	err := d.conn.QueryRow(
		`SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
		 FROM threads WHERE id = ?`, threadID).Scan(
		&t.ID, &t.ChannelID, &t.ParentMessageID, &t.TeamID, &t.CreatorID,
		&t.Title, &t.MessageCount, &lastMessageAt, &t.CreatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if lastMessageAt.Valid {
		t.LastMessageAt = &lastMessageAt.String
	}
	return &t, nil
}

// GetThreadByParentMessage retrieves the thread for a given parent message.
func (d *DB) GetThreadByParentMessage(messageID string) (*Thread, error) {
	var t Thread
	var lastMessageAt sql.NullString
	err := d.conn.QueryRow(
		`SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
		 FROM threads WHERE parent_message_id = ?`, messageID).Scan(
		&t.ID, &t.ChannelID, &t.ParentMessageID, &t.TeamID, &t.CreatorID,
		&t.Title, &t.MessageCount, &lastMessageAt, &t.CreatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if lastMessageAt.Valid {
		t.LastMessageAt = &lastMessageAt.String
	}
	return &t, nil
}

// GetChannelThreads lists threads in a channel with pagination.
func (d *DB) GetChannelThreads(channelID string, limit, offset int) ([]Thread, error) {
	rows, err := d.conn.Query(
		`SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
		 FROM threads WHERE channel_id = ?
		 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
		channelID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var lastMessageAt sql.NullString
		if err := rows.Scan(&t.ID, &t.ChannelID, &t.ParentMessageID, &t.TeamID, &t.CreatorID,
			&t.Title, &t.MessageCount, &lastMessageAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		if lastMessageAt.Valid {
			t.LastMessageAt = &lastMessageAt.String
		}
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// CreateThreadMessage creates a message in a thread and updates the thread counters.
func (d *DB) CreateThreadMessage(threadID, authorID, content, nonce string) (*Message, error) {
	thread, err := d.GetThread(threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, sql.ErrNoRows
	}

	msg := &Message{
		ID:        newID(),
		ChannelID: thread.ChannelID,
		AuthorID:  authorID,
		Content:   content,
		Type:      "text",
		ThreadID:  threadID,
		CreatedAt: time.Now().UTC(),
	}

	_, err = d.conn.Exec(
		`INSERT INTO messages (id, channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, ?)`,
		msg.ID, msg.ChannelID, msg.AuthorID, msg.Content, msg.Type,
		msg.ThreadID, formatTime(msg.CreatedAt),
	)
	if err != nil {
		return nil, err
	}

	// Update thread message_count and last_message_at.
	now := formatTime(msg.CreatedAt)
	_, err = d.conn.Exec(
		`UPDATE threads SET message_count = message_count + 1, last_message_at = ? WHERE id = ?`,
		now, threadID)
	if err != nil {
		return nil, err
	}

	return msg, nil
}

// GetThreadMessages retrieves messages in a thread with cursor pagination.
func (d *DB) GetThreadMessages(threadID string, before string, limit int) ([]Message, error) {
	var rows *sql.Rows
	var err error

	if before != "" {
		rows, err = d.conn.Query(
			`SELECT id, channel_id, author_id, content, type, COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE thread_id = ? AND deleted = 0 AND created_at < (SELECT created_at FROM messages WHERE id = ?)
			 ORDER BY created_at DESC LIMIT ?`,
			threadID, before, limit)
	} else {
		rows, err = d.conn.Query(
			`SELECT id, channel_id, author_id, content, type, COALESCE(thread_id, ''), edited_at, deleted, lamport_ts, created_at
			 FROM messages
			 WHERE thread_id = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT ?`,
			threadID, limit)
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

// UpdateThread updates a thread's title.
func (d *DB) UpdateThread(threadID, title string) error {
	_, err := d.conn.Exec(`UPDATE threads SET title = ? WHERE id = ?`, title, threadID)
	return err
}

// DeleteThread removes a thread and all its messages (via CASCADE on thread_id).
func (d *DB) DeleteThread(threadID string) error {
	// First soft-delete all thread messages.
	_, err := d.conn.Exec(`UPDATE messages SET deleted = 1, content = X'' WHERE thread_id = ?`, threadID)
	if err != nil {
		return err
	}
	// Then delete the thread record.
	_, err = d.conn.Exec(`DELETE FROM threads WHERE id = ?`, threadID)
	return err
}
