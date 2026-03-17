package voice

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TURNCredentialProvider generates ICE server credentials for WebRTC clients.
type TURNCredentialProvider interface {
	GetICEServers() (json.RawMessage, error)
}

// --- Cloudflare TURN (legacy) ---

// CFTurnConfig holds Cloudflare TURN API credentials.
type CFTurnConfig struct {
	KeyID    string
	APIToken string
}

// CFTurnClient fetches short-lived TURN credentials from Cloudflare.
type CFTurnClient struct {
	config CFTurnConfig
	client *http.Client

	mu          sync.RWMutex
	cached      *CFTurnResponse
	cachedUntil time.Time
}

// CFTurnResponse is the response from Cloudflare's generate-ice-servers API.
type CFTurnResponse struct {
	ICEServers json.RawMessage `json:"iceServers"`
}

func NewCFTurnClient(cfg CFTurnConfig) *CFTurnClient {
	return &CFTurnClient{
		config: cfg,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// GetICEServers returns the iceServers array from Cloudflare, caching for 1 hour.
func (c *CFTurnClient) GetICEServers() (json.RawMessage, error) {
	c.mu.RLock()
	if c.cached != nil && time.Now().Before(c.cachedUntil) {
		result := c.cached.ICEServers
		c.mu.RUnlock()
		return result, nil
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()

	// Double-check after acquiring write lock
	if c.cached != nil && time.Now().Before(c.cachedUntil) {
		return c.cached.ICEServers, nil
	}

	url := fmt.Sprintf("https://rtc.live.cloudflare.com/v1/turn/keys/%s/credentials/generate-ice-servers", c.config.KeyID)
	body := []byte(`{"ttl": 86400}`)

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.config.APIToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare TURN API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("cloudflare TURN API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result CFTurnResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode CF TURN response: %w", err)
	}

	c.cached = &result
	c.cachedUntil = time.Now().Add(1 * time.Hour)

	slog.Debug("fetched fresh Cloudflare TURN credentials")
	return result.ICEServers, nil
}

// --- Self-hosted TURN ---

// SelfHostedTurnClient generates HMAC-SHA1 credentials for a self-hosted TURN server.
type SelfHostedTurnClient struct {
	sharedSecret string
	turnURLs     []string
	ttl          time.Duration
}

// NewSelfHostedTurnClient creates a credential provider for a self-hosted TURN server.
func NewSelfHostedTurnClient(sharedSecret string, turnURLs []string, ttl time.Duration) *SelfHostedTurnClient {
	return &SelfHostedTurnClient{
		sharedSecret: sharedSecret,
		turnURLs:     turnURLs,
		ttl:          ttl,
	}
}

// GetICEServers generates fresh HMAC-SHA1 credentials and returns an iceServers JSON array.
func (c *SelfHostedTurnClient) GetICEServers() (json.RawMessage, error) {
	expiry := time.Now().Add(c.ttl).Unix()
	username := fmt.Sprintf("%d:%s", expiry, uuid.New().String()[:8])

	mac := hmac.New(sha1.New, []byte(c.sharedSecret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	iceServer := struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
	}{
		URLs:       c.turnURLs,
		Username:   username,
		Credential: password,
	}

	data, err := json.Marshal([]interface{}{iceServer})
	if err != nil {
		return nil, fmt.Errorf("marshal ICE servers: %w", err)
	}

	return json.RawMessage(data), nil
}
