fn main() {
    println!("cargo:rerun-if-changed=proto/nutrition.proto");
    println!("cargo:rerun-if-changed=data/anthropometry.json");
}
