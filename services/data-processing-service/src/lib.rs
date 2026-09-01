use chrono::NaiveDate;
use rust_xlsxwriter::Workbook;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use tonic::{
    Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
};

pub use e_posyandu_proto::data_processing as proto;

pub const GRPC_SERVICE_TOKEN_HEADER: &str = "x-eposyandu-service-token";

#[derive(Clone)]
pub struct ServiceAuthInterceptor {
    token: Option<MetadataValue<Ascii>>,
    required: bool,
}

impl Interceptor for ServiceAuthInterceptor {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let Some(expected) = &self.token else {
            return if self.required {
                Err(Status::failed_precondition(
                    "Secret service gRPC belum dikonfigurasi.",
                ))
            } else {
                Ok(request)
            };
        };
        let supplied = request
            .metadata()
            .get(GRPC_SERVICE_TOKEN_HEADER)
            .ok_or_else(|| Status::unauthenticated("Token service gRPC tidak ditemukan."))?;
        if supplied != expected {
            return Err(Status::unauthenticated("Token service gRPC tidak valid."));
        }
        Ok(request)
    }
}

pub fn service_auth_interceptor(required: bool) -> Result<ServiceAuthInterceptor, String> {
    let value = std::env::var("RUST_WORKER_SHARED_SECRET")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let token = value
        .map(|value| {
            value
                .parse()
                .map_err(|_| "Secret service gRPC harus berupa metadata ASCII.")
        })
        .transpose()?;
    Ok(ServiceAuthInterceptor { token, required })
}

mod analysis_client;
pub mod queue_consumer;

use analysis_client::AnalysisGrpcClient;

use proto::data_processing_worker_server::DataProcessingWorker;
use proto::{
    ExportRow, ImportRow, NormalizeSyncBatchRequest, NormalizeSyncBatchResponse,
    PrepareExportRequest, PrepareExportResponse, ProcessJobRequest, ProcessJobResponse, SyncRecord,
    ValidateImportRequest, ValidateImportResponse, ValidationIssue,
};

const MAX_BATCH_ITEMS: usize = 10_000;
const MAX_EXPORT_ROWS: usize = 100_000;
const MAX_EXPORT_COLUMNS: usize = 128;
fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()
}

fn months_between(birth: NaiveDate, measured: NaiveDate) -> i32 {
    use chrono::Datelike;
    let mut months =
        (measured.year() - birth.year()) * 12 + measured.month() as i32 - birth.month() as i32;
    if measured.day() < birth.day() {
        months -= 1;
    }
    months
}

fn normalized_sex(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "l" | "laki-laki" | "laki laki" | "male" => Some("L"),
        "p" | "perempuan" | "female" => Some("P"),
        _ => None,
    }
}

fn issue(row_number: u64, field: &str, code: &str, message: &str) -> ValidationIssue {
    ValidationIssue {
        row_number,
        field: field.into(),
        code: code.into(),
        message: message.into(),
        severity: "error".into(),
    }
}

pub fn validate_import_rows(
    rows: &[ImportRow],
    existing_niks: &[String],
) -> Result<ValidateImportResponse, Status> {
    if rows.len() > MAX_BATCH_ITEMS {
        return Err(Status::resource_exhausted(
            "Jumlah baris impor melebihi batas 10.000 per batch.",
        ));
    }
    let existing = existing_niks
        .iter()
        .map(|nik| nik.trim().to_owned())
        .filter(|nik| !nik.is_empty())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut invalid_rows = HashSet::new();
    let mut duplicate_rows = HashSet::new();
    let mut issues = Vec::new();

    for (index, row) in rows.iter().enumerate() {
        let row_number = if row.row_number == 0 {
            index as u64 + 2
        } else {
            row.row_number
        };
        let nik = row.nik.trim();
        if !nik.is_empty() && (nik.len() != 16 || !nik.bytes().all(|byte| byte.is_ascii_digit())) {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "nik",
                "invalid_nik",
                "NIK harus terdiri dari 16 angka.",
            ));
        }
        if !nik.is_empty() && (!seen.insert(nik.to_owned()) || existing.contains(nik)) {
            invalid_rows.insert(row_number);
            duplicate_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "nik",
                "duplicate_nik",
                "NIK sudah ada pada file atau database.",
            ));
        }
        let birth_date = parse_date(&row.birth_date);
        if birth_date.is_none() {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "birthDate",
                "invalid_date",
                "Tanggal lahir harus memakai format YYYY-MM-DD.",
            ));
        }
        let measurement_date = row
            .measurement_date
            .as_deref()
            .filter(|date| !date.trim().is_empty())
            .and_then(parse_date);
        if row
            .measurement_date
            .as_deref()
            .is_some_and(|date| !date.trim().is_empty())
            && measurement_date.is_none()
        {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "measurementDate",
                "invalid_date",
                "Tanggal pengukuran harus memakai format YYYY-MM-DD.",
            ));
        }
        if let (Some(birth), Some(measured)) = (birth_date, measurement_date) {
            let age = months_between(birth, measured);
            if !(0..=59).contains(&age) {
                invalid_rows.insert(row_number);
                issues.push(issue(
                    row_number,
                    "ageMonths",
                    "age_out_of_range",
                    "Usia saat pengukuran harus antara 0 dan 59 bulan.",
                ));
            }
            if let Some(supplied_age) = row.age_months
                && supplied_age != age
            {
                invalid_rows.insert(row_number);
                issues.push(issue(
                    row_number,
                    "ageMonths",
                    "age_mismatch",
                    "Usia tidak sesuai dengan tanggal lahir dan tanggal pengukuran.",
                ));
            }
        } else if let Some(age) = row.age_months
            && !(0..=59).contains(&age)
        {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "ageMonths",
                "age_out_of_range",
                "Usia harus antara 0 dan 59 bulan.",
            ));
        }
        if normalized_sex(&row.sex).is_none() {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "sex",
                "invalid_sex",
                "Jenis kelamin harus L atau P.",
            ));
        }
        if let Some(weight) = row.weight_kg
            && (!weight.is_finite() || !(0.1..=60.0).contains(&weight))
        {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "weightKg",
                "invalid_weight",
                "Berat badan harus dalam kilogram antara 0,1 dan 60 kg.",
            ));
        }
        if let Some(height) = row.height_cm
            && (!height.is_finite() || !(10.0..=220.0).contains(&height))
        {
            invalid_rows.insert(row_number);
            issues.push(issue(
                row_number,
                "heightCm",
                "invalid_height",
                "Panjang atau tinggi badan harus antara 10 dan 220 cm.",
            ));
        }
    }

    Ok(ValidateImportResponse {
        total_rows: rows.len() as u64,
        valid_rows: rows.len().saturating_sub(invalid_rows.len()) as u64,
        invalid_rows: invalid_rows.len() as u64,
        duplicate_rows: duplicate_rows.len() as u64,
        issues,
    })
}

fn sanitize_filename(filename: &str, extension: &str) -> String {
    let stem = filename
        .trim()
        .trim_end_matches(".xlsx")
        .trim_end_matches(".pdf")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let stem = stem.trim_matches('_');
    format!(
        "{}.{}",
        if stem.is_empty() { "laporan" } else { stem },
        extension
    )
}

fn create_xlsx(request: &PrepareExportRequest) -> Result<Vec<u8>, Status> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name("Laporan")
        .map_err(|_| Status::invalid_argument("Nama sheet ekspor tidak valid."))?;
    for (column, value) in request.columns.iter().enumerate() {
        worksheet
            .write_string(0, column as u16, value)
            .map_err(|_| Status::internal("Header Excel tidak dapat ditulis."))?;
    }
    for (row_index, row) in request.rows.iter().enumerate() {
        for (column, value) in row.cells.iter().enumerate() {
            worksheet
                .write_string((row_index + 1) as u32, column as u16, value)
                .map_err(|_| Status::internal("Isi Excel tidak dapat ditulis."))?;
        }
    }
    workbook
        .save_to_buffer()
        .map_err(|_| Status::internal("File Excel tidak dapat dibuat."))
}

fn pdf_escape(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '(' => "\\(".into(),
            ')' => "\\)".into(),
            '\\' => "\\\\".into(),
            value if value.is_ascii() && !value.is_control() => value.to_string(),
            _ => "?".into(),
        })
        .collect()
}

fn pdf_lines(request: &PrepareExportRequest) -> Vec<String> {
    let mut lines = vec![request.title.trim().to_owned()];
    lines.push(request.columns.join(" | "));
    lines.push("-".repeat(108));
    lines.extend(request.rows.iter().map(|row| row.cells.join(" | ")));
    lines
        .into_iter()
        .map(|line| {
            if line.chars().count() > 112 {
                line.chars().take(109).collect::<String>() + "..."
            } else {
                line
            }
        })
        .collect()
}

fn create_pdf(request: &PrepareExportRequest) -> Vec<u8> {
    let lines = pdf_lines(request);
    let pages = lines.chunks(52).collect::<Vec<_>>();
    let mut objects = Vec::<(usize, Vec<u8>)>::new();
    objects.push((1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()));
    let kids = (0..pages.len())
        .map(|index| format!("{} 0 R", 4 + index * 2))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push((
        2,
        format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()).into_bytes(),
    ));
    objects.push((
        3,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
    ));
    for (index, page_lines) in pages.iter().enumerate() {
        let page_id = 4 + index * 2;
        let content_id = page_id + 1;
        objects.push((
            page_id,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        ));
        let mut content = String::from("BT /F1 8 Tf 28 810 Td 10 TL\n");
        for line in *page_lines {
            content.push_str(&format!("({}) Tj T*\n", pdf_escape(line)));
        }
        content.push_str("ET");
        objects.push((
            content_id,
            format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                content.len(),
                content
            )
            .into_bytes(),
        ));
    }
    objects.sort_by_key(|(id, _)| *id);
    let max_id = objects.last().map(|(id, _)| *id).unwrap_or(0);
    let mut output = b"%PDF-1.4\n% E-Posyandu\n".to_vec();
    let mut offsets = vec![0usize; max_id + 1];
    for (id, object) in objects {
        offsets[id] = output.len();
        output.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        output.extend_from_slice(&object);
        output.extend_from_slice(b"\nendobj\n");
    }
    let xref = output.len();
    output.extend_from_slice(format!("xref\n0 {}\n", max_id + 1).as_bytes());
    output.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets.iter().skip(1) {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            max_id + 1
        )
        .as_bytes(),
    );
    output
}

pub fn prepare_export(request: &PrepareExportRequest) -> Result<PrepareExportResponse, Status> {
    if request.rows.len() > MAX_EXPORT_ROWS {
        return Err(Status::resource_exhausted(
            "Jumlah baris ekspor melebihi batas 100.000.",
        ));
    }
    if request.columns.is_empty() || request.columns.len() > MAX_EXPORT_COLUMNS {
        return Err(Status::invalid_argument(
            "Jumlah kolom ekspor harus antara 1 dan 128.",
        ));
    }
    if request
        .rows
        .iter()
        .any(|row| row.cells.len() != request.columns.len())
    {
        return Err(Status::invalid_argument(
            "Jumlah sel setiap baris harus sama dengan jumlah kolom.",
        ));
    }
    let format = request.format.trim().to_ascii_lowercase();
    let (content, content_type, filename) = match format.as_str() {
        "xlsx" | "excel" => (
            create_xlsx(request)?,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_owned(),
            sanitize_filename(&request.filename, "xlsx"),
        ),
        "pdf" => (
            create_pdf(request),
            "application/pdf".to_owned(),
            sanitize_filename(&request.filename, "pdf"),
        ),
        _ => {
            return Err(Status::invalid_argument(
                "Format ekspor harus xlsx atau pdf.",
            ));
        }
    };
    let sha256 = hex::encode(Sha256::digest(&content));
    Ok(PrepareExportResponse {
        content,
        content_type,
        filename,
        sha256,
        row_count: request.rows.len() as u64,
    })
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

pub fn normalize_sync_batch(records: &[SyncRecord]) -> Result<NormalizeSyncBatchResponse, Status> {
    if records.len() > MAX_BATCH_ITEMS {
        return Err(Status::resource_exhausted(
            "Jumlah data sinkronisasi melebihi batas 10.000.",
        ));
    }
    let supported_resources = [
        "children",
        "measurements",
        "mpasi_logs",
        "pmt_programs",
        "change_logs",
    ];
    let mut accepted = Vec::new();
    let mut issues = Vec::new();
    let mut idempotency_keys = HashSet::new();
    for (index, record) in records.iter().enumerate() {
        let row_number = index as u64 + 1;
        let resource = record.resource.trim().to_ascii_lowercase();
        let operation = match record.operation.trim().to_ascii_lowercase().as_str() {
            "add" | "create" | "insert" => "create",
            "update" | "patch" => "update",
            "delete" | "remove" => "delete",
            _ => "",
        };
        let mut valid = true;
        if !supported_resources.contains(&resource.as_str()) {
            issues.push(issue(
                row_number,
                "resource",
                "unsupported_resource",
                "Jenis data sinkronisasi tidak didukung.",
            ));
            valid = false;
        }
        if operation.is_empty() {
            issues.push(issue(
                row_number,
                "operation",
                "unsupported_operation",
                "Operasi sinkronisasi tidak didukung.",
            ));
            valid = false;
        }
        if record.document_id.trim().is_empty() || record.document_id.len() > 128 {
            issues.push(issue(
                row_number,
                "documentId",
                "invalid_document_id",
                "ID dokumen sinkronisasi tidak valid.",
            ));
            valid = false;
        }
        if !valid_idempotency_key(record.idempotency_key.trim())
            || !idempotency_keys.insert(record.idempotency_key.trim().to_owned())
        {
            issues.push(issue(
                row_number,
                "idempotencyKey",
                "invalid_idempotency_key",
                "Kunci idempotensi kosong, tidak valid, atau berulang.",
            ));
            valid = false;
        }
        let payload = serde_json::from_str::<Value>(&record.payload_json).ok();
        if operation != "delete" && !payload.as_ref().is_some_and(Value::is_object) {
            issues.push(issue(
                row_number,
                "payloadJson",
                "invalid_payload",
                "Payload sinkronisasi harus berupa objek JSON.",
            ));
            valid = false;
        }
        if valid {
            accepted.push(SyncRecord {
                resource,
                operation: operation.into(),
                document_id: record.document_id.trim().into(),
                idempotency_key: record.idempotency_key.trim().into(),
                version: record.version,
                payload_json: payload
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "{}".into()),
            });
        }
    }
    Ok(NormalizeSyncBatchResponse {
        accepted: accepted.len() as u64,
        rejected: records.len().saturating_sub(accepted.len()) as u64,
        records: accepted,
        issues,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportJobPayload {
    #[serde(default)]
    rows: Vec<ImportJobRow>,
    #[serde(default)]
    existing_niks: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportJobRow {
    #[serde(default)]
    row_number: u64,
    #[serde(default)]
    record_id: String,
    #[serde(default)]
    nik: String,
    #[serde(default)]
    birth_date: String,
    measurement_date: Option<String>,
    weight_kg: Option<f64>,
    height_cm: Option<f64>,
    age_months: Option<i32>,
    #[serde(default)]
    sex: String,
    measurement_method: Option<String>,
    #[serde(default)]
    village: String,
    #[serde(default)]
    posyandu: String,
}

impl From<ImportJobRow> for ImportRow {
    fn from(value: ImportJobRow) -> Self {
        Self {
            row_number: value.row_number,
            record_id: value.record_id,
            nik: value.nik,
            birth_date: value.birth_date,
            measurement_date: value.measurement_date,
            weight_kg: value.weight_kg,
            height_cm: value.height_cm,
            age_months: value.age_months,
            sex: value.sex,
            measurement_method: value.measurement_method,
            village: value.village,
            posyandu: value.posyandu,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NutritionJobPayload {
    #[serde(default)]
    items: Vec<NutritionJobItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NutritionJobItem {
    weight_kg: f64,
    height_cm: Option<f64>,
    #[serde(alias = "lila")]
    lila_cm: Option<f64>,
    #[serde(alias = "lk")]
    head_circumference_cm: Option<f64>,
    age_months: i32,
    sex: String,
    measurement_method: Option<String>,
    #[serde(default)]
    measurement_date: Option<String>,
    #[serde(default)]
    history: Vec<serde_json::Value>,
    #[serde(default, alias = "asi")]
    exclusive_breastfeeding: Option<String>,
    #[serde(default)]
    row_number: u64,
    #[serde(default)]
    record_id: String,
    #[serde(default)]
    nik: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportJobPayload {
    format: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncJobPayload {
    #[serde(default)]
    records: Vec<SyncJobRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncJobRecord {
    #[serde(default)]
    resource: String,
    #[serde(default)]
    operation: String,
    #[serde(default)]
    document_id: String,
    #[serde(default)]
    idempotency_key: String,
    #[serde(default)]
    version: u64,
    #[serde(default = "default_json_object")]
    payload_json: String,
}

fn default_json_object() -> String {
    "{}".into()
}

impl From<SyncJobRecord> for SyncRecord {
    fn from(value: SyncJobRecord) -> Self {
        Self {
            resource: value.resource,
            operation: value.operation,
            document_id: value.document_id,
            idempotency_key: value.idempotency_key,
            version: value.version,
            payload_json: value.payload_json,
        }
    }
}

fn issue_json(value: &ValidationIssue) -> Value {
    json!({
        "rowNumber": value.row_number,
        "field": value.field,
        "code": value.code,
        "message": value.message,
        "severity": value.severity,
    })
}

fn analysis_assessment_json(value: &e_posyandu_proto::analysis::NutritionAssessment) -> Value {
    let analysis = serde_json::from_str::<Value>(&value.analysis_json).unwrap_or_else(|_| json!({}));
    json!({
        "rowNumber": value.row_number,
        "recordId": value.record_id,
        "nik": value.nik,
        "bbuStatus": value.bbu_status,
        "tbuStatus": value.tbu_status,
        "bbtbStatus": value.bbtb_status,
        "imtuStatus": value.imtu_status,
        "lilaStatus": value.lila_status,
        "lkStatus": value.lk_status,
        "bbuZScore": value.bbu_z_score,
        "tbuZScore": value.tbu_z_score,
        "bbtbZScore": value.bbtb_z_score,
        "imtuZScore": value.imtu_z_score,
        "lilaZScore": value.lila_z_score,
        "lkZScore": value.lk_z_score,
        "analysis": analysis,
    })
}

fn enforce_import_scope(
    rows: &[ImportRow],
    actor_role: &str,
    village: Option<&str>,
    posyandu: Option<&str>,
) -> Result<(), Status> {
    let normalized_role = actor_role.trim().to_ascii_lowercase();
    let expected_village = village.unwrap_or_default().trim();
    let expected_posyandu = posyandu.unwrap_or_default().trim();
    if matches!(normalized_role.as_str(), "ahli gizi" | "super_admin") {
        return Ok(());
    }
    for row in rows {
        let village_matches = !expected_village.is_empty()
            && row.village.trim().eq_ignore_ascii_case(expected_village);
        let posyandu_matches = !expected_posyandu.is_empty()
            && row.posyandu.trim().eq_ignore_ascii_case(expected_posyandu);
        let allowed = match normalized_role.as_str() {
            "bidan desa" => village_matches,
            "kader posyandu" => village_matches && posyandu_matches,
            _ => false,
        };
        if !allowed {
            return Err(Status::permission_denied(format!(
                "Baris {} berada di luar wilayah akses pengguna.",
                row.row_number
            )));
        }
    }
    Ok(())
}

pub fn process_job(request: ProcessJobRequest) -> Result<ProcessJobResponse, Status> {
    if request.job_id.trim().is_empty() {
        return Err(Status::invalid_argument("ID job wajib diisi."));
    }
    let mut response = ProcessJobResponse {
        job_id: request.job_id,
        status: "completed".into(),
        progress: 100,
        ..ProcessJobResponse::default()
    };
    match request.kind.as_str() {
        "import_validation" => {
            let payload: ImportJobPayload = serde_json::from_str(&request.payload_json)
                .map_err(|_| Status::invalid_argument("Payload validasi impor tidak valid."))?;
            let rows = payload
                .rows
                .into_iter()
                .map(ImportRow::from)
                .collect::<Vec<_>>();
            enforce_import_scope(
                &rows,
                &request.actor_role,
                request.village.as_deref(),
                request.posyandu.as_deref(),
            )?;
            let result = validate_import_rows(&rows, &payload.existing_niks)?;
            response.result_json = json!({
                "totalRows": result.total_rows,
                "validRows": result.valid_rows,
                "invalidRows": result.invalid_rows,
                "duplicateRows": result.duplicate_rows,
                "issues": result.issues.iter().map(issue_json).collect::<Vec<_>>(),
            })
            .to_string();
            response.issues = result.issues;
        }
        "nutrition_report" => return Err(Status::failed_precondition(
            "Job laporan gizi harus diproses oleh analysis-service Python.",
        )),
        "export_file" => {
            let payload: ExportJobPayload = serde_json::from_str(&request.payload_json)
                .map_err(|_| Status::invalid_argument("Payload ekspor tidak valid."))?;
            let export_request = PrepareExportRequest {
                format: payload.format,
                title: payload.title,
                filename: payload.filename,
                columns: payload.columns,
                rows: payload
                    .rows
                    .into_iter()
                    .map(|cells| ExportRow { cells })
                    .collect(),
            };
            let result = prepare_export(&export_request)?;
            response.result_json = json!({
                "filename": result.filename,
                "contentType": result.content_type,
                "sha256": result.sha256,
                "rowCount": result.row_count,
                "sizeBytes": result.content.len(),
            })
            .to_string();
            response.file_content = result.content;
            response.file_content_type = result.content_type;
            response.file_name = result.filename;
        }
        "system_sync" => {
            let payload: SyncJobPayload = serde_json::from_str(&request.payload_json)
                .map_err(|_| Status::invalid_argument("Payload sinkronisasi tidak valid."))?;
            let records = payload
                .records
                .into_iter()
                .map(SyncRecord::from)
                .collect::<Vec<_>>();
            let result = normalize_sync_batch(&records)?;
            response.result_json = json!({
                "accepted": result.accepted,
                "rejected": result.rejected,
                "records": result.records.iter().map(|record| json!({
                    "resource": record.resource,
                    "operation": record.operation,
                    "documentId": record.document_id,
                    "idempotencyKey": record.idempotency_key,
                    "version": record.version,
                    "payloadJson": record.payload_json,
                })).collect::<Vec<_>>(),
                "issues": result.issues.iter().map(issue_json).collect::<Vec<_>>(),
            })
            .to_string();
            response.issues = result.issues;
        }
        _ => return Err(Status::invalid_argument("Jenis job tidak didukung.")),
    }
    Ok(response)
}

#[derive(Clone, Default)]
pub struct DataProcessingWorkerService;

#[tonic::async_trait]
impl DataProcessingWorker for DataProcessingWorkerService {
    async fn validate_import(
        &self,
        request: Request<ValidateImportRequest>,
    ) -> Result<Response<ValidateImportResponse>, Status> {
        let request = request.into_inner();
        Ok(Response::new(validate_import_rows(
            &request.rows,
            &request.existing_niks,
        )?))
    }

    async fn prepare_export(
        &self,
        request: Request<PrepareExportRequest>,
    ) -> Result<Response<PrepareExportResponse>, Status> {
        Ok(Response::new(prepare_export(&request.into_inner())?))
    }

    async fn normalize_sync_batch(
        &self,
        request: Request<NormalizeSyncBatchRequest>,
    ) -> Result<Response<NormalizeSyncBatchResponse>, Status> {
        Ok(Response::new(normalize_sync_batch(
            &request.into_inner().records,
        )?))
    }

    async fn process_job(
        &self,
        request: Request<ProcessJobRequest>,
    ) -> Result<Response<ProcessJobResponse>, Status> {
        let request = request.into_inner();
        if request.kind == "nutrition_report" {
            let client = AnalysisGrpcClient::from_env()
                .map_err(Status::internal)?
                .ok_or_else(|| Status::failed_precondition(
                    "ANALYSIS_GRPC_ENABLED harus true untuk job laporan gizi.",
                ))?;
            let payload: NutritionJobPayload = serde_json::from_str(&request.payload_json)
                .map_err(|_| Status::invalid_argument("Payload laporan gizi tidak valid."))?;
            let items = payload
                .items
                .into_iter()
                .map(|item| {
                    let history_json = serde_json::to_string(&item.history)
                        .map_err(|_| Status::invalid_argument("Riwayat pengukuran tidak valid."))?;
                    Ok(e_posyandu_proto::analysis::NutritionItem {
                        weight_kg: item.weight_kg,
                        height_cm: item.height_cm,
                        age_months: item.age_months,
                        sex: item.sex,
                        measurement_method: item.measurement_method,
                        row_number: item.row_number,
                        record_id: item.record_id,
                        nik: item.nik,
                        lila_cm: item.lila_cm,
                        head_circumference_cm: item.head_circumference_cm,
                        history_json,
                        measurement_date: item.measurement_date,
                        exclusive_breastfeeding: item.exclusive_breastfeeding,
                    })
                })
                .collect::<Result<Vec<_>, Status>>()?;
            let result = client
                .calculate_batch(items)
                .await
                .map_err(|status| status)?;
            let mut response = ProcessJobResponse {
                job_id: request.job_id,
                status: "completed".into(),
                progress: 100,
                ..ProcessJobResponse::default()
            };
            response.result_json = serde_json::to_string(&json!({
                "total": result.total,
                "valid": result.total,
                "underweight": result.underweight,
                "stunting": result.stunting,
                "wasting": result.wasting,
                "items": result.items.iter().map(analysis_assessment_json).collect::<Vec<_>>(),
                "calculator": "python-deterministic-lms",
            }))
            .map_err(|_| Status::internal("Hasil analisis tidak dapat diserialisasi."))?;
            return Ok(Response::new(response));
        }
        Ok(Response::new(process_job(request)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_duplicates_and_measurement_age() {
        let rows = vec![ImportRow {
            row_number: 2,
            record_id: "child-1".into(),
            nik: "3509040101260001".into(),
            birth_date: "2026-01-01".into(),
            measurement_date: Some("2026-08-01".into()),
            weight_kg: Some(6.5),
            height_cm: Some(64.0),
            age_months: Some(7),
            sex: "L".into(),
            measurement_method: Some("Terlentang".into()),
            village: "Desa Gumukmas".into(),
            posyandu: "SALAK 1".into(),
        }];
        let result =
            validate_import_rows(&rows, &["3509040101260001".into()]).expect("validation result");
        assert_eq!(result.invalid_rows, 1);
        assert_eq!(result.duplicate_rows, 1);
        assert!(
            result
                .issues
                .iter()
                .any(|value| value.code == "duplicate_nik")
        );
    }

    #[test]
    fn creates_xlsx_and_pdf_files() {
        let base = PrepareExportRequest {
            format: "xlsx".into(),
            title: "Laporan Gizi".into(),
            filename: "laporan-gizi".into(),
            columns: vec!["NIK".into(), "Nama".into()],
            rows: vec![ExportRow {
                cells: vec!["3509040101260001".into(), "Balita Contoh".into()],
            }],
        };
        let xlsx = prepare_export(&base).expect("xlsx");
        assert!(xlsx.content.starts_with(b"PK"));

        let pdf = prepare_export(&PrepareExportRequest {
            format: "pdf".into(),
            ..base
        })
        .expect("pdf");
        assert!(pdf.content.starts_with(b"%PDF"));
    }

    #[test]
    fn normalizes_sync_operations_and_rejects_duplicates() {
        let record = SyncRecord {
            resource: "Children".into(),
            operation: "add".into(),
            document_id: "child-1".into(),
            idempotency_key: "sync-child-1".into(),
            version: 1,
            payload_json: "{\"nama\":\"Balita\"}".into(),
        };
        let result = normalize_sync_batch(&[record.clone(), record]).expect("sync result");
        assert_eq!(result.accepted, 1);
        assert_eq!(result.rejected, 1);
        assert_eq!(result.records[0].operation, "create");
    }

    #[test]
    fn rejects_import_rows_outside_actor_scope() {
        let row = ImportRow {
            row_number: 2,
            village: "Desa Menampu".into(),
            posyandu: "SALAK 20".into(),
            ..ImportRow::default()
        };
        let error = enforce_import_scope(
            &[row],
            "Kader Posyandu",
            Some("Desa Gumukmas"),
            Some("SALAK 1"),
        )
        .expect_err("scope mismatch");
        assert_eq!(error.code(), tonic::Code::PermissionDenied);
    }
}
