package federation

import (
	"fmt"

	"github.com/dilla/dilla-server/internal/db"
)

// FederatedIdentity manages user identity resolution across the mesh.
type FederatedIdentity struct {
	db *db.DB
}

// NewFederatedIdentity creates a new federated identity resolver.
func NewFederatedIdentity(database *db.DB) *FederatedIdentity {
	return &FederatedIdentity{db: database}
}

// ResolveUser finds a user by their public key.
func (fi *FederatedIdentity) ResolveUser(publicKey []byte) (*db.User, error) {
	return fi.db.GetUserByPublicKey(publicKey)
}

// UserAddress returns the federated address format: user@instance.
func (fi *FederatedIdentity) UserAddress(username, instanceAddr string) string {
	return fmt.Sprintf("%s@%s", username, instanceAddr)
}
