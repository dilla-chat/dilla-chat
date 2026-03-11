package db

import (
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed migrations
var migrationsFS embed.FS

type DB struct {
	conn *sql.DB
}

func Open(dataDir, passphrase string) (*DB, error) {
	dbPath := filepath.Join(dataDir, "slimcord.db")

	dsn := fmt.Sprintf("file:%s?_pragma_key=%s&_journal_mode=WAL", dbPath, passphrase)
	if passphrase == "" {
		dsn = fmt.Sprintf("file:%s?_journal_mode=WAL", dbPath)
	}

	conn, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	slog.Info("database opened", "path", dbPath)
	return &DB{conn: conn}, nil
}

func (d *DB) RunMigrations() error {
	_, err := d.conn.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, f := range files {
		var count int
		if err := d.conn.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version = ?", f).Scan(&count); err != nil {
			return fmt.Errorf("check migration %s: %w", f, err)
		}
		if count > 0 {
			continue
		}

		content, err := migrationsFS.ReadFile(filepath.Join("migrations", f))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", f, err)
		}

		sqlStr := strings.TrimSpace(string(content))
		if sqlStr == "" || strings.HasPrefix(sqlStr, "--") && !strings.Contains(sqlStr, "\n") {
			slog.Info("skipping empty migration", "file", f)
		} else {
			if _, err := d.conn.Exec(sqlStr); err != nil {
				return fmt.Errorf("apply migration %s: %w", f, err)
			}
		}

		if _, err := d.conn.Exec("INSERT INTO schema_migrations (version) VALUES (?)", f); err != nil {
			return fmt.Errorf("record migration %s: %w", f, err)
		}
		slog.Info("applied migration", "file", f)
	}

	return nil
}

func (d *DB) HasUsers() (bool, error) {
	var count int
	err := d.conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (d *DB) Conn() *sql.DB {
	return d.conn
}

func (d *DB) Close() error {
	return d.conn.Close()
}

// EnsureDataDir creates the data directory if it does not exist.
func EnsureDataDir(dir string) error {
	return os.MkdirAll(dir, 0750)
}
