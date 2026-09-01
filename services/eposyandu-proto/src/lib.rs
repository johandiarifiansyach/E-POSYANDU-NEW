pub mod proto {
    pub mod platform {
        pub mod v1 {
            tonic::include_proto!("eposyandu.platform.v1");
        }
    }
}

pub mod data_processing {
    tonic::include_proto!("eposyandu.data_processing.v1");
}

pub mod analysis {
    tonic::include_proto!("eposyandu.analysis.v1");
}

pub mod transport {
    use std::{
        io,
        net::SocketAddr,
        path::{Path, PathBuf},
    };

    use tokio::net::UnixListener;

    #[derive(Debug)]
    pub enum ListenAddress {
        Tcp(SocketAddr),
        Unix(PathBuf),
    }

    /// Parse either a normal TCP socket address or tonic's `unix:` endpoint
    /// notation. This lets one binary run locally over UDS while retaining a
    /// TCP configuration for services on another host/platform.
    pub fn parse_listen_address(
        value: &str,
        default: &str,
        name: &str,
    ) -> Result<ListenAddress, io::Error> {
        let value = if value.trim().is_empty() {
            default
        } else {
            value.trim()
        };
        if let Some(path) = value
            .strip_prefix("unix://")
            .or_else(|| value.strip_prefix("unix:"))
        {
            let path = PathBuf::from(path);
            if !path.is_absolute() || path.as_os_str().is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{name} UDS harus berupa path absolut."),
                ));
            }
            return Ok(ListenAddress::Unix(path));
        }
        value.parse().map(ListenAddress::Tcp).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{name} harus berupa alamat TCP atau unix:///path.sock: {error}"),
            )
        })
    }

    pub fn bind_unix(path: &Path) -> Result<UnixListener, io::Error> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        if path.exists() {
            let metadata = std::fs::symlink_metadata(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                if !metadata.file_type().is_socket() {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!("Path UDS {} bukan socket.", path.display()),
                    ));
                }
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
        }
        Ok(listener)
    }
}

#[cfg(test)]
mod transport_tests {
    use super::transport::{ListenAddress, parse_listen_address};

    #[test]
    fn accepts_uds_and_tcp_listeners() {
        assert!(matches!(
            parse_listen_address(
                "unix:///run/e-posyandu/identity.sock",
                "127.0.0.1:50052",
                "IDENTITY_GRPC_ADDR"
            )
            .expect("valid UDS"),
            ListenAddress::Unix(_)
        ));
        assert!(matches!(
            parse_listen_address("127.0.0.1:50052", "unused", "IDENTITY_GRPC_ADDR")
                .expect("valid TCP"),
            ListenAddress::Tcp(_)
        ));
        assert!(parse_listen_address("unix://relative.sock", "unused", "ADDR").is_err());
    }
}
