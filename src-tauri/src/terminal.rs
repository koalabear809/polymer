//! Terminal sessions: a pty (portable-pty) driving a terminal emulator (alacritty_terminal).
//!
//! Sessions live here, not in the webview, so reloading the frontend re-attaches to running
//! shells. Each session has a reader thread (pty output -> emulator) and a render thread
//! that sends changed screen rows to the frontend over a Tauri channel, at most ~60 times
//! a second.

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const SCROLLBACK: usize = 10_000;

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

/// Receives emulator events: replies to the program (device status etc.), title, bell.
#[derive(Clone)]
struct Proxy {
    writer: Writer,
    title: Arc<Mutex<Option<String>>>,
    bell: Arc<AtomicBool>,
}

impl EventListener for Proxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => {
                if let Ok(mut w) = self.writer.lock() {
                    let _ = w.write_all(text.as_bytes());
                    let _ = w.flush();
                }
            }
            Event::Title(t) => *self.title.lock().unwrap() = Some(t),
            Event::ResetTitle => *self.title.lock().unwrap() = Some(String::new()),
            Event::Bell => self.bell.store(true, Ordering::Relaxed),
            _ => {}
        }
    }
}

#[derive(Serialize, Clone, Hash, PartialEq)]
pub struct Run {
    s: usize,
    e: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bg: Option<String>,
    /// 1 bold, 2 italic, 4 underline, 8 dim, 16 strikethrough
    f: u8,
}

#[derive(Serialize, Clone)]
pub struct Row {
    i: usize,
    text: String,
    runs: Vec<Run>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    #[serde(rename_all = "camelCase")]
    Frame {
        rows: usize,
        cols: usize,
        lines: Vec<Row>,
        cursor_row: Option<usize>,
        cursor_col: usize,
        cursor_visible: bool,
        app_cursor: bool,
        bracketed_paste: bool,
        alt_screen: bool,
        display_offset: usize,
        history: usize,
        title: Option<String>,
        bell: bool,
    },
    Exit {
        code: Option<u32>,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    id: u32,
    command: String,
    cwd: Option<String>,
    title: Option<String>,
    exited: bool,
    exit_code: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    lines: Vec<Row>,
    /// Index into `lines` of the screen's first row.
    screen_start: usize,
    cursor_line: usize,
    cursor_col: usize,
}

struct Session {
    term: Mutex<Term<Proxy>>,
    writer: Writer,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    channel: Mutex<Option<Channel<TermEvent>>>,
    dirty: AtomicBool,
    full: AtomicBool,
    alive: AtomicBool,
    last_rows: Mutex<Vec<u64>>,
    title: Arc<Mutex<Option<String>>>,
    sent_title: Mutex<Option<String>>,
    bell: Arc<AtomicBool>,
    exit_code: Mutex<Option<u32>>,
    command: String,
    cwd: Option<String>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}

impl Terminals {
    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| format!("No terminal {id}"))
    }
}

// ---------------------------------------------------------------------------
// Rendering rows

fn hex(c: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)
}

/// A color as the frontend expects it: None (default), "0".."255" (palette), "#rrggbb",
/// or "fg"/"bg" for the default colors used in the other position (reverse video).
fn color_token(c: Color, colors: &Colors, is_fg: bool) -> Option<String> {
    let palette = |i: usize| colors[i].map(hex).or_else(|| Some(i.to_string()));
    match c {
        Color::Spec(rgb) => Some(hex(rgb)),
        Color::Indexed(i) => palette(i as usize),
        Color::Named(n) => {
            let idx = n as usize;
            if idx < 16 {
                return palette(idx);
            }
            match n {
                NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::DimForeground => {
                    if is_fg { None } else { Some("fg".into()) }
                }
                NamedColor::Background => {
                    if is_fg { Some("bg".into()) } else { None }
                }
                NamedColor::Cursor => None,
                _ => {
                    // Dim colors map onto the normal palette.
                    let dim = idx.wrapping_sub(NamedColor::DimBlack as usize);
                    if dim < 8 { palette(dim) } else { None }
                }
            }
        }
    }
}

struct RenderedRow {
    text: String,
    runs: Vec<Run>,
    /// UTF-16 offset of each column (len = cols + 1).
    col_index: Vec<usize>,
}

fn render_row(row: &alacritty_terminal::grid::Row<Cell>, cols: usize, colors: &Colors) -> RenderedRow {
    let mut text = String::new();
    let mut len16 = 0usize;
    let mut runs: Vec<Run> = Vec::new();
    let mut col_index = Vec::with_capacity(cols + 1);
    let mut content_end = 0usize; // UTF-16 end of the last non-blank or styled cell
    for c in 0..cols {
        col_index.push(len16);
        let cell = &row[Column(c)];
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let start = len16;
        let ch = if cell.flags.contains(Flags::HIDDEN) { ' ' } else { cell.c };
        text.push(ch);
        len16 += ch.len_utf16();
        if let Some(zw) = cell.zerowidth() {
            for z in zw {
                text.push(*z);
                len16 += z.len_utf16();
            }
        }
        let (mut fg, mut bg) = (color_token(cell.fg, colors, true), color_token(cell.bg, colors, false));
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg);
            fg = fg.or_else(|| Some("bg".into()));
            bg = bg.or_else(|| Some("fg".into()));
        }
        let mut f = 0u8;
        if cell.flags.contains(Flags::BOLD) { f |= 1; }
        if cell.flags.contains(Flags::ITALIC) { f |= 2; }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { f |= 4; }
        if cell.flags.contains(Flags::DIM) { f |= 8; }
        if cell.flags.contains(Flags::STRIKEOUT) { f |= 16; }
        if ch != ' ' || bg.is_some() || f & (4 | 16) != 0 {
            content_end = len16;
        }
        if fg.is_none() && bg.is_none() && f == 0 {
            continue;
        }
        match runs.last_mut() {
            Some(r) if r.e == start && r.fg == fg && r.bg == bg && r.f == f => r.e = len16,
            _ => runs.push(Run { s: start, e: len16, fg, bg, f }),
        }
    }
    col_index.push(len16);
    // Drop trailing blank cells so lines don't carry padding.
    let mut cut = 0;
    let mut idx = 0;
    for ch in text.chars() {
        if idx >= content_end {
            break;
        }
        idx += ch.len_utf16();
        cut += ch.len_utf8();
    }
    text.truncate(cut);
    runs.retain(|r| r.s < content_end);
    for r in runs.iter_mut() {
        r.e = r.e.min(content_end);
    }
    RenderedRow { text, runs, col_index }
}

fn row_hash(text: &str, runs: &[Run]) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    runs.hash(&mut h);
    h.finish()
}

fn build_frame(s: &Session) -> TermEvent {
    let full = s.full.swap(false, Ordering::Relaxed);
    let term = s.term.lock().unwrap();
    let grid = term.grid();
    let rows = grid.screen_lines();
    let cols = grid.columns();
    let offset = grid.display_offset();
    let colors = term.colors();
    let mode = *term.mode();
    let cursor = grid.cursor.point;
    let cursor_row_signed = cursor.line.0 + offset as i32;
    let cursor_row = if cursor_row_signed >= 0 && (cursor_row_signed as usize) < rows { Some(cursor_row_signed as usize) } else { None };

    let mut last = s.last_rows.lock().unwrap();
    if full || last.len() != rows {
        last.clear();
        last.resize(rows, u64::MAX);
    }
    let mut lines = Vec::new();
    let mut cursor_col = 0;
    for r in 0..rows {
        let rendered = render_row(&grid[Line(r as i32 - offset as i32)], cols, colors);
        if Some(r) == cursor_row {
            cursor_col = rendered.col_index[cursor.column.0.min(cols)];
        }
        let h = row_hash(&rendered.text, &rendered.runs);
        if last[r] != h {
            last[r] = h;
            lines.push(Row { i: r, text: rendered.text, runs: rendered.runs });
        }
    }
    let title = s.title.lock().unwrap().clone();
    let mut sent = s.sent_title.lock().unwrap();
    let title_changed = *sent != title;
    if title_changed {
        *sent = title.clone();
    }
    TermEvent::Frame {
        rows,
        cols,
        lines,
        cursor_row,
        cursor_col,
        cursor_visible: mode.contains(TermMode::SHOW_CURSOR),
        app_cursor: mode.contains(TermMode::APP_CURSOR),
        bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
        alt_screen: mode.contains(TermMode::ALT_SCREEN),
        display_offset: offset,
        history: grid.total_lines().saturating_sub(rows),
        title: if title_changed || full { title } else { None },
        bell: s.bell.swap(false, Ordering::Relaxed),
    }
}

fn send(s: &Session, event: TermEvent) {
    let mut ch = s.channel.lock().unwrap();
    if let Some(c) = ch.as_ref() {
        if c.send(event).is_err() {
            *ch = None; // the frontend went away (reload); re-attach will resend everything
        }
    }
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    rows: u16,
    cols: u16,
}

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        (std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into()), vec![])
    } else {
        // A login shell, so a GUI-launched app still gets the user's PATH and profile.
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), vec!["-l".into()])
    }
}

#[tauri::command]
pub fn term_spawn(state: State<'_, Terminals>, options: SpawnOptions, channel: Channel<TermEvent>) -> Result<u32, String> {
    let rows = options.rows.max(1);
    let cols = options.cols.max(1);
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (program, default_args) = default_shell();
    let program = options.command.clone().unwrap_or(program);
    let args = options.args.clone().unwrap_or(if options.command.is_some() { vec![] } else { default_args });
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Polymer");
    // BSD/macOS ls and other tools only color their output when this is set.
    cmd.env("CLICOLOR", "1");
    for (k, v) in options.env.unwrap_or_default() {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let title = Arc::new(Mutex::new(None));
    let bell = Arc::new(AtomicBool::new(false));
    let proxy = Proxy { writer: writer.clone(), title: title.clone(), bell: bell.clone() };
    let config = Config { scrolling_history: SCROLLBACK, ..Config::default() };
    let term = Term::new(config, &Size { cols: cols as usize, rows: rows as usize }, proxy);

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let session = Arc::new(Session {
        term: Mutex::new(term),
        writer,
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        channel: Mutex::new(Some(channel)),
        dirty: AtomicBool::new(true),
        full: AtomicBool::new(true),
        alive: AtomicBool::new(true),
        last_rows: Mutex::new(Vec::new()),
        title,
        sent_title: Mutex::new(None),
        bell,
        exit_code: Mutex::new(None),
        command: std::iter::once(program).chain(args).collect::<Vec<_>>().join(" "),
        cwd: options.cwd,
    });
    state.sessions.lock().unwrap().insert(id, session.clone());

    // Reader: pty output -> emulator.
    let s = session.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut processor: Processor = Processor::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    processor.advance(&mut *s.term.lock().unwrap(), &buf[..n]);
                    s.dirty.store(true, Ordering::Relaxed);
                }
            }
        }
        let code = s.child.lock().unwrap().wait().ok().map(|st| st.exit_code());
        *s.exit_code.lock().unwrap() = code;
        s.alive.store(false, Ordering::Relaxed);
    });

    // Renderer: changed rows -> frontend.
    let s = session;
    thread::spawn(move || loop {
        thread::sleep(FRAME_INTERVAL);
        let alive = s.alive.load(Ordering::Relaxed);
        if s.dirty.swap(false, Ordering::Relaxed) || s.full.load(Ordering::Relaxed) {
            let frame = build_frame(&s);
            send(&s, frame);
        }
        if !alive {
            let code = *s.exit_code.lock().unwrap();
            send(&s, TermEvent::Exit { code });
            break;
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let s = state.get(id)?;
    let mut w = s.writer.lock().unwrap();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<'_, Terminals>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let s = state.get(id)?;
    let (rows, cols) = (rows.max(1), cols.max(1));
    s.master
        .lock()
        .unwrap()
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    s.term.lock().unwrap().resize(Size { cols: cols as usize, rows: rows as usize });
    s.full.store(true, Ordering::Relaxed);
    s.dirty.store(true, Ordering::Relaxed);
    Ok(())
}

/// Scroll the view into history: positive `delta` goes back, 0 returns to the bottom.
#[tauri::command]
pub fn term_scroll(state: State<'_, Terminals>, id: u32, delta: i32) -> Result<(), String> {
    let s = state.get(id)?;
    let scroll = if delta == 0 { Scroll::Bottom } else { Scroll::Delta(delta) };
    s.term.lock().unwrap().scroll_display(scroll);
    s.dirty.store(true, Ordering::Relaxed);
    Ok(())
}

/// The whole scrollback plus screen, for copy mode.
#[tauri::command]
pub fn term_snapshot(state: State<'_, Terminals>, id: u32) -> Result<Snapshot, String> {
    let s = state.get(id)?;
    let term = s.term.lock().unwrap();
    let grid = term.grid();
    let rows = grid.screen_lines();
    let cols = grid.columns();
    let history = grid.total_lines().saturating_sub(rows);
    let colors = term.colors();
    let mut lines = Vec::with_capacity(history + rows);
    let cursor = grid.cursor.point;
    let mut cursor_col = 0;
    for (i, line) in (-(history as i32)..rows as i32).enumerate() {
        let r = render_row(&grid[Line(line)], cols, colors);
        if line == cursor.line.0 {
            cursor_col = r.col_index[cursor.column.0.min(cols)];
        }
        lines.push(Row { i, text: r.text, runs: r.runs });
    }
    Ok(Snapshot {
        lines,
        screen_start: history,
        cursor_line: history + cursor.line.0.max(0) as usize,
        cursor_col,
    })
}

#[tauri::command]
pub fn term_kill(state: State<'_, Terminals>, id: u32) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.lock().unwrap().kill();
        *s.channel.lock().unwrap() = None;
    }
    Ok(())
}

/// Running (and exited but not yet killed) sessions, for re-attaching after a reload.
#[tauri::command]
pub fn term_list(state: State<'_, Terminals>) -> Vec<SessionInfo> {
    let mut out: Vec<SessionInfo> = state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| SessionInfo {
            id: *id,
            command: s.command.clone(),
            cwd: s.cwd.clone(),
            title: s.title.lock().unwrap().clone(),
            exited: !s.alive.load(Ordering::Relaxed),
            exit_code: *s.exit_code.lock().unwrap(),
        })
        .collect();
    out.sort_by_key(|i| i.id);
    out
}

/// Send this session's frames to a new channel (after a frontend reload).
#[tauri::command]
pub fn term_attach(state: State<'_, Terminals>, id: u32, channel: Channel<TermEvent>) -> Result<(), String> {
    let s = state.get(id)?;
    *s.channel.lock().unwrap() = Some(channel);
    s.full.store(true, Ordering::Relaxed);
    s.dirty.store(true, Ordering::Relaxed);
    if !s.alive.load(Ordering::Relaxed) {
        let frame = build_frame(&s);
        send(&s, frame);
        let code = *s.exit_code.lock().unwrap();
        send(&s, TermEvent::Exit { code });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoEvents;
    impl EventListener for NoEvents {}

    fn term_with(bytes: &[u8], cols: usize, rows: usize) -> Term<NoEvents> {
        let mut term = Term::new(Config::default(), &Size { cols, rows }, NoEvents);
        let mut p: Processor = Processor::new();
        p.advance(&mut term, bytes);
        term
    }

    fn row(term: &Term<NoEvents>, line: i32) -> RenderedRow {
        render_row(&term.grid()[Line(line)], term.grid().columns(), term.colors())
    }

    #[test]
    fn colors_runs_and_trimming() {
        let t = term_with(b"\x1b[31mred\x1b[0m plain   \x1b[1;38;5;208mX\x1b[0m   ", 40, 3);
        let r = row(&t, 0);
        assert_eq!(r.text, "red plain   X");
        assert_eq!(r.runs.len(), 2);
        assert_eq!((r.runs[0].s, r.runs[0].e, r.runs[0].fg.as_deref()), (0, 3, Some("1")));
        assert_eq!((r.runs[1].s, r.runs[1].fg.as_deref(), r.runs[1].f), (12, Some("208"), 1));
    }

    #[test]
    fn truecolor_and_inverse() {
        let t = term_with(b"\x1b[38;2;255;0;128mA\x1b[0m\x1b[7mB\x1b[0m", 10, 1);
        let r = row(&t, 0);
        assert_eq!(r.runs[0].fg.as_deref(), Some("#ff0080"));
        assert_eq!((r.runs[1].fg.as_deref(), r.runs[1].bg.as_deref()), (Some("bg"), Some("fg")));
    }

    #[test]
    fn wide_chars_map_columns_to_utf16() {
        let t = term_with("日本x".as_bytes(), 10, 1);
        let r = row(&t, 0);
        assert_eq!(r.text, "日本x");
        // columns 0,1 -> 日 ; 2,3 -> 本 ; 4 -> x
        assert_eq!(&r.col_index[..6], &[0, 1, 1, 2, 2, 3]);
        assert_eq!(t.grid().cursor.point.column.0, 5);
    }

    #[test]
    fn scrollback_keeps_history() {
        let mut out = Vec::new();
        for i in 0..10 {
            out.extend_from_slice(format!("line{i}\r\n").as_bytes());
        }
        let t = term_with(&out, 20, 3);
        let history = t.grid().total_lines() - t.grid().screen_lines();
        assert_eq!(history, 8);
        assert_eq!(row(&t, -(history as i32)).text, "line0");
        assert_eq!(row(&t, 0).text, "line8");
    }

    #[test]
    fn pty_runs_a_command() {
        let pair = native_pty_system().openpty(PtySize { rows: 5, cols: 40, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" });
        if cfg!(windows) { cmd.args(["/C", "echo polymer-ok"]); } else { cmd.args(["-c", "printf polymer-ok"]); }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
            if out.contains("polymer-ok") { break; }
        }
        let _ = child.wait();
        assert!(out.contains("polymer-ok"), "got {out:?}");
    }
}

#[cfg(test)]
mod frame_json_tests {
    use super::*;

    #[test]
    fn frame_serializes_in_the_shape_the_frontend_reads() {
        let ev = TermEvent::Frame {
            rows: 1, cols: 10,
            lines: vec![Row { i: 0, text: "red".into(), runs: vec![Run { s: 0, e: 3, fg: Some("1".into()), bg: None, f: 1 }] }],
            cursor_row: Some(0), cursor_col: 3, cursor_visible: true, app_cursor: false,
            bracketed_paste: false, alt_screen: false, display_offset: 0, history: 0, title: None, bell: false,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"frame""#), "{json}");
        assert!(json.contains(r#""runs":[{"s":0,"e":3,"fg":"1","f":1}]"#), "{json}");
        assert!(json.contains(r#""cursorRow":0"#), "{json}");
    }
}
