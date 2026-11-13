// Administrator chats (Electron's elevated.js): one elevated copy of the Deck hosts their PTYs and relays them over loopback TCP,
// so Windows asks UAC once, the first time (see launch_elevated). The unelevated Deck listens, and each end proves it holds the secret
// before a PTY starts. Every message after the handshake names its chat's channel in `c`.
// frugal: the secret rides in the helper's arguments; a release build must install the helper where non-admins cannot write.

use base64::Engine;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const FLAG: &str = "--elevated-helper";
// The UAC prompt waits for the user.
const CONNECT: Duration = Duration::from_secs(120);
// A stray local connection must not hold up the real helper for long.
const HANDSHAKE: Duration = Duration::from_secs(10);
const MAX_LINE: usize = 8 * 1024 * 1024;
const NO_WINDOW: u32 = 0x0800_0000;
const TIMEOUT: &str = "The administrator chat did not start in time.";
const NOT_GRANTED: &str = "Windows administrator permission was not granted.";
const NOT_ELEVATED: &str = "Windows did not give the chat administrator rights.";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_hex(len: usize) -> String {
    let mut bytes = vec![0; len];
    getrandom::fill(&mut bytes).expect("no system randomness");
    hex(&bytes)
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner = Sha256::new().chain_update(block.map(|byte| byte ^ 0x36)).chain_update(data).finalize();
    Sha256::new().chain_update(block.map(|byte| byte ^ 0x5c)).chain_update(inner).finalize().into()
}

fn proof(secret: &str, side: &str, nonce: &str) -> String {
    hex(&hmac(secret.as_bytes(), format!("{side}:{nonce}").as_bytes()))
}

// Constant time, so a wrong proof never tells how much of it was right.
fn matches(value: &Value, expected: &str) -> bool {
    value.as_str().is_some_and(|value| value.len() == expected.len() && value.bytes().zip(expected.bytes()).fold(0, |diff, (a, b)| diff | (a ^ b)) == 0)
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn send(mut writer: impl Write, message: &Value) -> bool {
    writer.write_all(format!("{message}\n").as_bytes()).is_ok()
}

// One JSON message per line; None (EOF, error, a longer line or bad JSON) ends the connection.
fn read_message(reader: &mut BufReader<TcpStream>) -> Option<Value> {
    let mut line = Vec::new();
    reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line).ok()?;
    if line.pop() != Some(b'\n') {
        return None;
    }
    serde_json::from_slice(&line).ok()
}

// A character split across two reads waits for its tail.
pub fn utf8_cut(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        _ => bytes.len(),
    }
}

fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32")
}

// JavaScript's toISOString, from Howard Hinnant's civil_from_days.
pub(crate) fn iso(ms: u64) -> String {
    let (days, ms) = (ms / 86_400_000, ms % 86_400_000);
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

// The first elevated helper registers a scheduled task that runs it with highest privileges, so later Deck runs start it
// without UAC; Task Scheduler puts the address and secret into $(Arg0) and $(Arg1).
// frugal: any process of this user can run the task, and the Deck folder is user-writable until the installer (Phase 7).
const TASK_FOLDER: &str = "\\Frugal Deck";
const TASK_NAME: &str = "Administrator helper";
const TASK_ARGUMENTS: &str = "--elevated-helper $(Arg0) $(Arg1)";

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

// Sets $current when the task exists and still starts this exe with these arguments.
fn find_task(exe: &str) -> String {
    format!(
        "try {{ $service = New-Object -ComObject Schedule.Service; $service.Connect(); $task = $service.GetFolder({}).GetTask({}); $action = $task.Definition.Actions.Item(1); $current = $action.Path -eq {} -and $action.Arguments -eq {} }} catch {{ $current = $false; $why = \"$_\" }}",
        quote(TASK_FOLDER), quote(TASK_NAME), quote(exe), quote(TASK_ARGUMENTS)
    )
}

fn powershell(script: &str) -> Command {
    let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut command = Command::new(system32().join("WindowsPowerShell").join("v1.0").join("powershell.exe"));
    command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &base64::engine::general_purpose::STANDARD.encode(encoded)]).creation_flags(NO_WINDOW);
    command
}

// Why a run fell back to UAC goes to this log.
fn log(text: &str) {
    let Some(home) = std::env::var_os("USERPROFILE") else { return };
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
    let file = PathBuf::from(home).join(".frugal-deck").join("elevated.log");
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(file).and_then(|mut file| file.write_all(format!("{} {text}\n", iso(ms)).as_bytes()));
}

// Start-Process fails when the UAC prompt is declined.
fn launch_elevated(addr: &str, secret: &str) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let exe = exe.to_string_lossy();
    let argument_list = format!("\"{FLAG}\" \"{addr}\" \"{secret}\"");
    let script = format!(
        "{}\nif ($current) {{ try {{ $task.Run([string[]]@({}, {})) | Out-Null; exit 0 }} catch {{ \"task run failed: $_\" }} }} elseif ($why) {{ \"task lookup failed: $why\" }} else {{ \"task missing or changed: $($action.Path) $($action.Arguments)\" }}\nStart-Process -FilePath {} -ArgumentList {} -Verb RunAs -WindowStyle Hidden",
        find_task(&exe), quote(addr), quote(secret), quote(&exe), quote(&argument_list)
    );
    let Ok(out) = powershell(&script).output() else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    if !text.trim().is_empty() {
        log(text.trim());
    }
    out.status.success()
}

// Runs in the elevated helper, which may create the task. A failure only means the next Deck run asks UAC again.
fn register_task() {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy();
    let script = format!(
        "{}\nif ($current) {{ exit 0 }}\n$action = New-ScheduledTaskAction -Execute {} -Argument {}\n$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest\n$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel -Priority 4\nRegister-ScheduledTask -TaskPath {} -TaskName {} -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
        find_task(&exe), quote(&exe), quote(TASK_ARGUMENTS), quote(&format!("{TASK_FOLDER}\\")), quote(TASK_NAME)
    );
    // Not waited on: PowerShell outlives a helper that quits first.
    let _ = powershell(&script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

// One chat's end of the shared connection, as the dispatcher sees it.
struct Channel {
    output: mpsc::Sender<Vec<u8>>,
    status: Arc<Status>,
}

#[derive(Default)]
struct Status {
    code: Mutex<Option<u32>>,
    changed: Condvar,
}

impl Status {
    fn set(&self, code: u32) {
        self.code.lock().unwrap().get_or_insert(code);
        self.changed.notify_all();
    }
}

struct Connection {
    writer: Mutex<TcpStream>,
    // None once the helper is gone, so no chat joins a dead connection.
    channels: Mutex<Option<HashMap<String, Channel>>>,
}

// Exit takes the channel out, dropping its sender, so the reader reaches EOF after the last output.
fn dispatch(connection: &Connection, mut reader: BufReader<TcpStream>) {
    while let Some(message) = read_message(&mut reader) {
        let Some(c) = message["c"].as_str() else { break };
        let mut channels = connection.channels.lock().unwrap();
        let Some(channels) = channels.as_mut() else { break };
        match message["t"].as_str() {
            Some("out") => {
                if let (Some(channel), Some(d)) = (channels.get(c), message["d"].as_str()) {
                    let _ = channel.output.send(d.as_bytes().to_vec());
                }
            }
            Some("exit") => {
                if let Some(channel) = channels.remove(c) {
                    channel.status.set(message["code"].as_u64().and_then(|code| u32::try_from(code).ok()).unwrap_or(1));
                }
            }
            _ => {}
        }
    }
    let _ = connection.writer.lock().unwrap().shutdown(Shutdown::Both);
    for (_, channel) in connection.channels.lock().unwrap().take().into_iter().flatten() {
        channel.status.set(1);
    }
}

struct Link {
    connection: Arc<Connection>,
    c: String,
    status: Arc<Status>,
}

impl Link {
    fn send(&self, mut message: Value) {
        if self.status.code.lock().unwrap().is_none() {
            message["c"] = json!(self.c);
            send(&*self.connection.writer.lock().unwrap(), &message);
        }
    }
}

struct RemoteMaster {
    link: Arc<Link>,
    size: Mutex<PtySize>,
    reader: Mutex<Option<RemoteReader>>,
    writer: Mutex<Option<RemoteWriter>>,
}

impl MasterPty for RemoteMaster {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.link.send(json!({ "t": "resize", "cols": size.cols, "rows": size.rows }));
        *self.size.lock().unwrap() = size;
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(*self.size.lock().unwrap())
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
        Ok(Box::new(self.reader.lock().unwrap().take().ok_or_else(|| anyhow::anyhow!("The reader is already taken."))?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
        Ok(Box::new(self.writer.lock().unwrap().take().ok_or_else(|| anyhow::anyhow!("The writer is already taken."))?))
    }
}

struct RemoteReader {
    output: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
}

impl Read for RemoteReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // An empty out message must not read as EOF.
        while self.pending.is_empty() {
            match self.output.recv() {
                Ok(chunk) => self.pending = chunk,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

struct RemoteWriter(Arc<Link>);

impl Write for RemoteWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.send(json!({ "t": "in", "d": String::from_utf8_lossy(buf) }));
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct RemoteChild(Arc<Link>);

impl std::fmt::Debug for RemoteChild {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.debug_tuple("RemoteChild").field(&self.0.c).finish()
    }
}

impl Child for RemoteChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        Ok(self.0.status.code.lock().unwrap().map(ExitStatus::with_exit_code))
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        let status = &self.0.status;
        let code = status.changed.wait_while(status.code.lock().unwrap(), |code| code.is_none()).unwrap();
        Ok(ExitStatus::with_exit_code(code.unwrap_or(1)))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

impl ChildKiller for RemoteChild {
    // The helper kills the PTY, and its exit message comes back on the channel.
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.send(json!({ "t": "kill" }));
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(RemoteChild(self.0.clone()))
    }
}

type Handshake = Result<(TcpStream, BufReader<TcpStream>), String>;

// None: not the helper, so the stream is dropped and the wait goes on.
fn handshake(stream: TcpStream, secret: &str) -> Option<Handshake> {
    stream.set_read_timeout(Some(HANDSHAKE)).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let hello = read_message(&mut reader)?;
    let theirs = hello["nonce"].as_str().filter(|_| hello["t"] == "hello")?;
    let mine = random_hex(16);
    send(&stream, &json!({ "t": "proof", "mac": proof(secret, "deck", theirs), "nonce": mine })).then_some(())?;
    let answer = read_message(&mut reader)?;
    (answer["t"] == "proof" && matches(&answer["mac"], &proof(secret, "helper", &mine))).then_some(())?;
    if answer["elevated"] != true {
        return Some(Err(NOT_ELEVATED.to_owned()));
    }
    stream.set_read_timeout(None).ok()?;
    Some(Ok((stream, reader)))
}

// The first administrator chat starts the helper; later ones reuse it until the connection closes, which ends all of them.
#[derive(Default)]
pub struct Host {
    connection: Mutex<Option<Arc<Connection>>>,
    // None runs launch_elevated; the check swaps in a helper thread.
    launch: Option<fn(&str, &str) -> bool>,
}

impl Host {
    // Blocks until the helper is connected (UAC, up to 120 s). Callers run it off the main thread.
    #[allow(clippy::type_complexity)]
    pub fn spawn(&self, command: &CommandBuilder, size: PtySize) -> Result<(Box<dyn MasterPty + Send>, Box<dyn Read + Send>, Box<dyn Write + Send>, Box<dyn Child + Send + Sync>), String> {
        let c = random_hex(16);
        let status = Arc::new(Status::default());
        let (output, received) = mpsc::channel();
        // Held while connecting, so concurrent spawns share one UAC prompt; a helper that quit is replaced.
        let mut slot = self.connection.lock().unwrap();
        let connection = loop {
            if let Some(connection) = slot.as_ref() {
                if let Some(channels) = connection.channels.lock().unwrap().as_mut() {
                    channels.insert(c.clone(), Channel { output, status: status.clone() });
                    break connection.clone();
                }
            }
            *slot = Some(self.connect()?);
        };
        drop(slot);
        let link = Arc::new(Link { connection, c, status });
        let text = |text: &std::ffi::OsString| text.to_string_lossy().into_owned();
        let argv = command.get_argv();
        let env: serde_json::Map<String, Value> = command.iter_extra_env_as_str().map(|(key, value)| (key.to_owned(), json!(value))).collect();
        link.send(json!({
            "t": "start",
            "file": argv.first().map(text),
            "args": argv.iter().skip(1).map(text).collect::<Vec<_>>(),
            "cols": size.cols,
            "rows": size.rows,
            "cwd": command.get_cwd().map(text),
            "env": env,
        }));
        let master = RemoteMaster {
            link: link.clone(),
            size: Mutex::new(size),
            reader: Mutex::new(Some(RemoteReader { output: received, pending: Vec::new() })),
            writer: Mutex::new(Some(RemoteWriter(link.clone()))),
        };
        let reader = master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = master.take_writer().map_err(|error| error.to_string())?;
        Ok((Box::new(master), reader, writer, Box::new(RemoteChild(link))))
    }

    fn connect(&self) -> Result<Arc<Connection>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let addr = listener.local_addr().map_err(|error| error.to_string())?;
        let secret = random_hex(32);
        let (found, results) = mpsc::channel::<Handshake>();
        let launch = self.launch.unwrap_or(launch_elevated);
        {
            let (found, addr, secret) = (found.clone(), addr.to_string(), secret.clone());
            thread::spawn(move || {
                if !launch(&addr, &secret) {
                    let _ = found.send(Err(NOT_GRANTED.to_owned()));
                }
            });
        }
        let done = Arc::new(AtomicBool::new(false));
        {
            let done = done.clone();
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if done.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let (found, secret) = (found.clone(), secret.clone());
                    thread::spawn(move || {
                        if let Some(result) = handshake(stream, &secret) {
                            let _ = found.send(result);
                        }
                    });
                }
            });
        }
        let result = results.recv_timeout(CONNECT);
        // The accept loop checks done only on a connection, so one is made to close the listener.
        done.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(addr);
        let (writer, reader) = result.unwrap_or_else(|_| Err(TIMEOUT.to_owned()))?;
        let connection = Arc::new(Connection { writer: Mutex::new(writer), channels: Mutex::new(Some(HashMap::new())) });
        let dispatched = connection.clone();
        thread::spawn(move || dispatch(&dispatched, reader));
        Ok(connection)
    }
}

// Runs in the elevated copy instead of the app.
pub fn run_helper(args: &[String]) {
    let at = args.iter().position(|arg| arg == FLAG).unwrap_or(args.len());
    let addr = args.get(at + 1).and_then(|addr| addr.parse::<SocketAddrV4>().ok()).filter(|addr| addr.ip().is_loopback());
    let (Some(addr), Some(secret)) = (addr, args.get(at + 2).filter(|secret| is_hex(secret, 64))) else {
        std::process::exit(1);
    };
    let elevated = Command::new(system32().join("net.exe"))
        .arg("session")
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    serve(addr, secret, elevated);
    std::process::exit(0);
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Terms = Arc<Mutex<HashMap<String, Term>>>;

fn open(message: &Value) -> Option<(Box<dyn MasterPty + Send>, Box<dyn Read + Send>, Box<dyn Write + Send>, Box<dyn Child + Send + Sync>)> {
    let size = PtySize { rows: u16::try_from(message["rows"].as_u64()?).ok()?, cols: u16::try_from(message["cols"].as_u64()?).ok()?, pixel_width: 0, pixel_height: 0 };
    let mut command = CommandBuilder::new(message["file"].as_str()?);
    for arg in message["args"].as_array()? {
        command.arg(arg.as_str()?);
    }
    command.env_clear();
    for (key, value) in message["env"].as_object()? {
        command.env(key, value.as_str()?);
    }
    if let Some(cwd) = message["cwd"].as_str() {
        command.cwd(cwd);
    }
    let pair = native_pty_system().openpty(size).ok()?;
    let reader = pair.master.try_clone_reader().ok()?;
    let writer = pair.master.take_writer().ok()?;
    let child = pair.slave.spawn_command(command).ok()?;
    Some((pair.master, reader, writer, child))
}

fn relay(mut reader: Box<dyn Read + Send>, writer: &Mutex<TcpStream>, c: &str) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending = Vec::new();
    while let Ok(n @ 1..) = reader.read(&mut buf) {
        pending.extend_from_slice(&buf[..n]);
        let cut = utf8_cut(&pending);
        if cut > 0 {
            send(&*writer.lock().unwrap(), &json!({ "t": "out", "c": c, "d": String::from_utf8_lossy(&pending[..cut]) }));
            pending.drain(..cut);
        }
    }
}

fn start(message: &Value, c: &str, terms: &Terms, writer: &Arc<Mutex<TcpStream>>) {
    let Some((master, reader, pty_writer, mut child)) = open(message) else {
        send(&*writer.lock().unwrap(), &json!({ "t": "exit", "c": c, "code": 1 }));
        return;
    };
    terms.lock().unwrap().insert(c.to_owned(), Term { master, writer: pty_writer, killer: child.clone_killer() });
    let (terms, writer, c) = (terms.clone(), writer.clone(), c.to_owned());
    thread::spawn(move || {
        let reading = {
            let (writer, c) = (writer.clone(), c.clone());
            thread::spawn(move || relay(reader, &writer, &c))
        };
        let code = child.wait().map_or(1, |status| status.exit_code());
        // Dropping the master closes the pseudoconsole, so the reader ends once the output drained and exit comes after it.
        let term = terms.lock().unwrap().remove(&c);
        drop(term);
        let _ = reading.join();
        send(&*writer.lock().unwrap(), &json!({ "t": "exit", "c": c, "code": code }));
    });
}

// The helper's side, returning when the connection ends; run_helper exits after it.
fn serve(addr: SocketAddrV4, secret: &str, elevated: bool) {
    let Ok(stream) = TcpStream::connect(addr) else { return };
    let Ok(mut reader) = stream.try_clone().map(BufReader::new) else { return };
    let writer = Arc::new(Mutex::new(stream));
    let mine = random_hex(16);
    if !send(&*writer.lock().unwrap(), &json!({ "t": "hello", "nonce": mine })) {
        return;
    }
    let Some(message) = read_message(&mut reader) else { return };
    let Some(theirs) = message["nonce"].as_str().filter(|_| message["t"] == "proof" && matches(&message["mac"], &proof(secret, "deck", &mine))) else {
        return;
    };
    send(&*writer.lock().unwrap(), &json!({ "t": "proof", "mac": proof(secret, "helper", theirs), "elevated": elevated }));
    // Tests must not create the task.
    if elevated && !cfg!(test) {
        register_task();
    }
    let terms = Terms::default();
    while let Some(message) = read_message(&mut reader) {
        let Some(c) = message["c"].as_str().filter(|c| is_hex(c, 32)) else { break };
        let t = message["t"].as_str().unwrap_or_default();
        if t == "start" && !terms.lock().unwrap().contains_key(c) {
            start(&message, c, &terms, &writer);
            continue;
        }
        let size = (|| Some(PtySize { rows: u16::try_from(message["rows"].as_u64()?).ok()?, cols: u16::try_from(message["cols"].as_u64()?).ok()?, pixel_width: 0, pixel_height: 0 }))();
        let mut live = terms.lock().unwrap();
        // in, resize and kill can race a PTY's exit, so an unknown channel is ignored rather than fatal.
        let term = live.get_mut(c);
        match (t, message["d"].as_str(), size) {
            ("in", Some(d), _) => {
                if let Some(term) = term {
                    let _ = term.writer.write_all(d.as_bytes());
                }
            }
            ("resize", _, Some(size)) => {
                if let Some(term) = term {
                    let _ = term.master.resize(size);
                }
            }
            ("kill", ..) => {
                if let Some(term) = term {
                    let _ = term.killer.kill();
                }
            }
            _ => break,
        }
    }
    for term in terms.lock().unwrap().values_mut() {
        let _ = term.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(hex(&hmac(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn holds_back_a_split_character() {
        assert_eq!(utf8_cut(b"a\xc3"), 1);
        assert_eq!(utf8_cut("aé".as_bytes()), 3);
        assert_eq!(utf8_cut(b"a\xff"), 2, "invalid bytes go out as they are");
        assert_eq!(iso(1_709_164_800_123), "2024-02-29T00:00:00.123Z");
    }

    fn local(addr: &str, secret: &str) -> bool {
        let (addr, secret) = (addr.parse().unwrap(), secret.to_owned());
        thread::spawn(move || serve(addr, &secret, true));
        true
    }

    #[test]
    fn runs_a_command_through_the_helper() {
        let host = Host { launch: Some(local), ..Host::default() };
        let mut command = CommandBuilder::new("cmd");
        command.args(["/c", "echo", "hi"]);
        command.env_clear();
        for (key, value) in std::env::vars() {
            command.env(key, value);
        }
        let (_master, mut reader, mut writer, mut child) = host.spawn(&command, PtySize::default()).unwrap();
        // ConPTY asks for the cursor position before it runs anything; xterm.js answers it in the app.
        writer.write_all(b"\x1b[1;1R").unwrap();
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        assert!(output.contains("hi"), "{output:?}");
        assert_eq!(child.wait().unwrap().exit_code(), 0);
    }
}
