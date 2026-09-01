fn main() {
    println!("cargo:rerun-if-changed=proto/data_processing.proto");
}
