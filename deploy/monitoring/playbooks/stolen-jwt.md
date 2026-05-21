# Playbook — stolen JWT / session theft

Triggered by:
- User report ("someone is logged in as me")
- `DeviceEnrollmentBurst` (rule 3)
- `DeviceRiskScoreCritical` (rule 4)
- `OneTimePrekeyDrain` (rule 6) against the user
- Analyst hunt query 1, 2, or 7 from `behavioral.md`

A stolen JWT is the worst-case auth incident on Dilla. Move fast and
loud — the user's data confidentiality is on the line.

## 1. Triage in one query

```logql
{job="dilla-audit", user_id="<uid>"}
  | json | __error__ = ""
  | line_format "{{.created_at}}  action={{.action}}  device={{.device_id}}  ip={{.details.ip}}"
```

Look for:
- `auth.login` from an unexpected IP/country.
- `auth.token_refresh` rate > 1/h (way above the sliding-refresh design).
- `device.enrolled` you didn't expect.

## 2. Revoke the suspect device(s)

Per `08-auth-enhancement.md §3`, each JWT carries a `did` (device ID)
claim. Revoking the device invalidates **just** that device's JWTs
without nuking the user's other sessions.

```sh
# From an admin context (PERM_MANAGE_USERS), or by the user themselves
# from a trusted device:
curl -X POST -H "Authorization: Bearer <jwt>" \
  https://<dilla>/api/v1/devices/<suspect_did>/revoke
```

The revocation:
1. Sets `user_devices.revoked_at`.
2. Bumps `tokens_invalidated_after` for that device (the existing JWT
   becomes 401 on next request — see H2 `validate_jwt_full`).
3. Audit-logs `device.revoked`.

## 3. Logout the user entirely (nuclear option)

If the attacker may also have the user's *primary* device key, revoking
one device isn't enough — the attacker can re-enroll a new one. You need
to force the user through a full re-auth dance.

**Today** (until `POST /api/v1/auth/logout-all` ships — see follow-up
FU-2 in `.security-hardening/13-monitoring-siem.md`): loop the device-
revoke endpoint over every active device for the user:

```sh
DID_LIST=$(sqlite3 /var/lib/dilla/dilla.db \
  "SELECT id FROM user_devices WHERE user_id='<uid>' AND revoked_at IS NULL;")
for did in $DID_LIST; do
  curl -X POST -H "Authorization: Bearer <admin-jwt>" \
    "https://<dilla>/api/v1/devices/$did/revoke"
done
```

Then bump the user-wide `tokens_invalidated_after`:

```sql
UPDATE user_devices
SET tokens_invalidated_after = datetime('now')
WHERE user_id = '<uid>';
```

(The force-logout-on-permission-change path already exists per A4. The
above is the user-initiated equivalent until the API endpoint lands.)

## 4. Contact the user via a different channel

The user's Dilla account is the channel under suspicion. Reach them via
the operator-out-of-band path (the email or matrix-id they registered
in the team-owner-notes column, or in person). Confirm:

- They expected the new device? (Maybe a real new phone.)
- They expected the foreign IP? (Maybe travel / VPN.)
- They want to do a full key-rotation? (Replaces all Ed25519 identity.)

## 5. If confirmed stolen — full identity rotation

The user must:
1. From a trusted device, generate a brand-new Ed25519 keypair (the
   client wizard handles this).
2. Re-enroll into every team they're a member of (see `SECURITY.md §4`).
3. Notify their conversation partners out-of-band that the new key is
   the canonical one (Signal-Protocol style safety-number compare).
   See F9 in `06-frontend-hardening.md`.

## 6. Audit-log

The `device.revoked` audit events from steps 2-3 are the canonical trail.
Add an operator note for context:

```sql
INSERT INTO audit_events (id, team_id, actor_user_id, action,
  target_type, target_id, details, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<team>', 'operator', 'incident.stolen_jwt_response',
  'user', '<uid>',
  json_object('triggered_by', '<rule_or_user_report>'),
  datetime('now')
);
```

## 7. Post-mortem

- How was the JWT extracted? (Browser malware? Stolen device backup?
  XSS — even though F1/F7 should block it?)
- Did we detect within 1h, 6h, or 24h?
- Should we tighten the device-risk thresholds?

## 8. References

- `.security-hardening/08-auth-enhancement.md §3` — multi-device + risk scoring.
- `.security-hardening/05-backend-hardening.md H2` — JWT revocation + 24h refresh.
- `.security-hardening/06-frontend-hardening.md F9` — safety-number compare.
