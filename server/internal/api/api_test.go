package api_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/dilla/dilla-server/internal/api"
	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/ws"
)

// testEnv holds everything needed for a single test server instance.
type testEnv struct {
	server  *httptest.Server
	db      *db.DB
	authSvc *auth.AuthService
}

func setupTestServer(t *testing.T) (*testEnv, func()) {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "dilla-test-*")
	if err != nil {
		t.Fatal("create temp dir:", err)
	}

	database, err := db.Open(tmpDir, "")
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatal("open db:", err)
	}

	if err := database.RunMigrations(); err != nil {
		database.Close()
		os.RemoveAll(tmpDir)
		t.Fatal("run migrations:", err)
	}

	authSvc := auth.NewAuthService(database)
	hub := ws.NewHub(database)
	go hub.Run()

	handler := api.NewRouter(database, authSvc, hub)
	server := httptest.NewServer(handler)

	env := &testEnv{server: server, db: database, authSvc: authSvc}
	cleanup := func() {
		server.Close()
		database.Close()
		os.RemoveAll(tmpDir)
	}
	return env, cleanup
}

// generateKeypair returns a new Ed25519 keypair with keys base64-encoded.
func generateKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("generate keypair:", err)
	}
	return pub, priv, base64.StdEncoding.EncodeToString(pub)
}

// doRequest sends a request and returns the response.
func doRequest(t *testing.T, method, url string, body interface{}, token string) *http.Response {
	t.Helper()
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal("marshal body:", err)
		}
		bodyReader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		t.Fatal("create request:", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal("do request:", err)
	}
	return resp
}

// parseJSON reads response body into a map.
func parseJSON(t *testing.T, resp *http.Response) map[string]interface{} {
	t.Helper()
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal("read body:", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal JSON: %v, body: %s", err, string(data))
	}
	return result
}

// assertStatus checks the HTTP status code.
func assertStatus(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	if resp.StatusCode != expected {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("expected status %d, got %d, body: %s", expected, resp.StatusCode, string(body))
	}
}

// bootstrapUser creates the first user via bootstrap and returns the JWT token and user info.
func bootstrapUser(t *testing.T, env *testEnv) (token string, userID string, teamID string, pub ed25519.PublicKey, priv ed25519.PrivateKey) {
	t.Helper()

	pub, priv, pubB64 := generateKeypair(t)

	// Generate a bootstrap token.
	bsToken, err := env.authSvc.GenerateBootstrapToken()
	if err != nil {
		t.Fatal("generate bootstrap token:", err)
	}

	resp := doRequest(t, "POST", env.server.URL+"/api/v1/auth/bootstrap", map[string]string{
		"username":        "admin",
		"display_name":    "Admin User",
		"public_key":      pubB64,
		"bootstrap_token": bsToken,
		"team_name":       "Test Team",
	}, "")
	assertStatus(t, resp, http.StatusCreated)

	result := parseJSON(t, resp)
	token, _ = result["token"].(string)
	if token == "" {
		t.Fatal("bootstrap returned empty token")
	}
	user := result["user"].(map[string]interface{})
	userID, _ = user["id"].(string)
	team := result["team"].(map[string]interface{})
	teamID, _ = team["id"].(string)
	return token, userID, teamID, pub, priv
}

func TestHealthEndpoint(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	resp := doRequest(t, "GET", env.server.URL+"/api/v1/health", nil, "")
	assertStatus(t, resp, http.StatusOK)

	result := parseJSON(t, resp)
	if result["status"] != "ok" {
		t.Fatalf("expected status 'ok', got %v", result["status"])
	}
	if _, ok := result["uptime"]; !ok {
		t.Fatal("expected 'uptime' in response")
	}
}

func TestVersionEndpoint(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	resp := doRequest(t, "GET", env.server.URL+"/api/v1/version", nil, "")
	assertStatus(t, resp, http.StatusOK)

	result := parseJSON(t, resp)
	if _, ok := result["version"]; !ok {
		t.Fatal("expected 'version' in response")
	}
	if _, ok := result["go_version"]; !ok {
		t.Fatal("expected 'go_version' in response")
	}
}

func TestBootstrapFlow(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	// Verify no users exist.
	hasUsers, err := env.db.HasUsers()
	if err != nil {
		t.Fatal("hasUsers:", err)
	}
	if hasUsers {
		t.Fatal("expected no users initially")
	}

	_, _, pubB64Actual := generateKeypair(t)

	bsToken, err := env.authSvc.GenerateBootstrapToken()
	if err != nil {
		t.Fatal("generate bootstrap token:", err)
	}

	// Bootstrap the first user.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/auth/bootstrap", map[string]string{
		"username":        "admin",
		"display_name":    "Admin",
		"public_key":      pubB64Actual,
		"bootstrap_token": bsToken,
		"team_name":       "My Team",
	}, "")
	assertStatus(t, resp, http.StatusCreated)

	result := parseJSON(t, resp)

	// Verify response fields.
	token, _ := result["token"].(string)
	if token == "" {
		t.Fatal("expected token in bootstrap response")
	}
	user, ok := result["user"].(map[string]interface{})
	if !ok {
		t.Fatal("expected user in bootstrap response")
	}
	if user["username"] != "admin" {
		t.Fatalf("expected username 'admin', got %v", user["username"])
	}
	if user["is_admin"] != true {
		t.Fatal("expected admin user to have is_admin=true")
	}

	team, ok := result["team"].(map[string]interface{})
	if !ok {
		t.Fatal("expected team in bootstrap response")
	}
	if team["name"] != "My Team" {
		t.Fatalf("expected team name 'My Team', got %v", team["name"])
	}
	teamID, _ := team["id"].(string)

	// Verify token works for an authenticated endpoint.
	resp2 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels", nil, token)
	assertStatus(t, resp2, http.StatusOK)
	resp2.Body.Close()

	// Verify bootstrap token can't be reused.
	_, _, pubB64_2 := generateKeypair(t)
	resp3 := doRequest(t, "POST", env.server.URL+"/api/v1/auth/bootstrap", map[string]string{
		"username":        "admin2",
		"display_name":    "Admin 2",
		"public_key":      pubB64_2,
		"bootstrap_token": bsToken,
		"team_name":       "Another Team",
	}, "")
	if resp3.StatusCode != http.StatusBadRequest && resp3.StatusCode != http.StatusConflict {
		t.Fatalf("expected 400 or 409 for reused bootstrap token, got %d", resp3.StatusCode)
	}
	resp3.Body.Close()
}

func TestChallengeResponseAuth(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	_, _, testTeamID, pub, priv := bootstrapUser(t, env)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	// Step 1: Request a challenge.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/auth/challenge", map[string]string{
		"public_key": pubB64,
	}, "")
	assertStatus(t, resp, http.StatusOK)

	result := parseJSON(t, resp)
	challengeID, _ := result["challenge_id"].(string)
	nonceB64, _ := result["nonce"].(string)
	if challengeID == "" || nonceB64 == "" {
		t.Fatal("expected challenge_id and nonce")
	}

	// Step 2: Sign the nonce.
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		t.Fatal("decode nonce:", err)
	}
	signature := ed25519.Sign(priv, nonce)
	sigB64 := base64.StdEncoding.EncodeToString(signature)

	// Step 3: Verify the challenge.
	resp2 := doRequest(t, "POST", env.server.URL+"/api/v1/auth/verify", map[string]string{
		"challenge_id": challengeID,
		"public_key":   pubB64,
		"signature":    sigB64,
	}, "")
	assertStatus(t, resp2, http.StatusOK)

	result2 := parseJSON(t, resp2)
	jwtToken, _ := result2["token"].(string)
	if jwtToken == "" {
		t.Fatal("expected JWT token from verify")
	}
	verifyUser, ok := result2["user"].(map[string]interface{})
	if !ok || verifyUser["username"] != "admin" {
		t.Fatal("expected user object with username admin")
	}

	// Step 4: Verify the JWT works.
	resp3 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+testTeamID+"/channels", nil, jwtToken)
	assertStatus(t, resp3, http.StatusOK)
	resp3.Body.Close()
}

func TestInviteFlow(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	adminToken, _, teamID, _, _ := bootstrapUser(t, env)

	// Create an invite.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/teams/"+teamID+"/invites", map[string]interface{}{
		"max_uses": 5,
	}, adminToken)
	assertStatus(t, resp, http.StatusCreated)

	result := parseJSON(t, resp)
	invite, ok := result["invite"].(map[string]interface{})
	if !ok {
		t.Fatal("expected invite in response")
	}
	inviteToken, _ := invite["token"].(string)
	if inviteToken == "" {
		t.Fatal("expected invite token")
	}

	// List invites.
	resp2 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/invites", nil, adminToken)
	assertStatus(t, resp2, http.StatusOK)
	result2 := parseJSON(t, resp2)
	invites, ok := result2["invites"].([]interface{})
	if !ok || len(invites) < 1 {
		t.Fatal("expected at least 1 invite")
	}

	// Get invite info (unauthenticated).
	resp3 := doRequest(t, "GET", env.server.URL+"/api/v1/invites/"+inviteToken+"/info", nil, "")
	assertStatus(t, resp3, http.StatusOK)
	result3 := parseJSON(t, resp3)
	if result3["team_name"] != "Test Team" {
		t.Fatalf("expected team_name 'Test Team', got %v", result3["team_name"])
	}

	// Register a new user with the invite.
	_, _, newPubB64 := generateKeypair(t)
	resp4 := doRequest(t, "POST", env.server.URL+"/api/v1/auth/register", map[string]string{
		"username":     "newuser",
		"display_name": "New User",
		"public_key":   newPubB64,
		"invite_token": inviteToken,
	}, "")
	assertStatus(t, resp4, http.StatusCreated)

	result4 := parseJSON(t, resp4)
	newUserToken, _ := result4["token"].(string)
	if newUserToken == "" {
		t.Fatal("expected token for new user")
	}
	newUser, ok := result4["user"].(map[string]interface{})
	if !ok || newUser["username"] != "newuser" {
		t.Fatal("expected user with username 'newuser'")
	}

	// Verify new user can authenticate.
	resp5 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels", nil, newUserToken)
	assertStatus(t, resp5, http.StatusOK)
	resp5.Body.Close()

	// Verify invite use count incremented.
	resp6 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/invites", nil, adminToken)
	assertStatus(t, resp6, http.StatusOK)
	result6 := parseJSON(t, resp6)
	invitesAfter, _ := result6["invites"].([]interface{})
	if len(invitesAfter) < 1 {
		t.Fatal("expected invites list")
	}
	firstInvite := invitesAfter[0].(map[string]interface{})
	uses, _ := firstInvite["uses"].(float64)
	if uses < 1 {
		t.Fatalf("expected invite uses >= 1, got %v", uses)
	}
}

func TestChannelCRUD(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	token, _, teamID, _, _ := bootstrapUser(t, env)

	// Create a channel.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/teams/"+teamID+"/channels", map[string]string{
		"name":     "test-channel",
		"type":     "text",
		"topic":    "Test topic",
		"category": "Testing",
	}, token)
	assertStatus(t, resp, http.StatusCreated)

	result := parseJSON(t, resp)
	ch, ok := result["channel"].(map[string]interface{})
	if !ok {
		t.Fatal("expected channel in response")
	}
	channelID, _ := ch["id"].(string)
	if channelID == "" {
		t.Fatal("expected channel id")
	}
	if ch["name"] != "test-channel" {
		t.Fatalf("expected name 'test-channel', got %v", ch["name"])
	}

	// List channels — should include the new one plus bootstrap defaults.
	resp2 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels", nil, token)
	assertStatus(t, resp2, http.StatusOK)
	result2 := parseJSON(t, resp2)
	channels, _ := result2["channels"].([]interface{})
	found := false
	for _, c := range channels {
		cm := c.(map[string]interface{})
		if cm["id"] == channelID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("created channel not found in list")
	}

	// Get channel by ID.
	resp3 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID, nil, token)
	assertStatus(t, resp3, http.StatusOK)
	result3 := parseJSON(t, resp3)
	getCh := result3["channel"].(map[string]interface{})
	if getCh["name"] != "test-channel" {
		t.Fatal("get channel returned wrong name")
	}

	// Update channel name.
	resp4 := doRequest(t, "PATCH", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID, map[string]interface{}{
		"name": "updated-channel",
	}, token)
	assertStatus(t, resp4, http.StatusOK)
	result4 := parseJSON(t, resp4)
	updCh := result4["channel"].(map[string]interface{})
	if updCh["name"] != "updated-channel" {
		t.Fatalf("expected updated name 'updated-channel', got %v", updCh["name"])
	}

	// Delete channel.
	resp5 := doRequest(t, "DELETE", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID, nil, token)
	assertStatus(t, resp5, http.StatusOK)
	resp5.Body.Close()

	// Verify deleted.
	resp6 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels", nil, token)
	assertStatus(t, resp6, http.StatusOK)
	result6 := parseJSON(t, resp6)
	channelsAfter, _ := result6["channels"].([]interface{})
	for _, c := range channelsAfter {
		cm := c.(map[string]interface{})
		if cm["id"] == channelID {
			t.Fatal("deleted channel still present in list")
		}
	}
}

func TestMessageCRUD(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	token, _, teamID, _, _ := bootstrapUser(t, env)

	// Create a channel for messages.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/teams/"+teamID+"/channels", map[string]string{
		"name": "msg-channel",
		"type": "text",
	}, token)
	assertStatus(t, resp, http.StatusCreated)
	chResult := parseJSON(t, resp)
	channelID := chResult["channel"].(map[string]interface{})["id"].(string)

	// Send a message.
	resp2 := doRequest(t, "POST", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages", map[string]string{
		"content": "Hello, world!",
	}, token)
	assertStatus(t, resp2, http.StatusCreated)
	msgResult := parseJSON(t, resp2)
	msg := msgResult["message"].(map[string]interface{})
	msgID, _ := msg["id"].(string)
	if msgID == "" {
		t.Fatal("expected message id")
	}

	// List messages.
	resp3 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages", nil, token)
	assertStatus(t, resp3, http.StatusOK)
	listResult := parseJSON(t, resp3)
	messages, _ := listResult["messages"].([]interface{})
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	// Edit message.
	resp4 := doRequest(t, "PATCH", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages/"+msgID, map[string]string{
		"content": "Updated message",
	}, token)
	assertStatus(t, resp4, http.StatusOK)
	resp4.Body.Close()

	// Verify edit by fetching messages again.
	resp5 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages", nil, token)
	assertStatus(t, resp5, http.StatusOK)
	listResult2 := parseJSON(t, resp5)
	messages2 := listResult2["messages"].([]interface{})
	editedMsg := messages2[0].(map[string]interface{})
	// Content is stored as []byte, so it's base64-encoded in JSON.
	// Check that edited_at is now set.
	if editedMsg["edited_at"] == nil {
		t.Fatal("expected edited_at to be set after edit")
	}

	// Delete message.
	resp6 := doRequest(t, "DELETE", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages/"+msgID, nil, token)
	assertStatus(t, resp6, http.StatusOK)
	resp6.Body.Close()

	// Verify deleted (soft delete - message may still appear but with deleted=true,
	// or it may be filtered out depending on implementation).
	resp7 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/channels/"+channelID+"/messages", nil, token)
	assertStatus(t, resp7, http.StatusOK)
	listResult3 := parseJSON(t, resp7)
	messages3, _ := listResult3["messages"].([]interface{})
	for _, m := range messages3 {
		mm := m.(map[string]interface{})
		if mm["id"] == msgID {
			if deleted, ok := mm["deleted"].(bool); ok && !deleted {
				t.Fatal("expected deleted message to have deleted=true")
			}
		}
	}
}

func TestRoleCRUD(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	token, _, teamID, _, _ := bootstrapUser(t, env)

	// Create a role.
	resp := doRequest(t, "POST", env.server.URL+"/api/v1/teams/"+teamID+"/roles", map[string]interface{}{
		"name":        "moderator",
		"color":       "#FF5733",
		"permissions": 0,
	}, token)
	assertStatus(t, resp, http.StatusCreated)

	result := parseJSON(t, resp)
	role := result["role"].(map[string]interface{})
	roleID, _ := role["id"].(string)
	if roleID == "" {
		t.Fatal("expected role id")
	}
	if role["name"] != "moderator" {
		t.Fatalf("expected role name 'moderator', got %v", role["name"])
	}

	// List roles.
	resp2 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/roles", nil, token)
	assertStatus(t, resp2, http.StatusOK)
	result2 := parseJSON(t, resp2)
	roles, _ := result2["roles"].([]interface{})
	if len(roles) < 2 { // default "everyone" + "moderator"
		t.Fatalf("expected at least 2 roles, got %d", len(roles))
	}

	// Update role.
	resp3 := doRequest(t, "PATCH", env.server.URL+"/api/v1/teams/"+teamID+"/roles/"+roleID, map[string]interface{}{
		"name":  "senior-mod",
		"color": "#00FF00",
	}, token)
	assertStatus(t, resp3, http.StatusOK)
	result3 := parseJSON(t, resp3)
	updRole := result3["role"].(map[string]interface{})
	if updRole["name"] != "senior-mod" {
		t.Fatalf("expected updated role name 'senior-mod', got %v", updRole["name"])
	}

	// Delete role.
	resp4 := doRequest(t, "DELETE", env.server.URL+"/api/v1/teams/"+teamID+"/roles/"+roleID, nil, token)
	assertStatus(t, resp4, http.StatusOK)
	resp4.Body.Close()

	// Verify deletion.
	resp5 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/roles", nil, token)
	assertStatus(t, resp5, http.StatusOK)
	result5 := parseJSON(t, resp5)
	rolesAfter, _ := result5["roles"].([]interface{})
	for _, r := range rolesAfter {
		rm := r.(map[string]interface{})
		if rm["id"] == roleID {
			t.Fatal("deleted role still present")
		}
	}
}

func TestTeamEndpoints(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	token, _, teamID, _, _ := bootstrapUser(t, env)

	// Get team.
	resp := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID, nil, token)
	assertStatus(t, resp, http.StatusOK)
	result := parseJSON(t, resp)
	team, ok := result["team"].(map[string]interface{})
	if !ok {
		t.Fatal("expected team in response")
	}
	if team["name"] != "Test Team" {
		t.Fatalf("expected team name 'Test Team', got %v", team["name"])
	}

	// Update team name.
	resp2 := doRequest(t, "PATCH", env.server.URL+"/api/v1/teams/"+teamID, map[string]interface{}{
		"name":        "Updated Team",
		"description": "A test team",
	}, token)
	assertStatus(t, resp2, http.StatusOK)
	result2 := parseJSON(t, resp2)
	updTeam := result2["team"].(map[string]interface{})
	if updTeam["name"] != "Updated Team" {
		t.Fatalf("expected 'Updated Team', got %v", updTeam["name"])
	}

	// List members.
	resp3 := doRequest(t, "GET", env.server.URL+"/api/v1/teams/"+teamID+"/members", nil, token)
	assertStatus(t, resp3, http.StatusOK)
	result3 := parseJSON(t, resp3)
	members, ok := result3["members"].([]interface{})
	if !ok || len(members) < 1 {
		t.Fatal("expected at least 1 member")
	}
	firstMember := members[0].(map[string]interface{})
	if firstMember["username"] != "admin" {
		t.Fatalf("expected member username 'admin', got %v", firstMember["username"])
	}
}

func TestAuthMiddleware(t *testing.T) {
	env, cleanup := setupTestServer(t)
	defer cleanup()

	// Bootstrap so team/channels exist.
	_, _, teamID, _, _ := bootstrapUser(t, env)

	protectedEndpoints := []struct {
		method string
		path   string
	}{
		{"GET", "/api/v1/teams/" + teamID + "/channels"},
		{"POST", "/api/v1/teams/" + teamID + "/channels"},
		{"GET", "/api/v1/teams/" + teamID + "/invites"},
		{"POST", "/api/v1/teams/" + teamID + "/invites"},
		{"GET", "/api/v1/teams/" + teamID + "/roles"},
		{"POST", "/api/v1/teams/" + teamID + "/roles"},
		{"GET", "/api/v1/teams/" + teamID},
		{"PATCH", "/api/v1/teams/" + teamID},
		{"GET", "/api/v1/teams/" + teamID + "/members"},
	}

	for _, ep := range protectedEndpoints {
		t.Run(fmt.Sprintf("%s_%s_no_token", ep.method, ep.path), func(t *testing.T) {
			var body interface{}
			if ep.method == "POST" || ep.method == "PATCH" {
				body = map[string]string{"name": "test"}
			}
			resp := doRequest(t, ep.method, env.server.URL+ep.path, body, "")
			if resp.StatusCode != http.StatusUnauthorized {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("expected 401 for %s %s without token, got %d: %s", ep.method, ep.path, resp.StatusCode, string(body))
			}
			resp.Body.Close()
		})

		t.Run(fmt.Sprintf("%s_%s_bad_token", ep.method, ep.path), func(t *testing.T) {
			var body interface{}
			if ep.method == "POST" || ep.method == "PATCH" {
				body = map[string]string{"name": "test"}
			}
			resp := doRequest(t, ep.method, env.server.URL+ep.path, body, "invalid-token-xyz")
			if resp.StatusCode != http.StatusUnauthorized {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("expected 401 for %s %s with bad token, got %d: %s", ep.method, ep.path, resp.StatusCode, string(body))
			}
			resp.Body.Close()
		})
	}
}

func TestRateLimiting(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "dilla-ratelimit-*")
	if err != nil {
		t.Fatal("create temp dir:", err)
	}
	defer os.RemoveAll(tmpDir)

	database, err := db.Open(tmpDir, "")
	if err != nil {
		t.Fatal("open db:", err)
	}
	defer database.Close()

	if err := database.RunMigrations(); err != nil {
		t.Fatal("run migrations:", err)
	}

	authSvc := auth.NewAuthService(database)
	hub := ws.NewHub(database)
	go hub.Run()

	// Create router with very low rate limit: 2 req/s, burst 3.
	handler := api.NewRouterWithConfig(database, authSvc, hub, api.RouterConfig{
		RateLimit: 2,
		RateBurst: 3,
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	got429 := false
	for i := 0; i < 20; i++ {
		resp, err := http.Get(server.URL + "/api/v1/health")
		if err != nil {
			t.Fatal("request failed:", err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			got429 = true
			break
		}
	}

	if !got429 {
		t.Fatal("expected 429 Too Many Requests after rapid requests")
	}
}
