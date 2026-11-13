mod content;
mod event_sink;
pub mod ffi;
mod panic_guard;
pub mod protocol;
pub mod runtime;
pub mod store;

use serde_json::{json, Value};
use std::sync::OnceLock;

fn runtime() -> &'static runtime::Runtime {
    static RUNTIME: OnceLock<runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(runtime::Runtime::new)
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    ffi::guarded(input_ptr, input_len, output_len, |input| {
        let envelope: Value = serde_json::from_slice(input).map_err(|_| "invalidRequest")?;
        Ok(json!({"ok":true,"data":runtime().invoke(envelope)?}))
    })
}

#[no_mangle]
pub extern "C" fn otools_plugin_on_event(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    ffi::guarded(input_ptr, input_len, output_len, |input| {
        let envelope: Value = serde_json::from_slice(input).map_err(|_| "invalidRequest")?;
        Ok(json!({"ok":true,"data":runtime().on_event(envelope)?}))
    })
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    ot_plugin_ffi::free_response(ptr, len);
}
