fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    unsafe {
        std::env::set_var("PROTOC", protoc);
    }
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(
            &[
                "../data-processing-service/proto/data_processing.proto",
                "../analysis-service/proto/analysis.proto",
                "proto/microservices.proto",
            ],
            &[
                "../data-processing-service/proto",
                "../analysis-service/proto",
                "proto",
            ],
        )?;
    println!("cargo:rerun-if-changed=../data-processing-service/proto/data_processing.proto");
    println!("cargo:rerun-if-changed=../analysis-service/proto/analysis.proto");
    println!("cargo:rerun-if-changed=proto/microservices.proto");
    Ok(())
}
