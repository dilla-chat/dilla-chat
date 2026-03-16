package observability

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
)

// Safe attribute keys (allowlisted for traces/metrics).
const (
	AttrHTTPMethod     = "http.method"
	AttrHTTPRoute      = "http.route"
	AttrHTTPStatusCode = "http.status_code"
	AttrHTTPDurationMS = "http.duration_ms"
	AttrWSEventType    = "ws.event_type"
	AttrDBQueryName    = "db.query_name"
	AttrDBError        = "db.error"
	AttrUserID         = "user_id"
	AttrTeamID         = "team_id"
	AttrChannelID      = "channel_id"
	AttrMessageID      = "message_id"
	AttrFedDirection   = "federation.direction"
)

// uuidPattern matches UUID-like path segments (8-4-4-4-12 hex).
var uuidPattern = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// SanitizeRoute replaces UUIDs in URL paths with {id} to prevent
// high-cardinality metric labels.
func SanitizeRoute(path string) string {
	return uuidPattern.ReplaceAllString(path, "{id}")
}

// HashIP returns a truncated SHA-256 hash of an IP address for anonymous
// identification without storing the raw IP.
func HashIP(ip string) string {
	h := sha256.Sum256([]byte(ip))
	return hex.EncodeToString(h[:8])
}
