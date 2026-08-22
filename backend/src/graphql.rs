use crate::{ApiFailure, ApiResult, api};
use graphql_parser::parse_query;
use graphql_parser::query::{Definition, OperationDefinition, Selection, Value as GraphQlValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use worker::{Env, Headers, Method, Request, RequestInit};

const SCHEMA: &str = include_str!("../graphql-schema.graphql");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphQlRequest {
    query: String,
    #[serde(default)]
    variables: Map<String, Value>,
    operation_name: Option<String>,
}

struct RootRoute {
    path: &'static str,
    allowed: &'static [&'static str],
    required: &'static [&'static str],
    defaults: &'static [(&'static str, &'static str)],
}

fn route_for(field: &str) -> Option<RootRoute> {
    match field {
        "dashboardStats" => Some(RootRoute {
            path: "/api/v1/dashboard/stats",
            allowed: &[
                "monthStart",
                "monthEnd",
                "previousMonthStart",
                "previousMonthEnd",
                "village",
                "posyandu",
            ],
            required: &[
                "monthStart",
                "monthEnd",
                "previousMonthStart",
                "previousMonthEnd",
            ],
            defaults: &[],
        }),
        "childrenPage" => Some(RootRoute {
            path: "/api/v1/children/page",
            allowed: &[
                "asOf",
                "measurementStart",
                "measurementEnd",
                "page",
                "size",
                "sort",
                "view",
                "search",
                "village",
                "posyandu",
            ],
            required: &["asOf", "measurementStart", "measurementEnd"],
            defaults: &[
                ("page", "1"),
                ("size", "10"),
                ("sort", "recent"),
                ("view", "data"),
            ],
        }),
        "exclusiveBreastfeedingPage" => Some(RootRoute {
            path: "/api/v1/exclusive-breastfeeding/page",
            allowed: &[
                "measurementStart",
                "measurementEnd",
                "ageGroup",
                "page",
                "size",
                "village",
                "posyandu",
            ],
            required: &["measurementStart", "measurementEnd", "ageGroup"],
            defaults: &[("page", "1"), ("size", "10")],
        }),
        _ => None,
    }
}

fn error_payload(message: impl Into<String>, code: &str) -> Value {
    json!({
        "data": Value::Null,
        "errors": [{
            "message": message.into(),
            "extensions": { "code": code }
        }]
    })
}

fn scalar_text(
    value: &GraphQlValue<'_, String>,
    variables: &Map<String, Value>,
) -> ApiResult<Option<String>> {
    match value {
        GraphQlValue::Variable(name) => match variables.get(name) {
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(Value::Number(value)) => Ok(Some(value.to_string())),
            Some(Value::Bool(value)) => Ok(Some(value.to_string())),
            Some(Value::Null) => Ok(None),
            _ => Err(ApiFailure::new(
                422,
                format!("Variabel GraphQL ${name} tidak valid."),
            )),
        },
        GraphQlValue::String(value) | GraphQlValue::Enum(value) => Ok(Some(value.clone())),
        GraphQlValue::Int(value) => value
            .as_i64()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| ApiFailure::new(422, "Nilai angka GraphQL tidak valid.")),
        GraphQlValue::Float(value) => Ok(Some(value.to_string())),
        GraphQlValue::Boolean(value) => Ok(Some(value.to_string())),
        GraphQlValue::Null => Ok(None),
        _ => Err(ApiFailure::new(
            422,
            "Argumen GraphQL harus berupa nilai tunggal.",
        )),
    }
}

fn query_path(
    field_name: &str,
    arguments: &[(String, GraphQlValue<'_, String>)],
    variables: &Map<String, Value>,
) -> ApiResult<String> {
    let route = route_for(field_name).ok_or_else(|| {
        ApiFailure::new(422, format!("Field GraphQL {field_name} tidak tersedia."))
    })?;
    let mut values = Map::new();
    for (name, value) in arguments {
        if !route.allowed.contains(&name.as_str()) {
            return Err(ApiFailure::new(
                422,
                format!("Argumen GraphQL {name} tidak didukung untuk {field_name}."),
            ));
        }
        if let Some(value) = scalar_text(value, variables)? {
            values.insert(name.clone(), Value::String(value));
        }
    }
    for (name, value) in route.defaults {
        values
            .entry(*name)
            .or_insert_with(|| Value::String((*value).into()));
    }
    for name in route.required {
        if values
            .get(*name)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(ApiFailure::new(
                422,
                format!("Argumen GraphQL {name} wajib diisi."),
            ));
        }
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in values {
        if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
            serializer.append_pair(&name, value);
        }
    }
    Ok(format!("{}?{}", route.path, serializer.finish()))
}

fn forwarded_headers(request: &Request) -> ApiResult<Headers> {
    let headers = Headers::new();
    let authorization = request
        .headers()
        .get("Authorization")
        .map_err(|_| ApiFailure::new(401, "Sesi masuk diperlukan."))?
        .ok_or_else(|| ApiFailure::new(401, "Sesi masuk diperlukan."))?;
    headers
        .set("Authorization", &authorization)
        .map_err(|_| ApiFailure::new(400, "Header autentikasi tidak valid."))?;
    if let Some(request_id) = request.headers().get("X-Request-ID").ok().flatten() {
        headers
            .set("X-Request-ID", &request_id)
            .map_err(|_| ApiFailure::new(400, "Request ID tidak valid."))?;
    }
    Ok(headers)
}

fn subrequest(request: &Request, path: &str) -> ApiResult<Request> {
    let origin = request
        .url()
        .map_err(|_| ApiFailure::new(400, "Alamat GraphQL tidak valid."))?
        .origin()
        .ascii_serialization();
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(forwarded_headers(request)?);
    Request::new_with_init(&format!("{origin}{path}"), &init)
        .map_err(|_| ApiFailure::new(400, "Query GraphQL tidak dapat diproses."))
}

pub(crate) fn schema_document() -> Value {
    json!({ "schema": SCHEMA })
}

pub(crate) async fn execute(mut request: Request, env: &Env) -> ApiResult<Value> {
    let body = request
        .text()
        .await
        .map_err(|_| ApiFailure::new(422, "Payload GraphQL tidak valid."))?;
    if body.len() > 64 * 1024 {
        return Err(ApiFailure::new(413, "Query GraphQL terlalu besar."));
    }
    let payload: GraphQlRequest = serde_json::from_str(&body)
        .map_err(|_| ApiFailure::new(422, "Payload GraphQL tidak valid."))?;
    let document = match parse_query::<String>(&payload.query) {
        Ok(document) => document,
        Err(error) => return Ok(error_payload(error.to_string(), "GRAPHQL_PARSE_FAILED")),
    };
    let operations = document
        .definitions
        .iter()
        .filter_map(|definition| match definition {
            Definition::Operation(operation) => Some(operation),
            Definition::Fragment(_) => None,
        })
        .collect::<Vec<_>>();
    let operation = operations.iter().copied().find(|operation| {
        match (payload.operation_name.as_deref(), operation) {
            (Some(expected), OperationDefinition::Query(query)) => {
                query.name.as_deref() == Some(expected)
            }
            (Some(_), _) => false,
            (None, _) => operations.len() == 1,
        }
    });
    let Some(operation) = operation else {
        return Ok(error_payload(
            "Operasi GraphQL tidak ditemukan atau operationName diperlukan.",
            "GRAPHQL_VALIDATION_FAILED",
        ));
    };
    let selection_set = match operation {
        OperationDefinition::Query(query) => &query.selection_set,
        OperationDefinition::SelectionSet(selection_set) => selection_set,
        OperationDefinition::Mutation(_) | OperationDefinition::Subscription(_) => {
            return Ok(error_payload(
                "GraphQL hanya tersedia untuk membaca data. Gunakan REST untuk perubahan data.",
                "READ_ONLY",
            ));
        }
    };
    let mut data = Map::new();
    let mut errors = Vec::new();
    for selection in &selection_set.items {
        let Selection::Field(field) = selection else {
            errors.push(json!({
                "message": "Fragment pada root query belum didukung.",
                "extensions": { "code": "GRAPHQL_VALIDATION_FAILED" }
            }));
            continue;
        };
        let response_name = field.alias.as_deref().unwrap_or(&field.name).to_owned();
        if field.name == "__typename" {
            data.insert(response_name, json!("Query"));
            continue;
        }
        let result = match query_path(&field.name, &field.arguments, &payload.variables) {
            Ok(path) => match subrequest(&request, &path) {
                Ok(request) => api::dispatch(request, env).await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => {
                data.insert(response_name, value);
            }
            Err(error) => {
                data.insert(response_name.clone(), Value::Null);
                errors.push(json!({
                    "message": error.detail,
                    "path": [response_name],
                    "extensions": { "code": error.code, "status": error.status }
                }));
            }
        }
    }
    let mut response = json!({ "data": data });
    if !errors.is_empty() {
        response
            .as_object_mut()
            .expect("GraphQL response object")
            .insert("errors".into(), Value::Array(errors));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use graphql_parser::query::Value as GraphQlValue;

    #[test]
    fn builds_children_route_with_defaults_and_variables() {
        let variables = json!({
            "asOf": "2026-08-06",
            "start": "2026-08-01",
            "end": "2026-08-31"
        })
        .as_object()
        .cloned()
        .expect("variables");
        let path = query_path(
            "childrenPage",
            &[
                ("asOf".into(), GraphQlValue::Variable("asOf".into())),
                (
                    "measurementStart".into(),
                    GraphQlValue::Variable("start".into()),
                ),
                (
                    "measurementEnd".into(),
                    GraphQlValue::Variable("end".into()),
                ),
            ],
            &variables,
        )
        .expect("valid route");
        assert!(path.starts_with("/api/v1/children/page?"));
        assert!(path.contains("page=1"));
        assert!(path.contains("size=10"));
        assert!(path.contains("view=data"));
    }

    #[test]
    fn rejects_mutation_only_field_arguments() {
        let error = query_path(
            "dashboardStats",
            &[("password".into(), GraphQlValue::String("secret".into()))],
            &Map::new(),
        )
        .expect_err("unsupported argument");
        assert_eq!(error.status, 422);
    }
}
