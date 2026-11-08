// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! Active-session tracking via logind.
//!
//! Only the user who owns the active session on seat0 may subscribe, and
//! events go out only while that session is unlocked. Only sessions of
//! class "user" count: the GDM greeter (its own system user, active
//! between two sessions) gets nothing, so no process of it could read the
//! password typed at the login screen. logind lives on the
//! system bus and can be queried without privileges, so this also works
//! when the helper itself runs on the session bus for development.

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use zbus::message::Type;
use zbus::proxy;
use zbus::proxy::CacheProperties;
use zbus::{Connection, MatchRule, MessageStream, OwnedObjectPath, Result};

/// UID of the active, unlocked session's owner on seat0; None while locked
/// or without an active session. Events are only sent to this user.
pub type Receiver = Arc<Mutex<Option<u32>>>;

#[proxy(
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1/seat/seat0",
    interface = "org.freedesktop.login1.Seat"
)]
trait Seat {
    #[zbus(property)]
    fn active_session(&self) -> Result<(String, OwnedObjectPath)>;
}

#[proxy(
    default_service = "org.freedesktop.login1",
    interface = "org.freedesktop.login1.Session"
)]
trait Session {
    #[zbus(property)]
    fn user(&self) -> Result<(u32, OwnedObjectPath)>;

    #[zbus(property)]
    fn locked_hint(&self) -> Result<bool>;

    #[zbus(property)]
    fn class(&self) -> Result<String>;
}

/// The active session on seat0, if it belongs to a user (not a greeter,
/// lock-screen or background session).
struct Active {
    owner: u32,
    locked: bool,
}

/// True if `uid` owns the active user session on seat0, locked or not.
/// Any lookup failure counts as "no".
pub async fn owns_active(system: &Connection, uid: u32) -> bool {
    matches!(active(system).await, Ok(Some(Active { owner, .. })) if owner == uid)
}

/// Keeps `receiver` up to date: recomputed on every logind property change
/// (seat0's ActiveSession, a session's LockedHint, ...). Fresh queries
/// instead of parsing the changes, so a missed or reordered signal cannot
/// leave a stale state behind.
pub async fn watch(system: Connection, receiver: Receiver) -> Result<()> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.login1")
        .interface("org.freedesktop.DBus.Properties")
        .member("PropertiesChanged")
        .build()?;
    // Listen first, then read the initial state, so no change falls in between
    let mut changes = MessageStream::for_match_rule(rule, &system, None).await?;
    update(&system, &receiver).await;
    while changes.next().await.is_some() {
        update(&system, &receiver).await;
    }
    Ok(())
}

async fn update(system: &Connection, receiver: &Receiver) {
    let now = match active(system).await {
        Ok(Some(Active { owner, locked: false })) => Some(owner),
        _ => None,
    };
    let mut current = receiver.lock().unwrap();
    if *current != now {
        match now {
            Some(uid) => eprintln!("output on: active, unlocked session of uid {uid}"),
            None => eprintln!("output off: session locked, greeter or none active"),
        }
        *current = now;
    }
}

/// Owner and LockedHint of the active session on seat0; None if that is
/// not a user session.
async fn active(system: &Connection) -> Result<Option<Active>> {
    let seat = SeatProxy::builder(system).cache_properties(CacheProperties::No).build().await?;
    let (_, path) = seat.active_session().await?;
    let session = SessionProxy::builder(system)
        .path(path)
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    // "user-early": logind's class for sessions started before
    // systemd-user-sessions.service, e.g. root on a console
    if !matches!(session.class().await?.as_str(), "user" | "user-early") {
        return Ok(None);
    }
    let (owner, _) = session.user().await?;
    Ok(Some(Active {
        owner,
        locked: session.locked_hint().await?,
    }))
}
