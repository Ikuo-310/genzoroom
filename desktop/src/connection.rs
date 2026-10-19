use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::{fs::File, io::Read, path::PathBuf, time::Duration};
use tauri::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    version: u8,
    pub port: u16,
    bootstrap_token: String,
    probe_key: String,
    #[serde(default)]
    pub launch_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    version: u8,
    proof: String,
}

pub fn user_root() -> Result<PathBuf, &'static str> {
    let base =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("local_user_directory_missing")?);
    if !base.is_absolute() || base.to_string_lossy().starts_with(r"\\") {
        return Err("local_user_directory_invalid");
    }
    let root = base.join("GenzoRoom");
    Ok(if cfg!(feature = "bundled-backend") {
        root
    } else {
        root.join("WindowsPoC")
    })
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| "handoff_read_failed")?;
    if bytes.len() > 16_384 {
        return Err("handoff_too_large");
    }
    Ok(bytes)
}

#[cfg(windows)]
fn decrypt(encrypted: &mut [u8]) -> Result<Vec<u8>, &'static str> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI checks both the current Windows user and encrypted-payload integrity.
    unsafe {
        if CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        ) == 0
        {
            return Err("handoff_decryption_failed");
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn decrypt(_encrypted: &mut [u8]) -> Result<Vec<u8>, &'static str> {
    Err("windows_required")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("invalid_identity_proof");
    }
    (0..64)
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| "invalid_identity_proof")
        })
        .collect()
}

impl Connection {
    pub fn load() -> Result<Self, &'static str> {
        let file = File::open(user_root()?.join("desktop-session.dpapi"))
            .map_err(|_| "start_backend_with_desktop_first")?;
        let mut encrypted = read_bounded(file)?;
        let plaintext = decrypt(&mut encrypted)?;
        let connection: Self = serde_json::from_slice(&plaintext).map_err(|_| "handoff_invalid")?;
        connection.validate()?;
        Ok(connection)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.port < 1024
            || self.bootstrap_token.len() != 43
            || !self
                .bootstrap_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || decode_hex(&self.probe_key).is_err()
            || self
                .launch_id
                .as_ref()
                .is_some_and(|value| decode_hex(value).is_err())
        {
            return Err("handoff_invalid");
        }
        Ok(())
    }

    pub fn verify_backend(&self) -> Result<(), &'static str> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "challenge_generation_failed")?;
        let challenge = hex(&random);
        // No proxy, redirect or credentials: a wrong listener must not receive the bootstrap token.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| "backend_probe_failed")?;
        let response = client
            .get(format!(
                "http://127.0.0.1:{}/__local/desktop-ready",
                self.port
            ))
            .query(&[("challenge", &challenge)])
            .send()
            .map_err(|_| "backend_not_ready")?;
        if !response.status().is_success() {
            return Err("backend_not_ready_or_session_used");
        }
        let bytes = read_bounded(response)?;
        let proof: Proof =
            serde_json::from_slice(&bytes).map_err(|_| "backend_identity_mismatch")?;
        self.verify_proof(&challenge, proof)
    }

    fn verify_proof(&self, challenge: &str, proof: Proof) -> Result<(), &'static str> {
        let key = decode_hex(&self.probe_key)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "handoff_invalid")?;
        mac.update(b"GenzoRoom desktop probe v1:");
        mac.update(challenge.as_bytes());
        if proof.version != 1 || mac.verify_slice(&decode_hex(&proof.proof)?).is_err() {
            return Err("backend_identity_mismatch");
        }
        Ok(())
    }

    pub fn bootstrap_url(&self) -> Url {
        // Validation fixes host/path; only the original in-WebView exchange sets the session cookie.
        let mut url =
            Url::parse(&format!("http://127.0.0.1:{}/__local/bootstrap", self.port)).unwrap();
        url.set_fragment(Some(&self.bootstrap_token));
        url
    }
}

pub fn allowed_navigation(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        Connection {
            version: 1,
            port: 3191,
            bootstrap_token: "x".repeat(43),
            probe_key: "01".repeat(32),
            launch_id: None,
        }
    }

    #[test]
    fn restricts_navigation_to_exact_backend() {
        for value in [
            "https://127.0.0.1:3191/",
            "http://localhost:3191/",
            "http://127.0.0.1:3192/",
            "http://user@127.0.0.1:3191/",
            "http://evil.example/",
            "file:///C:/photo.jpg",
        ] {
            assert!(!allowed_navigation(&Url::parse(value).unwrap(), 3191));
        }
        assert!(allowed_navigation(
            &Url::parse("http://127.0.0.1:3191/developer").unwrap(),
            3191
        ));
    }

    #[test]
    fn accepts_only_current_instance_proof() {
        let connection = connection();
        let challenge = "02".repeat(32);
        let mut mac = Hmac::<Sha256>::new_from_slice(&[1; 32]).unwrap();
        mac.update(b"GenzoRoom desktop probe v1:");
        mac.update(challenge.as_bytes());
        let proof = hex(&mac.finalize().into_bytes());
        assert!(connection
            .verify_proof(
                &challenge,
                Proof {
                    version: 1,
                    proof: proof.clone()
                }
            )
            .is_ok());
        assert!(connection
            .verify_proof(&"03".repeat(32), Proof { version: 1, proof })
            .is_err());
        assert!(connection
            .verify_proof(
                &challenge,
                Proof {
                    version: 1,
                    proof: "00".repeat(32)
                }
            )
            .is_err());
    }

    #[test]
    fn validates_handoff_before_building_url() {
        let mut connection = connection();
        assert!(connection.validate().is_ok());
        assert_eq!(connection.bootstrap_url().path(), "/__local/bootstrap");
        connection.bootstrap_token = "unsafe#token".into();
        assert!(connection.validate().is_err());
        connection.bootstrap_token = "x".repeat(43);
        connection.port = 80;
        assert!(connection.validate().is_err());
    }

    #[test]
    fn bounds_untrusted_files_and_responses() {
        assert!(read_bounded(&[0u8; 16_385][..]).is_err());
        assert!(read_bounded(&[0u8; 16_384][..]).is_ok());
        assert!(decode_hex(&"é".repeat(32)).is_err());
    }

    #[test]
    fn rejects_wrong_listener_and_redirect_without_disclosing_credentials() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let body = format!(r#"{{"version":1,"proof":"{}"}}"#, "00".repeat(32));
        for (response, expected_error) in [
            (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()), "backend_identity_mismatch"),
            ("HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(), "backend_not_ready_or_session_used"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut connection = connection();
            connection.port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = [0u8; 4096];
                let length = stream.read(&mut request).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
                String::from_utf8_lossy(&request[..length]).to_string()
            });
            assert_eq!(connection.verify_backend(), Err(expected_error));
            let request = server.join().unwrap();
            assert!(request.contains("/__local/desktop-ready?challenge="));
            assert!(!request.contains(&connection.bootstrap_token));
            assert!(!request.contains(&connection.probe_key));
        }
    }
}
