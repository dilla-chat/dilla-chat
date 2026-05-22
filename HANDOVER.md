# Dilla — Repo Handover (live document)

This is the **live source of truth** for everything outstanding
across the whole repo. When an item is finished, delete its block
**in the same commit that closes the item**. The commit message
should reference the item id (H-N). When this file is empty, no
in-flight work remains.

**How to use this:**
- **Tractable** — items an in-session contributor can knock out
  one-by-one. Each has a concrete "definition of done".
- **Integration tier** — release-coordinated work that touches the
  federation wire protocol or other multi-node concerns. Do NOT
  auto-apply these — they need explicit operator coordination and
  rolling-upgrade planning.
- **Product / UX follow-ups** — non-security work known to be
  in-flight or stubbed.
- **Architectural deferrals** — known limitations that are
  documented (in `SECURITY.md` §9 etc.) and tracked here for
  future revisits.

**Branch posture going into this handover:**
- On `feat/mesh-redesign`, 500+ commits ahead of `main`.
- Server builds clean (`cargo build --release`).
- Dev pattern `DILLA_INSECURE=true …` works.
- Client builds clean (`npm run build`).
- `npm audit` reports 0 vulnerabilities.
- `cargo test --release`: **803 passed, 0 failed** (H-4 closed).

---

## Tractable (in-session-friendly)

(none — H-4 closed)

---

## Integration tier (release-coordinated, NOT for autonomous patching)



---

## Product / UX follow-ups

### H-14b — Device-enrollment flow (remainder of H-14)

The device list + revoke UI shipped in Settings → Devices. The
"enroll a new device" flow is still open:

- QR code or short-string transfer of an enrollment payload from
  the new device to an authorizing device.
- The authorizing device signs the enroll-complete request
  (server endpoint `POST /api/v1/devices/enroll-complete`
  already exists).
- Recovery path when the user has only one device and wants to
  enroll a second — likely a recovery code / passphrase mechanism
  separate from the multi-device key trust model.

Real product UX work; should be planned alongside the
account-recovery story.

---

## Architectural deferrals (documented; not for in-session work)


---

## Closed in earlier sessions (for the record)

Summarized — full details in `.security-hardening/`:

- Phase 1 assessment (24 numbered findings + threat model +
  architecture review).
- Phase 2 remediation: critical fixes (commits `c9adcd8`..`244e15d`),
  backend hardening (`8a52367`..`587ae67`), frontend hardening
  (`5dbc856`..`bb03b16`).
- Phase 3 controls: auth enhancement (`0d55d30`..`b7eb3cd`),
  infrastructure docs (`004dbad`), secrets management
  (`eea6661`, `6644a6b`).
- Phase 4 validation + compliance + SIEM playbook (`004dbad`..`c286dca`).
- Federation Phase 3 foundation: design doc (`55063cc`), identity
  + migrations (`d3ac12a`), peers (`f7e55df`), wire (`76885cd`),
  authority (`8225e43`), admin API (`7410d31`), team-owner hook
  (`677f403`).
- 8 net-new findings from validation closed: VULN-015 doc
  (`3be0633`), bootstrap expiry fail-closed (`372b5f6`),
  federation empty-secret rejection (`5dbf455`), WS team-param
  membership (`3f46be4`), unlinked-attachment cross-team
  (`0552035`), TOCTOU revoke (`aa7bc50`), DNS-rebind SSRF
  (`4470fe8`).
- A6 policy-migration tail across 11 REST handlers (`3b7828c`).
- SECURITY.md §9 federation known-limitations (`33b83ab`).
