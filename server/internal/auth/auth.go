package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/slimcord/slimcord-server/internal/db"
)

type contextKey string

const UserIDKey contextKey = "user_id"

type challenge struct {
	nonce     []byte
	createdAt time.Time
}

type AuthService struct {
	db         *db.DB
	jwtSecret  []byte
	challenges sync.Map
}

func NewAuthService(database *db.DB) *AuthService {
	// Try to load persisted JWT secret from DB, generate one if not found.
	secret, err := database.GetSetting("jwt_secret")
	if err != nil || secret == "" {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			panic("failed to generate JWT secret: " + err.Error())
		}
		secret = base64.StdEncoding.EncodeToString(raw)
		_ = database.SetSetting("jwt_secret", secret)
	}
	decoded, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		panic("failed to decode JWT secret: " + err.Error())
	}
	a := &AuthService{
		db:        database,
		jwtSecret: decoded,
	}
	// Background goroutine to clean up expired challenges.
	go a.cleanupChallenges()
	return a
}

// GenerateChallenge creates a random nonce for challenge-response auth.
func (a *AuthService) GenerateChallenge() (nonce []byte, challengeID string, err error) {
	nonce = make([]byte, 32)
	if _, err = rand.Read(nonce); err != nil {
		return nil, "", fmt.Errorf("generate nonce: %w", err)
	}
	idBytes := make([]byte, 16)
	if _, err = rand.Read(idBytes); err != nil {
		return nil, "", fmt.Errorf("generate challenge id: %w", err)
	}
	challengeID = hex.EncodeToString(idBytes)
	a.challenges.Store(challengeID, &challenge{nonce: nonce, createdAt: time.Now()})
	return nonce, challengeID, nil
}

// VerifyChallenge verifies the signature against the stored nonce.
func (a *AuthService) VerifyChallenge(challengeID string, publicKey ed25519.PublicKey, signature []byte) (bool, error) {
	val, ok := a.challenges.LoadAndDelete(challengeID)
	if !ok {
		return false, fmt.Errorf("challenge not found or expired")
	}
	c := val.(*challenge)
	if time.Since(c.createdAt) > 5*time.Minute {
		return false, fmt.Errorf("challenge expired")
	}
	return ed25519.Verify(publicKey, c.nonce, signature), nil
}

// GenerateJWT creates a JWT token for an authenticated user.
func (a *AuthService) GenerateJWT(userID string) (string, error) {
	claims := jwt.MapClaims{
		"sub": userID,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(a.jwtSecret)
}

// ValidateJWT validates a JWT token and returns the user ID.
func (a *AuthService) ValidateJWT(tokenString string) (string, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return a.jwtSecret, nil
	})
	if err != nil {
		return "", err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return "", fmt.Errorf("invalid token")
	}
	userID, ok := claims["sub"].(string)
	if !ok {
		return "", fmt.Errorf("invalid token claims")
	}
	return userID, nil
}

// AuthMiddleware validates JWT from the Authorization header.
func (a *AuthService) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenString == authHeader {
			http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
			return
		}
		userID, err := a.ValidateJWT(tokenString)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), UserIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GenerateBootstrapToken creates a one-time first-user setup token.
func (a *AuthService) GenerateBootstrapToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate bootstrap token: %w", err)
	}
	token := hex.EncodeToString(b)
	if err := a.db.CreateBootstrapToken(token); err != nil {
		return "", fmt.Errorf("store bootstrap token: %w", err)
	}
	return token, nil
}

// GenerateInviteToken creates a new invite token string.
func (a *AuthService) GenerateInviteToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *AuthService) cleanupChallenges() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		a.challenges.Range(func(key, value interface{}) bool {
			c := value.(*challenge)
			if time.Since(c.createdAt) > 5*time.Minute {
				a.challenges.Delete(key)
			}
			return true
		})
	}
}

// GetDB returns the underlying database.
func (a *AuthService) GetDB() *db.DB {
	return a.db
}
