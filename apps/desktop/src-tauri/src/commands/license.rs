use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

const VALIDATE_URL: &str = "https://api.mozzie.dev/license/validate";

// Public key for verifying license JWTs (ES256 / ECDSA P-256).
// Only the Cloudflare Worker has the private key.
const LICENSE_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6STb6EFSAETXKwFca0MHp4ucPpQ8
yhgR7mYlasy7VQc2DllZzpG5xR32W2kLbSAPfHa9NdEqO27vWsvFnnVmyQ==
-----END PUBLIC KEY-----"#;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LicenseStatus {
    pub is_pro: bool,
    pub license_key: Option<String>,
    pub email: Option<String>,
    pub status: Option<String>,
    pub validated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    valid: bool,
    email: Option<String>,
    token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LicenseClaims {
    sub: String, // license key
    email: String,
    exp: usize,
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Verify a JWT token offline using the embedded public key.
/// Returns the claims if valid, None if invalid/expired.
fn verify_token(token: &str) -> Option<LicenseClaims> {
    let key = DecodingKey::from_ec_pem(LICENSE_PUBLIC_KEY_PEM.as_bytes()).ok()?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.validate_exp = true;
    validation.set_required_spec_claims(&["sub", "email", "exp"]);
    decode::<LicenseClaims>(token, &key, &validation)
        .ok()
        .map(|data| data.claims)
}

#[tauri::command]
pub async fn get_license_status(pool: State<'_, SqlitePool>) -> Result<LicenseStatus, String> {
    let row = sqlx::query_as::<_, (String, Option<String>, String, Option<String>, Option<String>)>(
        "SELECT license_key, email, status, validated_at, token FROM license WHERE id = 1",
    )
    .fetch_optional(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((key, email, status, validated_at, token)) => {
            if status != "active" {
                return Ok(LicenseStatus {
                    is_pro: false,
                    license_key: Some(mask_key(&key)),
                    email,
                    status: Some(status),
                    validated_at,
                });
            }

            // Try offline JWT verification first
            if let Some(ref t) = token {
                if let Some(claims) = verify_token(t) {
                    let subject_matches = claims.sub == key;
                    let email_matches = email
                        .as_deref()
                        .map(|stored| stored == claims.email)
                        .unwrap_or(true);
                    let _ = claims.exp;

                    if subject_matches && email_matches {
                        // JWT is valid and not expired — Pro confirmed offline
                        return Ok(LicenseStatus {
                            is_pro: true,
                            license_key: Some(mask_key(&key)),
                            email,
                            status: Some(status),
                            validated_at,
                        });
                    }
                }
            }

            // JWT missing or expired — try to re-validate online
            match call_validate(&key).await {
                Ok(result) => {
                    if !result.valid {
                        // License revoked remotely
                        let _ = sqlx::query(
                            "UPDATE license SET status = 'expired', token = NULL, validated_at = ? WHERE id = 1",
                        )
                        .bind(&now_iso())
                        .execute(pool.inner())
                        .await;

                        return Ok(LicenseStatus {
                            is_pro: false,
                            license_key: Some(mask_key(&key)),
                            email,
                            status: Some("expired".to_string()),
                            validated_at: Some(now_iso()),
                        });
                    }

                    // Store fresh token
                    let _ = sqlx::query(
                        "UPDATE license SET validated_at = ?, token = ?, email = COALESCE(?, email) WHERE id = 1",
                    )
                    .bind(&now_iso())
                    .bind(&result.token)
                    .bind(&result.email)
                    .execute(pool.inner())
                    .await;

                    Ok(LicenseStatus {
                        is_pro: true,
                        license_key: Some(mask_key(&key)),
                        email: result.email.or(email),
                        status: Some("active".to_string()),
                        validated_at: Some(now_iso()),
                    })
                }
                Err(_) => {
                    // Offline and JWT expired — grace period: still allow if validated
                    // within the last 7 days
                    let within_grace = validated_at
                        .as_deref()
                        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                        .map(|v| {
                            let age = chrono::Utc::now() - v.with_timezone(&chrono::Utc);
                            age < chrono::Duration::days(7)
                        })
                        .unwrap_or(false);

                    Ok(LicenseStatus {
                        is_pro: within_grace,
                        license_key: Some(mask_key(&key)),
                        email,
                        status: Some(if within_grace {
                            "active".to_string()
                        } else {
                            "expired".to_string()
                        }),
                        validated_at,
                    })
                }
            }
        }
        None => Ok(LicenseStatus {
            is_pro: false,
            license_key: None,
            email: None,
            status: None,
            validated_at: None,
        }),
    }
}

#[tauri::command]
pub async fn activate_license(
    pool: State<'_, SqlitePool>,
    license_key: String,
) -> Result<LicenseStatus, String> {
    let license_key = license_key.trim().to_string();
    if license_key.is_empty() {
        return Err("License key cannot be empty".to_string());
    }

    let result = call_validate(&license_key)
        .await
        .map_err(|e| format!("Failed to validate license: {}", e))?;

    if !result.valid {
        return Err(result.error.unwrap_or_else(|| "Invalid license key".to_string()));
    }

    // Verify the token signature before storing
    if let Some(ref token) = result.token {
        let claims = verify_token(token)
            .ok_or_else(|| "License validation response has an invalid signature".to_string())?;

        if claims.sub != license_key {
            return Err("License token does not match provided license key".to_string());
        }

        let _ = claims.exp;

        if let Some(ref email) = result.email {
            if claims.email != *email {
                return Err("License token email does not match validation response".to_string());
            }
        }

        if claims.email.is_empty() {
            return Err("License validation response has an invalid signature".to_string());
        }
    }

    let now = now_iso();

    sqlx::query(
        "INSERT INTO license (id, license_key, email, status, validated_at, token) VALUES (1, ?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET license_key = excluded.license_key, email = excluded.email, status = 'active', validated_at = excluded.validated_at, token = excluded.token",
    )
    .bind(&license_key)
    .bind(&result.email)
    .bind(&now)
    .bind(&result.token)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    get_license_status(pool).await
}

#[tauri::command]
pub async fn deactivate_license(pool: State<'_, SqlitePool>) -> Result<(), String> {
    sqlx::query("DELETE FROM license WHERE id = 1")
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn call_validate(key: &str) -> Result<ValidateResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(VALIDATE_URL)
        .json(&serde_json::json!({ "key": key }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.json::<ValidateResponse>()
        .await
        .map_err(|e| e.to_string())
}

fn mask_key(key: &str) -> String {
    if key.len() > 8 {
        format!("{}...{}", &key[..4], &key[key.len() - 4..])
    } else {
        key.to_string()
    }
}
