package db

import "time"

// CreateAttachment inserts a new attachment record and returns it.
func (d *DB) CreateAttachment(messageID string, filenameEncrypted, contentTypeEncrypted []byte, size int64, storagePath string) (*Attachment, error) {
	id := newID()
	now := formatTime(time.Now())
	_, err := d.conn.Exec(
		`INSERT INTO attachments (id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, messageID, filenameEncrypted, contentTypeEncrypted, size, storagePath, now,
	)
	if err != nil {
		return nil, err
	}
	return d.GetAttachment(id)
}

// CreateAttachmentWithID inserts an attachment with a pre-generated ID.
func (d *DB) CreateAttachmentWithID(id, messageID string, filenameEncrypted, contentTypeEncrypted []byte, size int64, storagePath string) (*Attachment, error) {
	now := formatTime(time.Now())
	_, err := d.conn.Exec(
		`INSERT INTO attachments (id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, messageID, filenameEncrypted, contentTypeEncrypted, size, storagePath, now,
	)
	if err != nil {
		return nil, err
	}
	return d.GetAttachment(id)
}

// GetAttachment returns a single attachment by ID, or nil if not found.
func (d *DB) GetAttachment(attachmentID string) (*Attachment, error) {
	row := d.conn.QueryRow(
		`SELECT id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at
		 FROM attachments WHERE id = ?`,
		attachmentID,
	)
	var a Attachment
	var createdAt string
	err := row.Scan(&a.ID, &a.MessageID, &a.FilenameEncrypted, &a.ContentTypeEncrypted, &a.Size, &a.StoragePath, &createdAt)
	if err != nil {
		return nil, err
	}
	a.CreatedAt = parseTime(createdAt)
	return &a, nil
}

// GetMessageAttachments returns all attachments for a message.
func (d *DB) GetMessageAttachments(messageID string) ([]Attachment, error) {
	rows, err := d.conn.Query(
		`SELECT id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at
		 FROM attachments WHERE message_id = ? ORDER BY created_at ASC`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attachments []Attachment
	for rows.Next() {
		var a Attachment
		var createdAt string
		if err := rows.Scan(&a.ID, &a.MessageID, &a.FilenameEncrypted, &a.ContentTypeEncrypted, &a.Size, &a.StoragePath, &createdAt); err != nil {
			return nil, err
		}
		a.CreatedAt = parseTime(createdAt)
		attachments = append(attachments, a)
	}
	return attachments, nil
}

// DeleteAttachment removes an attachment record by ID.
func (d *DB) DeleteAttachment(attachmentID string) error {
	_, err := d.conn.Exec(`DELETE FROM attachments WHERE id = ?`, attachmentID)
	return err
}
