use anyhow::Result;
use tokio::io::{AsyncRead, AsyncWrite};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Connection = Box<dyn Stream>;

#[cfg(windows)]
pub struct Listener {
    name: String,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}
#[cfg(windows)]
fn pipe(name: &str, first: bool) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let descriptor = crate::private::Descriptor::new()?;
    let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    Ok(unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(name, &attributes as *const _ as _)
    }?)
}
#[cfg(windows)]
impl Listener {
    pub fn bind(name: &str) -> Result<Self> {
        Ok(Self {
            name: name.into(),
            next: pipe(name, true)?,
        })
    }
    pub async fn accept(&mut self) -> Result<Connection> {
        self.next.connect().await?;
        let next = pipe(&self.name, false)?;
        Ok(Box::new(std::mem::replace(&mut self.next, next)))
    }
}
#[cfg(windows)]
pub async fn connect(name: &str) -> Result<Connection> {
    for _ in 0..100 {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
            Ok(pipe) => {
                use std::os::windows::io::AsRawHandle;
                let mut pid = 0;
                anyhow::ensure!(
                    unsafe {
                        windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(
                            pipe.as_raw_handle(),
                            &mut pid,
                        )
                    } != 0,
                    "cannot verify named-pipe server identity"
                );
                crate::private::same_user_process(pid)?;
                return Ok(Box::new(pipe));
            }
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await
            }
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("daemon pipe busy")
}

#[cfg(unix)]
pub struct Listener {
    listener: tokio::net::UnixListener,
    path: String,
}
#[cfg(unix)]
impl Listener {
    pub fn bind(name: &str) -> Result<Self> {
        if std::path::Path::new(name).exists() {
            crate::private::check(std::path::Path::new(name))?;
            anyhow::ensure!(
                std::os::unix::net::UnixStream::connect(name).is_err(),
                "daemon already running"
            );
            std::fs::remove_file(name)?;
        }
        let listener = tokio::net::UnixListener::bind(name)?;
        crate::private::restrict(std::path::Path::new(name))?;
        Ok(Self {
            listener,
            path: name.into(),
        })
    }
    pub async fn accept(&mut self) -> Result<Connection> {
        let (stream, _) = self.listener.accept().await?;
        Ok(Box::new(stream))
    }
}
#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[cfg(unix)]
pub async fn connect(name: &str) -> Result<Connection> {
    crate::private::check(std::path::Path::new(name))?;
    Ok(Box::new(tokio::net::UnixStream::connect(name).await?))
}

pub async fn call(
    connection: &mut Connection,
    kind: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    use anyhow::Context;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let request = crate::protocol::Request::new(kind, params);
        crate::protocol::write(connection, &request).await?;
        let reply: crate::protocol::Response = crate::protocol::read(connection).await?;
        anyhow::ensure!(
            reply.request_id == request.request_id && reply.version == crate::protocol::VERSION,
            "protocol response mismatch"
        );
        reply.value()
    })
    .await
    .context("daemon request timed out")?
}
