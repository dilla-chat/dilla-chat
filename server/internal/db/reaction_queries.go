package db

import "time"

// AddReaction inserts a reaction. Returns nil if the reaction already exists (idempotent).
func (d *DB) AddReaction(messageID, userID, emoji string) (*Reaction, error) {
	id := newID()
	now := formatTime(time.Now())
	_, err := d.conn.Exec(
		`INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, messageID, userID, emoji, now,
	)
	if err != nil {
		return nil, err
	}

	// Return the actual reaction (may be pre-existing).
	return d.GetUserReaction(messageID, userID, emoji)
}

// RemoveReaction deletes a specific reaction.
func (d *DB) RemoveReaction(messageID, userID, emoji string) error {
	_, err := d.conn.Exec(
		`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji,
	)
	return err
}

// ReactionGroup represents a single emoji with the list of users who reacted.
type ReactionGroup struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"user_ids"`
}

// GetMessageReactions returns reactions grouped by emoji for a message.
func (d *DB) GetMessageReactions(messageID string) ([]ReactionGroup, error) {
	rows, err := d.conn.Query(
		`SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at ASC`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := make(map[string]*ReactionGroup)
	var order []string
	for rows.Next() {
		var emoji, userID string
		if err := rows.Scan(&emoji, &userID); err != nil {
			return nil, err
		}
		g, ok := groups[emoji]
		if !ok {
			g = &ReactionGroup{Emoji: emoji}
			groups[emoji] = g
			order = append(order, emoji)
		}
		g.UserIDs = append(g.UserIDs, userID)
		g.Count++
	}

	result := make([]ReactionGroup, 0, len(order))
	for _, emoji := range order {
		result = append(result, *groups[emoji])
	}
	return result, nil
}

// GetUserReaction returns a single reaction or nil if not found.
func (d *DB) GetUserReaction(messageID, userID, emoji string) (*Reaction, error) {
	row := d.conn.QueryRow(
		`SELECT id, message_id, user_id, emoji, created_at FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji,
	)
	var r Reaction
	var createdAt string
	err := row.Scan(&r.ID, &r.MessageID, &r.UserID, &r.Emoji, &createdAt)
	if err != nil {
		return nil, err
	}
	r.CreatedAt = parseTime(createdAt)
	return &r, nil
}
