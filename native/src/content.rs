use crate::protocol::{
    valid_hash, Result, MAX_DIMENSION, MAX_PIXELS, MAX_PNG_BYTES, MAX_TEXT_BYTES, PREVIEW_CHARS,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngDecoder, ImageDecoder};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Cursor;

pub struct Capture {
    pub kind: &'static str,
    pub hash: String,
    pub text: Option<String>,
    pub png: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub preview: String,
    pub byte_size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextPayload {
    text: String,
    hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImagePayload {
    png_base64: String,
    width: u32,
    height: u32,
    hash: String,
}

fn dimensions(width: u32, height: u32) -> Result<()> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or("imageTooLarge")?;
    if width == 0 || height == 0 {
        return Err("invalidImage".into());
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION || pixels > MAX_PIXELS {
        return Err("imageTooLarge".into());
    }
    Ok(())
}

pub fn decode_png(png: &[u8]) -> Result<image::DynamicImage> {
    if png.len() > MAX_PNG_BYTES {
        return Err("imageTooLarge".into());
    }
    if png.len() < 33 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return Err("invalidImage".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().map_err(|_| "invalidImage")?);
    let height = u32::from_be_bytes(png[20..24].try_into().map_err(|_| "invalidImage")?);
    dimensions(width, height)?;
    // Validate IHDR dimensions before the decoder or output buffer can allocate pixels.
    let mut decoder = PngDecoder::new(Cursor::new(png)).map_err(|_| "invalidImage")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_PIXELS * 8 + 1024 * 1024);
    decoder.set_limits(limits).map_err(|_| "imageTooLarge")?;
    let (actual_width, actual_height) = decoder.dimensions();
    dimensions(actual_width, actual_height)?;
    image::DynamicImage::from_decoder(decoder).map_err(|_| "invalidImage".into())
}

pub fn normalize(payload: Value) -> Result<Vec<Capture>> {
    let object = payload.as_object().ok_or("invalidPayload")?;
    if object.keys().any(|key| key != "text" && key != "image") {
        return Err("invalidPayload".into());
    }
    let mut items = Vec::with_capacity(2);
    if let Some(value) = object.get("text") {
        let text: TextPayload =
            serde_json::from_value(value.clone()).map_err(|_| "invalidPayload")?;
        if text.text.len() > MAX_TEXT_BYTES {
            return Err("textTooLarge".into());
        }
        if !valid_hash(&text.hash) {
            return Err("invalidHash".into());
        }
        let mut digest = Sha256::new();
        digest.update(b"otools:clipboard:text:v1\0");
        digest.update(text.text.as_bytes());
        if format!("{:x}", digest.finalize()) != text.hash {
            return Err("hashMismatch".into());
        }
        if !text.text.is_empty() {
            items.push(Capture {
                kind: "text",
                preview: text.text.chars().take(PREVIEW_CHARS).collect(),
                byte_size: text.text.len() as u64,
                text: Some(text.text),
                hash: text.hash,
                png: None,
                width: None,
                height: None,
            });
        }
    }
    if let Some(value) = object.get("image") {
        let image: ImagePayload =
            serde_json::from_value(value.clone()).map_err(|_| "invalidPayload")?;
        dimensions(image.width, image.height)?;
        if image.png_base64.len() > MAX_PNG_BYTES.div_ceil(3) * 4 {
            return Err("imageTooLarge".into());
        }
        if !valid_hash(&image.hash) {
            return Err("invalidHash".into());
        }
        let png = STANDARD
            .decode(&image.png_base64)
            .map_err(|_| "invalidImage")?;
        let decoded = decode_png(&png)?;
        if decoded.width() != image.width || decoded.height() != image.height {
            return Err("imageDimensionsMismatch".into());
        }
        let rgba = decoded.to_rgba8();
        let mut digest = Sha256::new();
        digest.update(b"otools:clipboard:image:v1\0");
        digest.update(u64::from(decoded.width()).to_le_bytes());
        digest.update(u64::from(decoded.height()).to_le_bytes());
        digest.update(rgba.as_raw());
        if format!("{:x}", digest.finalize()) != image.hash {
            return Err("hashMismatch".into());
        }
        items.push(Capture {
            kind: "image",
            hash: image.hash,
            byte_size: png.len() as u64,
            png: Some(png),
            width: Some(image.width),
            height: Some(image.height),
            preview: format!("{} × {}", image.width, image.height),
            text: None,
        });
    }
    Ok(items)
}
