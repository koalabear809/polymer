//! Running external programs (git, ...) and collecting their output.
//!
//! The command is async and the process runs on a blocking worker thread, so slow
//! programs (git push) don't freeze the UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

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
    fn missing_program_is_an_error() {
        assert!(run(ProcessOptions { program: "polymer-no-such-program".into(), args: vec![], cwd: None, stdin: None, env: None }).is_err());
    }
}
