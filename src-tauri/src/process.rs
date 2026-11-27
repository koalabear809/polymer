//! Running external programs (git, ...) and collecting their output.
//!
//! The command is async and the process runs on a blocking worker thread, so slow
//! programs (git push) don't freeze the UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOptions {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    stdin: Option<String>,
    env: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    /// Exit code, or null if the process was killed by a signal.
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(options: ProcessOptions) -> Result<ProcessOutput, String> {
    let mut cmd = Command::new(&options.program);
    cmd.args(&options.args)
        .stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in options.env.unwrap_or_default() {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{}: {}", options.program, e))?;
    if let Some(input) = options.stdin {
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        // Write from another thread so a full stdout pipe can't deadlock us.
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(ProcessOutput {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn run_process(options: ProcessOptions) -> Result<ProcessOutput, String> {
    tauri::async_runtime::spawn_blocking(move || run(options)).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Long-running processes with streamed stdio (agents speaking JSON-RPC, ...)

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnProcessOptions {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    /// Variables to remove from the environment the process inherits from Polymer.
    env_remove: Option<Vec<String>>,
    /// Free-form label, e.g. "acp", so the frontend can find its processes after a reload.
    tag: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProcessEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: Option<i32> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    id: u32,
    program: String,
    tag: Option<String>,
}

struct Proc {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    program: String,
    tag: Option<String>,
}

#[derive(Default)]
pub struct Processes {
    procs: Mutex<HashMap<u32, Arc<Proc>>>,
    next_id: AtomicU32,
}

fn command_for(program: &str, options: &SpawnProcessOptions) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(&options.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    for k in options.env_remove.clone().unwrap_or_default() {
        cmd.env_remove(k);
    }
    for (k, v) in options.env.clone().unwrap_or_default() {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Stream a pipe to the channel, splitting only at UTF-8 boundaries.
fn pump<R: Read + Send + 'static>(mut reader: R, channel: Channel<ProcessEvent>, stderr: bool) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid == 0 {
                continue;
            }
            let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            let ev = if stderr { ProcessEvent::Stderr { data } } else { ProcessEvent::Stdout { data } };
            if channel.send(ev).is_err() {
                break;
            }
        }
    });
}

#[tauri::command]
pub fn proc_spawn(state: State<'_, Processes>, options: SpawnProcessOptions, channel: Channel<ProcessEvent>) -> Result<u32, String> {
    let mut child = match command_for(&options.program, &options).spawn() {
        Ok(c) => c,
        // On Windows, npx/npm and friends are .cmd scripts.
        Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::NotFound && !options.program.contains('.') => {
            command_for(&format!("{}.cmd", options.program), &options).spawn().map_err(|e| format!("{}: {}", options.program, e))?
        }
        Err(e) => return Err(format!("{}: {}", options.program, e)),
    };
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let proc = Arc::new(Proc { stdin: Mutex::new(stdin), child: Mutex::new(child), program: options.program.clone(), tag: options.tag.clone() });
    state.procs.lock().unwrap().insert(id, proc.clone());
    pump(stdout, channel.clone(), false);
    pump(stderr, channel.clone(), true);
    // Wait for exit without holding the child lock forever: poll.
    std::thread::spawn(move || {
        let code = loop {
            match proc.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        // Give the readers a moment to flush the last output.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _ = channel.send(ProcessEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn proc_write(state: State<'_, Processes>, id: u32, data: String) -> Result<(), String> {
    let proc = state.procs.lock().unwrap().get(&id).cloned().ok_or_else(|| format!("No process {id}"))?;
    let mut stdin = proc.stdin.lock().unwrap();
    let w = stdin.as_mut().ok_or("stdin is closed")?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn proc_kill(state: State<'_, Processes>, id: u32) -> Result<(), String> {
    if let Some(proc) = state.procs.lock().unwrap().remove(&id) {
        proc.stdin.lock().unwrap().take();
        let _ = proc.child.lock().unwrap().kill();
    }
    Ok(())
}

#[tauri::command]
pub fn proc_list(state: State<'_, Processes>) -> Vec<ProcessInfo> {
    state
        .procs
        .lock()
        .unwrap()
        .iter()
        .map(|(id, p)| ProcessInfo { id: *id, program: p.program.clone(), tag: p.tag.clone() })
        .collect()
}

/// On macOS/Linux a GUI-launched app gets a minimal PATH; adopt the login shell's so
/// tools installed with Homebrew, nvm, etc. (git, node, npx) are found.
pub fn adopt_login_shell_path() {
    if cfg!(windows) {
        return;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(shell).args(["-l", "-c", "printf %s \"$PATH\""]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        let _ = tx.send(out);
    });
    if let Ok(Ok(out)) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && path.contains('/') {
            std::env::set_var("PATH", path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_output_stdin_and_exit_code() {
        if cfg!(windows) {
            return;
        }
        let out = run(ProcessOptions {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "cat; echo err >&2; exit 3".into()],
            cwd: None,
            stdin: Some("hello".into()),
            env: None,
        })
        .unwrap();
        assert_eq!((out.code, out.stdout.as_str(), out.stderr.trim()), (Some(3), "hello", "err"));
    }

    #[test]
    fn spawn_options_remove_inherited_variables_but_explicit_ones_win() {
        let options = SpawnProcessOptions {
            program: "x".into(),
            args: vec![],
            cwd: None,
            env: Some(HashMap::from([("KEEP".to_string(), "1".to_string()), ("DROP_THEN_SET".to_string(), "2".to_string())])),
            env_remove: Some(vec!["CLAUDECODE".into(), "DROP_THEN_SET".into()]),
            tag: None,
        };
        let cmd = command_for("x", &options);
        let envs: HashMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string()))).collect();
        assert_eq!(envs.get("CLAUDECODE"), Some(&None), "removed from the inherited environment");
        assert_eq!(envs.get("KEEP"), Some(&Some("1".to_string())));
        assert_eq!(envs.get("DROP_THEN_SET"), Some(&Some("2".to_string())), "an explicit value wins over removal");
    }

    #[test]
    fn missing_program_is_an_error() {
        assert!(run(ProcessOptions { program: "polymer-no-such-program".into(), args: vec![], cwd: None, stdin: None, env: None }).is_err());
    }
}
