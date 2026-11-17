use anyhow::{ensure, Context, Result};
use std::path::{Path, PathBuf};

pub fn executable() -> Result<PathBuf> {
    let path = std::env::current_exe()?;
    #[cfg(windows)]
    {
        // Browser/native-host and login-startup launchers cannot use verbatim paths.
        Ok(dunce::canonicalize(path)?)
    }
    #[cfg(not(windows))]
    {
        Ok(path.canonicalize()?)
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn registered_executable_is_compatible_with_windows_launchers() {
        let path = super::executable().unwrap();
        let manifest = serde_json::json!({ "path": path });
        let registered = manifest["path"].as_str().unwrap();
        assert!(std::path::Path::new(registered).is_absolute());
        assert!(!registered.starts_with(r"\\?\"));
    }
}

#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
}
impl Paths {
    pub fn discover() -> Result<Self> {
        Ok(Self {
            root: dirs::config_dir()
                .context("no user configuration directory")?
                .join("console-tty"),
        })
    }
    pub fn prepare(&self) -> Result<()> {
        directory(&self.root)
    }
    pub fn config(&self) -> PathBuf {
        self.root.join("config.toml")
    }
    pub fn endpoint(&self, admin: bool) -> String {
        use sha2::{Digest, Sha256};
        let id = hex::encode(Sha256::digest(self.root.to_string_lossy().as_bytes()));
        #[cfg(windows)]
        {
            format!(
                r"\\.\pipe\console-tty-{}{}",
                &id[..24],
                if admin { "-admin" } else { "" }
            )
        }
        #[cfg(unix)]
        {
            let _ = id;
            self.root
                .join(if admin { "admin.sock" } else { "daemon.sock" })
                .to_string_lossy()
                .into()
        }
    }
}

pub fn directory(path: &Path) -> Result<()> {
    if path.exists() {
        return check(path);
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    restrict(path)?;
    check(path)
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if path.exists() {
        check(path)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        restrict(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(windows)]
        if path.exists() {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<_> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            ensure!(
                unsafe {
                    MoveFileExW(
                        from.as_ptr(),
                        to.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } != 0,
                "atomic credential-state update failed"
            );
            return Ok(());
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

#[cfg(unix)]
pub fn restrict(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(if path.is_dir() { 0o700 } else { 0o600 }),
    )?;
    Ok(())
}
#[cfg(unix)]
pub fn check(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path)?;
    ensure!(!m.file_type().is_symlink() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0,
        "{} must be owned by this user, not a symlink, and inaccessible to group/other users (chmod 700 directory / 600 file)", path.display());
    Ok(())
}

#[cfg(windows)]
pub use windows::{check, ordinary, restrict, same_user_process, Descriptor};

#[cfg(unix)]
pub fn ordinary() -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "refusing to run terminal daemon as root"
    );
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{Authorization::*, *},
        System::Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    pub struct Descriptor(pub PSECURITY_DESCRIPTOR);
    pub fn same_user_process(pid: u32) -> Result<()> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            ensure!(!process.is_null(), "cannot verify local IPC server process");
            let mut token = ptr::null_mut();
            let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
            CloseHandle(process);
            ensure!(opened != 0, "cannot verify local IPC server user");
            let mut size = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
            let mut bytes = vec![0u8; size as usize];
            let ok =
                GetTokenInformation(token, TokenUser, bytes.as_mut_ptr() as _, size, &mut size);
            CloseHandle(token);
            ensure!(ok != 0, "cannot inspect local IPC server user");
            let expected = user()?;
            let actual_sid = (*(bytes.as_ptr() as *const TOKEN_USER)).User.Sid;
            let expected_sid = (*(expected.as_ptr() as *const TOKEN_USER)).User.Sid;
            ensure!(
                EqualSid(actual_sid, expected_sid) != 0,
                "refusing an IPC endpoint owned by a different user"
            );
        }
        Ok(())
    }
    pub fn ordinary() -> Result<()> {
        unsafe {
            let mut token = ptr::null_mut();
            ensure!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
                "cannot inspect process privileges"
            );
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut size = 0;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as _,
                std::mem::size_of_val(&elevation) as u32,
                &mut size,
            );
            CloseHandle(token);
            ensure!(
                ok != 0 && elevation.TokenIsElevated == 0,
                "run console-tty from a non-elevated user terminal, not Administrator/LocalSystem"
            );
        }
        Ok(())
    }
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0 as _);
            }
        }
    }
    fn user() -> Result<Vec<u8>> {
        unsafe {
            let mut token = ptr::null_mut();
            ensure!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
                "cannot inspect current user"
            );
            let mut size = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
            let mut bytes = vec![0u8; size as usize];
            let ok =
                GetTokenInformation(token, TokenUser, bytes.as_mut_ptr() as _, size, &mut size);
            CloseHandle(token);
            ensure!(ok != 0, "cannot read current user SID");
            Ok(bytes)
        }
    }
    impl Descriptor {
        pub fn new() -> Result<Self> {
            unsafe {
                let bytes = user()?;
                let sid = (*(bytes.as_ptr() as *const TOKEN_USER)).User.Sid;
                let mut text = ptr::null_mut();
                ensure!(
                    ConvertSidToStringSidW(sid, &mut text) != 0,
                    "cannot format user SID"
                );
                let mut len = 0;
                while *text.add(len) != 0 {
                    len += 1;
                }
                let sid_string = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
                LocalFree(text as _);
                let sddl: Vec<u16> = format!("D:P(A;OICI;GA;;;{sid_string})")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let mut descriptor = ptr::null_mut();
                ensure!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        ptr::null_mut()
                    ) != 0,
                    "cannot build private ACL"
                );
                Ok(Self(descriptor))
            }
        }
    }
    pub fn restrict(path: &Path) -> Result<()> {
        let descriptor = Descriptor::new()?;
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        ensure!(
            unsafe {
                SetFileSecurityW(
                    path.as_ptr(),
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    descriptor.0,
                )
            } != 0,
            "cannot set private file ACL"
        );
        Ok(())
    }
    pub fn check(path: &Path) -> Result<()> {
        ensure!(
            !std::fs::symlink_metadata(path)?.file_type().is_symlink(),
            "private path cannot be a symlink"
        );
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let mut owner = ptr::null_mut();
            let mut acl = ptr::null_mut();
            let mut raw = ptr::null_mut();
            ensure!(
                GetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut acl,
                    ptr::null_mut(),
                    &mut raw
                ) == 0,
                "cannot inspect private path ACL"
            );
            let _descriptor = Descriptor(raw);
            let bytes = user()?;
            let sid = (*(bytes.as_ptr() as *const TOKEN_USER)).User.Sid;
            ensure!(
                EqualSid(owner, sid) != 0 && !acl.is_null(),
                "{} must be owned by this user with a private ACL",
                path.display()
            );
            for i in 0..(*acl).AceCount {
                let mut ace: *mut c_void = ptr::null_mut();
                ensure!(GetAce(acl, i as u32, &mut ace) != 0, "cannot inspect ACE");
                let header = &*(ace as *const ACE_HEADER);
                ensure!(
                    header.AceType <= 1,
                    "{} has an unsupported ACL entry; use a current-user-only ACL",
                    path.display()
                );
                if header.AceType == 0 {
                    let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
                    ensure!(EqualSid(&allowed.SidStart as *const _ as _, sid) != 0,
                        "{} is accessible to another principal; restrict its ACL to the current user", path.display());
                }
            }
        }
        Ok(())
    }
}
