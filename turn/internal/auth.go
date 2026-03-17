package internal

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pion/turn/v4"
)

// GenerateCredentials creates time-limited TURN credentials using the
// standard HMAC-SHA1 scheme (compatible with coturn's static-auth-secret).
// username = "expiry_timestamp:random_id"
// password = Base64(HMAC-SHA1(secret, username))
func GenerateCredentials(sharedSecret string, ttl time.Duration) (username, password string) {
	expiry := time.Now().Add(ttl).Unix()
	username = fmt.Sprintf("%d:%s", expiry, uuid.New().String()[:8])
	mac := hmac.New(sha1.New, []byte(sharedSecret))
	mac.Write([]byte(username))
	password = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, password
}

// NewAuthHandler returns a pion/turn AuthHandler that validates HMAC-SHA1
// credentials against the shared secret.
func NewAuthHandler(sharedSecret, realm string) turn.AuthHandler {
	return func(username, rlm string, srcAddr net.Addr) (key []byte, ok bool) {
		// Parse expiry from username (format: "timestamp:id")
		parts := strings.SplitN(username, ":", 2)
		if len(parts) != 2 {
			return nil, false
		}

		expiry, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return nil, false
		}

		if time.Now().Unix() > expiry {
			return nil, false
		}

		// Compute the expected password
		mac := hmac.New(sha1.New, []byte(sharedSecret))
		mac.Write([]byte(username))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		return turn.GenerateAuthKey(username, realm, password), true
	}
}
