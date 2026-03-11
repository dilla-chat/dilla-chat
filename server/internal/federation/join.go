package federation

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// JoinManager handles new node onboarding to the mesh.
type JoinManager struct {
	node   *MeshNode
	secret []byte
}

// JoinInfo contains the information needed for a new node to join.
type JoinInfo struct {
	TeamID    string    `json:"team_id"`
	TeamName  string    `json:"team_name"`
	Peers     []string  `json:"peers"`
	ExpiresAt time.Time `json:"expires_at"`
}

// NewJoinManager creates a new join manager.
func NewJoinManager(node *MeshNode) *JoinManager {
	secret := make([]byte, 32)
	rand.Read(secret)
	return &JoinManager{
		node:   node,
		secret: secret,
	}
}

// GenerateJoinToken creates a signed token allowing a new node to join the mesh.
func (jm *JoinManager) GenerateJoinToken(creatorID string) (string, error) {
	database := jm.node.db
	team, err := database.GetFirstTeam()
	if err != nil || team == nil {
		return "", errors.New("no team configured")
	}

	// Collect current peer addresses.
	peers := make([]string, 0)
	if jm.node.config.AdvertiseAddr != "" {
		addr := jm.node.config.AdvertiseAddr
		if jm.node.config.AdvertisePort > 0 {
			addr = fmt.Sprintf("%s:%d", addr, jm.node.config.AdvertisePort)
		}
		peers = append(peers, addr)
	}
	for _, p := range jm.node.GetPeers() {
		if p.Status == PeerStatusConnected {
			peers = append(peers, p.Address)
		}
	}

	expiresAt := time.Now().Add(24 * time.Hour)
	claims := jwt.MapClaims{
		"team_id":   team.ID,
		"team_name": team.Name,
		"peers":     peers,
		"creator":   creatorID,
		"exp":       expiresAt.Unix(),
		"iat":       time.Now().Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jm.secret)
}

// ValidateJoinToken validates and decodes a join token.
func (jm *JoinManager) ValidateJoinToken(tokenStr string) (*JoinInfo, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return jm.secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	info := &JoinInfo{
		TeamID:   claimString(claims, "team_id"),
		TeamName: claimString(claims, "team_name"),
	}

	if peersRaw, ok := claims["peers"]; ok {
		if arr, ok := peersRaw.([]interface{}); ok {
			for _, p := range arr {
				if s, ok := p.(string); ok {
					info.Peers = append(info.Peers, s)
				}
			}
		}
	}

	if exp, err := claims.GetExpirationTime(); err == nil && exp != nil {
		info.ExpiresAt = exp.Time
	}

	return info, nil
}

// HandleNodeJoin processes a new node joining the mesh.
func (jm *JoinManager) HandleNodeJoin(peerAddr string) error {
	slog.Info("federation: new node joining", "address", peerAddr)

	if err := jm.node.syncMgr.HandleStateSyncRequest(peerAddr); err != nil {
		slog.Error("federation: state sync to new node failed", "peer", peerAddr, "error", err)
		return err
	}

	payload, _ := json.Marshal(map[string]string{
		"address": peerAddr,
	})

	evt := FederationEvent{
		Type:      FedEventMemberJoined,
		NodeName:  jm.node.config.NodeName,
		Timestamp: jm.node.syncMgr.Tick(),
		Payload:   json.RawMessage(payload),
	}
	jm.node.transport.Broadcast(evt)

	return nil
}

func claimString(claims jwt.MapClaims, key string) string {
	if v, ok := claims[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
