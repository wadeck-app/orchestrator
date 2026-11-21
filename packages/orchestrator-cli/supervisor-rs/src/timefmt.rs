// Time formatting without a time crate: UTC only, which is all the supervisor ever prints.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Time since the Unix epoch, now.
pub fn sys_now() -> Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO)
}

// Howard Hinnant's civil_from_days.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn parts(t: Duration) -> (i64, u32, u32, u32, u32, u32, u32) {
    let secs = t.as_secs() as i64;
    let (y, mo, d) = civil(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    (y, mo, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32, t.subsec_nanos())
}

/// Go's time.RFC3339Nano in UTC: 2026-11-21T10:00:00.123456789Z (fraction trimmed of trailing zeros, absent when zero).
pub fn rfc3339_nano(t: Duration) -> String {
    let (y, mo, d, h, mi, s, ns) = parts(t);
    let mut out = format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}");
    if ns > 0 {
        out.push('.');
        out.push_str(format!("{ns:09}").trim_end_matches('0'));
    }
    out.push('Z');
    out
}

/// The run log's stamp, Go layout "2006-01-02 15:04:05", UTC.
pub fn log_stamp(t: Duration) -> String {
    let (y, mo, d, h, mi, s, _) = parts(t);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_go() {
        // 2026-10-25 10:00:05 UTC
        let t = Duration::new(1_792_922_405, 120_000_000);
        assert_eq!(log_stamp(t), "2026-10-25 10:00:05");
        assert_eq!(rfc3339_nano(t), "2026-10-25T10:00:05.12Z");
        assert_eq!(rfc3339_nano(Duration::new(0, 0)), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_nano(Duration::new(951_782_400, 5)), "2000-02-29T00:00:00.000000005Z");
    }
}
