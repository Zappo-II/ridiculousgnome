// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! Spike check for unicast signals: listens for the helper's `Key` signal
//! with a plain match rule, optionally after calling `Subscribe`.
//!
//! Usage: cargo run --example listen -- [--system] [--subscribe]
//! A listener without --subscribe must receive nothing.

use futures_util::StreamExt;
use zbus::{Connection, MessageStream};

const NAME: &str = "io.github.zappoii.RidiculousGnome.Helper";
const PATH: &str = "/io/github/zappoii/RidiculousGnome/Helper";

fn main() -> zbus::Result<()> {
    zbus::block_on(run())
}

async fn run() -> zbus::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let connection = if args.iter().any(|a| a == "--system") {
        Connection::system().await?
    } else {
        Connection::session().await?
    };
    let subscribe = args.iter().any(|a| a == "--subscribe");

    let rule = format!("type='signal',interface='{NAME}',member='Key'");
    let mut stream = MessageStream::for_match_rule(rule.as_str(), &connection, None).await?;

    if subscribe {
        connection.call_method(Some(NAME), PATH, Some(NAME), "Subscribe", &()).await?;
    }
    println!("listening (subscribed: {subscribe})");

    while let Some(message) = stream.next().await {
        let message = message?;
        let (pressed, label): (bool, String) = message.body().deserialize()?;
        println!("Key {} {label}", if pressed { "down" } else { "up" });
    }
    Ok(())
}
