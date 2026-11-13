use std::cell::Cell;
use std::sync::Once;

thread_local! {
    static PRIVATE_SCOPE: Cell<u32> = const {Cell::new(0)};
}

struct Scope;
impl Scope {
    fn enter() -> Self {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                // The hook is process-wide within this Rust runtime, but only
                // plugin-owned guarded scopes are suppressed. Other threads keep
                // their original diagnostic hook; no user content is logged here.
                if !PRIVATE_SCOPE
                    .try_with(|depth| depth.get() > 0)
                    .unwrap_or(false)
                {
                    previous(info);
                }
            }));
        });
        PRIVATE_SCOPE.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        let _ = PRIVATE_SCOPE.try_with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

pub fn catch<T>(
    operation: impl FnOnce() -> T,
) -> std::result::Result<T, Box<dyn std::any::Any + Send>> {
    let _scope = Scope::enter();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
}
