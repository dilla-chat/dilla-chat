# Dilla — Mobile Security Hardening (Step 7)

**Status:** SKIPPED — Dilla has no native mobile target.

## Rationale

The Dilla product surface consists of:

1. **`server-rs/`** — Rust backend (single-binary axum + tokio-tungstenite + webrtc-rs SFU). Server-side only.
2. **`client/src/`** — React 19 + TypeScript SPA. Runs in two contexts:
   - Browsers visiting the server-embedded webapp (via `rust-embed` at `server-rs/src/webapp/mod.rs`).
   - The Tauri desktop shell (`client/src-tauri/`).
3. **`client/src-tauri/`** — **Tauri v2 desktop shell only.** The `tauri.conf.json` targets `app.targets = ["dmg", "msi", "deb", "appimage"]` — macOS, Windows, Linux. **No `ios`, no `android` target is configured.**

The Tauri v2 framework supports iOS / Android targets in principle, but Dilla has not opted in. There is no mobile-specific code in the repository, no `ios/` or `android/` directory under `client/src-tauri/`, no platform-conditional Rust modules, and no mobile build scripts in `client/package.json`.

## Mobile-style threats that DO apply (and where they were addressed)

Even without a mobile build, several mobile-style hardening concerns apply to the Tauri desktop shell, and these are addressed in step 6 (frontend hardening):

| Mobile concern | Where it lives in Dilla | Where addressed |
|---|---|---|
| Certificate pinning | TLS terminated by `server-rs` (Mode A: reverse proxy; Mode B: `axum-server bind_rustls`) | Step 4 commit `244e15d` (server-side); step 6 CSP `upgrade-insecure-requests` + `wss:` allow-list (F1 commit `5dbc856`) pushes clients toward TLS. Per-peer pinning for federation traffic is deferred to Phase 3 architecture (see `.security-hardening/03-architecture-review.md` §6/§7). |
| Biometric authentication | Replaced by Ed25519 keypair + Tauri-stored identity blob | Already in place; passkey/WebAuthn entrypoint exists at `client/src-tauri/src/main.rs` (loopback HTTP callback on ports 65530–65534). Hardening of that loopback is captured as NEW threat TAU-LOOP-1 in `.security-hardening/02-threat-model.md` and noted as Low-impact follow-up. |
| Secure local storage with encryption | Tauri secure store + at-rest token encryption | Step 6 F4 commit `f3fd854` — JWT/team-tokens encrypted at rest in `sessionStorage` with AES-GCM and a non-extractable WebCrypto wrap key. SQLCipher key zeroize on the server side: step 5 H9 commit `726e85a`. |
| Code obfuscation (ProGuard/R8) | N/A for Tauri desktop — Rust binaries are already release-optimized | Reproducible-build recommendations for the desktop shell are in `.security-hardening/03-architecture-review.md` §10 (R-31 / R-32). |
| Anti-tampering / root-jailbreak detection | N/A for desktop Linux/macOS/Windows by design | Operator-side recommendation: deploy signed/notarized installers. Tracked as Phase 3 hardening item R-33 in the architecture review. |
| Secure IPC | Tauri `tauri::invoke` IPC surface is minimal (`greet`, `denoise_frame`) | Step 6 F8 commit `68193fb` — Tauri navigation guard + tightened CSP + committed `Cargo.lock` (closes TAU-SUPPLY-1). |
| Mobile-specific app-transport-security (ATS / Network Security Config) | N/A | Step 6 F1 CSP enforces `wss:` outside `DILLA_INSECURE`. |

## Recommendations for future mobile target

If Dilla adds an iOS/Android target in the future (Tauri v2 supports both), the following items become applicable and should be re-evaluated:

1. **Certificate pinning** of the federation/API endpoint to defeat MITM via installed CA roots — particularly important on Android where users can install custom CAs.
2. **Biometric unlock** of the local keystore (LAContext on iOS, BiometricPrompt on Android) for the Ed25519 identity key.
3. **Hardware-backed key storage** — Secure Enclave (iOS) / StrongBox (Android) for the Signal Protocol identity key and Double Ratchet root keys. Today these are in WebView IndexedDB (DR-XSS-1 in the threat model).
4. **App-Transport-Security (iOS)** and **Network Security Config (Android)** to enforce TLS at the OS level.
5. **Code obfuscation** via ProGuard/R8 for Android — Tauri-generated Java/Kotlin shim still benefits.
6. **Anti-tampering** — SafetyNet/Play Integrity (Android), DeviceCheck/App Attest (iOS).
7. **Secure IPC** — review every `tauri::invoke` command for mobile-platform-specific permission models.
8. **Push notifications** — when added, ensure ciphertext is delivered through the push payload but message bodies remain end-to-end encrypted (Signal Protocol invariant must hold).
9. **Background message decryption** — careful thought required about where the ratchet state lives when the app is killed by the OS.
10. **App Store / Play Store review** — federation client code may trigger reviewer questions about decentralization; document the trust model in submission materials.

For now: **no work is required in step 7**. Continue to step 8.
