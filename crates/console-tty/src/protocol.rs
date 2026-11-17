use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u32 = 1;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
pub const MAX_INPUT: usize = 64 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub params: Value,
}
impl Request {
    pub fn new(kind: &str, params: Value) -> Self {
        Self {
            version: VERSION,
            request_id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            params,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Response {
    pub version: u32,
    pub request_id: String,
    #[serde(
        default,
        deserialize_with = "present_result",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
fn present_result<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    // A present JSON null is a successful unchanged-screen poll, not a missing result.
    Value::deserialize(deserializer).map(Some)
}
impl Response {
    pub fn new(id: String, result: Result<Value>) -> Self {
        match result {
            Ok(value) => Self {
                version: VERSION,
                request_id: id,
                result: Some(value),
                error: None,
            },
            Err(error) => Self {
                version: VERSION,
                request_id: id,
                result: None,
                error: Some(error.to_string()),
            },
        }
    }
    pub fn value(self) -> Result<Value> {
        if let Some(error) = self.error {
            anyhow::bail!("{error}");
        }
        self.result
            .ok_or_else(|| anyhow::anyhow!("empty protocol response"))
    }
}
pub async fn read<R: AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    reader: &mut R,
) -> Result<T> {
    read_limited(reader, MAX_FRAME).await
}
pub async fn read_limited<R: AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    reader: &mut R,
    max: usize,
) -> Result<T> {
    let len = reader.read_u32_le().await? as usize;
    ensure!((1..=max).contains(&len), "invalid frame size");
    let mut buffer = vec![0; len];
    reader.read_exact(&mut buffer).await?;
    Ok(serde_json::from_slice(&buffer)?)
}
pub async fn write<W: AsyncWrite + Unpin, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    let buffer = serde_json::to_vec(value)?;
    ensure!(buffer.len() <= MAX_FRAME, "frame exceeds protocol limit");
    writer.write_u32_le(buffer.len() as u32).await?;
    writer.write_all(&buffer).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn idle_poll_null_result_survives_framed_roundtrip() {
        let (mut output, mut input) = tokio::io::duplex(1024);
        write(&mut output, &Response::new("idle".into(), Ok(Value::Null)))
            .await
            .unwrap();
        let response: Response = read(&mut input).await.unwrap();
        assert_eq!(response.value().unwrap(), Value::Null);
    }

    #[test]
    fn missing_result_is_not_a_successful_idle_poll() {
        let response: Response = serde_json::from_value(serde_json::json!({
            "version": VERSION, "request_id": "missing"
        }))
        .unwrap();
        assert!(response.value().is_err());
    }
}
