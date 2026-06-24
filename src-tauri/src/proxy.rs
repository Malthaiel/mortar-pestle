//! Loopback-refusing forward proxy for the sandboxed in-app browser.
//!
//! The content WebView (`commands::browser`) routes ALL its network traffic
//! through this proxy via WebKit's `set_network_proxy_settings(Custom, …)`.
//! It is the real network boundary: WebKit's navigation policy handler only
//! sees top-level navigations, NOT `fetch`/XHR/subresource/WebSocket loads, so
//! the only place we can reliably stop a hostile page from reaching the media
//! server (`127.0.0.1:7878`), qBittorrent (`localhost:8080`), or any other
//! loopback / private-range service is here, on the wire.
//!
//! Policy (matches the feature's https-only navigation rule):
//!   * `CONNECT host:port`  → resolve `host`, refuse if ANY resolved IP is
//!     loopback / private / link-local / unspecified / multicast / ULA, else
//!     tunnel raw bytes (TLS passes through; we never see plaintext).
//!   * anything else (plain-HTTP forward requests) → refused. This is
//!     fail-closed and consistent with https-only: it also blocks
//!     `fetch('http://127.0.0.1:7878/…')`, which arrives as an absolute-form
//!     HTTP request, not a CONNECT.
//!
//! DNS-rebind defense: the host is resolved fresh on every connection (no
//! cache) and refused if any returned address is blocked — a host that
//! resolves to both a public and a loopback IP is refused outright.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::OnceLock;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpListener, TcpStream};

static PROXY_PORT: OnceLock<u16> = OnceLock::new();

/// The bound proxy port, once `run` has bound its listener.
pub fn port() -> Option<u16> {
    PROXY_PORT.get().copied()
}

/// True if the content view must never be allowed to reach this IP.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => {
            // Unwrap IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible forms so
            // a mapped loopback/private address can't sneak past the v6 checks.
            if let Some(v4) = v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()) {
                return is_blocked_v4(v4);
            }
            is_blocked_v6(v6)
        }
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()        // 127.0.0.0/8
        || ip.is_private()      // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()   // 169.254.0.0/16
        || ip.is_unspecified()  // 0.0.0.0
        || ip.is_broadcast()    // 255.255.255.255
        || ip.is_multicast()    // 224.0.0.0/4
        || ip.octets()[0] == 0 // 0.0.0.0/8 "this network"
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true; // ::1, ::, ff00::/8
    }
    let o = ip.octets();
    o[0] & 0xfe == 0xfc                       // unique-local fc00::/7
        || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80) // link-local fe80::/10
}

/// Literal-host checks applied before resolution (defense in depth; resolution
/// would catch these too, but we never want to even emit a `.local` mDNS query).
fn is_blocked_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local")
}

/// Split a CONNECT target (`host:port` or `[v6]:port`) into host and port.
fn split_host_port(s: &str) -> Option<(&str, u16)> {
    if let Some(rest) = s.strip_prefix('[') {
        let (h, p) = rest.split_once("]:")?;
        Some((h, p.parse().ok()?))
    } else {
        let (h, p) = s.rsplit_once(':')?;
        Some((h, p.parse().ok()?))
    }
}

/// Bind a kernel-assigned port on 127.0.0.1 and serve until exit. Mirrors
/// `media_server::run`: sets `port()` immediately after bind.
pub async fn run() -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0u16)).await?;
    let local = listener.local_addr()?;
    let _ = PROXY_PORT.set(local.port());
    log::info!("browser proxy listening on http://{local}");
    loop {
        match listener.accept().await {
            Ok((client, _)) => {
                tokio::spawn(async move {
                    if let Err(e) = handle(client).await {
                        log::debug!("browser proxy conn: {e}");
                    }
                });
            }
            Err(e) => log::debug!("browser proxy accept: {e}"),
        }
    }
}

async fn handle(mut client: TcpStream) -> std::io::Result<()> {
    // Read the request head (request line + headers) up to the CRLFCRLF
    // terminator. For CONNECT the client waits for our 200 before sending any
    // TLS bytes, so nothing is buffered past the terminator.
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        let n = client.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return refuse(&mut client, 431, "Request Header Fields Too Large").await;
        }
    }

    let head = String::from_utf8_lossy(&buf);
    let mut first = head.lines().next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("");
    let target = first.next().unwrap_or("");

    // https-only: refuse every non-CONNECT (plain-HTTP forward) request. This
    // is the path a `fetch('http://127.0.0.1:7878/…')` takes — refusing it is
    // the loopback block for plain HTTP.
    if !method.eq_ignore_ascii_case("CONNECT") {
        log::warn!("browser proxy refused {method} {target} (non-CONNECT)");
        return refuse(&mut client, 403, "Forbidden").await;
    }

    let Some((host, port)) = split_host_port(target) else {
        return refuse(&mut client, 400, "Bad Request").await;
    };
    if is_blocked_host(host) {
        log::warn!("browser proxy refused CONNECT {host}:{port} (blocked host)");
        return refuse(&mut client, 403, "Forbidden").await;
    }

    // Shield ad/tracker blocklist (gated by the global toggle): refuse known
    // ad/tracker hosts here, before DNS — no lookup for a host we'll drop.
    if crate::blocker::should_block_host(host) {
        log::debug!("browser proxy blocked ad/tracker host {host}:{port}");
        return refuse(&mut client, 403, "Forbidden").await;
    }

    // Resolve fresh every time; refuse if ANY resolved address is blocked.
    let addrs: Vec<SocketAddr> = match lookup_host((host, port)).await {
        Ok(it) => it.collect(),
        Err(_) => {
            log::debug!("browser proxy CONNECT {host}:{port} failed (DNS)");
            return refuse(&mut client, 502, "Bad Gateway").await;
        }
    };
    if addrs.is_empty() || addrs.iter().any(|a| is_blocked_ip(a.ip())) {
        log::warn!("browser proxy refused CONNECT {host}:{port} (blocked addr {addrs:?})");
        return refuse(&mut client, 403, "Forbidden").await;
    }

    let mut upstream = match TcpStream::connect(&addrs[..]).await {
        Ok(s) => s,
        Err(_) => return refuse(&mut client, 502, "Bad Gateway").await,
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

async fn refuse(client: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    let _ = client
        .write_all(
            format!("HTTP/1.1 {code} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                .as_bytes(),
        )
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_ipv4_loopback_and_private() {
        for s in [
            "127.0.0.1",
            "127.5.6.7",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
            "0.0.0.0",
            "0.1.2.3",
            "255.255.255.255",
            "224.0.0.1",
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",  // just below the 172.16/12 private block
            "172.32.0.1",  // just above it
            "203.0.113.7",
            "198.51.100.9",
        ] {
            assert!(!is_blocked_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn blocks_ipv6_loopback_link_local_ula_mapped() {
        for s in [
            "::1",
            "::",
            "fe80::1",
            "febf:ffff::1",
            "fc00::1",
            "fdff::1",
            "ff02::1",            // multicast
            "::ffff:127.0.0.1",   // IPv4-mapped loopback
            "::ffff:10.0.0.1",    // IPv4-mapped private
            "::ffff:169.254.0.1", // IPv4-mapped link-local
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv6() {
        for s in ["2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(!is_blocked_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn blocks_local_hostnames() {
        for h in ["localhost", "LocalHost", "foo.localhost", "printer.local", "host.local."] {
            assert!(is_blocked_host(h), "{h} should be blocked");
        }
        for h in ["example.com", "myanimelist.net", "localhostx.com", "local.example.com"] {
            assert!(!is_blocked_host(h), "{h} should be allowed");
        }
    }

    #[test]
    fn parses_host_port() {
        assert_eq!(split_host_port("example.com:443"), Some(("example.com", 443)));
        assert_eq!(split_host_port("[::1]:8080"), Some(("::1", 8080)));
        assert_eq!(split_host_port("127.0.0.1:7878"), Some(("127.0.0.1", 7878)));
        assert_eq!(split_host_port("noport"), None);
        assert_eq!(split_host_port("bad:port"), None);
    }
}
