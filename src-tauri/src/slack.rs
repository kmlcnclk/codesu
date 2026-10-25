//! Slack messages you react to, brought in as notes.
//!
//! The flow is deliberately pull-only: the user reacts to a message in Slack with a
//! chosen emoji, and the UI periodically asks `reactions.list` for the messages the
//! user has reacted to, keeping the ones with that emoji. No server, no public URL, no
//! WebSocket — the same "local credentials, nothing hosted" shape as the GitHub side.
//!
//! Two system tools do the heavy lifting so no HTTP or TLS crate is pulled in:
//!
//! - `/usr/bin/security` keeps the user token in the login Keychain. The token is fed
//!   to it on stdin (`security -i`), never in argv, so it can't be read from `ps`.
//! - `/usr/bin/curl` talks to the Slack Web API. The URL and the Authorization header go
//!   in a curl config read from stdin (`-K -`) — again keeping the token out of argv.
//!
//! The token is a USER token (`xoxp-…`): `reactions.list` reports the reactions of
//! whoever the token belongs to, so a bot token would only ever see the bot's own.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

const SECURITY: &str = "/usr/bin/security";
const CURL: &str = "/usr/bin/curl";
/// Keychain item the token lives under.
const KC_SERVICE: &str = "codesu.slack";
const KC_ACCOUNT: &str = "user-token";

/// Who the stored token belongs to, as `auth.test` reports it.
#[derive(Serialize, Clone, Debug)]
pub struct Account {
    pub team: String,
    pub user: String,
    pub user_id: String,
    /// The workspace URL, e.g. `https://acme.slack.com/` — used to build permalinks.
    pub url: String,
}

/// One reacted-to message, resolved into something a note can be made from.
#[derive(Serialize, Clone, Debug)]
pub struct SlackMessage {
    /// `<channel>:<ts>` — stable identity, used to import each message only once.
    pub key: String,
    /// Display name of whoever wrote the message.
    pub author: String,
    /// Where it was said: `#channel`, `DM with Ana`, or `Group DM`.
    pub place: String,
    /// The message text with Slack's `<@U…>` / `<#C…>` / `<url|label>` markup resolved
    /// into plain Markdown.
    pub text: String,
    pub permalink: String,
    /// When the message was posted, epoch ms.
    pub posted_at: i64,
}

/// Per-process lookups. Slack ids never change meaning, so names are fetched once.
#[derive(Default)]
struct Cache {
    account: Option<Account>,
    users: HashMap<String, String>,
    places: HashMap<String, String>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: std::sync::OnceLock<Mutex<Cache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

// ---------- Keychain ----------

/// A user token is `xoxp-` followed by digits, letters and dashes. Anything else is
/// refused before it gets near a command line or a config file.
fn valid_token(token: &str) -> bool {
    token.starts_with("xoxp-")
        && token.len() < 512
        && token[5..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn keychain_read() -> Option<String> {
    let out = Command::new(SECURITY)
        .args(["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    valid_token(&token).then_some(token)
}

fn keychain_write(token: &str) -> Result<(), String> {
    // `-U` updates an existing item in place. `security -i` reads commands from stdin
    // and exits 0 even when one fails, so success is judged by reading the item back.
    let line = format!("add-generic-password -U -s {KC_SERVICE} -a {KC_ACCOUNT} -w {token}\n");
    let mut child = Command::new(SECURITY)
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to run security: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("security has no stdin")?
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    match keychain_read() {
        Some(saved) if saved == token => Ok(()),
        _ => Err("Couldn't save the token to the Keychain.".into()),
    }
}

fn keychain_delete() {
    let _ = Command::new(SECURITY)
        .args(["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ---------- Web API ----------

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Call one Web API method and return its JSON body when Slack says `ok`.
fn api(token: &str, method: &str, params: &[(&str, &str)]) -> Result<Value, String> {
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    // Both values are safe inside curl's double-quoted config strings: the token was
    // checked by `valid_token`, and the query is percent-encoded.
    let config = format!(
        "url = \"https://slack.com/api/{method}?{query}\"\nheader = \"Authorization: Bearer {token}\"\n"
    );
    let mut child = Command::new(CURL)
        .args(["-sS", "--max-time", "20", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("curl has no stdin")?
        .write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("Couldn't reach Slack: {err}"));
    }
    let body: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| "Slack sent back something that isn't JSON.".to_string())?;
    if body["ok"].as_bool() == Some(true) {
        return Ok(body);
    }
    let code = body["error"].as_str().unwrap_or("unknown_error");
    Err(match code {
        "invalid_auth" | "not_authed" | "token_revoked" | "token_expired" | "account_inactive" => {
            "Slack rejected the token — reconnect Slack in Settings.".into()
        }
        "missing_scope" => format!(
            "The Slack token is missing a scope ({}). Add it to the app and reinstall.",
            body["needed"].as_str().unwrap_or("see the setup steps")
        ),
        "ratelimited" => "Slack is rate-limiting requests; will retry shortly.".into(),
        other => format!("Slack error: {other}"),
    })
}

fn auth_test(token: &str) -> Result<Account, String> {
    let body = api(token, "auth.test", &[])?;
    let s = |k: &str| body[k].as_str().unwrap_or_default().to_string();
    Ok(Account { team: s("team"), user: s("user"), user_id: s("user_id"), url: s("url") })
}

/// The stored token and the account it belongs to (cached after the first check).
fn session() -> Result<(String, Account), String> {
    let token = keychain_read().ok_or("Slack isn't connected.")?;
    if let Some(acc) = cache().lock().unwrap().account.clone() {
        return Ok((token, acc));
    }
    let acc = auth_test(&token)?;
    cache().lock().unwrap().account = Some(acc.clone());
    Ok((token, acc))
}

// ---------- Name resolution ----------

/// Messages `api` returns for failures worth retrying (see its error mapping).
const TRANSIENT: &[&str] = &["Couldn't reach Slack", "Slack is rate-limiting", "Slack sent back"];

/// Whether a failed name lookup should still be cached. Permanent failures (a missing
/// scope, a channel the user can't see) are, so they aren't retried on every poll;
/// transient ones aren't, so a blip doesn't pin a raw id for the rest of the session.
fn cache_failure(err: &str) -> bool {
    !TRANSIENT.iter().any(|t| err.starts_with(t))
}

fn user_name(token: &str, id: &str) -> String {
    if let Some(n) = cache().lock().unwrap().users.get(id) {
        return n.clone();
    }
    // A lookup failure (missing `users:read`, a deleted user) falls back to the raw id
    // rather than failing the whole import.
    let body = match api(token, "users.info", &[("user", id)]) {
        Ok(body) => body,
        Err(e) => {
            if cache_failure(&e) {
                cache().lock().unwrap().users.insert(id.to_string(), id.to_string());
            }
            return id.to_string();
        }
    };
    let u = &body["user"];
    let name = [&u["profile"]["display_name"], &u["profile"]["real_name"], &u["name"]]
        .iter()
        .filter_map(|v| v.as_str())
        .find(|s| !s.trim().is_empty())
        .unwrap_or(id)
        .to_string();
    cache().lock().unwrap().users.insert(id.to_string(), name.clone());
    name
}

fn place_name(token: &str, channel: &str) -> String {
    if let Some(n) = cache().lock().unwrap().places.get(channel) {
        return n.clone();
    }
    let body = match api(token, "conversations.info", &[("channel", channel)]) {
        Ok(body) => body,
        Err(e) => {
            if cache_failure(&e) {
                cache().lock().unwrap().places.insert(channel.to_string(), channel.to_string());
            }
            return channel.to_string();
        }
    };
    let c = &body["channel"];
    let name = if c["is_im"].as_bool() == Some(true) {
        let other = c["user"].as_str().unwrap_or_default();
        format!("DM with {}", user_name(token, other))
    } else if c["is_mpim"].as_bool() == Some(true) {
        "Group DM".to_string()
    } else {
        format!("#{}", c["name"].as_str().unwrap_or(channel))
    };
    cache().lock().unwrap().places.insert(channel.to_string(), name.clone());
    name
}

/// Turn Slack's message markup into Markdown: `<@U1>` → `@Ana`, `<#C1|general>` →
/// `#general`, `<https://x|label>` → `[label](https://x)`, `<!here>` → `@here`, and the
/// three HTML entities Slack escapes. Bold/italic markers are left alone — they read
/// fine either way.
fn to_markdown(token: &str, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let Some(len) = rest[open..].find('>') else {
            out.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let inner = &rest[open + 1..open + len];
        let (target, label) = match inner.split_once('|') {
            Some((t, l)) => (t, Some(l)),
            None => (inner, None),
        };
        let piece = if let Some(id) = target.strip_prefix('@') {
            format!("@{}", label.map(str::to_string).unwrap_or_else(|| user_name(token, id)))
        } else if let Some(id) = target.strip_prefix('#') {
            match label {
                Some(l) => format!("#{l}"),
                None => place_name(token, id),
            }
        } else if let Some(special) = target.strip_prefix('!') {
            // `<!here>`, `<!channel>`, `<!subteam^S1|@team>`, `<!date^…|fallback>`.
            match label {
                Some(l) => l.to_string(),
                None => format!("@{special}"),
            }
        } else {
            match label {
                Some(l) if l != target => format!("[{l}]({target})"),
                _ => target.to_string(),
            }
        };
        out.push_str(&piece);
        rest = &rest[open + len + 1..];
    }
    out.push_str(rest);
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// Link to a message. Slack usually includes one; otherwise build it the way Slack's
/// own "Copy link" does, keeping the thread so a reply opens in context.
fn permalink(acc: &Account, channel: &str, msg: &Value) -> String {
    if let Some(p) = msg["permalink"].as_str() {
        return p.to_string();
    }
    let ts = msg["ts"].as_str().unwrap_or_default();
    let mut link = format!("{}archives/{channel}/p{}", acc.url, ts.replace('.', ""));
    if let Some(thread) = msg["thread_ts"].as_str().filter(|t| *t != ts) {
        link.push_str(&format!("?thread_ts={thread}&cid={channel}"));
    }
    link
}

/// True when the user reacted to `msg` with `emoji` (any skin tone of it).
fn has_reaction(msg: &Value, emoji: &str, user_id: &str) -> bool {
    msg["reactions"].as_array().is_some_and(|rs| {
        rs.iter().any(|r| {
            let name = r["name"].as_str().unwrap_or_default();
            let base = name.split("::").next().unwrap_or(name);
            base == emoji
                && r["users"]
                    .as_array()
                    .is_some_and(|us| us.iter().any(|u| u.as_str() == Some(user_id)))
        })
    })
}

fn resolve(token: &str, acc: &Account, channel: &str, msg: &Value) -> SlackMessage {
    let ts = msg["ts"].as_str().unwrap_or_default();
    let author = match msg["user"].as_str() {
        Some(id) => user_name(token, id),
        None => msg["username"]
            .as_str()
            .or_else(|| msg["bot_profile"]["name"].as_str())
            .unwrap_or("Slack")
            .to_string(),
    };
    let mut text = to_markdown(token, msg["text"].as_str().unwrap_or_default());
    if let Some(files) = msg["files"].as_array().filter(|f| !f.is_empty()) {
        let list = files
            .iter()
            .map(|f| {
                let name = f["name"].as_str().or_else(|| f["title"].as_str()).unwrap_or("file");
                match f["permalink"].as_str() {
                    Some(url) => format!("- [{name}]({url})"),
                    None => format!("- {name}"),
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        text = format!("{}\n\nFiles:\n{list}", text.trim()).trim().to_string();
    }
    let posted_at = ts
        .split('.')
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .map_or(0, |secs| secs * 1000);
    SlackMessage {
        key: format!("{channel}:{ts}"),
        author,
        place: place_name(token, channel),
        text,
        permalink: permalink(acc, channel, msg),
        posted_at,
    }
}

// ---------- Commands ----------

/// Check `token`, make sure it can list reactions, then keep it in the Keychain.
pub fn connect(token: &str) -> Result<Account, String> {
    let token = token.trim();
    if token.starts_with("xoxb-") {
        return Err("That's a bot token (xoxb-). Codesu needs the User OAuth Token (xoxp-).".into());
    }
    if !valid_token(token) {
        return Err("That doesn't look like a Slack user token — it should start with xoxp-.".into());
    }
    let acc = auth_test(token)?;
    // Fail now, with the scope message, rather than on the first poll.
    api(token, "reactions.list", &[("limit", "1")])?;
    keychain_write(token)?;
    *cache().lock().unwrap() = Cache { account: Some(acc.clone()), ..Cache::default() };
    Ok(acc)
}

/// The connected account, or `None` when no token is stored.
pub fn account() -> Result<Option<Account>, String> {
    if keychain_read().is_none() {
        return Ok(None);
    }
    session().map(|(_, acc)| Some(acc))
}

pub fn disconnect() {
    keychain_delete();
    *cache().lock().unwrap() = Cache::default();
}

/// Messages the user has reacted to with `emoji`, newest reaction first.
pub fn poll(emoji: &str) -> Result<Vec<SlackMessage>, String> {
    let emoji = emoji.trim().trim_matches(':');
    if emoji.is_empty() {
        return Err("No emoji set.".into());
    }
    let (token, acc) = session()?;
    let body = api(&token, "reactions.list", &[("limit", "100"), ("full", "true")])?;
    let items = body["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .filter(|it| it["type"].as_str() == Some("message"))
        .filter_map(|it| Some((it["channel"].as_str()?, &it["message"])))
        .filter(|(_, msg)| has_reaction(msg, emoji, &acc.user_id))
        .map(|(channel, msg)| resolve(&token, &acc, channel, msg))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_without_lookups() {
        // Labelled forms need no API call, so they can be checked offline.
        let md = to_markdown(
            "xoxp-0",
            "hi <@U1|ana> in <#C1|general>: <https://x.dev|docs> &amp; <https://y.dev> <!subteam^S1|@devs>",
        );
        assert_eq!(md, "hi @ana in #general: [docs](https://x.dev) & https://y.dev @devs");
    }

    #[test]
    fn here_and_unclosed() {
        assert_eq!(to_markdown("xoxp-0", "<!here> a < b"), "@here a < b");
    }

    #[test]
    fn reaction_match_ignores_skin_tone_and_other_users() {
        let msg = serde_json::json!({ "reactions": [
            { "name": "memo::skin-tone-2", "users": ["U1"] },
            { "name": "eyes", "users": ["U2"] },
        ]});
        assert!(has_reaction(&msg, "memo", "U1"));
        assert!(!has_reaction(&msg, "memo", "U2"));
        assert!(!has_reaction(&msg, "eyes", "U1"));
    }

    #[test]
    fn built_permalink_keeps_thread() {
        let acc = Account {
            team: "t".into(),
            user: "u".into(),
            user_id: "U1".into(),
            url: "https://acme.slack.com/".into(),
        };
        let msg = serde_json::json!({ "ts": "1700000000.000200", "thread_ts": "1699999999.000100" });
        assert_eq!(
            permalink(&acc, "C1", &msg),
            "https://acme.slack.com/archives/C1/p1700000000000200?thread_ts=1699999999.000100&cid=C1"
        );
    }

    #[test]
    fn only_permanent_lookup_failures_are_cached() {
        assert!(cache_failure("The Slack token is missing a scope (users:read). Add it…"));
        assert!(cache_failure("Slack error: channel_not_found"));
        assert!(!cache_failure("Slack is rate-limiting requests; will retry shortly."));
        assert!(!cache_failure("Couldn't reach Slack: timeout"));
    }

    #[test]
    fn token_shape() {
        assert!(valid_token("xoxp-123-456-abc"));
        assert!(!valid_token("xoxb-123"));
        assert!(!valid_token("xoxp-12\" 3"));
    }
}
