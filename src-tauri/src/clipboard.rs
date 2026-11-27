// The system clipboard (text and images), read and written from the backend.
//
// The webview's navigator.clipboard is unreliable here: WebView2 can refuse reads, and
// reads/writes outside a user gesture fail. Going through the OS clipboard avoids both.

use std::sync::Mutex;

use arboard::{Clipboard, Error, ImageData};
use tauri::State;

/// One clipboard handle for the app's lifetime. On Linux, what we copy is only served
/// while the handle that set it is alive, so it must not be dropped after each write.
#[derive(Default)]
pub struct ClipboardState(Mutex<Option<Clipboard>>);

/// Run f with the clipboard. "Nothing of that kind on the clipboard" comes back as Ok(None).
fn with_clipboard<T>(state: &State<'_, ClipboardState>, f: impl FnOnce(&mut Clipboard) -> Result<T, Error>) -> Result<Option<T>, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|e| e.to_string())?);
    }
    match f(guard.as_mut().unwrap()) {
        Ok(v) => Ok(Some(v)),
        Err(Error::ContentNotAvailable | Error::ConversionFailure) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The clipboard's text, or None if it holds no text.
#[tauri::command]
pub async fn clipboard_read_text(state: State<'_, ClipboardState>) -> Result<Option<String>, String> {
    with_clipboard(&state, |c| c.get_text())
}

#[tauri::command]
pub async fn clipboard_write_text(state: State<'_, ClipboardState>, text: String) -> Result<(), String> {
    with_clipboard(&state, |c| c.set_text(text)).map(|_| ())
}

/// The clipboard's image as PNG bytes (an ArrayBuffer in JS); empty if it holds no image.
#[tauri::command]
pub async fn clipboard_read_image(state: State<'_, ClipboardState>) -> Result<tauri::ipc::Response, String> {
    let bytes = match with_clipboard(&state, |c| c.get_image())? {
        Some(image) => encode_png(&image)?,
        None => Vec::new(),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

fn encode_png(image: &ImageData) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, image.width as u32, image.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&image.bytes).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn encodes_rgba_as_png() {
        let image = ImageData { width: 2, height: 1, bytes: Cow::Owned(vec![255, 0, 0, 255, 0, 0, 255, 128]) };
        let png = encode_png(&image).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
