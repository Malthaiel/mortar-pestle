// bindgen entry header — the one root the regen script feeds bindgen.
// obs.h pulls the core API surface; util/base.h adds base_set_log_handler
// (log routing into Rust `log`), which obs.h does not include itself.
#include <obs.h>
#include <util/base.h>
