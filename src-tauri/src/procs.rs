use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(any(windows, test))]
use std::time::Duration;

const GIB: u64 = 1 << 30;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Light,
    #[default]
    Balanced,
    Performance,
    Custom,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Budget {
    cpu: i64,
    ram: i64,
    gpu: i64,
    parallel: i64,
}

const LIGHT: Budget = Budget { cpu: 10, ram: 10, gpu: 0, parallel: 1 };
const BALANCED: Budget = Budget { cpu: 40, ram: 40, gpu: 30, parallel: 3 };
const PERFORMANCE: Budget = Budget { cpu: 90, ram: 85, gpu: 90, parallel: 0 };

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
struct Config {
    mode: Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom: Option<Budget>,
}

impl Config {
    fn load(file: &Path) -> Self {
        let data = crate::accounts::read_json(file, Value::Null);
        let custom = serde_json::from_value(data["custom"].clone()).ok();
        let mode = serde_json::from_value(data["mode"].clone()).unwrap_or_default();
        let mode = if mode == Mode::Custom && custom.is_none() { Mode::Balanced } else { mode };
        Self { mode, custom }
    }

    fn budget(self) -> Budget {
        match self.mode {
            Mode::Light => LIGHT,
            Mode::Balanced => BALANCED,
            Mode::Performance => PERFORMANCE,
            Mode::Custom => self.custom.unwrap_or(BALANCED),
        }
    }

    fn cpu_rate(self, cores: u32) -> u32 {
        if self.mode == Mode::Performance && cores > 1 {
            return (10_000 - 10_000u32.div_ceil(cores)).min(9000);
        }
        self.budget().cpu.saturating_mul(100).clamp(1, 10_000) as u32
    }

    fn effective(self, cores: u32, ram_bytes: u64) -> Value {
        let mut budget = budget_json(self.budget(), self.mode);
        budget["mode"] = json!(self.mode);
        if self.mode == Mode::Performance {
            budget["cpu"] = json!(f64::from(self.cpu_rate(cores)) / 100.0);
            if ram_bytes != 0 {
                let cap = (u128::from(ram_bytes) * 85 / 100) as u64;
                budget["ram"] = json!(cap.min(ram_bytes.saturating_sub(2 * GIB)) as f64 * 100.0 / ram_bytes as f64);
            }
        }
        budget
    }
}

fn budget_json(budget: Budget, mode: Mode) -> Value {
    let mut data = json!(budget);
    data["priority"] = json!(if mode == Mode::Light { "below_normal" } else { "normal" });
    data
}

fn validate(mode: &str, custom: Option<Budget>, saved: Option<Budget>) -> Result<Config, String> {
    let mode = serde_json::from_value(json!(mode)).map_err(|_| "Invalid performance mode".to_owned())?;
    let valid = |custom: Budget| {
        [custom.cpu, custom.ram, custom.gpu].into_iter().all(|value| (1..=100).contains(&value))
            && (0..=32).contains(&custom.parallel)
    };
    if custom.is_some_and(|b| !valid(b)) {
        return Err("CPU, RAM and GPU must be integers from 1 to 100, and parallel must be an integer from 0 to 32".into());
    }
    let custom = custom.or(saved);
    if mode == Mode::Custom && !custom.is_some_and(valid) {
        return Err("Custom mode requires valid CPU, RAM, GPU and parallel budgets".into());
    }
    Ok(Config { mode, custom })
}

fn config_path() -> Result<PathBuf, String> {
    std::env::home_dir().map(|home| home.join(".frugal").join("performance.json"))
        .ok_or_else(|| "User folder unavailable".into())
}

fn config() -> Config {
    config_path().map_or_else(|_| Config::default(), |file| Config::load(&file))
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
pub(crate) struct Limits {
    cpu_rate: u32,
    light: bool,
}

impl Limits {
    pub(crate) fn valid(self) -> bool { (1..=10_000).contains(&self.cpu_rate) }
}

pub(crate) fn limits() -> Limits {
    let config = config();
    Limits { cpu_rate: config.cpu_rate(platform::cores()), light: config.mode == Mode::Light }
}

fn refresh(host: &crate::elevated::Host) {
    static REFRESH: Mutex<()> = Mutex::new(());
    let Ok(_refresh) = REFRESH.lock() else { return };
    let limits = limits();
    apply_limits(limits);
    host.apply_limits(limits);
}

#[cfg(windows)]
pub(crate) fn watch(app: tauri::AppHandle) {
    use tauri::Manager;
    let watched = app.clone();
    refresh(&app.state::<crate::elevated::Host>());
    if let Err(error) = std::thread::Builder::new().spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        refresh(&watched.state::<crate::elevated::Host>());
    }) {
        crate::debug_log!("procs", "Could not watch performance settings: {error}");
    }
}

#[cfg(not(windows))]
pub(crate) fn watch(_: tauri::AppHandle) {}

#[cfg(any(windows, test))]
fn cpu_pct(previous: u64, current: u64, elapsed: Duration, cores: u32) -> f64 {
    if elapsed.is_zero() || cores == 0 {
        return 0.0;
    }
    (current.saturating_sub(previous) as f64 / (elapsed.as_secs_f64() * 100_000.0 * f64::from(cores))).min(100.0)
}

#[tauri::command]
pub fn perf_get() -> Value {
    let config = config();
    json!({
        "mode": config.mode, "custom": config.custom,
        "presets": {
            "light": budget_json(LIGHT, Mode::Light),
            "balanced": budget_json(BALANCED, Mode::Balanced),
            "performance": budget_json(PERFORMANCE, Mode::Performance),
        },
        "effective": config.effective(platform::cores(), platform::ram_bytes()),
    })
}

#[tauri::command]
pub fn perf_set(mode: String, custom: Option<Budget>, host: tauri::State<crate::elevated::Host>) -> Result<Value, String> {
    use std::io::Write;
    static WRITE: Mutex<()> = Mutex::new(());
    let _write = WRITE.lock().map_err(|error| error.to_string())?;
    let file = config_path()?;
    let config = validate(&mode, custom, Config::load(&file).custom)?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    let folder = file.parent().ok_or("User folder unavailable")?;
    std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let temp = folder.join(format!("performance-{:016x}.tmp", u64::from_ne_bytes(nonce)));
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|error| error.to_string())?;
    let result = output.write_all(&bytes).and_then(|()| output.sync_all());
    drop(output);
    if let Err(error) = result.and_then(|()| std::fs::rename(&temp, &file)) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    refresh(&host);
    Ok(perf_get())
}

#[tauri::command]
pub fn perf_machine() -> Value {
    json!({ "cores": platform::cores(), "ram_bytes": platform::ram_bytes(), "gpus": platform::gpus() })
}

pub(crate) use platform::{apply_limits, Job};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::sync::{Once, OnceLock};
    use std::time::Instant;
    use windows::core::{s, w, BOOL, GUID, HRESULT, Interface, PCWSTR, Type};
    use windows::Win32::Foundation::{FreeLibrary, ERROR_MORE_DATA, FILETIME, HANDLE, LUID, NTSTATUS, UNICODE_STRING};
    use windows::Win32::Graphics::{DXCore, Dxgi};
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    use windows::Win32::System::Performance::*;
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::*;

    pub fn cores() -> u32 {
        unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1)
    }

    pub fn ram_bytes() -> u64 {
        let mut memory = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        unsafe { GlobalMemoryStatusEx(&mut memory) }.map_or(0, |()| memory.ullTotalPhys)
    }

    fn wide_text(text: &[u16]) -> String {
        String::from_utf16_lossy(text.split(|&ch| ch == 0).next().unwrap_or_default())
    }

    fn dxcore_factory() -> Option<DXCore::IDXCoreAdapterFactory> {
        type CreateFactory = unsafe extern "system" fn(*const GUID, *mut *mut c_void) -> HRESULT;
        static CREATE: OnceLock<Option<CreateFactory>> = OnceLock::new();
        // DXCore is absent on older Windows 10 builds. Keep the system DLL loaded if available.
        let create = (*CREATE.get_or_init(|| {
            let module = unsafe { LoadLibraryExW(w!("dxcore.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }.ok()?;
            match unsafe { GetProcAddress(module, s!("DXCoreCreateAdapterFactory")) } {
                Some(proc) => Some(unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateFactory>(proc) }),
                None => {
                    let _ = unsafe { FreeLibrary(module) };
                    None
                }
            }
        }))?;
        let mut factory = std::ptr::null_mut();
        unsafe { create(&DXCore::IDXCoreAdapterFactory::IID, &mut factory).and_then(|| Type::from_abi(factory)) }.ok()
    }

    fn adapters() -> Vec<(LUID, Value)> {
        let Ok(factory) = (unsafe { Dxgi::CreateDXGIFactory1::<Dxgi::IDXGIFactory1>() }) else { return Vec::new() };
        let Some(core) = dxcore_factory() else { return Vec::new() };
        (0..).map_while(|i| unsafe { factory.EnumAdapters1(i) }.ok()).filter_map(|adapter| {
            let desc = unsafe { adapter.GetDesc1() }.ok()?;
            if desc.Flags & Dxgi::DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 || (desc.DedicatedVideoMemory as u64) < GIB {
                return None;
            }
            let adapter = unsafe { core.GetAdapterByLuid::<DXCore::IDXCoreAdapter>(&desc.AdapterLuid) }.ok()?;
            let mut integrated = 1u8;
            unsafe { adapter.GetProperty(DXCore::IsIntegrated, size_of::<u8>(), (&mut integrated as *mut u8).cast()) }.ok()?;
            (integrated == 0).then(|| (desc.AdapterLuid, json!({
                "name": wide_text(&desc.Description), "vram_bytes": desc.DedicatedVideoMemory,
            })))
        }).collect()
    }

    pub fn gpus() -> Vec<Value> {
        adapters().into_iter().map(|(_, desc)| desc).collect()
    }

    fn raw(handle: &OwnedHandle) -> HANDLE { HANDLE(handle.as_raw_handle()) }

    fn set_info<T>(job: &OwnedHandle, class: JOBOBJECTINFOCLASS, info: &T) -> windows::core::Result<()> {
        unsafe { SetInformationJobObject(raw(job), class, (info as *const T).cast(), size_of::<T>() as u32) }
    }

    fn set_priority(job: &OwnedHandle, priority: Option<PROCESS_CREATION_FLAGS>) -> windows::core::Result<()> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Some(priority) = priority {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PRIORITY_CLASS;
            info.BasicLimitInformation.PriorityClass = priority.0;
        }
        set_info(job, JobObjectExtendedLimitInformation, &info)
    }

    fn create_job() -> windows::core::Result<OwnedHandle> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }?;
        // CreateJobObjectW returns a new, non-inheritable handle.
        let job = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        set_priority(&job, None)?;
        Ok(job)
    }

    fn log_once(once: &Once, message: &str, error: &impl std::fmt::Display) {
        once.call_once(|| {
            let message = format!("{message}: {error}");
            if std::env::args_os().nth(1).is_some_and(|arg| arg == crate::elevated::FLAG) {
                crate::elevated::log(&message);
            } else {
                crate::debug::write("procs", &message);
            }
        });
    }

    static ASSIGN_ERROR: Once = Once::new();
    static LIMIT_ERROR: Once = Once::new();
    static TERMINATE_ERROR: Once = Once::new();
    static PARENT: OnceLock<Option<Parent>> = OnceLock::new();

    struct Parent {
        job: OwnedHandle,
        applied: Mutex<Option<Limits>>,
    }

    impl Parent {
        fn apply(&self, limits: Limits) -> windows::core::Result<()> {
            let Ok(mut applied) = self.applied.lock() else { return Ok(()) };
            if *applied == Some(limits) {
                return Ok(());
            }
            let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: limits.cpu_rate },
            };
            // Set both independently so an unsupported CPU cap does not disable ownership or priority.
            let cpu_result = set_info(&self.job, JobObjectCpuRateControlInformation, &cpu);
            let priority_result = if limits.light {
                set_priority(&self.job, Some(BELOW_NORMAL_PRIORITY_CLASS))
            } else {
                // Removing the limit leaves existing processes at their last assigned priority.
                set_priority(&self.job, Some(NORMAL_PRIORITY_CLASS)).and_then(|()| set_priority(&self.job, None))
            };
            cpu_result.and(priority_result)?;
            *applied = Some(limits);
            Ok(())
        }
    }

    pub(crate) fn apply_limits(limits: Limits) {
        if let Some(parent) = parent() {
            if let Err(error) = parent.apply(limits) {
                log_once(&LIMIT_ERROR, "Could not update process job limits", &error);
            }
        }
    }

    fn parent() -> Option<&'static Parent> {
        PARENT.get_or_init(|| {
            let job = match create_job() {
                Ok(job) => job,
                Err(error) => {
                    log_once(&ASSIGN_ERROR, "Could not create the parent process job", &error);
                    return None;
                }
            };
            Some(Parent { job, applied: Mutex::new(None) })
        }).as_ref()
    }

    #[derive(Default)]
    struct CpuSample {
        at: Option<Instant>,
        times: HashMap<u32, (u64, u64)>,
    }

    pub struct Job {
        handle: OwnedHandle,
        cpu: CpuSample,
        gpu: Option<Option<GpuQuery>>,
    }

    impl Job {
        pub fn new() -> Option<Self> {
            let _ = parent();
            match create_job() {
                Ok(handle) => Some(Self { handle, cpu: CpuSample::default(), gpu: None }),
                Err(error) => {
                    log_once(&ASSIGN_ERROR, "Could not create the chat process job", &error);
                    None
                }
            }
        }

        pub fn attach(self, child: &dyn portable_pty::Child) -> Option<Self> {
            let Some(process) = child.as_raw_handle().map(HANDLE) else {
                log_once(&ASSIGN_ERROR, "Could not assign the chat process job", &"PTY child handle unavailable");
                return None;
            };
            if let Some(parent) = parent() {
                if let Err(error) = unsafe { AssignProcessToJobObject(raw(&parent.job), process) } {
                    log_once(&ASSIGN_ERROR, "Could not assign the parent process job", &error);
                }
            }
            match unsafe { AssignProcessToJobObject(raw(&self.handle), process) } {
                Ok(()) => Some(self),
                Err(error) => {
                    log_once(&ASSIGN_ERROR, "Could not assign the chat process job", &error);
                    None
                }
            }
        }

        fn terminate_processes(&self) -> bool {
            match unsafe { TerminateJobObject(raw(&self.handle), 1) } {
                Ok(()) => true,
                Err(error) => {
                    log_once(&TERMINATE_ERROR, "Could not terminate the chat process job", &error);
                    false
                }
            }
        }

        pub fn terminate(self) -> bool {
            // Drop closes the handle even if explicit termination fails.
            self.terminate_processes()
        }

        fn pids(&self) -> windows::core::Result<Vec<u32>> {
            // The native header contains two DWORDs followed by a variable-length ULONG_PTR array.
            let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / size_of::<usize>();
            let mut data = vec![0usize; header + 16];
            loop {
                let bytes = (data.len() * size_of::<usize>()) as u32;
                let query = unsafe { QueryInformationJobObject(Some(raw(&self.handle)), JobObjectBasicProcessIdList,
                    data.as_mut_ptr().cast(), bytes, None) };
                let assigned = data[0] as u32 as usize;
                // On 64-bit Windows the two little-endian DWORDs share the first word.
                let count = if header == 1 { (data[0] as u64 >> 32) as usize } else { data[1] };
                match query {
                    Ok(()) if assigned == count && count <= data.len() - header => {
                        return Ok(data[header..header + count].iter().filter_map(|&pid| u32::try_from(pid).ok()).filter(|&pid| pid != 0).collect());
                    }
                    Ok(()) => {}
                    Err(error) if error.code() == ERROR_MORE_DATA.to_hresult() => {}
                    Err(error) => return Err(error),
                }
                let words = data.len().saturating_mul(2).max(assigned.saturating_add(header));
                if words > u32::MAX as usize / size_of::<usize>() || data.try_reserve_exact(words - data.len()).is_err() {
                    return Err(windows::core::Error::from_hresult(ERROR_MORE_DATA.to_hresult()));
                }
                data.resize(words, 0);
            }
        }

        fn contains(&self, process: HANDLE) -> windows::core::Result<bool> {
            let mut member = BOOL::default();
            unsafe { IsProcessInJob(process, Some(raw(&self.handle)), &mut member) }?;
            Ok(member.as_bool())
        }

        pub fn kill(&self, pid: u32) -> Result<Value, String> {
            const OUTSIDE: &str = "PID is not in this chat's process job";
            if pid == 0 || !self.pids().map_err(|error| error.to_string())?.contains(&pid) {
                return Err(OUTSIDE.into());
            }
            let process = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .map_err(|error| error.to_string())?;
            let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
            // Recheck the opened object so PID reuse between enumeration and OpenProcess cannot kill an unrelated process.
            if !self.contains(raw(&process)).map_err(|error| error.to_string())? {
                return Err(OUTSIDE.into());
            }
            unsafe { TerminateProcess(raw(&process), 1) }.map_err(|error| error.to_string())?;
            Ok(json!({"ok": true}))
        }

        pub fn processes(&mut self) -> Result<Value, String> {
            let pids = self.pids().map_err(|error| error.to_string())?;
            let metadata = process_metadata();
            let gpu = if let Some(gpu) = &mut self.gpu {
                gpu.as_mut().and_then(GpuQuery::sample)
            } else {
                self.gpu = Some(GpuQuery::open());
                None
            };
            let now = Instant::now();
            let elapsed = self.cpu.at.map_or(Duration::ZERO, |at| now.duration_since(at));
            let cores = cores();
            let mut times = HashMap::new();
            let mut processes = Vec::new();
            let (mut cpu_total, mut ram_total, mut gpu_total) = (0.0, 0u64, 0.0);
            let mut gpu_valid = gpu.is_some();
            for pid in pids {
                let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { continue };
                let process = unsafe { OwnedHandle::from_raw_handle(handle.0) };
                let process = raw(&process);
                if !self.contains(process).unwrap_or(false) {
                    continue;
                }
                let (ppid, name) = metadata.get(&pid).map_or((0, ""), |(ppid, name)| (*ppid, name.as_str()));
                let (mut started_ms, mut cpu) = (0, 0.0);
                if let Some((started, ticks)) = process_times(process) {
                    started_ms = started.saturating_sub(116_444_736_000_000_000) / 10_000;
                    if let Some(&(previous_start, previous_ticks)) = self.cpu.times.get(&pid) {
                        if previous_start == started {
                            cpu = cpu_pct(previous_ticks, ticks, elapsed, cores);
                        }
                    }
                    times.insert(pid, (started, ticks));
                }
                let mut memory = PROCESS_MEMORY_COUNTERS { cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
                let ram = if unsafe { K32GetProcessMemoryInfo(process, &mut memory, size_of::<PROCESS_MEMORY_COUNTERS>() as u32) }.as_bool() {
                    memory.WorkingSetSize as u64
                } else { 0 };
                let mut row = json!({"pid": pid, "ppid": ppid, "name": name, "cmd": command_line(process),
                    "cpu_pct": cpu, "ram_bytes": ram, "started_ms": started_ms});
                if let Some(gpu) = &gpu {
                    match gpu.get(&pid).copied().unwrap_or(Some(0.0)) {
                        Some(pct) => {
                            row["gpu_pct"] = json!(pct);
                            gpu_total += pct;
                        }
                        None => gpu_valid = false,
                    }
                }
                processes.push(row);
                cpu_total += cpu;
                ram_total = ram_total.saturating_add(ram);
            }
            self.cpu = CpuSample { at: Some(now), times };
            let mut totals = json!({"cpu_pct": cpu_total, "ram_bytes": ram_total});
            if gpu_valid {
                totals["gpu_pct"] = json!(gpu_total);
            }
            Ok(json!({"processes": processes, "totals": totals}))
        }
    }

    fn process_metadata() -> HashMap<u32, (u32, String)> {
        let mut rows = HashMap::new();
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return rows };
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut result = unsafe { Process32FirstW(raw(&snapshot), &mut entry) };
        while result.is_ok() {
            rows.insert(entry.th32ProcessID, (entry.th32ParentProcessID, wide_text(&entry.szExeFile)));
            result = unsafe { Process32NextW(raw(&snapshot), &mut entry) };
        }
        rows
    }

    fn process_times(process: HANDLE) -> Option<(u64, u64)> {
        let [mut start, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
        unsafe { GetProcessTimes(process, &mut start, &mut exit, &mut kernel, &mut user) }.ok()?;
        let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        Some((ticks(start), ticks(kernel).saturating_add(ticks(user))))
    }

    fn command_line(process: HANDLE) -> String {
        // Same NT information class as the plugin. The result points into the caller's buffer.
        windows::core::link!("ntdll.dll" "system" fn NtQueryInformationProcess(process: HANDLE, class: u32,
            info: *mut c_void, bytes: u32, returned: *mut u32) -> NTSTATUS);
        const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
        #[repr(C)]
        struct CommandLine {
            header: UNICODE_STRING,
            text: [u16; 32_768],
        }
        let mut buffer = CommandLine { header: UNICODE_STRING::default(), text: [0; 32_768] };
        let mut bytes = 0;
        let status = unsafe { NtQueryInformationProcess(process, PROCESS_COMMAND_LINE_INFORMATION,
            (&mut buffer as *mut CommandLine).cast(), size_of::<CommandLine>() as u32, &mut bytes) };
        if status.0 < 0 || buffer.header.Length % 2 != 0 {
            return String::new();
        }
        let Some(offset) = (buffer.header.Buffer.0 as usize).checked_sub(buffer.text.as_ptr() as usize) else { return String::new() };
        let length = usize::from(buffer.header.Length);
        if offset % 2 != 0 || offset.saturating_add(length) > (bytes as usize).saturating_sub(size_of::<UNICODE_STRING>()) {
            return String::new();
        }
        buffer.text.get(offset / 2..offset / 2 + length / 2).map_or_else(String::new, |text| {
            char::decode_utf16(text.iter().copied()).take(200).map(|ch| ch.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
        })
    }

    struct GpuQuery {
        // PDH handles are opaque pointer-sized tokens, used only under the chat lock.
        query: usize,
        counter: usize,
        adapters: Vec<String>,
    }

    impl GpuQuery {
        fn open() -> Option<Self> {
            let adapters: Vec<_> = adapters().into_iter().map(|(luid, _)| {
                format!("luid_0x{:08x}_0x{:08x}", luid.HighPart as u32, luid.LowPart)
            }).collect();
            if adapters.is_empty() {
                return None;
            }
            let mut query = PDH_HQUERY::default();
            if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
                return None;
            }
            let mut sampler = Self { query: query.0 as usize, counter: 0, adapters };
            let mut counter = PDH_HCOUNTER::default();
            // One wildcard counter keeps samples for new instances. Filter by exact PID and dedicated LUID below.
            if unsafe { PdhAddEnglishCounterW(query, w!(r"\GPU Engine(*)\Utilization Percentage"), 0, &mut counter) } != 0 {
                return None;
            }
            sampler.counter = counter.0 as usize;
            let _ = unsafe { PdhCollectQueryData(query) };
            Some(sampler)
        }

        fn sample(&mut self) -> Option<HashMap<u32, Option<f64>>> {
            if unsafe { PdhCollectQueryData(PDH_HQUERY(self.query as *mut c_void)) } != 0 {
                return None;
            }
            let counter = PDH_HCOUNTER(self.counter as *mut c_void);
            let (mut bytes, mut count) = (0, 0);
            let format = PDH_FMT_DOUBLE;
            match unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut bytes, &mut count, None) } {
                0 if count == 0 => return Some(HashMap::new()),
                PDH_MORE_DATA => {}
                _ => return None,
            }
            let words = (bytes as usize).div_ceil(size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>());
            let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); words];
            if unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut bytes, &mut count, Some(items.as_mut_ptr())) } != 0 {
                return None;
            }
            let mut sums = HashMap::new();
            for item in items.get(..count as usize)? {
                // On success PDH returns null-terminated instance names in the live output buffer.
                let name = unsafe { item.szName.to_string() }.ok()?;
                let Some((pid, suffix)) = name.strip_prefix("pid_").and_then(|name| name.split_once('_')) else { continue };
                if !self.adapters.iter().any(|luid| suffix.strip_prefix(luid).is_some_and(|rest| rest.starts_with('_'))) {
                    continue;
                }
                let Ok(pid) = pid.parse::<u32>() else { continue };
                let total = sums.entry(pid).or_insert(Some(0.0));
                if matches!(item.FmtValue.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA) {
                    let value = unsafe { item.FmtValue.Anonymous.doubleValue };
                    *total = total.filter(|_| value.is_finite()).map(|total| total + value.max(0.0));
                } else {
                    *total = None;
                }
            }
            Some(sums)
        }
    }

    impl Drop for GpuQuery {
        fn drop(&mut self) {
            if self.query != 0 {
                let _ = unsafe { PdhCloseQuery(PDH_HQUERY(self.query as *mut c_void)) };
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn cores() -> u32 { std::thread::available_parallelism().map_or(1, |cores| cores.get() as u32) }
    pub fn ram_bytes() -> u64 { 0 }
    pub fn gpus() -> Vec<Value> { Vec::new() }
    pub(crate) fn apply_limits(_: Limits) {}

    pub struct Job;

    impl Job {
        pub fn new() -> Option<Self> { None }
        pub fn attach(self, _: &dyn portable_pty::Child) -> Option<Self> { None }
        pub fn terminate(self) -> bool { false }
        pub fn processes(&mut self) -> Result<Value, String> { Err("Process jobs are unavailable".into()) }
        pub fn kill(&self, _: u32) -> Result<Value, String> { Err("Process jobs are unavailable".into()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_and_budgets() {
        assert_eq!(Config::default().effective(8, 8 * GIB),
            json!({"mode":"balanced","cpu":40,"ram":40,"gpu":30,"parallel":3,"priority":"normal"}));
        assert_eq!(Config { mode: Mode::Light, custom: None }.effective(8, 8 * GIB),
            json!({"mode":"light","cpu":10,"ram":10,"gpu":0,"parallel":1,"priority":"below_normal"}));
        let performance = Config { mode: Mode::Performance, custom: None };
        assert_eq!(performance.effective(8, 8 * GIB),
            json!({"mode":"performance","cpu":87.5,"ram":75.0,"gpu":90,"parallel":0,"priority":"normal"}));
        assert!((performance.effective(16, 32 * GIB)["ram"].as_f64().unwrap() - 85.0).abs() < 1e-8);
        assert_eq!(performance.effective(4, GIB)["ram"], 0.0);
    }

    #[test]
    fn cpu_rate_matches_plugin() {
        let performance = Config { mode: Mode::Performance, custom: None };
        for (cores, rate) in [(0, 9000), (1, 9000), (2, 5000), (3, 6666), (8, 8750), (10, 9000), (16, 9000)] {
            assert_eq!(performance.cpu_rate(cores), rate);
        }
        assert_eq!(Config::default().cpu_rate(8), 4000);
        assert_eq!(Config { mode: Mode::Light, custom: None }.cpu_rate(8), 1000);
    }

    #[test]
    fn validates_perf_set_input() {
        let budget = Budget { cpu: 1, ram: 100, gpu: 1, parallel: 32 };
        assert_eq!(validate("custom", Some(budget), None).unwrap().budget(), budget);
        assert_eq!(validate("balanced", None, Some(budget)).unwrap().custom, Some(budget));
        assert_eq!(validate("custom", None, Some(budget)).unwrap().budget(), budget);
        assert!(validate("custom", None, None).is_err());
        assert!(validate("unknown", None, None).is_err());
        for invalid in [Budget { cpu: 0, ..budget }, Budget { ram: 101, ..budget },
            Budget { gpu: -1, ..budget }, Budget { parallel: 33, ..budget }] {
            assert!(validate("light", Some(invalid), None).is_err());
        }
        for value in [json!(true), json!(1.5), json!("1"), json!(null)] {
            assert!(serde_json::from_value::<Budget>(json!({"cpu": value, "ram": 1, "gpu": 1, "parallel": 0})).is_err());
        }
    }

    #[test]
    fn cpu_delta_is_percent_of_the_whole_machine() {
        let second = Duration::from_secs(1);
        assert_eq!(cpu_pct(10_000_000, 20_000_000, second, 4), 25.0);
        assert_eq!(cpu_pct(20, 5, second, 4), 0.0);
        assert_eq!(cpu_pct(0, 40_000_000, second, 4), 100.0);
        assert_eq!(cpu_pct(0, 100, Duration::ZERO, 4), 0.0);
        assert_eq!(cpu_pct(0, 100, second, 0), 0.0);
    }
}
