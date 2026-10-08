#[tokio::main]
async fn main() {
    if let Err(error) = skerry_lib::native_ipc::run_native_ipc_service().await {
        eprintln!("skerry native service failed: {error}");
        std::process::exit(1);
    }
}
