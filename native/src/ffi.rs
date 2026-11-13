//! Same buffer ABI as invoke/free; never echo parser errors or panic payloads.
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

// Keep the public ABI compatible with the existing host (which calls safe extern C
// function pointers). The caller is still responsible for valid readable/writable
// ranges; null and impossible lengths are rejected before building an input slice.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn guarded<F>(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
    logic: F,
) -> *mut u8
where
    F: FnOnce(&[u8]) -> Result<Value, String>,
{
    if output_len.is_null() {
        return std::ptr::null_mut();
    }
    unsafe {
        *output_len = 0;
    }
    if input_ptr.is_null() {
        return std::ptr::null_mut();
    }
    if input_len > MAX_REQUEST_BYTES {
        let bytes = br#"{"ok":false,"error":"requestTooLarge"}"#.to_vec();
        return ot_plugin_ffi::take_json_response(bytes, output_len);
    }
    // Use the current host guard, but catch inside its closure first: that crate's
    // fallback formats panic strings, which may contain sensitive captured content.
    ot_plugin_ffi::guard_invoke(input_ptr, input_len, output_len, |bytes| {
        crate::panic_guard::catch(|| logic(bytes))
            .unwrap_or_else(|_| Ok(json!({"ok":false,"error":"internalError"})))
    })
}
