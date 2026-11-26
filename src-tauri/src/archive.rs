// Gzipped copies of transcripts in ~/.frugal-deck/archive, since Claude Code deletes transcripts idle cleanupPeriodDays (30 by default).
// A copy mirrors its transcript's path under %USERPROFILE%, so restoring needs no database.

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::index::Index;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
// A transcript still being written is copied on a later pass.
const IDLE: Duration = Duration::from_secs(10 * 60);
const EVERY: Duration = Duration::from_secs(60 * 60);

pub fn root(home: &Path) -> PathBuf { home.join(".frugal-deck").join("archive") }

pub fn is_copy(file: &str) -> bool { file.ends_with(".jsonl.gz") }

// frugal: config folders outside %USERPROFILE% are not copied; mirror them under archive/<drive> if one shows up.
pub fn mirror(home: &Path, path: &Path) -> Option<PathBuf> { Some(root(home).join(path.strip_prefix(home).ok()?)) }

pub fn copy_path(home: &Path, file: &Path) -> Option<PathBuf> {
    let mut copy = mirror(home, file)?.into_os_string();
    copy.push(".gz");
    Some(copy.into())
}

pub fn original_path(home: &Path, copy: &Path) -> Option<PathBuf> {
    Some(home.join(copy.strip_prefix(root(home)).ok()?.to_str()?.strip_suffix(".gz")?))
}

// Written beside the target and renamed, so a crash never leaves half a file under the real name.
fn write_new(target: &Path, fill: impl FnOnce(&mut File) -> Result<()>) -> Result<File> {
    fs::create_dir_all(target.parent().ok_or_else(|| crate::i18n::t("error.no-parent-folder", &[]))?)?;
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(".tmp");
    let written = File::create(&temporary).map_err(Into::into).and_then(|mut out| fill(&mut out).map(|()| out));
    match written {
        Ok(out) => { fs::rename(&temporary, target)?; Ok(out) }
        Err(error) => { let _ = fs::remove_file(&temporary); Err(error) }
    }
}

// The copy takes the transcript's mtime from before the read, so a line appended meanwhile makes it stale again.
pub fn copy(home: &Path, file: &Path, idle: Duration) -> Result<bool> {
    let Some(target) = copy_path(home, file) else { return Ok(false) };
    let source = fs::metadata(file)?.modified()?;
    if source.elapsed().unwrap_or_default() < idle { return Ok(false); }
    if fs::metadata(&target).and_then(|m| m.modified()).is_ok_and(|t| t >= source) { return Ok(false); }
    let out = write_new(&target, |out| {
        let mut gz = GzEncoder::new(out, Compression::default());
        io::copy(&mut File::open(file)?, &mut gz)?;
        gz.finish()?.flush()?;
        Ok(())
    })?;
    out.set_modified(source)?;
    Ok(true)
}

// Never over an existing transcript. The restored file keeps the current time, so Claude Code's cleanup does not take it again on start.
pub fn restore(home: &Path, copy: &Path) -> Result<PathBuf> {
    let target = original_path(home, copy).ok_or_else(|| crate::i18n::t("error.not-an-archive-copy", &[]))?;
    if !target.exists() {
        write_new(&target, |out| { io::copy(&mut GzDecoder::new(File::open(copy)?), out)?; Ok(()) })?;
    }
    Ok(target)
}

pub fn copy_all(app: &AppHandle, home: &Path, files: &[String], idle: Duration) {
    let mut failed = None;
    for file in files.iter().filter(|f| !is_copy(f)) {
        if let Err(error) = copy(home, Path::new(file), idle) { failed.get_or_insert(crate::i18n::t("error.archive-file-copy-failed", &[("file", &file), ("error", &error)])); }
    }
    if let Some(error) = failed { crate::index::publish(app, json!({ "error": error })); }
}

// After the startup scan, then every hour. Read from deck.db, since the sidebar leaves out chats whose folder is gone, such as a removed worktree.
pub fn start(app: AppHandle, home: PathBuf) {
    let db = home.join(".frugal-deck").join("deck.db");
    thread::spawn(move || loop {
        let index = app.state::<Index>();
        while index.get("indexing") != false { thread::sleep(Duration::from_secs(5)); }
        match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(Into::into).and_then(|db| crate::index::archivable(&db)) {
            Ok(files) => copy_all(&app, &home, &files, IDLE),
            Err(error) => crate::index::publish(&app, json!({ "error": crate::i18n::t("error.archive-copy-failed", &[("error", &error)]) })),
        }
        thread::sleep(EVERY);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_restore_and_freshness() {
        let home = std::env::temp_dir().join(format!("deck-archive-{}", std::process::id()));
        let file = home.join(".claude/projects/p/00000000-0000-4000-8000-000000000001.jsonl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{\"a\":1}\n").unwrap();
        let copy_file = copy_path(&home, &file).unwrap();
        assert_eq!(copy_file, home.join(".frugal-deck/archive/.claude/projects/p/00000000-0000-4000-8000-000000000001.jsonl.gz"));
        assert_eq!(original_path(&home, &copy_file).unwrap(), file);
        assert_eq!(copy_path(&home, Path::new("Z:\\elsewhere\\x.jsonl")), None);
        assert!(!copy(&home, &file, IDLE).unwrap(), "too recent");
        assert!(copy(&home, &file, Duration::ZERO).unwrap());
        assert!(!copy(&home, &file, Duration::ZERO).unwrap(), "fresh");
        fs::write(&file, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        File::options().append(true).open(&file).unwrap().set_modified(std::time::SystemTime::now() + Duration::from_secs(5)).unwrap();
        assert!(copy(&home, &file, Duration::ZERO).unwrap(), "stale after a change");
        fs::remove_file(&file).unwrap();
        assert_eq!(restore(&home, &copy_file).unwrap(), file);
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        fs::write(&file, "kept").unwrap();
        restore(&home, &copy_file).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept");
        fs::remove_dir_all(&home).unwrap();
    }
}
