//! Single-instance IPC startup. The lock inode is permanent: unlinking it on
//! shutdown would allow a waiting process to lock an orphaned inode (ABA).
use anyhow::{bail, Context, Result};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::net::{UnixListener, UnixStream};

pub struct SocketLock {
    // Owned for the entire lifetime of the listener, including accept().
    _file: File,
}

fn lock_path(socket: &Path) -> PathBuf {
    let mut name: OsString = socket.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

impl SocketLock {
    pub fn acquire(socket: &Path) -> Result<Self> {
        let path = lock_path(socket);
        // NONBLOCK prevents a pre-existing FIFO from hanging open(); NOFOLLOW
        // prevents a lock path from resolving to another user's file.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .with_context(|| format!("open daemon lock {}", path.display()))?;
        let owner = unsafe { libc::geteuid() };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.uid() != owner || metadata.mode() & 0o7777 != 0o600 {
            bail!("unsafe daemon lock file {}", path.display());
        }
        // flock is tied to this open file description and released by Drop.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error()).with_context(|| {
                format!("daemon already starting/running (lock {})", path.display())
            });
        }
        // Reject a path replaced between open and flock. Never remove the lock.
        let current = fs::symlink_metadata(&path)?;
        if !current.is_file() || current.dev() != metadata.dev() || current.ino() != metadata.ino()
        {
            bail!("daemon lock path changed: {}", path.display());
        }
        Ok(Self { _file: file })
    }
}

// Do not follow socket symlinks, even if they point at a socket owned by us.
fn socket_metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o7777 != 0o600
            {
                bail!("refusing unsafe socket path {}", path.display());
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("inspect socket {}", path.display())),
    }
}

/// Call only while holding SocketLock. Probe existing sockets before touching
/// desktop backends; a running older daemon may not implement our lock.
/// This does not create a listening socket or indicate readiness to clients.
pub async fn prepare_path(socket: &Path) -> Result<()> {
    if let Some(previous) = socket_metadata(socket)? {
        match tokio::time::timeout(Duration::from_millis(500), UnixStream::connect(socket)).await {
            Ok(Ok(_)) => bail!("daemon already listening at {}", socket.display()),
            Ok(Err(error))
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ECONNREFUSED | libc::ENOENT)
                ) => {}
            Ok(Err(error)) => return Err(error).context("probe existing daemon socket"),
            Err(_) => bail!("timed out probing daemon socket {}", socket.display()),
        }
        // Do not remove a different inode placed here during the probe.
        if let Some(current) = socket_metadata(socket)? {
            if current.dev() != previous.dev() || current.ino() != previous.ino() {
                bail!("daemon socket changed during probe: {}", socket.display());
            }
            fs::remove_file(socket).context("remove stale daemon socket")?;
        }
    }
    Ok(())
}

/// Check again while holding the lock: an old daemon without our locking
/// protocol could have bound the socket during backend initialization.
pub async fn bind(socket: &Path) -> Result<UnixListener> {
    prepare_path(socket).await?;
    let listener =
        UnixListener::bind(socket).with_context(|| format!("bind {}", socket.display()))?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600))
        .context("restrict daemon socket permissions")?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pi-turbo-lock-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn socket(&self) -> PathBuf {
            self.0.join("ipc")
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn exclusive_persistent_lock() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let lock = SocketLock::acquire(&socket).unwrap();
        let path = lock_path(&socket);
        let inode = fs::metadata(&path).unwrap().ino();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert!(SocketLock::acquire(&socket).is_err());
        drop(lock);
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        let _lock = SocketLock::acquire(&socket).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    }

    #[test]
    fn unsafe_lock_paths_fail_closed() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let path = lock_path(&socket);
        let target = dir.0.join("target");
        fs::write(&target, b"untouched").unwrap();
        symlink(&target, &path).unwrap();
        assert!(SocketLock::acquire(&socket).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(SocketLock::acquire(&socket).is_err());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, b"preserved").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(SocketLock::acquire(&socket).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"preserved");
    }

    #[tokio::test]
    async fn preparation_cleans_stale_socket_without_listening() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let _lock = SocketLock::acquire(&socket).unwrap();
        prepare_path(&socket).await.unwrap();
        assert!(!socket.exists());
        let stale = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        drop(stale);
        prepare_path(&socket).await.unwrap();
        assert!(fs::symlink_metadata(&socket).is_err());
        assert!(UnixStream::connect(&socket).await.is_err());
        let listener = bind(&socket).await.unwrap();
        assert!(UnixStream::connect(&socket).await.is_ok());
        drop(listener);
    }

    #[tokio::test]
    async fn live_and_stale_socket() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let _lock = SocketLock::acquire(&socket).unwrap();
        let listener = bind(&socket).await.unwrap();
        assert_eq!(fs::metadata(&socket).unwrap().mode() & 0o777, 0o600);
        assert!(bind(&socket).await.is_err());
        drop(listener);
        let listener = bind(&socket).await.unwrap();
        assert!(UnixStream::connect(&socket).await.is_ok());
        drop(listener);
    }

    #[tokio::test]
    async fn live_legacy_daemon_without_lock_is_not_replaced() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let old_listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let _lock = SocketLock::acquire(&socket).unwrap();
        assert!(prepare_path(&socket).await.is_err());
        assert!(bind(&socket).await.is_err());
        assert!(UnixStream::connect(&socket).await.is_ok());
        drop(old_listener);
    }

    #[tokio::test]
    async fn late_bind_rechecks_for_legacy_daemon() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let _lock = SocketLock::acquire(&socket).unwrap();
        prepare_path(&socket).await.unwrap();
        let old_listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(bind(&socket).await.is_err());
        assert!(UnixStream::connect(&socket).await.is_ok());
        drop(old_listener);
    }

    #[tokio::test]
    async fn unsafe_socket_paths_are_never_removed() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let _lock = SocketLock::acquire(&socket).unwrap();
        fs::write(&socket, b"preserved").unwrap();
        assert!(prepare_path(&socket).await.is_err());
        assert_eq!(fs::read(&socket).unwrap(), b"preserved");
        fs::remove_file(&socket).unwrap();
        let target = dir.0.join("other");
        let _listener = UnixListener::bind(&target).unwrap();
        symlink(&target, &socket).unwrap();
        assert!(prepare_path(&socket).await.is_err());
        assert!(fs::symlink_metadata(&socket)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_file(&socket).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();
        drop(listener);
        assert!(prepare_path(&socket).await.is_err());
        assert!(fs::symlink_metadata(&socket)
            .unwrap()
            .file_type()
            .is_socket());
    }

    #[tokio::test]
    async fn parallel_startup_has_one_winner() {
        let dir = TestDir::new();
        let socket = dir.socket();
        let stale = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        drop(stale);
        let (first, second) = tokio::join!(
            async {
                let _lock = SocketLock::acquire(&socket)?;
                prepare_path(&socket).await?;
                assert!(!socket.exists()); // Not ready during backend setup.
                let _listener = bind(&socket).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok::<_, anyhow::Error>(())
            },
            async {
                let _lock = SocketLock::acquire(&socket)?;
                prepare_path(&socket).await?;
                assert!(!socket.exists());
                let _listener = bind(&socket).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok::<_, anyhow::Error>(())
            },
        );
        assert_ne!(first.is_ok(), second.is_ok());
    }
}
