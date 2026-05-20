mod agent;
mod config;
mod dispatch;
mod egress;
mod ingress;
mod telegram;

#[cfg(test)]
mod tests;

fn print_help() {
    println!(
        "\
muxclaw — channel-to-coding-agent bridge

Usage:
  muxclaw                     Show this help
  muxclaw help                Show this help
  muxclaw ingress             Start ingress (channel → queue)
  muxclaw egress              Start egress reactor (queue → channel, watches continuously)
  muxclaw dispatch <message>   Dispatch message to configured agent
  muxclaw dispatch --stdin     Read message from stdin
  muxclaw dispatch --id <chan>:<id> Read message from natural key store"
    );
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
        print_help();
        return Ok(());
    }

    // Ensure all required config/data directories exist
    config::ensure_dirs().await?;

    let command = args[0].to_lowercase();
    match command.as_str() {
        "ingress" => {
            ingress::ingress().await?;
        }
        "egress" => {
            egress::egress().await?;
        }
        "dispatch" => {
            let dispatch_args = args[1..].to_vec();
            dispatch::dispatch(&dispatch_args).await?;
        }
        _ => {
            eprintln!("Unknown command: {}", args[0]);
            print_help();
            std::process::exit(1);
        }
    }

    Ok(())
}
