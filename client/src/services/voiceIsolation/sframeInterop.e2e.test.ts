// Two-client SFrame interop E2E stub (Milestone 5.1).
//
// Goal: confirm that the dispatcher's noise-suppression hook fires at
// exactly the right point in the WebRTC pipeline so the SFrame metadata
// (epoch, key id, generation, frame counter) survives a round trip:
//
//   getUserMedia → DFN3 → SFrame.encrypt → SFU → SFrame.decrypt → DFN3 → output
//
// The receiving client must be able to decrypt the frame *after* it has
// passed through DFN3 on both sides. If our dispatcher accidentally re-
// encodes or re-times frames, SFrame's authenticated counter check will
// fail and the receiver will discard the audio.
//
// Why this is a stub
// ------------------
// Spinning up a full two-client voice-channel E2E from scratch needs:
//   - The Rust server running with TLS (`server-rs && cargo run`)
//   - Two browser contexts, both authenticated as different identities
//   - A shared kanal with a voice channel
//   - Manipulation of `getUserMedia` to inject deterministic test audio
//   - A receiver-side hook to extract and decode the recovered audio
//   - SFrame metadata inspection on the wire (`webrtc-internals`-level)
//
// None of that infrastructure exists in this repo at the time of Phase 1
// noise-suppression landing — there are no Playwright tests of any kind
// (`grep -r playwright` returns only the vitest browser-mode adapter).
//
// What "passing" should look like once the infra exists
// -----------------------------------------------------
//   1. Sender plays a known sine-wave + speech mix into a fake mic.
//   2. Receiver records its decoded audio for ~3 seconds.
//   3. Cross-correlate received audio against the (DFN3-cleaned) reference
//      generated offline. Pearson r >= 0.9 → audio path intact.
//   4. Read `RTCRtpSender.getStats()` and verify the SFrame `keyId` /
//      `generation` advance monotonically (no re-keying glitch).
//   5. Verify `RTCInboundRtpStreamStats.framesDecoded` advances
//      smoothly (no drops > 5%).
//
// To extend, the recommended path is:
//   - Add `@playwright/test` as a devDependency (vitest browser mode is
//     not enough — we need two independent browser contexts).
//   - Create `client/test/e2e/voice-noise-suppression.spec.ts` with a
//     `playwright.config.ts` that boots `cargo run` + Vite as a server
//     fixture.
//   - Stub `getUserMedia` via `--use-fake-device-for-media-stream` and
//     `--use-file-for-fake-audio-capture=<path/to/noisy_input.wav>`.
//
// Until then, this file exists so:
//   (a) future contributors can grep `sframeInterop` and find the contract
//   (b) `vitest run` reports the test as `skipped` (visible TODO marker)
//   (c) the unit-level dispatcher tests in `dispatcher.test.ts` plus the
//       browser-mode `pipeline.browser.test.ts` still cover the bulk of
//       the integration surface.

import { describe, it } from 'vitest';

describe('SFrame interop with noise suppression (two-client E2E)', () => {
  it.skip(
    'preserves SFrame metadata across DFN3 → SFrame → DFN3 round trip',
    () => {
      // Intentional stub. See file header for the infrastructure work
      // required to enable this test.
    },
  );
});
