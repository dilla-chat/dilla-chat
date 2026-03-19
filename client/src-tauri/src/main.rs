#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth_server;

use std::sync::Mutex;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ─── Voice: RNNoise Noise Suppression ─────────────────────────────────────────

static DENOISE_STATE: Mutex<Option<Box<nnnoiseless::DenoiseState<'static>>>> = Mutex::new(None);

#[tauri::command]
fn denoise_frame(samples: Vec<f32>) -> Vec<f32> {
    if samples.len() != 480 {
        return samples;
    }
    let mut state_guard = DENOISE_STATE.lock().unwrap();
    let state = state_guard.get_or_insert_with(|| Box::new(nnnoiseless::DenoiseState::new()));
    let mut output = vec![0.0f32; 480];
    state.process_frame(&mut output, &samples);
    output
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            denoise_frame,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
